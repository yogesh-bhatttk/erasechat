// Tracks whether the user has navigated away from the platform-picker list (into
// the Slack/Bluesky/Telegram special views) while a connectAndLaunchPlatform()
// call for some OTHER platform is still in flight, so that call's eventual
// afterConnect() can tell it should no longer yank the user into a newly-opened
// dashboard tab with the popup closed out from under them.
//
// This is deliberately a single boolean, not "which platform was clicked last" --
// an earlier version tracked the latter (activeConnectPlatformId) and had a real
// bug: starting a connect for one platform (e.g. Teams, which polls up to 15s)
// and then clicking a DIFFERENT platform's row (e.g. Reddit, a few fast fetches)
// while the first is still pending would overwrite that single "current platform"
// value, so Teams' later, entirely legitimate success would be silently dropped
// (no dashboard opened, no error shown) even though the user never left the
// picker at all. Concurrent connects for different platforms are fine; only
// actually leaving the picker (for one of the three special-cased views) should
// suppress a still-pending connect's tab-open.
let leftPlatformPicker = false;

// i18n helpers. Localized text is applied over the English already in the HTML,
// so a missing key or a browser without chrome.i18n simply keeps the English —
// no blank strings, no regression.
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
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
      if (m) el.setAttribute("aria-label", m);
    });
  } catch (e) { /* i18n unavailable */ }
}

// The host permissions the manifest declares. Declaring them is not the same as
// HAVING them: Chrome lets a user set an extension's site access to "On click" or
// "On specific sites", and Firefox MV3 can leave host permissions awaiting opt-in.
// In that state nothing works — the content script never auto-injects and the
// chrome.scripting fallback is rejected too — so the popup checks before it
// promises the user anything.
const SLACK_ORIGINS = ["https://*.slack.com/*", "https://slack.com/*"];

// Callback form on purpose: it is the one shape both Chrome and Firefox support on
// the `chrome.*` namespace, matching the rest of this codebase.
//
// Fails OPEN (resolves true) if the check itself cannot run. This is a diagnostic,
// not a security boundary — the real enforcement is the browser's own permission
// model — so a browser that cannot answer must never be shown a blocking wall it
// has no way to dismiss.
function hasSlackAccess() {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.contains !== "function") {
        resolve(true);
        return;
      }
      chrome.permissions.contains({ origins: SLACK_ORIGINS }, (granted) => {
        void chrome.runtime.lastError;
        resolve(granted !== false);
      });
    } catch (e) {
      resolve(true);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  localizeI18n(document);

  // Check for first-run onboarding
  chrome.storage.local.get(["slack_onboarding_complete"], (data) => {
    if (!data.slack_onboarding_complete) {
      showOnboarding();
    }
  });

  renderPlatformList();

  document.getElementById("btn-back-to-platforms").addEventListener("click", showPlatformList);
  document.getElementById("btn-back-to-platforms-bluesky").addEventListener("click", showPlatformList);
  document.getElementById("btn-back-to-platforms-telegram").addEventListener("click", showPlatformList);

  // Auto-skip the picker only when the active tab is unambiguously Slack's --
  // every other platform's own migration step decides its own auto-detect
  // behavior when it lands (see popup/platform-registry.js's isTabMatch).
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const hostname = tab && tab.url ? safeHostname(tab.url) : null;
    const slackPlatform = PLATFORMS.find((p) => p.id === "slack");
    if (hostname && slackPlatform.isTabMatch(hostname)) {
      enterSlackView();
    }
  });
});

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

// Build the platform picker from popup/platform-registry.js's PLATFORMS table.
function renderPlatformList() {
  const list = document.getElementById("platform-list");
  list.innerHTML = "";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const hostname = tab && tab.url ? safeHostname(tab.url) : null;

    for (const platform of PLATFORMS) {
      const row = document.createElement("li");
      row.className = "platform-row";
      row.dataset.platform = platform.id;

      const isCurrentTab = hostname && typeof platform.isTabMatch === "function" && platform.isTabMatch(hostname);
      if (isCurrentTab) row.classList.add("is-current-tab");
      if (!platform.ready) row.classList.add("is-disabled");

      const dot = document.createElement("span");
      dot.className = "platform-dot";
      dot.style.background = `linear-gradient(135deg, ${platform.accent[0]}, ${platform.accent[1]})`;

      const name = document.createElement("span");
      name.className = "platform-name";
      name.textContent = platform.name;

      const status = document.createElement("span");
      status.className = "platform-status";
      status.textContent = !platform.ready
        ? t("popupComingSoon", "Coming soon")
        : isCurrentTab
          ? t("popupCurrentTab", "This tab")
          : "";

      row.append(dot, name, status);
      row.addEventListener("click", () => onPlatformRowClick(platform));
      list.appendChild(row);
    }
  });
}

function onPlatformRowClick(platform) {
  if (!platform.ready) return; // inert placeholder, nothing to launch yet
  if (platform.id === "slack") {
    leftPlatformPicker = true; // see connectAndLaunchPlatform's afterConnect guard
    enterSlackView();
    return;
  }
  if (platform.id === "bluesky") {
    leftPlatformPicker = true;
    enterBlueskyView();
    return;
  }
  if (platform.id === "telegram") {
    leftPlatformPicker = true;
    enterTelegramView();
    return;
  }
  if (Array.isArray(platform.form)) {
    togglePlatformForm(platform);
    return;
  }
  connectAndLaunchPlatform(platform);
}

// Platforms with no ambient session to check (federated/self-hosted services, or
// anything OAuth-driven that needs a handle first) collect input inline, right
// below their row, before anything is requested or connected -- there's nothing to
// request permission for until the user names a target (see resolveOrigin).
function togglePlatformForm(platform) {
  const existing = document.querySelector(`.platform-form[data-platform="${platform.id}"]`);
  if (existing) {
    existing.remove();
    return;
  }
  // Only one form open at a time.
  document.querySelectorAll(".platform-form").forEach((el) => el.remove());
  clearPlatformConnectError();

  const row = document.querySelector(`.platform-row[data-platform="${platform.id}"]`);
  if (!row) return;

  const formEl = document.createElement("li");
  formEl.className = "platform-form";
  formEl.dataset.platform = platform.id;

  for (const field of platform.form) {
    const label = document.createElement("label");
    label.className = "label";
    label.textContent = field.label;
    label.htmlFor = `platform-form-${platform.id}-${field.id}`;

    const input = document.createElement("input");
    input.type = field.type || "text";
    input.id = `platform-form-${platform.id}-${field.id}`;
    input.className = "text-input";
    input.placeholder = field.placeholder || "";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.field = field.id;

    formEl.append(label, input);
  }

  const connectBtn = document.createElement("button");
  connectBtn.type = "button";
  connectBtn.className = "btn btn-primary platform-form-connect";
  connectBtn.textContent = t("popupConnect", "Connect");
  connectBtn.style.background = `linear-gradient(135deg, ${platform.accent[0]}, ${platform.accent[1]})`;
  connectBtn.addEventListener("click", () => {
    const values = {};
    formEl.querySelectorAll("input[data-field]").forEach((el) => {
      values[el.dataset.field] = el.value;
    });
    connectAndLaunchPlatform(platform, values);
  });
  formEl.appendChild(connectBtn);

  row.insertAdjacentElement("afterend", formEl);
  const firstInput = formEl.querySelector("input");
  if (firstInput) firstInput.focus();
}

function setPlatformRowStatus(platformId, text, { connecting = false } = {}) {
  const row = document.querySelector(`.platform-row[data-platform="${platformId}"]`);
  if (!row) return;
  row.classList.toggle("is-connecting", connecting);
  const status = row.querySelector(".platform-status");
  if (status) status.textContent = text;
}

function showPlatformConnectError(message) {
  const el = document.getElementById("platform-connect-error");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

function clearPlatformConnectError() {
  const el = document.getElementById("platform-connect-error");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

// Request a platform's optional permission (from this click's user gesture, as
// required), run its own connect step if it has one, then open its dashboard tab.
// Every failure path resets the row rather than leaving it stuck on "Connecting...".
//
// formValues is only passed for platforms with a `form` (see togglePlatformForm) --
// it's undefined for the cookie-session platforms that connect with no input.
function connectAndLaunchPlatform(platform, formValues) {
  const row = document.querySelector(`.platform-row[data-platform="${platform.id}"]`);
  if (row && row.classList.contains("is-connecting")) {
    // A fast double-click (or double-submit of the inline form) would otherwise
    // fire chrome.permissions.request twice concurrently -- possibly showing two
    // permission prompts back-to-back, or running connect()/opening the dashboard
    // tab twice. No-op while a request for this same platform is already in flight.
    return;
  }

  leftPlatformPicker = false;
  clearPlatformConnectError();

  // A dynamic-origin platform (e.g. Mastodon's user-typed instance) resolves the
  // one specific origin to request from the form values instead of using a fixed
  // list -- optionalHostPermissions in that case is only the broad pattern Chrome
  // requires be declared for the narrow, resolved request to be legal at runtime.
  let origins = platform.optionalHostPermissions || [];
  if (typeof platform.resolveOrigin === "function") {
    const resolved = platform.resolveOrigin(formValues || {});
    if (!resolved) {
      showPlatformConnectError(t("popupConnectFailed", "Could not connect. Please try again."));
      return;
    }
    origins = [resolved];
  }

  setPlatformRowStatus(platform.id, t("popupConnecting", "Connecting..."), { connecting: true });
  document.querySelectorAll(".platform-form").forEach((el) => el.remove());

  const request = { origins, permissions: platform.optionalPermissions || [] };

  try {
    chrome.permissions.request(request, (granted) => {
      void chrome.runtime.lastError;
      if (!granted) {
        setPlatformRowStatus(platform.id, "");
        showPlatformConnectError(t("popupPermissionDenied", "Permission was not granted, so this platform can't be opened."));
        return;
      }

      const afterConnect = (result) => {
        if (result && result.ok === false) {
          setPlatformRowStatus(platform.id, "");
          showPlatformConnectError(result.message || t("popupConnectFailed", "Could not connect. Please try again."));
          return;
        }
        if (leftPlatformPicker) {
          // The user navigated away from the picker (e.g. into the Slack view)
          // while this connect was still in flight. Don't yank them out of that
          // view by opening a dashboard tab and closing the popup out from under
          // them for a platform they're no longer looking at -- just leave the
          // permission granted; they can click this row again if they still want it.
          setPlatformRowStatus(platform.id, "");
          return;
        }
        chrome.tabs.create({ url: chrome.runtime.getURL(platform.dashboard) });
        window.close();
      };

      if (typeof platform.connect === "function") {
        Promise.resolve(platform.connect(formValues)).then(afterConnect).catch((err) => {
          setPlatformRowStatus(platform.id, "");
          showPlatformConnectError(String(err && err.message ? err.message : err));
        });
      } else {
        afterConnect({ ok: true });
      }
    });
  } catch (err) {
    // chrome.permissions.request() throws synchronously (rather than calling
    // back with granted:false) on a malformed match pattern -- e.g. a
    // resolveOrigin() result that isn't a legal Chrome match pattern. Without
    // this catch, the row would be stuck on "Connecting..." forever with no
    // error shown.
    setPlatformRowStatus(platform.id, "");
    showPlatformConnectError(String(err && err.message ? err.message : err));
  }
}

function showPlatformList() {
  document.getElementById("platform-list-state").classList.remove("hidden");
  document.getElementById("slack-view").classList.add("hidden");
  document.getElementById("bluesky-view").classList.add("hidden");
  document.getElementById("telegram-view").classList.add("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = t("brandTag", "Choose a platform");
  // Coming back to the picker means any still-pending connect for another
  // platform is fair game to open its dashboard tab again once it resolves.
  leftPlatformPicker = false;
}

// Telegram's multi-step login flow (credentials -> code -> 2FA -> success) is
// managed entirely by telegram-popup.bundle.js, same reasoning as
// enterBlueskyView() above -- this only handles which view is visible.
function enterTelegramView() {
  document.getElementById("platform-list-state").classList.add("hidden");
  document.getElementById("telegram-view").classList.remove("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = "Telegram";
}

// Bluesky's own login/status states are managed entirely by bluesky-popup.bundle.js
// (already listening on these elements since page load -- see that file's own
// DOMContentLoaded handler and the comment on its <script> tag in popup.html). This
// just handles which view is visible, matching enterSlackView() below.
function enterBlueskyView() {
  document.getElementById("platform-list-state").classList.add("hidden");
  document.getElementById("bluesky-view").classList.remove("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = "Bluesky";
}

function enterSlackView() {
  document.getElementById("platform-list-state").classList.add("hidden");
  document.getElementById("slack-view").classList.remove("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = "Slack";

  hasSlackAccess().then((granted) => {
    if (!granted) {
      showPermissionRequiredState();
      return;
    }
    detectSlackTab();
  });
}

function detectSlackTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      showOfflineState();
      return;
    }

    if (isSlackClientTab(tab.url)) {
      showActiveState(tab.id);
    } else {
      showOfflineState();
    }
  });
}

// Show only the named state container, so the three Slack-view states can never overlap.
// Also ensures the Slack view itself (as opposed to the platform picker) is what's
// showing, since each of the three states can be driven directly -- e.g. by a test,
// or a future caller -- without going through enterSlackView() first.
function showOnlyState(id) {
  const platformList = document.getElementById("platform-list-state");
  const slackView = document.getElementById("slack-view");
  if (platformList) platformList.classList.add("hidden");
  if (slackView) slackView.classList.remove("hidden");

  ["slack-active-state", "slack-inactive-state", "permission-required-state"].forEach((stateId) => {
    const el = document.getElementById(stateId);
    if (el) el.classList.toggle("hidden", stateId !== id);
  });
}

function showPermissionRequiredState() {
  showOnlyState("permission-required-state");

  const grantBtn = document.getElementById("btn-grant-access");
  const showManualHint = () => {
    const hint = document.getElementById("grant-manual-hint");
    if (hint) hint.classList.remove("hidden");
  };

  // permissions.request() is not universally implemented — Firefox for Android has no
  // it at all (addons-linter flags exactly this as ANDROID_INCOMPATIBLE_API). A button
  // that cannot possibly work is worse than no button, so where the API is missing go
  // straight to the manual steps instead of offering a dead control.
  const canRequest = !!(chrome.permissions && typeof chrome.permissions.request === "function");
  if (!grantBtn || !canRequest) {
    if (grantBtn) grantBtn.classList.add("hidden");
    showManualHint();
    return;
  }

  // Clone to strip listeners, matching the pattern used by the other state handlers.
  const freshBtn = grantBtn.cloneNode(true);
  freshBtn.classList.remove("hidden");
  grantBtn.parentNode.replaceChild(freshBtn, grantBtn);

  freshBtn.addEventListener("click", () => {
    // permissions.request() must be called from a user gesture, which this click is.
    // It can still legitimately fail: the user dismisses the browser's prompt, or the
    // browser declines to prompt for an already-declared REQUIRED host permission
    // (Chrome's own runtime-host-permission model reserves that for its UI). Any of
    // those lands on the manual-steps hint rather than a dead end.
    try {
      chrome.permissions.request({ origins: SLACK_ORIGINS }, (granted) => {
        void chrome.runtime.lastError;
        if (granted) {
          // Access is live now, so re-run normal detection in place.
          detectSlackTab();
        } else {
          showManualHint();
        }
      });
    } catch (e) {
      showManualHint();
    }
  });
}

// True for the Slack web client on any slack.com subdomain (app.slack.com or a
// workspace subdomain like acme.slack.com). Rejects spoofs and the bare domain.
function isSlackClientTab(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".slack.com");
  } catch (e) {
    return false;
  }
}

function showActiveState(tabId) {
  showOnlyState("slack-active-state");

  const workspaceTitle = document.getElementById("workspace-name");
  const launchBtn = document.getElementById("btn-launch");

  // Attempt to contact content script to get workspace info
  chrome.tabs.sendMessage(tabId, { type: "GET_WORKSPACE_INFO" }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script is not listening yet: programmatically inject it!
      workspaceTitle.innerText = t("popupConnecting", "Connecting...");

      chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content.js"]
      }, () => {
        if (chrome.runtime.lastError) {
          // Injection was refused. By far the most common cause is that site access
          // to slack.com is not actually granted — in which case "reload the page"
          // is wrong advice that leaves the user stuck forever. Re-check, and route
          // to the grant flow when that is the real problem.
          hasSlackAccess().then((granted) => {
            if (!granted) {
              showPermissionRequiredState();
              return;
            }
            workspaceTitle.innerText = t("popupSetupRequired", "Setup Required");
            const descEl = document.querySelector(".workspace-info .desc");
            if (descEl) descEl.innerText = t("popupSetupRequiredDesc", "Please reload the Slack page to activate the extension.");
          });
          return;
        }
        
        // Poll for content-script readiness instead of guessing a single delay
        // (fixed timeouts flake on slow machines).
        pollWorkspaceInfo(tabId, workspaceTitle, launchBtn, 6);
      });
    } else if (response && response.workspaceName) {
      workspaceTitle.innerText = response.workspaceName;
      setupLaunchButton(tabId, launchBtn);
    } else {
      workspaceTitle.innerText = t("popupClientLoaded", "Slack Client Loaded");
      setupLaunchButton(tabId, launchBtn);
    }
  });
}

// Ping the freshly-injected content script until it answers (or attempts run out).
function pollWorkspaceInfo(tabId, workspaceTitle, launchBtn, attemptsLeft) {
  chrome.tabs.sendMessage(tabId, { type: "GET_WORKSPACE_INFO" }, (response) => {
    const notReady = chrome.runtime.lastError || !response;
    if (notReady && attemptsLeft > 1) {
      setTimeout(() => pollWorkspaceInfo(tabId, workspaceTitle, launchBtn, attemptsLeft - 1), 150);
      return;
    }
    if (response && response.workspaceName) {
      workspaceTitle.innerText = response.workspaceName;
    } else {
      workspaceTitle.innerText = t("popupClientLoaded", "Slack Client Loaded");
    }
    setupLaunchButton(tabId, launchBtn);
  });
}

function setupLaunchButton(tabId, launchBtn) {
  // Clone to strip any previously attached listeners (SC-BUG-04)
  const freshBtn = launchBtn.cloneNode(true);
  launchBtn.parentNode.replaceChild(freshBtn, launchBtn);

  freshBtn.addEventListener("click", () => {
    chrome.tabs.sendMessage(tabId, { type: "LAUNCH_DASHBOARD" }, (response) => {
      if (chrome.runtime.lastError) {
        const customAlert = document.createElement("div");
        customAlert.style.cssText = "position:absolute; bottom:10px; left:10px; right:10px; padding:10px; background:#ef4444; color:#fff; border-radius:8px; font-size:12px; text-align:center; z-index:1000;";
        customAlert.innerText = t("popupConnectionLost", "Connection lost. Please reload the page.");
        document.body.appendChild(customAlert);
      } else {
        window.close();
      }
    });
  });
}

function showOfflineState() {
  showOnlyState("slack-inactive-state");

  const gotoBtn = document.getElementById("btn-goto-slack");
  // Clone to prevent duplicate listeners if showOfflineState is called multiple times
  const freshBtn = gotoBtn.cloneNode(true);
  gotoBtn.parentNode.replaceChild(freshBtn, gotoBtn);

  freshBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://app.slack.com/client" });
    window.close();
  });
}

// First-run onboarding experience (SC-UX-01)
function showOnboarding() {
  const onboardingEl = document.getElementById("onboarding-card");
  if (!onboardingEl) return;

  onboardingEl.classList.remove("hidden");

  const dismissBtn = document.getElementById("btn-dismiss-onboarding");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      onboardingEl.classList.add("hidden");
      chrome.storage.local.set({ slack_onboarding_complete: true });
    });
  }
}
