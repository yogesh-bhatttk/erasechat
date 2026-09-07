// Bluesky's popup logic, bundled separately (see scripts/build-bluesky.js) because
// it needs the real @atproto/oauth-client-browser library, not something that fits
// the generic connect(formValues) shape every other platform in
// popup/platform-registry.js uses. Ported from bulk-clean-for-bluesky's own popup.js.
//
// One real change from that standalone version: identity there was a REQUIRED
// permission, granted at install, so chrome.identity.getRedirectURL() (which the
// OAuth client needs to build its redirect_uri) always worked immediately. Here
// identity is OPTIONAL -- requested only when the user actually opens Bluesky -- so
// client construction is deferred behind an explicit permission check/request
// instead of happening at module load time.
import { BrowserOAuthClient } from '@atproto/oauth-client-browser';

// AT Protocol "loopback client" pattern for public clients that don't host a
// client-metadata.json (see @atproto/oauth-types' oauth-client-id-loopback.js:
// LOOPBACK_CLIENT_ID_ORIGIN === "http://localhost"). Only "http://localhost" is a
// recognized loopback client_id origin, and it must not be used as if it were a
// fetchable metadata URL.
//
// IMPORTANT: this loopback client_id is only valid for local/dev testing -- the
// AT Protocol authorization server rejects it for anything but a literal loopback
// redirect_uri (127.0.0.1/[::1]), which chrome.identity.launchWebAuthFlow's
// *.chromiumapp.org redirect is not (confirmed against the real bsky.social server
// during this platform's audit). Real login requires the hosted client-metadata.json
// URL described in that file's own "_comment" field, used as client_id instead.
const OAUTH_SCOPE = "atproto transition:generic";
const LOOPBACK_CLIENT_ID = `http://localhost?scope=${encodeURIComponent(OAUTH_SCOPE)}`;
const REQUIRED_PERMISSIONS = { permissions: ["identity"], origins: ["https://*/*"] };

let client = null;

function buildClient() {
  const redirectUri = chrome.identity.getRedirectURL();
  return new BrowserOAuthClient({
    handleResolver: "https://bsky.social",
    clientMetadata: {
      client_id: LOOPBACK_CLIENT_ID,
      client_name: "Bulk Clean for Bluesky",
      client_uri: "https://github.com/bulk-clean",
      redirect_uris: [redirectUri],
      scope: OAUTH_SCOPE,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      dpop_bound_access_tokens: true
    }
  });
}

function hasPermission() {
  return new Promise((resolve) => {
    chrome.permissions.contains(REQUIRED_PERMISSIONS, (granted) => resolve(!!granted));
  });
}

function requestPermission() {
  return new Promise((resolve) => {
    chrome.permissions.request(REQUIRED_PERMISSIONS, (granted) => {
      void chrome.runtime.lastError;
      resolve(!!granted);
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const loginSection = document.getElementById("login-section");
  const statusSection = document.getElementById("status-section");
  const handleInput = document.getElementById("handle");
  const loginBtn = document.getElementById("login-btn");
  const errorMsg = document.getElementById("error-msg");
  const connectedHandle = document.getElementById("connected-handle");
  const dashboardBtn = document.getElementById("dashboard-btn");
  const logoutBtn = document.getElementById("logout-btn");

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = "block";
  }

  function showStatus(sub) {
    loginSection.style.display = "none";
    statusSection.style.display = "block";
    connectedHandle.textContent = sub;
    dashboardBtn.style.display = "block";
  }

  // Only attempt to resume an existing session if permission is already granted --
  // buildClient() needs chrome.identity.getRedirectURL(), which requires it.
  if (await hasPermission()) {
    client = buildClient();
    try {
      const result = await client.init();
      if (result && result.session) {
        showStatus(result.session.sub);
      }
    } catch (e) {
      console.error("Init error", e);
    }
  }

  loginBtn.addEventListener("click", async () => {
    let identifier = handleInput.value.trim();
    if (!identifier) {
      showError("Please enter your handle.");
      return;
    }

    if (!identifier.includes(".")) {
      identifier += ".bsky.social";
    }

    loginBtn.textContent = "Connecting...";
    loginBtn.disabled = true;
    errorMsg.style.display = "none";

    try {
      const granted = await requestPermission();
      if (!granted) {
        throw new Error("Permission was not granted, so Bluesky can't be connected.");
      }
      if (!client) client = buildClient();

      const url = await client.authorize(identifier);

      const callbackUrl = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({
          url: url.href,
          interactive: true
        }, (redirectUrl) => {
          if (chrome.runtime.lastError || !redirectUrl) {
            reject(new Error(chrome.runtime.lastError?.message || "Auth flow failed"));
          } else {
            resolve(redirectUrl);
          }
        });
      });

      const urlObj = new URL(callbackUrl);
      const params = new URLSearchParams(urlObj.search || urlObj.hash.slice(1));

      const authResult = await client.initCallback(params, chrome.identity.getRedirectURL());

      showStatus(authResult.session.sub);
    } catch (e) {
      showError(e.message);
    } finally {
      loginBtn.textContent = "Connect";
      loginBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    indexedDB.deleteDatabase("@atproto/oauth-client-browser");
    loginSection.style.display = "block";
    statusSection.style.display = "none";
    handleInput.value = "";
  });

  dashboardBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard-bluesky.html") });
    window.close();
  });
});
