#!/usr/bin/env bash
#
# Set the release version in every place it appears, atomically.
#
#   npm run version:set 1.0.1
#
# The version lives in THREE files that must agree: manifest.json (Chrome),
# manifest.firefox.json (Firefox) and package.json. `npm test` fails if they drift, and
# the release workflow additionally refuses a tag that disagrees with them — so the
# failure mode of hand-editing is a blocked release, not a silent mismatch. This script
# removes the chance to get it wrong in the first place.
#
# Both stores refuse to accept a version number that has already been uploaded, so a
# botched bump costs a whole version. Hence the strict validation below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NEW_VERSION="${1:-}"

if [ -z "$NEW_VERSION" ]; then
  current="$(node -p "require('./manifest.json').version")"
  echo "usage: npm run version:set <version>    (current: $current)" >&2
  exit 1
fi

# Chrome requires 1-4 dot-separated integers, each 0-65535, no leading zeros beyond "0".
# Firefox is looser, so Chrome's rule is the binding one — validate against it.
if ! printf '%s' "$NEW_VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){0,3}$'; then
  echo "error: '$NEW_VERSION' is not a valid extension version (expected 1-4 dot-separated integers, e.g. 1.0.1)." >&2
  exit 1
fi

node - "$NEW_VERSION" <<'NODE'
const fs = require("node:fs");

const version = process.argv[2];

for (const part of version.split(".")) {
  if (Number(part) > 65535) {
    console.error(`error: version segment '${part}' exceeds the 65535 maximum Chrome allows.`);
    process.exit(1);
  }
  if (part.length > 1 && part.startsWith("0")) {
    console.error(`error: version segment '${part}' has a leading zero, which Chrome rejects.`);
    process.exit(1);
  }
}

// Rewrite only the top-level "version" line so formatting, key order and comments-in-
// JSON-adjacent style stay byte-identical apart from the number itself. A full
// JSON.parse/stringify round-trip would reflow all three files on every bump.
const files = ["manifest.json", "manifest.firefox.json", "package.json"];
const previous = JSON.parse(fs.readFileSync("manifest.json", "utf8")).version;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const updated = src.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (updated === src) {
    console.error(`error: no top-level "version" field found in ${file}.`);
    process.exit(1);
  }
  fs.writeFileSync(file, updated);
}

// package-lock.json carries the version twice (root entry and the "" package entry).
if (fs.existsSync("package-lock.json")) {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
}

console.log(`Version ${previous} -> ${version} in ${files.join(", ")} (+ package-lock.json).`);
NODE

echo ""
echo "Next:"
echo "  1. Move the CHANGELOG.md 'Unreleased' heading to $NEW_VERSION and date it."
echo "  2. npm run verify        # full gate: lint, tests, e2e, build, addons-linter"
echo "  3. git commit -am \"Release v$NEW_VERSION\" && git tag v$NEW_VERSION && git push --follow-tags"
echo "     CI publishes both store zips to the GitHub release for that tag."
