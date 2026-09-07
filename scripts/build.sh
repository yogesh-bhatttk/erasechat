#!/usr/bin/env bash
#
# Build clean, store-ready packages for both targets.
#
#   dist/bulk-clean-for-slack-chrome-<version>.zip    -> uses manifest.json (service worker)
#   dist/bulk-clean-for-slack-firefox-<version>.zip   -> uses manifest.firefox.json (event page)
#
# Only runtime files are shipped; tests, tooling, and dev docs are excluded. Run from
# the repo root:  npm run build   (or)   bash scripts/build.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' is required but not installed." >&2; exit 1; }

VERSION="$(node -p "require('./manifest.json').version")"
DIST="$ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST/chrome" "$DIST/firefox"

# Runtime assets shipped in BOTH packages (the manifest is added per target below).
# privacy.html ships because the popup links to it (in-extension policy page);
# LICENSE ships for hygiene.
ASSETS=(
  background.js
  content.js
  content.css
  popup.html
  popup.js
  popup.css
  popup
  privacy.html
  shared-filters.js
  _locales
  icons
  fonts
  LICENSE
  dashboard-reddit.html
  dashboard-reddit.js
  dashboard-reddit.css
  dashboard-x.html
  dashboard-x.js
  dashboard-x.css
)

copy_assets() {
  local dest="$1"
  for item in "${ASSETS[@]}"; do
    if [ ! -e "$item" ]; then
      echo "error: expected asset '$item' is missing." >&2
      exit 1
    fi
    cp -r "$item" "$dest"/
  done
}

echo "Building Chrome/Chromium package (manifest.json)..."
copy_assets "$DIST/chrome"
cp manifest.json "$DIST/chrome/manifest.json"
( cd "$DIST/chrome" && zip -qr "$DIST/bulk-clean-for-slack-chrome-$VERSION.zip" . )

echo "Building Firefox package (manifest.firefox.json -> manifest.json)..."
copy_assets "$DIST/firefox"
cp manifest.firefox.json "$DIST/firefox/manifest.json"
( cd "$DIST/firefox" && zip -qr "$DIST/bulk-clean-for-slack-firefox-$VERSION.zip" . )

echo ""
echo "Done. Packages (v$VERSION):"
ls -1sh "$DIST"/*.zip
