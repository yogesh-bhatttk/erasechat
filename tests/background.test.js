// Erasechat — background service-worker harness tests (node --test)
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
  // Keep the last handler registered for each event so tests can drive the real
  // message router, not just assert that it registered.
  const handlers = {};
  const event = (name) => ({
    addListener: (fn) => { registered[name]++; handlers[name] = fn; }
  });

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
      sendMessage: (_id, _msg, cb) => { if (cb) cb(); },
      onCreated: event("tabs.onCreated"),
      onRemoved: event("tabs.onRemoved"),
      onUpdated: event("tabs.onUpdated")
    }
  };

  if (flavor === "chrome") {
    chrome.runtime.onSuspend = event("onSuspend");
  }

  return { chrome, registered, handlers };
}

// Load shared-filters.js then background.js into one vm context, as the browser does.
// Returns the context so tests can call the background's top-level functions directly.
function loadBackground({ flavor = "chrome", fetchImpl, sessionTokens } = {}) {
  const { chrome, registered, handlers } = makeChrome({ flavor });

  // Let a test pre-seed chrome.storage.session with `sc_token_<teamId>` entries, which
  // is how the worker recovers a token via ensureToken() after an idle-death.
  if (sessionTokens) {
    chrome.storage.session.get = async (key) => (
      key in sessionTokens ? { [key]: sessionTokens[key] } : {}
    );
  }

  const sandbox = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // Both are browser globals the worker relies on. URL in particular is what
    // isSlackHostname() parses sender origins with — omit it and every message is
    // silently rejected as unauthorized_origin, since the failure is swallowed by
    // that function's try/catch.
    URL,
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

  return { context, sandbox, registered, handlers };
}

// Drive the real chrome.runtime.onMessage router the way the browser does, from a
// sender the worker will accept (its own extension pages / a Slack tab).
function sendMessage(handlers, request, { sender } = {}) {
  return new Promise((resolve, reject) => {
    const from = sender || { tab: { url: "https://app.slack.com/client/T1/C1" } };
    let settled = false;
    const sendResponse = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const keepOpen = handlers.onMessage(request, from, sendResponse);
    // A handler that answers synchronously returns false; one that returns true has
    // promised a later sendResponse. If it returns false without answering, that is
    // itself the bug — surface it instead of hanging the test.
    if (keepOpen !== true && !settled) {
      reject(new Error(`handler for ${request.type} returned ${keepOpen} without responding`));
    }
  });
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

test("runScanInBg: excludePinned drops a pinned message end-to-end", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      messages: [
        { ts: "1000.000", user: "U1", text: "pinned announcement", pinned_to: ["C123"] },
        { ts: "1001.000", user: "U1", text: "ordinary message" }
      ],
      response_metadata: { next_cursor: "" }
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
    excludePinned: true,
    userId: "U1"
  });

  assert.strictEqual(scan.results.length, 1);
  assert.strictEqual(scan.results[0].ts, "1001.000");
});

test("runScanInBg: invertText keeps the non-matching message and drops the matching one", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      messages: [
        { ts: "1000.000", user: "U1", text: "this is confidential" },
        { ts: "1001.000", user: "U1", text: "unrelated chatter" }
      ],
      response_metadata: { next_cursor: "" }
    })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const scan = await vm.runInContext("runScanInBg", context)("xoxc-test", {
    channelId: "C123",
    oldest: 0,
    latest: 9999999999,
    includeThreads: false,
    filterSender: "all",
    filterText: "confidential",
    onlyAttachments: false,
    invertText: true,
    userId: "U1"
  });

  assert.strictEqual(scan.results.length, 1);
  assert.strictEqual(scan.results[0].ts, "1001.000");
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

// A scan request that the worker will accept: token recoverable from session storage.
const SCAN_REQUEST = {
  type: "RUN_SCAN",
  teamId: "T1",
  channelId: "C1",
  oldest: 0,
  latest: 9999999999,
  includeThreads: false,
  filterSender: "all",
  filterText: "",
  onlyAttachments: false,
  userId: "U1"
};

test("RUN_SCAN: a duplicate scan of the same conversation joins the running sweep, not run twice", async () => {
  // The dashboard abandons a scan after its own client-side timeout and invites a
  // retry, while the worker keeps paginating. The retry must neither start a second
  // full sweep (doubling the API load that made the first slow) nor be bounced:
  // it waits for the in-flight sweep and gets its result.
  let releaseFirstScan;
  const gate = new Promise((resolve) => { releaseFirstScan = resolve; });

  const stub = makeSlackFetch({
    "conversations.history": async () => {
      await gate; // hold the first scan open so the second arrives mid-flight
      return { ok: true, messages: [{ ts: "1000.000", user: "U1", text: "hi" }], response_metadata: { next_cursor: "" } };
    }
  });

  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const first = sendMessage(handlers, SCAN_REQUEST);
  // Let the first scan get past ensureToken and into fetch before racing it.
  await new Promise((r) => setTimeout(r, 10));
  // `latest` drifts forward on a real retry ("now" moved on) — still the same scan.
  const second = sendMessage(handlers, { ...SCAN_REQUEST, latest: SCAN_REQUEST.latest + 30 });

  releaseFirstScan();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.ok, true, "the original scan still completes normally");
  assert.strictEqual(secondResult.ok, true, "the retry receives the in-flight scan's result");
  assert.deepStrictEqual(Array.from(secondResult.results, r => r.ts), ["1000.000"]);
  assert.strictEqual(stub.calls["conversations.history"], 1,
    "the joined scan must not have issued any Slack API calls of its own");
});

test("RUN_SCAN: a scan with DIFFERENT filters is refused while one is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stub = makeSlackFetch({
    "conversations.history": async () => {
      await gate;
      return { ok: true, messages: [], response_metadata: { next_cursor: "" } };
    }
  });
  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const first = sendMessage(handlers, SCAN_REQUEST);
  await new Promise((r) => setTimeout(r, 10));
  const second = await sendMessage(handlers, { ...SCAN_REQUEST, filterText: "other" });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, "scan_in_progress");

  release();
  assert.strictEqual((await first).ok, true);
});

test("RUN_SCAN: a finished scan is served from the short-lived cache on retry, and START_DELETION invalidates it", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true, messages: [{ ts: "1000.000", user: "U1", text: "hi" }], response_metadata: { next_cursor: "" }
    }),
    "chat.delete": () => ({ ok: true })
  });
  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const first = await sendMessage(handlers, SCAN_REQUEST);
  assert.strictEqual(first.ok, true);
  assert.ok(!first.cached);

  const retry = await sendMessage(handlers, { ...SCAN_REQUEST, latest: SCAN_REQUEST.latest + 60, allowCached: true });
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(retry.cached, true, "same filters within the TTL must come from the cache");
  assert.deepStrictEqual(Array.from(retry.results, r => r.ts), ["1000.000"]);
  assert.strictEqual(stub.calls["conversations.history"], 1, "the cached retry must not hit Slack");

  // A normal Scan click (no allowCached) always re-sweeps.
  const fresh = await sendMessage(handlers, SCAN_REQUEST);
  assert.ok(!fresh.cached);
  assert.strictEqual(stub.calls["conversations.history"], 2);

  // Different filters are a different scan.
  const other = await sendMessage(handlers, { ...SCAN_REQUEST, filterText: "hi", allowCached: true });
  assert.ok(!other.cached);
  assert.strictEqual(stub.calls["conversations.history"], 3);

  // Deleting makes the cached result stale: a later scan must re-sweep.
  const started = await sendMessage(handlers, {
    type: "START_DELETION", teamId: "T1", channelId: "C1",
    deleteQueue: [{ ts: "1000.000", user: "U1", text: "hi", files: [] }], throttleDelay: 1000
  });
  assert.strictEqual(started.success, true);
  const afterDelete = await sendMessage(handlers, { ...SCAN_REQUEST, filterText: "hi", allowCached: true });
  assert.ok(!afterDelete.cached, "a scan after START_DELETION must not be served stale results");
  await new Promise((r) => setTimeout(r, 50)); // let the queued delete settle
});

test("RUN_SCAN: results are slimmed — no full file objects/attachments, blocks only where a trim could need them", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true,
      messages: [
        { ts: "1.000", user: "U1", text: "plain", blocks: [{ type: "rich_text" }] },
        { ts: "2.000", user: "U1", text: "with file", blocks: [{ type: "rich_text" }],
          files: [{ id: "F1", name: "a.png", url_private: "https://files.slack.com/x", thumb_64: "t" }] },
        { ts: "3.000", user: "U1", text: "unfurl", attachments: [{ title: "x", text: "y" }] }
      ],
      response_metadata: { next_cursor: "" }
    })
  });
  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const res = await sendMessage(handlers, SCAN_REQUEST);
  const [plain, withFile, unfurl] = res.results;
  assert.strictEqual(plain.blocks, undefined, "a message with nothing to trim carries no blocks");
  assert.strictEqual(plain.hasAttachments, false);
  assert.strictEqual(withFile.blocks.length, 1);
  assert.deepStrictEqual(Object.keys(withFile.files[0]).sort(), ["id", "name"]);
  assert.strictEqual(unfurl.attachments, undefined);
  assert.strictEqual(unfurl.hasAttachments, true);
});

test("START_DELETION: rejects queue items that the worker's last scan never returned", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true, messages: [{ ts: "1000.000", user: "U1", text: "hi" }], response_metadata: { next_cursor: "" }
    }),
    "chat.delete": () => { throw new Error("must not delete"); }
  });
  const { handlers, context } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  // No scan at all yet.
  const noScan = await sendMessage(handlers, {
    type: "START_DELETION", teamId: "T1", channelId: "C1",
    deleteQueue: [{ ts: "1000.000", user: "U1" }], throttleDelay: 1000
  });
  assert.strictEqual(noScan.success, false);
  assert.strictEqual(noScan.error, "scan_required");

  await sendMessage(handlers, SCAN_REQUEST);
  const res = await sendMessage(handlers, {
    type: "START_DELETION", teamId: "T1", channelId: "C1",
    deleteQueue: [{ ts: "1000.000", user: "U1" }, { ts: "5555.000", user: "U1" }], throttleDelay: 1000
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "queue_not_from_scan");
  assert.strictEqual(res.count, 1);
  const activeJobs = vm.runInContext("activeJobs", context);
  assert.strictEqual(activeJobs["slack_state_T1_C1"], undefined, "no job may be created");
});

test("START_DELETION: in 'me' mode rejects items not authored by the scanning user", async () => {
  const { context } = loadBackground();
  const validate = vm.runInContext("validateQueueAgainstScan", context);
  const record = { users: { "1.0": "U1", "2.0": "U2" }, filterSender: "me", userId: "U1" };

  assert.strictEqual(validate([{ ts: "1.0", user: "U1" }], record).ok, true);
  // The page claims U1 wrote it, but the scan saw U2.
  const forged = validate([{ ts: "2.0", user: "U1" }], record);
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.error, "queue_not_owned");
  // The page's own claim also has to match.
  assert.strictEqual(validate([{ ts: "1.0", user: "U9" }], record).error, "queue_not_owned");
  // "all" (admin) mode accepts other authors — that's what it is for.
  assert.strictEqual(validate([{ ts: "2.0", user: "U2" }], { ...record, filterSender: "all" }).ok, true);
});

test("START_DELETION: the scan record survives a worker restart via session storage", async () => {
  const session = {};
  const { sandbox, context } = loadBackground();
  sandbox.chrome.storage.session.set = async (items) => { Object.assign(session, items); };
  sandbox.chrome.storage.session.get = async (key) => (key in session ? { [key]: session[key] } : {});

  const remember = vm.runInContext("rememberScanRecord", context);
  const load = vm.runInContext("loadScanRecord", context);
  await remember("T1", "C1", { filterSender: "me", userId: "U1" }, [{ ts: "1.0", user: "U1" }]);
  vm.runInContext("lastScanRecords.clear()", context); // simulated idle-death
  const record = await load("T1", "C1");
  assert.ok(record, "record must be recovered from chrome.storage.session");
  assert.strictEqual(record.scans[0].users["1.0"], "U1");
});

test("START_DELETION: a re-scan (e.g. from another tab) doesn't invalidate an earlier scan's selection", async () => {
  const { context } = loadBackground();
  const remember = vm.runInContext("rememberScanRecord", context);
  const load = vm.runInContext("loadScanRecord", context);
  const validate = vm.runInContext("validateQueueAgainstScan", context);
  await remember("T1", "C1", { filterSender: "me", userId: "U1" }, [{ ts: "1.0", user: "U1" }]);
  await remember("T1", "C1", { filterSender: "me", userId: "U1" }, [{ ts: "2.0", user: "U1" }]);
  const record = await load("T1", "C1");
  assert.strictEqual(validate([{ ts: "1.0", user: "U1" }, { ts: "2.0", user: "U1" }], record).ok, true);
  assert.strictEqual(validate([{ ts: "3.0", user: "U1" }], record).error, "queue_not_from_scan");
  // Expired scans no longer count.
  record.scans[0].at = Date.now() - 31 * 60 * 1000;
  assert.strictEqual(validate([{ ts: "1.0", user: "U1" }], record).error, "queue_not_from_scan");
});

test("RUN_SCAN: a different conversation may be scanned concurrently", async () => {
  // The guard is per-conversation. Two different channels are independent work and
  // must not block each other.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const stub = makeSlackFetch({
    "conversations.history": async () => {
      await gate;
      return { ok: true, messages: [], response_metadata: { next_cursor: "" } };
    }
  });

  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const first = sendMessage(handlers, SCAN_REQUEST);
  await new Promise((r) => setTimeout(r, 10));
  const second = sendMessage(handlers, { ...SCAN_REQUEST, channelId: "C2" });

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true, "a scan of another channel must not be refused");
  assert.strictEqual(stub.calls["conversations.history"], 2);
});

test("RUN_SCAN: the in-flight guard is released so the channel can be re-scanned", async () => {
  const stub = makeSlackFetch({
    "conversations.history": () => ({
      ok: true, messages: [{ ts: "1000.000", user: "U1", text: "hi" }], response_metadata: { next_cursor: "" }
    })
  });

  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const first = await sendMessage(handlers, SCAN_REQUEST);
  assert.strictEqual(first.ok, true);

  // A leaked guard would permanently wedge the channel: every later scan refused.
  const second = await sendMessage(handlers, SCAN_REQUEST);
  assert.strictEqual(second.ok, true, "the guard must not leak after a scan completes");
});

test("RUN_SCAN: the guard is released when the scan FAILS, not just when it succeeds", async () => {
  // A failing scan that leaked the guard would be worse than no guard: the user's
  // channel becomes permanently unscannable until the worker is torn down.
  const stub = makeSlackFetch({
    "conversations.history": () => ({ ok: false, error: "channel_not_found" })
  });

  const { handlers } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const first = await sendMessage(handlers, SCAN_REQUEST);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.error, "scan_error");

  const second = await sendMessage(handlers, SCAN_REQUEST);
  assert.notStrictEqual(second.error, "scan_in_progress",
    "a failed scan must release the guard");
});

test("queueKeyFor: job-progress and queue keys never collide across channels", () => {
  const { context } = loadBackground();
  const queueKeyFor = vm.runInContext("queueKeyFor", context);

  const a = queueKeyFor("T1", "C1");
  const b = queueKeyFor("T1", "C2");
  const c = queueKeyFor("T2", "C1");

  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
  // recoverAllJobs scans storage for the "slack_state_" prefix; a queue key that
  // shared it would be misread as a job record.
  assert.ok(!a.startsWith("slack_state_"));
});

test("parseJobKey: recovers teamId/channelId from a real slack_state_ key", () => {
  const { context } = loadBackground();
  const parseJobKey = vm.runInContext("parseJobKey", context);

  // Field-by-field, not deepStrictEqual: the vm-realm object's prototype differs
  // from this realm's plain-object literal, which deepStrictEqual treats as
  // unequal even when every own property matches (see the runScanInBg tests
  // above for the same re-homing gotcha).
  const result = parseJobKey("slack_state_T123_C456");
  assert.strictEqual(result.teamId, "T123");
  assert.strictEqual(result.channelId, "C456");
});

test("parseJobKey: rejects a key with the wrong number of underscore-delimited parts instead of misattributing an ID", () => {
  const { context } = loadBackground();
  const parseJobKey = vm.runInContext("parseJobKey", context);

  // Only Slack IDs are alphanumeric today, so this is a defensive/theoretical guard
  // rather than a reachable real-world case -- but if a team or channel ID ever DID
  // contain an underscore, a bare split+fixed-index read would silently drop part
  // of it (or attribute the wrong segment) instead of failing closed like this does.
  assert.strictEqual(parseJobKey("slack_state_T123_C456_extra"), null);
  assert.strictEqual(parseJobKey("slack_state_T123"), null);
  assert.strictEqual(parseJobKey("slack_state_"), null);
});

test("parseJobKey: rejects a key whose team/channel segments aren't alphanumeric (not a real Slack ID shape)", () => {
  const { context } = loadBackground();
  const parseJobKey = vm.runInContext("parseJobKey", context);

  assert.strictEqual(parseJobKey("slack_state_T-123_C456"), null);
  assert.strictEqual(parseJobKey("slack_state_T123_C 456"), null);
});

test("GET_JOB_STATUS: returns otherJobs if there is a job in another channel", async () => {
  const { handlers, context } = loadBackground();
  const activeJobs = vm.runInContext("activeJobs", context);
  activeJobs["slack_state_T1_C2"] = {
    teamId: "T1",
    channelId: "C2",
    isPaused: true,
    isRunning: false
  };

  const res = await sendMessage(handlers, { type: "GET_JOB_STATUS", teamId: "T1", channelId: "C1" });
  assert.strictEqual(res.exists, false);
  assert.strictEqual(res.otherJob, undefined, "the legacy singular field is gone");
  assert.strictEqual(res.otherJobs.length, 1);
  assert.strictEqual(res.otherJobs[0].channelId, "C2");
  assert.strictEqual(res.otherJobs[0].isPaused, true);
});

test("executeQueue: trim mode preserves structural blocks while removing files and images", async () => {
  let updateCalled = false;
  let sentBlocks = null;
  const stub = makeSlackFetch({
    "chat.update": (params) => {
      updateCalled = true;
      sentBlocks = params.blocks;
      return { ok: true };
    }
  });

  const { context } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });

  const activeJobs = vm.runInContext("activeJobs", context);
  activeJobs["slack_state_T1_C1"] = {
    teamId: "T1",
    channelId: "C1",
    token: "xoxc-test",
    isRunning: true,
    isPaused: false,
    deleteQueue: [{
      ts: "123",
      action: "trim",
      text: "hello",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "hello" } },
        { type: "image", image_url: "http" },
        { type: "file", file_id: "F123" }
      ]
    }],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 }
  };

  // Mock processingKeys to allow execution
  const _processingKeys = vm.runInContext("processingKeys", context);
  
  const executeQueue = vm.runInContext("executeQueue", context);
  await executeQueue("slack_state_T1_C1");

  assert.strictEqual(updateCalled, true);
  const blocks = JSON.parse(sentBlocks);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, "section");
});

test("isAutoResumeAllowed: prevents resumption on cold boot (session storage cleared)", async () => {
  const { context } = loadBackground();
  const isAutoResumeAllowed = vm.runInContext("isAutoResumeAllowed", context);

  // Default mock in test harness for session.get returns {} (empty), simulating cold boot
  const coldBoot = await isAutoResumeAllowed("slack_state_T1_C1");
  assert.strictEqual(coldBoot, false, "Must default to false if run token is missing");
});

test("isAutoResumeAllowed: permits resumption after SW suspension (session storage persists)", async () => {
  const { sandbox, context } = loadBackground();
  // Simulate session storage persisting across an idle-death
  sandbox.chrome.storage.session.get = async () => ({ "sc_run_slack_state_T1_C1": true });
  const isAutoResumeAllowed = vm.runInContext("isAutoResumeAllowed", context);

  const warmWake = await isAutoResumeAllowed("slack_state_T1_C1");
  assert.strictEqual(warmWake, true, "Must permit resumption if run token survived in session storage");
});

// Minimal persistent chrome.storage.local backed by a plain object, so a test can
// simulate state actually surviving a service-worker restart (the default harness
// mock's `get` always returns {} regardless of what was `set`).
function makePersistentLocalStorage() {
  const store = {};
  return {
    store,
    local: {
      get: async (keys) => {
        if (keys === null || keys === undefined) return { ...store };
        if (typeof keys === "string") return (keys in store) ? { [keys]: store[keys] } : {};
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        }
        return {};
      },
      set: async (items) => { Object.assign(store, items); },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
      }
    }
  };
}

test("saveJobState persists rate-limit/transient retry streaks, and recoverAllJobs restores them across a simulated SW restart", async () => {
  const { sandbox, context } = loadBackground();
  const { local } = makePersistentLocalStorage();
  sandbox.chrome.storage.local = local;

  const activeJobs = vm.runInContext("activeJobs", context);
  const saveJobState = vm.runInContext("saveJobState", context);
  const saveJobQueue = vm.runInContext("saveJobQueue", context);
  const recoverAllJobs = vm.runInContext("recoverAllJobs", context);

  const key = "slack_state_T1_C1";
  const job = {
    teamId: "T1",
    channelId: "C1",
    deleteQueue: [{ ts: "123", action: "delete" }],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 },
    isRunning: true,
    isPaused: false,
    throttleDelay: 1000,
    filterAttachments: false,
    _rateLimitRetries: 7,
    _transientRetries: 2
  };
  await saveJobQueue(job);
  await saveJobState(key, job);

  // Simulate the SW dying and restarting: the in-memory map is gone, only what
  // was persisted to chrome.storage.local (via the mock above) survives.
  delete activeJobs[key];
  await recoverAllJobs();

  assert.ok(activeJobs[key], "job must be recovered from storage");
  assert.strictEqual(activeJobs[key]._rateLimitRetries, 7,
    "rate-limit retry streak must survive a simulated SW restart, not reset to 0");
  assert.strictEqual(activeJobs[key]._transientRetries, 2,
    "transient retry streak must survive a simulated SW restart, not reset to 0");
});

test("MAX_RATELIMIT_RETRIES: a persisted retry streak from a previous SW lifetime is honored after recovery, not reset to 0", async () => {
  const MAX_RATELIMIT_RETRIES = 20; // mirrors background.js's own constant
  const key = "slack_state_T1_C1";

  // Every attempt at chat.delete comes back as HTTP 429 — the exact "perpetually
  // throttled item" scenario MAX_RATELIMIT_RETRIES exists to bound.
  const fetchImpl = async () => ({
    status: 429,
    headers: { get: (h) => (h === "Retry-After" ? "5" : null) },
    json: async () => ({ ok: false })
  });

  const { sandbox, context } = loadBackground({
    fetchImpl,
    sessionTokens: {
      sc_token_T1: "xoxc-test",
      // Browser-restart-safe "was actually running" flag — required for
      // executeQueue's recovery path to auto-resume a job it didn't start.
      [`sc_run_${key}`]: true
    }
  });
  const { local, store } = makePersistentLocalStorage();
  sandbox.chrome.storage.local = local;

  // Pre-seed storage as if a previous SW lifetime had already retried this exact
  // item MAX_RATELIMIT_RETRIES times (persisted by the fix under test) and then
  // died again before a 21st attempt could run.
  store[key] = {
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 },
    isRunning: true,
    isPaused: false,
    throttleDelay: 1000,
    filterAttachments: false,
    rateLimitRetries: MAX_RATELIMIT_RETRIES,
    transientRetries: 0
  };
  store["slack_q_T1_C1"] = [{ ts: "123", action: "delete" }];

  const activeJobs = vm.runInContext("activeJobs", context);
  assert.strictEqual(activeJobs[key], undefined, "activeJobs must start empty, as after a real SW restart");

  const executeQueue = vm.runInContext("executeQueue", context);
  await executeQueue(key);

  const job = activeJobs[key];
  assert.ok(job, "job must have been recovered");
  assert.strictEqual(job.isPaused, true,
    "must pause immediately on the very next 429 instead of granting a fresh 20-retry budget");
  assert.strictEqual(job.isRunning, false);
  assert.strictEqual(job.deleteIndex, 0, "the stuck item must not be counted as processed");
});

test("executeQueue: a structural/permission error (not_allowed_token_type) pauses the job immediately instead of failing one item at a time", async () => {
  let deleteCalls = 0;
  const stub = makeSlackFetch({
    "chat.delete": () => {
      deleteCalls++;
      return { ok: false, error: "not_allowed_token_type" };
    }
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const activeJobs = vm.runInContext("activeJobs", context);
  const key = "slack_state_T1_C1";
  activeJobs[key] = {
    teamId: "T1",
    channelId: "C1",
    token: "xoxc-test",
    isRunning: true,
    isPaused: false,
    deleteQueue: [
      { ts: "1", action: "delete" },
      { ts: "2", action: "delete" }
    ],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 2 }
  };

  const executeQueue = vm.runInContext("executeQueue", context);
  await executeQueue(key);

  const job = activeJobs[key];
  assert.strictEqual(deleteCalls, 1, "must stop after the first structural failure, not try the second item");
  assert.strictEqual(job.isPaused, true);
  assert.strictEqual(job.isRunning, false);
  assert.strictEqual(job.deleteIndex, 0, "the failed item must not be counted as processed");
  assert.strictEqual(job.stats.fail, 0,
    "a structural/job-wide error is not a per-item failure and must not inflate the fail count");
});

test("executeQueue: channel_not_found (a structural error not in the original hardcoded auth list) also pauses immediately", async () => {
  const stub = makeSlackFetch({
    "chat.delete": () => ({ ok: false, error: "channel_not_found" })
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const activeJobs = vm.runInContext("activeJobs", context);
  const key = "slack_state_T1_C1";
  activeJobs[key] = {
    teamId: "T1",
    channelId: "C1",
    token: "xoxc-test",
    isRunning: true,
    isPaused: false,
    deleteQueue: [{ ts: "1", action: "delete" }],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 }
  };

  const executeQueue = vm.runInContext("executeQueue", context);
  await executeQueue(key);

  assert.strictEqual(activeJobs[key].isPaused, true);
  assert.strictEqual(activeJobs[key].stats.fail, 0);
});

test("executeQueue: a transient network error retries the SAME item without advancing, then succeeds on the next tick", async () => {
  let deleteCalls = 0;
  const stub = makeSlackFetch({
    "chat.delete": () => {
      deleteCalls++;
      if (deleteCalls === 1) throw new Error("simulated network blip");
      return { ok: true };
    }
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const activeJobs = vm.runInContext("activeJobs", context);
  const key = "slack_state_T1_C1";
  activeJobs[key] = {
    teamId: "T1",
    channelId: "C1",
    token: "xoxc-test",
    isRunning: true,
    isPaused: false,
    deleteQueue: [{ ts: "1", time: "t1", action: "delete" }],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 }
  };
  // Captured up front: executeQueue deletes activeJobs[key] once the (1-item)
  // queue is exhausted, but this object reference stays valid for assertions.
  const job = activeJobs[key];

  const executeQueue = vm.runInContext("executeQueue", context);

  await executeQueue(key); // 1st attempt: network_error -> retry scheduled
  assert.strictEqual(job.deleteIndex, 0, "must not advance past the item on a transient failure");
  assert.strictEqual(job._transientRetries, 1);
  assert.strictEqual(job.isRunning, true, "job stays running -- this is a per-item retry, not a pause");
  // The scheduled retry (a real setTimeout under SETTIMEOUT_MAX_MS) is simulated
  // by calling executeQueue again directly below rather than waiting it out; clear
  // it so it doesn't also fire for real ~3s later and needlessly keep the test
  // process alive.
  clearTimeout(job._timer);

  await executeQueue(key); // 2nd attempt (simulating the scheduled retry firing): succeeds
  assert.strictEqual(deleteCalls, 2);
  assert.strictEqual(job.stats.success, 1);
  assert.strictEqual(job.stats.fail, 0);
  assert.strictEqual(job.isRunning, false, "queue is now exhausted (1 item, now processed)");
});

test("executeQueue: a transient error exhausting MAX_TRANSIENT_RETRIES is counted as a genuine failure and the queue advances past it", async () => {
  const stub = makeSlackFetch({
    "chat.delete": () => { throw new Error("persistent network failure"); }
  });

  const { context } = loadBackground({ fetchImpl: stub.fetch });
  const activeJobs = vm.runInContext("activeJobs", context);
  const key = "slack_state_T1_C1";
  activeJobs[key] = {
    teamId: "T1",
    channelId: "C1",
    token: "xoxc-test",
    isRunning: true,
    isPaused: false,
    deleteQueue: [{ ts: "1", time: "t1", action: "delete" }],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 }
  };
  // Captured up front: executeQueue deletes activeJobs[key] once the (1-item)
  // queue is exhausted, but this object reference stays valid for assertions.
  const job = activeJobs[key];

  const executeQueue = vm.runInContext("executeQueue", context);
  const MAX_TRANSIENT_RETRIES = vm.runInContext("MAX_TRANSIENT_RETRIES", context);

  // One tick per retry attempt, plus one more to exceed the cap and give up. Each
  // call simulates that tick's scheduled retry firing, so clear the real timer
  // scheduleNextStep armed on the prior tick before simulating the next one --
  // otherwise it fires for real ~3s later, needlessly keeping the test process
  // alive (harmless in production: real ticks are separated by the timer
  // actually firing, so there's never more than one pending at once there).
  for (let i = 0; i < MAX_TRANSIENT_RETRIES + 1; i++) {
    clearTimeout(job._timer);
    await executeQueue(key);
  }

  assert.strictEqual(job.stats.fail, 1, "must be counted as a failure once retries are exhausted");
  assert.strictEqual(job.isRunning, false, "queue is exhausted (1 item, now resolved as a failure)");
});

test("START_DELETION: refuses to overwrite an existing PAUSED job's queue/progress", async () => {
  const { handlers, context } = loadBackground();
  const activeJobs = vm.runInContext("activeJobs", context);
  const key = "slack_state_T1_C1";
  const originalQueue = [{ ts: "1" }, { ts: "2" }, { ts: "3" }];
  const pausedJob = {
    teamId: "T1",
    channelId: "C1",
    token: "xoxc-old",
    isRunning: false,
    isPaused: true,
    deleteQueue: originalQueue,
    deleteIndex: 1,
    stats: { success: 1, fail: 0, skipped: 0, total: 3 }
  };
  activeJobs[key] = pausedJob;

  const res = await sendMessage(handlers, {
    type: "START_DELETION",
    teamId: "T1",
    channelId: "C1",
    deleteQueue: [{ ts: "999" }], // a brand-new, unrelated scan's queue
    throttleDelay: 1000
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "job_already_paused");
  // The paused job's queue/progress must be completely untouched, not silently
  // replaced by the new one.
  assert.strictEqual(activeJobs[key], pausedJob, "must not replace the job object");
  assert.strictEqual(activeJobs[key].deleteQueue, originalQueue);
  assert.strictEqual(activeJobs[key].deleteIndex, 1);
});

test("START_DELETION: still refused while a job is actively RUNNING (existing guard unaffected by the isPaused addition)", async () => {
  const { handlers, context } = loadBackground();
  const activeJobs = vm.runInContext("activeJobs", context);
  const key = "slack_state_T1_C1";
  activeJobs[key] = {
    teamId: "T1", channelId: "C1", isRunning: true, isPaused: false,
    deleteQueue: [{ ts: "1" }], deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, total: 1 }
  };

  const res = await sendMessage(handlers, {
    type: "START_DELETION", teamId: "T1", channelId: "C1",
    deleteQueue: [{ ts: "999" }], throttleDelay: 1000
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "job_already_running");
});

test("SET_SESSION: propagates a session-storage write failure to the caller, but still caches the token in memory", async () => {
  const { sandbox, handlers, context } = loadBackground();
  sandbox.chrome.storage.session.set = async () => { throw new Error("quota_exceeded"); };

  const res = await sendMessage(handlers, { type: "SET_SESSION", teamId: "T1", token: "xoxc-new" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "session_storage_failed");

  // The in-memory cache must still have been updated, so the token is usable for
  // the rest of this service-worker lifetime even though it won't survive a
  // restart.
  const userTokens = vm.runInContext("userTokens", context);
  assert.strictEqual(userTokens.T1, "xoxc-new");
});

test("SET_SESSION: reports success once the session-storage write actually resolves", async () => {
  const { handlers } = loadBackground();
  const res = await sendMessage(handlers, { type: "SET_SESSION", teamId: "T1", token: "xoxc-ok" });
  assert.strictEqual(res.success, true);
});

test("slackAPICallWithRetry (via runScanInBg): a very long Retry-After fails fast and returns partial results, not an uncapped wait or a thrown error", async () => {
  let historyCalls = 0;
  const fetchImpl = async (url) => {
    const endpoint = String(url).split("/api/")[1];
    if (endpoint === "conversations.history") {
      historyCalls++;
      if (historyCalls === 1) {
        // First page succeeds and returns a real message -- proves this isn't
        // discarded once the SECOND page hits an unsafe-to-wait rate limit.
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, messages: [{ ts: "100.000", user: "U1", text: "hi" }], response_metadata: { next_cursor: "cursor1" } })
        };
      }
      return {
        status: 429,
        // Far beyond SETTIMEOUT_MAX_MS (25s) — the exact case where an uncapped
        // setTimeout risks the SW dying mid-wait and silently losing the scan.
        headers: { get: (h) => (h === "Retry-After" ? "9999" : null) },
        json: async () => ({ ok: false })
      };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  const { context } = loadBackground({ fetchImpl });
  const runScanInBg = vm.runInContext("runScanInBg", context);

  const start = Date.now();
  const scan = await runScanInBg("xoxc-test", {
    channelId: "C123", oldest: 0, latest: 9999999999, includeThreads: false,
    filterSender: "all", filterText: "", onlyAttachments: false, userId: "U1"
  });
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 2000, `must fail fast, not actually wait ~9999s (took ${elapsedMs}ms)`);
  // The first page's message must survive -- a late rate limit must not discard
  // everything already gathered.
  assert.deepStrictEqual(Array.from(scan.results, r => r.ts), ["100.000"]);
  assert.strictEqual(scan.moreAvailable, true, "must honestly report the scan stopped early");
  assert.strictEqual(scan.capped, false);
});

test("BG_API_CALL: only the read-only lookup endpoints are proxied", async () => {
  const { handlers } = loadBackground();
  await sendMessage(handlers, { type: "SET_SESSION", teamId: "T1", token: "xoxc-ok" });
  const res = await sendMessage(handlers, { type: "BG_API_CALL", teamId: "T1", endpoint: "chat.delete", params: { channel: "C1", ts: "1.1" } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "endpoint_not_allowed");
});

test("executeQueue: a trim on a message with uploaded files is reported as partial, not cleaned", async () => {
  const stub = makeSlackFetch({ "chat.update": () => ({ ok: true }) });
  const logs = [];
  const { sandbox, context } = loadBackground({
    fetchImpl: stub.fetch,
    sessionTokens: { sc_token_T1: "xoxc-test" }
  });
  sandbox.chrome.tabs.query = (_q, cb) => cb([{ id: 1 }]);
  sandbox.chrome.tabs.sendMessage = (_id, msg, cb) => { if (msg.type === "JOB_LOG") logs.push(msg.log); if (cb) cb(); };

  const activeJobs = vm.runInContext("activeJobs", context);
  activeJobs["slack_state_T1_C1"] = {
    teamId: "T1", channelId: "C1", token: "xoxc-test", isRunning: true, isPaused: false,
    deleteQueue: [
      { ts: "1", time: "t1", action: "trim", text: "caption", blocks: [], files: [{ id: "F1" }] },
      { ts: "2", time: "t2", action: "trim", text: "unfurl only", blocks: [], files: [] }
    ],
    deleteIndex: 0,
    stats: { success: 0, fail: 0, skipped: 0, partial: 0, total: 2 },
    throttleDelay: 1000
  };
  const executeQueue = vm.runInContext("executeQueue", context);
  const clearScheduled = vm.runInContext("clearScheduled", context);
  await executeQueue("slack_state_T1_C1");
  clearScheduled("slack_state_T1_C1");
  const job = activeJobs["slack_state_T1_C1"];
  assert.strictEqual(job.stats.partial, 1, "files remain attached -> partial");
  assert.strictEqual(job.stats.success, 0, "must not be counted as fully cleaned");
  assert.ok(logs.some(l => l.message.startsWith("[Partial]")), "log must say partial, not [Success]");
  assert.ok(!logs.some(l => l.message.startsWith("[Success]")));

  await executeQueue("slack_state_T1_C1");
  assert.strictEqual(job.stats.success, 1, "a trim with no uploaded files is a genuine clean");
});

test("recoverAllJobs: a job paused for more than 30 days is discarded with its queue; a recent one is kept", async () => {
  const { sandbox, context } = loadBackground();
  const { local, store } = makePersistentLocalStorage();
  sandbox.chrome.storage.local = local;
  const DAY = 24 * 60 * 60 * 1000;
  store["slack_state_T1_C1"] = { isPaused: true, isRunning: false, deleteIndex: 3, stats: { total: 10 }, timestamp: Date.now() - 31 * DAY };
  store["slack_q_T1_C1"] = [{ ts: "1", action: "trim", text: "secret" }];
  store["slack_state_T1_C2"] = { isPaused: true, isRunning: false, deleteIndex: 1, stats: { total: 5 }, timestamp: Date.now() - 2 * DAY };
  store["slack_q_T1_C2"] = [{ ts: "2", action: "delete" }];

  const recoverAllJobs = vm.runInContext("recoverAllJobs", context);
  await recoverAllJobs();
  const activeJobs = vm.runInContext("activeJobs", context);

  assert.strictEqual(activeJobs["slack_state_T1_C1"], undefined, "expired job must not be recovered");
  assert.ok(!("slack_state_T1_C1" in store), "expired job record must be removed from storage");
  assert.ok(!("slack_q_T1_C1" in store), "expired job queue (with message text) must be removed");
  assert.ok(activeJobs["slack_state_T1_C2"], "a recently paused job is still recoverable");
  assert.ok("slack_q_T1_C2" in store);
});
