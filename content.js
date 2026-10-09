// Erasechat - Content Script Logic Engine (Fortified Production Edition)

// Pure predicate, kept at module scope (outside the IIFE below) so it's unit-
// testable without a DOM: does a background broadcast belong to THIS tab's
// currently active channel/workspace?
//
// Broadcasts (JOB_UPDATE/JOB_RATELIMIT/JOB_LOG) go to every Slack tab regardless
// of workspace, so channelId alone isn't enough to identify "this tab's job" --
// Slack channel IDs are workspace-scoped, incrementing identifiers, not globally
// random, so two independently-created workspaces could plausibly share one
// (e.g. an early #general). teamId must match too, or a job update meant for an
// unrelated workspace's same-named channel ID could otherwise flip this tab's UI
// into "running"/"finished" state and wipe its own pending scan results out from
// under the user.
function matchesActiveWorkspaceChannel(reqChannelId, reqTeamId, activeChannel, activeTeam) {
  return !!(activeChannel && activeTeam && reqChannelId === activeChannel.id && reqTeamId === activeTeam.id);
}

// ADVISORY-ONLY mirror of shared-filters.js's isSafeRegex(), for one purpose only:
// warning the user, before a scan runs, that their Text Match pattern will be
// silently downgraded to a literal substring search. It is NEVER used to decide
// what gets scanned or deleted — that decision is made exclusively by the real
// isSafeRegex()/qualifies() in shared-filters.js, loaded only into the background
// worker (per manifest.json), which content.js has no way to import directly without
// a manifest change (out of scope here). Worst case if this drifts out of sync with
// the real check: a wrong or missing warning banner, never a wrong delete — the
// safety-critical gate is untouched by this file. This copy is asserted against the
// real isSafeRegex() across a shared pattern battery in tests/content.test.js, so any
// future edit to one without the other fails CI rather than silently drifting.
// KEEP THIS IN SYNC WITH shared-filters.js's isSafeRegex() / its constants.
const PREVIEW_MAX_REGEX_PATTERN_LENGTH = 100;
const PREVIEW_MAX_QUANTIFIERS = 10;
const PREVIEW_MAX_UNBOUNDED_QUANTIFIERS = 2;

function isSafeRegexPreview(pattern) {
  // shared-filters.js is loaded ahead of this file in the Slack content script
  // (see the manifests), so the preview uses the worker's exact check and can't
  // drift from it. The copy below only runs where that global is absent (Node tests).
  if (typeof isSafeRegex === "function") return isSafeRegex(pattern);
  if (pattern.length > PREVIEW_MAX_REGEX_PATTERN_LENGTH) return false;
  if (/[+*?]{2,}/.test(pattern)) return false;
  if (/\([^)]*[+*]\)[+*?{]/.test(pattern)) return false;
  if (/\([^()]*[+*][^()]*\)[^(]*\)[+*?{]/.test(pattern)) return false;
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern)) return false;
  if (/\([^)]*\{[^}]+\}[^)]*\)[+*{]/.test(pattern)) return false;
  if (/\([^)]*\\[0-9]+[^)]*\)[+*]/.test(pattern)) return false;

  const quantifiers = (pattern.match(/(?<!\\)[*+?{]/g) || []).length;
  if (quantifiers > PREVIEW_MAX_QUANTIFIERS) return false;

  const unbounded = (pattern.match(/(?<!\\)[*+]/g) || []).length
                  + (pattern.match(/(?<!\\)\{\d*,\}/g) || []).length;
  if (unbounded > PREVIEW_MAX_UNBOUNDED_QUANTIFIERS) return false;

  if (/(?<!\\)[*+].{0,3}(?<!\\)[*+]/.test(pattern)) return false;

  return true;
}

// Returns null (pattern is fine, or textFilter isn't a /regex/) or a reason string
// ("unsafe" | "invalid") describing why the background worker's real isSafeRegex()
// is expected to reject this pattern and fall back to a literal substring match.
function checkTextFilterPattern(textFilter) {
  const keyword = (textFilter || "").toLowerCase();
  if (!(keyword.startsWith("/") && keyword.endsWith("/") && keyword.length > 2)) {
    return null;
  }
  const pattern = textFilter.substring(1, textFilter.length - 1);
  if (!isSafeRegexPreview(pattern)) return "unsafe";
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    return "invalid";
  }
  return null;
}

// Pure: computes the [oldest, latest] Unix-timestamp scan window from the filter
// panel's raw date-mode inputs. Kept at module scope (unlike readFilterFormState,
// which stays DOM-coupled) so this arithmetic — the actual "how much history gets
// swept" decision — is unit-tested directly (tests/content.test.js) instead of only
// via manual QA, matching the audit finding that runScan's own inline version of
// this had zero coverage.
//
// Returns { ok: true, oldest, latest } or { ok: false, error: "incomplete" | "invalid" }
// -- runScan is responsible for turning that error into the right log line/alert;
// this function never touches the DOM or i18n.
function computeScanTimeRange(filterDate, { days, startVal, endVal } = {}, nowSec) {
  const now = nowSec !== undefined ? nowSec : Math.floor(Date.now() / 1000);
  let oldest = 0;
  let latest = now;

  if (filterDate === "older_than") {
    const parsedDays = parseInt(days || "30", 10);
    latest = Math.floor(now - parsedDays * 24 * 60 * 60);
    return { ok: true, oldest, latest };
  }

  if (filterDate === "custom") {
    // Both bounds are REQUIRED for a custom range. A blank field silently falling
    // back to oldest=0/latest=now would quietly cover ALL history -- and the
    // confirm dialog only shows a count, never the date range, so the user could
    // delete far more than intended.
    if (!startVal || !endVal) {
      return { ok: false, error: "incomplete" };
    }

    // Parse both bounds in the SAME (local) frame. A bare "YYYY-MM-DD" is parsed
    // as UTC midnight, while "YYYY-MM-DDTHH:MM:SS" is parsed as local time --
    // mixing them skews the window by the UTC offset and can delete messages
    // outside the range the user picked. Anchor start to local midnight.
    const oldestTs = Math.floor(new Date(startVal + "T00:00:00").getTime() / 1000);
    const latestTs = Math.floor(new Date(endVal + "T23:59:59").getTime() / 1000);

    if (oldestTs > latestTs) {
      return { ok: false, error: "invalid" };
    }
    return { ok: true, oldest: oldestTs, latest: latestTs };
  }

  return { ok: true, oldest, latest };
}

// Pure: builds the CSV content string for "Export Messages as CSV", including the
// formula-injection defense (a cell starting with = + - @ is prefixed with a quote
// so Excel/Sheets renders it as text rather than evaluating it) -- security-relevant
// and, before this extraction, only ever exercised by manually clicking Export.
function csvSafe(value) {
  let s = String(value == null ? "" : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s.replace(/"/g, '""').replace(/[\r\n]+/g, " ");
}

function buildMessagesCsv(scanResults, userCache) {
  const csvHeader = "Timestamp,User,Text,ThreadReply,Time,Attachments\n";
  const csvRows = scanResults.map(msg => {
    const text = csvSafe(msg.text || "");
    const user = csvSafe((userCache && userCache[msg.user]) || msg.user || "");
    const fileCount = (msg.files || []).length;
    return `"${csvSafe(msg.ts)}","${user}","${text}","${msg.isThreadReply ? "Yes" : "No"}","${csvSafe(msg.time)}","${fileCount}"`;
  }).join("\n");
  return csvHeader + csvRows;
}

// Pure: given the raw (string) data-idx values from every CHECKED result checkbox
// and the CURRENT scanResults array, returns the messages to actually enqueue for
// deletion -- silently dropping any index that's out of bounds or no longer
// resolves to a real entry. This is the SC-BUG-03 stale-index guard: scanResults
// can be modified/replaced between a scan finishing and the user clicking Delete,
// so a checkbox's index must be re-validated against the array it's about to index
// into, not trusted as still valid.
function buildDeleteQueueFromIndices(rawIndices, scanResults) {
  const queue = [];
  for (const raw of rawIndices) {
    const idx = parseInt(raw, 10);
    if (idx >= 0 && idx < scanResults.length && scanResults[idx]) {
      queue.push(scanResults[idx]);
    }
  }
  return queue;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    matchesActiveWorkspaceChannel,
    isSafeRegexPreview,
    checkTextFilterPattern,
    computeScanTimeRange,
    csvSafe,
    buildMessagesCsv,
    buildDeleteQueueFromIndices
  };
}

if (!window.slackCleanInitialized) {
  window.slackCleanInitialized = true;

  (function() {
    let activeTeam = null;
    let activeChannel = null; // { id, name, type }
    let userCache = {};
    let scanResults = [];
    let deleteQueue = [];
    let deleteIndex = 0;
    let stats = { success: 0, fail: 0, total: 0 };
    let isRunning = false;
    let localCancelPending = false; // see sendJobControl
    let scanTimedOutKey = null; // team_channel whose last scan hit SCAN_TIMEOUT_MS
    let isPaused = false;
    let throttleDelay = 1000; // ms between deletions
    let urlObserverInterval = null; // URL change polling interval ID
    // Channel the current deleteQueue was built against. The queue is dispatched
    // later (after a non-blocking confirm modal), by which point the user may have
    // navigated to another conversation — so we pin the queue to its origin channel
    // and refuse to dispatch it against a different one (drift/data-loss guard).
    let queueChannelId = null;
    // The channel a scan's results actually belong to (the channel the scan RAN in),
    // and the channel the dashboard currently intends to target. `activeChannel` is
    // only reassigned AFTER an await in loadActiveChannel, so during a channel switch
    // it lags; `intendedChannelId` flips synchronously the instant a switch starts.
    // Together they close the race where a scan started in channel A finishes just as
    // the user switches to channel B: the stale results are discarded (they don't
    // match the intended target) instead of being shown/armed against B.
    let scanResultsChannelId = null;
    let intendedChannelId = null;
    // Same pinning, but for the WORKSPACE (team) a queue/scan belongs to. Channel
    // IDs are workspace-scoped, incrementing identifiers, not globally random, so
    // two independently-created workspaces could plausibly share one (e.g. an
    // early #general) -- channel-only guards can't tell those apart. `activeTeam`
    // is reassigned SYNCHRONOUSLY the instant a workspace switch is detected
    // (unlike activeChannel, which lags behind an await), so `intendedTeamId` is
    // set at the very same moment for symmetry with the channel-side variables.
    let queueTeamId = null;
    let scanResultsTeamId = null;
    let intendedTeamId = null;
    // Guards the one-time "Erasechat Finished" completion alert against a
    // redundant final JOB_UPDATE re-firing it. Reset when a new job starts.
    let jobFinalized = false;
    // Channel IDs we've already shown the "Paused Job in Another Channel" alert for
    // during this dashboard session — see checkAndResumeState.
    const alertedOtherJobChannels = new Set();
    // Bumped on every renderScanResults() call. The chunked (requestAnimationFrame)
    // render loop checks it so a second scan cancels a still-running render from
    // the previous one (otherwise the stale loop keeps appending cards indexed
    // into the NEW scanResults, duplicating/misaligning the list).
    let renderGeneration = 0;
    // True while the chunked render is still adding cards. Guards the delete
    // button from being enabled (by a checkbox toggle) before every card exists.
    let isRendering = false;

    // Named constants (SC-CODE-01)
    const CONSOLE_LOG_MAX_LINES = 200;
    const RENDER_CHUNK_SIZE = 50;
    const USER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const URL_POLL_INTERVAL_MS = 1000;
    const MIN_THROTTLE_DELAY_MS = 1000;
    const LARGE_DELETE_THRESHOLD = 100;
    // Circumference of the progress ring (r=40): 2πr. Exact value (was hardcoded 251.2).
    const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 40;
    // Client-side safety net for a scan whose background response never arrives (e.g.
    // the service worker is suspended mid-scan). Without it the scan button and inputs
    // stay disabled on "Scanning..." forever. Generous, since a throttled scan is slow;
    // an abandoned scan is read-only, so a false timeout just means the user re-scans.
    const SCAN_TIMEOUT_MS = 120000;
    // While another scan of this conversation (with different filters) is still
    // running in the worker, re-ask this often instead of failing the new one.
    const SCAN_BUSY_RETRY_MS = 5000;
    // Bumped by every runScan(). A late response (one that arrives after the
    // client-side timeout) is still applied, but only if no newer scan started.
    let scanGeneration = 0;
    // users.list is Slack Tier 2 (~20 req/min). 5 pages × 1000 = up to 5,000
    // member names cached at init — a balance between coverage and startup latency.
    const MAX_USER_CACHE_PAGES = 5;
    // Saved filter presets are a convenience list, not a database — cap it so a
    // "Save Current" habit can't grow chrome.storage.local without bound.
    const MAX_FILTER_PRESETS = 20;
    const FILTER_PRESETS_STORAGE_KEY = "erasechatFilterPresets";

    // UI Shadow DOM and Element Cache references
    let shadowHost = null;
    let shadowRoot = null;
    let dashboardEl = null;
    let ui = {};

    let rateLimitInterval = null;

    // i18n helpers. Translations are applied over the English already baked into
    // the injected markup, so a missing key (or a browser without chrome.i18n)
    // simply keeps the English — never a blank label.
    function t(key, fallback, substitutions) {
      try {
        const m = chrome.i18n.getMessage(key, substitutions);
        if (m) return m;
      } catch (e) { /* i18n unavailable */ }
      return fallback !== undefined ? fallback : key;
    }

    function localizeI18n(root) {
      try {
        root.querySelectorAll("[data-i18n]").forEach((el) => {
          const m = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
          if (m) el.textContent = m;
        });
        root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
          const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-ph"));
          if (m) el.setAttribute("placeholder", m);
        });
        root.querySelectorAll("[data-i18n-title]").forEach((el) => {
          const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
          if (m) el.setAttribute("title", m);
        });
        root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
          const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
          if (m) el.setAttribute("aria-label", m);
        });
      } catch (e) { /* i18n unavailable */ }
    }

    // Initialize messaging listener from popup and background service worker
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === "GET_WORKSPACE_INFO") {
        const info = getActiveTeamInfo();
        if (info) {
          // Mirror handleUrlChange's drift protection: a job that is running or
          // paused is bound to activeTeam, and every operation (Pause/Resume/
          // Cancel) keys off that variable. GET_WORKSPACE_INFO is polled by the
          // popup on every open purely to display a label — it must not silently
          // rebind activeTeam to whatever workspace the tab's URL currently shows,
          // or a Pause/Resume/Cancel click right after would target the wrong
          // workspace's job while the real one keeps running unseen. Only adopt
          // the freshly-read team when nothing is pinned, or it's the same team.
          const pinned = (isRunning || isPaused) && activeTeam;
          if (!pinned || !info.team || info.team.id === activeTeam.id) {
            activeTeam = info.team;
            // Send token securely to background for memory caching
            chrome.runtime.sendMessage({
              type: "SET_SESSION",
              teamId: activeTeam.id,
              token: activeTeam.token
            });
          }
          sendResponse({ workspaceName: info.team.name });
        } else {
          sendResponse({ workspaceName: t("dashSlackWebClient", "Slack Web Client") });
        }
      } else if (request.type === "LAUNCH_DASHBOARD") {
        initDashboard();
        sendResponse({ success: true });
      } else if (request.type === "JOB_UPDATE") {
        if (matchesActiveWorkspaceChannel(request.job.channelId, request.job.teamId, activeChannel, activeTeam)) {
          // background.js's convention sets isRunning=false alongside isPaused=true
          // on every pause path (manual, drift-guard, rate-limit, auth-error -- see
          // its PAUSE_DELETION handler). content.js's own convention is different:
          // isRunning stays true while paused, with isPaused as the sub-state that
          // syncButtonStates()/toggleInputs()/handleUrlChange's drift guard all key
          // off to distinguish "actively running" from "paused but still bound".
          // Translate at the boundary instead of copying background's flag as-is --
          // otherwise a paused job gets locally mislabeled as "no job" (button shows
          // "Start Deleting", inputs re-enable, workspace drift guard stands down).
          const wasRunning = isRunning;
          const wasPaused = isPaused;
          isRunning = request.job.isRunning || request.job.isPaused;
          isPaused = request.job.isPaused;
          deleteIndex = request.job.deleteIndex;
          stats = request.job.stats;
          throttleDelay = request.job.throttleDelay;

          // A paused job isn't waiting on Slack's rate limit any more.
          if (isPaused) {
            clearRateLimitCountdown();
            if (!wasPaused && ui.consoleStatus) ui.consoleStatus.innerText = t("dashStatusPaused", "Paused");
            if (!wasPaused) announce(t("srJobPaused", "Deletion paused."));
          }

          updateProgressUI();
          syncButtonStates();
          toggleInputs(isRunning);

          const skipped = stats.skipped || 0;
          const partial = stats.partial || 0;
          if (!jobFinalized && !isRunning && stats.success + stats.fail + skipped + partial >= stats.total && stats.total > 0) {
            jobFinalized = true;
            // Report skips honestly — a skipped item ("attachment-only" mode with
            // nothing to clean) was NOT deleted, so it must not be counted under
            // "Successfully deleted".
            let summary = t("modalFinishedSummary", `Bulk deletion process completed.\n\nSuccessfully deleted: ${stats.success}\nFailed: ${stats.fail}`, [String(stats.success), String(stats.fail)]);
            if (skipped > 0) summary += t("modalFinishedSkipped", `\nSkipped (nothing to clean): ${skipped}`, [String(skipped)]);
            if (partial > 0) summary += t("modalFinishedPartial", `\nPartially cleaned (uploaded files still attached): ${partial}`, [String(partial)]);
            showCustomAlert(t("modalFinishedTitle", "Erasechat Finished"), summary);
            announce(t("srJobFinished", `Deletion finished. ${stats.success} deleted, ${stats.fail} failed.`, [String(stats.success), String(stats.fail)]));
            stopOperations(t("dashStatusFinished", "Finished"));
            // Clear the now-deleted messages from the preview so the user can't
            // re-run a delete against stale results (which would all fail as
            // message_not_found).
            resetScanResultsUI();
            resyncTargetToUrl();
          } else if (wasRunning && !isRunning && !jobFinalized && !localCancelPending) {
            // Ended without completing: cancelled from another tab, or the worker
            // lost the queue. Don't leave "Deleting..." and a stale ring behind.
            logConsole(t("logJobStoppedElsewhere", "The deletion job was stopped outside this tab (cancelled elsewhere, or its queue was lost)."), "warn");
            announce(t("srJobStopped", "Deletion stopped."));
            stopOperations(t("dashStatusStopped", "Stopped"));
            resetScanResultsUI();
            resyncTargetToUrl();
          }
        }
      } else if (request.type === "JOB_RATELIMIT") {
        if (!isPaused && matchesActiveWorkspaceChannel(request.channelId, request.teamId, activeChannel, activeTeam)) {
          startClientRateLimitCountdown(request.pauseTime);
        }
      } else if (request.type === "JOB_LOG") {
        if (matchesActiveWorkspaceChannel(request.channelId, request.teamId, activeChannel, activeTeam)) {
          logConsole(request.log.message, request.log.type);
        }
      }
      // All responses above are synchronous; no open channel needed.
      return false;
    });

    function startClientRateLimitCountdown(pauseTime) {
      let countdown = pauseTime;
      const label = (n) => t("dashRateLimitedCountdown", `Rate Limited (${n}s)`, [String(n)]);
      if (ui.consoleStatus) ui.consoleStatus.innerText = label(countdown);

      if (rateLimitInterval) clearInterval(rateLimitInterval);

      rateLimitInterval = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
          clearInterval(rateLimitInterval);
          rateLimitInterval = null;
          if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashDeleting", "Deleting...");
        } else {
          if (ui.consoleStatus) ui.consoleStatus.innerText = label(countdown);
        }
      }, 1000);
    }

    // Stops the rate-limit countdown (pause/stop) so it can't keep ticking and
    // then overwrite the status with "Deleting..." while nothing is deleting.
    function clearRateLimitCountdown() {
      if (rateLimitInterval) {
        clearInterval(rateLimitInterval);
        rateLimitInterval = null;
      }
    }

    // Polite screen-reader summary (start/finish/pause/cancel). The execution
    // console itself is aria-live="off" so per-item log lines don't flood AT.
    function announce(message) {
      const region = shadowRoot && shadowRoot.getElementById("sc-status-live");
      if (!region) return;
      region.textContent = "";
      // Re-set on the next tick so repeating the same text is still announced.
      setTimeout(() => { region.textContent = message; }, 50);
    }

    function syncButtonStates() {
      const delBtn = ui.btnDelete;
      if (delBtn) {
        if (isRunning) {
          if (isPaused) {
            delBtn.innerText = t("dashResumeDeleting", "Resume Deleting");
            delBtn.className = "dashboard-btn btn-delete";
          } else {
            delBtn.innerText = t("dashPauseDeleting", "Pause Deleting");
            delBtn.className = "dashboard-btn btn-delete danger";
          }
        } else {
          delBtn.innerText = t("dashStartDeleting", "Start Deleting");
          delBtn.className = "dashboard-btn btn-delete";
        }
      }
      
      const cancelBtn = shadowRoot.getElementById("sc-btn-cancel");
      if (cancelBtn) {
        if (isRunning) {
          cancelBtn.classList.remove("hidden");
        } else {
          cancelBtn.classList.add("hidden");
        }
      }
    }

    // Extract token, active workspace details, and active channel from Slack URL/Storage
    function getActiveTeamInfo() {
      try {
        const configStr = localStorage.getItem("localConfig_v2");
        if (!configStr) return null;
        const config = JSON.parse(configStr);
        const teams = config.teams;
        if (!teams || Object.keys(teams).length === 0) return null;

        const path = window.location.pathname;

        // Parse the team and conversation from the URL. Handle the modern unified
        // client (/client/TEAM[/CHANNEL]) as well as legacy workspace-domain
        // routes (/messages/CHANNEL, /archives/CHANNEL). The channel segment is
        // optional so the workspace still resolves when no conversation is open.
        let teamSeg = null;
        let channelSeg = null;
        const clientMatch = path.match(/\/client\/([A-Z0-9]+)(?:\/([A-Z0-9]+))?/i);
        if (clientMatch) {
          teamSeg = clientMatch[1];
          channelSeg = clientMatch[2] || null;
        }
        if (!channelSeg) {
          const legacyMatch = path.match(/\/(?:messages|archives)\/([A-Z0-9]+)/i);
          if (legacyMatch) channelSeg = legacyMatch[1];
        }

        // Resolve the workspace. If the URL names a team we have NO credentials for
        // (stale link, removed from workspace, cache skew), do NOT silently fall back
        // to a different workspace — that would issue scans/deletes with the wrong
        // team's token. Refuse instead (caller shows "not connected"). A URL with no
        // team segment at all (legacy /messages/, /archives/ routes on a workspace
        // domain like acme.slack.com) is resolved by matching the workspace's own
        // URL/domain against this page's hostname; only if nothing matches does it
        // fall back to the first workspace.
        let activeTeamId = teamSeg;
        if (activeTeamId && !teams[activeTeamId]) {
          return null;
        }
        if (!activeTeamId) {
          const host = window.location.hostname.toLowerCase();
          activeTeamId = Object.keys(teams).find((id) => {
            const tm = teams[id] || {};
            let urlHost = "";
            try { urlHost = tm.url ? new URL(tm.url).hostname.toLowerCase() : ""; } catch (e) { /* malformed url */ }
            const domainHost = tm.domain ? `${String(tm.domain).toLowerCase()}.slack.com` : "";
            return (urlHost && urlHost === host) || (domainHost && domainHost === host);
          }) || Object.keys(teams)[0];
        }

        // Real Slack conversation IDs start with C (channel), D (DM), or G
        // (group/private DM). Requiring that prefix also rejects non-conversation
        // routes such as /client/TEAM/threads, /activity, /saved, /drafts.
        const isValidChannel = channelSeg && /^[CDG][A-Z0-9]{6,}$/i.test(channelSeg);

        const team = teams[activeTeamId];
        return {
          team: {
            id: activeTeamId,
            name: team.name,
            token: team.token,
            userId: team.user_id,
            url: team.url
          },
          channelId: isValidChannel ? channelSeg : null
        };
      } catch (e) {
        console.error("SlackClean: Error parsing localConfig_v2", e);
        return null;
      }
    }

    // Global API Fetch helper delegated to background script
    async function slackAPICall(endpoint, params = {}) {
      if (!activeTeam) {
        const info = getActiveTeamInfo();
        if (info) activeTeam = info.team;
      }
      if (!activeTeam || !activeTeam.token) {
        throw new Error("Slack session credentials not found. Please reload Slack.");
      }

      // Sync active token with background session cache
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: "SET_SESSION",
          teamId: activeTeam.id,
          token: activeTeam.token
        }, () => {
          void chrome.runtime.lastError; // suppress unchecked-error warning
          resolve();
        });
      });

      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "BG_API_CALL",
          teamId: activeTeam.id,
          endpoint: endpoint,
          params: params
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "background_disconnected", message: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      });
    }

    // API Fetch helper that retries on rate limits
    async function slackAPICallWithRetry(endpoint, params = {}, maxRetries = 3) {
      let attempt = 0;
      while (attempt < maxRetries) {
        const data = await slackAPICall(endpoint, params);
        if (data.ok) {
          return data;
        }

        if (data.error === "rate_limited") {
          const waitTime = (data.retryAfter || 10) + 1;
          logConsole(t("logRateLimitHit", `API Rate Limit hit on ${endpoint}. Waiting ${waitTime} seconds before retry (Attempt ${attempt + 1}/${maxRetries})...`, [String(endpoint), String(waitTime), String(attempt + 1), String(maxRetries)]), "warn");
          await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
          attempt++;
        } else {
          return data;
        }
      }
      return { ok: false, error: "max_retries_exceeded", message: "Maximum API call retries exceeded." };
    }

    // Scrape channel title/username directly from current DOM
    function getChannelNameFromDOM() {
      const selectors = [
        "[data-qa='channel_title']",
        "[data-qa='channel_name']",
        ".p-classic_nav__model__title",
        ".p-view_header__title_btn",
        ".p-view_header__title",
        "h1",
        "h2"
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText) {
          const val = el.innerText.trim().replace(/[\r\n]+/g, " ").replace(/^#/, "");
          if (val && val.length > 0 && val.length < 100) return val;
        }
      }
      return null;
    }

    async function pruneExpiredUserCaches(ttl) {
      try {
        let keys;
        if (typeof chrome.storage.local.getKeys === "function") {
          keys = (await chrome.storage.local.getKeys()).filter(k => k.startsWith("sc_user_cache_"));
        } else {
          keys = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith("sc_user_cache_"));
        }
        if (keys.length === 0) return;
        const entries = await chrome.storage.local.get(keys);
        const now = Date.now();
        const expired = keys.filter((k) => {
          const e = entries[k];
          return !e || !e.timestamp || now - e.timestamp >= ttl;
        });
        if (expired.length > 0) await chrome.storage.local.remove(expired);
      } catch (err) {
        console.warn("SlackClean: Expired user-cache cleanup failed.", err);
      }
    }

    // Loads cache of user profiles in the workspace (24-hour TTL expiration, optimized user scope limit)
    async function loadUserCache() {
      if (!activeTeam) return;
      const cacheKey = `sc_user_cache_${activeTeam.id}`;
      const TTL = USER_CACHE_TTL_MS;

      // Drop every workspace's expired name cache (not just this one's) so caches
      // for workspaces the user no longer opens don't sit in storage forever.
      await pruneExpiredUserCaches(TTL);

      try {
        const cached = await chrome.storage.local.get(cacheKey);
        if (cached && cached[cacheKey]) {
          const { cacheData, timestamp } = cached[cacheKey];
          if (cacheData && timestamp && (Date.now() - timestamp < TTL)) {
            userCache = cacheData;
            logConsole(t("logLoadedUserCache", `Loaded ${Object.keys(userCache).length} user profiles from local cache.`, [String(Object.keys(userCache).length)]), "info");
            return;
          }
        }
      } catch (err) {
        console.warn("SlackClean: Cache load failed, querying API.", err);
      }

      try {
        userCache[activeTeam.userId] = t("dashAuthorMe", "Me");
        logConsole(t("logCachingUsers", "Caching workspace user directories..."), "info");
        
        let cursor = "";
        let pages = 0;
        
        do {
          const data = await slackAPICallWithRetry("users.list", { limit: 1000, cursor });
          if (data && data.ok && data.members) {
            data.members.forEach(member => {
              userCache[member.id] = member.profile?.display_name || member.real_name || member.name;
            });
            cursor = data.response_metadata?.next_cursor || "";
            pages++;
            if (pages >= MAX_USER_CACHE_PAGES) break;
          } else {
            break;
          }
        } while (cursor);

        await chrome.storage.local.set({ [cacheKey]: { cacheData: userCache, timestamp: Date.now() } });
        logConsole(t("logCachedUsers", `Cached ${Object.keys(userCache).length} user profiles.`, [String(Object.keys(userCache).length)]), "info");
      } catch (e) {
        console.error("SlackClean: Could not cache user list", e);
      }
    }

    // Resolves a user's name from cache, or fetches it dynamically if missing
    async function getUserName(userId) {
      if (!userId) return t("dashUnknown", "Unknown");
      if (userCache[userId]) return userCache[userId];
      try {
        const res = await slackAPICallWithRetry("users.info", { user: userId });
        if (res && res.ok && res.user) {
          const name = res.user.profile?.display_name || res.user.real_name || res.user.name;
          userCache[userId] = name;
          return name;
        }
      } catch (err) {
        console.warn(`SlackClean: Failed to fetch user profile for ${userId}`, err);
      }
      return null;
    }

    // Fetch metadata of the active target conversation
    async function loadActiveChannel(channelId) {
      // Record the intended target SYNCHRONOUSLY (before the await below reassigns
      // activeChannel), so a scan callback that lands mid-load can tell it's stale.
      intendedChannelId = channelId;
      logConsole(t("logFetchingChannel", `Fetching details for active channel ID: ${channelId}...`, [String(channelId)]), "info");
      
      const domName = getChannelNameFromDOM();
      
      try {
        const data = await slackAPICallWithRetry("conversations.info", { channel: channelId });
        if (data && data.ok && data.channel) {
          const ch = data.channel;
          let name = ch.name || domName || t("dashActiveChat", "Active Chat");
          let type = t("dashTypePublicChannel", "Public Channel");

          if (ch.is_im) {
            type = t("dashTypeDirectMessage", "Direct Message");
            const fetchedName = await getUserName(ch.user);
            name = fetchedName ? `@${fetchedName}` : `@${ch.user || "User"}`;
          } else if (ch.is_mpim) {
            type = t("dashTypeGroupDm", "Group DM");
            name = ch.purpose?.value || domName || type;
          } else if (ch.is_private) {
            type = t("dashTypePrivateChannel", "Private Channel");
          }

          activeChannel = { id: channelId, name, type };
          
          shadowRoot.getElementById("sc-selected-title").innerText = t("dashTargetLabel", `Target: ${activeChannel.name}`, [String(activeChannel.name)]);
          shadowRoot.getElementById("sc-selected-subtitle").innerText = t("dashModeLabel", `Mode: ${activeChannel.type} (${activeChannel.id}). Only this open chat will be cleaned.`, [String(activeChannel.type), String(activeChannel.id)]);
          shadowRoot.getElementById("sc-btn-scan").disabled = false;
          
          logConsole(t("logTargetLoaded", `Target loaded: ${activeChannel.name} (${activeChannel.type})`, [String(activeChannel.name), String(activeChannel.type)]), "info");
        } else {
          activeChannel = {
            id: channelId,
            name: domName || t("dashConversationFallback", `Conversation ${channelId}`, [String(channelId)]),
            type: channelId.startsWith("D") ? t("dashTypeDirectMessage", "Direct Message") : t("dashTypeChannel", "Channel")
          };
          
          shadowRoot.getElementById("sc-selected-title").innerText = t("dashTargetLabel", `Target: ${activeChannel.name}`, [String(activeChannel.name)]);
          shadowRoot.getElementById("sc-selected-subtitle").innerText = t("dashLoadedViaUrl", `Loaded via URL (${activeChannel.id}). Only this open chat will be cleaned.`, [String(activeChannel.id)]);
          shadowRoot.getElementById("sc-btn-scan").disabled = false;
          
          logConsole(t("logTargetLoadedUrl", `Target loaded via URL matching: ${activeChannel.name}`, [String(activeChannel.name)]), "info");
        }
      } catch (e) {
        logConsole(t("logErrorLoadingConversation", "Error loading conversation info: " + e.message, [e.message]), "error");
      }
    }

    // Clears the scan-results preview + state. Called when the target channel
    // changes so results from the previous chat can't linger (which would be
    // misleading, and unsafe — a delete builds its queue from scanResults but
    // executes against the CURRENT activeChannel).
    function resetScanResultsUI() {
      scanResults = [];
      // Invalidate any pending (not-yet-dispatched) delete queue: it belongs to
      // the previous target and must never be executed against the new one.
      deleteQueue = [];
      queueChannelId = null;
      scanResultsChannelId = null;
      queueTeamId = null;
      scanResultsTeamId = null;
      const container = shadowRoot.getElementById("sc-results-list");
      if (container) {
        const nm = document.createElement("div");
        nm.className = "no-messages";
        nm.textContent = t("dashResultsPlaceholder", "Select a conversation and run Scan to preview target items here.");
        container.innerHTML = "";
        container.appendChild(nm);
      }
      const countEl = shadowRoot.getElementById("sc-scan-count");
      if (countEl) countEl.innerText = t("dashItemsFound", "0 items found", ["0"]);
      const exportBtn = shadowRoot.getElementById("sc-btn-export-messages");
      if (exportBtn) exportBtn.disabled = true;
      if (ui.btnDelete) ui.btnDelete.disabled = true;
    }

    // Point the dashboard at a new target chat: clear stale results, then reload.
    // Returns loadActiveChannel's promise so callers can act only AFTER
    // activeChannel is actually updated (it's assigned past an await).
    function switchTargetChannel(channelId) {
      // A new target means any prior completion is no longer "the current job" — reset
      // the finalize guard so a completion broadcast for this new target isn't swallowed.
      jobFinalized = false;
      resetScanResultsUI();
      return loadActiveChannel(channelId);
    }

    // Re-point the dashboard at a different WORKSPACE (team). Slack's unified client
    // changes the team segment in the URL when the user picks another workspace in
    // the sidebar, all within the same tab. `activeTeam` carries the token and userId
    // every scan/delete is issued against, so it MUST follow the switch — otherwise
    // the dashboard keeps operating against the previous workspace's credentials.
    // Only call this when NO job is bound to the current workspace (a running/paused
    // job stays pinned to its origin team; see handleUrlChange). Returns a promise
    // that settles once the new workspace's target conversation is loaded.
    function switchWorkspace(info) {
      // New workspace target — clear the finalize guard (see switchTargetChannel).
      jobFinalized = false;
      activeTeam = info.team;
      // Record the intended workspace SYNCHRONOUSLY, mirroring intendedChannelId's
      // reasoning: a scan/delete race guard checked before the async work below
      // resolves must be able to tell this workspace switch is already underway.
      intendedTeamId = activeTeam.id;

      // Refresh the background token cache for the newly-active workspace.
      chrome.runtime.sendMessage({
        type: "SET_SESSION",
        teamId: activeTeam.id,
        token: activeTeam.token
      }, () => { void chrome.runtime.lastError; });

      // Update the connection panel to the new workspace.
      const nameEl = shadowRoot.getElementById("sc-connection-name");
      const urlEl = shadowRoot.getElementById("sc-connection-url");
      const uidEl = shadowRoot.getElementById("sc-connection-uid");
      if (nameEl) nameEl.innerText = activeTeam.name || t("dashSlackWorkspace", "Slack Workspace");
      if (urlEl) urlEl.innerText = activeTeam.url || t("dashSlackUrl", "Slack URL");
      if (uidEl) uidEl.innerText = activeTeam.userId || t("dashUserFallback", "User");

      logConsole(t("logWorkspaceSwitched", `Workspace switched to ${activeTeam.name || activeTeam.id}. Reloading directory...`, [String(activeTeam.name || activeTeam.id)]), "info");

      // The cached user-name directory belongs to the previous workspace — reset it
      // and reload before resolving the target so DM/author names resolve correctly.
      userCache = {};
      return loadUserCache().then(() => {
        if (info.channelId) {
          return switchTargetChannel(info.channelId);
        }
        // No conversation open in the new workspace: clear the target cleanly.
        resetScanResultsUI();
        activeChannel = null;
        const titleEl = shadowRoot.getElementById("sc-selected-title");
        const subEl = shadowRoot.getElementById("sc-selected-subtitle");
        if (titleEl) titleEl.innerText = t("dashNoConversationActive", "No Conversation Active");
        if (subEl) subEl.innerText = t("dashNoConversationHint", "Click a Channel or DM in Slack's sidebar — it will be detected automatically.");
        const scanBtn = shadowRoot.getElementById("sc-btn-scan");
        if (scanBtn) scanBtn.disabled = true;
        return undefined;
      });
    }

    // Injects Dashboard modal into Shadow DOM (Secured against startup crash)
    function initDashboard() {
      // 1. If dashboard exists, reveal and continue
      if (shadowHost) {
        shadowHost.style.display = "block";
        dashboardEl.classList.add("visible");

        // Re-detect the active chat: the user may have switched channels while
        // the dashboard was closed. The URL observer skips channel-sync while
        // hidden, so activeChannel can be stale here. Don't switch if a job is
        // running/paused for the current target (that flow is channel-scoped and
        // handled by checkAndResumeState below).
        if (!isRunning) {
          const info = getActiveTeamInfo();
          // The user may have switched WORKSPACES while the dashboard was closed —
          // re-point credentials first, then resume-check the new target.
          if (info && activeTeam && info.team && info.team.id !== activeTeam.id) {
            switchWorkspace(info).then(() => checkAndResumeState());
            return;
          }
          if (info && info.channelId && (!activeChannel || activeChannel.id !== info.channelId)) {
            // Wait for activeChannel to actually update before checking job
            // status — otherwise GET_JOB_STATUS queries the STALE channel and a
            // paused job's resume prompt for the new channel is silently lost.
            switchTargetChannel(info.channelId).then(() => checkAndResumeState());
            return;
          }
        }

        checkAndResumeState();
        return;
      }

      // 2. Scaffold Shadow DOM Structure FIRST so error alerts can be rendered on DOM fallback
      shadowHost = document.createElement("div");
      shadowHost.id = "slackclean-dashboard-root";
      
      shadowHost.style.position = "absolute";
      shadowHost.style.top = "0";
      shadowHost.style.left = "0";
      shadowHost.style.width = "0";
      shadowHost.style.height = "0";
      shadowHost.style.margin = "0";
      shadowHost.style.padding = "0";
      shadowHost.style.border = "none";
      shadowHost.style.overflow = "visible";
      shadowHost.style.pointerEvents = "none";
      
      document.body.appendChild(shadowHost);

      // Closed mode: Slack's page scripts can't reach in through host.shadowRoot
      // and drive the dashboard (e.g. click Delete). Our own reference is kept in
      // the `shadowRoot` variable above, which is all this script ever uses.
      shadowRoot = shadowHost.attachShadow({ mode: "closed" });

      // Isolate keyboard events from the host page (Slack). Slack registers global,
      // document-level keyboard-shortcut handlers that inspect document.activeElement
      // to decide whether the user is "typing". For an input inside our shadow
      // root, document.activeElement is this HOST element — a <div>, not an input —
      // so Slack misreads each keystroke as a shortcut and can preventDefault() it,
      // which silently blocks typing in our fields (most visibly the "type DELETE"
      // confirmation box, where typing is mandatory). Stopping propagation at the host
      // keeps every keystroke that originates inside the dashboard from reaching Slack.
      // BUBBLE phase only and attached to the HOST (outside the shadow root) on purpose:
      // our own in-shadow handlers (the Tab/Escape focus trap and the verify-input
      // validation listener) run first, then the event is stopped here before Slack
      // sees it. A capture-phase stop would pre-empt — and break — our own focus trap.
      // Events originating in Slack's own DOM never pass through this host, so Slack's
      // native shortcuts keep working normally when the dashboard isn't focused.
      ["keydown", "keyup", "keypress"].forEach((evtType) => {
        shadowHost.addEventListener(evtType, (e) => e.stopPropagation());
      });

      const styleLink = document.createElement("link");
      styleLink.rel = "stylesheet";
      styleLink.href = chrome.runtime.getURL("content.css");
      shadowRoot.appendChild(styleLink);

      // Modal Container
      dashboardEl = document.createElement("div");
      dashboardEl.className = "dashboard-overlay";
      dashboardEl.innerHTML = `
        <div class="dashboard-modal">
          
          <!-- Expanded View -->
          <div class="expanded-view">
            <header class="dashboard-header">
              <div class="header-left">
                <svg class="logo-icon" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <linearGradient id="logo-glow-injected" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stop-color="#8B5CF6" />
                      <stop offset="100%" stop-color="#EC4899" />
                    </linearGradient>
                  </defs>
                  <rect width="512" height="512" rx="128" fill="#1E1E2E" />
                  <path d="M140 180 C140 135.8, 184.8 100, 240 100 H320 C375.2 100, 420 135.8, 420 180 V260 C420 304.2, 375.2 340, 320 340 H210 L130 400 V340 C140 320, 140 290, 140 260 Z" stroke="url(#logo-glow-injected)" stroke-width="24" stroke-linejoin="round" />
                  <path d="M220 220 L310 130" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round" />
                  <path d="M300 120 L340 160" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round" />
                </svg>
                <div class="brand-title">
                  <h2>Erasechat</h2>
                  <span class="premium-badge">Slack</span>
                </div>
              </div>
              <div class="header-right">
                <div class="theme-picker">
                  <span class="info-label" data-i18n="dashVibe">Vibe:</span>
                  <button type="button" class="theme-bubble neon active" data-theme="neon" data-i18n-title="dashThemeNeon" title="Neon Aura" data-i18n-aria="dashThemeNeon" aria-label="Neon Aura" aria-pressed="true"></button>
                  <button type="button" class="theme-bubble matrix" data-theme="matrix" data-i18n-title="dashThemeMatrix" title="Emerald Matrix" data-i18n-aria="dashThemeMatrix" aria-label="Emerald Matrix" aria-pressed="false"></button>
                  <button type="button" class="theme-bubble fusion" data-theme="fusion" data-i18n-title="dashThemeFusion" title="Fusion Gold" data-i18n-aria="dashThemeFusion" aria-label="Fusion Gold" aria-pressed="false"></button>
                </div>
                <button class="close-btn" id="sc-btn-minimize" data-i18n-title="dashMinimize" title="Minimize Dashboard" data-i18n-aria="dashMinimize" aria-label="Minimize dashboard overlay">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="4" y1="12" x2="20" y2="12"></line>
                  </svg>
                </button>
                <button class="close-btn" id="sc-btn-close" data-i18n-aria="dashClose" aria-label="Close dashboard overlay">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </header>
            
            <div class="dashboard-body">
              <main class="dashboard-main">
                <div class="config-grid">
                  <!-- Account Info Panel -->
                  <section class="panel-card">
                    <h3 class="panel-title" data-i18n="dashSessionConnection">Session Connection</h3>
                    <div class="info-row">
                      <span class="info-label" data-i18n="dashWorkspaceName">Workspace Name</span>
                      <span class="info-val" id="sc-connection-name">Loading...</span>
                    </div>
                    <div class="info-row">
                      <span class="info-label" data-i18n="dashWorkspaceUrl">Workspace URL</span>
                      <span class="info-val" id="sc-connection-url">Loading...</span>
                    </div>
                    <div class="info-row">
                      <span class="info-label" data-i18n="dashUserId">User ID</span>
                      <span class="info-val" id="sc-connection-uid">Loading...</span>
                    </div>
                    <div class="info-row">
                      <span class="info-label" data-i18n="dashLocalProtection">Local Protection</span>
                      <span class="info-val"><span class="badge-connected sc-scope-badge" data-i18n="dashCurrentChatScope">CURRENT CHAT SCOPE</span></span>
                    </div>
                  </section>

                  <!-- Filters Panel -->
                  <section class="panel-card">
                    <h3 class="panel-title" data-i18n="dashFilterMatrix">Filters</h3>
                    <div class="filter-form">
                      <div class="form-group sc-preset-group">
                        <label for="sc-preset-select" data-i18n="dashPresetLabel">Saved Presets</label>
                        <div class="preset-controls">
                          <select id="sc-preset-select">
                            <option value="" data-i18n="dashPresetChoose">Load preset…</option>
                          </select>
                          <button type="button" id="sc-btn-preset-save" class="dashboard-btn btn-scan" data-i18n="dashPresetSave">Save Current</button>
                          <button type="button" id="sc-btn-preset-delete" class="dashboard-btn btn-scan hidden" data-i18n="dashPresetDelete">Delete</button>
                        </div>
                      </div>

                      <div class="form-row">
                        <div class="form-group">
                          <label for="sc-filter-sender" data-i18n="dashSenderProfile">Sender Profile</label>
                          <select id="sc-filter-sender">
                            <option value="me" selected data-i18n="dashOnlyMyMessages">Only My Messages</option>
                            <option value="all" data-i18n="dashAllMessages">All Messages (Requires Admin permissions)</option>
                          </select>
                        </div>
                        <div class="form-group">
                          <label for="sc-filter-date" data-i18n="dashDateThreshold">Date Threshold</label>
                          <select id="sc-filter-date">
                            <option value="all" selected data-i18n="dashAllTime">All Time</option>
                            <option value="older_than" data-i18n="dashOlderThan">Older than X days</option>
                            <option value="custom" data-i18n="dashCustomRange">Custom Date Range</option>
                          </select>
                        </div>
                      </div>

                      <div class="form-row hidden" id="sc-date-days-row">
                        <div class="form-group">
                          <label for="sc-filter-days" data-i18n="dashDaysOld">Days Old Threshold</label>
                          <input type="number" id="sc-filter-days" value="30" min="1">
                        </div>
                        <div></div>
                      </div>

                      <div class="form-row hidden" id="sc-date-custom-row">
                        <div class="form-group">
                          <label for="sc-filter-start-date" data-i18n="dashStartDate">Start Date</label>
                          <input type="date" id="sc-filter-start-date">
                        </div>
                        <div class="form-group">
                          <label for="sc-filter-end-date" data-i18n="dashEndDate">End Date</label>
                          <input type="date" id="sc-filter-end-date">
                        </div>
                      </div>

                      <div class="form-row">
                        <div class="form-group">
                          <label for="sc-filter-text" data-i18n="dashTextMatch">Text Match (Optional)</label>
                          <input type="text" id="sc-filter-text" data-i18n-ph="dashKeywordPlaceholder" placeholder="Keyword or Phrase">
                          <p class="sc-field-hint" data-i18n="dashTextMatchRegexHint">Wrap in / / to use a regular expression, e.g. /ERR_\\d+/. Plain text otherwise.</p>
                          <label class="sc-inline-checkbox" for="sc-filter-invert-text">
                            <input type="checkbox" id="sc-filter-invert-text">
                            <span data-i18n="dashInvertText">Invert: delete everything EXCEPT matches</span>
                          </label>
                        </div>
                        <div class="form-group">
                          <label for="sc-filter-delay" data-i18n="dashSpeedDelay">Speed Delay (ms)</label>
                          <input type="number" id="sc-filter-delay" value="1000" min="1000" step="100">
                        </div>
                      </div>

                      <div class="toggle-group">
                        <div class="toggle-label">
                          <span class="toggle-title" id="sc-lbl-threads" data-i18n="dashIncludeThreads">Include Thread Replies</span>
                          <span class="toggle-subtitle" id="sc-desc-threads" data-i18n="dashIncludeThreadsDesc">Scan and delete messages inside threads</span>
                        </div>
                        <label class="switch">
                          <input type="checkbox" id="sc-filter-threads" checked aria-labelledby="sc-lbl-threads" aria-describedby="sc-desc-threads">
                          <span class="slider"></span>
                        </label>
                      </div>

                      <div class="toggle-group">
                        <div class="toggle-label">
                          <span class="toggle-title" id="sc-lbl-attachments" data-i18n="dashOnlyAttachments">Only Delete Attachments</span>
                          <span class="toggle-subtitle" id="sc-desc-attachments" data-i18n="dashOnlyAttachmentsDesc">Strips files/attachments but keeps any message text (a message that is only a file is deleted)</span>
                        </div>
                        <label class="switch">
                          <input type="checkbox" id="sc-filter-attachments" aria-labelledby="sc-lbl-attachments" aria-describedby="sc-desc-attachments">
                          <span class="slider"></span>
                        </label>
                      </div>

                      <div class="toggle-group">
                        <div class="toggle-label">
                          <span class="toggle-title" id="sc-lbl-skip-pinned" data-i18n="dashSkipPinned">Skip Pinned Messages</span>
                          <span class="toggle-subtitle" id="sc-desc-skip-pinned" data-i18n="dashSkipPinnedDesc">Never delete a message that is currently pinned in this conversation</span>
                        </div>
                        <label class="switch">
                          <input type="checkbox" id="sc-filter-skip-pinned" checked aria-labelledby="sc-lbl-skip-pinned" aria-describedby="sc-desc-skip-pinned">
                          <span class="slider"></span>
                        </label>
                      </div>
                    </div>
                  </section>
                </div>
   
                <!-- Channel Action Bar -->
                <div class="action-panel">
                  <div class="selected-channel-summary">
                    <h4 id="sc-selected-title">Loading current conversation...</h4>
                    <p id="sc-selected-subtitle">Please stand by as details are retrieved.</p>
                  </div>
                  <div class="action-buttons">
                    <button class="dashboard-btn btn-scan" id="sc-btn-scan" disabled data-i18n="dashScan">Scan Messages</button>
                    <button class="dashboard-btn btn-delete" id="sc-btn-delete" disabled data-i18n="dashStartDeleting">Start Deleting</button>
                    <button class="dashboard-btn btn-scan hidden" id="sc-btn-cancel" data-i18n="dashCancel">Cancel</button>
                  </div>
                </div>

                <!-- Scan Results checklist -->
                <div class="panel-card results-panel">
                  <div class="results-header">
                    <h4 data-i18n="dashMessagesFlagged">Messages Flagged for Deletion</h4>
                    <div class="results-selector">
                      <span id="sc-scan-count">0 items found</span>
                      <button id="sc-btn-export-messages" class="dashboard-btn btn-scan" disabled data-i18n="dashExportCsv">Export CSV</button>
                      <label class="sc-selectall-label">
                        <input type="checkbox" id="sc-select-all" checked> <span data-i18n="dashSelectAll">Select All</span>
                      </label>
                    </div>
                  </div>
                  <div class="results-list" id="sc-results-list">
                    <div class="no-messages" data-i18n="dashResultsPlaceholder">Select a conversation and run Scan to preview target items here.</div>
                  </div>
                </div>
   
                <!-- Log and Progress monitoring -->
                <div class="monitor-panel">
                  <!-- Progress stats -->
                  <div class="panel-card progress-stats sc-progress-panel">
                    <div class="progress-ring-wrapper sc-ring-80">
                      <svg width="80" height="80" viewBox="0 0 100 100" class="sc-progress-svg">
                        <circle class="sc-ring-track" cx="50" cy="50" r="40" stroke-width="8" fill="transparent" />
                        <circle id="sc-progress-circle" cx="50" cy="50" r="40" stroke="url(#logo-glow-injected)" stroke-width="8" fill="transparent" stroke-dasharray="251.33" stroke-dashoffset="251.33" stroke-linecap="round" />
                      </svg>
                      <div id="sc-progress-ring-text">0%</div>
                    </div>
                    <div class="sc-progress-detail">
                      <div class="progress-title-row sc-tight">
                        <span class="progress-label" id="sc-progress-title" data-i18n="dashIdle">Idle</span>
                      </div>
                      <div class="stats-grid">
                        <div class="stat-item sc-stat-compact">
                          <div class="stat-item-label sc-stat-label-sm" data-i18n="dashStatSuccess">Success</div>
                          <div class="stat-item-val success" id="sc-stat-success">0</div>
                        </div>
                        <div class="stat-item sc-stat-compact">
                          <div class="stat-item-label sc-stat-label-sm" data-i18n="dashStatFailed">Failed</div>
                          <div class="stat-item-val fail" id="sc-stat-fail">0</div>
                        </div>
                        <div class="stat-item sc-stat-compact">
                          <div class="stat-item-label sc-stat-label-sm" data-i18n="dashStatLeft">Left</div>
                          <div class="stat-item-val" id="sc-stat-remaining">0</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Terminal Logger -->
                  <div class="console-log-wrapper">
                    <div class="console-header">
                      <span data-i18n="dashExecutionLogs">Execution Logs</span>
                      <div class="console-actions">
                        <button type="button" id="sc-btn-clear-logs" data-i18n="dashClear">Clear</button>
                        <button type="button" id="sc-btn-download-logs" data-i18n="dashExport">Export</button>
                        <span id="sc-console-status" data-i18n="dashReady">Ready</span>
                      </div>
                    </div>
                    <div class="console-terminal" id="sc-console-log" role="log" aria-live="off" tabindex="0" data-i18n-aria="dashExecutionLogs" aria-label="Execution Logs">
                      <div class="console-line info" data-i18n="logInitialized">Erasechat initialized in Safe (Single-Channel) Mode.</div>
                    </div>
                    <!-- Start/finish/pause summaries for screen readers (the log above is not live). -->
                    <div id="sc-status-live" class="sc-sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
                  </div>
                </div>
              </main>
            </div>
          </div>
          
          <!-- Minimized View -->
          <div class="minimized-view hidden">
            <div class="minimized-content">
              <div class="minimized-ring-wrapper">
                <svg width="36" height="36" viewBox="0 0 100 100">
                  <circle class="sc-ring-track" cx="50" cy="50" r="40" stroke-width="8" fill="transparent" />
                  <circle id="sc-min-progress-circle" cx="50" cy="50" r="40" stroke="url(#logo-glow-injected)" stroke-width="8" fill="transparent" stroke-dasharray="251.33" stroke-dashoffset="251.33" stroke-linecap="round" />
                </svg>
              </div>
              <div class="minimized-info">
                <h5 id="sc-min-status-title">Erasechat</h5>
                <span id="sc-min-status-text">Idle</span>
              </div>
              <button class="btn-maximize" id="sc-btn-maximize" data-i18n-title="dashMaximize" title="Expand Dashboard" data-i18n-aria="dashMaximize" aria-label="Expand dashboard overlay">
                <svg class="minimized-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <polyline points="9 21 3 21 3 15"></polyline>
                  <line x1="21" y1="3" x2="14" y2="10"></line>
                  <line x1="3" y1="21" x2="10" y2="14"></line>
                </svg>
              </button>
            </div>
          </div>

        </div>
   
        <!-- Safety Verification Modal -->
        <div class="verification-overlay hidden" id="sc-verify-modal" role="dialog" aria-modal="true" aria-labelledby="sc-verify-title">
          <div class="verification-card">
            <h4 id="sc-verify-title" data-i18n="dashVerifyTitle">Confirm Deletion</h4>
            <p class="sc-verify-desc">
              You are about to delete more than 100 messages (<span id="sc-verify-count-label">0</span> messages). To confirm this operation, type the word <strong class="sc-verify-emphasis">DELETE</strong> below:
            </p>
            <input type="text" id="sc-verify-input" data-i18n-ph="dashVerifyInputPlaceholder" placeholder="Type DELETE to confirm" data-i18n-aria="dashVerifyInputPlaceholder" aria-label="Type DELETE to confirm">
            <div class="sc-modal-actions">
              <button class="dashboard-btn btn-scan" id="sc-verify-cancel-btn" data-i18n="dashVerifyGoBack">Go Back</button>
              <button class="dashboard-btn btn-delete danger" id="sc-verify-confirm-btn" disabled data-i18n="dashVerifyConfirm">Confirm Deletion</button>
            </div>
          </div>
        </div>

        <!-- Custom Alert Modal -->
        <div class="verification-overlay hidden" id="sc-alert-modal" role="dialog" aria-modal="true" aria-labelledby="sc-alert-title">
          <div class="verification-card sc-card-purple">
            <h4 id="sc-alert-title" data-i18n="dashAlertTitle">Notification</h4>
            <p id="sc-alert-message"></p>
            <div class="sc-modal-actions">
              <button class="dashboard-btn btn-delete" id="sc-alert-ok-btn" data-i18n="dashOk">OK</button>
            </div>
          </div>
        </div>

        <!-- Custom Confirm Modal -->
        <div class="verification-overlay hidden" id="sc-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="sc-confirm-title">
          <div class="verification-card sc-card-purple">
            <h4 id="sc-confirm-title" data-i18n="dashConfirmTitle">Confirmation</h4>
            <p id="sc-confirm-message"></p>
            <div class="sc-modal-actions">
              <button class="dashboard-btn btn-scan" id="sc-confirm-cancel-btn" data-i18n="dashCancel">Cancel</button>
              <button class="dashboard-btn btn-delete" id="sc-confirm-ok-btn" data-i18n="dashConfirm">Confirm</button>
            </div>
          </div>
        </div>

        <!-- Custom Prompt Modal (single text-input dialog, e.g. naming a saved preset) -->
        <div class="verification-overlay hidden" id="sc-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="sc-prompt-title">
          <div class="verification-card sc-card-purple">
            <h4 id="sc-prompt-title" data-i18n="dashPromptTitle">Name This Preset</h4>
            <p id="sc-prompt-message"></p>
            <input type="text" id="sc-prompt-input" maxlength="60" aria-labelledby="sc-prompt-title">
            <div class="sc-modal-actions">
              <button class="dashboard-btn btn-scan" id="sc-prompt-cancel-btn" data-i18n="dashCancel">Cancel</button>
              <button class="dashboard-btn btn-delete" id="sc-prompt-ok-btn" disabled data-i18n="dashConfirm">Confirm</button>
            </div>
          </div>
        </div>
      `;

      shadowRoot.appendChild(dashboardEl);

      // Apply translations over the freshly-injected English markup.
      localizeI18n(shadowRoot);

      // The overlay is a modal dialog over Slack (aria-modal is dropped while it
      // is minimized to the floating widget — see setupHeaderControls).
      const modalRoot = dashboardEl.querySelector(".dashboard-modal");
      if (modalRoot) {
        modalRoot.setAttribute("role", "dialog");
        modalRoot.setAttribute("aria-modal", "true");
        modalRoot.setAttribute("aria-label", t("dashDialogLabel", "Erasechat dashboard"));
      }

      // Cache DOM references
      ui = {
        progressCircle: shadowRoot.getElementById("sc-progress-circle"),
        progressRingText: shadowRoot.getElementById("sc-progress-ring-text"),
        progressTitle: shadowRoot.getElementById("sc-progress-title"),
        statSuccess: shadowRoot.getElementById("sc-stat-success"),
        statFail: shadowRoot.getElementById("sc-stat-fail"),
        statRemaining: shadowRoot.getElementById("sc-stat-remaining"),
        consoleLog: shadowRoot.getElementById("sc-console-log"),
        consoleStatus: shadowRoot.getElementById("sc-console-status"),
        btnDelete: shadowRoot.getElementById("sc-btn-delete")
      };

      // Set up theme controls and button events
      setupUIListeners();
      startUrlObserver();
      refreshPresetSelect();

      // Trigger DOM paint then slide in, then move focus for accessibility
      setTimeout(() => {
        dashboardEl.classList.add("visible");
        // Move focus to first interactive element for keyboard users (SC-A11Y-04)
        const firstFocusable = shadowRoot.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled])');
        if (firstFocusable) firstFocusable.focus();
      }, 50);

      // 3. Perform credentials retrieval and error checks AFTER DOM setup
      const info = getActiveTeamInfo();
      if (!info) {
        // UI fields default to offline
        shadowRoot.getElementById("sc-connection-name").innerText = t("dashNotConnected", "Not Connected");
        shadowRoot.getElementById("sc-connection-url").innerText = t("dashUnknown", "Unknown");
        shadowRoot.getElementById("sc-connection-uid").innerText = t("dashUnknown", "Unknown");
        
        shadowRoot.getElementById("sc-selected-title").innerText = t("dashNoConversationConnected", "No Conversation Connected");
        shadowRoot.getElementById("sc-selected-subtitle").innerText = t("dashLoginHint", "Please log in to Slack and go to a workspace channel.");
        
        showCustomAlert(
          t("modalAuthErrorTitle", "Authentication Error"),
          t("modalAuthErrorMsg", "Slack session credentials not found. Make sure you are logged into Slack web client on this tab, then re-open.")
        );
        return;
      }

      activeTeam = info.team;
      intendedTeamId = activeTeam.id;
      const targetChannelId = info.channelId;

      // Populate Connection Details
      shadowRoot.getElementById("sc-connection-name").innerText = activeTeam.name || t("dashSlackWorkspace", "Slack Workspace");
      shadowRoot.getElementById("sc-connection-url").innerText = activeTeam.url || t("dashSlackUrl", "Slack URL");
      shadowRoot.getElementById("sc-connection-uid").innerText = activeTeam.userId || t("dashUserFallback", "User");

      // Load workspace and active channel data
      loadUserCache().then(() => {
        if (targetChannelId) {
          loadActiveChannel(targetChannelId).then(() => {
            checkAndResumeState();
          });
        } else {
          shadowRoot.getElementById("sc-selected-title").innerText = t("dashNoConversationActive", "No Conversation Active");
          shadowRoot.getElementById("sc-selected-subtitle").innerText = t("dashNoConversationHint", "Click a Channel or DM in Slack's sidebar — it will be detected automatically.");
          logConsole(t("logNoConversationDetected", "No conversation detected yet. Click a channel or DM in Slack and it will be picked up automatically."), "warn");
        }
      });
    }

    // Log message to UI terminal console (capped at 200 elements for DOM performance)
    function logConsole(message, type = "info") {
      if (!ui.consoleLog) return;

      // Add severity prefix for color-blind accessibility (SC-A11Y-02)
      const prefixMap = { info: "[INFO]", warn: "[WARN]", error: "[ERROR]" };
      const prefix = prefixMap[type] || "[INFO]";
      const prefixedMsg = message.startsWith("[") ? message : `${prefix} ${message}`;

      const line = document.createElement("div");
      line.className = `console-line ${type}`;
      line.innerText = `[${new Date().toLocaleTimeString()}] ${prefixedMsg}`;
      ui.consoleLog.appendChild(line);

      // Prune oldest lines once the node count exceeds the cap
      while (ui.consoleLog.children.length > CONSOLE_LOG_MAX_LINES) {
        ui.consoleLog.removeChild(ui.consoleLog.firstElementChild);
      }

      ui.consoleLog.scrollTop = ui.consoleLog.scrollHeight;
    }

    // Theme Switcher engine overriding CSS properties dynamically
    function setTheme(themeName) {
      const host = shadowHost;
      if (!host) return;

      // De-activate other theme switcher buttons
      shadowRoot.querySelectorAll(".theme-bubble").forEach(btn => {
        btn.classList.remove("active");
        btn.setAttribute("aria-pressed", "false");
      });
      
      const targetBtn = shadowRoot.querySelector(`.theme-bubble.${themeName}`);
      if (targetBtn) {
        targetBtn.classList.add("active");
        targetBtn.setAttribute("aria-pressed", "true");
      }

      if (themeName === 'neon') {
        host.style.setProperty('--color-purple', '#8b5cf6');
        host.style.setProperty('--color-pink', '#ec4899');
        host.style.setProperty('--gradient-glow', 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)');
        host.style.setProperty('--gradient-glow-hover', 'linear-gradient(135deg, #a78bfa 0%, #f472b6 100%)');
        host.style.setProperty('--accent-soft', 'rgba(139, 92, 246, 0.16)');
      } else if (themeName === 'matrix') {
        // Darker emerald/cyan stops: buttons carry white text, and the bright
        // #10b981/#06b6d4 pair only reached ~2.2-2.5:1. These are >= 5.3:1 (AA),
        // and hover goes darker still rather than lighter.
        host.style.setProperty('--color-purple', '#047857');
        host.style.setProperty('--color-pink', '#0e7490');
        host.style.setProperty('--gradient-glow', 'linear-gradient(135deg, #047857 0%, #0e7490 100%)');
        host.style.setProperty('--gradient-glow-hover', 'linear-gradient(135deg, #065f46 0%, #155e75 100%)');
        host.style.setProperty('--accent-soft', 'rgba(4, 120, 87, 0.16)');
      } else if (themeName === 'fusion') {
        // Same reasoning for amber/red: #b45309/#b91c1c are >= 5:1 with white text.
        host.style.setProperty('--color-purple', '#b45309');
        host.style.setProperty('--color-pink', '#b91c1c');
        host.style.setProperty('--gradient-glow', 'linear-gradient(135deg, #b45309 0%, #b91c1c 100%)');
        host.style.setProperty('--gradient-glow-hover', 'linear-gradient(135deg, #92400e 0%, #991b1b 100%)');
        host.style.setProperty('--accent-soft', 'rgba(180, 83, 9, 0.16)');
      }
      
      const themeLabel = targetBtn ? (targetBtn.getAttribute("aria-label") || themeName) : themeName;
      logConsole(t("logThemeSet", `Interface theme set to: ${themeLabel.toUpperCase()}`, [themeLabel.toUpperCase()]), "info");
    }



    // Checks background job status and resumes/syncs UI state
    async function checkAndResumeState() {
      if (!activeTeam || !activeChannel) return;
      // Captured now, not read from activeTeam.id inside the callback below: this
      // request is async, and switchWorkspace() can reassign activeTeam to a
      // DIFFERENT team before the response arrives (e.g. a fast workspace switch
      // while this round-trip is still in flight). Reading activeTeam.id inside the
      // callback would then tag/read this team-A response's data under team B's
      // id -- reintroducing the exact cross-workspace mislabeling the teamId-scoped
      // alertedOtherJobChannels keying below exists to prevent.
      const teamId = activeTeam.id;
      try {
        chrome.runtime.sendMessage({
          type: "GET_JOB_STATUS",
          teamId,
          channelId: activeChannel.id
        }, (response) => {
          if (chrome.runtime.lastError) return;

          // background.js's GET_JOB_STATUS handler always sends otherJobs (an array).
          const pausedElsewhere = (response && response.otherJobs || []).filter(j => j.isPaused);

          // Only alert about a paused-elsewhere job the FIRST time it's seen — without
          // this, switching between channels A/B/C while a job sits paused in channel Y
          // re-triggers the same modal on every single switch, forcing a fresh dismiss
          // click each time. Alert again if a channel not already alerted-on appears
          // (e.g. a second job gets paused later).
          // Keyed by teamId_channelId, not bare channelId: channel IDs are workspace-
          // scoped and two independently-created workspaces could plausibly reuse one
          // (see matchesActiveWorkspaceChannel's own docstring above). otherJobs is
          // already team-scoped by background.js, but this Set persists for the whole
          // content-script lifetime across workspace switches, so it must carry the
          // team scope forward too or a collision would silently suppress a real,
          // unrelated alert in a different workspace.
          const otherJobKey = j => `${teamId}_${j.channelId}`;
          const newlyPaused = pausedElsewhere.filter(j => !alertedOtherJobChannels.has(otherJobKey(j)));
          if (newlyPaused.length > 0) {
            newlyPaused.forEach(j => alertedOtherJobChannels.add(otherJobKey(j)));
            const names = newlyPaused.map(j => j.channelId).join(", ");
            showCustomAlert(
              t("modalPausedOtherTitle", "Paused Job in Another Channel"),
              t("modalPausedOtherMsg", `You have a paused bulk clean in another conversation (${names}). Switch to that channel to resume or cancel it.`, [names])
            );
          }
          // Drop tracking for channels that are no longer paused, so a job that's
          // resumed/cancelled and later paused again in the same channel re-alerts.
          for (const trackedKey of Array.from(alertedOtherJobChannels)) {
            if (trackedKey.startsWith(`${teamId}_`)) {
              const channelId = trackedKey.slice(`${teamId}_`.length);
              if (!pausedElsewhere.some(j => j.channelId === channelId)) {
                alertedOtherJobChannels.delete(trackedKey);
              }
            }
          }

          if (response && response.exists) {
            const state = response.job;
            // Same background-vs-local convention translation as the JOB_UPDATE
            // listener above (see its comment) -- state.isRunning is false while
            // paused, but content.js needs isRunning true-while-paused so the
            // drift guard below still recognizes a bound-but-paused job.
            isRunning = state.isRunning || state.isPaused;
            isPaused = state.isPaused;
            deleteIndex = state.deleteIndex;
            stats = state.stats;
            throttleDelay = state.throttleDelay || 1000;

            if (isRunning && !isPaused) {
              // Active job running: sync UI directly without prompting. Clear the
              // finalize guard so THIS job's completion broadcast still fires the
              // "finished" alert even if a previous job on this tab already finalized.
              jobFinalized = false;
              toggleInputs(true);
              updateProgressUI();
              syncButtonStates();
              if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashDeleting", "Deleting...");
              logConsole(t("logConnectedToActive", `Connected to active background clean process at message ${deleteIndex}/${stats.total}...`, [String(deleteIndex), String(stats.total)]), "info");
            } else if (isPaused) {
              // Paused/interrupted job: prompt to resume
              showCustomConfirm(
                t("modalInterruptedTitle", "Interrupted Clean Detected"),
                t("modalInterruptedMsg", `An unfinished deletion task was found for "${activeChannel.name}" at index ${state.deleteIndex}/${state.stats.total}. Would you like to resume?`, [String(activeChannel.name), String(state.deleteIndex), String(state.stats.total)]),
                t("modalResumeDeletion", "Resume Deletion"),
                t("modalDiscardProgress", "Discard Progress"),
                async (confirmed) => {
                  if (confirmed) {
                    sendJobControl("RESUME_DELETION", activeTeam.id, activeChannel.id, (delivered, jobFound) => {
                      if (!jobFound) {
                        logConsole(t("logResumeFailed", "Could not resume — background service worker unavailable. Please reload Slack."), "error");
                        stopOperations(t("dashStatusError", "Error"));
                        return;
                      }
                      isRunning = true;
                      isPaused = false;
                      jobFinalized = false;
                      toggleInputs(true);
                      syncButtonStates();
                      logConsole(t("logResuming", `Resuming bulk deletion queue from message index ${deleteIndex + 1}...`, [String(deleteIndex + 1)]), "warn");
                      updateProgressUI();
                    });
                  } else {
                    // Route through sendJobControl like every other job-control call
                    // site (see its comment) instead of firing CANCEL_DELETION with no
                    // callback. isRunning/isPaused were already set true above just to
                    // drive this resume/discard prompt -- if this fire-and-forget send
                    // were lost, or background.js found no matching job, those flags
                    // would never get corrected and the dashboard would believe a job
                    // is running forever. So unlike the normal Cancel button (which
                    // keeps the running UI on failure so the user can retry a
                    // still-active job), "Discard Progress" always resets local state
                    // to not-running -- that's what the user asked for, and there's
                    // nothing here to protect against re-canceling.
                    sendJobControl("CANCEL_DELETION", activeTeam.id, activeChannel.id, (delivered, jobFound) => {
                      if (!delivered) {
                        logConsole(t("logCancelUnreachable", "Could not reach the background worker to cancel. The job may still be running — reload Slack and try again."), "error");
                      } else if (!jobFound) {
                        logConsole(t("logCancelNoJob", "Cancel reached the background worker, but found no matching job at this workspace/channel."), "warn");
                      } else {
                        logConsole(t("logCanceledByUser", "Bulk deletion canceled by user."), "warn");
                      }
                      stopOperations();
                      resetScanResultsUI();
                    });
                  }
                }
              );
            }
          }
        });
      } catch (err) {
        console.warn("SlackClean: Error recovering progress state:", err);
      }
    }

    // Focus return for the modals below: remember what had focus when a modal
    // opened (ignoring controls inside another modal, so chained dialogs return
    // to the original trigger) and put focus back once it closes.
    let modalOpener = null;
    function rememberModalOpener() {
      const active = shadowRoot.activeElement;
      if (active && !active.closest(".verification-overlay")) modalOpener = active;
    }
    function restoreModalOpenerFocus() {
      const el = modalOpener;
      modalOpener = null;
      if (el && el.isConnected && !el.disabled && isFocusableVisible(el)) el.focus();
    }

    // Custom non-blocking Alert Dialog helper
    function showCustomAlert(title, message, callback) {
      const modal = shadowRoot.getElementById("sc-alert-modal");
      if (!modal) return;
      rememberModalOpener();
      
      shadowRoot.getElementById("sc-alert-title").innerText = title;
      shadowRoot.getElementById("sc-alert-message").innerText = message;
      
      const okBtn = shadowRoot.getElementById("sc-alert-ok-btn");
      const newOkBtn = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOkBtn, okBtn);
      
      newOkBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        restoreModalOpenerFocus();
        if (callback) callback();
      });
      modal.classList.remove("hidden");
      newOkBtn.focus();
    }

    // Custom non-blocking Confirmation Dialog helper (prevents accidental confirmation by default-focusing cancel)
    function showCustomConfirm(title, message, okText, cancelText, callback) {
      const modal = shadowRoot.getElementById("sc-confirm-modal");
      if (!modal) return;
      rememberModalOpener();

      shadowRoot.getElementById("sc-confirm-title").innerText = title;
      shadowRoot.getElementById("sc-confirm-message").innerText = message;

      const okBtn = shadowRoot.getElementById("sc-confirm-ok-btn");
      okBtn.innerText = okText || t("dashConfirm", "Confirm");
      const newOkBtn = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOkBtn, okBtn);

      const cancelBtn = shadowRoot.getElementById("sc-confirm-cancel-btn");
      cancelBtn.innerText = cancelText || t("dashCancel", "Cancel");
      const newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

      newOkBtn.addEventListener("click", (e) => {
        // Confirm is what starts deletions/cancels: only a real user gesture counts.
        if (!e.isTrusted) return;
        modal.classList.add("hidden");
        restoreModalOpenerFocus();
        callback(true);
      });
      newCancelBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        restoreModalOpenerFocus();
        callback(false);
      });
      modal.classList.remove("hidden");
      newCancelBtn.focus();
    }

    // Custom non-blocking single-text-input Prompt Dialog helper (e.g. naming a preset).
    // callback receives the trimmed value, or null if cancelled.
    function showCustomPrompt(title, message, placeholder, callback) {
      const modal = shadowRoot.getElementById("sc-prompt-modal");
      if (!modal) return;
      rememberModalOpener();

      shadowRoot.getElementById("sc-prompt-title").innerText = title;
      shadowRoot.getElementById("sc-prompt-message").innerText = message || "";

      const input = shadowRoot.getElementById("sc-prompt-input");
      input.value = "";
      input.placeholder = placeholder || "";

      const okBtn = shadowRoot.getElementById("sc-prompt-ok-btn");
      const newOkBtn = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOkBtn, okBtn);
      newOkBtn.disabled = true;

      const cancelBtn = shadowRoot.getElementById("sc-prompt-cancel-btn");
      const newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

      const onInput = () => {
        newOkBtn.disabled = input.value.trim().length === 0;
      };
      input.addEventListener("input", onInput);

      const finish = (value) => {
        input.removeEventListener("input", onInput);
        modal.classList.add("hidden");
        restoreModalOpenerFocus();
        callback(value);
      };

      newOkBtn.addEventListener("click", () => finish(input.value.trim()));
      newCancelBtn.addEventListener("click", () => finish(null));

      modal.classList.remove("hidden");
      input.focus();
    }

    // Saved Filter Presets ---------------------------------------------------
    // Presets capture every filter input EXCEPT the destructive/context-specific
    // ones (sender profile stays "me" by default is fine to include; the target
    // channel and delete queue itself are never part of a preset). Stored in
    // chrome.storage.local so they survive across Slack sessions/tabs.

    // Shows/hides the "days old" vs "custom range" rows to match the Date Threshold
    // select. Shared by the live change listener and by applyFilterFormState (loading
    // a saved preset), so both paths keep the visible rows in sync with the value.
    function updateDateFilterRows(val) {
      const daysRow = shadowRoot.getElementById("sc-date-days-row");
      const customRow = shadowRoot.getElementById("sc-date-custom-row");
      if (!daysRow || !customRow) return;

      if (val === "older_than") {
        daysRow.classList.remove("hidden");
        customRow.classList.add("hidden");
      } else if (val === "custom") {
        daysRow.classList.add("hidden");
        customRow.classList.remove("hidden");
      } else {
        daysRow.classList.add("hidden");
        customRow.classList.add("hidden");
      }
    }

    function readFilterFormState() {
      return {
        sender: shadowRoot.getElementById("sc-filter-sender").value,
        dateMode: shadowRoot.getElementById("sc-filter-date").value,
        days: shadowRoot.getElementById("sc-filter-days").value,
        startDate: shadowRoot.getElementById("sc-filter-start-date").value,
        endDate: shadowRoot.getElementById("sc-filter-end-date").value,
        text: shadowRoot.getElementById("sc-filter-text").value,
        invertText: shadowRoot.getElementById("sc-filter-invert-text").checked,
        threads: shadowRoot.getElementById("sc-filter-threads").checked,
        onlyAttachments: shadowRoot.getElementById("sc-filter-attachments").checked,
        skipPinned: shadowRoot.getElementById("sc-filter-skip-pinned").checked,
        delay: shadowRoot.getElementById("sc-filter-delay").value
      };
    }

    function applyFilterFormState(state) {
      if (!state) return;
      const setVal = (id, val) => {
        const el = shadowRoot.getElementById(id);
        if (el && val !== undefined) el.value = val;
      };
      const setChecked = (id, val) => {
        const el = shadowRoot.getElementById(id);
        if (el && val !== undefined) el.checked = !!val;
      };

      // A preset may narrow the sender to "me" but never widen it to "all": that
      // switch targets other people's messages and must be a deliberate choice
      // made in the form, not something a one-click preset load does silently.
      if (state.sender === "me") setVal("sc-filter-sender", "me");
      setVal("sc-filter-date", state.dateMode);
      setVal("sc-filter-days", state.days);
      setVal("sc-filter-start-date", state.startDate);
      setVal("sc-filter-end-date", state.endDate);
      setVal("sc-filter-text", state.text);
      setChecked("sc-filter-invert-text", state.invertText);
      setChecked("sc-filter-threads", state.threads);
      setChecked("sc-filter-attachments", state.onlyAttachments);
      setChecked("sc-filter-skip-pinned", state.skipPinned);
      setVal("sc-filter-delay", state.delay);

      // Sync the days/custom-range rows to the loaded mode instead of leaving
      // them showing whatever the previous selection had visible.
      updateDateFilterRows(state.dateMode);
    }

    async function loadFilterPresets() {
      try {
        const data = await chrome.storage.local.get(FILTER_PRESETS_STORAGE_KEY);
        const presets = data[FILTER_PRESETS_STORAGE_KEY];
        return Array.isArray(presets) ? presets : [];
      } catch (err) {
        console.warn("SlackClean: Error loading filter presets:", err);
        return [];
      }
    }

    async function saveFilterPresets(presets) {
      try {
        await chrome.storage.local.set({ [FILTER_PRESETS_STORAGE_KEY]: presets });
      } catch (err) {
        console.warn("SlackClean: Error saving filter presets:", err);
      }
    }

    function populatePresetSelect(presets) {
      const select = shadowRoot.getElementById("sc-preset-select");
      if (!select) return;
      const previousValue = select.value;

      while (select.options.length > 1) select.remove(1);

      presets.forEach(preset => {
        const opt = document.createElement("option");
        opt.value = preset.id;
        opt.textContent = preset.name;
        select.appendChild(opt);
      });

      // Keep the current selection if it still exists (e.g. after a save that
      // didn't change the list order), otherwise fall back to the placeholder.
      select.value = presets.some(p => p.id === previousValue) ? previousValue : "";
      const delBtn = shadowRoot.getElementById("sc-btn-preset-delete");
      if (delBtn) delBtn.classList.toggle("hidden", !select.value);
    }

    async function refreshPresetSelect() {
      const presets = await loadFilterPresets();
      populatePresetSelect(presets);
    }

    // Listens for SPA tab URL navigation changes via low-overhead checks (replaces CPU intensive MutationObservers)
    let lastUrl = window.location.href;
    function startUrlObserver() {
      // Guard against duplicate intervals if dashboard is re-opened
      if (urlObserverInterval) return;

      // This interval is intentionally never cleared -- not even when the
      // dashboard is closed (see hideDashboard, which only hides the host
      // element rather than destroying it). Its intended lifetime is the
      // content script's lifetime: URL changes must keep being tracked while
      // hidden so a reopened dashboard is instantly rebound to the current
      // channel instead of needing a fresh poll cycle to catch up. The poll
      // itself is cheap (1/sec, a string compare), so leaving it running is a
      // deliberate tradeoff, not an oversight.
      urlObserverInterval = setInterval(() => {
        if (window.location.href !== lastUrl) {
          const oldUrl = lastUrl;
          lastUrl = window.location.href;
          handleUrlChange(oldUrl, lastUrl);
        }
      }, URL_POLL_INTERVAL_MS); // polling costs virtually 0% CPU next to MutationObserver subtree tracking
    }

    // Sends a job-control message (PAUSE_DELETION/RESUME_DELETION/CANCEL_DELETION)
    // and normalizes background.js's response into two booleans instead of leaving
    // every call site to hand-roll (and, several of them did, forget) the same
    // check: `delivered` (false only if the message never reached background.js at
    // all -- chrome.runtime.lastError) and `jobFound` (background.js's own
    // `success: !!job` -- false when no job exists at this teamId/channelId, e.g.
    // right after a workspace/channel drift). `delivered && !jobFound` means the
    // control message was received but found nothing to act on: the real job, if
    // one exists, is still running unaffected under a different/stale key, so a
    // caller must NOT tell the user it was paused/resumed/cancelled in that case.
    function sendJobControl(type, teamId, channelId, callback) {
      // The worker broadcasts the cancelled-job JOB_UPDATE before it answers this
      // request, so mark the cancel as ours: otherwise that broadcast reads as a
      // job "stopped outside this tab" (see the JOB_UPDATE handler).
      if (type === "CANCEL_DELETION") localCancelPending = true;
      chrome.runtime.sendMessage({ type, teamId, channelId }, (res) => {
        if (type === "CANCEL_DELETION") setTimeout(() => { localCancelPending = false; }, 2000);
        const delivered = !chrome.runtime.lastError;
        const jobFound = delivered && !!res && !!res.success;
        callback(delivered, jobFound);
      });
    }

    // Follows Slack navigation. A running or paused job is bound (in the worker)
    // to the workspace/channel it was started in, so navigating elsewhere neither
    // pauses nor re-targets it: the dashboard stays pinned to the job's channel
    // until the job ends, then re-syncs to wherever the user is (resyncTargetToUrl).
    // With no job, the dashboard simply follows the user to the new conversation.
    let lastBoundNoticeKey = null;
    function handleUrlChange(oldUrl, newUrl) {
      const info = getActiveTeamInfo();
      if (!info) return;

      const leftTeam = activeTeam && info.team && info.team.id !== activeTeam.id;
      const leftChannel = activeChannel && info.channelId !== activeChannel.id;

      if (isRunning && (leftTeam || leftChannel)) {
        // Say it once per destination, not on every poll tick / hop.
        const noticeKey = `${info.team && info.team.id}_${info.channelId}`;
        if (noticeKey !== lastBoundNoticeKey) {
          lastBoundNoticeKey = noticeKey;
          const name = activeChannel ? activeChannel.name : "";
          logConsole(isPaused
            ? t("logPausedJobStaysBound", `The paused clean stays bound to "${name}". Resume or cancel it here at any time.`, [String(name)])
            : t("logJobContinuesInBackground", `The clean of "${name}" keeps running in the background while you browse. This dashboard keeps showing its progress.`, [String(name)]), "info");
        }
        return;
      }
      lastBoundNoticeKey = null;

      // Workspace (team) switch within the same tab — handle BEFORE channel logic,
      // since the channel id also changes and would otherwise be interpreted against
      // the stale workspace. activeTeam holds the credentials every operation uses.
      if (leftTeam) {
        if (shadowHost && shadowHost.style.display !== "none") {
          switchWorkspace(info);
        }
        return;
      }

      // No target adopted yet (dashboard was opened outside a conversation):
      // pick up the conversation as soon as the user navigates into one, so the
      // dashboard doesn't stay stuck on "No Conversation Active" until reopened.
      if (!activeChannel) {
        if (info.channelId && shadowHost && shadowHost.style.display !== "none") {
          logConsole(t("logConversationDetected", `Conversation detected: ${info.channelId}`, [String(info.channelId)]), "info");
          switchTargetChannel(info.channelId);
        }
        return;
      }

      if (leftChannel && info.channelId && shadowHost && shadowHost.style.display !== "none") {
        logConsole(t("logSyncingChannel", `Syncing workspace channel target details: ${info.channelId}`, [String(info.channelId)]), "info");
        switchTargetChannel(info.channelId);
      }
    }

    // Once a job has ended, point the (visible) dashboard back at the workspace/
    // conversation the user is actually looking at — it stayed pinned to the job's
    // channel while the job ran (see handleUrlChange).
    function resyncTargetToUrl() {
      if (isRunning || !shadowHost || shadowHost.style.display === "none") return;
      const info = getActiveTeamInfo();
      if (!info) return;
      if (activeTeam && info.team && info.team.id !== activeTeam.id) {
        switchWorkspace(info);
      } else if (info.channelId && (!activeChannel || info.channelId !== activeChannel.id)) {
        switchTargetChannel(info.channelId);
      }
    }

    // Attaches action listeners to injected components. Split into one function
    // per concern (mechanical extraction only, no behavior change) so a merge
    // conflict or review of one area (e.g. presets) doesn't have to wade through
    // everything else this used to be one 350+ line function.
    function setupUIListeners() {
      setupHeaderControls();
      setupFilterControls();
      setupScanDeleteControls();
      setupSelectAllControl();
      setupPresetControls();
      setupConsoleControls();
      setupVerifyModalControls();
      setupThemeControls();
      setupKeyboardNav();
    }

    // Minimize / maximize / close the dashboard overlay.
    function setupHeaderControls() {
      const getEl = (id) => shadowRoot.getElementById(id);

      // Minimize Overlay View to bottom floating widget
      const modalRoot = dashboardEl.querySelector(".dashboard-modal");
      getEl("sc-btn-minimize").addEventListener("click", () => {
        dashboardEl.classList.add("minimized");
        // The floating widget doesn't block Slack, so it isn't modal.
        if (modalRoot) modalRoot.setAttribute("aria-modal", "false");
        logConsole(t("logMinimized", "Dashboard minimized to floating widget."), "info");
      });

      // Maximize Overlay View to full-screen view
      getEl("sc-btn-maximize").addEventListener("click", () => {
        dashboardEl.classList.remove("minimized");
        if (modalRoot) modalRoot.setAttribute("aria-modal", "true");
        logConsole(t("logMaximized", "Dashboard maximized to full view."), "info");
      });

      // Close Dashboard (Hide host in DOM instead of destroying). Closing never
      // cancels anything: a running job keeps going in the background and a paused
      // one stays paused. Cancel is its own explicit button.
      getEl("sc-btn-close").addEventListener("click", () => {
        if (isRunning) {
          logConsole(isPaused
            ? t("logClosedJobPaused", "Dashboard closed. The paused clean stays paused — reopen Erasechat to resume or cancel it.")
            : t("logClosedJobRunning", "Dashboard closed. The clean keeps running in the background — reopen Erasechat to follow it."), "info");
        }
        hideDashboard();
      });

      function hideDashboard() {
        // Only hides the host element -- urlObserverInterval (see
        // startUrlObserver) is deliberately left running so URL changes are
        // still tracked while hidden and the dashboard can rebind instantly
        // if reopened.
        dashboardEl.classList.remove("visible");
        setTimeout(() => {
          if (shadowHost) {
            shadowHost.style.display = "none";
          }
        }, 300);
      }
    }

    // Date-range filter mode toggle (older-than / custom / all-time rows).
    function setupFilterControls() {
      const getEl = (id) => shadowRoot.getElementById(id);

      getEl("sc-filter-date").addEventListener("change", (e) => {
        updateDateFilterRows(e.target.value);
      });
    }

    // Scan / Delete (Start-Pause-Resume) / Cancel buttons.
    function setupScanDeleteControls() {
      const getEl = (id) => shadowRoot.getElementById(id);

      // Scan Button Event
      getEl("sc-btn-scan").addEventListener("click", () => {
        runScan();
      });

      // Delete Action Button Event (Toggle Start/Pause/Resume). Destructive, so
      // only a real user gesture counts — never a synthetic .click().
      getEl("sc-btn-delete").addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        handleDeleteClick();
      });

      // Cancel Action Event
      getEl("sc-btn-cancel").addEventListener("click", () => {
        showCustomConfirm(
          t("modalCancelSequenceTitle", "Cancel Cleaning Sequence"),
          t("modalCancelSequenceMsg", "Are you sure you want to cancel the deletion process? Remaining messages will not be deleted."),
          t("modalStopDeletion", "Stop Deletion"),
          t("modalContinueDeleting", "Continue Deleting"),
          (confirmed) => {
            if (confirmed) {
              sendJobControl("CANCEL_DELETION", activeTeam.id, activeChannel.id, (delivered, jobFound) => {
                if (!delivered) {
                  // Cancel didn't reach the worker — the job may still be deleting.
                  // Keep the running UI so the user can retry rather than being told
                  // it stopped when it may not have.
                  logConsole(t("logCancelUnreachable", "Could not reach the background worker to cancel. The job may still be running — reload Slack and try again."), "error");
                  showCustomAlert(
                    t("modalCouldNotCancelTitle", "Could Not Cancel"),
                    t("modalCouldNotCancelMsg", "The cancel request didn't reach the background worker, so the clean may still be running. Reload the Slack page and try again.")
                  );
                  return;
                }
                if (!jobFound) {
                  logConsole(t("logCancelNoJob", "Cancel reached the background worker, but found no matching job at this workspace/channel."), "warn");
                } else {
                  logConsole(t("logCanceledByUser", "Bulk deletion canceled by user."), "warn");
                }
                announce(t("srJobCanceled", "Deletion canceled."));
                stopOperations(t("dashStatusCanceled", "Canceled"));
                // Prune already-deleted messages from the checklist, same as the
                // "Finished" path -- otherwise clicking Delete again without a fresh
                // scan resubmits everything, including whatever this job already
                // deleted before the cancel landed.
                resetScanResultsUI();
                resyncTargetToUrl();
              });
            }
          }
        );
      });
    }

    // Select-all checkbox above the scan results list.
    function setupSelectAllControl() {
      const getEl = (id) => shadowRoot.getElementById(id);

      getEl("sc-select-all").addEventListener("change", (e) => {
        const checked = e.target.checked;
        const checkboxes = shadowRoot.querySelectorAll(".msg-checkbox");
        checkboxes.forEach(cb => cb.checked = checked);
        updateScanBadgeCount();
      });
    }

    // Saved filter presets: load selection, save current filters, delete selected.
    function setupPresetControls() {
      const getEl = (id) => shadowRoot.getElementById(id);

      getEl("sc-preset-select").addEventListener("change", async (e) => {
        const presetId = e.target.value;
        const delBtn = getEl("sc-btn-preset-delete");
        if (delBtn) delBtn.classList.toggle("hidden", !presetId);
        if (!presetId) return;

        const presets = await loadFilterPresets();
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
          applyFilterFormState(preset);
          logConsole(t("logPresetLoaded", `Loaded filter preset "${preset.name}".`, [String(preset.name)]), "info");
        }
      });

      getEl("sc-btn-preset-save").addEventListener("click", () => {
        showCustomPrompt(
          t("dashPromptTitle", "Name This Preset"),
          t("modalSavePresetMsg", "Save the current filter settings for reuse later."),
          t("modalSavePresetPlaceholder", "e.g. Older than 90 days, no attachments"),
          async (name) => {
            if (!name) return;

            const presets = await loadFilterPresets();
            const state = readFilterFormState();
            const existing = presets.find(p => p.name.toLowerCase() === name.toLowerCase());

            if (existing) {
              Object.assign(existing, state);
            } else {
              if (presets.length >= MAX_FILTER_PRESETS) {
                showCustomAlert(
                  t("modalPresetLimitTitle", "Preset Limit Reached"),
                  t("modalPresetLimitMsg", `You already have ${MAX_FILTER_PRESETS} saved presets, the maximum. Delete one before saving another.`, [String(MAX_FILTER_PRESETS)])
                );
                return;
              }
              presets.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, ...state });
            }

            // Post-hoc cap enforcement: the length check above is a plain read-then-
            // write with no transaction (chrome.storage.local has none), so two tabs
            // saving a preset within the same instant could both pass it and each add
            // one, briefly landing above MAX_FILTER_PRESETS. Trimming the oldest
            // entries here — applied on every save — turns that into a transient blip
            // (corrected by whichever save lands second) rather than a permanent
            // overshoot, since the cap is re-enforced every time regardless of how the
            // in-memory `presets` array arrived at this point.
            while (presets.length > MAX_FILTER_PRESETS) {
              presets.shift();
            }

            await saveFilterPresets(presets);
            populatePresetSelect(presets);
            getEl("sc-preset-select").value = existing ? existing.id : presets[presets.length - 1].id;
            getEl("sc-btn-preset-delete").classList.remove("hidden");
            logConsole(t("logPresetSaved", `Saved filter preset "${name}".`, [String(name)]), "info");
          }
        );
      });

      getEl("sc-btn-preset-delete").addEventListener("click", () => {
        const select = getEl("sc-preset-select");
        const presetId = select.value;
        if (!presetId) return;

        const selectedLabel = select.options[select.selectedIndex]?.text || "this preset";
        showCustomConfirm(
          t("modalDeletePresetTitle", "Delete Preset?"),
          t("modalDeletePresetMsg", `Remove the saved preset "${selectedLabel}"? This cannot be undone.`, [String(selectedLabel)]),
          t("dashPresetDelete", "Delete"),
          t("dashCancel", "Cancel"),
          async (confirmed) => {
            if (!confirmed) return;
            const presets = await loadFilterPresets();
            const remaining = presets.filter(p => p.id !== presetId);
            await saveFilterPresets(remaining);
            populatePresetSelect(remaining);
            logConsole(t("logPresetDeleted", `Deleted filter preset "${selectedLabel}".`, [String(selectedLabel)]), "info");
          }
        );
      });
    }

    // Clear/export the live execution log, and export scanned messages as CSV.
    function setupConsoleControls() {
      const getEl = (id) => shadowRoot.getElementById(id);

      // Clear Logs (using DOM construction instead of innerHTML for security)
      getEl("sc-btn-clear-logs").addEventListener("click", () => {
        if (ui.consoleLog) {
          while (ui.consoleLog.firstChild) {
            ui.consoleLog.removeChild(ui.consoleLog.firstChild);
          }
          const cleared = document.createElement("div");
          cleared.className = "console-line info";
          cleared.textContent = t("logsClearedByUser", "[Logs cleared by user]");
          ui.consoleLog.appendChild(cleared);
        }
      });

      // Export/Download Logs
      getEl("sc-btn-download-logs").addEventListener("click", () => {
        const lines = shadowRoot.querySelectorAll(".console-line");
        let content = "";
        lines.forEach(l => {
          content += l.innerText + "\n";
        });

        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `erasechat_log_${activeChannel ? activeChannel.name : "export"}_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      });

      // Export Messages as CSV
      getEl("sc-btn-export-messages").addEventListener("click", () => {
        if (scanResults.length === 0) return;

        const blob = new Blob([buildMessagesCsv(scanResults, userCache)], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `erasechat_messages_${activeChannel ? activeChannel.name : "export"}_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        logConsole(t("logExportedCsv", `Exported ${scanResults.length} messages to CSV.`, [String(scanResults.length)]), "info");
      });
    }

    // The large-delete (type-DELETE-to-confirm) verification modal.
    function setupVerifyModalControls() {
      const getEl = (id) => shadowRoot.getElementById(id);

      getEl("sc-verify-input").addEventListener("input", (e) => {
        const confirmBtn = getEl("sc-verify-confirm-btn");
        confirmBtn.disabled = e.target.value.trim() !== "DELETE";
      });

      getEl("sc-verify-cancel-btn").addEventListener("click", () => {
        getEl("sc-verify-modal").classList.add("hidden");
        getEl("sc-verify-input").value = "";
        restoreModalOpenerFocus();
      });

      getEl("sc-verify-confirm-btn").addEventListener("click", (e) => {
        // Starts a bulk delete: only a real user gesture counts.
        if (!e.isTrusted) return;
        getEl("sc-verify-confirm-btn").disabled = true;
        getEl("sc-verify-modal").classList.add("hidden");
        getEl("sc-verify-input").value = "";
        restoreModalOpenerFocus();
        startDeletionProcess();
      });
    }

    // Theme picker bubbles.
    function setupThemeControls() {
      shadowRoot.querySelectorAll(".theme-bubble").forEach(btn => {
        btn.addEventListener("click", (e) => {
          const themeName = e.currentTarget.getAttribute("data-theme");
          setTheme(themeName);
        });
      });
    }

    // True when the element is actually rendered: not inside a .hidden/[hidden]
    // subtree and laid out (offsetParent is null for display:none ancestors;
    // position:fixed elements have a null offsetParent too, so allow those).
    function isFocusableVisible(el) {
      if (el.closest(".hidden, [hidden]")) return false;
      if (el.offsetParent !== null) return true;
      return getComputedStyle(el).position === "fixed";
    }

    // Keyboard focus trap inside Shadow DOM for Accessibility (a11y) compliance (Modal Scoped)
    function setupKeyboardNav() {
      shadowRoot.addEventListener("keydown", (e) => {
        if (dashboardEl && dashboardEl.classList.contains("minimized")) return;

        // Escape dismisses the topmost open modal. We click the existing
        // cancel/OK control so the modal's real handler (and its callback) runs,
        // rather than just hiding the element and orphaning the callback.
        if (e.key === "Escape") {
          const alertModal = shadowRoot.getElementById("sc-alert-modal");
          const confirmModal = shadowRoot.getElementById("sc-confirm-modal");
          const verifyModal = shadowRoot.getElementById("sc-verify-modal");
          const promptModal = shadowRoot.getElementById("sc-prompt-modal");

          if (alertModal && !alertModal.classList.contains("hidden")) {
            shadowRoot.getElementById("sc-alert-ok-btn")?.click();
            e.preventDefault();
          } else if (confirmModal && !confirmModal.classList.contains("hidden")) {
            shadowRoot.getElementById("sc-confirm-cancel-btn")?.click();
            e.preventDefault();
          } else if (verifyModal && !verifyModal.classList.contains("hidden")) {
            shadowRoot.getElementById("sc-verify-cancel-btn")?.click();
            e.preventDefault();
          } else if (promptModal && !promptModal.classList.contains("hidden")) {
            shadowRoot.getElementById("sc-prompt-cancel-btn")?.click();
            e.preventDefault();
          }
          return;
        }

        if (e.key === "Tab") {
          let containerEl = shadowRoot;

          const alertModal = shadowRoot.getElementById("sc-alert-modal");
          const confirmModal = shadowRoot.getElementById("sc-confirm-modal");
          const verifyModal = shadowRoot.getElementById("sc-verify-modal");
          const promptModal = shadowRoot.getElementById("sc-prompt-modal");

          if (alertModal && !alertModal.classList.contains("hidden")) {
            containerEl = alertModal;
          } else if (confirmModal && !confirmModal.classList.contains("hidden")) {
            containerEl = confirmModal;
          } else if (verifyModal && !verifyModal.classList.contains("hidden")) {
            containerEl = verifyModal;
          } else if (promptModal && !promptModal.classList.contains("hidden")) {
            containerEl = promptModal;
          }

          const focusableSelectors = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
          // Skip controls in hidden modals/rows — otherwise Tab from the last
          // visible control "wraps" onto an invisible button and focus vanishes.
          const focusables = Array.from(containerEl.querySelectorAll(focusableSelectors)).filter(isFocusableVisible);
          if (focusables.length === 0) return;

          const firstEl = focusables[0];
          const lastEl = focusables[focusables.length - 1];
          const activeEl = shadowRoot.activeElement;

          if (e.shiftKey) { // Shift + Tab
            if (activeEl === firstEl || !focusables.includes(activeEl)) {
              lastEl.focus();
              e.preventDefault();
            }
          } else { // Tab
            if (activeEl === lastEl || !focusables.includes(activeEl)) {
              firstEl.focus();
              e.preventDefault();
            }
          }
        }
      });
    }


    // Scans conversation history using filters delegated to background service worker
    async function runScan() {
      if (!activeChannel) return;
      
      const targetChannelId = activeChannel.id;
      const targetTeamId = activeTeam.id;
      const scanBtn = shadowRoot.getElementById("sc-btn-scan");
      scanBtn.disabled = true;
      scanBtn.innerText = t("dashScanning", "Scanning...");
      toggleInputs(true);
      // Disable the delete button for the duration of the scan. scanResults is
      // cleared just below, so any click now would build an empty/partial queue;
      // renderScanResults re-enables it once fresh results are fully rendered.
      if (ui.btnDelete) ui.btnDelete.disabled = true;
      
      logConsole(t("logScanInitiating", `Initiating message scan in current target: ${activeChannel.name}...`, [String(activeChannel.name)]), "info");
      
      // Read filter inputs
      const filterSender = shadowRoot.getElementById("sc-filter-sender").value;
      const filterDate = shadowRoot.getElementById("sc-filter-date").value;
      const filterText = shadowRoot.getElementById("sc-filter-text").value.trim();
      const includeThreads = shadowRoot.getElementById("sc-filter-threads").checked;
      const onlyAttachments = shadowRoot.getElementById("sc-filter-attachments").checked;
      const invertText = shadowRoot.getElementById("sc-filter-invert-text").checked;
      const excludePinned = shadowRoot.getElementById("sc-filter-skip-pinned").checked;

      // Warn up front if the background worker's real isSafeRegex() is expected to
      // reject this pattern — it would otherwise fall back to a literal substring
      // match on the raw pattern text with no explanation, near-guaranteeing 0
      // results and leaving the user to wonder why. This is an advisory check only
      // (see isSafeRegexPreview above); the actual decision is always made by
      // shared-filters.js in the background worker.
      const patternIssue = checkTextFilterPattern(filterText);
      if (patternIssue) {
        const warnMsg = patternIssue === "unsafe"
          ? t("warnRegexUnsafe", `Your /regex/ text filter ("${filterText}") looks unsafe (too long, or shaped like a runaway backtracking pattern) and will be treated as a plain literal substring instead of a regex — it will likely match nothing. Simplify the pattern if you intended it as a regex.`, [String(filterText)])
          : t("warnRegexInvalid", `Your /regex/ text filter ("${filterText}") isn't a valid regular expression and will be treated as a plain literal substring instead — it will likely match nothing. Check the pattern syntax.`, [String(filterText)]);
        logConsole(warnMsg, "warn");
        showCustomAlert(t("modalRegexRejectedTitle", "Text Filter Pattern Rejected"), warnMsg);
      }

      const rangeResult = computeScanTimeRange(filterDate, {
        days: shadowRoot.getElementById("sc-filter-days").value,
        startVal: shadowRoot.getElementById("sc-filter-start-date").value,
        endVal: shadowRoot.getElementById("sc-filter-end-date").value
      });
      if (!rangeResult.ok) {
        if (rangeResult.error === "incomplete") {
          logConsole(t("logDateRangeIncomplete", "Error: Custom date range requires both a start and an end date."), "error");
          showCustomAlert(t("modalIncompleteDateRangeTitle", "Incomplete Date Range"), t("modalIncompleteDateRangeMsg", "Please choose both a Start Date and an End Date for a custom range."));
        } else {
          logConsole(t("logDateRangeInvalid", "Error: Start Date cannot be after End Date."), "error");
          showCustomAlert(t("modalInvalidDateRangeTitle", "Invalid Date Range"), t("modalInvalidDateRangeMsg", "Start Date must be before or equal to End Date."));
        }
        scanBtn.disabled = false;
        scanBtn.innerText = t("dashScan", "Scan Messages");
        toggleInputs(false);
        return;
      }
      const { oldest, latest } = rangeResult;

      scanResults = [];
      logConsole(t("logQuerying", "Querying Slack APIs in background..."), "info");

      // Guard the scan against a response that never arrives (SW suspended mid-scan).
      // `scanSettled` ensures the timeout and the real callback don't both restore
      // the UI; a response that arrives after the timeout is still applied below
      // (as long as no newer scan has started), so a slow scan isn't simply lost.
      const myGeneration = ++scanGeneration;
      let scanSettled = false;
      let busyNoticeShown = false;
      const restoreScanUI = () => {
        scanBtn.disabled = false;
        scanBtn.innerText = t("dashScan", "Scan Messages");
        toggleInputs(false);
      };
      const scanTimeout = setTimeout(() => {
        if (scanSettled) return;
        scanSettled = true;
        restoreScanUI();
        // Deliberately does NOT claim the scan stopped: this timeout only means no
        // response arrived in time. The worker may have been suspended (scan really
        // is gone) or may still be paginating a heavily-throttled channel. If it is
        // still running, its result is shown here when it arrives, and re-running
        // Scan with the same filters joins that sweep (or gets its cached result)
        // instead of starting a second one.
        scanTimedOutKey = `${activeTeam.id}_${targetChannelId}`;
        logConsole(t("logScanTimeoutWaiting", "No scan result after 2 minutes. The background worker may have been suspended, or may still be working through a throttled channel — if it finishes, the results will appear here. Re-running Scan with the same filters picks up that result instead of starting over."), "error");
        showCustomAlert(
          t("modalScanTimeoutTitle", "Scan Did Not Finish In Time"),
          t("modalScanTimeoutWaitingMsg", "No result came back within 2 minutes. The background worker was either suspended or is still working through a heavily rate-limited channel.\n\nIf it is still running, the results will appear here when it finishes. Re-running Scan with the same filters reuses that result. Nothing is deleted either way.")
        );
      }, SCAN_TIMEOUT_MS);

      const scanRequest = {
        type: "RUN_SCAN",
        teamId: activeTeam.id,
        channelId: targetChannelId,
        oldest,
        latest,
        includeThreads,
        filterSender,
        filterText,
        onlyAttachments,
        invertText,
        excludePinned,
        userId: activeTeam.userId,
        // Reuse the worker's just-finished result only when retrying a scan that
        // timed out here; a normal Scan click always re-sweeps.
        allowCached: scanTimedOutKey === `${activeTeam.id}_${targetChannelId}`
      };
      scanTimedOutKey = null;

      const sendScan = () => chrome.runtime.sendMessage(scanRequest, (response) => {
        // A newer scan superseded this one; its own callback owns the UI.
        if (myGeneration !== scanGeneration) return;

        if (!chrome.runtime.lastError && response && response.error === "scan_in_progress" && !scanSettled) {
          // Another scan of this conversation (different filters) is still
          // sweeping. Wait for it to finish rather than failing this one.
          if (!busyNoticeShown) {
            busyNoticeShown = true;
            logConsole(t("logScanWaitingForOther", "Another scan of this conversation is still running. Waiting for it to finish, then this scan will start..."), "warn");
          }
          setTimeout(() => {
            if (!scanSettled && myGeneration === scanGeneration) sendScan();
          }, SCAN_BUSY_RETRY_MS);
          return;
        }

        const lateResult = scanSettled;
        if (!scanSettled) {
          scanSettled = true;
          clearTimeout(scanTimeout);
          restoreScanUI();
        }

        if (chrome.runtime.lastError) {
          if (!lateResult) logConsole(t("logScanApiFailed", `Scan API call failed: ${chrome.runtime.lastError.message}`, [chrome.runtime.lastError.message]), "error");
          return;
        }

        // A result arriving after the timeout is only useful if nothing has
        // happened since: no job started, no newer results on screen.
        if (lateResult && (isRunning || !response || !response.ok)) return;

        // Channel/workspace Race Protection: discard stale results if the user
        // navigated away during the scan. Check BOTH activeChannel/activeTeam AND
        // intendedChannelId/intendedTeamId — activeChannel is reassigned only
        // after an await in loadActiveChannel, so during a switch it still holds
        // the OLD channel and would wrongly pass this guard; intendedChannelId
        // flips synchronously the instant the switch is detected, closing that
        // race (a scan started in A finishing while switching to B is now
        // correctly dropped). The team-side check closes the identical race for
        // a WORKSPACE switch: activeTeam IS reassigned synchronously (see
        // switchWorkspace), so it alone would wrongly pass this guard during the
        // async work switchWorkspace still has in flight — intendedTeamId is
        // required too, exactly mirroring the channel-side reasoning.
        if ((activeChannel && activeChannel.id !== targetChannelId) ||
            (intendedChannelId && intendedChannelId !== targetChannelId) ||
            (activeTeam && activeTeam.id !== targetTeamId) ||
            (intendedTeamId && intendedTeamId !== targetTeamId)) {
          logConsole(t("logScanStale", "Channel or workspace changed during active scan. Discarding stale scan results."), "warn");
          return;
        }

        if (response && response.ok) {
          if (lateResult) {
            logConsole(t("logScanLateResult", "The slow scan finished after all — showing its results now."), "info");
          }
          if (response.cached) {
            const ageMin = Math.max(0, Math.round((Date.now() - (response.cachedAt || Date.now())) / 60000));
            logConsole(t("logScanCached", `Reusing the result of the identical scan that finished ${ageMin} min ago (no new Slack requests).`, [String(ageMin)]), "info");
          }
          scanResults = response.results || [];
          // Tag the results with the channel/workspace they were scanned in, so
          // the delete path can refuse to dispatch them against a different
          // target (belt-and-suspenders alongside the guard above and the
          // queue's queueChannelId/queueTeamId pin).
          scanResultsChannelId = targetChannelId;
          scanResultsTeamId = targetTeamId;
          // Two distinct truncation reasons — surface both honestly:
          //  - capped:        hit the 5,000 matched-results ceiling
          //  - moreAvailable: hit the page-scan limit while older messages remained
          //                   UNexamined (previously silent — users assumed full coverage)
          const wasCapped = !!response.capped;
          const moreAvailable = !!response.moreAvailable;
          const truncated = wasCapped || moreAvailable;

          const note = wasCapped
            ? t("logScanCappedNote", " (5,000-result limit reached — narrow your filters for more)")
            : (moreAvailable ? t("logScanMoreNote", " (scan depth limit reached — older messages were NOT examined)") : "");
          logConsole(t("logScanComplete", `Scan complete. Matches found: ${scanResults.length}`, [String(scanResults.length)]) + note, truncated ? "warn" : "info");
          announce(t("srScanComplete", `Scan complete. ${scanResults.length} messages found.`, [String(scanResults.length)]));

          if (response.threadLookbackLimited) {
            logConsole(t("logScanThreadLookbackNote", "Note: thread replies are checked for threads started up to 30 days before your start date. Replies under older threads were not checked."), "warn");
          }

          // A valid /regex/ filter only ever runs against the first 300 characters
          // of a message's filterable text (shared-filters.js's MAX_REGEX_INPUT, a
          // hard ReDoS backstop). That cap can silently under-match ordinary long
          // messages, so report it when it actually happened.
          if (response.regexTruncatedCount > 0) {
            logConsole(
              t("logRegexTruncatedNote", `Note: your /regex/ text filter only checks the first 300 characters of a message (a fixed safety limit). ${response.regexTruncatedCount} scanned message(s) were longer than that, so a match past character 300 would have been missed.`, [String(response.regexTruncatedCount)]),
              "warn"
            );
          }

          // Pre-fetch any unknown users so the UI renders real names instead of raw IDs
          const unknownUsers = new Set();
          scanResults.forEach(msg => {
            if (msg.user && !userCache[msg.user]) unknownUsers.add(msg.user);
          });
          if (unknownUsers.size > 0) {
            logConsole(t("logFetchingNames", `Fetching names for ${unknownUsers.size} unknown users...`, [String(unknownUsers.size)]), "info");
            Promise.all(Array.from(unknownUsers).map(uid => getUserName(uid))).then(() => {
              renderScanResults();
            });
          } else {
            renderScanResults();
          }

          if (wasCapped) {
            showCustomAlert(
              t("modalScanCappedTitle", "Scan Results Capped"),
              t("modalScanCappedMsg", `The scan returned ${scanResults.length} messages, the maximum per scan. There may be additional matching messages. Use a narrower date range or text filter, delete this batch, then scan again.`, [String(scanResults.length)])
            );
          } else if (moreAvailable) {
            showCustomAlert(
              t("modalMoreNotScannedTitle", "Not All Messages Were Scanned"),
              t("modalMoreNotScannedMsg", `This channel has more history than a single scan examines, so only its most recent messages were checked (${scanResults.length} matched). Older matching messages exist but were NOT scanned. Use a date range to scan older messages, or delete this batch and scan again.`, [String(scanResults.length)])
            );
          }
        } else {
          const reason = response ? (response.message || response.error || "Unknown error") : t("dashNoBgResponse", "No response from the background worker");
          logConsole(t("logScanRuntimeError", `Scan runtime error: ${reason}`, [String(reason)]), "error");
          showCustomAlert(t("modalScanFailedTitle", "Scan Failed"), t("modalScanFailedMsg", `The scan could not be completed: ${reason}`, [String(reason)]));
        }
      });
      sendScan();
    }

    // NOTE: message filtering/qualification and ReDoS-safe regex checks live in
    // shared-filters.js and run in the background service worker (see runScanInBg).
    // The content script intentionally does NOT reimplement that logic — it only
    // renders the results the background returns.

    // Render scanned results in virtual chunk loops via requestAnimationFrame (avoids blocking main thread)
    function renderScanResults() {
      const container = shadowRoot.getElementById("sc-results-list");
      const delBtn = ui.btnDelete;
      const countEl = shadowRoot.getElementById("sc-scan-count");
      const exportBtn = shadowRoot.getElementById("sc-btn-export-messages");

      // Supersede any in-flight render loop from a previous scan.
      const gen = ++renderGeneration;
      isRendering = true;

      // The delete button and CSV export are sourced from the DOM (checked
      // checkboxes / scanResults). Keep them DISABLED until the chunked render
      // finishes — otherwise a click on a large result set would build a queue
      // from only the ~50 checkboxes rendered so far, silently under-deleting.
      if (delBtn) delBtn.disabled = true;
      if (exportBtn) exportBtn.disabled = true;

      if (scanResults.length === 0) {
        isRendering = false;
        const nm = document.createElement("div");
        nm.className = "no-messages";
        nm.textContent = t("dashNoMatches", "Zero messages matched the active filters. Try widening criteria.");
        container.innerHTML = "";
        container.appendChild(nm);
        if (countEl) countEl.innerText = t("dashItemsFound", "0 items found", ["0"]);
        return;
      }

      container.innerHTML = "";

      let currentIdx = 0;
      const chunkSize = RENDER_CHUNK_SIZE;

      // Render cards in requestAnimationFrame chunks to maintain 60 FPS
      function renderChunk() {
        // A newer scan started — abandon this stale loop.
        if (gen !== renderGeneration) return;
        const fragment = document.createDocumentFragment();
        const limit = Math.min(currentIdx + chunkSize, scanResults.length);

        for (let i = currentIdx; i < limit; i++) {
          const msg = scanResults[i];
          // Some messages (integrations/system posts) have no `user`; never let
          // that throw and abort the whole render chunk.
          const authorName = userCache[msg.user] || msg.user || t("dashUnknown", "Unknown");
          const initials = authorName.substring(0, 2).toUpperCase();
          
          const card = document.createElement("div");
          card.className = `msg-card ${msg.isThreadReply ? "thread-reply-card" : ""}`;
          
          if (msg.isThreadReply) {
            const connector = document.createElement("div");
            connector.className = "thread-branch-connector";
            card.appendChild(connector);
          }

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "msg-checkbox";
          checkbox.setAttribute("data-idx", String(i));
          // Follow the current "Select All" state (read fresh each card) so cards
          // rendered AFTER the user toggles Select All mid-render stay consistent
          // with the ones already on screen, rather than always defaulting to checked.
          const selectAllEl = shadowRoot.getElementById("sc-select-all");
          checkbox.checked = selectAllEl ? selectAllEl.checked : true;
          checkbox.addEventListener("change", updateScanBadgeCount);
          card.appendChild(checkbox);

          const avatar = document.createElement("div");
          avatar.className = "msg-avatar";
          avatar.style.backgroundColor = stringToColor(msg.user);
          avatar.textContent = initials;
          card.appendChild(avatar);

          const wrapper = document.createElement("div");
          wrapper.className = "msg-content-wrapper";

          const meta = document.createElement("div");
          meta.className = "msg-meta";

          const authorSpan = document.createElement("span");
          authorSpan.className = "msg-author";
          authorSpan.textContent = authorName;
          meta.appendChild(authorSpan);

          const timeSpan = document.createElement("span");
          timeSpan.className = "msg-time";
          timeSpan.textContent = msg.time;
          meta.appendChild(timeSpan);

          if (msg.isThreadReply) {
            const threadBadge = document.createElement("span");
            threadBadge.className = "msg-badge-thread";
            threadBadge.textContent = t("dashBadgeThreadReply", "Thread Reply");
            meta.appendChild(threadBadge);
          } else if (msg.replyCount > 0) {
            const rootBadge = document.createElement("span");
            rootBadge.className = "msg-badge-thread";
            rootBadge.style.backgroundColor = "var(--color-pink)";
            rootBadge.style.color = "white";
            // Deleting a thread root does NOT delete its replies: Slack keeps them
            // and shows the parent as "This message was deleted."
            rootBadge.textContent = t("dashBadgeThreadRoot", `Thread root (${msg.replyCount} replies stay; parent shows as deleted)`, [String(msg.replyCount)]);
            meta.appendChild(rootBadge);
          }

          wrapper.appendChild(meta);

          const textDiv = document.createElement("div");
          textDiv.className = "msg-text";
          textDiv.textContent = msg.text || t("dashEmptyMessage", "[Empty Message]");
          wrapper.appendChild(textDiv);

          if (msg.files && msg.files.length > 0) {
            const fileDiv = document.createElement("div");
            fileDiv.style.fontSize = "10px";
            fileDiv.style.color = "var(--color-pink)";
            fileDiv.style.marginTop = "2px";
            fileDiv.textContent = "📎 " + t("dashContainsFiles", `Contains ${msg.files.length} attached files`, [String(msg.files.length)]);
            wrapper.appendChild(fileDiv);
          }

          card.appendChild(wrapper);
          fragment.appendChild(card);
        }

        container.appendChild(fragment);
        currentIdx = limit;

        if (currentIdx < scanResults.length) {
          requestAnimationFrame(renderChunk);
        } else {
          // Render complete — every checkbox now exists, so it's safe to enable
          // the actions that read them.
          isRendering = false;
          updateScanBadgeCount();
          if (exportBtn) exportBtn.disabled = false;
          if (delBtn) {
            delBtn.disabled = false;
            delBtn.innerText = t("dashStartDeleting", "Start Deleting");
            delBtn.className = "dashboard-btn btn-delete";
          }
        }
      }

      if (countEl) countEl.innerText = t("dashItemsFound", `${scanResults.length} items found`, [String(scanResults.length)]);

      renderChunk();
    }

    // Display count changes based on manual unchecks
    function updateScanBadgeCount() {
      const checkboxes = shadowRoot.querySelectorAll(".msg-checkbox:checked");
      const countEl = shadowRoot.getElementById("sc-scan-count");
      if (countEl) countEl.innerText = t("dashSelectedOfScanned", `${checkboxes.length} selected of ${scanResults.length} scanned`, [String(checkboxes.length), String(scanResults.length)]);
      
      // Don't flip the delete button while the chunked render is still adding
      // cards — enabling it early would allow a queue built from a partial list.
      const delBtn = isRendering ? null : ui.btnDelete;
      if (delBtn) {
        if (checkboxes.length === 0) {
          delBtn.disabled = true;
        } else {
          delBtn.disabled = false;
        }
      }
    }

    // Controller for clicking delete
    function handleDeleteClick() {
      if (!isRunning) {
        const checkboxes = shadowRoot.querySelectorAll(".msg-checkbox:checked");
        const rawIndices = Array.from(checkboxes).map(cb => cb.getAttribute("data-idx"));
        // Guard against stale indices if scanResults was modified between scan and
        // delete (SC-BUG-03) -- see buildDeleteQueueFromIndices.
        deleteQueue = buildDeleteQueueFromIndices(rawIndices, scanResults);

        if (deleteQueue.length === 0) return;

        const hasThreadRoots = deleteQueue.some(msg => msg.replyCount > 0);
        // Deleting a thread root doesn't delete its replies — Slack keeps them and
        // shows the parent as "This message was deleted." — but the thread loses
        // its opening message, which the user should know before confirming.
        const threadRootNotice = t("modalThreadRootNotice", "Note: you selected one or more thread starters. Their replies (including other people's) are NOT deleted, but each thread will show \"This message was deleted.\" in place of its first message.");
        const warningPrefix = hasThreadRoots
          ? threadRootNotice + " "
          : t("modalWarningPrefix", "WARNING: ");

        // Pin this queue to the channel/workspace it was built against.
        // startDeletionProcess re-checks this before dispatching, so a channel or
        // workspace switch during the (non-blocking) confirmation modal can't
        // misroute the delete.
        queueChannelId = activeChannel.id;
        queueTeamId = activeTeam.id;

        let delayVal = parseInt(shadowRoot.getElementById("sc-filter-delay").value, 10);
        if (isNaN(delayVal) || delayVal < MIN_THROTTLE_DELAY_MS) {
          delayVal = MIN_THROTTLE_DELAY_MS;
          shadowRoot.getElementById("sc-filter-delay").value = String(MIN_THROTTLE_DELAY_MS);
        }
        throttleDelay = delayVal;

        const confirmDeletion = () => {
          if (deleteQueue.length > LARGE_DELETE_THRESHOLD) {
            const verifyModal = shadowRoot.getElementById("sc-verify-modal");
            const verifyDesc = verifyModal.querySelector(".sc-verify-desc");
            if (verifyDesc) {
              // Built from DOM nodes, never innerHTML: the translated sentences get an
              // invisible marker as their $1 and are split around it, so the styled
              // count/word are inserted as real elements and the text stays text.
              const PLACEHOLDER = "\u2063";
              const withNode = (text, node) => {
                const [before, ...after] = text.split(PLACEHOLDER);
                const frag = document.createDocumentFragment();
                frag.append(before);
                if (after.length) frag.append(node, after.join(""));
                return frag;
              };
              const countLabel = document.createElement("span");
              countLabel.id = "sc-verify-count-label";
              const deleteWord = document.createElement("strong");
              deleteWord.className = "sc-verify-emphasis";
              deleteWord.textContent = "DELETE";
              const introText = t("verifyCountIntro", `You are about to delete more than 100 messages (${PLACEHOLDER} messages).`, [PLACEHOLDER]);
              const confirmText = t("verifyTypeDelete", `To confirm this operation, type the word ${PLACEHOLDER} below:`, [PLACEHOLDER]);
              verifyDesc.replaceChildren(withNode(introText, countLabel));
              if (hasThreadRoots) {
                const warningEl = document.createElement("strong");
                warningEl.style.color = "var(--color-pink)";
                warningEl.textContent = threadRootNotice;
                verifyDesc.append(document.createElement("br"), document.createElement("br"), warningEl,
                  document.createElement("br"), document.createElement("br"));
              } else {
                verifyDesc.append(" ");
              }
              verifyDesc.append(withNode(confirmText, deleteWord));
            }
            shadowRoot.getElementById("sc-verify-count-label").innerText = deleteQueue.length;
            shadowRoot.getElementById("sc-verify-confirm-btn").disabled = true;
            rememberModalOpener();
            verifyModal.classList.remove("hidden");
            shadowRoot.getElementById("sc-verify-input").focus();
          } else {
            showCustomConfirm(
              t("modalConfirmDeletionTitle", "Confirm Deletion"),
              t("modalConfirmDeletionMsg", `${warningPrefix}You are about to permanently delete ${deleteQueue.length} messages in channel "${activeChannel.name}". This action cannot be undone.`, [warningPrefix, String(deleteQueue.length), String(activeChannel.name)]),
              t("dashStartDeleting", "Start Deleting"),
              t("dashVerifyGoBack", "Go Back"),
              (confirmed) => {
                if (confirmed) {
                  startDeletionProcess();
                }
              }
            );
          }
        };

        // "All Messages (admin)" scans can queue other people's messages. Make
        // that explicit before the usual confirmation, with the actual count.
        const othersCount = deleteQueue.filter(msg => !activeTeam.userId || msg.user !== activeTeam.userId).length;
        if (othersCount > 0) {
          showCustomConfirm(
            t("modalOthersMessagesTitle", "Includes Other People's Messages"),
            t("modalOthersMessagesMsg", `${othersCount} of the ${deleteQueue.length} selected messages were posted by other people (or by apps/bots), not by you. Deleting them requires admin rights and removes their content for everyone. Continue only if you intend to delete other people's messages.`, [String(othersCount), String(deleteQueue.length)]),
            t("modalOthersMessagesContinue", "Yes, include them"),
            t("dashVerifyGoBack", "Go Back"),
            (confirmed) => {
              if (confirmed) confirmDeletion();
            }
          );
        } else {
          confirmDeletion();
        }
      } else {
        if (!isPaused) {
          sendJobControl("PAUSE_DELETION", activeTeam.id, activeChannel.id, (delivered, jobFound) => {
            if (!delivered) {
              logConsole(t("logPauseFailed", "Pause request failed — background unavailable. Reload Slack if this persists."), "error");
              return;
            }
            if (!jobFound) {
              logConsole(t("logPauseNoJob", "Pause request reached the background worker, but it found no matching job — nothing was paused. Reload Slack if a clean should still be running."), "error");
              return;
            }
            isPaused = true;
            clearRateLimitCountdown();
            if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashStatusPaused", "Paused");
            syncButtonStates();
            logConsole(t("logRequestingPause", "Requesting pause in background..."), "warn");
            announce(t("srJobPaused", "Deletion paused."));
          });
        } else {
          sendJobControl("RESUME_DELETION", activeTeam.id, activeChannel.id, (delivered, jobFound) => {
            if (!delivered) {
              logConsole(t("logResumeReqFailed", "Resume request failed — background unavailable. Reload Slack if this persists."), "error");
              return;
            }
            if (!jobFound) {
              logConsole(t("logResumeNoJob", "Resume request reached the background worker, but it found no matching job — nothing was resumed."), "error");
              return;
            }
            isPaused = false;
            if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashDeleting", "Deleting...");
            syncButtonStates();
            logConsole(t("logRequestingResume", "Requesting resume in background..."), "info");
            announce(t("srJobResumed", "Deletion resumed."));
          });
        }
      }
    }

    // Start queue execution delegated to background
    function startDeletionProcess() {
      // Drift guard: the queue was built and confirmed for `queueChannelId`/`queueTeamId`,
      // and its items came from a scan of `scanResultsChannelId`/`scanResultsTeamId`.
      // Abort unless ALL of these still match the currently-active conversation AND
      // workspace — this catches (a) a channel switch while the confirmation modal was
      // open (queueChannelId mismatch), (b) a scan that ran in a different channel than
      // the one now targeted (scanResultsChannelId mismatch, the async-lag race), and
      // (c) either of those same two races happening across a WORKSPACE switch instead
      // of a channel switch (queueTeamId/scanResultsTeamId mismatch) — channel IDs are
      // workspace-scoped, not globally unique, so a channel-only check could otherwise
      // let a queue built in one workspace dispatch against a same-ID channel in
      // another. Never dispatch one channel/workspace's queue against another.
      if (!activeChannel || !activeTeam || !queueChannelId || !queueTeamId ||
          activeChannel.id !== queueChannelId ||
          activeTeam.id !== queueTeamId ||
          scanResultsChannelId !== activeChannel.id ||
          scanResultsTeamId !== activeTeam.id) {
        logConsole(t("logDeletionAbortedDrift", "Target conversation changed before deletion started — operation aborted for safety. Re-scan the current channel."), "error");
        showCustomAlert(
          t("modalDeletionAbortedTitle", "Deletion Aborted"),
          t("modalDeletionAbortedMsg", "The active conversation changed before deletion started, so the operation was cancelled to protect against deleting from the wrong channel. Please re-scan and try again.")
        );
        stopOperations(t("dashStatusAborted", "Aborted"));
        return;
      }

      isRunning = true;
      isPaused = false;
      jobFinalized = false;
      deleteIndex = 0;
      stats = { success: 0, fail: 0, skipped: 0, partial: 0, total: deleteQueue.length };

      toggleInputs(true);
      syncButtonStates();

      if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashDeleting", "Deleting...");
      const minTitle = shadowRoot.getElementById("sc-min-status-title");
      if (minTitle) minTitle.innerText = t("dashDeleting", "Deleting...");

      logConsole(t("logDelegatingDeletion", `Delegating deletion of ${stats.total} items to background service worker...`, [String(stats.total)]), "info");
      announce(t("srJobStarted", `Deleting ${stats.total} messages.`, [String(stats.total)]));

      const filterAttachments = shadowRoot.getElementById("sc-filter-attachments").checked;

      chrome.runtime.sendMessage({
        type: "START_DELETION",
        teamId: activeTeam.id,
        channelId: activeChannel.id,
        // Forward the raw facts the worker needs; the worker computes and persists
        // each item's action via the shared decideItemAction() (single source of
        // truth), so "preserve text" behavior survives a service-worker restart.
        // `hasAttachments` is carried because the worker never receives the full
        // attachments array (only file IDs are needed for deletion). Scan results
        // are already slimmed by the worker (see toScanResult in background.js):
        // `blocks` is only present on items with files/attachments.
        deleteQueue: deleteQueue.map(msg => ({
          ts: msg.ts,
          user: msg.user,
          time: msg.time,
          text: msg.text,
          isThreadReply: msg.isThreadReply,
          parentTs: msg.parentTs,
          hasAttachments: !!msg.hasAttachments || (msg.attachments || []).length > 0,
          files: (msg.files || []).map(f => ({ id: f.id, name: f.name })),
          blocks: msg.blocks || []
        })),
        deleteIndex: 0,
        throttleDelay: throttleDelay,
        filterAttachments
      }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          if (response && response.error === "job_already_running") {
            logConsole(t("logJobAlreadyRunning", "A deletion job for this channel is already running (likely started from another tab). Not starting a second one."), "error");
            showCustomAlert(
              t("modalAlreadyRunningTitle", "Already Running"),
              t("modalAlreadyRunningMsg", "A deletion job for this conversation is already running — possibly from another tab with the same channel open. Wait for it to finish, or pause/cancel it from that tab, before starting a new one.")
            );
          } else if (response && (response.error === "scan_required" || response.error === "queue_not_from_scan" || response.error === "queue_not_owned")) {
            // The worker only deletes what its own last scan of this conversation
            // returned (and, in "Only My Messages" mode, only your messages).
            logConsole(t("logQueueRejected", `The background worker refused the delete list (${response.error}). Run a fresh scan of this conversation, then try again.`, [String(response.error)]), "error");
            showCustomAlert(
              t("modalQueueRejectedTitle", "Please Scan Again"),
              t("modalQueueRejectedMsg", "Some selected messages don't match a recent scan of this conversation (scans expire after 30 minutes). Nothing was deleted. Run Scan again, then start the deletion.")
            );
          } else {
            logConsole(t("logStartDeletionError", "Error starting deletion process in background."), "error");
          }
          stopOperations(t("dashStatusError", "Error"));
        }
      });
    }

    // Circular Progress SVG updates
    function updateProgressUI() {
      const percent = stats.total > 0 ? Math.round((deleteIndex / stats.total) * 100) : 0;
      
      if (ui.progressCircle && ui.progressRingText) {
        const offset = CIRCLE_CIRCUMFERENCE - (percent / 100) * CIRCLE_CIRCUMFERENCE;
        ui.progressCircle.style.strokeDashoffset = offset;
        ui.progressRingText.innerText = `${percent}%`;
      }

      if (ui.progressTitle) {
        ui.progressTitle.innerText = t("dashProcessingProgress", `Processing: ${deleteIndex}/${stats.total}`, [String(deleteIndex), String(stats.total)]);
      }
      if (ui.statSuccess) ui.statSuccess.innerText = stats.success;
      if (ui.statFail) ui.statFail.innerText = stats.fail;
      if (ui.statRemaining) ui.statRemaining.innerText = stats.total - deleteIndex;

      // Update Minimized elements
      const minCircle = shadowRoot.getElementById("sc-min-progress-circle");
      const minProgressText = shadowRoot.getElementById("sc-min-status-text");
      if (minCircle) {
        const offset = CIRCLE_CIRCUMFERENCE - (percent / 100) * CIRCLE_CIRCUMFERENCE;
        minCircle.style.strokeDashoffset = offset;
      }
      if (minProgressText) {
        // deleteIndex counts every processed item — failures, skips and partial
        // trims included — so "Deleted X" would overstate what was removed.
        minProgressText.innerText = t("dashProcessedOf", `Processed ${deleteIndex} of ${stats.total}`, [String(deleteIndex), String(stats.total)]);
      }
    }

    // Reset operations controls
    function stopOperations(statusText) {
      // Default resting state is "Idle"; callers pass an already-localized
      // status (Finished/Canceled/Aborted/Error/Stopped).
      statusText = statusText || t("dashIdle", "Idle");
      isRunning = false;
      isPaused = false;

      // Clear active rate limit countdown timers
      clearRateLimitCountdown();
      
      toggleInputs(false);

      const delBtn = ui.btnDelete;
      if (delBtn) {
        delBtn.innerText = t("dashStartDeleting", "Start Deleting");
        delBtn.className = "dashboard-btn btn-delete";
      }
      
      const cancelBtn = shadowRoot.getElementById("sc-btn-cancel");
      if (cancelBtn) cancelBtn.classList.add("hidden");

      if (ui.consoleStatus) ui.consoleStatus.innerText = statusText;
      if (ui.progressTitle) ui.progressTitle.innerText = statusText;
      
      if (ui.progressCircle && ui.progressRingText) {
        ui.progressCircle.style.strokeDashoffset = String(CIRCLE_CIRCUMFERENCE);
        ui.progressRingText.innerText = "0%";
      }

      // Reset Minimized View elements
      const minCircle = shadowRoot.getElementById("sc-min-progress-circle");
      if (minCircle) minCircle.style.strokeDashoffset = String(CIRCLE_CIRCUMFERENCE);
      const minProgressText = shadowRoot.getElementById("sc-min-status-text");
      if (minProgressText) minProgressText.innerText = t("dashIdle", "Idle");
      const minTitle = shadowRoot.getElementById("sc-min-status-title");
      if (minTitle) minTitle.innerText = "Erasechat";
    }

    // Input toggles during deletes
    function toggleInputs(disabled) {
      const selectors = [
        "sc-filter-sender",
        "sc-filter-date",
        "sc-filter-days",
        "sc-filter-start-date",
        "sc-filter-end-date",
        "sc-filter-text",
        "sc-filter-invert-text",
        "sc-filter-delay",
        "sc-filter-threads",
        "sc-filter-attachments",
        "sc-filter-skip-pinned",
        "sc-btn-scan",
        "sc-select-all",
        "sc-preset-select",
        "sc-btn-preset-save",
        "sc-btn-preset-delete"
      ];

      selectors.forEach(id => {
        const el = shadowRoot.getElementById(id);
        if (el) el.disabled = disabled;
      });

      const checkboxes = shadowRoot.querySelectorAll(".msg-checkbox");
      checkboxes.forEach(cb => cb.disabled = disabled);
    }

    // Deterministic avatar color from a user ID (purely cosmetic).
    function stringToColor(str) {
      if (!str) return "#8B5CF6";
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      const colors = [
        "#8B5CF6", "#EC4899", "#3B82F6", "#10B981", "#F59E0B",
        "#EF4444", "#06B6D4", "#14B8A6", "#84CC16", "#A855F7"
      ];
      const idx = Math.abs(hash) % colors.length;
      return colors[idx];
    }
  })();
}
