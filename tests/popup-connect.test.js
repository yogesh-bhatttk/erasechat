// Erasechat - popup.js connect/disconnect unit tests (node --test, no real DOM).
//
// Covers two popup flows with a minimal fake DOM + chrome.* mock:
//  - a connect that succeeds while ANOTHER platform's connect is still pending must
//    still reset its own row (it used to stay stuck on "Connecting..." with
//    .is-connecting, which also blocked clicking it again), and must not close the
//    popup out from under the still-pending one;
//  - per-platform Disconnect clears exactly that platform's storage keys and
//    revokes its permissions, keeping shared API permissions (Reddit/X "cookies")
//    that another connected platform still needs.

const test = require("node:test");
const assert = require("node:assert/strict");

// --- minimal fake DOM -------------------------------------------------------
function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    }
  };
}

function makeEl() {
  const attrs = {};
  return {
    classList: makeClassList(),
    textContent: "",
    attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    focus() {},
    closest: () => null
  };
}

function makeRow(platformId, name) {
  const row = makeEl();
  const status = makeEl();
  const nameEl = makeEl();
  nameEl.textContent = name;
  row.dataset = { platform: platformId };
  row.querySelector = (sel) => (sel === ".platform-status" ? status : sel === ".platform-name" ? nameEl : null);
  row.status = status;
  return row;
}

const rows = {};
const errorEl = makeEl();
global.document = {
  addEventListener() {},
  activeElement: null,
  getElementById: (id) => (id === "platform-connect-error" ? errorEl : null),
  querySelector: (sel) => {
    const m = sel.match(/^\.platform-row\[data-platform="([^"]+)"\]$/);
    return m ? rows[m[1]] || null : null;
  },
  querySelectorAll: () => []
};

let windowClosed = 0;
global.window = { close: () => { windowClosed++; } };

// --- chrome mock ------------------------------------------------------------
function makeArea() {
  const data = {};
  return {
    data,
    get: (keys, cb) => {
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      cb(out);
    },
    remove: (keys, cb) => { for (const k of keys) delete data[k]; cb && cb(); }
  };
}

const granted = { origins: new Set(), permissions: new Set() };
const removeCalls = [];
const createdTabs = [];

global.chrome = {
  runtime: { lastError: undefined, getURL: (p) => `chrome-extension://id/${p}` },
  i18n: { getMessage: () => "" },
  tabs: { create: (opts) => createdTabs.push(opts.url) },
  storage: { session: makeArea(), local: makeArea() },
  permissions: {
    request: (req, cb) => {
      (req.origins || []).forEach((o) => granted.origins.add(o));
      (req.permissions || []).forEach((p) => granted.permissions.add(p));
      cb(true);
    },
    contains: (req, cb) => cb(
      (req.origins || []).every((o) => granted.origins.has(o)) &&
      (req.permissions || []).every((p) => granted.permissions.has(p))
    ),
    remove: (req, cb) => {
      removeCalls.push(JSON.parse(JSON.stringify(req)));
      (req.origins || []).forEach((o) => granted.origins.delete(o));
      (req.permissions || []).forEach((p) => granted.permissions.delete(p));
      cb(true);
    }
  }
};

const { PLATFORMS: REGISTRY } = require("../popup/platform-registry.js");
global.PLATFORMS = REGISTRY;

const popup = require("../popup.js");

const flush = () => new Promise((r) => setImmediate(r));

function resetMocks() {
  removeCalls.length = 0;
  createdTabs.length = 0;
  windowClosed = 0;
  granted.origins.clear();
  granted.permissions.clear();
  for (const area of ["session", "local"]) {
    const d = chrome.storage[area].data;
    for (const k of Object.keys(d)) delete d[k];
  }
}

// --- item 12: concurrent connects ------------------------------------------
test("a connect that succeeds while another is pending resets its own row and keeps the popup open", async () => {
  resetMocks();
  let resolveSlow;
  const slow = {
    id: "slowp", name: "Slow", ready: true, accent: ["#000", "#000"],
    optionalHostPermissions: ["https://slow.example/*"], dashboard: "slow.html",
    connect: () => new Promise((r) => { resolveSlow = r; })
  };
  const fast = {
    id: "fastp", name: "Fast", ready: true, accent: ["#000", "#000"],
    optionalHostPermissions: ["https://fast.example/*"], dashboard: "fast.html",
    connect: async () => ({ ok: true })
  };
  rows.slowp = makeRow("slowp", "Slow");
  rows.fastp = makeRow("fastp", "Fast");

  popup.connectAndLaunchPlatform(slow);
  assert.equal(rows.slowp.classList.contains("is-connecting"), true);
  assert.equal(rows.slowp.getAttribute("aria-busy"), "true");

  popup.connectAndLaunchPlatform(fast);
  await flush();

  assert.deepEqual(createdTabs, ["chrome-extension://id/fast.html"]);
  assert.equal(rows.fastp.classList.contains("is-connecting"), false, "fast row must not stay is-connecting");
  assert.equal(rows.fastp.status.textContent, "", "fast row must not stay on Connecting...");
  assert.equal(rows.fastp.getAttribute("aria-busy"), null);
  assert.equal(rows.fastp.getAttribute("aria-label"), "Fast");
  assert.equal(windowClosed, 0, "popup must stay open while the slow connect is pending");
  assert.equal(rows.slowp.classList.contains("is-connecting"), true, "slow row is still connecting");

  resolveSlow({ ok: true });
  await flush();
  assert.deepEqual(createdTabs, ["chrome-extension://id/fast.html", "chrome-extension://id/slow.html"]);
  assert.equal(rows.slowp.classList.contains("is-connecting"), false);
  assert.equal(windowClosed, 1, "popup closes once nothing is pending");
  assert.equal(popup._getPendingConnectCount(), 0);
});

test("an unexpected connect() exception shows a localized wrapper, not just the raw message", async () => {
  resetMocks();
  const boom = {
    id: "boomp", name: "Boom", ready: true, accent: ["#000", "#000"],
    optionalHostPermissions: [], dashboard: "boom.html",
    connect: async () => { throw new Error("kaboom"); }
  };
  rows.boomp = makeRow("boomp", "Boom");
  popup.connectAndLaunchPlatform(boom);
  await flush();
  assert.match(errorEl.textContent, /Could not connect \(kaboom\)/);
  assert.equal(rows.boomp.classList.contains("is-connecting"), false);
});

// --- item 19: per-platform Disconnect ---------------------------------------
const byId = (id) => REGISTRY.find((p) => p.id === id);

test("every connectable platform declares the storage keys Disconnect clears", () => {
  for (const id of ["reddit", "x", "mastodon", "teams", "telegram"]) {
    const p = byId(id);
    assert.ok(p.storageKeys, `${id} has storageKeys`);
    assert.ok((p.storageKeys.session || []).length > 0, `${id} lists its session credential key`);
  }
});

test("disconnect Reddit: clears only Reddit's keys and keeps 'cookies' while X is still connected", async () => {
  resetMocks();
  chrome.storage.session.data.reddit_modhash = "m";
  chrome.storage.local.data.reddit_username = "u";
  chrome.storage.session.data.x_csrf = "c";
  byId("reddit").optionalHostPermissions.forEach((o) => granted.origins.add(o));
  byId("x").optionalHostPermissions.forEach((o) => granted.origins.add(o));
  granted.permissions.add("cookies");

  assert.equal(await popup.isPlatformConnected(byId("reddit")), true);
  await popup.disconnectPlatform(byId("reddit"));

  assert.equal("reddit_modhash" in chrome.storage.session.data, false);
  assert.equal("reddit_username" in chrome.storage.local.data, false);
  assert.equal(chrome.storage.session.data.x_csrf, "c", "X's credential untouched");
  assert.deepEqual(removeCalls, [{ origins: byId("reddit").optionalHostPermissions, permissions: [] }]);
  assert.equal(granted.permissions.has("cookies"), true);
  assert.equal(await popup.isPlatformConnected(byId("reddit")), false);
});

test("disconnect X when Reddit is not connected also revokes 'cookies'", async () => {
  resetMocks();
  chrome.storage.session.data.x_csrf = "c";
  chrome.storage.local.data.x_username = "me";
  byId("x").optionalHostPermissions.forEach((o) => granted.origins.add(o));
  granted.permissions.add("cookies");

  await popup.disconnectPlatform(byId("x"));
  assert.deepEqual(removeCalls, [{ origins: byId("x").optionalHostPermissions, permissions: ["cookies"] }]);
  assert.deepEqual(chrome.storage.session.data, {});
  assert.deepEqual(chrome.storage.local.data, {});
});

test("disconnect Teams revokes webRequest (stops passive token capture) and clears the pending hint", async () => {
  resetMocks();
  chrome.storage.session.data.teams_token = "Bearer x";
  chrome.storage.session.data.teams_connect_pending = "hint";
  chrome.storage.local.data.teams_base_url = "https://teams.microsoft.com/api/chatsvc/emea";
  await popup.disconnectPlatform(byId("teams"));
  assert.deepEqual(removeCalls, [{ origins: byId("teams").optionalHostPermissions, permissions: ["webRequest"] }]);
  assert.deepEqual(chrome.storage.session.data, {});
  assert.deepEqual(chrome.storage.local.data, {});
});

test("disconnect Mastodon revokes only the instance origin it was granted", async () => {
  resetMocks();
  chrome.storage.session.data.mstdn_token = "t";
  chrome.storage.local.data.mstdn_host = "mastodon.social";
  chrome.storage.local.data.mstdn_username = "me";
  await popup.disconnectPlatform(byId("mastodon"));
  assert.deepEqual(removeCalls, [{ origins: ["https://mastodon.social/*"], permissions: [] }]);
  assert.deepEqual(chrome.storage.local.data, {});
});

test("disconnect Telegram just clears its keys (no permissions to revoke)", async () => {
  resetMocks();
  chrome.storage.session.data.tg_session = "s";
  chrome.storage.local.data.tg_api_id = 1;
  chrome.storage.local.data.tg_api_hash = "h";
  assert.equal(await popup.isPlatformConnected(byId("telegram")), true);
  await popup.disconnectPlatform(byId("telegram"));
  assert.deepEqual(removeCalls, []);
  assert.deepEqual(chrome.storage.session.data, {});
  assert.deepEqual(chrome.storage.local.data, {});
  assert.equal(await popup.isPlatformConnected(byId("telegram")), false);
});

test("a fixed-origin platform with no stored keys but a still-granted host permission counts as connected", async () => {
  resetMocks();
  byId("reddit").optionalHostPermissions.forEach((o) => granted.origins.add(o));
  assert.equal(await popup.isPlatformConnected(byId("reddit")), true);
});
