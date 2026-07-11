#!/usr/bin/env bash
# build-module.sh — fully automated build + GitHub release for a ModuLab module.
#
# Usage:
#   ./scripts/build-module.sh <module-name>
#
# Requirements:
#   - GITHUB_TOKEN    env var with a Personal Access Token (repo scope)
#   - COSIGN_PASSWORD env var with the password for the cosign key
#   - cosign.key      in the repo root - the private cosign key (see below,
#                      never commit it, hence it's in .gitignore)
#   - npm             (for the UI build)
#   - curl, zip, jq, cosign, python3, PyYAML (`pip3 install pyyaml`) - PyYAML
#     is used to parse manifest.yaml properly (rather than sed/grep) so nested
#     fields like description's per-language map parse correctly
#
# Optional:
#   - KEEP_RELEASES   env var (integer) - if set, deletes older GitHub
#                      releases for THIS module after a successful release,
#                      keeping only the newest N (including the one just
#                      created). Unset/0 = disabled, nothing is pruned
#                      (default, safe by default). See step 9 below.
#
# One-time setup of the signing key (only for the very first release):
#   1. cosign generate-key-pair
#      → creates cosign.key (private, password-protected) and cosign.pub in
#        the current directory. Run this in the repo root.
#   2. Paste the contents of cosign.pub as-is into modulab-core:
#      backend/internal/modules/cosign_pubkey.pem
#      (see the comment there - as long as that file has no real PEM header,
#      Core skips the signature check for all official modules.)
#   3. Keep cosign.key somewhere safe (password manager) - whoever has this
#      key can impersonate an "official ModuLab module".
#
# What this script does:
#   1. Reads name/version/category/description/display_name/logo from
#      <module>/manifest.yaml (description and display_name are both maps
#      of language code → text, e.g. {en: "...", de: "..."}; logo is an
#      optional filename resolved to an absolute raw.githubusercontent.com URL)
#   2. Builds the React UI (if ui/package.json exists)
#   3. Creates dist/<module>-v<version>.zip (release-relevant files only)
#   4. Computes SHA256
#   5. Signs the zip with cosign sign-blob using the new Sigstore bundle
#      format (--bundle; a JSON file with the signature + verification
#      material, cosign.key)
#   6. Creates a GitHub Release (tag: <module>-v<version>)
#   7. Uploads .zip + .zip.sha256 + .zip.cosign.bundle as release assets
#   8. Updates registry.json (incl. cosign_sig_url, description, display_name,
#      logo_url, browse_url) and commits + pushes
#   9. Optionally prunes older releases for this module (see KEEP_RELEASES above)

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────────────
red()   { echo -e "\033[0;31m$*\033[0m"; }
green() { echo -e "\033[0;32m$*\033[0m"; }
blue()  { echo -e "\033[0;34m$*\033[0m"; }
step()  { echo; blue "▶ $*"; }
ok()    { green "  ✓ $*"; }
die()   { red "Error: $*" >&2; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────
[[ $# -ne 1 ]] && die "Usage: $0 <module-name>"

MODULE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODULE_DIR="$REPO_ROOT/$MODULE"

[[ -d "$MODULE_DIR" ]]           || die "module directory not found: $MODULE_DIR"
[[ -f "$MODULE_DIR/manifest.yaml" ]] || die "manifest.yaml not found in $MODULE_DIR"

# ── GitHub token ──────────────────────────────────────────────────────────────
[[ -n "${GITHUB_TOKEN:-}" ]] || die "GITHUB_TOKEN is not set. Export a GitHub Personal Access Token with repo scope."

# ── Cosign ────────────────────────────────────────────────────────────────────
# Official modules must be signed (README.md: "mandatory cosign sign-blob
# signing"). Checked up front, before any build work happens, so a missing
# key/tool fails fast instead of after minutes of npm install + zip.
command -v cosign &>/dev/null || die "cosign is not installed. See https://docs.sigstore.dev/cosign/system_config/installation/"
COSIGN_KEY_PATH="${COSIGN_KEY_PATH:-$REPO_ROOT/cosign.key}"
[[ -f "$COSIGN_KEY_PATH" ]] || die "Cosign private key not found at $COSIGN_KEY_PATH. Run 'cosign generate-key-pair' once in the repo root (see this script's header comment) before releasing the first module."
[[ -n "${COSIGN_PASSWORD:-}" ]] || die "COSIGN_PASSWORD is not set. Export the password for $COSIGN_KEY_PATH (needed for non-interactive signing)."

# ── Read repo from git remote ─────────────────────────────────────────────────
REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null) || die "could not read git remote"
# https://github.com/owner/repo.git → owner/repo
GITHUB_REPO=$(echo "$REMOTE_URL" | sed 's|.*github.com[:/]||; s|\.git$||')
[[ -n "$GITHUB_REPO" ]] || die "could not parse GitHub repo from remote: $REMOTE_URL"

# ── Read manifest ─────────────────────────────────────────────────────────────
# Parsed with PyYAML rather than sed/grep: description is a nested map (one
# key per language code, same shape as display_name), which line-based
# regex extraction can't handle reliably.
command -v python3 &>/dev/null || die "python3 is not installed."
python3 -c "import yaml" 2>/dev/null || die "PyYAML is not installed. Run: pip3 install pyyaml"

MANIFEST_JSON=$(python3 -c "
import yaml, json

with open('$MODULE_DIR/manifest.yaml') as f:
    m = yaml.safe_load(f) or {}

def lang_map(v):
    # Shared helper for description/display_name: both are optional maps of
    # language code -> text, same shape. A plain string is treated as
    # English-only (legacy pre-i18n manifests) rather than failing the build.
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
[[ "$DESCRIPTION_JSON" != "{}" ]] || echo "  ⚠ no 'description' in manifest.yaml — store entry will have none"

# browse_url: link into the module's own subdirectory of this monorepo,
# not just the repo root - $MODULE is the actual on-disk directory name,
# which can differ from the manifest's own "name" field (e.g. directory
# "my-place" vs name "my-places").
BROWSE_URL="https://github.com/$GITHUB_REPO/tree/main/$MODULE"

# logo (optional): a filename relative to the module directory, e.g.
# "logo.png". Resolved here to an absolute raw.githubusercontent.com URL
# against the "main" branch, since Core reads registry.json only - it never
# fetches an official module's manifest.yaml or repo tree directly. Verified
# to actually exist in the module directory so a typo'd filename fails the
# build instead of silently shipping a 404 logo_url.
LOGO_URL=""
if [[ -n "$LOGO" ]]; then
  [[ -f "$MODULE_DIR/$LOGO" ]] || die "manifest.yaml references logo '$LOGO' but $MODULE_DIR/$LOGO does not exist"
  LOGO_URL="https://raw.githubusercontent.com/$GITHUB_REPO/main/$MODULE/$LOGO"
fi

TAG="${NAME}-v${VERSION}"
ZIP_NAME="${NAME}-v${VERSION}.zip"

echo
blue "═══════════════════════════════════════════════"
blue " ModuLab Module Build"
blue " Module : $NAME"
blue " Version: $VERSION"
blue " Tag    : $TAG"
blue " Repo   : $GITHUB_REPO"
blue "═══════════════════════════════════════════════"

# ── Build UI ──────────────────────────────────────────────────────────────────
UI_DIR="$MODULE_DIR/ui"
if [[ -f "$UI_DIR/package.json" ]]; then
  step "Building React UI..."
  cd "$UI_DIR"
  npm install --silent
  npm run build --silent
  cd "$REPO_ROOT"
  ok "bundle.js written to $MODULE/bundle/"
else
  echo "  (no ui/ — skipping UI build)"
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
# Uses the new Sigstore bundle format (--bundle) rather than the deprecated
# --output-signature, per cosign's own guidance (docs.sigstore.dev/cosign/signing/signing_with_blobs).
# The bundle is a JSON file containing the signature plus verification material;
# Core's VerifyCosign (backend/internal/modules/verifier.go) verifies it with
# `cosign verify-blob --key <pubkey> --bundle <bundle-file>`.
step "Signing $ZIP_NAME with cosign..."
BUNDLE_PATH="$ZIP_PATH.cosign.bundle"
rm -f "$BUNDLE_PATH"
COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign-blob \
  --key "$COSIGN_KEY_PATH" \
  --bundle "$BUNDLE_PATH" \
  --yes \
  "$ZIP_PATH" > /dev/null || die "cosign sign-blob failed"
ok "$BUNDLE_PATH"

# ── GitHub Release ────────────────────────────────────────────────────────────
step "Creating GitHub Release $TAG..."

# Check if release already exists
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
      \"body\": \"ModuLab module release — built by build-module.sh\",
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

  # Delete existing asset with the same name if present
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

# Build the new entry. Passed via env vars (not interpolated into the Python
# source string) because free text - and JSON - may contain quotes,
# apostrophes, or other characters that would otherwise break the literal.
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

# Read existing registry, remove old entry for this module, add new one
python3 -c "
import json, sys

try:
    with open('$REGISTRY') as f:
        registry = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    registry = []

# Remove existing entry for this module
registry = [e for e in registry if e.get('name') != '$NAME']

# Add updated entry
registry.append(json.loads(sys.stdin.read()))

# Sort by name for clean diffs
registry.sort(key=lambda e: e['name'])

with open('$REGISTRY', 'w') as f:
    json.dump(registry, f, indent=2)
    f.write('\n')
" <<< "$NEW_ENTRY"

ok "registry.json updated"

# ── Git commit + push ─────────────────────────────────────────────────────────
step "Committing and pushing registry.json..."

cd "$REPO_ROOT"
git add registry.json
git diff --cached --quiet && echo "  (registry.json unchanged — nothing to commit)" || {
  git commit -m "release($NAME): v$VERSION"
  git push
  ok "Pushed to origin"
}

# ── Prune old releases ────────────────────────────────────────────────────────
# Opt-in via KEEP_RELEASES (see header comment). Deletes older GitHub
# releases for THIS module only — other modules' releases are untouched,
# since they're matched by tag_name prefix "<name>-v".
if [[ -n "${KEEP_RELEASES:-}" && "${KEEP_RELEASES}" =~ ^[0-9]+$ && "${KEEP_RELEASES}" -gt 0 ]]; then
  step "Pruning old releases for '$NAME' (keeping the newest $KEEP_RELEASES)..."

  # per_page=100 covers a homelab-scale release history in one request; add
  # pagination here if a single module ever accumulates more releases than
  # that.
  ALL_RELEASES=$(curl -sf \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPO/releases?per_page=100") || die "Failed to list releases for pruning."

  # Only this module's releases (tag_name "<name>-v<version>"), newest first.
  # GitHub already returns releases newest-first, but sort explicitly by
  # created_at so this doesn't depend on that ordering being guaranteed.
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
        || { red "  ! failed to delete release $OLD_TAG (id=$OLD_ID), continuing"; continue; }
      # Deleting the release above does not delete the underlying git tag
      # (GitHub keeps those as two separate objects) — remove the tag ref
      # too, so `git fetch --tags` doesn't keep accumulating dead
      # module-release tags forever.
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
green "═══════════════════════════════════════════════"
green " Release complete!"
green ""
green " https://github.com/$GITHUB_REPO/releases/tag/$TAG"
green ""
green " In ModuLab: Admin → Module store → Sync"
green "═══════════════════════════════════════════════"
echo
