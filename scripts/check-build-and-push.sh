#!/usr/bin/env bash
# check-build-and-push.sh — pre-flight checks + build + GitHub release for a
# ModuLab module, in one script (modules-repo counterpart to modulab-core's
# check-and-push.sh).
#
# Usage:
#   ./scripts/check-build-and-push.sh <module-name>              # checks -> asks "release?" -> build+release+push, or just commit+push
#   ./scripts/check-build-and-push.sh <module-name> --no-push     # same, but skip the final push (commit stays local)
#   ./scripts/check-build-and-push.sh <module-name> --check-only  # only run the pre-flight checks, no prompt, no build/release/git
#
# After the checks pass you're asked: "Publish a new release for '<module>'? [y/N]"
#   - y: version-collision check + auto-bump (see below), zip, cosign sign,
#        GitHub release, registry.json update, commit + push.
#   - N (default): no version change, no GitHub release — just a plain
#     `git add -A` + commit (+ push unless --no-push) of whatever's changed.
#
# Requirements (unchanged from the old build-module.sh):
#   - GITHUB_TOKEN    env var with a Personal Access Token (repo scope)
#   - COSIGN_PASSWORD env var with the password for the cosign key
#   - cosign.key      in the repo root - the private cosign key (gitignored)
#   - npm, curl, zip, jq, cosign, python3, PyYAML (`pip3 install pyyaml`)
#
# Optional:
#   - KEEP_RELEASES   see the "Prune old releases" step near the bottom.
#
# What changed vs. the old build-module.sh: everything from "Build UI"
# onward is identical. What's new is a pre-flight block that runs BEFORE
# any of that — git sanity check, then module-scoped checks (conflict
# markers, secret scan, large-file warning, UI lint, UI build/typecheck,
# npm audit) — modeled on modulab-core's check-and-push.sh but scoped to
# a single module directory instead of the whole repo, since this is a
# monorepo of many modules and only one is being released at a time.
#
# NOTE: unlike modulab-core, a module has no Go backend and no top-level
# test suite of its own — modules run inside Core's process (Tier 1
# config-driven via manifest.yaml's `crud` block, or custom logic via the
# module SDK). So there is no `go build`/`go vet`/`go test` step here.
# manifest.yaml schema validation against modulab-manifest-schema was
# explicitly left out (not wanted) - only structural parsing (name/version/
# etc. must be present) still happens where the manifest is read, further
# down.

set -uo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
DO_PUSH=1
DO_BUILD=1
MODULE=""
for arg in "$@"; do
  case "$arg" in
    --no-push) DO_PUSH=0 ;;
    --check-only) DO_BUILD=0; DO_PUSH=0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) MODULE="$arg" ;;
  esac
done
[[ -n "$MODULE" ]] || { echo "Usage: $0 <module-name> [--no-push|--check-only]" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODULE_DIR="$REPO_ROOT/$MODULE"
cd "$REPO_ROOT" || exit 1

[[ -d "$MODULE_DIR" ]]               || { echo "Error: module directory not found: $MODULE_DIR" >&2; exit 1; }
[[ -f "$MODULE_DIR/manifest.yaml" ]] || { echo "Error: manifest.yaml not found in $MODULE_DIR" >&2; exit 1; }

# ── Output helpers ────────────────────────────────────────────────────────────
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
step()  { printf "\n%s==> %s%s\n" "$BOLD" "$1" "$RESET"; }
ok()    { printf "%s✓ %s%s\n" "$GREEN" "$1" "$RESET"; }
warn()  { printf "%s! %s%s\n" "$YELLOW" "$1" "$RESET"; }
fail()  { printf "%s✗ %s%s\n" "$RED" "$1" "$RESET"; }
die()   { fail "$*"; exit 1; }

FAILED=0

# ════════════════════════════════════════════════════════════════════════════
# PART 1 — PRE-FLIGHT CHECKS
# (mirrors check-and-push.sh's structure, but scoped to $MODULE_DIR since
# this is a monorepo and only this one module is being touched)
# ════════════════════════════════════════════════════════════════════════════

# --- 0. Git sanity: stale locks + genuinely-in-progress states -------------
git_sanity_check() {
  local git_running=0
  pgrep -x git >/dev/null 2>&1 && git_running=1

  local lock_files=(
    "$REPO_ROOT/.git/index.lock" "$REPO_ROOT/.git/HEAD.lock"
    "$REPO_ROOT/.git/config.lock" "$REPO_ROOT/.git/shallow.lock"
    "$REPO_ROOT/.git/packed-refs.lock" "$REPO_ROOT/.git/COMMIT_EDITMSG.lock"
    "$REPO_ROOT/.git/FETCH_HEAD.lock" "$REPO_ROOT/.git/gc.pid"
  )
  if [ -d "$REPO_ROOT/.git/refs" ]; then
    while IFS= read -r -d '' f; do lock_files+=("$f"); done \
      < <(find "$REPO_ROOT/.git/refs" -name "*.lock" -print0 2>/dev/null)
  fi

  local found_lock=0
  for f in "${lock_files[@]}"; do
    if [ -e "$f" ]; then
      found_lock=1
      if [ $git_running -eq 1 ]; then
        fail "Found $f, and a git process is currently running — not touching it. Wait and re-run."
        return 1
      fi
      warn "Removing stale lock file: $f"
      rm -f "$f"
    fi
  done
  [ $found_lock -eq 1 ] && ok "Stale git lock file(s) cleared."

  if [ -d "$REPO_ROOT/.git/rebase-merge" ] || [ -d "$REPO_ROOT/.git/rebase-apply" ]; then
    fail "A rebase is in progress. Resolve it yourself first."; return 1
  fi
  if [ -f "$REPO_ROOT/.git/MERGE_HEAD" ]; then
    fail "A merge is in progress. Resolve it yourself first."; return 1
  fi
  if [ -f "$REPO_ROOT/.git/CHERRY_PICK_HEAD" ]; then
    fail "A cherry-pick is in progress. Resolve it yourself first."; return 1
  fi
  if [ -f "$REPO_ROOT/.git/BISECT_LOG" ]; then
    fail "A bisect is in progress ('git bisect reset' when done)."; return 1
  fi
  return 0
}

step "Git: checking for stale locks / in-progress operations"
if [ -d "$REPO_ROOT/.git" ]; then
  git_sanity_check || exit 1
  ok "git state clean"
else
  warn "$REPO_ROOT/.git not found, skipping"
fi

# --- 1. Conflict markers / secrets / large files, scoped to this module ----
# Scans every file *tracked or changed under $MODULE_DIR*, not the whole
# monorepo — releasing module A shouldn't be blocked by an unrelated WIP
# secret sitting in module B.
collect_module_files() {
  MODULE_FILES=()
  while IFS= read -r f; do
    [ -n "$f" ] && MODULE_FILES+=("$f")
  done < <(cd "$REPO_ROOT" && git ls-files -co --exclude-standard -- "$MODULE" 2>/dev/null)
}

scan_for_conflict_markers() {
  local hit=0 f
  for f in "$@"; do
    [ -f "$REPO_ROOT/$f" ] || continue
    if grep -lE '^(<{7}|={7}|>{7})( |$)' -- "$REPO_ROOT/$f" >/dev/null 2>&1; then
      fail "Unresolved merge-conflict markers in: $f"; hit=1
    fi
  done
  return $hit
}

scan_for_secrets() {
  local hit=0 f pat
  local patterns=(
    'AKIA[0-9A-Z]{16}'
    '-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----'
    'xox[baprs]-[0-9A-Za-z-]{10,}'
    'gh[pousr]_[A-Za-z0-9]{36,}'
    'sk-ant-[A-Za-z0-9_-]{20,}'
    'AIzaSy[0-9A-Za-z_-]{33}'
  )
  for f in "$@"; do
    [ -f "$REPO_ROOT/$f" ] || continue
    for pat in "${patterns[@]}"; do
      if grep -lE "$pat" -- "$REPO_ROOT/$f" >/dev/null 2>&1; then
        fail "Possible credential in: $f (matches a known secret format — double-check)"; hit=1
      fi
    done
  done
  return $hit
}

scan_for_large_files() {
  local f size max_bytes=$((5 * 1024 * 1024))
  for f in "$@"; do
    [ -f "$REPO_ROOT/$f" ] || continue
    size=$(wc -c < "$REPO_ROOT/$f" 2>/dev/null | tr -d ' ')
    if [ -n "$size" ] && [ "$size" -gt "$max_bytes" ] 2>/dev/null; then
      warn "Large file in module: $f ($((size / 1024 / 1024)) MB) — make sure that's intentional (release zips exclude node_modules, but check anyway)."
    fi
  done
}

step "Checks: scanning $MODULE for conflict markers / secrets / large files"
collect_module_files
scan_for_conflict_markers "${MODULE_FILES[@]}" || FAILED=1
scan_for_secrets "${MODULE_FILES[@]}" || FAILED=1
if [ $FAILED -eq 0 ]; then ok "no conflict markers or known secret formats found"; fi
scan_for_large_files "${MODULE_FILES[@]}"

# --- 2. manifest.yaml: must at least parse and have name/version -----------
step "Checks: manifest.yaml parses and has name + version"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed."
python3 -c "import yaml" 2>/dev/null || die "PyYAML is not installed. Run: pip3 install pyyaml"
if python3 -c "
import yaml, sys
with open('$MODULE_DIR/manifest.yaml') as f:
    m = yaml.safe_load(f) or {}
missing = [k for k in ('name', 'version') if not m.get(k)]
sys.exit(1 if missing else 0)
"; then
  ok "manifest.yaml OK (name + version present)"
else
  fail "manifest.yaml is missing 'name' and/or 'version'"
  FAILED=1
fi

# --- 3. UI: npm ci (if needed), lint (if a lint script exists), build ------
UI_DIR="$MODULE_DIR/ui"
if [ -f "$UI_DIR/package.json" ]; then
  NEED_INSTALL=0
  [ ! -d "$UI_DIR/node_modules" ] && NEED_INSTALL=1
  if [ -f "$UI_DIR/package-lock.json" ] && [ "$UI_DIR/package-lock.json" -nt "$UI_DIR/node_modules" ] 2>/dev/null; then
    NEED_INSTALL=1
  fi
  if [ $NEED_INSTALL -eq 1 ]; then
    step "UI: npm ci"
    ( cd "$UI_DIR" && npm ci )
    if [ $? -eq 0 ]; then ok "npm ci passed"; else fail "npm ci failed"; FAILED=1; fi
  fi

  if [ $FAILED -eq 0 ] && node -e "process.exit(require('$UI_DIR/package.json').scripts && require('$UI_DIR/package.json').scripts.lint ? 0 : 1)" 2>/dev/null; then
    step "UI: npm run lint"
    ( cd "$UI_DIR" && npm run lint )
    if [ $? -eq 0 ]; then ok "lint clean"; else fail "lint failed"; FAILED=1; fi
  else
    warn "no 'lint' script in $MODULE/ui/package.json — skipping lint"
  fi

  if [ $FAILED -eq 0 ]; then
    step "UI: npm run build (typecheck + bundle)"
    ( cd "$UI_DIR" && npm run build )
    if [ $? -eq 0 ]; then ok "UI build passed"; else fail "UI build failed"; FAILED=1; fi
  fi

  if [ $FAILED -eq 0 ]; then
    step "UI: npm audit --audit-level=high"
    ( cd "$UI_DIR" && npm audit --audit-level=high )
    if [ $? -eq 0 ]; then ok "npm audit passed"; else fail "npm audit found high/critical advisories"; FAILED=1; fi
  fi
else
  warn "no ui/ in $MODULE — skipping UI checks"
fi

# --- summary -----------------------------------------------------------------
if [ $FAILED -ne 0 ]; then
  step "Result"
  fail "One or more checks failed — nothing was built, released, or pushed."
  exit 1
fi
step "Result"
ok "All checks passed."

if [ $DO_BUILD -eq 0 ]; then
  exit 0
fi

# ── Release decision ──────────────────────────────────────────────────────────
# Ask before doing anything version-related: a version bump and a new
# GitHub release should only ever happen when explicitly confirmed here —
# not as a side effect of just wanting to commit some in-progress work.
step "Release decision"
read -r -p "Publish a new release for '$MODULE'? [y/N] " RELEASE_REPLY
case "$RELEASE_REPLY" in
  [yY]|[yY][eE][sS]) DO_RELEASE=1 ;;
  *) DO_RELEASE=0 ;;
esac

if [ "$DO_RELEASE" -eq 0 ]; then
  step "No release — committing only (no version change, no GitHub release)"
  git_sanity_check || exit 1
  cd "$REPO_ROOT"
  git add -A

  if git diff --cached --quiet; then
    warn "Nothing to commit."
    exit 0
  fi

  step "Staged diff (summary)"
  git diff --cached --stat

  echo
  printf "%sCommit message%s (Enter, then Ctrl+D):\n" "$BOLD" "$RESET"
  COMMIT_MSG="$(cat)"
  [[ -n "$COMMIT_MSG" ]] || die "Empty commit message — aborting (changes are staged but not committed)."

  git commit -m "$COMMIT_MSG" || die "git commit failed."
  ok "Committed."

  if [ $DO_PUSH -eq 1 ]; then
    git push || die "git push failed — commit is local, push manually."
    ok "Pushed."
  else
    warn "Skipping push (--no-push)."
  fi
  exit 0
fi

# ════════════════════════════════════════════════════════════════════════════
# PART 2 — BUILD + RELEASE (only reached if the release prompt above was
# confirmed with 'y'; this is where the version-bump-on-collision logic and
# the actual GitHub release live)
# ════════════════════════════════════════════════════════════════════════════

[[ -n "${GITHUB_TOKEN:-}" ]] || die "GITHUB_TOKEN is not set. Export a GitHub Personal Access Token with repo scope."

command -v cosign &>/dev/null || die "cosign is not installed. See https://docs.sigstore.dev/cosign/system_config/installation/"
COSIGN_KEY_PATH="${COSIGN_KEY_PATH:-$REPO_ROOT/cosign.key}"
[[ -f "$COSIGN_KEY_PATH" ]] || die "Cosign private key not found at $COSIGN_KEY_PATH. Run 'cosign generate-key-pair' once in the repo root."
[[ -n "${COSIGN_PASSWORD:-}" ]] || die "COSIGN_PASSWORD is not set."

REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null) || die "could not read git remote"
GITHUB_REPO=$(echo "$REMOTE_URL" | sed 's|.*github.com[:/]||; s|\.git$||')
[[ -n "$GITHUB_REPO" ]] || die "could not parse GitHub repo from remote: $REMOTE_URL"

MANIFEST_JSON=$(python3 -c "
import yaml, json
with open('$MODULE_DIR/manifest.yaml') as f:
    m = yaml.safe_load(f) or {}
def lang_map(v):
    if isinstance(v, str):
        return {'en': v} if v else {}
    if isinstance(v, dict):
        return v
    return {}
print(json.dumps({
    'name': m.get('name') or '',
    'version': m.get('version') or '',
    'category': m.get('category') or '',
    'description': lang_map(m.get('description')),
    'display_name': lang_map(m.get('display_name')),
    'logo': m.get('logo') or '',
}))
") || die "failed to parse $MODULE_DIR/manifest.yaml"

NAME=$(echo "$MANIFEST_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")
VERSION=$(echo "$MANIFEST_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
CATEGORY=$(echo "$MANIFEST_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['category'])")
DESCRIPTION_JSON=$(echo "$MANIFEST_JSON" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['description']))")
DISPLAY_NAME_JSON=$(echo "$MANIFEST_JSON" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['display_name']))")
LOGO=$(echo "$MANIFEST_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['logo'])")

[[ -n "$NAME" ]]     || die "could not read 'name' from manifest.yaml"
[[ -n "$VERSION" ]]  || die "could not read 'version' from manifest.yaml"
[[ -n "$CATEGORY" ]] || CATEGORY="productivity"
[[ "$DESCRIPTION_JSON" != "{}" ]] || warn "no 'description' in manifest.yaml — store entry will have none"

# --- Auto-bump patch version if this version already has a GitHub release --
# Convenience: instead of failing because manifest.yaml's version was
# already released, bump the patch number (repeatedly, in case several
# versions were skipped) and rewrite manifest.yaml. Saves having to
# remember to hand-edit the version before every release.
version_tag_exists() {
  local v="$1"
  curl -sf -o /dev/null \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases/tags/${NAME}-v${v}"
}

ORIGINAL_VERSION="$VERSION"
MANIFEST_BUMPED=0
if version_tag_exists "$VERSION"; then
  step "Version $VERSION is already released as ${NAME}-v${VERSION} — bumping patch version"
  while version_tag_exists "$VERSION"; do
    IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
    if [[ -z "$MAJOR" || -z "$MINOR" || -z "$PATCH" ]]; then
      die "Version '$VERSION' isn't in MAJOR.MINOR.PATCH form — can't auto-bump. Edit manifest.yaml manually."
    fi
    VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
  done
  warn "Bumped version: $ORIGINAL_VERSION → $VERSION"

  # Targeted line replace (not a full yaml.safe_load + dump round-trip) so
  # comments, formatting, and key order elsewhere in the file survive.
  MODULE_DIR="$MODULE_DIR" OLD_VERSION="$ORIGINAL_VERSION" NEW_VERSION="$VERSION" python3 -c "
import re, os
path = os.path.join(os.environ['MODULE_DIR'], 'manifest.yaml')
old = os.environ['OLD_VERSION']
new = os.environ['NEW_VERSION']
with open(path) as f:
    content = f.read()
pattern = re.compile(r'^(version:\s*)([\'\"]?)' + re.escape(old) + r'\2\s*$', re.MULTILINE)
new_content, n = pattern.subn(lambda m: m.group(1) + m.group(2) + new + m.group(2), content, count=1)
if n != 1:
    raise SystemExit(f'expected exactly 1 version line to replace, found {n}')
with open(path, 'w') as f:
    f.write(new_content)
" || die "Failed to update version in manifest.yaml"
  ok "manifest.yaml updated to version $VERSION"
  MANIFEST_BUMPED=1
fi

BROWSE_URL="https://github.com/$GITHUB_REPO/tree/main/$MODULE"

LOGO_URL=""
if [[ -n "$LOGO" ]]; then
  [[ -f "$MODULE_DIR/$LOGO" ]] || die "manifest.yaml references logo '$LOGO' but $MODULE_DIR/$LOGO does not exist"
  LOGO_URL="https://raw.githubusercontent.com/$GITHUB_REPO/main/$MODULE/$LOGO"
fi

TAG="${NAME}-v${VERSION}"
ZIP_NAME="${NAME}-v${VERSION}.zip"

echo
BLUE_LINE() { printf "%s%s%s\n" "$BLUE" "$1" "$RESET"; }
BLUE_LINE "═══════════════════════════════════════════════"
BLUE_LINE " ModuLab Module Build"
BLUE_LINE " Module : $NAME"
BLUE_LINE " Version: $VERSION"
BLUE_LINE " Tag    : $TAG"
BLUE_LINE " Repo   : $GITHUB_REPO"
BLUE_LINE "═══════════════════════════════════════════════"

# UI already built + checked above in Part 1 (npm run build already ran as
# a check); no need to rebuild here, dist/bundle output is already on disk.
if [ -f "$UI_DIR/package.json" ]; then
  ok "bundle already built in Part 1 checks — reusing $MODULE/bundle/"
else
  echo "  (no ui/ — nothing to build)"
fi

# ── Create ZIP ────────────────────────────────────────────────────────────────
step "Creating $ZIP_NAME..."
DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"
rm -f "$ZIP_PATH" "$ZIP_PATH.sha256"

cd "$MODULE_DIR"
zip -qr "$ZIP_PATH" . \
  --exclude "ui/node_modules/*" \
  --exclude "ui/src/*" \
  --exclude "ui/vite.config.ts" \
  --exclude "ui/tsconfig*" \
  --exclude "ui/package*.json" \
  --exclude "*.DS_Store" \
  --exclude ".git/*"
cd "$REPO_ROOT"
ok "$ZIP_PATH"

# ── SHA256 ────────────────────────────────────────────────────────────────────
step "Computing SHA256..."
if command -v shasum &>/dev/null; then
  SHA256=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
else
  SHA256=$(sha256sum "$ZIP_PATH" | awk '{print $1}')
fi
echo "$SHA256" > "$ZIP_PATH.sha256"
ok "$SHA256"

# ── Cosign signature ──────────────────────────────────────────────────────────
step "Signing $ZIP_NAME with cosign..."
BUNDLE_PATH="$ZIP_PATH.cosign.bundle"
rm -f "$BUNDLE_PATH"
COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign-blob \
  --key "$COSIGN_KEY_PATH" \
  --bundle "$BUNDLE_PATH" \
  --yes \
  "$ZIP_PATH" > /dev/null || die "cosign sign-blob failed"
ok "$BUNDLE_PATH"

# ── Remote sync check (before creating a release / committing registry.json) ─
step "Git: checking sync status with origin"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
AHEAD=0
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  warn "Detached HEAD — skipping remote sync check."
elif git fetch origin "$BRANCH" --quiet 2>/dev/null && git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
  BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
  if [ "$BEHIND" -gt 0 ]; then
    die "Local branch is $BEHIND commit(s) behind origin/$BRANCH — run 'git pull' first."
  fi
  ok "In sync with origin/$BRANCH."
else
  warn "Could not compare against origin — proceeding anyway."
fi

# ── GitHub Release ────────────────────────────────────────────────────────────
step "Creating GitHub Release $TAG..."

EXISTING=$(curl -sf \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GITHUB_REPO/releases/tags/$TAG" 2>/dev/null || true)

if [[ -n "$EXISTING" ]]; then
  RELEASE_ID=$(echo "$EXISTING" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  UPLOAD_URL=$(echo "$EXISTING" | python3 -c "import sys,json; print(json.load(sys.stdin)['upload_url'])" | sed 's/{.*}//')
  echo "  Release already exists (id=$RELEASE_ID) — reusing it"
else
  RELEASE_JSON=$(curl -sf \
    -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases" \
    -d "{
      \"tag_name\": \"$TAG\",
      \"name\": \"$NAME v$VERSION\",
      \"body\": \"ModuLab module release — built by check-build-and-push.sh\",
      \"draft\": false,
      \"prerelease\": false
    }") || die "Failed to create GitHub Release. Check your GITHUB_TOKEN."

  RELEASE_ID=$(echo "$RELEASE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  UPLOAD_URL=$(echo "$RELEASE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['upload_url'])" | sed 's/{.*}//')
  ok "Release created (id=$RELEASE_ID)"
fi

# ── Upload assets ─────────────────────────────────────────────────────────────
step "Uploading assets..."

upload_asset() {
  local FILE="$1"
  local FILENAME=$(basename "$FILE")

  EXISTING_ASSET=$(curl -sf \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases/$RELEASE_ID/assets" \
    | python3 -c "
import sys, json
assets = json.load(sys.stdin)
for a in assets:
    if a['name'] == '$FILENAME':
        print(a['id'])
        break
" 2>/dev/null || true)

  if [[ -n "$EXISTING_ASSET" ]]; then
    curl -sf \
      -X DELETE \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$GITHUB_REPO/releases/assets/$EXISTING_ASSET" > /dev/null
  fi

  curl -sf \
    -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    "${UPLOAD_URL}?name=${FILENAME}" \
    --data-binary "@$FILE" > /dev/null || die "Failed to upload $FILENAME"

  ok "$FILENAME"
}

upload_asset "$ZIP_PATH"
upload_asset "$ZIP_PATH.sha256"
upload_asset "$BUNDLE_PATH"

# ── Update registry.json ──────────────────────────────────────────────────────
step "Updating registry.json..."

REGISTRY="$REPO_ROOT/registry.json"
RELEASE_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/$ZIP_NAME"
SIG_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/$ZIP_NAME.cosign.bundle"

NEW_ENTRY=$(NAME="$NAME" VERSION="$VERSION" RELEASE_URL="$RELEASE_URL" SHA256="$SHA256" \
            SIG_URL="$SIG_URL" CATEGORY="$CATEGORY" DESCRIPTION_JSON="$DESCRIPTION_JSON" \
            DISPLAY_NAME_JSON="$DISPLAY_NAME_JSON" LOGO_URL="$LOGO_URL" BROWSE_URL="$BROWSE_URL" python3 -c "
import json, os
entry = {
    'name': os.environ['NAME'],
    'version': os.environ['VERSION'],
    'release_url': os.environ['RELEASE_URL'],
    'sha256': os.environ['SHA256'],
    'cosign_sig_url': os.environ['SIG_URL'],
    'category': os.environ['CATEGORY'],
    'description': json.loads(os.environ.get('DESCRIPTION_JSON') or '{}'),
    'display_name': json.loads(os.environ.get('DISPLAY_NAME_JSON') or '{}'),
    'logo_url': os.environ.get('LOGO_URL', ''),
    'browse_url': os.environ.get('BROWSE_URL', '')
}
print(json.dumps(entry, indent=2))
")

python3 -c "
import json, sys
try:
    with open('$REGISTRY') as f:
        registry = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    registry = []
registry = [e for e in registry if e.get('name') != '$NAME']
registry.append(json.loads(sys.stdin.read()))
registry.sort(key=lambda e: e['name'])
with open('$REGISTRY', 'w') as f:
    json.dump(registry, f, indent=2)
    f.write('\n')
" <<< "$NEW_ENTRY"

ok "registry.json updated"

# ── Git commit + push ─────────────────────────────────────────────────────────
# git add -A here, not just registry.json/manifest.yaml — the release was
# just zipped straight off the working tree, so any other uncommitted
# changes in the module (or elsewhere in the repo) are already part of the
# artifact that just got uploaded to GitHub. Leaving them uncommitted would
# mean the released zip and the repo's git history silently diverge.
step "Committing everything (registry.json + module changes)..."

cd "$REPO_ROOT"
git_sanity_check || exit 1
git add -A
git diff --cached --quiet && echo "  (nothing to commit)" || {
  git diff --cached --stat

  # Interactive, same as the non-release commit path and modulab-core's
  # check-and-push.sh — but with a suggested default, since "release(name):
  # vX.Y.Z" is almost always exactly what you want here. Leave it empty
  # (just Ctrl+D) to accept the default, or type your own message.
  DEFAULT_MSG="release($NAME): v$VERSION"
  echo
  printf "%sCommit message%s (Enter, then Ctrl+D — leave empty to use \"%s\"):\n" "$BOLD" "$RESET" "$DEFAULT_MSG"
  COMMIT_MSG="$(cat)"
  [[ -n "$COMMIT_MSG" ]] || COMMIT_MSG="$DEFAULT_MSG"

  git commit -m "$COMMIT_MSG" || die "git commit failed."
  ok "Committed."

  if [ $DO_PUSH -eq 1 ]; then
    git push || die "git push failed — commit is local, push manually."
    ok "Pushed to origin"
  else
    warn "Skipping push (--no-push). Commit is local."
  fi
}

# ── Prune old releases ────────────────────────────────────────────────────────
if [[ -n "${KEEP_RELEASES:-}" && "${KEEP_RELEASES}" =~ ^[0-9]+$ && "${KEEP_RELEASES}" -gt 0 ]]; then
  step "Pruning old releases for '$NAME' (keeping the newest $KEEP_RELEASES)..."

  ALL_RELEASES=$(curl -sf \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases?per_page=100") || die "Failed to list releases for pruning."

  TO_DELETE=$(echo "$ALL_RELEASES" | python3 -c "
import sys, json
releases = json.load(sys.stdin)
mine = [r for r in releases if r['tag_name'].startswith('$NAME-v')]
mine.sort(key=lambda r: r['created_at'], reverse=True)
keep = int('$KEEP_RELEASES')
for r in mine[keep:]:
    print(f\"{r['id']}\t{r['tag_name']}\")
")

  if [[ -z "$TO_DELETE" ]]; then
    echo "  (nothing to prune)"
  else
    while IFS=$'\t' read -r OLD_ID OLD_TAG; do
      [[ -z "$OLD_ID" ]] && continue
      curl -sf -X DELETE \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$GITHUB_REPO/releases/$OLD_ID" > /dev/null \
        || { fail "  ! failed to delete release $OLD_TAG (id=$OLD_ID), continuing"; continue; }
      curl -sf -X DELETE \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$GITHUB_REPO/git/refs/tags/$OLD_TAG" > /dev/null 2>&1 || true
      ok "deleted $OLD_TAG"
    done <<< "$TO_DELETE"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo
GREEN_LINE() { printf "%s%s%s\n" "$GREEN" "$1" "$RESET"; }
GREEN_LINE "═══════════════════════════════════════════════"
GREEN_LINE " Release complete!"
GREEN_LINE ""
GREEN_LINE " https://github.com/$GITHUB_REPO/releases/tag/$TAG"
GREEN_LINE ""
GREEN_LINE " In ModuLab: Admin → Module store → Sync"
GREEN_LINE "═══════════════════════════════════════════════"
echo
