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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { matchesActiveWorkspaceChannel };
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
    function t(key, fallback) {
      try {
        const m = chrome.i18n.getMessage(key);
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
          activeTeam = info.team;
          // Send token securely to background for memory caching
          chrome.runtime.sendMessage({
            type: "SET_SESSION",
            teamId: activeTeam.id,
            token: activeTeam.token
          });
          sendResponse({ workspaceName: info.team.name });
        } else {
          sendResponse({ workspaceName: "Slack Web Client" });
        }
      } else if (request.type === "LAUNCH_DASHBOARD") {
        initDashboard();
        sendResponse({ success: true });
      } else if (request.type === "JOB_UPDATE") {
        if (matchesActiveWorkspaceChannel(request.job.channelId, request.job.teamId, activeChannel, activeTeam)) {
          isRunning = request.job.isRunning;
          isPaused = request.job.isPaused;
          deleteIndex = request.job.deleteIndex;
          stats = request.job.stats;
          throttleDelay = request.job.throttleDelay;

          updateProgressUI();
          syncButtonStates();
          toggleInputs(isRunning);

          const skipped = stats.skipped || 0;
          if (!jobFinalized && !isRunning && stats.success + stats.fail + skipped >= stats.total && stats.total > 0) {
            jobFinalized = true;
            // Report skips honestly — a skipped item ("attachment-only" mode with
            // nothing to clean) was NOT deleted, so it must not be counted under
            // "Successfully deleted".
            let summary = `Bulk deletion process completed.\n\nSuccessfully deleted: ${stats.success}\nFailed: ${stats.fail}`;
            if (skipped > 0) summary += `\nSkipped (nothing to clean): ${skipped}`;
            showCustomAlert("Erasechat Finished", summary);
            stopOperations("Finished");
            // Clear the now-deleted messages from the preview so the user can't
            // re-run a delete against stale results (which would all fail as
            // message_not_found).
            resetScanResultsUI();
          }
        }
      } else if (request.type === "JOB_RATELIMIT") {
        if (matchesActiveWorkspaceChannel(request.channelId, request.teamId, activeChannel, activeTeam)) {
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
      if (ui.consoleStatus) ui.consoleStatus.innerText = `Rate Limited (${countdown}s)`;
      
      if (rateLimitInterval) clearInterval(rateLimitInterval);
      
      rateLimitInterval = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
          clearInterval(rateLimitInterval);
          rateLimitInterval = null;
          if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashDeleting", "Deleting...");
        } else {
          if (ui.consoleStatus) ui.consoleStatus.innerText = `Rate Limited (${countdown}s)`;
        }
      }, 1000);
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
        // team's token. Refuse instead (caller shows "not connected"). Only a URL with
        // no team segment at all (legacy /messages/ routes) falls back to the sole/first
        // workspace, which is the correct behavior there.
        let activeTeamId = teamSeg;
        if (activeTeamId && !teams[activeTeamId]) {
          return null;
        }
        if (!activeTeamId) {
          activeTeamId = Object.keys(teams)[0];
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
          logConsole(`API Rate Limit hit on ${endpoint}. Waiting ${waitTime} seconds before retry (Attempt ${attempt + 1}/${maxRetries})...`, "warn");
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

    // Loads cache of user profiles in the workspace (24-hour TTL expiration, optimized user scope limit)
    async function loadUserCache() {
      if (!activeTeam) return;
      const cacheKey = `sc_user_cache_${activeTeam.id}`;
      const TTL = USER_CACHE_TTL_MS;

      try {
        const cached = await chrome.storage.local.get(cacheKey);
        if (cached && cached[cacheKey]) {
          const { cacheData, timestamp } = cached[cacheKey];
          if (cacheData && timestamp && (Date.now() - timestamp < TTL)) {
            userCache = cacheData;
            logConsole(`Loaded ${Object.keys(userCache).length} user profiles from local cache.`, "info");
            return;
          }
        }
      } catch (err) {
        console.warn("SlackClean: Cache load failed, querying API.", err);
      }

      try {
        userCache[activeTeam.userId] = "Me";
        logConsole("Caching workspace user directories...", "info");
        
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
        logConsole(`Cached ${Object.keys(userCache).length} user profiles.`, "info");
      } catch (e) {
        console.error("SlackClean: Could not cache user list", e);
      }
    }

    // Resolves a user's name from cache, or fetches it dynamically if missing
    async function getUserName(userId) {
      if (!userId) return "Unknown";
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
      logConsole(`Fetching details for active channel ID: ${channelId}...`, "info");
      
      const domName = getChannelNameFromDOM();
      
      try {
        const data = await slackAPICallWithRetry("conversations.info", { channel: channelId });
        if (data && data.ok && data.channel) {
          const ch = data.channel;
          let name = ch.name || domName || "Active Chat";
          let type = "Public Channel";

          if (ch.is_im) {
            type = "Direct Message";
            const fetchedName = await getUserName(ch.user);
            name = fetchedName ? `@${fetchedName}` : `@${ch.user || "User"}`;
          } else if (ch.is_mpim) {
            type = "Group DM";
            name = ch.purpose?.value || domName || "Group DM";
          } else if (ch.is_private) {
            type = "Private Channel";
          }

          activeChannel = { id: channelId, name, type };
          
          shadowRoot.getElementById("sc-selected-title").innerText = `Target: ${activeChannel.name}`;
          shadowRoot.getElementById("sc-selected-subtitle").innerText = `Mode: ${activeChannel.type} (${activeChannel.id}). Only this open chat will be cleaned.`;
          shadowRoot.getElementById("sc-btn-scan").disabled = false;
          
          logConsole(`Target loaded: ${activeChannel.name} (${activeChannel.type})`, "info");
        } else {
          activeChannel = {
            id: channelId,
            name: domName || `Conversation ${channelId}`,
            type: channelId.startsWith("D") ? "Direct Message" : "Channel"
          };
          
          shadowRoot.getElementById("sc-selected-title").innerText = `Target: ${activeChannel.name}`;
          shadowRoot.getElementById("sc-selected-subtitle").innerText = `Loaded via URL (${activeChannel.id}). Only this open chat will be cleaned.`;
          shadowRoot.getElementById("sc-btn-scan").disabled = false;
          
          logConsole(`Target loaded via URL matching: ${activeChannel.name}`, "info");
        }
      } catch (e) {
        logConsole("Error loading conversation info: " + e.message, "error");
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
      if (countEl) countEl.innerText = "0 items found";
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
      if (nameEl) nameEl.innerText = activeTeam.name || "Slack Workspace";
      if (urlEl) urlEl.innerText = activeTeam.url || "Slack URL";
      if (uidEl) uidEl.innerText = activeTeam.userId || "User";

      logConsole(`Workspace switched to ${activeTeam.name || activeTeam.id}. Reloading directory...`, "info");

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
        if (titleEl) titleEl.innerText = "No Conversation Active";
        if (subEl) subEl.innerText = "Click a Channel or DM in Slack's sidebar — it will be detected automatically.";
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

      // Secure Sandboxed DOM via open mode (Accessible & Testable)
      shadowRoot = shadowHost.attachShadow({ mode: "open" });

      // Isolate keyboard events from the host page (Slack). Slack registers global,
      // document-level keyboard-shortcut handlers that inspect document.activeElement
      // to decide whether the user is "typing". For an input inside our (open) shadow
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
                  <span class="premium-badge" data-i18n="brandTag">Choose a platform</span>
                </div>
              </div>
              <div class="header-right">
                <div class="theme-picker">
                  <span class="info-label" data-i18n="dashVibe">Vibe:</span>
                  <button class="theme-bubble neon active" data-theme="neon" data-i18n-title="dashThemeNeon" title="Neon Aura" aria-label="Set interface theme to Neon Aura"></button>
                  <button class="theme-bubble matrix" data-theme="matrix" data-i18n-title="dashThemeMatrix" title="Emerald Matrix" aria-label="Set interface theme to Emerald Matrix"></button>
                  <button class="theme-bubble fusion" data-theme="fusion" data-i18n-title="dashThemeFusion" title="Fusion Gold" aria-label="Set interface theme to Fusion Gold"></button>
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
                    <h3 class="panel-title" data-i18n="dashFilterMatrix">Deletion Filter Matrix</h3>
                    <div class="filter-form">
                      <div class="form-group sc-preset-group">
                        <label for="sc-preset-select" data-i18n="dashPresetLabel">Saved Presets</label>
                        <div class="preset-controls">
                          <select id="sc-preset-select" aria-label="Load a saved filter preset">
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
                          <label class="sc-inline-checkbox" for="sc-filter-invert-text">
                            <input type="checkbox" id="sc-filter-invert-text" aria-label="Invert text match: delete everything except matches">
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
                          <span class="toggle-title" data-i18n="dashIncludeThreads">Include Thread Replies</span>
                          <span class="toggle-subtitle" data-i18n="dashIncludeThreadsDesc">Scan and delete messages inside threads</span>
                        </div>
                        <label class="switch">
                          <input type="checkbox" id="sc-filter-threads" checked aria-label="Include thread replies checkbox">
                          <span class="slider"></span>
                        </label>
                      </div>

                      <div class="toggle-group">
                        <div class="toggle-label">
                          <span class="toggle-title" data-i18n="dashOnlyAttachments">Only Delete Attachments</span>
                          <span class="toggle-subtitle" data-i18n="dashOnlyAttachmentsDesc">Strips files/attachments but keeps any message text (a message that is only a file is deleted)</span>
                        </div>
                        <label class="switch">
                          <input type="checkbox" id="sc-filter-attachments" aria-label="Only delete attachments checkbox">
                          <span class="slider"></span>
                        </label>
                      </div>

                      <div class="toggle-group">
                        <div class="toggle-label">
                          <span class="toggle-title" data-i18n="dashSkipPinned">Skip Pinned Messages</span>
                          <span class="toggle-subtitle" data-i18n="dashSkipPinnedDesc">Never delete a message that is currently pinned in this conversation</span>
                        </div>
                        <label class="switch">
                          <input type="checkbox" id="sc-filter-skip-pinned" checked aria-label="Skip pinned messages checkbox">
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
                      <button id="sc-btn-export-messages" class="dashboard-btn btn-scan" disabled aria-label="Download scanned messages as CSV" data-i18n="dashExportCsv">Export CSV</button>
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
                        <circle cx="50" cy="50" r="40" stroke="rgba(255,255,255,0.05)" stroke-width="8" fill="transparent" />
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
                        <button id="sc-btn-clear-logs" role="button" aria-label="Clear execution logs" data-i18n="dashClear">Clear</button>
                        <button id="sc-btn-download-logs" role="button" aria-label="Export execution logs as text file" data-i18n="dashExport">Export</button>
                        <span id="sc-console-status" data-i18n="dashReady">Ready</span>
                      </div>
                    </div>
                    <div class="console-terminal" id="sc-console-log" aria-live="polite" role="log">
                      <div class="console-line info">Erasechat initialized in Safe (Single-Channel) Mode.</div>
                    </div>
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
                  <circle cx="50" cy="50" r="40" stroke="rgba(255,255,255,0.05)" stroke-width="8" fill="transparent" />
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
            <h4 id="sc-verify-title" data-i18n="dashVerifyTitle">Critical Action Verification</h4>
            <p class="sc-verify-desc">
              You are about to delete more than 100 messages (<span id="sc-verify-count-label">0</span> messages). To confirm this operation, type the word <strong class="sc-verify-emphasis">DELETE</strong> below:
            </p>
            <input type="text" id="sc-verify-input" data-i18n-ph="dashVerifyInputPlaceholder" placeholder="Type DELETE to confirm" aria-label="Type DELETE to confirm bulk deletion">
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
            <input type="text" id="sc-prompt-input" maxlength="60" aria-label="Preset name">
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
        shadowRoot.getElementById("sc-connection-name").innerText = "Not Connected";
        shadowRoot.getElementById("sc-connection-url").innerText = "Unknown";
        shadowRoot.getElementById("sc-connection-uid").innerText = "Unknown";
        
        shadowRoot.getElementById("sc-selected-title").innerText = "No Conversation Connected";
        shadowRoot.getElementById("sc-selected-subtitle").innerText = "Please log in to Slack and go to a workspace channel.";
        
        showCustomAlert(
          "Authentication Error",
          "Slack session credentials not found. Make sure you are logged into Slack web client on this tab, then re-open."
        );
        return;
      }

      activeTeam = info.team;
      intendedTeamId = activeTeam.id;
      const targetChannelId = info.channelId;

      // Populate Connection Details
      shadowRoot.getElementById("sc-connection-name").innerText = activeTeam.name || "Slack Workspace";
      shadowRoot.getElementById("sc-connection-url").innerText = activeTeam.url || "Slack URL";
      shadowRoot.getElementById("sc-connection-uid").innerText = activeTeam.userId || "User";

      // Load workspace and active channel data
      loadUserCache().then(() => {
        if (targetChannelId) {
          loadActiveChannel(targetChannelId).then(() => {
            checkAndResumeState();
          });
        } else {
          shadowRoot.getElementById("sc-selected-title").innerText = "No Conversation Active";
          shadowRoot.getElementById("sc-selected-subtitle").innerText = "Click a Channel or DM in Slack's sidebar — it will be detected automatically.";
          logConsole("No conversation detected yet. Click a channel or DM in Slack and it will be picked up automatically.", "warn");
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
      shadowRoot.querySelectorAll(".theme-bubble").forEach(btn => btn.classList.remove("active"));
      
      const targetBtn = shadowRoot.querySelector(`.theme-bubble.${themeName}`);
      if (targetBtn) targetBtn.classList.add("active");

      if (themeName === 'neon') {
        host.style.setProperty('--color-purple', '#8b5cf6');
        host.style.setProperty('--color-pink', '#ec4899');
        host.style.setProperty('--gradient-glow', 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)');
        host.style.setProperty('--gradient-glow-hover', 'linear-gradient(135deg, #a78bfa 0%, #f472b6 100%)');
        host.style.setProperty('--accent-soft', 'rgba(139, 92, 246, 0.16)');
      } else if (themeName === 'matrix') {
        host.style.setProperty('--color-purple', '#10b981');
        host.style.setProperty('--color-pink', '#06b6d4');
        host.style.setProperty('--gradient-glow', 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)');
        host.style.setProperty('--gradient-glow-hover', 'linear-gradient(135deg, #34d399 0%, #22d3ee 100%)');
        host.style.setProperty('--accent-soft', 'rgba(16, 185, 129, 0.16)');
      } else if (themeName === 'fusion') {
        host.style.setProperty('--color-purple', '#f59e0b');
        host.style.setProperty('--color-pink', '#ef4444');
        host.style.setProperty('--gradient-glow', 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)');
        host.style.setProperty('--gradient-glow-hover', 'linear-gradient(135deg, #fbbf24 0%, #f87171 100%)');
        host.style.setProperty('--accent-soft', 'rgba(245, 158, 11, 0.16)');
      }
      
      logConsole(`Interface theme set to: ${themeName.toUpperCase()}`, "info");
    }



    // Checks background job status and resumes/syncs UI state
    async function checkAndResumeState() {
      if (!activeTeam || !activeChannel) return;
      try {
        chrome.runtime.sendMessage({
          type: "GET_JOB_STATUS",
          teamId: activeTeam.id,
          channelId: activeChannel.id
        }, (response) => {
          if (chrome.runtime.lastError) return;

          if (response && response.otherJob && response.otherJob.isPaused) {
            showCustomAlert(
              "Paused Job in Another Channel",
              `You have a paused bulk clean in another conversation (${response.otherJob.channelId}). Switch to that channel to resume or cancel it.`
            );
          }

          if (response && response.exists) {
            const state = response.job;
            isRunning = state.isRunning;
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
              logConsole(`Connected to active background clean process at message ${deleteIndex}/${stats.total}...`, "info");
            } else if (isPaused) {
              // Paused/interrupted job: prompt to resume
              showCustomConfirm(
                "Interrupted Clean Detected",
                `An unfinished deletion task was found for "${activeChannel.name}" at index ${state.deleteIndex}/${state.stats.total}. Would you like to resume?`,
                "Resume Deletion",
                "Discard Progress",
                async (confirmed) => {
                  if (confirmed) {
                    chrome.runtime.sendMessage({
                      type: "RESUME_DELETION",
                      teamId: activeTeam.id,
                      channelId: activeChannel.id
                    }, (res) => {
                      if (chrome.runtime.lastError || !res || !res.success) {
                        logConsole("Could not resume — background service worker unavailable. Please reload Slack.", "error");
                        stopOperations("Error");
                        return;
                      }
                      isRunning = true;
                      isPaused = false;
                      jobFinalized = false;
                      toggleInputs(true);
                      syncButtonStates();
                      logConsole(`Resuming bulk deletion queue from message index ${deleteIndex + 1}...`, "warn");
                      updateProgressUI();
                    });
                  } else {
                    chrome.runtime.sendMessage({
                      type: "CANCEL_DELETION",
                      teamId: activeTeam.id,
                      channelId: activeChannel.id
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

    // Custom non-blocking Alert Dialog helper
    function showCustomAlert(title, message, callback) {
      const modal = shadowRoot.getElementById("sc-alert-modal");
      if (!modal) return;
      
      shadowRoot.getElementById("sc-alert-title").innerText = title;
      shadowRoot.getElementById("sc-alert-message").innerText = message;
      
      const okBtn = shadowRoot.getElementById("sc-alert-ok-btn");
      const newOkBtn = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOkBtn, okBtn);
      
      newOkBtn.focus();
      
      newOkBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        if (callback) callback();
      });
      modal.classList.remove("hidden");
    }

    // Custom non-blocking Confirmation Dialog helper (prevents accidental confirmation by default-focusing cancel)
    function showCustomConfirm(title, message, okText, cancelText, callback) {
      const modal = shadowRoot.getElementById("sc-confirm-modal");
      if (!modal) return;

      shadowRoot.getElementById("sc-confirm-title").innerText = title;
      shadowRoot.getElementById("sc-confirm-message").innerText = message;

      const okBtn = shadowRoot.getElementById("sc-confirm-ok-btn");
      okBtn.innerText = okText || "Confirm";
      const newOkBtn = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(newOkBtn, okBtn);

      const cancelBtn = shadowRoot.getElementById("sc-confirm-cancel-btn");
      cancelBtn.innerText = cancelText || "Cancel";
      const newCancelBtn = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

      newCancelBtn.focus();

      newOkBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        callback(true);
      });
      newCancelBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        callback(false);
      });
      modal.classList.remove("hidden");
    }

    // Custom non-blocking single-text-input Prompt Dialog helper (e.g. naming a preset).
    // callback receives the trimmed value, or null if cancelled.
    function showCustomPrompt(title, message, placeholder, callback) {
      const modal = shadowRoot.getElementById("sc-prompt-modal");
      if (!modal) return;

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

      setVal("sc-filter-sender", state.sender);
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

      urlObserverInterval = setInterval(() => {
        if (window.location.href !== lastUrl) {
          const oldUrl = lastUrl;
          lastUrl = window.location.href;
          handleUrlChange(oldUrl, lastUrl);
        }
      }, URL_POLL_INTERVAL_MS); // polling costs virtually 0% CPU next to MutationObserver subtree tracking
    }

    // Auto-pauses on channel switching drift detection to prevent accidental data destruction
    function handleUrlChange(oldUrl, newUrl) {
      const info = getActiveTeamInfo();
      if (!info) return;

      // Workspace (team) switch within the same tab — handle BEFORE channel logic,
      // since the channel id also changes and would otherwise be interpreted against
      // the stale workspace. activeTeam holds the credentials every operation uses.
      if (activeTeam && info.team && info.team.id !== activeTeam.id) {
        if (isRunning) {
          // A job is bound to the PREVIOUS workspace. Never rebind mid-job: pause it
          // if it's actively deleting (drift protection), otherwise leave it bound.
          if (!isPaused) {
            chrome.runtime.sendMessage({
              type: "PAUSE_DELETION",
              teamId: activeTeam.id,
              channelId: activeChannel ? activeChannel.id : null
            }, () => {
              void chrome.runtime.lastError;
              isPaused = true;
              syncButtonStates();
              logConsole("[Warning] Workspace switch detected! Bulk clean auto-paused to avoid operating on the wrong workspace.", "error");
              showCustomAlert(
                "Execution Paused",
                "You switched workspaces while a clean was running. It was paused and stays bound to the original workspace. Return there to resume, or cancel it before working here."
              );
            });
          } else {
            logConsole("A paused clean is still bound to its original workspace. Return to it to resume, or cancel it before switching.", "warn");
          }
          return; // stay pinned to the old workspace/channel
        }
        // No job in flight — adopt the new workspace (and its conversation).
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
          logConsole(`Conversation detected: ${info.channelId}`, "info");
          switchTargetChannel(info.channelId);
        }
        return;
      }

      if (info.channelId !== activeChannel.id) {
        if (isRunning && !isPaused) {
          // Drift protection: pause if we leave the target while deleting
          // (including navigating to a non-conversation view).
          chrome.runtime.sendMessage({
            type: "PAUSE_DELETION",
            teamId: activeTeam.id,
            channelId: activeChannel.id
          }, () => {
            isPaused = true;
            syncButtonStates();
            logConsole("[Warning] Slack navigation detected! Bulk clean auto-paused to prevent channel drift.", "error");

            showCustomAlert(
              "Execution Paused",
              "You have navigated away from the target channel. The cleaner process has been paused. Return to the target channel to resume, or discard operations."
            );
          });
        } else if (!isRunning && info.channelId && shadowHost && shadowHost.style.display !== "none") {
          // Re-target only when there's an actual new conversation AND no job is
          // active. If a job is paused (isRunning && isPaused), it stays bound to
          // its original channel — re-targeting here would orphan that job and
          // misroute subsequent pause/resume/cancel messages to the wrong channel.
          logConsole(`Syncing workspace channel target details: ${info.channelId}`, "info");
          switchTargetChannel(info.channelId);
        } else if (isRunning) {
          logConsole("A paused clean is still bound to its channel. Return to it to resume, or cancel it before switching.", "warn");
        }
      }
    }

    // Attaches action listeners to injected components
    function setupUIListeners() {
      const getEl = (id) => shadowRoot.getElementById(id);

      // Minimize Overlay View to bottom floating widget
      getEl("sc-btn-minimize").addEventListener("click", () => {
        dashboardEl.classList.add("minimized");
        logConsole("Dashboard minimized to floating widget.", "info");
      });

      // Maximize Overlay View to full-screen view
      getEl("sc-btn-maximize").addEventListener("click", () => {
        dashboardEl.classList.remove("minimized");
        logConsole("Dashboard maximized to full view.", "info");
      });

      // Close Dashboard (Hide host in DOM instead of destroying)
      getEl("sc-btn-close").addEventListener("click", () => {
        if (isRunning) {
          showCustomConfirm(
            "Close Dashboard?",
            "A clean operation is running. Exiting will cancel all ongoing processes. Are you sure you want to close?",
            "Close and Stop",
            "Keep Running",
            (confirmed) => {
              if (confirmed) {
                chrome.runtime.sendMessage({
                  type: "CANCEL_DELETION",
                  teamId: activeTeam.id,
                  channelId: activeChannel.id
                }, () => {
                  if (chrome.runtime.lastError) {
                    // The cancel didn't reach the worker — the job may STILL be running.
                    // Don't claim it stopped or hide the dashboard; tell the user to retry.
                    logConsole("Could not reach the background worker to stop the job. It may still be running — reload Slack and try again.", "error");
                    showCustomAlert(
                      "Could Not Stop",
                      "The stop request didn't reach the background worker, so the clean may still be running. Reload the Slack page and try again."
                    );
                    return;
                  }
                  stopOperations();
                  hideDashboard();
                });
              }
            }
          );
        } else {
          hideDashboard();
        }
      });

      function hideDashboard() {
        dashboardEl.classList.remove("visible");
        setTimeout(() => {
          if (shadowHost) {
            shadowHost.style.display = "none";
          }
        }, 300);
      }

      // Date Filter Selector Toggles
      getEl("sc-filter-date").addEventListener("change", (e) => {
        updateDateFilterRows(e.target.value);
      });

      // Scan Button Event
      getEl("sc-btn-scan").addEventListener("click", () => {
        runScan();
      });

      // Delete Action Button Event (Toggle Start/Pause/Resume)
      getEl("sc-btn-delete").addEventListener("click", () => {
        handleDeleteClick();
      });

      // Cancel Action Event
      getEl("sc-btn-cancel").addEventListener("click", () => {
        showCustomConfirm(
          "Cancel Cleaning Sequence",
          "Are you sure you want to cancel the deletion process? Remaining messages will not be deleted.",
          "Stop Deletion",
          "Continue Deleting",
          (confirmed) => {
            if (confirmed) {
              chrome.runtime.sendMessage({
                type: "CANCEL_DELETION",
                teamId: activeTeam.id,
                channelId: activeChannel.id
              }, () => {
                if (chrome.runtime.lastError) {
                  // Cancel didn't reach the worker — the job may still be deleting.
                  // Keep the running UI so the user can retry rather than being told
                  // it stopped when it may not have.
                  logConsole("Could not reach the background worker to cancel. The job may still be running — reload Slack and try again.", "error");
                  showCustomAlert(
                    "Could Not Cancel",
                    "The cancel request didn't reach the background worker, so the clean may still be running. Reload the Slack page and try again."
                  );
                  return;
                }
                logConsole("Bulk deletion canceled by user.", "warn");
                stopOperations("Canceled");
              });
            }
          }
        );
      });

      // Select all checkboxes toggle
      getEl("sc-select-all").addEventListener("change", (e) => {
        const checked = e.target.checked;
        const checkboxes = shadowRoot.querySelectorAll(".msg-checkbox");
        checkboxes.forEach(cb => cb.checked = checked);
        updateScanBadgeCount();
      });

      // Saved Filter Presets: load selection, save current filters, delete selected
      getEl("sc-preset-select").addEventListener("change", async (e) => {
        const presetId = e.target.value;
        const delBtn = getEl("sc-btn-preset-delete");
        if (delBtn) delBtn.classList.toggle("hidden", !presetId);
        if (!presetId) return;

        const presets = await loadFilterPresets();
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
          applyFilterFormState(preset);
          logConsole(`Loaded filter preset "${preset.name}".`, "info");
        }
      });

      getEl("sc-btn-preset-save").addEventListener("click", () => {
        showCustomPrompt(
          "Name This Preset",
          "Save the current filter settings for reuse later.",
          "e.g. Older than 90 days, no attachments",
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
                  "Preset Limit Reached",
                  `You already have ${MAX_FILTER_PRESETS} saved presets, the maximum. Delete one before saving another.`
                );
                return;
              }
              presets.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, ...state });
            }

            await saveFilterPresets(presets);
            populatePresetSelect(presets);
            getEl("sc-preset-select").value = existing ? existing.id : presets[presets.length - 1].id;
            getEl("sc-btn-preset-delete").classList.remove("hidden");
            logConsole(`Saved filter preset "${name}".`, "info");
          }
        );
      });

      getEl("sc-btn-preset-delete").addEventListener("click", () => {
        const select = getEl("sc-preset-select");
        const presetId = select.value;
        if (!presetId) return;

        const selectedLabel = select.options[select.selectedIndex]?.text || "this preset";
        showCustomConfirm(
          "Delete Preset?",
          `Remove the saved preset "${selectedLabel}"? This cannot be undone.`,
          "Delete",
          "Cancel",
          async (confirmed) => {
            if (!confirmed) return;
            const presets = await loadFilterPresets();
            const remaining = presets.filter(p => p.id !== presetId);
            await saveFilterPresets(remaining);
            populatePresetSelect(remaining);
            logConsole(`Deleted filter preset "${selectedLabel}".`, "info");
          }
        );
      });

      // Clear Logs (using DOM construction instead of innerHTML for security)
      getEl("sc-btn-clear-logs").addEventListener("click", () => {
        if (ui.consoleLog) {
          while (ui.consoleLog.firstChild) {
            ui.consoleLog.removeChild(ui.consoleLog.firstChild);
          }
          const cleared = document.createElement("div");
          cleared.className = "console-line info";
          cleared.textContent = "[Logs cleared by user]";
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

        // Neutralize CSV/formula injection: a cell starting with = + - @ (or a
        // control char that a spreadsheet may treat as a formula lead-in) is
        // prefixed with a single quote so Excel/Sheets renders it as text.
        const csvSafe = (value) => {
          let s = String(value == null ? "" : value);
          if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
          return s.replace(/"/g, '""').replace(/[\r\n]+/g, " ");
        };

        const csvHeader = "Timestamp,User,Text,ThreadReply,Time,Attachments\n";
        const csvRows = scanResults.map(msg => {
          const text = csvSafe(msg.text || "");
          const user = csvSafe(userCache[msg.user] || msg.user || "");
          const fileCount = (msg.files || []).length;
          return `"${csvSafe(msg.ts)}","${user}","${text}","${msg.isThreadReply ? "Yes" : "No"}","${csvSafe(msg.time)}","${fileCount}"`;
        }).join("\n");

        const blob = new Blob([csvHeader + csvRows], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `erasechat_messages_${activeChannel ? activeChannel.name : "export"}_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);

        logConsole(`Exported ${scanResults.length} messages to CSV.`, "info");
      });

      // Safety Verification Modal Event Listeners
      getEl("sc-verify-input").addEventListener("input", (e) => {
        const confirmBtn = getEl("sc-verify-confirm-btn");
        confirmBtn.disabled = e.target.value.trim() !== "DELETE";
      });

      getEl("sc-verify-cancel-btn").addEventListener("click", () => {
        getEl("sc-verify-modal").classList.add("hidden");
        getEl("sc-verify-input").value = "";
      });

      getEl("sc-verify-confirm-btn").addEventListener("click", () => {
        getEl("sc-verify-confirm-btn").disabled = true;
        getEl("sc-verify-modal").classList.add("hidden");
        getEl("sc-verify-input").value = "";
        startDeletionProcess();
      });

      // Hook up Theme Switchers
      shadowRoot.querySelectorAll(".theme-bubble").forEach(btn => {
        btn.addEventListener("click", (e) => {
          const themeName = e.target.getAttribute("data-theme");
          setTheme(themeName);
        });
      });

      // Keyboard focus trap inside Shadow DOM for Accessibility (a11y) compliance (Modal Scoped)
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
          const focusables = Array.from(containerEl.querySelectorAll(focusableSelectors));
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
      
      logConsole(`Initiating message scan in current target: ${activeChannel.name}...`, "info");
      
      // Read filter inputs
      const filterSender = shadowRoot.getElementById("sc-filter-sender").value;
      const filterDate = shadowRoot.getElementById("sc-filter-date").value;
      const filterText = shadowRoot.getElementById("sc-filter-text").value.trim();
      const includeThreads = shadowRoot.getElementById("sc-filter-threads").checked;
      const onlyAttachments = shadowRoot.getElementById("sc-filter-attachments").checked;
      const invertText = shadowRoot.getElementById("sc-filter-invert-text").checked;
      const excludePinned = shadowRoot.getElementById("sc-filter-skip-pinned").checked;

      let oldest = 0;
      let latest = Math.floor(Date.now() / 1000);

      // Compute timestamp ranges dynamically
      if (filterDate === "older_than") {
        const days = parseInt(shadowRoot.getElementById("sc-filter-days").value || "30", 10);
        latest = Math.floor(Date.now() / 1000 - days * 24 * 60 * 60);
      } else if (filterDate === "custom") {
        const startVal = shadowRoot.getElementById("sc-filter-start-date").value;
        const endVal = shadowRoot.getElementById("sc-filter-end-date").value;

        // Both bounds are REQUIRED for a custom range. Previously a blank field
        // silently fell back to oldest=0 / latest=now, so the scan quietly
        // covered ALL history — and the confirm dialog only shows a count, never
        // the date range, so the user could delete far more than intended.
        if (!startVal || !endVal) {
          logConsole("Error: Custom date range requires both a start and an end date.", "error");
          showCustomAlert("Incomplete Date Range", "Please choose both a Start Date and an End Date for a custom range.");
          scanBtn.disabled = false;
          scanBtn.innerText = t("dashScan", "Scan Messages");
          toggleInputs(false);
          return;
        }

        // Parse both bounds in the SAME (local) frame. A bare "YYYY-MM-DD" is
        // parsed as UTC midnight, while "YYYY-MM-DDTHH:MM:SS" is parsed as local
        // time — mixing them skews the window by the UTC offset and can delete
        // messages outside the range the user picked. Anchor start to local midnight.
        const oldestTs = Math.floor(new Date(startVal + "T00:00:00").getTime() / 1000);
        const latestTs = Math.floor(new Date(endVal + "T23:59:59").getTime() / 1000);

        if (oldestTs > latestTs) {
          logConsole("Error: Start Date cannot be after End Date.", "error");
          showCustomAlert("Invalid Date Range", "Start Date must be before or equal to End Date.");
          scanBtn.disabled = false;
          scanBtn.innerText = t("dashScan", "Scan Messages");
          toggleInputs(false);
          return;
        }
        oldest = oldestTs;
        latest = latestTs;
      }

      scanResults = [];
      logConsole("Querying Slack APIs in background...", "info");

      // Guard the scan against a response that never arrives (SW suspended mid-scan).
      // `scanSettled` ensures the timeout and the real callback don't both run.
      let scanSettled = false;
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
        // is gone) or may still be paginating a heavily-throttled channel. It refuses
        // a duplicate sweep of the same conversation while one is still running, so
        // re-scanning is safe either way — it just reports "already running" instead
        // of doubling the API load.
        logConsole("No scan result after 2 minutes. The background worker may have been suspended, or may still be working through a throttled channel. Re-run Scan — a scan that is still running will say so rather than starting a second one.", "error");
        showCustomAlert(
          "Scan Did Not Finish In Time",
          "No result came back within 2 minutes. The background worker was either suspended or is still working through a heavily rate-limited channel.\n\nRe-run Scan: if one is still in progress you'll be told, and nothing is deleted either way."
        );
      }, SCAN_TIMEOUT_MS);

      chrome.runtime.sendMessage({
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
        userId: activeTeam.userId
      }, (response) => {
        // The timeout may have already restored the UI and given up on this scan.
        if (scanSettled) return;
        scanSettled = true;
        clearTimeout(scanTimeout);
        restoreScanUI();

        if (chrome.runtime.lastError) {
          logConsole(`Scan API call failed: ${chrome.runtime.lastError.message}`, "error");
          return;
        }

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
          logConsole("Channel or workspace changed during active scan. Discarding stale scan results.", "warn");
          return;
        }

        if (response && response.ok) {
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
            ? " (5,000-result limit reached — narrow your filters for more)"
            : (moreAvailable ? " (scan depth limit reached — older messages were NOT examined)" : "");
          logConsole(`Scan complete. Matches found: ${scanResults.length}${note}`, truncated ? "warn" : "info");
          
          // Pre-fetch any unknown users so the UI renders real names instead of raw IDs
          const unknownUsers = new Set();
          scanResults.forEach(msg => {
            if (msg.user && !userCache[msg.user]) unknownUsers.add(msg.user);
          });
          if (unknownUsers.size > 0) {
            logConsole(`Fetching names for ${unknownUsers.size} unknown users...`, "info");
            Promise.all(Array.from(unknownUsers).map(uid => getUserName(uid))).then(() => {
              renderScanResults();
            });
          } else {
            renderScanResults();
          }

          if (wasCapped) {
            showCustomAlert(
              "Scan Results Capped",
              `The scan returned ${scanResults.length} messages, the maximum per scan. There may be additional matching messages. Use a narrower date range or text filter, delete this batch, then scan again.`
            );
          } else if (moreAvailable) {
            showCustomAlert(
              "Not All Messages Were Scanned",
              `This channel has more history than a single scan examines, so only its most recent messages were checked (${scanResults.length} matched). Older matching messages exist but were NOT scanned. Use a date range to scan older messages, or delete this batch and scan again.`
            );
          }
        } else if (response && response.error === "scan_in_progress") {
          // A previous scan of this same conversation is still sweeping Slack (most
          // likely the user hit the client-side scan timeout and retried). Say so
          // plainly rather than reporting it as a failure — the first scan is still
          // coming, and starting a second would only compete for the rate limit.
          logConsole("A scan of this conversation is already running. Waiting for it to finish rather than starting a second one.", "warn");
          showCustomAlert(
            "Scan Already Running",
            "A scan of this conversation is still in progress. Starting another would compete for the same Slack rate limit and make both slower, so this request was skipped. Give the first scan a moment to finish."
          );
        } else {
          const reason = response ? (response.message || response.error || "Unknown error") : "No response from the background worker";
          logConsole(`Scan runtime error: ${reason}`, "error");
          showCustomAlert("Scan Failed", `The scan could not be completed: ${reason}`);
        }
      });
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
        if (countEl) countEl.innerText = "0 items found";
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
          const authorName = userCache[msg.user] || msg.user || "Unknown";
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
            threadBadge.textContent = "Thread Reply";
            meta.appendChild(threadBadge);
          } else if (msg.replyCount > 0) {
            const rootBadge = document.createElement("span");
            rootBadge.className = "msg-badge-thread";
            rootBadge.style.backgroundColor = "var(--color-pink)";
            rootBadge.style.color = "white";
            rootBadge.textContent = `Thread Root (${msg.replyCount} replies will be deleted!)`;
            meta.appendChild(rootBadge);
          }

          wrapper.appendChild(meta);

          const textDiv = document.createElement("div");
          textDiv.className = "msg-text";
          textDiv.textContent = msg.text || "[Empty Message]";
          wrapper.appendChild(textDiv);

          if (msg.files && msg.files.length > 0) {
            const fileDiv = document.createElement("div");
            fileDiv.style.fontSize = "10px";
            fileDiv.style.color = "var(--color-pink)";
            fileDiv.style.marginTop = "2px";
            fileDiv.textContent = `📎 Contains ${msg.files.length} attached files`;
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

      if (countEl) countEl.innerText = `${scanResults.length} items found`;

      renderChunk();
    }

    // Display count changes based on manual unchecks
    function updateScanBadgeCount() {
      const checkboxes = shadowRoot.querySelectorAll(".msg-checkbox:checked");
      const countEl = shadowRoot.getElementById("sc-scan-count");
      if (countEl) countEl.innerText = `${checkboxes.length} selected of ${scanResults.length} scanned`;
      
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
        deleteQueue = [];
        checkboxes.forEach(cb => {
          const idx = parseInt(cb.getAttribute("data-idx"), 10);
          // Guard against stale indices if scanResults was modified between scan and delete (SC-BUG-03)
          if (idx >= 0 && idx < scanResults.length && scanResults[idx]) {
            deleteQueue.push(scanResults[idx]);
          }
        });

        if (deleteQueue.length === 0) return;

        const hasThreadRoots = deleteQueue.some(msg => msg.replyCount > 0);
        const warningPrefix = hasThreadRoots
          ? `CRITICAL WARNING: You have selected one or more Thread Roots. Slack will permanently delete ALL replies by other users in those threads! `
          : `WARNING: `;

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

        if (deleteQueue.length > LARGE_DELETE_THRESHOLD) {
          const verifyModal = shadowRoot.getElementById("sc-verify-modal");
          const verifyDesc = verifyModal.querySelector(".sc-verify-desc");
          if (verifyDesc) {
            if (hasThreadRoots) {
              verifyDesc.innerHTML = 'You are about to delete more than 100 messages (<span id="sc-verify-count-label"></span> messages). <br><br><strong style="color:var(--color-pink)">CRITICAL WARNING: You have selected one or more Thread Roots. Slack will permanently delete ALL replies by other users in those threads!</strong><br><br>To confirm this operation, type the word <strong class="sc-verify-emphasis">DELETE</strong> below:';
            } else {
              verifyDesc.innerHTML = 'You are about to delete more than 100 messages (<span id="sc-verify-count-label"></span> messages). To confirm this operation, type the word <strong class="sc-verify-emphasis">DELETE</strong> below:';
            }
            shadowRoot.getElementById("sc-verify-count-label").innerText = deleteQueue.length;
          } else {
            shadowRoot.getElementById("sc-verify-count-label").innerText = deleteQueue.length;
          }
          shadowRoot.getElementById("sc-verify-confirm-btn").disabled = true;
          verifyModal.classList.remove("hidden");
          shadowRoot.getElementById("sc-verify-input").focus();
        } else {
          showCustomConfirm(
            "Confirm Deletion",
            `${warningPrefix}You are about to permanently delete ${deleteQueue.length} messages in channel "${activeChannel.name}". This action cannot be undone.`,
            "Start Deleting",
            "Go Back",
            (confirmed) => {
              if (confirmed) {
                startDeletionProcess();
              }
            }
          );
        }
      } else {
        if (!isPaused) {
          chrome.runtime.sendMessage({
            type: "PAUSE_DELETION",
            teamId: activeTeam.id,
            channelId: activeChannel.id
          }, () => {
            if (chrome.runtime.lastError) {
              logConsole("Pause request failed — background unavailable. Reload Slack if this persists.", "error");
              return;
            }
            isPaused = true;
            syncButtonStates();
            logConsole("Requesting pause in background...", "warn");
          });
        } else {
          chrome.runtime.sendMessage({
            type: "RESUME_DELETION",
            teamId: activeTeam.id,
            channelId: activeChannel.id
          }, () => {
            if (chrome.runtime.lastError) {
              logConsole("Resume request failed — background unavailable. Reload Slack if this persists.", "error");
              return;
            }
            isPaused = false;
            syncButtonStates();
            logConsole("Requesting resume in background...", "info");
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
        logConsole("Target conversation changed before deletion started — operation aborted for safety. Re-scan the current channel.", "error");
        showCustomAlert(
          "Deletion Aborted",
          "The active conversation changed before deletion started, so the operation was cancelled to protect against deleting from the wrong channel. Please re-scan and try again."
        );
        stopOperations("Aborted");
        return;
      }

      isRunning = true;
      isPaused = false;
      jobFinalized = false;
      deleteIndex = 0;
      stats = { success: 0, fail: 0, skipped: 0, total: deleteQueue.length };

      toggleInputs(true);
      syncButtonStates();

      if (ui.consoleStatus) ui.consoleStatus.innerText = t("dashDeleting", "Deleting...");
      const minTitle = shadowRoot.getElementById("sc-min-status-title");
      if (minTitle) minTitle.innerText = t("dashDeleting", "Deleting...");

      logConsole(`Delegating deletion of ${stats.total} items to background service worker...`, "info");

      const filterAttachments = shadowRoot.getElementById("sc-filter-attachments").checked;

      chrome.runtime.sendMessage({
        type: "START_DELETION",
        teamId: activeTeam.id,
        channelId: activeChannel.id,
        // Forward the raw facts the worker needs; the worker computes and persists
        // each item's action via the shared decideItemAction() (single source of
        // truth), so "preserve text" behavior survives a service-worker restart.
        // `hasAttachments` is carried because the worker never receives the full
        // attachments array (only file IDs are needed for deletion).
        deleteQueue: deleteQueue.map(msg => ({
          ts: msg.ts,
          user: msg.user,
          time: msg.time,
          text: msg.text,
          isThreadReply: msg.isThreadReply,
          parentTs: msg.parentTs,
          hasAttachments: (msg.attachments || []).length > 0,
          files: (msg.files || []).map(f => ({ id: f.id, name: f.name })),
          blocks: msg.blocks || []
        })),
        deleteIndex: 0,
        throttleDelay: throttleDelay,
        filterAttachments
      }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          logConsole("Error starting deletion process in background.", "error");
          stopOperations("Error");
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
        ui.progressTitle.innerText = `Processing: ${deleteIndex}/${stats.total}`;
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
        minProgressText.innerText = `Deleted ${deleteIndex} of ${stats.total}`;
      }
    }

    // Reset operations controls
    function stopOperations(statusText) {
      // Default resting state is localized; explicit statuses (Finished/Canceled/
      // Aborted/Error) are passed by callers as operational text.
      statusText = statusText || t("dashIdle", "Idle");
      isRunning = false;
      isPaused = false;

      // Clear active rate limit countdown timers
      if (rateLimitInterval) {
        clearInterval(rateLimitInterval);
        rateLimitInterval = null;
      }
      
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

    // Convert member strings to HSL matching colors
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
