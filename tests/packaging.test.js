// Bulk Clean for Slack — packaging & manifest gate (node --test)
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
  // shared-filters.js and every background/*.js listener must load BEFORE
  // background.js: Firefox has no importScripts, so ordering here is the only thing
  // that defines qualifies()/decideItemAction() and registers listeners like Teams'
  // webRequest one before background.js itself runs.
  assert.deepStrictEqual(firefoxManifest.background.scripts,
    ["shared-filters.js", "background/teams-webrequest.js", "background.js"]);
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
  const sources = {
    "popup.html": fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"),
    "content.js": fs.readFileSync(path.join(ROOT, "content.js"), "utf8"),
    "privacy.html": fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8")
  };

  let checked = 0;
  for (const [name, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/data-i18n(?:-ph|-title|-aria)?=["']([A-Za-z0-9_]+)["']/g)) {
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
  for (const name of ["popup.js", "content.js"]) {
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
  const expectedOptionalPermissions = ["cookies", "webRequest", "identity"];
  const expectedOptionalHosts = [
    "*://*.reddit.com/*",
    "*://*.x.com/*",
    "*://*.twitter.com/*",
    "*://*.teams.microsoft.com/*",
    "*://*.msg.teams.microsoft.com/*",
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
