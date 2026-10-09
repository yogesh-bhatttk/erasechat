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
# ERASECHAT_DIST overrides the output folder (tests/packaging.test.js builds into a
# temp dir instead of touching dist/).
DIST="${ERASECHAT_DIST:-$ROOT/dist}"
rm -rf "$DIST"
mkdir -p "$DIST/chrome" "$DIST/firefox"

# ERASECHAT_SKIP_TELEGRAM_BUILD=1 reuses already-built bundles (npm test builds
# them first; re-running webpack inside the test would double its time and memory).
if [ "${ERASECHAT_SKIP_TELEGRAM_BUILD:-}" = "1" ] && [ -f platforms/telegram/telegram-dashboard.bundle.js ]; then
  echo "Reusing existing Telegram bundles (ERASECHAT_SKIP_TELEGRAM_BUILD=1)."
else
  echo "Bundling Telegram's MTProto client (webpack)..."
  node scripts/build-telegram.js
fi

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
  # (*.src.js, only esbuild/webpack ever load these) and sourcemaps. Neither is
  # loaded by the built extension, so prune them rather than list every
  # platform's runtime files by hand the way ASSETS above does for everything
  # outside platforms/.
  find "$dest/platforms" -name '*.src.js' -delete
  find "$dest/platforms" -name '*.bundle.js.map' -delete
  # Build-time only: webpack aliases `function-bind` to this shim and inlines it
  # into the Telegram bundles; nothing loads the file itself at runtime.
  find "$dest/platforms" -name 'function-bind-shim.js' -delete
  # *.bundle.js.LICENSE.txt is deliberately KEPT: Terser moves the third-party
  # copyright/license comments (teleproto and its polyfills, MIT and others) out
  # of the minified bundle into that file, and MIT requires the notice to ship
  # with the code.
}

# Reproducible zips: the same commit must always produce byte-identical packages, so
# a store upload can be re-derived from the tag and compared. Three things otherwise
# leak the build machine into the archive -- file order (filesystem-dependent), file
# timestamps (checkout/copy time) and owner/permission extras -- so all three are
# pinned. SOURCE_DATE_EPOCH (https://reproducible-builds.org/specs/source-date-epoch/)
# defaults to the last commit's time; zip's DOS timestamps are local time, hence TZ=UTC.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 315532800)}"
export SOURCE_DATE_EPOCH

deterministic_zip() {
  local src="$1" out="$2"
  # Normalise modes (cp preserves the checkout's, which depends on umask) and mtimes.
  find "$src" -type d -exec chmod 755 {} +
  find "$src" -type f -exec chmod 644 {} +
  node -e '
    const fs = require("fs"), path = require("path");
    const t = Number(process.env.SOURCE_DATE_EPOCH);
    (function walk(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        fs.utimesSync(full, t, t);
      }
    })(process.argv[1]);
  ' "$src"
  # -X drops uid/gid + extended-timestamp extras; the sorted list (C locale, files
  # only) fixes entry order; -D omits directory entries whose order/mtime would vary.
  ( cd "$src" && find . -type f | LC_ALL=C sort | TZ=UTC zip -q -X -D "$out" -@ )
}

echo "Building Chrome/Chromium package (manifest.json)..."
copy_assets "$DIST/chrome"
# manifest.json carries a "key" so unpacked dev builds keep a stable extension id
# (and the same chrome-extension:// origin) across machines. The Chrome Web Store
# assigns its own id and rejects/warns on an uploaded "key", so strip it from the
# store package only -- the repo copy keeps it for "Load unpacked".
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  delete m.key;
  fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
' manifest.json "$DIST/chrome/manifest.json"
deterministic_zip "$DIST/chrome" "$DIST/erasechat-chrome-$VERSION.zip"

echo "Building Firefox package (manifest.firefox.json -> manifest.json)..."
copy_assets "$DIST/firefox"
cp manifest.firefox.json "$DIST/firefox/manifest.json"
deterministic_zip "$DIST/firefox" "$DIST/erasechat-firefox-$VERSION.zip"

echo ""
echo "Done. Packages (v$VERSION):"
ls -1sh "$DIST"/*.zip
