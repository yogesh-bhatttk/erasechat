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

test("background wiring matches each browser's supported form", () => {
  // Chromium MV3 rejects background.scripts; Firefox MV3 rejects service_worker.
  assert.ok(chromeManifest.background.service_worker, "Chrome needs a service_worker");
  assert.ok(!chromeManifest.background.scripts, "Chrome must not use background.scripts");

  assert.ok(Array.isArray(firefoxManifest.background.scripts), "Firefox needs background.scripts");
  assert.ok(!firefoxManifest.background.service_worker, "Firefox must not use service_worker");
  // shared-filters.js must load BEFORE background.js: Firefox has no importScripts, so
  // ordering here is the only thing that defines qualifies()/decideItemAction().
  assert.deepStrictEqual(firefoxManifest.background.scripts, ["shared-filters.js", "background.js"]);
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
    }
  }
});

test("the build ships every runtime file both manifests reference", () => {
  // scripts/build.sh copies a hand-maintained ASSETS list; a file added to a manifest
  // but forgotten there produces a package that loads and then breaks at runtime.
  const build = fs.readFileSync(path.join(ROOT, "scripts/build.sh"), "utf8");
  const assetBlock = build.split("ASSETS=(")[1].split(")")[0];
  const shipped = assetBlock.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));

  const referenced = new Set([...referencedFiles(chromeManifest), ...referencedFiles(firefoxManifest)]);
  // Firefox loads shared-filters.js via the manifest; Chrome via importScripts, which
  // referencedFiles() cannot see — assert it explicitly.
  referenced.add("shared-filters.js");

  for (const rel of referenced) {
    const topLevel = rel.split("/")[0];
    assert.ok(shipped.includes(rel) || shipped.includes(topLevel),
      `scripts/build.sh does not ship ${rel}`);
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

test("locale file is well formed", () => {
  for (const [key, entry] of Object.entries(messages)) {
    assert.strictEqual(typeof entry, "object", `${key} must be an object`);
    assert.strictEqual(typeof entry.message, "string", `${key} needs a string message`);
    assert.ok(entry.message.length > 0, `${key} message must not be empty`);
  }
});

test("permissions stay minimal and host access is Slack-only", () => {
  // Store reviewers reject unjustified permissions; this pins the surface so a
  // debugging permission can't be left behind in a release.
  const expected = ["storage", "scripting", "alarms"];
  for (const manifest of [chromeManifest, firefoxManifest]) {
    assert.deepStrictEqual([...manifest.permissions].sort(), [...expected].sort());
    for (const host of manifest.host_permissions) {
      assert.match(host, /^https:\/\/(\*\.)?slack\.com\/\*$/, `non-Slack host permission: ${host}`);
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

test("extension-page CSP blocks remote code", () => {
  // Both stores ask whether the extension executes remote code; this keeps the answer "no".
  for (const manifest of [chromeManifest, firefoxManifest]) {
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-eval|unsafe-inline|https?:/.test(csp), `CSP permits remote or unsafe code: ${csp}`);
  }
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
