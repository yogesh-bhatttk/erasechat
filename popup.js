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

document.addEventListener("DOMContentLoaded", () => {
  localizeI18n(document);

  // Check for first-run onboarding
  chrome.storage.local.get(["sc_onboarding_complete"], (data) => {
    if (!data.sc_onboarding_complete) {
      showOnboarding();
    }
  });

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
});

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
  document.getElementById("slack-inactive-state").classList.add("hidden");
  document.getElementById("slack-active-state").classList.remove("hidden");

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
          workspaceTitle.innerText = t("popupSetupRequired", "Setup Required");
          const descEl = document.querySelector(".workspace-info .desc");
          if (descEl) descEl.innerText = t("popupSetupRequiredDesc", "Please reload the Slack page to activate the extension.");
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
  document.getElementById("slack-active-state").classList.add("hidden");
  document.getElementById("slack-inactive-state").classList.remove("hidden");

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
