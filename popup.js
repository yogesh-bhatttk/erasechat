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
  chrome.storage.local.get(["sc_onboarding_complete"], (data) => {
    if (!data.sc_onboarding_complete) {
      showOnboarding();
    }
  });

  hasSlackAccess().then((granted) => {
    if (!granted) {
      showPermissionRequiredState();
      return;
    }
    detectSlackTab();
  });
});

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

// Show only the named state container, so the three states can never overlap.
function showOnlyState(id) {
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
    return new URL(url).hostname.endsWith(".slack.com");
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
      chrome.storage.local.set({ sc_onboarding_complete: true });
    });
  }
}
