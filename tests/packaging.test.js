// Erasechat — packaging & manifest gate (node --test)
//
// These are the checks that otherwise only fail late, in a store review queue:
// a manifest property AMO rejects, a version that drifted between the two manifests
// and package.json, a file referenced by a manifest but missing from the build, or an
// __MSG_ placeholder with no matching locale key. Cheap to run, expensive to discover
// after submitting.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

const chromeManifest = readJson("manifest.json");
const firefoxManifest = readJson("manifest.firefox.json");
const pkg = readJson("package.json");
const messages = readJson("_locales/en/messages.json");
const { PLATFORMS } = require(path.join(ROOT, "popup/platform-registry.js"));

// Every file path a manifest can point at, so a rename can't silently ship broken.
function referencedFiles(manifest) {
  const files = [];
  if (manifest.background?.service_worker) files.push(manifest.background.service_worker);
  for (const s of manifest.background?.scripts || []) files.push(s);
  for (const cs of manifest.content_scripts || []) {
    for (const j of cs.js || []) files.push(j);
    for (const c of cs.css || []) files.push(c);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) files.push(r);
  }
  for (const icon of Object.values(manifest.icons || {})) files.push(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) files.push(icon);
  if (manifest.action?.default_popup) files.push(manifest.action.default_popup);
  return files;
}

// An HTML entry point (popup.html today; dashboard-<platform>.html as each
// platform's migration lands) can reference its own scripts/stylesheets that no
// manifest field mentions at all -- e.g. popup/platform-registry.js, loaded only via
// a <script src> tag inside popup.html. Manifest-derived referencedFiles() above is
// blind to these, which is exactly the gap that let a real "ships a popup.html that
// 404s on its own script" bug through once already.
function htmlReferencedFiles(relHtmlPath) {
  const html = fs.readFileSync(path.join(ROOT, relHtmlPath), "utf8");
  const dir = path.dirname(relHtmlPath);
  const files = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    files.push(path.normalize(path.join(dir, m[1])));
  }
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) {
    files.push(path.normalize(path.join(dir, m[1])));
  }
  return files;
}

test("version is identical across both manifests and package.json", () => {
  assert.strictEqual(chromeManifest.version, pkg.version, "manifest.json vs package.json");
  assert.strictEqual(firefoxManifest.version, pkg.version, "manifest.firefox.json vs package.json");
});

test("Firefox manifest declares the AMO data-collection disclosure as 'none'", () => {
  // AMO requires browser_specific_settings.gecko.data_collection_permissions for new
  // extensions; addons-linter warns (MISSING_DATA_COLLECTION_PERMISSIONS) without it.
  //
  // This also pins the disclosure to the promise made in PRIVACY_POLICY.md, privacy.html
  // and both store listings: nothing is collected. If a future change starts collecting
  // anything, this test fails and forces the manifest, the policy and the store answers
  // to be updated together rather than drifting apart.
  const gecko = firefoxManifest.browser_specific_settings?.gecko || {};
  const dcp = gecko.data_collection_permissions;

  assert.ok(dcp, "AMO requires a data_collection_permissions disclosure");
  assert.deepStrictEqual(dcp.required, ["none"], "the extension collects no data");
  assert.ok(!dcp.optional, "no optional data collection is declared or implemented");

  assert.ok(gecko.id, "Firefox build needs a stable extension id");
  assert.ok(gecko.strict_min_version, "Firefox build needs strict_min_version");
});

test("strict_min_version is high enough for every manifest key and API used", () => {
  // Each capability below landed in a specific Firefox version, and declaring support
  // for anything older is a promise the build cannot keep — addons-linter reports it on
  // every submission (KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION, ANDROID_INCOMPATIBLE_API,
  // KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION).
  //
  // 142 rather than 140: data_collection_permissions landed on DESKTOP in 140 but on
  // Firefox for Android in 142. Because gecko_android is deliberately absent (below),
  // addons-linter derives the Android floor from this same value — so 142 is what it
  // takes to validate with zero warnings. Verified by linting 140/141/142 builds: only
  // 142 comes back clean.
  //
  // The cost is deliberate and worth restating before anyone "optimises" it: 142 excludes
  // Firefox 140–141, and 140 is the current ESR (115 ESR died in March 2026). Enterprise
  // users pinned to ESR 140 cannot install this build. That was accepted to reach a clean
  // validator report; reverting to 140 trades one warning back for those users.
  const MIN_FOR_ANDROID_DATA_COLLECTION_PERMISSIONS = 142;
  const declared = parseFloat(firefoxManifest.browser_specific_settings.gecko.strict_min_version);

  assert.ok(declared >= MIN_FOR_ANDROID_DATA_COLLECTION_PERMISSIONS,
    `strict_min_version ${declared} is below ${MIN_FOR_ANDROID_DATA_COLLECTION_PERMISSIONS}, which is where ` +
    "Firefox for Android gained browser_specific_settings.gecko.data_collection_permissions. " +
    "Lowering it re-introduces KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION.");

  // The popup calls chrome.permissions.request(), which Firefox for Android does not
  // implement. It is feature-detected (see showPermissionRequiredState), and the add-on
  // deliberately does NOT declare gecko_android: the dashboard is a fixed 880x760
  // multi-panel modal with no viewport breakpoints, so claiming Android support would
  // ship a knowingly-unusable UI purely to silence a linter warning.
  assert.ok(!firefoxManifest.browser_specific_settings.gecko_android,
    "gecko_android must stay undeclared until the dashboard has a mobile layout");

  const popup = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  assert.match(popup, /typeof chrome\.permissions\.request === "function"/,
    "permissions.request must stay feature-detected for browsers that lack it");
});

test("the Firefox add-on id is a real UUID, not a template placeholder", () => {
  // AMO enforces global uniqueness of the gecko id and rejects an upload with
  // "Duplicate add-on ID found." Template/tutorial UUIDs like
  // {a1b2c3d4-e5f6-7890-abcd-ef1234567890} are already registered by whoever submitted
  // first, so shipping one costs a failed review cycle — and the id is permanent once a
  // listing exists, so it can only be fixed cheaply BEFORE the first successful upload.
  const id = firefoxManifest.browser_specific_settings.gecko.id;

  // A braced UUID, or the email-style form AMO also accepts.
  const braced = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
  const emailStyle = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  assert.ok(braced.test(id) || emailStyle.test(id),
    `gecko.id must be a braced UUID or an email-style id, got: ${id}`);

  if (braced.test(id)) {
    // Require a genuine random (v4) UUID: version nibble 4, variant nibble 8/9/a/b.
    // Hand-typed and sequential placeholders essentially never satisfy both.
    assert.match(id, /^\{[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i,
      `gecko.id looks hand-made rather than a random v4 UUID: ${id}. Generate one with: node -e "console.log(require('crypto').randomUUID())"`);

    // Reject visibly patterned ids (ascending hex runs, repeated digits) that would
    // pass the v4 shape by luck but are obviously copied from a template.
    const hex = id.replace(/[{}-]/g, "").toLowerCase();
    assert.ok(!/0123456789|abcdef|1234567890/.test(hex),
      `gecko.id contains a sequential run, so it is almost certainly a placeholder: ${id}`);
    assert.ok(new Set(hex).size > 8,
      `gecko.id uses too few distinct characters to be random: ${id}`);
  }

  // IDs already burned on AMO. Deleting an add-on permanently blocklists its GUID
  // (Mozilla does this to stop hostile takeover of a published identifier), so these can
  // never be submitted again by anyone — reusing one fails with "Duplicate add-on ID
  // found" forever. Restoring an old id from git history would silently re-break the
  // submission, so they are pinned here rather than left as folklore.
  const BURNED_IDS = [
    "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}", // original template placeholder
    "{2f1a47b2-e534-4428-8b9d-02c65f01bcad}"  // uploaded to AMO, then deleted
  ];
  assert.ok(!BURNED_IDS.includes(id.toLowerCase()),
    `gecko.id ${id} was deleted on AMO and is permanently blocklisted. ` +
    "Generate a new one: node -e \"console.log(require('crypto').randomUUID())\"");
});

test("background wiring matches each browser's supported form", () => {
  // Chromium MV3 rejects background.scripts; Firefox MV3 rejects service_worker.
  assert.ok(chromeManifest.background.service_worker, "Chrome needs a service_worker");
  assert.ok(!chromeManifest.background.scripts, "Chrome must not use background.scripts");

  assert.ok(Array.isArray(firefoxManifest.background.scripts), "Firefox needs background.scripts");
  assert.ok(!firefoxManifest.background.service_worker, "Firefox must not use service_worker");
  // shared-filters.js and every per-platform background listener must load BEFORE
  // background.js: Firefox has no importScripts, so ordering here is the only thing
  // that defines qualifies()/decideItemAction() and registers listeners like Teams'
  // webRequest one before background.js itself runs.
  assert.deepStrictEqual(firefoxManifest.background.scripts,
    ["shared-filters.js", "platforms/teams/teams-webrequest.js", "background.js"]);
});

test("shared-filters.js reaches the background in both browsers", () => {
  // Chrome gets it via importScripts inside the worker rather than the manifest.
  const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  assert.match(bg, /importScripts\(\s*["']shared-filters\.js["']\s*\)/,
    "Chrome relies on importScripts to load the shared filter logic");
});

test("every file referenced by either manifest exists on disk", () => {
  for (const [name, manifest] of [["manifest.json", chromeManifest], ["manifest.firefox.json", firefoxManifest]]) {
    for (const rel of referencedFiles(manifest)) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${name} references missing file: ${rel}`);
      if (rel.endsWith(".html")) {
        for (const htmlRel of htmlReferencedFiles(rel)) {
          assert.ok(fs.existsSync(path.join(ROOT, htmlRel)),
            `${rel} references missing file: ${htmlRel}`);
        }
      }
    }
  }
});

// scripts/build.sh's hand-maintained ASSETS list, parsed once and reused by every
// "does the build actually ship X" test below.
function shippedAssets() {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.sh"), "utf8");
  const assetBlock = build.split("ASSETS=(")[1].split(")")[0];
  return assetBlock.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
}

test("the build ships every runtime file both manifests reference", () => {
  // A file added to a manifest but forgotten in ASSETS produces a package that loads
  // and then breaks at runtime.
  const shipped = shippedAssets();

  const referenced = new Set([...referencedFiles(chromeManifest), ...referencedFiles(firefoxManifest)]);
  // Firefox loads shared-filters.js via the manifest; Chrome via importScripts, which
  // referencedFiles() cannot see — assert it explicitly.
  referenced.add("shared-filters.js");

  // Follow HTML entry points to their own <script src>/<link href> references too
  // (see htmlReferencedFiles's comment) -- iterate a snapshot since this adds to
  // `referenced` while looping over it.
  for (const rel of [...referenced]) {
    if (rel.endsWith(".html")) {
      for (const htmlRel of htmlReferencedFiles(rel)) referenced.add(htmlRel);
    }
  }

  for (const rel of referenced) {
    const topLevel = rel.split("/")[0];
    assert.ok(shipped.includes(rel) || shipped.includes(topLevel),
      `scripts/build.sh does not ship ${rel}`);
  }
});

test("every ready platform's dashboard file exists and is shipped by the build", () => {
  // Dashboard files are opened dynamically (chrome.tabs.create in popup.js), never
  // referenced by either manifest -- so referencedFiles() above can't see them at
  // all, and a platform going live without its dashboard in ASSETS would only be
  // caught by actually clicking it in a browser. popup/platform-registry.js is the
  // one place every platform's dashboard filename is written down, so it's the
  // right source of truth for this check too.
  const shipped = shippedAssets();
  for (const platform of PLATFORMS) {
    if (!platform.ready || !platform.dashboard) continue;

    assert.ok(fs.existsSync(path.join(ROOT, platform.dashboard)),
      `platform "${platform.id}" declares dashboard "${platform.dashboard}" but it doesn't exist`);

    const topLevel = platform.dashboard.split("/")[0];
    assert.ok(shipped.includes(platform.dashboard) || shipped.includes(topLevel),
      `scripts/build.sh does not ship platform "${platform.id}"'s dashboard: ${platform.dashboard}`);

    for (const htmlRel of htmlReferencedFiles(platform.dashboard)) {
      assert.ok(fs.existsSync(path.join(ROOT, htmlRel)),
        `${platform.dashboard} references missing file: ${htmlRel}`);
      const htmlTopLevel = htmlRel.split("/")[0];
      assert.ok(shipped.includes(htmlRel) || shipped.includes(htmlTopLevel),
        `scripts/build.sh does not ship ${htmlRel}, referenced by ${platform.dashboard}`);
    }
  }
});

test("every __MSG_ placeholder resolves to a locale key", () => {
  for (const [name, manifest] of [["manifest.json", chromeManifest], ["manifest.firefox.json", firefoxManifest]]) {
    for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
      assert.ok(messages[m[1]], `${name} references undefined locale key: ${m[1]}`);
    }
    assert.ok(manifest.default_locale, `${name} uses __MSG_ placeholders so it needs default_locale`);
  }
});

test("every data-i18n key in the UI resolves to a locale key", () => {
  // The manifest's __MSG_ placeholders are covered above, but the popup and the
  // injected dashboard localize at RUNTIME through data-i18n attributes, which no
  // manifest check can see. A typo'd or renamed key there is invisible until a user
  // on a localized build sees the raw English fallback (or, for attributes, nothing
  // at all). Covers popup.html and the dashboard markup inside content.js alike.
  const PLATFORM_DASHBOARD_HTML = [
    "platforms/x/dashboard-x.html",
    "platforms/teams/dashboard-teams.html",
    "platforms/mastodon/dashboard-mastodon.html",
    "platforms/reddit/dashboard-reddit.html",
    "platforms/telegram/dashboard-telegram.html"
  ];

  const sources = {
    "popup.html": fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"),
    "content.js": fs.readFileSync(path.join(ROOT, "content.js"), "utf8"),
    "privacy.html": fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8")
  };
  for (const rel of PLATFORM_DASHBOARD_HTML) {
    sources[rel] = fs.readFileSync(path.join(ROOT, rel), "utf8");
  }

  let checked = 0;
  for (const [name, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/data-i18n(?:-ph|-title|-aria|-placeholder)?=["']([A-Za-z0-9_]+)["']/g)) {
      assert.ok(messages[m[1]], `${name} references undefined locale key: ${m[1]}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "expected to find data-i18n attributes to verify");
});

test("locale keys used via the t() fallback helper exist too", () => {
  // t("key", "English fallback") is the JS-side counterpart to data-i18n. A missing
  // key here degrades silently to the fallback, so it never surfaces as a bug in the
  // default locale — only in translated builds.
  const FILES_USING_T = [
    "popup.js", "content.js", "background.js",
    "platforms/shared/dashboard-fetch-utils.js",
    "platforms/x/dashboard-x.js",
    "platforms/teams/dashboard-teams.js",
    "platforms/mastodon/dashboard-mastodon.js",
    "platforms/reddit/dashboard-reddit.js",
    "platforms/telegram/telegram-dashboard.src.js"
  ];
  for (const name of FILES_USING_T) {
    const src = fs.readFileSync(path.join(ROOT, name), "utf8");
    for (const m of src.matchAll(/\bt\(\s*["']([A-Za-z0-9_]+)["']/g)) {
      assert.ok(messages[m[1]], `${name} calls t() with an undefined locale key: ${m[1]}`);
    }
  }
});

test("locale file is well formed", () => {
  for (const [key, entry] of Object.entries(messages)) {
    assert.strictEqual(typeof entry, "object", `${key} must be an object`);
    assert.strictEqual(typeof entry.message, "string", `${key} needs a string message`);
    assert.ok(entry.message.length > 0, `${key} message must not be empty`);
  }
});

test("no message text accidentally forms a $NAME$ named placeholder", () => {
  // Chrome's messages.json format treats ANY "$...$" span as a NAMED placeholder
  // reference, which must have a matching "placeholders" entry or the whole
  // extension refuses to load ("Variable $X$ used but not defined"). This project
  // only ever uses bare numbered substitution ($1, $2, ...) with no "placeholders"
  // block anywhere -- so two adjacent numbered refs with nothing between them
  // (e.g. a message built as "$1" + "$2" = literal text "...$1$2...") reads as the
  // named placeholder "$1$" followed by a stray "2", and Chrome rejects the whole
  // package at install time. This was caught only by actually loading the built
  // extension, not by any positive test -- $1 resolving to a real key doesn't
  // catch $1 and $2 colliding into an invalid token.
  for (const locale of ["en", "es", "fr", "de"]) {
    const localeMessages = readJson(`_locales/${locale}/messages.json`);
    for (const [key, entry] of Object.entries(localeMessages)) {
      const collision = entry.message.match(/\$[A-Za-z0-9_]*\$/);
      assert.strictEqual(collision, null,
        `_locales/${locale}/messages.json: "${key}" contains ${collision && collision[0]}, which Chrome parses as an undefined named placeholder: "${entry.message}"`);
    }
  }
});

test("translated locales have exactly the same key set as English", () => {
  // A missing key silently falls back to English for that one string (no blank
  // label) -- not a crash, but a drift that's otherwise invisible until a user on
  // that locale spots the one untranslated string. An extra key is dead weight
  // that will never be read. Both are cheap to catch here.
  const enKeys = new Set(Object.keys(messages));
  for (const locale of ["es", "fr", "de"]) {
    const localeMessages = readJson(`_locales/${locale}/messages.json`);
    const localeKeys = new Set(Object.keys(localeMessages));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    const extra = [...localeKeys].filter((k) => !enKeys.has(k));
    assert.deepStrictEqual(missing, [], `_locales/${locale}/messages.json is missing keys present in English`);
    assert.deepStrictEqual(extra, [], `_locales/${locale}/messages.json has keys not present in English`);
    for (const [key, entry] of Object.entries(localeMessages)) {
      assert.strictEqual(typeof entry.message, "string", `_locales/${locale}: ${key} needs a string message`);
      assert.ok(entry.message.length > 0, `_locales/${locale}: ${key} message must not be empty`);
    }
  }
});

test("extensionDescription stays within the Chrome Web Store's 132-character manifest limit, in every locale", () => {
  // Chrome truncates (and can reject) a manifest `description` over 132 characters.
  // Both stores' listing description is longer-form text entered separately in their
  // submission forms, but the manifest's own description -- which __MSG_extensionDescription__
  // resolves to -- is what shows in chrome://extensions and is capped by Chrome itself.
  for (const locale of ["en", "es", "fr", "de"]) {
    const localeMessages = readJson(`_locales/${locale}/messages.json`);
    const desc = localeMessages.extensionDescription?.message;
    assert.ok(desc, `_locales/${locale}/messages.json is missing extensionDescription`);
    assert.ok(desc.length <= 132,
      `_locales/${locale}/messages.json extensionDescription is ${desc.length} chars (max 132): "${desc}"`);
  }
});

test("required permissions stay minimal and required host access is Slack-only", () => {
  // Store reviewers reject unjustified permissions; this pins the surface so a
  // debugging permission can't be left behind in a release. Required (non-optional)
  // permissions/host_permissions are the ones active from install with no user
  // action, so they stay pinned to exactly what Slack's own flow needs -- every
  // other platform's access is optional, requested only when the user opens it
  // (see the optional_* pinning test below).
  const expected = ["storage", "scripting", "alarms"];
  for (const manifest of [chromeManifest, firefoxManifest]) {
    assert.deepStrictEqual([...manifest.permissions].sort(), [...expected].sort());
    for (const host of manifest.host_permissions) {
      assert.match(host, /^https:\/\/(\*\.)?slack\.com\/\*$/, `non-Slack required host permission: ${host}`);
    }
    for (const cs of manifest.content_scripts) {
      for (const match of cs.matches) {
        assert.match(match, /^https:\/\/\*\.slack\.com\/\*$/, `content script injected outside Slack: ${match}`);
      }
    }
    for (const war of manifest.web_accessible_resources || []) {
      for (const match of war.matches) {
        assert.match(match, /^https:\/\/\*\.slack\.com\/\*$/, `resource exposed outside Slack: ${match}`);
      }
    }
  }
});

test("optional permissions are pinned to exactly the multi-platform surface", () => {
  // These are inert until a specific platform's flow requests them via
  // chrome.permissions.request() at runtime (see popup/platform-registry.js) --
  // pinning the list here still catches an unreviewed permission sneaking in.
  const expectedOptionalPermissions = ["cookies", "webRequest"];
  const expectedOptionalHosts = [
    "*://*.reddit.com/*",
    "*://*.x.com/*",
    "*://*.twitter.com/*",
    "*://*.teams.microsoft.com/*",
    "*://*.msg.teams.microsoft.com/*",
    "*://*.teams.cloud.microsoft/*",
    "https://*/*"
  ];
  for (const manifest of [chromeManifest, firefoxManifest]) {
    assert.deepStrictEqual(
      [...manifest.optional_permissions].sort(),
      [...expectedOptionalPermissions].sort()
    );
    assert.deepStrictEqual(
      [...manifest.optional_host_permissions].sort(),
      [...expectedOptionalHosts].sort()
    );
  }
});

test("extension-page CSP blocks remote code", () => {
  // Both stores ask whether the extension executes remote code; this keeps the answer "no".
  for (const manifest of [chromeManifest, firefoxManifest]) {
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-eval|unsafe-inline|https?:/.test(csp), `CSP permits remote or unsafe code: ${csp}`);
  }
});

test("the release job cannot publish untested or mis-tagged code", () => {
  // Publishing is the one irreversible step in this repo: both stores refuse a version
  // number that has already been uploaded, so a release built from unverified code, or
  // carrying zips whose internal version disagrees with the tag, costs a whole version
  // to undo. These are the three properties that make that impossible by construction.
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

  const releaseJob = ci.split(/^  release:$/m)[1];
  assert.ok(releaseJob, "ci.yml must define a `release` job");

  // 1. It runs only after the full gate passed — never in parallel with it.
  assert.match(releaseJob, /needs:\s*verify/,
    "the release job must depend on `verify`, so it cannot publish untested code");

  // 2. It runs only for a version tag, never for an ordinary push or PR.
  assert.match(releaseJob, /if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/,
    "the release job must be gated on a v* tag");

  // 3. It refuses a tag that disagrees with the packaged version.
  assert.match(releaseJob, /manifest_version/,
    "the release job must compare the tag against the manifest version");

  // Write access is scoped to the release job alone; the build/test path stays read-only
  // even though it is the job that executes third-party code (npm deps, browsers).
  const header = ci.split(/^jobs:$/m)[0];
  assert.match(header, /permissions:\s*\n\s*contents:\s*read/,
    "workflow-level token must be read-only");
  assert.match(releaseJob, /permissions:\s*\n\s*contents:\s*write/,
    "only the release job may escalate to contents: write");
});

test("the version-bump path referenced by the release guard actually exists", () => {
  // The release guard tells a failing build to run `npm run version:set <v>`. That
  // advice has to be real, or the operator is stuck mid-release with a broken tag.
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/set-version.sh")),
    "scripts/set-version.sh is missing");
  assert.match(pkg.scripts["version:set"] || "", /set-version\.sh/,
    "package.json must expose the bump script as `version:set`");

  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm run version:set/,
    "the release guard should point at the script that fixes the problem");

  // It must rewrite every file the version-drift test pins, or a bump would pass here
  // and then fail the gate.
  const script = fs.readFileSync(path.join(ROOT, "scripts/set-version.sh"), "utf8");
  for (const file of ["manifest.json", "manifest.firefox.json", "package.json"]) {
    assert.ok(script.includes(file), `set-version.sh does not update ${file}`);
  }
});

test("the pre-push guard exists, is executable, and still guards main", () => {
  // This hook is the only thing standing in for branch protection, which GitHub gates
  // behind a paid plan for private repos. A hook that lost its exec bit, or quietly
  // stopped covering one of the three rules, would fail OPEN and silently — nothing
  // would ever surface that main had become unguarded.
  const hookPath = path.join(ROOT, ".githooks/pre-push");
  assert.ok(fs.existsSync(hookPath), ".githooks/pre-push is missing");

  // Git ignores a hook that is not executable, without reporting anything.
  const mode = fs.statSync(hookPath).mode;
  assert.ok(mode & 0o111, ".githooks/pre-push is not executable, so git will ignore it");

  const hook = fs.readFileSync(hookPath, "utf8");
  assert.match(hook, /PROTECTED_BRANCH="main"/, "the hook must guard main");
  // Rule 1: reject a non-fast-forward (force-push).
  assert.match(hook, /merge-base --is-ancestor/, "force-push detection was removed");
  // Rule 2: reject a deletion (all-zero local oid).
  assert.match(hook, /is_zero "\$local_oid"/, "deletion detection was removed");
  // Rule 3: run the gate. Both halves must stay wired, or a push to main runs no checks.
  assert.match(hook, /npm run --silent lint/, "the lint step was removed");
  assert.match(hook, /npm test/, "the test step was removed");

  // The hook only takes effect via core.hooksPath, so the install path must exist.
  assert.match(pkg.scripts["hooks:install"] || "", /core\.hooksPath \.githooks/,
    "package.json must expose `hooks:install` to point git at .githooks");
});

test("no token is ever written to persistent storage", () => {
  // The privacy policy and both store listings promise the Slack token lives only in
  // chrome.storage.session. A storage.local write of a token would break that promise.
  // Comments are stripped first: the code deliberately DOCUMENTS that the token is not
  // stored here, and matching that prose would be a false positive.
  const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const localWrites = bg.match(/chrome\.storage\.local\.set\([\s\S]{0,400}?\)/g) || [];
  assert.ok(localWrites.length > 0, "expected to find storage.local writes to inspect");
  for (const write of localWrites) {
    assert.ok(!/token/i.test(write), `token written to storage.local:\n${write}`);
  }
  // The token's only persistent home is session storage, which clears on browser close.
  assert.match(bg, /chrome\.storage\.session\.set\(\s*\{\s*\[`sc_token_/);
});

test("the five non-Slack platforms' account credentials are never written to storage.local either", () => {
  // Same promise as the Slack token above, extended to the newer platforms: each of
  // these is a standing account credential (an MTProto session, a personal access
  // token, a Bearer JWT, a CSRF/modhash write token) and belongs only in
  // chrome.storage.session, memory-only, cleared on browser close.
  const CREDENTIAL_FILES = [
    { file: "platforms/telegram/telegram-popup.src.js", key: "tg_session" },
    { file: "platforms/telegram/telegram-dashboard.src.js", key: "tg_session" },
    { file: "platforms/mastodon/connect-mastodon.js", key: "mstdn_token" },
    { file: "platforms/mastodon/dashboard-mastodon.js", key: "mstdn_token" },
    { file: "platforms/teams/teams-webrequest.js", key: "teams_token" },
    { file: "platforms/teams/dashboard-teams.js", key: "teams_token" },
    { file: "platforms/x/connect-x.js", key: "x_csrf" },
    { file: "platforms/x/dashboard-x.js", key: "x_csrf" },
    { file: "platforms/reddit/connect-reddit.js", key: "reddit_modhash" },
    { file: "platforms/reddit/dashboard-reddit.js", key: "reddit_modhash" }
  ];

  for (const { file, key } of CREDENTIAL_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const localWrites = src.match(/chrome\.storage\.local\.(set|get|remove)\([\s\S]{0,400}?\)/g) || [];
    for (const call of localWrites) {
      assert.ok(!call.includes(key), `${key} touched via chrome.storage.local in ${file}:\n${call}`);
    }
    assert.match(src, new RegExp(`chrome\\.storage\\.session\\.(set|get)\\([\\s\\S]{0,200}?${key}`),
      `${file} must read/write ${key} via chrome.storage.session`);
  }
});

test("all five non-Slack delete loops fail fast on an expired/revoked credential", () => {
  // Reddit/Mastodon/Teams originally had this (an auth failure otherwise looks
  // identical to any other per-item failure and retries every remaining item at
  // full pacing delay before giving up). X and Telegram were later brought up to
  // the same bar -- verify all five still detect it explicitly rather than
  // silently regressing back to "retry everything, fail slowly".
  const EXPIRED_AUTH_FILES = [
    "platforms/reddit/dashboard-reddit.js",
    "platforms/mastodon/dashboard-mastodon.js",
    "platforms/teams/dashboard-teams.js",
    "platforms/x/dashboard-x.js"
  ];
  for (const file of EXPIRED_AUTH_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(src, /expiredAuth/, `${file} must flag an auth failure distinctly (expiredAuth)`);
    assert.match(src, /if\s*\(\s*expiredAuth/, `${file} must branch on expiredAuth to stop the delete loop early`);
  }
  // Telegram detects the same condition via teleproto's own RPC error hierarchy
  // rather than an HTTP status, so it earns its own check.
  const telegramSrc = fs.readFileSync(path.join(ROOT, "platforms/telegram/telegram-dashboard.src.js"), "utf8");
  assert.match(telegramSrc, /errors\.UnauthorizedError/, "telegram-dashboard.src.js must detect teleproto's UnauthorizedError family (AuthKeyUnregistered/Invalid, SessionExpired/Revoked, UserDeactivated*)");
  assert.match(telegramSrc, /expiredAuth/, "telegram-dashboard.src.js must flag an auth failure distinctly (expiredAuth)");
});

test("all five non-Slack delete loops report live failure counts during the run, not just in the final summary", () => {
  // "Processed N of M (X deleted, Y failed)" -- Reddit/Mastodon/Teams/X get this
  // from the shared runDeleteLoop() (dashboard-fetch-utils.js) rather than each
  // rendering it inline, so verify it lives there AND that each of those four
  // actually calls runDeleteLoop (i.e. really gets the behavior, not just
  // physically able to reach the string). Telegram still hand-rolls its own loop
  // (its MTProto batch/channel-entity handling doesn't fit the shared shape), so it
  // keeps the original direct check.
  const sharedSrc = fs.readFileSync(path.join(ROOT, "platforms/shared/dashboard-fetch-utils.js"), "utf8");
  assert.match(sharedSrc, /failed\)/, "dashboard-fetch-utils.js's runDeleteLoop must render a live \"(N deleted, M failed)\"-style progress string");

  const RUN_DELETE_LOOP_CALLERS = [
    "platforms/reddit/dashboard-reddit.js",
    "platforms/mastodon/dashboard-mastodon.js",
    "platforms/teams/dashboard-teams.js",
    "platforms/x/dashboard-x.js"
  ];
  for (const file of RUN_DELETE_LOOP_CALLERS) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(src, /\brunDeleteLoop\(/, `${file} must use the shared runDeleteLoop() to get live progress reporting`);
  }

  const telegramSrc = fs.readFileSync(path.join(ROOT, "platforms/telegram/telegram-dashboard.src.js"), "utf8");
  assert.match(telegramSrc, /failed\)/, "telegram-dashboard.src.js must render a live \"(N deleted, M failed)\"-style progress string");
});

test("Telegram's dashboard uses the shared dashboard-fetch-utils.js helpers instead of re-duplicating them", () => {
  // Regression guard for the exact drift this shared module exists to prevent:
  // Telegram used to hand-roll its own interrupted-delete report, its own
  // "empty state" placeholders, and its own local sleep() instead of calling the
  // shared helpers every other platform already uses.
  const src = fs.readFileSync(path.join(ROOT, "platforms/telegram/telegram-dashboard.src.js"), "utf8");
  assert.match(src, /\breportInterruptedDelete\(/, "must call the shared reportInterruptedDelete() instead of duplicating the interrupted-delete check");
  assert.match(src, /\brenderEmptyState\(/, "must call the shared renderEmptyState() for its placeholder states");
  assert.match(src, /\bmaybeSaveDeleteProgress\(/, "must call the shared maybeSaveDeleteProgress() instead of an unthrottled per-chunk storage.local write");
  assert.doesNotMatch(src, /function\s+sleep\s*\(/, "must not define its own local sleep() -- use the shared delay() from dashboard-fetch-utils.js");
});

test("showConfirm (the shared non-blocking Yes/No modal) has a real caller", () => {
  // Previously dead code (defined in dashboard-fetch-utils.js, called nowhere).
  // It's now wired into armCancelButton's own click handler, shared by all five
  // non-Slack dashboards.
  const src = fs.readFileSync(path.join(ROOT, "platforms/shared/dashboard-fetch-utils.js"), "utf8");
  const showConfirmDef = src.indexOf("function showConfirm(");
  const showConfirmCallSites = [...src.matchAll(/\bshowConfirm\(/g)].length;
  assert.ok(showConfirmDef >= 0, "showConfirm must still be defined");
  assert.ok(showConfirmCallSites > 1, "showConfirm must be called somewhere besides its own definition");
});

test("dashboard-base.css keeps the [hidden] attribute override that makes el.hidden actually hide a .dashboard-btn", () => {
  // Regression guard for a real bug found via manual verification: .dashboard-btn's
  // own `display: flex` has the same specificity as the browser's default
  // `[hidden] { display: none }` rule and loads later in the cascade, so it silently
  // won -- armCancelButton/resetCancelButton set cancelBtn.hidden via the boolean DOM
  // attribute (not a class), so without this override the Cancel button stayed
  // visibly rendered on all five non-Slack dashboards at every point it was
  // supposed to be hidden, including on first page load before any delete had run.
  const src = fs.readFileSync(path.join(ROOT, "platforms/shared/dashboard-base.css"), "utf8");
  assert.match(src, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "dashboard-base.css must force [hidden] elements to display:none, overriding .dashboard-btn's own display:flex");
});

test("Telegram popup's showStep only clears the error message on a genuine step transition", () => {
  // Regression guard: teleproto's auth retry loop re-enters the SAME step (code or
  // 2FA password) right after showError() just displayed a "wrong code"/"wrong
  // password" message, with no paint in between. showStep() unconditionally hiding
  // the error on every call silently erased it before the user ever saw it. Fixed
  // by tracking the currently-displayed step and only clearing the error when `id`
  // differs from it -- this is a static-source regression guard (this file is
  // DOM-driven with no Node-testable exports), so it checks for that structure
  // rather than executing showStep().
  const src = fs.readFileSync(path.join(ROOT, "platforms/telegram/telegram-popup.src.js"), "utf8");
  const showStepMatch = src.match(/function showStep\(id\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(showStepMatch, "showStep(id) must still be defined");
  const showStepBody = showStepMatch[0];
  assert.match(showStepBody, /if\s*\(\s*id\s*!==\s*currentStepId\s*\)\s*\{[\s\S]*errorMsg\.style\.display\s*=\s*['"]none['"]/,
    "showStep must only clear errorMsg when id differs from the currently-tracked step");
  assert.doesNotMatch(
    showStepBody.replace(/if\s*\(\s*id\s*!==\s*currentStepId\s*\)\s*\{[\s\S]*?\}/, ""),
    /errorMsg\.style\.display\s*=\s*['"]none['"]/,
    "errorMsg must not be cleared unconditionally outside the step-transition guard"
  );
  assert.match(src, /currentStepId\s*=\s*id/, "showStep must update the tracked current step id");
});

// ---------------------------------------------------------------------------
// Store-package and disclosure guards (2026-10-09 audit, "Store / build / CI").
// ---------------------------------------------------------------------------

test("build.sh keeps third-party license notices in the store zips", () => {
  // Terser moves teleproto's (and its polyfills') MIT/other notices out of the minified
  // bundles into *.bundle.js.LICENSE.txt. MIT requires the notice to ship with the code,
  // so deleting those files from dist/ is a licence violation, not a size optimisation.
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.sh"), "utf8");
  const code = build.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /LICENSE\.txt/,
    "scripts/build.sh must not delete (or otherwise filter) *.bundle.js.LICENSE.txt");
  assert.match(code, /-name '\*\.bundle\.js\.map' -delete/,
    "sanity: the sourcemap prune this test sits next to is still present");
});

test("build.sh strips the dev-only manifest \"key\" from the Chrome store package", () => {
  // manifest.json carries "key" so unpacked dev builds keep a stable id; the Chrome Web
  // Store assigns its own and flags an uploaded key. The repo copy must keep it (the
  // e2e tests and local dev rely on the stable id) and the store zip must not.
  assert.ok(chromeManifest.key, "manifest.json should keep its dev key for Load unpacked");
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.sh"), "utf8");
  const chromeSection = build.split('echo "Building Chrome/Chromium package')[1].split('echo "Building Firefox package')[0];
  assert.match(chromeSection, /delete\s+m\.key/, "the Chrome manifest copy must delete .key");
  assert.doesNotMatch(chromeSection, /^\s*cp manifest\.json /m,
    "the Chrome manifest must not be copied verbatim (that would ship the key)");
  assert.ok(!firefoxManifest.key, "manifest.firefox.json must never carry a Chrome key");
});

test("build.sh produces deterministic zips", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.sh"), "utf8");
  assert.match(build, /SOURCE_DATE_EPOCH/, "file mtimes must be pinned via SOURCE_DATE_EPOCH");
  assert.match(build, /LC_ALL=C sort/, "zip entries must be added in a sorted, locale-independent order");
  assert.match(build, /zip -q -X/, "zip must run with -X (no uid/gid/extended timestamp extras)");
  assert.doesNotMatch(build, /zip -qr /, "a bare recursive zip reintroduces filesystem order");
});

test("both manifests load shared-filters.js before content.js in the Slack content script", () => {
  // content.js's regex preview delegates to the real isSafeRegex() from
  // shared-filters.js; loaded after (or not at all) it silently falls back to drift.
  for (const [name, manifest] of [["manifest.json", chromeManifest], ["manifest.firefox.json", firefoxManifest]]) {
    const cs = (manifest.content_scripts || []).find((c) => (c.js || []).includes("content.js"));
    assert.ok(cs, `${name} must inject content.js`);
    const iShared = cs.js.indexOf("shared-filters.js");
    assert.ok(iShared !== -1, `${name}: shared-filters.js must be injected with content.js`);
    assert.ok(iShared < cs.js.indexOf("content.js"), `${name}: shared-filters.js must load before content.js`);
  }
});

test("every platform dashboard has an aria-live status region", () => {
  // Scan/delete progress is announced only through these; without one, screen-reader
  // users get no feedback that a destructive run started, progressed, or failed.
  const dashboards = [];
  for (const dir of fs.readdirSync(path.join(ROOT, "platforms"))) {
    const abs = path.join(ROOT, "platforms", dir);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/^dashboard-.*\.html$/.test(f)) dashboards.push(`platforms/${dir}/${f}`);
    }
  }
  assert.ok(dashboards.length >= 5, `expected the five platform dashboards, found ${dashboards.length}`);
  for (const rel of dashboards) {
    const html = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const tags = html.match(/<[a-z][^>]*>/gi) || [];
    const statusLive = tags.some((t) =>
      /\saria-live=["'](polite|assertive)["']/.test(t) &&
      (/\srole=["']status["']/.test(t) || /\sid=["'][^"']*status[^"']*["']/.test(t)));
    assert.ok(statusLive, `${rel} has no status element with aria-live`);
  }
});

test("every chrome.storage key the code writes is disclosed in PRIVACY_POLICY.md", () => {
  // The policy promises a complete account of what is stored. This collects every key
  // written via chrome.storage.{local,session}.set() in shipped source and requires it
  // (or, for templated keys, its literal prefix) to appear in the policy.
  const policy = fs.readFileSync(path.join(ROOT, "PRIVACY_POLICY.md"), "utf8");

  // Writes whose key is not visible at the call site. Each entry says where the
  // concrete key names come from; those names are collected separately below.
  const INDIRECT = {
    // saveJobState(key, ...) — key is always `slack_state_${team}_${channel}`.
    "background.js:key": "slack_state_",
    // Migration: re-writes already-disclosed legacy keys under their new names.
    "background.js:legacyRewrites": null,
    // Shared helpers: the caller passes its own *_DELETE_PROGRESS_KEY constant.
    "platforms/shared/dashboard-fetch-utils.js:key": null,
    "platforms/shared/dashboard-fetch-utils.js:progressKey": null
  };

  const files = ["background.js", "content.js", "popup.js", "shared-filters.js"];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/\.js$/.test(e.name) && !/\.bundle\.js$/.test(e.name)) files.push(r);
    }
  })("platforms");
  files.push("popup/platform-registry.js");

  // Resolve an identifier to a string/template constant in the same file.
  const resolveIdent = (src, name) => {
    const m = src.match(new RegExp(`\\b${name}\\s*=\\s*(["'\`])([^"'\`]*?)(\\$\\{|\\1)`));
    return m ? m[2] : undefined;
  };
  const resolveFnReturn = (src, fn) => {
    const m = src.match(new RegExp(`function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{\\s*return\\s+\`([^\`]*?)\\$\\{([A-Z_]+)\\}`));
    if (!m) return undefined;
    // `${PREFIX}${...}` form: resolve the leading constant.
    return m[1] === "" ? resolveIdent(src, m[2]) : m[1];
  };

  const keys = new Map(); // key or prefix -> where
  const add = (k, where) => { if (k) keys.set(k, where); };
  let calls = 0;

  for (const rel of files) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Every *_delete_progress-style constant is written via the shared helpers.
    for (const m of src.matchAll(/["']([a-z]+_delete_progress)["']/g)) add(m[1], `${rel} (progress constant)`);

    for (const m of src.matchAll(/chrome\.storage\.(?:local|session)\.set\(\s*/g)) {
      calls++;
      const rest = src.slice(m.index + m[0].length);
      if (!rest.startsWith("{")) {
        const ident = (rest.match(/^[A-Za-z_$][\w$]*/) || [])[0];
        assert.ok(`${rel}:${ident}` in INDIRECT, `${rel}: storage write with a non-literal object (${ident}) — disclose its keys and add it to INDIRECT`);
        add(INDIRECT[`${rel}:${ident}`], rel);
        continue;
      }
      // Grab the object literal (balanced braces).
      let depth = 0, end = 0;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "{") depth++;
        else if (rest[i] === "}" && --depth === 0) { end = i; break; }
      }
      const body = rest.slice(1, end);
      // Only top-level properties: drop nested object values.
      // Template-literal `${...}` braces are kept, not treated as nesting.
      let top = "", d = 0, tpl = 0;
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "$" && body[i + 1] === "{") {
          tpl++;
          if (d === 0) top += "${";
          i++;
          continue;
        }
        if (ch === "}" && tpl > 0) { tpl--; if (d === 0) top += ch; continue; }
        if (ch === "{") d++;
        if (d === 0) top += ch;
        if (ch === "}") d--;
      }
      for (const p of top.matchAll(/(?:^|,)\s*(?:([A-Za-z_$][\w$]*)\s*:|\[\s*([^\]]+?)\s*\]\s*:|([A-Za-z_$][\w$]*)\s*(?=,|$))/g)) {
        if (p[1] || p[3]) { add(p[1] || p[3], rel); continue; }
        const expr = p[2];
        let k;
        if (/^`/.test(expr)) {
          // `prefix${...}` -> "prefix"; `${PREFIX_CONST}${...}` -> the constant's value.
          const lead = expr.match(/^`\$\{\s*([A-Za-z_$][\w$]*)\s*\}/);
          k = lead ? resolveIdent(src, lead[1]) : expr.slice(1).split("${")[0].replace(/`$/, "");
        }
        else if (/^["']/.test(expr)) k = expr.slice(1, -1);
        else if (/^[A-Za-z_$][\w$]*\(/.test(expr)) k = resolveFnReturn(src, expr.split("(")[0]);
        else if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
          k = resolveIdent(src, expr);
          if (k === undefined) {
            assert.ok(`${rel}:${expr}` in INDIRECT, `${rel}: cannot resolve storage key [${expr}] — disclose it and add it to INDIRECT`);
            k = INDIRECT[`${rel}:${expr}`];
          }
        }
        assert.ok(k !== undefined, `${rel}: cannot resolve storage key expression [${expr}]`);
        add(k, rel);
      }
    }
  }

  assert.ok(calls >= 15, `expected to find the storage writes to inspect (found ${calls})`);
  for (const [k, where] of keys) {
    assert.ok(policy.includes(k), `storage key "${k}" (written in ${where}) is not disclosed in PRIVACY_POLICY.md`);
  }
});

// AMO's linter flags any bare `eval` reference (DANGEROUS_EVAL) and any innerHTML
// assignment from a non-literal (UNSAFE_VAR_ASSIGNMENT). Keep the shipped code free
// of both so the Firefox validation stays at zero warnings.
test("Telegram bundles contain no bare eval reference (see strip-intrinsic-eval-loader)", () => {
  for (const name of ["telegram-dashboard.bundle.js", "telegram-popup.bundle.js"]) {
    const file = path.join(ROOT, "platforms/telegram", name);
    assert.ok(fs.existsSync(file),
      `${name} is missing -- run \`node scripts/build-telegram.js\` (npm test does this first)`);
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /(?<![A-Za-z0-9_$.%])eval(?![A-Za-z0-9_$%])/,
      `${name} references eval -- AMO will warn (DANGEROUS_EVAL)`);
  }
});

// Every hand-written script that ships (bundles are covered above). Collected from
// disk so a new platform file is checked automatically.
function shippedSourceFiles() {
  const files = ["background.js", "content.js", "popup.js", "shared-filters.js"];
  for (const dir of ["popup", "platforms"]) {
    const walk = (rel) => {
      for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = path.join(rel, ent.name);
        if (ent.isDirectory()) walk(child);
        else if (child.endsWith(".js") && !child.endsWith(".bundle.js") && !child.endsWith("-shim.js")) files.push(child);
      }
    };
    walk(dir);
  }
  return files;
}

test("no shipped script writes HTML from a dynamic value (AMO UNSAFE_VAR_ASSIGNMENT)", () => {
  const offenders = [];
  for (const rel of shippedSourceFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const lineOf = (i) => src.slice(0, i).split("\n").length;
    // insertAdjacentHTML / document.write are never needed here.
    for (const m of src.matchAll(/\.insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(/g)) {
      offenders.push(`${rel}:${lineOf(m.index)} ${m[0]}`);
    }
    for (const m of src.matchAll(/\.(innerHTML|outerHTML)\s*(\+?=)(?!=)\s*/g)) {
      const at = `${rel}:${lineOf(m.index)}`;
      if (m[2] === "+=") { offenders.push(`${at} ${m[1]} +=`); continue; }
      const rest = src.slice(m.index + m[0].length);
      const quote = rest[0];
      if (quote === "'" || quote === '"') {
        // A plain string literal, e.g. '' -- fine as long as nothing is concatenated.
        const end = rest.indexOf(quote, 1);
        if (!/^\s*[;,)\n]/.test(rest.slice(end + 1))) offenders.push(`${at} ${m[1]} = string + ...`);
      } else if (quote === "`") {
        const end = rest.indexOf("`", 1);
        if (rest.slice(1, end).includes("${")) offenders.push(`${at} ${m[1]} = template with \${}`);
        else if (!/^\s*[;,)\n]/.test(rest.slice(end + 1))) offenders.push(`${at} ${m[1]} = template + ...`);
      } else {
        offenders.push(`${at} ${m[1]} = ${rest.slice(0, 30).split("\n")[0]}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], "build these nodes with the DOM API instead");
});

test("store build: real zips are reproducible, strip `key`, ship license notices, and leak no source/shims", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  for (const tool of ["zip", "unzip"]) {
    try { execFileSync("sh", ["-c", `command -v ${tool}`]); }
    catch { assert.fail(`'${tool}' is required to verify the store build`); }
  }
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
  const build = () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "erasechat-build-"));
    execFileSync("bash", [path.join(ROOT, "scripts/build.sh")], {
      cwd: ROOT, stdio: "pipe",
      env: { ...process.env, ERASECHAT_DIST: out, ERASECHAT_SKIP_TELEGRAM_BUILD: "1" }
    });
    return out;
  };
  const a = build();
  const b = build();
  try {
    for (const flavor of ["chrome", "firefox"]) {
      const zipA = path.join(a, `erasechat-${flavor}-${version}.zip`);
      const zipB = path.join(b, `erasechat-${flavor}-${version}.zip`);
      assert.ok(fs.readFileSync(zipA).equals(fs.readFileSync(zipB)), `${flavor} zip is not reproducible`);

      const entries = execFileSync("unzip", ["-Z1", zipA], { encoding: "utf8" }).split("\n").filter(Boolean);
      assert.ok(entries.includes("platforms/telegram/telegram-dashboard.bundle.js.LICENSE.txt"),
        `${flavor} zip must ship the bundle's third-party license notices`);
      const leaked = entries.filter((e) => e.endsWith(".src.js") || e.endsWith(".map") || e.endsWith("function-bind-shim.js"));
      assert.deepStrictEqual(leaked, [], `${flavor} zip ships build-only files`);

      const manifest = JSON.parse(execFileSync("unzip", ["-p", zipA, "manifest.json"], { encoding: "utf8" }));
      if (flavor === "chrome") assert.ok(!("key" in manifest), "the Chrome store zip must not contain manifest.key");
      else assert.ok(manifest.browser_specific_settings, "the Firefox zip must carry manifest.firefox.json");
    }
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
