// Bulk Clean for Slack — background service-worker harness tests (node --test)
//
// background.js is written for a browser worker global, not for CommonJS, so these
// tests load it into a `vm` context with a mocked `chrome` API surface. That buys two
// things no other test in this repo covers:
//
//   1. Cross-browser LOAD safety. A Chrome-only API touched at top level throws at
//      load time and takes the whole script down with it — including the onMessage
//      router — leaving the extension silently inert. Loading under a Firefox-shaped
//      `chrome` object catches that class of regression.
//   2. The real scan engine (runScanInBg) end-to-end against a stubbed Slack API, so
//      pagination caps and truncation reporting are tested as executed, not asserted
//      about in a comment.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SHARED_SRC = fs.readFileSync(path.join(ROOT, "shared-filters.js"), "utf8");
const BG_SRC = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

// Minimal chrome mock. `flavor: "firefox"` omits runtime.onSuspend, which Firefox
// has never implemented — the exact shape that used to crash background.js on load.
function makeChrome({ flavor = "chrome" } = {}) {
  const registered = { onMessage: 0, onStartup: 0, onInstalled: 0, onSuspend: 0, onAlarm: 0 };
  const event = (name) => ({ addListener: () => { registered[name]++; } });

  const chrome = {
    runtime: {
      id: "testextensionid",
      lastError: undefined,
      getURL: (p) => `chrome-extension://testextensionid/${p}`,
      onMessage: event("onMessage"),
      onStartup: event("onStartup"),
      onInstalled: event("onInstalled")
    },
    alarms: {
      onAlarm: event("onAlarm"),
      create: () => {},
      clear: () => {},
      get: (_name, cb) => cb(undefined)
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      }
    },
    tabs: {
      query: (_q, cb) => cb([]),
      sendMessage: (_id, _msg, cb) => { if (cb) cb(); }
    }
  };

  if (flavor === "chrome") {
    chrome.runtime.onSuspend = event("onSuspend");
  }

  return { chrome, registered };
}

// Load shared-filters.js then background.js into one vm context, as the browser does.
// Returns the context so tests can call the background's top-level functions directly.
function loadBackground({ flavor = "chrome", fetchImpl } = {}) {
  const { chrome, registered } = makeChrome({ flavor });

  const sandbox = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    AbortController,
    fetch: fetchImpl || (async () => { throw new Error("fetch not stubbed"); })
  };
  // The worker global: background.js calls self.addEventListener("unhandledrejection").
  const workerEvents = {};
  sandbox.addEventListener = (type, handler) => { workerEvents[type] = handler; };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__workerEvents = workerEvents;

  const context = vm.createContext(sandbox);
  // No importScripts in this context, so shared-filters.js is loaded explicitly —
  // mirroring Firefox's background.scripts ordering.
  vm.runInContext(SHARED_SRC, context, { filename: "shared-filters.js" });
  vm.runInContext(BG_SRC, context, { filename: "background.js" });

  return { context, sandbox, registered };
}

// Build a fetch stub that answers Slack Web API calls from a routing table keyed by
// endpoint. Each handler receives (params, callIndexForThatEndpoint).
function makeSlackFetch(routes) {
  const calls = {};
  return {
    calls,
    fetch: async (url, opts) => {
      const endpoint = String(url).split("/api/")[1];
      const params = {};
      for (const [k, v] of new URLSearchParams(String(opts.body))) params[k] = v;
      calls[endpoint] = (calls[endpoint] || 0) + 1;
      const handler = routes[endpoint];
      if (!handler) throw new Error(`unexpected endpoint: ${endpoint}`);
      const body = handler(params, calls[endpoint] - 1);
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => body
      };
    }
  };
}

test("background.js loads under a Firefox-shaped chrome API (no runtime.onSuspend)", () => {
  // Regression guard: reading .addListener off the missing onSuspend event threw a
  // TypeError at load, aborting the script BEFORE the onMessage router registered —
  // which left Firefox with an installed-but-dead extension.
  const { registered } = loadBackground({ flavor: "firefox" });

  assert.strictEqual(registered.onMessage, 1, "message router must still register on Firefox");
  assert.strictEqual(registered.onStartup, 1);
  assert.strictEqual(registered.onInstalled, 1);
  assert.strictEqual(registered.onAlarm, 1);
  assert.strictEqual(registered.onSuspend, 0, "Firefox has no onSuspend to register");
});

test("background.js still registers onSuspend where it exists (Chrome)", () => {
  const { registered } = loadBackground({ flavor: "chrome" });
  assert.strictEqual(registered.onSuspend, 1);
  assert.strictEqual(registered.onMessage, 1);
});

test("runScanInBg: caps per-thread reply pagination and reports the truncation", async () => {
  // One thread root whose replies paginate forever. Without a cap the scan would
  // page indefinitely, burning the workspace's rate limit and outliving the content
  // script's own scan timeout.
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      messages: [{ ts: "1000.000", thread_ts: "1000.000", user: "U1", text: "root" }],
      response_metadata: { next_cursor: "" }
    }),
    "conversations.replies": (_params, i) => ({
      ok: true,
      messages: [
        { ts: "1000.000", thread_ts: "1000.000", user: "U1", text: "root" },
        { ts: `${2000 + i}.000`, thread_ts: "1000.000", user: "U1", text: `reply ${i}` }
      ],
      response_metadata: { next_cursor: "keep-going" }
    })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const scan = await vm.runInContext("runScanInBg", context)("xoxc-test", {
    channelId: "C123",
    oldest: 0,
    latest: 9999999999,
    includeThreads: true,
    filterSender: "all",
    filterText: "",
    onlyAttachments: false,
    userId: "U1"
  });

  assert.strictEqual(stub.calls["conversations.replies"], 10, "must stop at MAX_THREAD_PAGES");
  assert.strictEqual(scan.moreAvailable, true, "truncated thread must be reported honestly");
  // 1 root + one unique reply per paged call.
  assert.strictEqual(scan.results.length, 11);
});

test("runScanInBg: caps history pagination and reports moreAvailable", async () => {
  const stub = makeSlackFetch({
    "conversations.history": (_params, i) => ({
      ok: true,
      messages: [{ ts: `${1000 + i}.000`, user: "U1", text: "hello" }],
      response_metadata: { next_cursor: "next-page" }
    })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const scan = await vm.runInContext("runScanInBg", context)("xoxc-test", {
    channelId: "C123",
    oldest: 0,
    latest: 9999999999,
    includeThreads: false,
    filterSender: "all",
    filterText: "",
    onlyAttachments: false,
    userId: "U1"
  });

  assert.strictEqual(stub.calls["conversations.history"], 20, "must stop at MAX_SCAN_PAGES");
  assert.strictEqual(scan.moreAvailable, true);
  assert.strictEqual(scan.results.length, 20);
});

test("runScanInBg: a fully-examined channel reports no truncation", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      messages: [{ ts: "1000.000", user: "U1", text: "hello" }],
      response_metadata: { next_cursor: "" }
    })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const scan = await vm.runInContext("runScanInBg", context)("xoxc-test", {
    channelId: "C123",
    oldest: 0,
    latest: 9999999999,
    includeThreads: true,
    filterSender: "all",
    filterText: "",
    onlyAttachments: false,
    userId: "U1"
  });

  assert.strictEqual(scan.moreAvailable, false);
  assert.strictEqual(scan.capped, false);
  assert.strictEqual(scan.results.length, 1);
});

test("runScanInBg: thread replies outside the date window are never queued", async () => {
  // The scan deliberately relaxes the server-side `oldest` when threads are included
  // (so pre-window parents can be expanded). That makes the CLIENT-side window guard
  // the only thing keeping out-of-window roots and replies out of the delete queue.
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      // Root predates the window; it exists only so its thread can be expanded.
      messages: [{ ts: "1000.000", thread_ts: "1000.000", user: "U1", text: "old root" }],
      response_metadata: { next_cursor: "" }
    }),
    "conversations.replies": () => ({
      ok: true,
      messages: [
        { ts: "1000.000", thread_ts: "1000.000", user: "U1", text: "old root" },
        { ts: "1500.000", thread_ts: "1000.000", user: "U1", text: "before window" },
        { ts: "5500.000", thread_ts: "1000.000", user: "U1", text: "inside window" },
        { ts: "9000.000", thread_ts: "1000.000", user: "U1", text: "after window" }
      ],
      response_metadata: { next_cursor: "" }
    })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const scan = await vm.runInContext("runScanInBg", context)("xoxc-test", {
    channelId: "C123",
    oldest: 5000,
    latest: 6000,
    includeThreads: true,
    filterSender: "all",
    filterText: "",
    onlyAttachments: false,
    userId: "U1"
  });

  // Array.from re-homes the vm-realm array so deepStrictEqual compares values, not prototypes.
  assert.deepStrictEqual(Array.from(scan.results, r => r.ts), ["5500.000"]);
});

test("runScanInBg: a thread_broadcast reply is queued once, not twice", async () => {
  // A "also send to channel" reply comes back from BOTH conversations.history and
  // conversations.replies. Queued twice, the second chat.delete fails as
  // message_not_found and inflates the failure count.
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      messages: [
        { ts: "1000.000", thread_ts: "1000.000", user: "U1", text: "root" },
        { ts: "1200.000", thread_ts: "1000.000", subtype: "thread_broadcast", user: "U1", text: "broadcast" }
      ],
      response_metadata: { next_cursor: "" }
    }),
    "conversations.replies": () => ({
      ok: true,
      messages: [
        { ts: "1000.000", thread_ts: "1000.000", user: "U1", text: "root" },
        { ts: "1200.000", thread_ts: "1000.000", subtype: "thread_broadcast", user: "U1", text: "broadcast" }
      ],
      response_metadata: { next_cursor: "" }
    })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const scan = await vm.runInContext("runScanInBg", context)("xoxc-test", {
    channelId: "C123",
    oldest: 0,
    latest: 9999999999,
    includeThreads: true,
    filterSender: "all",
    filterText: "",
    onlyAttachments: false,
    userId: "U1"
  });

  const tsList = Array.from(scan.results, r => r.ts).sort();
  assert.deepStrictEqual(tsList, ["1000.000", "1200.000"]);
});

test("slackAPICall: omits unset params instead of sending the string 'undefined'", async () => {
  // `latest=undefined` reaches Slack verbatim as text and fails the whole call with
  // invalid_ts_latest, which surfaces to the user as a broken scan.
  let sentBody = null;
  const fetchImpl = async (_url, opts) => {
    sentBody = String(opts.body);
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };

  const { context } = loadBackground({ fetchImpl });
  const res = await vm.runInContext("slackAPICall", context)("xoxc-test", "conversations.history", {
    channel: "C123",
    latest: undefined,
    oldest: null,
    limit: 100
  });

  assert.strictEqual(res.ok, true);
  const params = new URLSearchParams(sentBody);
  assert.strictEqual(params.get("channel"), "C123");
  assert.strictEqual(params.get("limit"), "100");
  assert.strictEqual(params.has("latest"), false, "unset latest must be omitted");
  assert.strictEqual(params.has("oldest"), false, "null oldest must be omitted");
});

test("slackAPICall: surfaces HTTP 429 as rate_limited with Retry-After honored", async () => {
  const fetchImpl = async () => ({
    status: 429,
    headers: { get: (h) => (h === "Retry-After" ? "42" : null) },
    json: async () => ({ ok: false })
  });

  const { context } = loadBackground({ fetchImpl });
  const res = await vm.runInContext("slackAPICall", context)("xoxc-test", "chat.delete", { channel: "C1", ts: "1.0" });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "rate_limited");
  assert.strictEqual(res.retryAfter, 42);
});

test("queueKeyFor: job-progress and queue keys never collide across channels", () => {
  const { context } = loadBackground();
  const queueKeyFor = vm.runInContext("queueKeyFor", context);

  const a = queueKeyFor("T1", "C1");
  const b = queueKeyFor("T1", "C2");
  const c = queueKeyFor("T2", "C1");

  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
  // recoverAllJobs scans storage for the "slackclean_state_" prefix; a queue key that
  // shared it would be misread as a job record.
  assert.ok(!a.startsWith("slackclean_state_"));
});
