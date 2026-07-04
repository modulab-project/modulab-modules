#!/usr/bin/env bash
# build-module.sh — vollautomatischer Build + GitHub Release für ein ModuLab-Modul.
#
# Usage:
#   ./scripts/build-module.sh <module-name>
#
# Voraussetzungen:
#   - GITHUB_TOKEN    env-Variable mit einem Personal Access Token (repo-Scope)
#   - COSIGN_PASSWORD env-Variable mit dem Passwort des Cosign-Schlüssels
#   - cosign.key      im Repo-Root - der private Cosign-Schlüssel (siehe unten,
#                      niemals committen, steht deswegen in .gitignore)
#   - npm             (für den UI-Build)
#   - curl, zip, jq, cosign
#
# Einmalige Einrichtung des Signier-Schlüssels (nur beim allerersten Release):
#   1. cosign generate-key-pair
#      → erzeugt cosign.key (privat, passwortgeschützt) und cosign.pub im
#        aktuellen Verzeichnis. Im Repo-Root ausführen.
#   2. Den Inhalt von cosign.pub 1:1 in modulab-core einfügen:
#      backend/internal/modules/cosign_pubkey.pem
#      (siehe den Kommentar dort - solange die Datei keinen echten PEM-Header
#      enthält, überspringt Core die Signaturprüfung für alle offiziellen Module.)
#   3. cosign.key sicher aufbewahren (Passwort-Manager) - wer diesen Schlüssel
#      hat, kann sich als "offizielles ModuLab-Modul" ausgeben.
#
# Was das Skript macht:
#   1. Liest name/version/category aus <module>/manifest.yaml
#   2. Baut die React-UI  (falls ui/package.json vorhanden)
#   3. Erstellt dist/<module>-v<version>.zip  (nur Release-relevante Dateien)
#   4. Berechnet SHA256
#   5. Signiert die ZIP mit cosign sign-blob (cosign.key)
#   6. Erstellt einen GitHub Release (Tag: <module>-v<version>)
#   7. Lädt .zip + .zip.sha256 + .zip.sig als Release-Assets hoch
#   8. Aktualisiert registry.json (inkl. cosign_sig_url) und committet + pusht

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
yaml_field() { grep -E "^$1:" "$MODULE_DIR/manifest.yaml" | head -1 | sed "s/$1:[[:space:]]*//" | tr -d '"'"'" | tr -d '[:space:]'; }

NAME=$(yaml_field name)
VERSION=$(yaml_field version)
CATEGORY=$(yaml_field category)

[[ -n "$NAME" ]]     || die "could not read 'name' from manifest.yaml"
[[ -n "$VERSION" ]]  || die "could not read 'version' from manifest.yaml"
[[ -n "$CATEGORY" ]] || CATEGORY="productivity"

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
step "Signing $ZIP_NAME with cosign..."
SIG_PATH="$ZIP_PATH.sig"
rm -f "$SIG_PATH"
COSIGN_PASSWORD="$COSIGN_PASSWORD" cosign sign-blob \
  --key "$COSIGN_KEY_PATH" \
  --output-signature "$SIG_PATH" \
  --yes \
  "$ZIP_PATH" > /dev/null || die "cosign sign-blob failed"
ok "$SIG_PATH"

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
upload_asset "$SIG_PATH"

# ── Update registry.json ──────────────────────────────────────────────────────
step "Updating registry.json..."

REGISTRY="$REPO_ROOT/registry.json"
RELEASE_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/$ZIP_NAME"
SIG_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/$ZIP_NAME.sig"

# Build the new entry
NEW_ENTRY=$(python3 -c "
import json
entry = {
    'name': '$NAME',
    'version': '$VERSION',
    'release_url': '$RELEASE_URL',
    'sha256': '$SHA256',
    'cosign_sig_url': '$SIG_URL',
    'category': '$CATEGORY'
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

# ── Done ──────────────────────────────────────────────────────────────────────
echo
green "═══════════════════════════════════════════════"
green " Release complete!"
green ""
green " https://github.com/$GITHUB_REPO/releases/tag/$TAG"
green ""
green " In ModuLab: Admin → Modul-Store → Sync"
green "═══════════════════════════════════════════════"
echo
