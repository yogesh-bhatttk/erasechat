// SlackClean Premium - Background Service Worker

// Load shared filtering/safety logic (single source of truth).
// Chrome MV3 service worker: importScripts is available.
// Firefox MV3 event page: shared-filters.js is loaded first via background.scripts,
// so importScripts is unavailable here and must be skipped.
if (typeof importScripts === "function") {
  importScripts("shared-filters.js");
}

const MAX_SCAN_PAGES = 20;
const MAX_SCAN_RESULTS = 5000;
const DEFAULT_THROTTLE_DELAY = 1000;
const STORAGE_BATCH_INTERVAL = 10;
// Transient (network/exception) errors on a single item are retried this many
// times with a short backoff before the item is counted as failed — so a brief
// connectivity blip doesn't permanently skip messages the user asked to delete.
const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_DELAY_MS = 3000;
// Rate-limit (HTTP 429) backoff respects Slack's Retry-After, but a single item
// that is throttled on EVERY attempt would otherwise retry forever and leave the
// job silently stuck at N%. Cap the consecutive 429 retries per item; on exceeding
// it, pause the job (recoverable) instead of looping indefinitely. Reset once an
// item finally resolves, so normal throttled progress never trips it.
const MAX_RATELIMIT_RETRIES = 20;

// Queue engine timing.
// Pacing under this bound uses setTimeout for accurate sub-30s throttling
// (chrome.alarms clamps to a ~30s floor, which is useless for per-message pacing).
// Longer waits (rate-limit backoff) use alarms so they survive SW termination.
const SETTIMEOUT_MAX_MS = 25000;
const WATCHDOG_ALARM = "sc_watchdog";
const WATCHDOG_PERIOD_MIN = 0.5; // 30s: the platform minimum; used only for crash recovery
const STALL_GRACE_MS = 20000;    // a job is "stalled" (SW died) only if this far past due

// Companion storage key holding a job's immutable delete queue. Kept separate
// from the (frequently-rewritten) progress record so batched progress saves
// don't re-serialize the whole queue. Prefix intentionally does NOT start with
// "slackclean_state_" so recoverAllJobs never mistakes it for a job record.
const QUEUE_PREFIX = "sc_q_";

let activeJobs = {}; // key: `slackclean_state_${teamId}_${channelId}` -> job state
let userTokens = {}; // key: `${teamId}` -> xoxc- token

// Reentrancy lock keyed by job key. Module-level (not on the job object) so it
// survives recoverAllJobs() replacing job objects, and is acquired BEFORE any
// recovery so two alarm/timeout paths can't double-process or double-recover.
const processingKeys = new Set();

function queueKeyFor(teamId, channelId) {
  return `${QUEUE_PREFIX}${teamId}_${channelId}`;
}

// Return the team's token, recovering it from session storage if the in-memory
// cache was cleared by a service-worker idle-death mid-session (e.g. the SW died
// between a scan and a delete). Without this, token-dependent messages fail with
// not_authed even though the session is still valid.
async function ensureToken(teamId) {
  if (userTokens[teamId]) return userTokens[teamId];
  try {
    const d = await chrome.storage.session.get(`sc_token_${teamId}`);
    const t = d[`sc_token_${teamId}`];
    if (t) {
      userTokens[teamId] = t;
      return t;
    }
  } catch (e) { /* session storage unavailable */ }
  return null;
}

// Global error handler for unhandled promise rejections
self.addEventListener("unhandledrejection", (event) => {
  console.error("SlackClean BG: Unhandled promise rejection:", event.reason);
  event.preventDefault(); // Prevent service worker from terminating
});

// Alarm listener: watchdog sweep + long-wait (rate-limit) resumption
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    runWatchdogSweep();
    return;
  }
  if (alarm.name.startsWith("sc_queue_")) {
    const key = alarm.name.replace("sc_queue_", "");
    executeQueue(key);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await recoverAllJobs();
  // Browser restart safety: never silently auto-resume a destructive job.
  // Force any previously-running job to paused; the user confirms resume in the dashboard.
  for (const [key, job] of Object.entries(activeJobs)) {
    if (job.isRunning && !job.isPaused) {
      job.isRunning = false;
      job.isPaused = true;
      clearScheduled(key);
      markRunning(key, false);
      await saveJobState(key, job, true);
    }
  }
  maybeClearWatchdog();
});

chrome.runtime.onInstalled.addListener((details) => {
  recoverAllJobs();

  // Set first-run flag for onboarding
  if (details.reason === "install") {
    chrome.storage.local.set({ sc_onboarding_complete: false });
  }
});

// Save critical state before service worker termination
chrome.runtime.onSuspend.addListener(() => {
  for (const [key, job] of Object.entries(activeJobs)) {
    if (job.isRunning) {
      saveJobState(key, job, true);
    }
  }
});

async function recoverAllJobs() {
  try {
    // Recover tokens from session storage (memory-only, not persisted to disk)
    try {
      const sessionData = await chrome.storage.session.get(null);
      for (const [key, val] of Object.entries(sessionData)) {
        if (key.startsWith("sc_token_") && val) {
          const teamId = key.replace("sc_token_", "");
          userTokens[teamId] = val;
        }
      }
    } catch (e) {
      // chrome.storage.session unavailable (older browsers)
    }

    const storage = await chrome.storage.local.get(null);
    for (const [key, val] of Object.entries(storage)) {
      if (key.startsWith("slackclean_state_") && val) {
        // Never clobber a live in-memory job — storage is only a backup, and a
        // running job's state is always fresher than what's on disk.
        if (activeJobs[key]) continue;

        const parts = key.split("_");
        // key format: slackclean_state_${teamId}_${channelId}
        if (parts.length >= 4) {
          const teamId = parts[2];
          const channelId = parts[3];

          // Queue lives in a companion key; fall back to any legacy inline queue.
          const companionQueue = storage[queueKeyFor(teamId, channelId)];
          const recoveredQueue = Array.isArray(companionQueue)
            ? companionQueue
            : (val.deleteQueue || []);

          activeJobs[key] = {
            teamId,
            channelId,
            token: userTokens[teamId] || null,
            deleteQueue: recoveredQueue,
            deleteIndex: val.deleteIndex || 0,
            stats: val.stats || { success: 0, fail: 0, skipped: 0, total: 0 },
            // Honor the persisted run state so a job interrupted by a mere
            // service-worker idle-death resumes on its own (via the watchdog).
            // onStartup separately force-pauses across full browser restarts.
            isRunning: !!val.isRunning,
            isPaused: val.isPaused !== undefined ? !!val.isPaused : true,
            throttleDelay: val.throttleDelay || DEFAULT_THROTTLE_DELAY,
            filterAttachments: val.filterAttachments || false,
            nextRunAt: 0,     // 0 => immediately due to the watchdog after a crash
            _timer: null
          };
        }
      }
    }

    // Re-arm the watchdog if anything is meant to be running.
    if (Object.values(activeJobs).some(j => j.isRunning && !j.isPaused)) {
      ensureWatchdog();
    }
  } catch (err) {
    console.error("SlackClean BG: Error recovering jobs", err);
  }
}

// Global API Fetch helper
async function slackAPICall(token, endpoint, params = {}) {
  if (!token) {
    return { ok: false, error: "not_authed", message: "Missing Slack API Token" };
  }

  const bodyParams = new URLSearchParams();
  bodyParams.append("token", token);
  for (const [k, v] of Object.entries(params)) {
    // Skip unset params: String(undefined) === "undefined" would be sent verbatim
    // and rejected by Slack (e.g. latest=undefined -> invalid_ts_latest), failing
    // the whole call. Omit them so Slack applies its own defaults.
    if (v === undefined || v === null) continue;
    bodyParams.append(k, String(v));
  }

  try {
    const response = await fetch(`https://slack.com/api/${endpoint}`, {
      method: "POST",
      // xoxc- client tokens are only valid alongside the Slack `d` session cookie.
      // credentials:"include" attaches first-party slack.com cookies to this
      // cross-origin request (permitted by our slack.com host_permission).
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "15", 10);
      return { ok: false, error: "rate_limited", retryAfter };
    }

    const data = await response.json();
    return data;
  } catch (err) {
    console.error(`SlackClean BG: API Error on ${endpoint}`, err);
    return { ok: false, error: "network_error", message: err.message };
  }
}

// API Fetch helper that retries on rate limits
async function slackAPICallWithRetry(token, endpoint, params = {}, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    const data = await slackAPICall(token, endpoint, params);
    if (data.ok) return data;

    if (data.error === "rate_limited") {
      const waitTime = (data.retryAfter || 10) + 1;
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      attempt++;
    } else {
      return data;
    }
  }
  return { ok: false, error: "max_retries_exceeded", message: "Maximum API call retries exceeded." };
}

// Origin Validation Helper
function isValidSender(sender) {
  // Trust messages from this extension's own scripts (popup, options page)
  if (sender.id === chrome.runtime.id && !sender.tab) return true;

  const senderUrl = sender.tab?.url || sender.url;
  if (!senderUrl) return false;

  // Exact hostname match (shared logic) prevents subdomain spoofing.
  if (isSlackHostname(senderUrl)) return true;

  // Allow extension pages (fixed chrome-extension:// origin — startsWith is safe here)
  const extensionUrl = chrome.runtime.getURL("");
  if (senderUrl.startsWith(extensionUrl)) return true;

  return false;
}

// Message Router
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Security origin validation
  if (!isValidSender(sender)) {
    sendResponse({ ok: false, error: "unauthorized_origin" });
    return false;
  }

  if (request.type === "SET_SESSION") {
    userTokens[request.teamId] = request.token;
    // Persist token in session storage (memory-only, cleared on browser close)
    try {
      chrome.storage.session.set({ [`sc_token_${request.teamId}`]: request.token });
    } catch (e) { /* session storage unavailable in older browsers */ }
    sendResponse({ success: true });
    return false;
  }

  else if (request.type === "GET_SESSION") {
    const token = userTokens[request.teamId] || null;
    sendResponse({ token });
    return false;
  }

  else if (request.type === "BG_API_CALL") {
    ensureToken(request.teamId).then(token => {
      if (!token) { sendResponse({ ok: false, error: "not_authed" }); return; }
      return slackAPICall(token, request.endpoint, request.params).then(res => sendResponse(res));
    }).catch(err => sendResponse({ ok: false, error: "catch_error", message: err.message }));
    return true; // async response
  }

  else if (request.type === "GET_JOB_STATUS") {
    const key = `slackclean_state_${request.teamId}_${request.channelId}`;
    const respond = () => {
      const job = activeJobs[key];
      if (job) {
        sendResponse({
          exists: true,
          job: {
            deleteIndex: job.deleteIndex,
            stats: job.stats,
            isRunning: job.isRunning,
            isPaused: job.isPaused,
            throttleDelay: job.throttleDelay,
            filterAttachments: job.filterAttachments
          }
        });
      } else {
        sendResponse({ exists: false });
      }
    };

    // If in-memory state was lost to a service-worker idle-death mid-session,
    // re-hydrate from storage so an interrupted/paused job's resume prompt isn't
    // silently lost until the next browser restart.
    if (!activeJobs[key]) {
      recoverAllJobs().then(respond).catch(respond);
      return true; // async response
    }
    respond();
    return false;
  }

  else if (request.type === "RUN_SCAN") {
    ensureToken(request.teamId).then(token => {
      if (!token) {
        sendResponse({ ok: false, error: "not_authed", message: "Session token not found in background." });
        return;
      }
      return runScanInBg(token, request).then(scan => sendResponse({
        ok: true,
        results: scan.results,
        moreAvailable: scan.moreAvailable,
        capped: scan.capped
      }));
    }).catch(err => sendResponse({ ok: false, error: "scan_error", message: err.message }));
    return true; // async response
  }

  else if (request.type === "START_DELETION") {
    ensureToken(request.teamId).then(token => {
      if (!token) {
        sendResponse({ success: false, error: "not_authed" });
        return;
      }

      const key = `slackclean_state_${request.teamId}_${request.channelId}`;
      clearScheduled(key);

      // Resolve each item's concrete action once, here, via the shared decision
      // function, then persist it (see saveJobState) so it is stable across restarts.
      const filterAttachments = request.filterAttachments || false;
      const preparedQueue = (request.deleteQueue || []).map(item => ({
        ...item,
        action: decideItemAction(item, filterAttachments)
      }));

      activeJobs[key] = {
        teamId: request.teamId,
        channelId: request.channelId,
        token: token,
        deleteQueue: preparedQueue,
        deleteIndex: request.deleteIndex || 0,
        stats: request.stats || { success: 0, fail: 0, skipped: 0, total: request.deleteQueue.length },
        isRunning: true,
        isPaused: false,
        throttleDelay: request.throttleDelay || DEFAULT_THROTTLE_DELAY,
        filterAttachments,
        nextRunAt: 0,
        _timer: null
      };

      // Persist the (immutable) queue once; progress saves afterward are light.
      saveJobQueue(activeJobs[key]);
      saveJobState(key, activeJobs[key]);
      markRunning(key, true);
      ensureWatchdog();
      scheduleNextStep(key, 0);
      sendResponse({ success: true });
    }).catch(err => sendResponse({ success: false, error: "catch_error", message: err.message }));
    return true; // async response
  }

  // PAUSE/RESUME/CANCEL must recover the job from storage first. If the service
  // worker was idle-killed mid-job and is woken BY this very message, activeJobs
  // is empty; acting only on the in-memory map would silently no-op while the
  // on-disk state (and the sc_run_ session flag) still says "running" — so a
  // pending rate-limit alarm or the watchdog would later RESUME a job the user
  // just paused/cancelled. Recover, then apply the transition. (async response.)
  else if (request.type === "PAUSE_DELETION") {
    const key = `slackclean_state_${request.teamId}_${request.channelId}`;
    (async () => {
      if (!activeJobs[key]) await recoverAllJobs();
      const job = activeJobs[key];
      if (job) {
        job.isPaused = true;
        clearScheduled(key);
        markRunning(key, false);
        await saveJobState(key, job, true);
        broadcastJobUpdate(job);
        maybeClearWatchdog();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  else if (request.type === "RESUME_DELETION") {
    const key = `slackclean_state_${request.teamId}_${request.channelId}`;
    (async () => {
      if (!activeJobs[key]) await recoverAllJobs();
      const job = activeJobs[key];
      if (job) {
        job.isPaused = false;
        job.isRunning = true;
        await saveJobState(key, job, true);
        markRunning(key, true);
        broadcastJobUpdate(job);
        ensureWatchdog();
        scheduleNextStep(key, 0);
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  else if (request.type === "CANCEL_DELETION") {
    const key = `slackclean_state_${request.teamId}_${request.channelId}`;
    (async () => {
      if (!activeJobs[key]) await recoverAllJobs();
      const job = activeJobs[key];
      if (job) {
        job.isRunning = false;
        job.isPaused = false;
        clearScheduled(key);
        markRunning(key, false);
        await clearJobState(key, job);
        delete activeJobs[key];

        broadcastJobUpdate({
          teamId: request.teamId,
          channelId: request.channelId,
          isRunning: false,
          isPaused: false,
          deleteIndex: 0,
          stats: { success: 0, fail: 0, skipped: 0, total: 0 }
        });
        maybeClearWatchdog();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Queue scheduling (accurate pacing via setTimeout; alarms only for recovery)
// ---------------------------------------------------------------------------

// Memory-only "this job is actively running" flag. chrome.storage.session
// survives service-worker idle-death but is cleared on browser close — exactly
// the signal that separates "SW restarted, keep going" from "browser restarted,
// require the user to confirm before resuming a destructive delete".
function markRunning(key, on) {
  try {
    if (on) chrome.storage.session.set({ [`sc_run_${key}`]: true });
    else chrome.storage.session.remove(`sc_run_${key}`);
  } catch (e) { /* session storage unavailable */ }
}

async function isAutoResumeAllowed(key) {
  try {
    const d = await chrome.storage.session.get(`sc_run_${key}`);
    return !!d[`sc_run_${key}`];
  } catch (e) {
    return false; // safe default: do not auto-resume a destructive job
  }
}

function ensureWatchdog() {
  chrome.alarms.get(WATCHDOG_ALARM, (a) => {
    if (!a) chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  });
}

function maybeClearWatchdog() {
  const anyRunning = Object.values(activeJobs).some(j => j.isRunning && !j.isPaused);
  if (!anyRunning) chrome.alarms.clear(WATCHDOG_ALARM);
}

function clearScheduled(key) {
  const job = activeJobs[key];
  if (job && job._timer) {
    clearTimeout(job._timer);
    job._timer = null;
  }
  chrome.alarms.clear(`sc_queue_${key}`);
}

function scheduleNextStep(key, delayMs) {
  const job = activeJobs[key];
  if (!job) return;

  const delay = Math.max(10, delayMs);
  job.nextRunAt = Date.now() + delay;

  if (job._timer) {
    clearTimeout(job._timer);
    job._timer = null;
  }
  chrome.alarms.clear(`sc_queue_${key}`);
  // Watchdog is armed once at start/resume/recovery — no need to poll it here.

  if (delay <= SETTIMEOUT_MAX_MS) {
    // Accurate pacing. Each step performs a fetch, which keeps the SW alive
    // between short intervals; the watchdog recovers if the SW is killed.
    job._timer = setTimeout(() => {
      job._timer = null;
      executeQueue(key);
    }, delay);
  } else {
    // Long wait (rate-limit backoff): an alarm survives SW termination.
    chrome.alarms.create(`sc_queue_${key}`, { when: job.nextRunAt });
  }
}

// Recovery net: resume jobs whose setTimeout was lost to a service-worker death.
async function runWatchdogSweep() {
  if (Object.keys(activeJobs).length === 0) {
    await recoverAllJobs();
  }

  const now = Date.now();
  for (const key of Object.keys(activeJobs)) {
    const job = activeJobs[key];
    if (!job || job.isPaused || !job.isRunning || processingKeys.has(key)) continue;
    // Skip jobs that are pacing normally (nextRunAt in the near future).
    if (job.nextRunAt && now < job.nextRunAt + STALL_GRACE_MS) continue;
    // Only auto-resume a stalled job if it was running before a SW death —
    // never silently resume a destructive delete after a full browser restart.
    if (!(await isAutoResumeAllowed(key))) continue;
    executeQueue(key);
  }

  maybeClearWatchdog();
}

// Background Scan Execution
async function runScanInBg(token, req) {
  const { channelId, oldest, latest, includeThreads, filterSender, filterText, onlyAttachments, userId } = req;
  // Numeric bounds for the manual thread-reply time filter below. Coerce defensively:
  // a missing/empty `latest` must mean "no upper bound" (Infinity), not "" — because
  // `replyTsNum > ""` coerces to `> 0` and would drop every reply. Likewise oldest -> 0.
  const oldestNum = (oldest === undefined || oldest === null || oldest === "") ? 0 : parseFloat(oldest);
  const latestNum = (latest === undefined || latest === null || latest === "") ? Infinity : parseFloat(latest);

  // Thread replies live inside their PARENT message, reachable only by expanding
  // that parent. conversations.history only returns messages whose own ts is within
  // [oldest, latest], so with a non-zero lower bound a thread whose ROOT predates the
  // window is never returned — and its in-window replies would be silently missed.
  // When threads are included AND a lower bound is set, drop the server-side `oldest`
  // for the history sweep so older parents are still discovered and expanded; root
  // messages are then filtered to the window client-side (see rootInWindow) so an
  // out-of-window root is never itself queued. The upper bound is safe to keep: a
  // reply is always newer than its parent, so no in-window reply can hang off a
  // parent newer than `latest`.
  const relaxLowerBound = includeThreads && oldestNum > 0;
  const historyOldest = relaxLowerBound ? 0 : oldest;
  const results = [];
  // Dedup by ts: a reply sent with "also send to channel" (thread_broadcast)
  // is returned by BOTH conversations.history (as a top-level message) and its
  // parent's conversations.replies. Without this it would be scanned, queued,
  // and chat.delete'd twice (the second call failing with message_not_found).
  const seenTs = new Set();
  let cursor = "";
  let pageCount = 0;
  const maxPages = MAX_SCAN_PAGES;
  let continueScan = true;
  let capped = false;

  while (continueScan) {
    const res = await slackAPICallWithRetry(token, "conversations.history", {
      channel: channelId,
      latest,
      oldest: historyOldest,
      limit: 100,
      cursor
    });

    if (!res.ok) {
      throw new Error(`Conversations history failed: ${res.error}`);
    }

    const messages = res.messages || [];
    for (const msg of messages) {
      // Client-side window guard for ROOT messages. Redundant when the server-side
      // `oldest` is in force, but essential once relaxLowerBound drops it — it keeps
      // roots older than the window (fetched only to expand their threads) from being
      // queued for deletion themselves.
      const msgTsNum = parseFloat(msg.ts);
      const rootInWindow = msgTsNum >= oldestNum && msgTsNum <= latestNum;

      if (rootInWindow && qualifies(msg, userId, filterSender, filterText, onlyAttachments) && !seenTs.has(msg.ts)) {
        seenTs.add(msg.ts);
        results.push({
          ts: msg.ts,
          user: msg.user,
          text: msg.text || "",
          time: new Date(parseFloat(msg.ts) * 1000).toLocaleString(),
          isThreadReply: false,
          files: msg.files || [],
          attachments: msg.attachments || []
        });

        if (results.length >= MAX_SCAN_RESULTS) {
          capped = true;
          return { results, capped, moreAvailable: true };
        }
      }

      if (includeThreads && msg.thread_ts && msg.thread_ts === msg.ts) {
        let threadCursor = "";
        let threadHasMore = true;

        while (threadHasMore) {
          const threadRes = await slackAPICallWithRetry(token, "conversations.replies", {
            channel: channelId,
            ts: msg.thread_ts,
            cursor: threadCursor
          });

          if (threadRes && threadRes.ok) {
            const replies = threadRes.messages || [];
            for (const reply of replies) {
              if (reply.ts === msg.ts) continue; // Skip parent duplicate

              const replyTsNum = parseFloat(reply.ts);
              if (replyTsNum < oldestNum || replyTsNum > latestNum) continue;

              if (qualifies(reply, userId, filterSender, filterText, onlyAttachments) && !seenTs.has(reply.ts)) {
                seenTs.add(reply.ts);
                results.push({
                  ts: reply.ts,
                  user: reply.user,
                  text: reply.text || "",
                  time: new Date(replyTsNum * 1000).toLocaleString(),
                  isThreadReply: true,
                  parentTs: msg.ts,
                  files: reply.files || [],
                  attachments: reply.attachments || []
                });

                if (results.length >= MAX_SCAN_RESULTS) {
                  capped = true;
                  return { results, capped, moreAvailable: true };
                }
              }
            }
            threadCursor = threadRes.response_metadata?.next_cursor || "";
            threadHasMore = !!threadCursor;
          } else {
            break;
          }
        }
      }
    }

    cursor = res.response_metadata?.next_cursor || "";
    pageCount++;
    if (!cursor || pageCount >= maxPages) {
      continueScan = false;
    }
  }

  // moreAvailable === true means we stopped at the page cap while Slack still
  // had older messages we never examined (honest truncation signal for the UI).
  const moreAvailable = !!cursor && pageCount >= maxPages;
  return { results, capped, moreAvailable };
}

// Read a queued item's resolved action. The decision is made once at enqueue time
// via the shared decideItemAction() and persisted, so it is deterministic even
// after a service-worker restart. Defaults to a safe full delete if ever missing.
function itemAction(item) {
  if (item.action === "trim") return "trim";
  if (item.action === "skip") return "skip";
  return "delete";
}

// Shared 429 handler: back off honoring Retry-After, but stop retrying a single
// perpetually-throttled item after MAX_RATELIMIT_RETRIES and pause the job so it
// can't hang forever. The broadcast uses the SAME wait value the queue actually
// sleeps for, so the dashboard countdown stays in sync. Caller must `return` right
// after invoking this (the same item is retried after the backoff, or the job is
// paused). `job._rateLimitRetries` is reset once an item finally resolves.
function handleRateLimitBackoff(job, key, pauseTime, context) {
  job._rateLimitRetries = (job._rateLimitRetries || 0) + 1;
  if (job._rateLimitRetries > MAX_RATELIMIT_RETRIES) {
    sendLogMessage(job, `[Rate Limited] Slack is still throttling after ${MAX_RATELIMIT_RETRIES} retries. Pausing — reopen the dashboard to resume once throttling clears.`, "error");
    job.isPaused = true;
    clearScheduled(key);
    markRunning(key, false);
    saveJobState(key, job, true);
    broadcastJobUpdate(job);
    maybeClearWatchdog();
    return;
  }
  const waitSec = pauseTime + 1; // small buffer past Retry-After
  sendLogMessage(job, `[Rate Limited] ${context} Backing off ${waitSec}s (retry ${job._rateLimitRetries}/${MAX_RATELIMIT_RETRIES})...`, "warn");
  broadcastRateLimit(job, waitSec);
  scheduleNextStep(key, waitSec * 1000);
}

// Queue Loop execution handler
async function executeQueue(key) {
  // Acquire the reentrancy lock BEFORE any await (including recovery), so two
  // alarm/timeout paths can't both recover or process the same job.
  if (processingKeys.has(key)) return;
  processingKeys.add(key);

  try {
    let job = activeJobs[key];

    // Service worker state recovery after SW restart.
    if (!job) {
      await recoverAllJobs();
      job = activeJobs[key];
      if (!job) return; // Genuinely no job exists
      // Reached here via a recovery/rate-limit alarm after the SW was torn down.
      // Gate destructive resumption on the same browser-restart-safe signal.
      if (!(await isAutoResumeAllowed(key))) return;
    }

    if (!job.isRunning || job.isPaused) return;

    // Token recovery: if token was lost, attempt to recover from session storage
    if (!job.token) {
      try {
        const sessionData = await chrome.storage.session.get(`sc_token_${job.teamId}`);
        const sessionToken = sessionData[`sc_token_${job.teamId}`];
        if (sessionToken) {
          job.token = sessionToken;
          userTokens[job.teamId] = sessionToken;
        }
      } catch (e) { /* session storage unavailable */ }

      if (!job.token) {
        sendLogMessage(job, "[Fatal] Session token lost after service worker restart. Please re-open the dashboard to reconnect.", "error");
        job.isRunning = false;
        broadcastJobUpdate(job);
        markRunning(key, false);
        clearJobState(key);
        delete activeJobs[key];
        maybeClearWatchdog();
        return;
      }
    }

    if (job.deleteIndex >= job.deleteQueue.length) {
      job.isRunning = false;
      broadcastJobUpdate(job);
      sendLogMessage(job, "Bulk clean operation completed successfully.", "info");
      markRunning(key, false);
      clearJobState(key, job); // removes progress + queue; no final save needed
      delete activeJobs[key];
      maybeClearWatchdog();
      return;
    }

    const msg = job.deleteQueue[job.deleteIndex];
    const action = itemAction(msg);

    let response;
    if (action === "skip") {
      // Attachment-only mode, but this item has no attachment/file to clean.
      // Never delete it — mark processed and move on with no destructive call.
      response = { ok: true, skipped: true };
    } else {
      // Track whether every file object was actually removed. A message edit/delete
      // that "succeeds" while a file survives must NOT be counted as a clean success.
      let fileDeleteFailed = false;
      try {
        // Remove the message's underlying file objects FIRST, for EVERY item that
        // has files — attachment "trim"/"delete" AND a normal full delete alike.
        // Neither chat.delete nor chat.update purges an uploaded file from Slack's
        // file store, so without this a "delete my messages" run would leave the
        // files behind (still downloadable/searchable). Idempotent on retry.
        const files = msg.files || [];
        for (const file of files) {
          if (!file || !file.id) continue;

          // SAFETY: files.delete purges a file from Slack ENTIRELY — every channel
          // and DM it was shared into, not just this message. Before hard-deleting,
          // look up its live share count; if it lives in more than one place, leave
          // it intact so cleaning this conversation can't destroy content in another
          // (honoring the "current chat scope" promise). Only files that exist
          // solely here are removed.
          const infoRes = await slackAPICall(job.token, "files.info", { file: file.id });
          if (infoRes.error === "rate_limited") {
            handleRateLimitBackoff(job, key, infoRes.retryAfter || 15, `Throttled inspecting file ${file.id}.`);
            return; // do NOT advance deleteIndex — retry the same item
          }
          if (infoRes.ok && infoRes.file) {
            if (fileShareCount(infoRes.file) > 1) {
              // Shared elsewhere: preserve the file. For a full delete the message
              // still goes; for a trim the file reference stays (Slack offers no way
              // to detach a file from one message without deleting it everywhere).
              sendLogMessage(job, `File ${file.id} is shared in other conversations — left intact so cleaning this chat won't remove it elsewhere.`, "info");
              continue;
            }
          } else if (infoRes.error === "file_not_found" || infoRes.error === "file_deleted") {
            // Already gone — the "remove the file" goal is met; nothing to do.
            sendLogMessage(job, `File ${file.id} already removed from Slack.`, "info");
            continue;
          } else {
            // Couldn't verify shares (permission/transient error). Be conservative:
            // do NOT hard-delete a file whose blast radius is unknown. The message
            // op below still runs; worst case is a leftover file, never collateral loss.
            fileDeleteFailed = true;
            sendLogMessage(job, `Could not verify shares for file ${file.id} (${infoRes.error || "unknown"}); leaving it intact.`, "warn");
            continue;
          }

          const fileRes = await slackAPICall(job.token, "files.delete", { file: file.id });
          if (fileRes.ok || fileRes.error === "file_deleted" ||
              fileRes.error === "file_not_found" || fileRes.error === "already_deleted") {
            // Deleted now, or already gone (idempotent when an item is retried).
            sendLogMessage(job, `Removed file attachment ${file.id} from Slack.`, "info");
          } else if (fileRes.error === "rate_limited") {
            // files.delete has no retry of its own: back off and retry the WHOLE
            // item, so the file isn't silently orphaned while the message op runs.
            handleRateLimitBackoff(job, key, fileRes.retryAfter || 15, `Throttled deleting file ${file.id}.`);
            return; // do NOT advance deleteIndex — retry the same item
          } else {
            fileDeleteFailed = true;
            sendLogMessage(job, `Failed to delete file entry ${file.id}: ${fileRes.error || "unknown"}`, "warn");
          }
        }

        if (job.filterAttachments && fileDeleteFailed) {
          // Attachment-cleaning mode: a file could not be removed, so do NOT run
          // the message op. A full delete would destroy the message and orphan the
          // file; a trim would strip the file's reference while the file lingers.
          // Fail the item so BOTH message and file stay intact for a retry.
          // (A normal full delete falls through instead: removing the message is
          // the primary goal, and best-effort file cleanup already logged a warn.)
          response = { ok: false, error: "file_delete_failed" };
        } else if (action === "trim") {
          // Strip attachments/blocks while preserving text. NOTE: this flattens rich
          // block formatting to the plain-text fallback — "Only Delete Attachments"
          // guarantees text survival, not layout.
          response = await slackAPICall(job.token, "chat.update", {
            channel: job.channelId,
            ts: msg.ts,
            text: msg.text || "",
            attachments: JSON.stringify([]),
            blocks: JSON.stringify([])
          });
        } else {
          response = await slackAPICall(job.token, "chat.delete", {
            channel: job.channelId,
            ts: msg.ts,
            as_user: true
          });
        }
      } catch (err) {
        response = { ok: false, error: "catch_error", message: err.message };
      }
    }

    // The job may have been CANCELLED (activeJobs entry deleted) while we were
    // awaiting the API call above. If so, stop here — don't record stats, advance
    // the index, reschedule, or re-persist a job the user just cancelled.
    if (!activeJobs[key]) return;

    if (response.error === "rate_limited") {
      // Do NOT advance deleteIndex: retry the same item after the backoff (or pause
      // the job if it has been throttled too many times in a row).
      handleRateLimitBackoff(job, key, response.retryAfter || 15, "Slack API throttled.");
      return;
    }

    if (response.error === "token_revoked" || response.error === "not_authed" || response.error === "account_inactive") {
      sendLogMessage(job, `[Fatal Error] Slack Session Invalidation: ${response.error}. Halting queue.`, "error");
      job.isRunning = false;
      broadcastJobUpdate(job);
      markRunning(key, false);
      clearJobState(key);
      delete activeJobs[key];
      maybeClearWatchdog();
      return;
    }

    // Transient failure (network blip, or a JS exception in the fetch path):
    // retry the SAME item a few times with a short backoff before giving up, so
    // a momentary hiccup doesn't permanently skip messages the user asked to
    // delete. The counter is reset once the item is finally resolved (below).
    if (response.error === "network_error" || response.error === "catch_error") {
      job._transientRetries = (job._transientRetries || 0) + 1;
      if (job._transientRetries <= MAX_TRANSIENT_RETRIES) {
        sendLogMessage(job, `[Network] Transient error at ${msg.time} (attempt ${job._transientRetries}/${MAX_TRANSIENT_RETRIES}). Retrying...`, "warn");
        scheduleNextStep(key, TRANSIENT_RETRY_DELAY_MS);
        return; // do NOT advance — retry the same item
      }
      // Retries exhausted: fall through and count it as a failure.
      sendLogMessage(job, `[Network] Giving up on message at ${msg.time} after ${MAX_TRANSIENT_RETRIES} retries.`, "warn");
    }

    // Idempotency: an already-gone message is exactly the end state we wanted
    // (e.g. a mid-batch service-worker death re-processed it, or it was deleted
    // manually). Count it as success, not a failure — so recovery never inflates
    // the failure tally by re-deleting messages that are already gone.
    if (!response.ok && response.error === "message_not_found") {
      response = { ok: true, alreadyGone: true };
    }

    if (response.ok) {
      if (response.skipped) {
        job.stats.skipped = (job.stats.skipped || 0) + 1;
        sendLogMessage(job, `[Skipped] No attachment to clean at ${msg.time}`, "info");
      } else if (response.alreadyGone) {
        job.stats.success++;
        sendLogMessage(job, `[Success] Message at ${msg.time} was already removed.`, "info");
      } else {
        job.stats.success++;
        sendLogMessage(job, `[Success] Cleaned msg at ${msg.time}`);
      }
    } else {
      job.stats.fail++;
      sendLogMessage(job, `[Failed] Error cleaning msg at ${msg.time}: ${response.error || "unknown"}`, "error");
    }

    job._transientRetries = 0;  // item resolved — reset for the next one
    job._rateLimitRetries = 0;  // clear the per-item 429 streak counter too
    job.deleteIndex++;

    // Completed the last item: finalize NOW rather than waiting one more throttle
    // tick. Waiting left a ~throttleDelay window at 100% where a Pause would
    // cancel the pending completion tick and strand the job (never firing the
    // "finished" alert). Broadcasting isRunning:false here triggers it promptly.
    if (job.deleteIndex >= job.deleteQueue.length) {
      job.isRunning = false;
      broadcastJobUpdate(job);
      sendLogMessage(job, "Bulk clean operation completed successfully.", "info");
      markRunning(key, false);
      clearJobState(key, job); // removes progress + queue; no final save needed
      delete activeJobs[key];
      maybeClearWatchdog();
      return;
    }

    // Batch storage writes to prevent storage thrashing.
    if (job.deleteIndex % STORAGE_BATCH_INTERVAL === 0) {
      saveJobState(key, job);
    }

    broadcastJobUpdate(job);

    // Schedule next iteration. Skips make no API call, so they don't need the
    // per-message throttle — advance quickly instead of stalling the whole queue.
    scheduleNextStep(key, response.skipped ? 50 : job.throttleDelay);
  } finally {
    processingKeys.delete(key);
  }
}

// Scoped state sync broadcasts
function broadcastJobUpdate(job) {
  chrome.tabs.query({ url: "https://*.slack.com/*" }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: "JOB_UPDATE",
        job: {
          teamId: job.teamId,
          channelId: job.channelId,
          deleteIndex: job.deleteIndex,
          stats: job.stats,
          isRunning: job.isRunning,
          isPaused: job.isPaused,
          throttleDelay: job.throttleDelay,
          filterAttachments: job.filterAttachments
        }
      }, () => {
        void chrome.runtime.lastError; // Suppress unchecked error for closed tabs
      });
    });
  });
}

function broadcastRateLimit(job, pauseTime) {
  chrome.tabs.query({ url: "https://*.slack.com/*" }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: "JOB_RATELIMIT",
        channelId: job.channelId,
        pauseTime
      }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

function sendLogMessage(job, message, type = "info") {
  // Add severity prefix for accessibility (color-blind users)
  const prefixMap = { info: "[INFO]", warn: "[WARN]", error: "[ERROR]" };
  const prefix = prefixMap[type] || "[INFO]";
  const prefixedMessage = message.startsWith("[") ? message : `${prefix} ${message}`;
  chrome.tabs.query({ url: "https://*.slack.com/*" }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: "JOB_LOG",
        channelId: job.channelId,
        log: { message: prefixedMessage, type, timestamp: new Date().toLocaleTimeString() }
      }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

// Storage helpers (Token NOT persisted to disk for security).
//
// The (immutable) queue is written ONCE via saveJobQueue to a companion key;
// the light progress record is written frequently via saveJobState. This avoids
// re-serializing the whole queue on every batched save. Recovery reads both.
// With an ABSOLUTE deleteIndex, recovery resumes at the correct position.

async function saveJobQueue(job) {
  try {
    // `text` is retained ONLY for "trim" (preserve-text) items so that behavior
    // survives a service-worker restart; plain deletes and file entries stay
    // minimal. This array never changes after enqueue, so it's written just once.
    const persistedQueue = job.deleteQueue.map(msg => {
      const entry = {
        ts: msg.ts,
        user: msg.user,
        time: msg.time,
        isThreadReply: msg.isThreadReply,
        parentTs: msg.parentTs,
        action: (msg.action === "trim" || msg.action === "skip") ? msg.action : "delete",
        files: (msg.files || []).map(f => ({ id: f.id }))
      };
      if (entry.action === "trim") {
        entry.text = msg.text || "";
      }
      return entry;
    });
    await chrome.storage.local.set({ [queueKeyFor(job.teamId, job.channelId)]: persistedQueue });
  } catch (err) {
    console.error("SlackClean BG: Queue save failed", err);
  }
}

// forceImmediate retained for call-site compatibility; writes are already light.
async function saveJobState(key, job, forceImmediate = false) {
  try {
    await chrome.storage.local.set({
      [key]: {
        // Token intentionally NOT stored here — kept in chrome.storage.session only.
        // Queue lives in its companion key (see saveJobQueue).
        deleteIndex: job.deleteIndex,
        stats: job.stats,
        isRunning: job.isRunning,
        isPaused: job.isPaused,
        throttleDelay: job.throttleDelay,
        filterAttachments: job.filterAttachments,
        timestamp: Date.now()
      }
    });
  } catch (err) {
    console.error("SlackClean BG: State save failed", err);
  }
}

async function clearJobState(key, job) {
  try {
    const keysToRemove = [key];
    if (job) {
      keysToRemove.push(queueKeyFor(job.teamId, job.channelId));
    } else {
      // Derive the companion queue key from the job key when no job is passed:
      // slackclean_state_${teamId}_${channelId}
      const parts = key.split("_");
      if (parts.length >= 4) keysToRemove.push(queueKeyFor(parts[2], parts[3]));
    }
    await chrome.storage.local.remove(keysToRemove);
  } catch (err) {
    console.error("SlackClean BG: State clear failed", err);
  }
}
