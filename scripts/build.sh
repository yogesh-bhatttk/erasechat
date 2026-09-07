#!/usr/bin/env bash
#
# Build clean, store-ready packages for both targets.
#
#   dist/erasechat-chrome-<version>.zip    -> uses manifest.json (service worker)
#   dist/erasechat-firefox-<version>.zip   -> uses manifest.firefox.json (event page)
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

echo "Bundling Bluesky's OAuth client (esbuild)..."
node scripts/build-bluesky.js

echo "Bundling Telegram's MTProto client (webpack)..."
node scripts/build-telegram.js

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
  platforms
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

  # platforms/ mixes each platform's shipped runtime files with bundler source
  # (*.src.js, only esbuild/webpack ever load these), sourcemaps, and Bluesky's
  # client-metadata.json (a doc-only reference copy of what's actually hosted --
  # see that file's own comment). None of these three are loaded by the built
  # extension, so prune them rather than list every platform's runtime files by
  # hand the way ASSETS above does for everything outside platforms/.
  find "$dest/platforms" -name '*.src.js' -delete
  find "$dest/platforms" -name '*.bundle.js.map' -delete
  rm -f "$dest/platforms/bluesky/client-metadata.json"
}

echo "Building Chrome/Chromium package (manifest.json)..."
copy_assets "$DIST/chrome"
cp manifest.json "$DIST/chrome/manifest.json"
( cd "$DIST/chrome" && zip -qr "$DIST/erasechat-chrome-$VERSION.zip" . )

echo "Building Firefox package (manifest.firefox.json -> manifest.json)..."
copy_assets "$DIST/firefox"
cp manifest.firefox.json "$DIST/firefox/manifest.json"
( cd "$DIST/firefox" && zip -qr "$DIST/erasechat-firefox-$VERSION.zip" . )

echo ""
echo "Done. Packages (v$VERSION):"
ls -1sh "$DIST"/*.zip
