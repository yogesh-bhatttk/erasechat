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
      sendMessage: (_id, _msg, cb) => { if (cb) cb(); }
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

test("RUN_SCAN: a duplicate scan of the same conversation is refused, not run twice", async () => {
  // The dashboard abandons a scan after its own client-side timeout and invites a
  // retry, while the worker keeps paginating. Without this guard the retry starts a
  // second full sweep concurrently — doubling the API load that made the first slow.
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
  const second = await sendMessage(handlers, SCAN_REQUEST);

  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, "scan_in_progress",
    "the second scan must be refused while the first is still sweeping");

  releaseFirstScan();
  const firstResult = await first;
  assert.strictEqual(firstResult.ok, true, "the original scan still completes normally");
  assert.strictEqual(stub.calls["conversations.history"], 1,
    "the refused scan must not have issued any Slack API calls");
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

test("GET_JOB_STATUS: returns otherJob if there is a job in another channel", async () => {
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
  assert.ok(res.otherJob);
  assert.strictEqual(res.otherJob.channelId, "C2");
  assert.strictEqual(res.otherJob.isPaused, true);
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
