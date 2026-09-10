// Erasechat - Background Service Worker

// Load shared filtering/safety logic (single source of truth).
// Chrome/Chromium MV3 (manifest.json): the background is a service worker, where
// importScripts IS available, so we load shared-filters.js here.
// Firefox MV3 (manifest.firefox.json): the background is an event page declared as
// `background.scripts: ["shared-filters.js", "background.js"]`, so shared-filters.js
// is already loaded before this file runs and importScripts is undefined — the guard
// below skips it. Chromium MV3 rejects `background.scripts`, which is why the two
// browsers ship different manifests (see the packaging note in CHANGELOG.md).
if (typeof importScripts === "function") {
  importScripts("shared-filters.js");
  importScripts("platforms/teams/teams-webrequest.js");
}

const MAX_SCAN_PAGES = 20;
const MAX_SCAN_RESULTS = 5000;
// Per-thread reply pagination cap. conversations.replies is cursor-paginated with
// no inherent bound, so a single pathological thread (tens of thousands of replies)
// could otherwise spin API calls indefinitely inside the scan — burning the team's
// rate limit and outliving the content script's own scan timeout, which leaves the
// worker still paginating after the user has been told the scan failed. 10 pages ×
// 200 replies covers any realistic thread; hitting the cap sets the same honest
// "not everything was examined" flag the history page cap uses.
const MAX_THREAD_PAGES = 10;
const THREAD_PAGE_LIMIT = 200;
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

// Auth/session errors: the Slack session backing the token is no longer valid at
// all, so every remaining item would fail identically until the user
// re-authenticates.
const AUTH_INVALID_ERRORS = new Set([
  "token_revoked", "not_authed", "account_inactive", "invalid_auth", "token_expired"
]);
// Structural/permission errors: not about the specific message (unlike a genuine
// per-item failure such as cant_delete_message), but about what the current
// token/channel/workspace can do at all — so the identical error recurs on every
// remaining item. Stopping immediately avoids burning through the whole queue
// failing one item at a time at full throttle pace before the user learns
// anything is wrong. Mirrors the equivalent "fail fast on auth failure" fix
// already applied to the non-Slack platforms (see CHANGELOG), closing the same
// gap in this core Slack engine.
const STRUCTURAL_JOB_ERRORS = new Set([
  "not_allowed_token_type", "missing_scope", "no_permission", "channel_not_found",
  "org_login_required", "ekm_access_denied", "compliance_exports_prevent_deletion"
]);

// Queue engine timing.
// Pacing under this bound uses setTimeout for accurate sub-30s throttling
// (chrome.alarms clamps to a ~30s floor, which is useless for per-message pacing).
// Longer waits (rate-limit backoff) use alarms so they survive SW termination.
const SETTIMEOUT_MAX_MS = 25000;
// Hard ceiling on a single Slack API request. Longer than any healthy call, short
// enough that a stalled request can't pin the queue's reentrancy lock indefinitely.
const FETCH_TIMEOUT_MS = 30000;
const WATCHDOG_ALARM = "slack_watchdog";
const WATCHDOG_PERIOD_MIN = 1.0; // 1.0m: the platform minimum (Chrome enforces >= 1 min)
const STALL_GRACE_MS = 60000;    // a job is "stalled" (SW died) only if this far past due

// Companion storage key holding a job's immutable delete queue. Kept separate
// from the (frequently-rewritten) progress record so batched progress saves
// don't re-serialize the whole queue. Prefix intentionally does NOT start with
// "slack_state_" so recoverAllJobs never mistakes it for a job record.
const QUEUE_PREFIX = "slack_q_";

let activeJobs = {}; // key: `slack_state_${teamId}_${channelId}` -> job state
let userTokens = {}; // key: `${teamId}` -> xoxc- token

// Scans currently sweeping Slack, keyed by `${teamId}_${channelId}`. A scan is
// read-only, but it is by far the most API-expensive operation here: up to
// MAX_SCAN_PAGES history pages plus a paginated conversations.replies sweep per
// thread, every call drawing on the same workspace rate limit. The dashboard gives
// up on a scan after its own client-side timeout and invites the user to try again,
// while this worker keeps paginating — so without a guard the retry (or an impatient
// double-click on Scan) starts a SECOND full sweep concurrently, doubling the API
// load that made the first one slow and pushing the workspace further into 429s.
// Memory-only on purpose: if the worker is torn down the scan really did stop, so a
// fresh request should be allowed through.
const inFlightScans = new Set();

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

chrome.runtime.onInstalled.addListener(async (details) => {
  await recoverAllJobs();

  // Extension update/reload safety (mirrors onStartup): an update tears down the SW
  // and clears chrome.storage.session, so the browser-restart-safe `sc_run_` flag is
  // gone and isAutoResumeAllowed() is now false. A job recovered as isRunning would
  // therefore never advance (every resume path is gated on that flag) yet still show
  // "running" and keep the 30s watchdog alive forever. Force any running job to paused
  // so it lands in the same recoverable, user-confirmed state as a browser restart.
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

  // Set first-run flag for onboarding
  if (details.reason === "install") {
    chrome.storage.local.set({ erasechat_onboarding_complete: false });
  } else if (details.reason === "update") {
    // Migrate the onboarding-seen flag from its pre-Erasechat-rename names (the
    // original "sc_onboarding_complete", and the six-platform expansion's
    // "slack_onboarding_complete" -- a naming leftover from when the onboarding
    // card was Slack-only). Without this, every user who already dismissed
    // onboarding under an old key sees the "Welcome to Erasechat!" card reappear
    // once after updating, since the new key reads as undefined/falsy -- the same
    // class of gap the job/queue key rename already gets a migration for in
    // recoverAllJobs().
    try {
      const legacy = await chrome.storage.local.get([
        "sc_onboarding_complete", "slack_onboarding_complete", "erasechat_onboarding_complete"
      ]);
      if (legacy.erasechat_onboarding_complete === undefined) {
        const inherited = legacy.slack_onboarding_complete !== undefined
          ? legacy.slack_onboarding_complete
          : legacy.sc_onboarding_complete;
        if (inherited !== undefined) {
          await chrome.storage.local.set({ erasechat_onboarding_complete: inherited });
        }
      }
      await chrome.storage.local.remove(["sc_onboarding_complete", "slack_onboarding_complete"]);
    } catch (e) {
      console.error("SlackClean BG: onboarding-flag migration failed", e);
    }

    // The watchdog alarm was renamed alongside it ("sc_watchdog" -> WATCHDOG_ALARM).
    // chrome.alarms persist across an update independent of source code, so a
    // pre-rename install's old-named alarm would otherwise fire forever -- it
    // matches neither branch in the onAlarm listener above, so nothing ever
    // cancels it once the code stops looking for that name.
    chrome.alarms.clear("sc_watchdog");
  }
});

// Save critical state before service worker termination.
//
// runtime.onSuspend is Chrome-only — Firefox has never implemented it. Reading
// `.addListener` off an undefined event throws a TypeError at load time, which in
// Firefox would abort this whole script BEFORE the onMessage router below is
// registered, leaving the extension completely inert (no scans, no deletes, and a
// popup that only ever reports "Setup Required"). Feature-detect instead of
// assuming. Nothing is lost on Firefox: every state transition already persists
// eagerly via saveJobState, so this listener is a best-effort extra flush.
if (chrome.runtime.onSuspend && typeof chrome.runtime.onSuspend.addListener === "function") {
  chrome.runtime.onSuspend.addListener(() => {
    for (const [key, job] of Object.entries(activeJobs)) {
      if (job.isRunning) {
        saveJobState(key, job, true);
      }
    }
  });
}

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

    // One-time migration for installs from before the "Bulk Clean for Slack" ->
    // "Erasechat" rename: the job/queue key prefixes changed (slackclean_state_ ->
    // slack_state_, sc_q_ -> slack_q_) but an in-place extension update keeps the
    // same extension ID and storage, so a paused/running job saved under the old
    // prefixes would otherwise silently vanish the first time this runs post-update
    // (recoverAllJobs only ever looked for the new prefix). Rewrite any legacy keys
    // to their new names before the recovery scan below runs.
    const LEGACY_STATE_PREFIX = "slackclean_state_";
    const LEGACY_QUEUE_PREFIX = "sc_q_";
    const legacyRewrites = {};
    const legacyRemove = [];
    for (const [key, val] of Object.entries(storage)) {
      let newKey = null;
      if (key.startsWith(LEGACY_STATE_PREFIX)) {
        newKey = "slack_state_" + key.slice(LEGACY_STATE_PREFIX.length);
      } else if (key.startsWith(LEGACY_QUEUE_PREFIX)) {
        newKey = "slack_q_" + key.slice(LEGACY_QUEUE_PREFIX.length);
      }
      if (newKey && !(newKey in storage)) {
        legacyRewrites[newKey] = val;
        storage[newKey] = val;
      }
      if (newKey) legacyRemove.push(key);
    }
    if (legacyRemove.length > 0) {
      try {
        if (Object.keys(legacyRewrites).length > 0) await chrome.storage.local.set(legacyRewrites);
        await chrome.storage.local.remove(legacyRemove);
      } catch (e) {
        console.error("SlackClean BG: legacy key migration failed", e);
      }
    }

    for (const [key, val] of Object.entries(storage)) {
      if (key.startsWith("slack_state_") && val) {
        // Never clobber a live in-memory job — storage is only a backup, and a
        // running job's state is always fresher than what's on disk.
        if (activeJobs[key]) continue;

        const parts = key.split("_");
        // key format: slack_state_${teamId}_${channelId}
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
            _timer: null,
            // Restore retry streaks across a SW restart (see saveJobState) so a
            // rate-limit/transient backoff that survives via chrome.alarms keeps
            // counting toward MAX_RATELIMIT_RETRIES/MAX_TRANSIENT_RETRIES instead
            // of silently starting back over at 0.
            _rateLimitRetries: val.rateLimitRetries || 0,
            _transientRetries: val.transientRetries || 0
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

  // Abort a black-holed request instead of hanging forever. Without this, a stalled
  // fetch never resolves, so executeQueue never returns, its `finally` never releases
  // the processingKeys lock, and the watchdog keeps skipping the job (it treats a
  // locked key as "already processing") — wedging that job until the SW is torn down.
  // An abort surfaces as network_error, which the queue already retries transiently.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

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
      body: bodyParams,
      signal: controller.signal
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
  } finally {
    clearTimeout(timeoutId);
  }
}

// API Fetch helper that retries on rate limits
async function slackAPICallWithRetry(token, endpoint, params = {}, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    const data = await slackAPICall(token, endpoint, params);
    if (data.ok) return data;

    if (data.error === "rate_limited") {
      const waitMs = ((data.retryAfter || 10) + 1) * 1000;
      // A scan holds no persisted, resumable state (unlike the delete queue,
      // which routes waits this long through chrome.alarms specifically
      // BECAUSE the service worker is expected to be torn down while they're
      // pending — see scheduleNextStep). An uncapped setTimeout wait here risks
      // the SW dying mid-wait with the whole in-flight RUN_SCAN response lost
      // silently (its sendResponse never fires). Fail fast with a clear error
      // instead of gambling on the worker surviving an arbitrarily long
      // Retry-After; the caller can simply re-scan.
      if (waitMs > SETTIMEOUT_MAX_MS) {
        return {
          ok: false,
          error: "rate_limited_too_long",
          message: `Slack asked to wait ${Math.round(waitMs / 1000)}s before retrying — too long to safely wait in the background. Try scanning again shortly.`
        };
      }
      await new Promise(resolve => setTimeout(resolve, waitMs));
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
    // Persist token in session storage (memory-only, cleared on browser close).
    // Awaited (not fire-and-forget) so a failed write is actually reported to the
    // caller instead of claiming success regardless — the in-memory cache above
    // still makes the token usable for the rest of THIS service-worker lifetime,
    // but only a persisted copy survives a SW idle-death, so the caller deserves
    // to know when that durability didn't actually happen.
    (async () => {
      try {
        await chrome.storage.session.set({ [`sc_token_${request.teamId}`]: request.token });
        sendResponse({ success: true });
      } catch (e) {
        // session storage unavailable/failed (older browsers, quota, etc.)
        sendResponse({ success: false, error: "session_storage_failed", message: e && e.message });
      }
    })();
    return true; // async response
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
    const key = `slack_state_${request.teamId}_${request.channelId}`;
    const respond = () => {
      const job = activeJobs[key];
      
      // otherJobs: every OTHER job in this same team, not just the first one found —
      // a user can have paused jobs in more than one other channel at once, and the
      // dashboard needs to be able to warn about all of them, not silently drop all
      // but the first. otherJob (singular, first match) is kept alongside for
      // backward compatibility with existing callers/tests.
      const otherJobs = [];
      for (const [, j] of Object.entries(activeJobs)) {
        if (j.teamId === request.teamId && j.channelId !== request.channelId) {
          otherJobs.push({ channelId: j.channelId, isPaused: j.isPaused, isRunning: j.isRunning });
        }
      }
      const otherJob = otherJobs.length > 0 ? otherJobs[0] : null;

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
          },
          otherJob,
          otherJobs
        });
      } else {
        sendResponse({ exists: false, otherJob, otherJobs });
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
    // Refuse a duplicate concurrent sweep of the same conversation (see inFlightScans).
    const scanKey = `${request.teamId}_${request.channelId}`;
    if (inFlightScans.has(scanKey)) {
      sendResponse({ ok: false, error: "scan_in_progress" });
      return false;
    }
    inFlightScans.add(scanKey);

    (async () => {
      let result;
      try {
        const token = await ensureToken(request.teamId);
        if (!token) {
          result = { ok: false, error: "not_authed", message: "Session token not found in background." };
        } else {
          const scan = await runScanInBg(token, request);
          result = {
            ok: true,
            results: scan.results,
            moreAvailable: scan.moreAvailable,
            capped: scan.capped
          };
        }
      } catch (err) {
        result = { ok: false, error: "scan_error", message: err.message };
      } finally {
        // Release the guard BEFORE answering, not in a trailing .finally(). A caller
        // may legitimately re-scan the moment it hears back — a truncated result asks
        // the user to narrow filters and scan again — and must not be refused by a
        // guard that is only cleared a microtask later. Releasing on the failure path
        // matters most: a leaked guard would make the channel permanently unscannable
        // until the worker is torn down.
        inFlightScans.delete(scanKey);
      }
      sendResponse(result);
    })();
    return true; // async response
  }

  else if (request.type === "START_DELETION") {
    const key = `slack_state_${request.teamId}_${request.channelId}`;
    // Refuse a second concurrent START_DELETION for the same channel (e.g. the same
    // conversation open in two tabs). Without this, the second message silently
    // replaces activeJobs[key] out from under the first job: executeQueue's identity
    // check correctly stops the superseded run rather than corrupting it, but the
    // first tab is left showing "Deleting…" forever with no error, and its remaining
    // items are simply abandoned. Mirrors the inFlightScans guard for RUN_SCAN.
    //
    // Also refuse when a PAUSED job already exists for this channel: accepting a
    // fresh queue here would silently overwrite activeJobs[key] and both of its
    // storage keys (saveJobQueue/saveJobState), discarding the paused job's
    // progress with no error ever surfaced to the caller. The paused job must be
    // explicitly resumed (RESUME_DELETION) or discarded (CANCEL_DELETION) first —
    // content.js's own resume/discard prompt already does this before ever
    // reaching this code path, so a legitimate caller is unaffected.
    if (activeJobs[key] && (activeJobs[key].isRunning || activeJobs[key].isPaused)) {
      const error = activeJobs[key].isRunning ? "job_already_running" : "job_already_paused";
      sendResponse({ success: false, error });
      return true;
    }

    ensureToken(request.teamId).then(async token => {
      if (!token) {
        sendResponse({ success: false, error: "not_authed" });
        return;
      }

      // Re-check after the async token fetch: another START_DELETION/PAUSE could
      // have landed while this one was awaiting ensureToken().
      if (activeJobs[key] && (activeJobs[key].isRunning || activeJobs[key].isPaused)) {
        const error = activeJobs[key].isRunning ? "job_already_running" : "job_already_paused";
        sendResponse({ success: false, error });
        return;
      }

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
      // The two writes target independent storage keys, so run them concurrently
      // instead of paying for two sequential chrome.storage.local round-trips.
      await Promise.all([
        saveJobQueue(activeJobs[key]),
        saveJobState(key, activeJobs[key])
      ]);
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
    const key = `slack_state_${request.teamId}_${request.channelId}`;
    (async () => {
      if (!activeJobs[key]) await recoverAllJobs();
      const job = activeJobs[key];
      if (job) {
        // isRunning=false alongside isPaused=true — matches every other pause
        // path (see the identical note in handleRateLimitBackoff) so a paused
        // job is never mistaken for a running one, e.g. by START_DELETION's
        // job_already_running vs. job_already_paused guard.
        job.isRunning = false;
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
    const key = `slack_state_${request.teamId}_${request.channelId}`;
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
    const key = `slack_state_${request.teamId}_${request.channelId}`;
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
  const { channelId, oldest, latest, includeThreads, filterSender, filterText, onlyAttachments, userId, invertText, excludePinned } = req;
  const qualifyOpts = { invertText: !!invertText, excludePinned: !!excludePinned };
  // Numeric bounds for the manual thread-reply time filter below. Coerce defensively:
  // a missing/empty `latest` must mean "no upper bound" (Infinity), not "" — because
  // `replyTsNum > ""` coerces to `> 0` and would drop every reply. Likewise oldest -> 0.
  // Coerce defensively. A missing/empty bound means "no bound" (0 / Infinity). A
  // genuinely non-numeric bound (parseFloat -> NaN) must ALSO fall back to no-bound,
  // not stay NaN: every comparison with NaN is false, which would drop all roots
  // (rootInWindow false) yet keep ALL thread replies (the `< NaN || > NaN` guard never
  // fires) — an inconsistent, partial selection. Normalize NaN to the open bound.
  let oldestNum = (oldest === undefined || oldest === null || oldest === "") ? 0 : parseFloat(oldest);
  let latestNum = (latest === undefined || latest === null || latest === "") ? Infinity : parseFloat(latest);
  if (Number.isNaN(oldestNum)) oldestNum = 0;
  if (Number.isNaN(latestNum)) latestNum = Infinity;

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
  const THREAD_LOOKBACK_SEC = 30 * 24 * 60 * 60; // 30 days
  const relaxLowerBound = includeThreads && oldestNum > 0;
  const lookbackCutoff = oldestNum - THREAD_LOOKBACK_SEC;
  const historyOldest = relaxLowerBound ? Math.max(0, lookbackCutoff) : oldest;
  // If the 30-day lookback itself got clamped short of the true beginning of history
  // (lookbackCutoff > 0), a thread whose root predates it is never fetched/expanded,
  // so an in-window reply hanging off it would be silently missed. That's a real,
  // if rare, incompleteness distinct from MAX_THREAD_PAGES/page-cap truncation, so it
  // must feed the same honest "not everything was examined" signal (see
  // threadsTruncated/moreAvailable below) rather than reporting a clean scan.
  const lookbackMayMissThreads = relaxLowerBound && lookbackCutoff > 0;

  // Track results, dedup, and rate limit pausing
  const results = [];
  const seenTs = new Set();
  let cursor = "";
  let pageCount = 0;
  // A custom date range (oldest > 0) implicitly accepts a longer scan; allow up to
  // 100 pages (10,000 roots) so the scan can complete rather than truncating early.
  const maxPages = (oldestNum > 0) ? 100 : MAX_SCAN_PAGES;
  let continueScan = true;
  let capped = false;
  // Set when a thread was deeper than MAX_THREAD_PAGES, or (see lookbackMayMissThreads
  // above) when a thread root could predate the 30-day lookback window, so replies in
  // it went unexamined. Folded into `moreAvailable` below — the UI already warns
  // honestly that older/deeper messages were NOT scanned.
  let threadsTruncated = lookbackMayMissThreads;

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

      if (rootInWindow && qualifies(msg, userId, filterSender, filterText, onlyAttachments, qualifyOpts) && !seenTs.has(msg.ts)) {
        seenTs.add(msg.ts);
        results.push({
          ts: msg.ts,
          user: msg.user,
          text: msg.text || "",
          time: new Date(parseFloat(msg.ts) * 1000).toLocaleString(),
          isThreadReply: false,
          files: msg.files || [],
          attachments: msg.attachments || [],
          blocks: msg.blocks || [],
          replyCount: msg.reply_count || 0
        });

        if (results.length >= MAX_SCAN_RESULTS) {
          capped = true;
          return { results, capped, moreAvailable: true };
        }
      }

      if (includeThreads && msg.thread_ts && msg.thread_ts === msg.ts) {
        let threadCursor = "";
        let threadHasMore = true;
        let threadPages = 0;

        while (threadHasMore) {
          const threadRes = await slackAPICallWithRetry(token, "conversations.replies", {
            channel: channelId,
            ts: msg.thread_ts,
            limit: THREAD_PAGE_LIMIT,
            cursor: threadCursor
          });

          if (threadRes && threadRes.ok) {
            const replies = threadRes.messages || [];
            for (const reply of replies) {
              if (reply.ts === msg.ts) continue; // Skip parent duplicate

              const replyTsNum = parseFloat(reply.ts);
              if (replyTsNum < oldestNum || replyTsNum > latestNum) continue;

              if (qualifies(reply, userId, filterSender, filterText, onlyAttachments, qualifyOpts) && !seenTs.has(reply.ts)) {
                seenTs.add(reply.ts);
                results.push({
                  ts: reply.ts,
                  user: reply.user,
                  text: reply.text || "",
                  time: new Date(replyTsNum * 1000).toLocaleString(),
                  isThreadReply: true,
                  parentTs: msg.ts,
                  files: reply.files || [],
                  attachments: reply.attachments || [],
                  blocks: reply.blocks || [],
                  replyCount: reply.reply_count || 0
                });

                if (results.length >= MAX_SCAN_RESULTS) {
                  capped = true;
                  return { results, capped, moreAvailable: true };
                }
              }
            }
            threadCursor = threadRes.response_metadata?.next_cursor || "";
            threadPages++;
            threadHasMore = !!threadCursor;
            if (threadHasMore && threadPages >= MAX_THREAD_PAGES) {
              // Deeper than we will page. Stop and remember that this thread was
              // only partially examined, so the UI can say so rather than implying
              // full coverage.
              threadsTruncated = true;
              threadHasMore = false;
            }
          } else {
            // The replies call itself failed (retries exhausted, or a Slack
            // error other than the cap above) -- this thread was only
            // partially examined, same as hitting MAX_THREAD_PAGES. Flag it so
            // moreAvailable reflects the real, incomplete coverage instead of
            // silently under-reporting matches from this thread.
            threadsTruncated = true;
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

  // moreAvailable === true means we stopped at a page cap while Slack still had
  // messages we never examined — either older history (the history page cap) or
  // deeper thread replies (MAX_THREAD_PAGES). Honest truncation signal for the UI.
  const moreAvailable = (!!cursor && pageCount >= maxPages) || threadsTruncated;
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
async function handleRateLimitBackoff(job, key, pauseTime, context) {
  // If the job was cancelled/replaced while an API call was in flight, do nothing —
  // otherwise the exceeded-retries branch below would saveJobState() and resurrect a
  // job the user just cancelled (its companion queue is already gone → a ghost record).
  if (activeJobs[key] !== job) return;
  job._rateLimitRetries = (job._rateLimitRetries || 0) + 1;
  if (job._rateLimitRetries > MAX_RATELIMIT_RETRIES) {
    sendLogMessage(job, t("bgLogRateLimitPaused", `[Rate Limited] Slack is still throttling after ${MAX_RATELIMIT_RETRIES} retries. Pausing — reopen the dashboard to resume once throttling clears.`, [String(MAX_RATELIMIT_RETRIES)]), "error");
    // isRunning=false alongside isPaused=true, matching every other pause path
    // (AUTH_INVALID_ERRORS/STRUCTURAL_JOB_ERRORS, token-lost, browser-restart
    // force-pause) — left inconsistent before, this mattered once START_DELETION
    // started checking isRunning to label its refusal (see job_already_paused).
    job.isRunning = false;
    job.isPaused = true;
    clearScheduled(key);
    markRunning(key, false);
    await saveJobState(key, job, true);
    broadcastJobUpdate(job);
    maybeClearWatchdog();
    return;
  }
  const waitSec = pauseTime + 1; // small buffer past Retry-After
  sendLogMessage(job, t("bgLogRateLimitBackoff", `[Rate Limited] ${context} Backing off ${waitSec}s (retry ${job._rateLimitRetries}/${MAX_RATELIMIT_RETRIES})...`, [String(context), String(waitSec), String(job._rateLimitRetries), String(MAX_RATELIMIT_RETRIES)]), "warn");
  broadcastRateLimit(job, waitSec);
  // Persist the bumped retry streak BEFORE scheduling the wait: a wait this long
  // routes through chrome.alarms (see scheduleNextStep), and the SW is expected to
  // be torn down while it's pending. Save first so a restart mid-wait recovers the
  // correct count (see recoverAllJobs) instead of resetting it to 0.
  await saveJobState(key, job, true);
  scheduleNextStep(key, waitSec * 1000);
}

// Shared pause-on-fatal-error path for AUTH_INVALID_ERRORS/STRUCTURAL_JOB_ERRORS:
// stop the job and preserve its queue/progress (never discard it) so the user
// can resume once the underlying session/permission/access problem is fixed.
async function pauseJobForFatalError(job, key, message) {
  sendLogMessage(job, message, "error");
  job.isRunning = false;
  job.isPaused = true;
  clearScheduled(key);
  markRunning(key, false);
  await saveJobState(key, job, true);
  broadcastJobUpdate(job);
  maybeClearWatchdog();
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
        // PAUSE (don't discard): preserve the queue + progress so re-opening the
        // dashboard (which re-sends the fresh session token via SET_SESSION) lets the
        // user resume exactly where it stopped. Deleting the job here would throw away
        // all remaining work and contradict the "re-open to reconnect" guidance.
        sendLogMessage(job, t("bgLogTokenLostPaused", "[Paused] Session token lost after a service-worker restart. Re-open the dashboard to reconnect, then resume."), "error");
        job.isRunning = false;
        job.isPaused = true;
        clearScheduled(key);
        markRunning(key, false);
        await saveJobState(key, job, true);
        broadcastJobUpdate(job);
        maybeClearWatchdog();
        return;
      }
    }

    if (job.deleteIndex >= job.deleteQueue.length) {
      job.isRunning = false;
      broadcastJobUpdate(job);
      if (job.deleteQueue.length === 0 && job.stats.total > 0) {
        sendLogMessage(job, t("bgLogQueueLost", "Error: The deletion queue was lost from storage. Please run a new scan."), "error");
      } else {
        sendLogMessage(job, t("bgLogCompletedSuccess", "Bulk clean operation completed successfully."), "info");
      }
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
      try {
        // Remove the message's underlying file objects FIRST, for EVERY item that
        // has files — attachment "trim"/"delete" AND a normal full delete alike.
        // Neither chat.delete nor chat.update purges an uploaded file from Slack's
        // file store, so without this a "delete my messages" run would leave the
        // files behind (still downloadable/searchable). Idempotent on retry.
        // [MODIFIED] files.delete has been entirely removed to prevent global collateral data loss
        // in unseen private channels. Only chat.delete and chat.update are used.
        // A trim operation will remove the file's visual presence from the message in this channel,
        // but the file itself will remain securely in Slack's workspace storage.

        if (action === "trim") {
          // Strip attachments/blocks while preserving text.
          let trimmedBlocks = [];
          if (msg.blocks && Array.isArray(msg.blocks)) {
             trimmedBlocks = msg.blocks.filter(b => b && b.type !== "image" && b.type !== "file");
          }
          response = await slackAPICall(job.token, "chat.update", {
            channel: job.channelId,
            ts: msg.ts,
            text: msg.text || "",
            attachments: JSON.stringify([]),
            blocks: trimmedBlocks.length > 0 ? JSON.stringify(trimmedBlocks) : JSON.stringify([])
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

    // The job may have been CANCELLED (activeJobs entry deleted) OR REPLACED by a
    // fresh START_DELETION for the same key while we were awaiting the API call above.
    // Compare object identity, not mere presence: if the key now holds a different
    // job object, this stale execution must not record stats, advance the index,
    // reschedule, or (via the finalize block) clear the brand-new job's state.
    if (activeJobs[key] !== job) return;

    if (response.error === "rate_limited") {
      // Do NOT advance deleteIndex: retry the same item after the backoff (or pause
      // the job if it has been throttled too many times in a row).
      await handleRateLimitBackoff(job, key, response.retryAfter || 15, "Slack API throttled.");
      return;
    }

    if (AUTH_INVALID_ERRORS.has(response.error) || STRUCTURAL_JOB_ERRORS.has(response.error)) {
      // Session invalidated OR a structural/permission error (see
      // STRUCTURAL_JOB_ERRORS above) — either way, the same failure will recur
      // on every remaining item, so continuing would just burn through the
      // whole queue failing one at a time at full throttle pace instead of
      // telling the user what's actually wrong. PAUSE and preserve the
      // queue/progress rather than discarding it: the job can resume once the
      // session/permission/access problem is fixed and the dashboard reopened.
      // Distinct locale keys/wording per error class: AUTH_INVALID_ERRORS really
      // is an invalid/expired session, but STRUCTURAL_JOB_ERRORS (missing_scope,
      // channel_not_found, etc.) is not — reusing "session invalid" wording for
      // those would misdiagnose the problem.
      const message = AUTH_INVALID_ERRORS.has(response.error)
        ? t("bgLogSessionInvalidPaused", `[Paused] Slack session invalid (${response.error}). Re-log in to Slack, re-open the dashboard, then resume.`, [String(response.error)])
        : t("bgLogJobPausedFatalError", `[Paused] Slack rejected this operation (${response.error}) and it will recur on every remaining item. Check your permissions/channel access, re-open the dashboard, then resume.`, [String(response.error)]);
      await pauseJobForFatalError(job, key, message);
      return;
    }

    // Transient failure (network blip, a JS exception in the fetch path, or an
    // attachment-mode item whose file op failed transiently): retry the SAME item a
    // few times with a short backoff before giving up, so a momentary hiccup doesn't
    // permanently skip messages/attachments the user asked to remove. `file_delete_failed`
    // is included because in attachment mode a single files.info/files.delete network
    // blip aborts the item (correctly, to never orphan a file) — but that abort must
    // be RETRIED like any other transient error, not counted as a permanent failure on
    // the first blip. The counter is reset once the item is finally resolved (below).
    if (response.error === "network_error" || response.error === "catch_error" || response.error === "file_delete_failed") {
      job._transientRetries = (job._transientRetries || 0) + 1;
      if (job._transientRetries <= MAX_TRANSIENT_RETRIES) {
        sendLogMessage(job, t("bgLogTransientRetry", `[Network] Transient error at ${msg.time} (attempt ${job._transientRetries}/${MAX_TRANSIENT_RETRIES}). Retrying...`, [String(msg.time), String(job._transientRetries), String(MAX_TRANSIENT_RETRIES)]), "warn");
        // Persist the bumped streak before retrying (see handleRateLimitBackoff's
        // identical reasoning) so a SW restart mid-retry recovers the correct
        // count instead of resetting it to 0 and letting a permanently-failing
        // item retry forever across restarts.
        await saveJobState(key, job, true);
        scheduleNextStep(key, TRANSIENT_RETRY_DELAY_MS);
        return; // do NOT advance — retry the same item
      }
      // Retries exhausted: fall through and count it as a failure.
      sendLogMessage(job, t("bgLogTransientGiveUp", `[Network] Giving up on message at ${msg.time} after ${MAX_TRANSIENT_RETRIES} retries.`, [String(msg.time), String(MAX_TRANSIENT_RETRIES)]), "warn");
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
        sendLogMessage(job, t("bgLogSkippedNoAttachment", `[Skipped] No attachment to clean at ${msg.time}`, [String(msg.time)]), "info");
      } else if (response.alreadyGone) {
        job.stats.success++;
        sendLogMessage(job, t("bgLogAlreadyRemoved", `[Success] Message at ${msg.time} was already removed.`, [String(msg.time)]), "info");
      } else {
        job.stats.success++;
        sendLogMessage(job, t("bgLogCleaned", `[Success] Cleaned msg at ${msg.time}`, [String(msg.time)]));
      }
    } else {
      job.stats.fail++;
      sendLogMessage(job, t("bgLogCleanFailed", `[Failed] Error cleaning msg at ${msg.time}: ${response.error || "unknown"}`, [String(msg.time), String(response.error || "unknown")]), "error");
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
      sendLogMessage(job, t("bgLogCompletedSuccess", "Bulk clean operation completed successfully."), "info");
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
        teamId: job.teamId,
        channelId: job.channelId,
        pauseTime
      }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

// Same pattern as content.js/popup.js's own t(): localized text is used when
// available, English is the fallback -- never a blank/undefined log line.
function t(key, fallback, substitutions) {
  try {
    const m = chrome.i18n.getMessage(key, substitutions);
    if (m) return m;
  } catch (e) { /* i18n unavailable */ }
  return fallback !== undefined ? fallback : key;
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
        teamId: job.teamId,
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
        entry.blocks = msg.blocks || [];
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
        // Per-item retry streaks. Persisted (not just kept in memory) because a
        // long rate-limit backoff deliberately routes through chrome.alarms
        // (see scheduleNextStep) specifically because the service worker is
        // expected to be torn down while such a wait is pending. Without this,
        // recoverAllJobs would restore the job with these counters reset to 0,
        // silently defeating MAX_RATELIMIT_RETRIES/MAX_TRANSIENT_RETRIES and
        // letting a perpetually-throttled/failing item retry forever across
        // repeated SW restarts.
        rateLimitRetries: job._rateLimitRetries || 0,
        transientRetries: job._transientRetries || 0,
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
      // slack_state_${teamId}_${channelId}
      const parts = key.split("_");
      if (parts.length >= 4) keysToRemove.push(queueKeyFor(parts[2], parts[3]));
    }
    await chrome.storage.local.remove(keysToRemove);
  } catch (err) {
    console.error("SlackClean BG: State clear failed", err);
  }
}
