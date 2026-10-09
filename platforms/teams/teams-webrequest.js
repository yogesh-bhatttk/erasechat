// Microsoft Teams' "connect" step is passive, unlike every other platform here: there
// is no login form and no session cookie to check. Teams' own web client authenticates
// via a short-lived Bearer token attached to its own API requests, so this listener
// watches the user's own teams.microsoft.com traffic (once the optional permission is
// granted -- see popup/connect-teams.js) and captures that token the moment it sees one
// go out, exactly the way bulk-clean-for-teams' own background.js did as a standalone
// extension.
//
// "webRequest" is optional, so on a fresh install (or any startup before the user has
// ever connected Teams) `chrome.webRequest` itself is undefined -- not just an API that
// exists but never fires. Calling addListener unconditionally at top level throws
// ("Cannot read properties of undefined (reading 'onSendHeaders')"), which aborts the
// whole service worker's script evaluation and takes every OTHER platform down with it.
// Guard the registration, and register live via permissions.onAdded for a worker that's
// already running when the popup's chrome.permissions.request() grants it -- a later
// restart would also pick it up (chrome.webRequest exists by then), but the running
// worker doesn't get a free restart just because a permission changed.
function registerTeamsWebRequestListener() {
  // Guard the specific event object, not just the chrome.webRequest namespace: a
  // build/policy where the namespace exists but onSendHeaders doesn't would still
  // throw on .addListener below and take down the whole shared service worker for
  // every platform -- the exact failure class this guard exists to prevent.
  if (!chrome.webRequest || !chrome.webRequest.onSendHeaders || registerTeamsWebRequestListener.done) return;
  registerTeamsWebRequestListener.done = true;

  // extraHeaders is required in extraInfoSpec: without it Chrome withholds the
  // Authorization header from ever reaching this listener at all.
  const onTeamsHeaders = (details) => {
      const authHeader = details.requestHeaders.find(h => h.name.toLowerCase() === "authorization");
      if (!authHeader || !authHeader.value.startsWith("Bearer ")) return;

      // Only accept a capture whose PATH actually matches what dashboard-teams.js
      // calls (/v1/users/ME/conversations/...). The broader
      // *://*.teams.microsoft.com/api/* host pattern below is kept because some
      // tenant configurations serve the chat API from the bare teams.microsoft.com
      // host instead of msg.teams.microsoft.com -- but that pattern also matches a
      // large amount of unrelated Teams traffic (presence, notifications, and
      // dozens of other internal APIs), which fires far more often during ordinary
      // use. Storing whichever request happened to fire last (the original
      // behavior) could overwrite a working token/base URL with one for a
      // completely different API and audience, breaking every dashboard call with
      // no permission-related explanation. Gating on the real path instead of just
      // the host means only a request that could plausibly BE the chat API (either
      // host variant) is ever stored.
      let parsed;
      try {
        parsed = new URL(details.url);
      } catch {
        return;
      }
      if (parsed.protocol !== "https:") return;
      const path = parsed.pathname;
      const apiIdx = path.indexOf("/v1/users/ME/");
      if (apiIdx === -1) return;
      // Keep any prefix before /v1/users/ME (the bare-host variant serves the chat
      // API under e.g. /api/chatsvc/<region>) -- the dashboard appends
      // /v1/users/ME/... to this, so storing only the origin 404'd on that variant.
      const baseUrl = parsed.origin + path.slice(0, apiIdx);

      // The captured Bearer token is a live credential (decodable to the user's own
      // AAD identity) refreshed continuously as long as a Teams tab is open, so it's
      // stored session-only (chrome.storage.session, memory-only, cleared on browser
      // close) -- matching the Slack token's own discipline. teams_base_url is not
      // sensitive and stays in local storage so the dashboard doesn't need Teams
      // traffic to have fired again yet just to know which origin to call.
      chrome.storage.session.set({ teams_token: authHeader.value }).catch(() => {});
      chrome.storage.local.set({ teams_base_url: baseUrl }).catch(() => {});
  };
  // teams.cloud.microsoft is Teams on the web's new home (Microsoft redirects every
  // work tenant there from 30 Sep 2026); its chat API calls are captured the same way.
  const filter = { urls: [
    "https://*.msg.teams.microsoft.com/v1/users/ME/*",
    "https://*.teams.microsoft.com/api/*",
    "https://*.teams.cloud.microsoft/api/*",
    "https://*.teams.cloud.microsoft/v1/users/ME/*"
  ] };
  try {
    chrome.webRequest.onSendHeaders.addListener(onTeamsHeaders, filter, ["requestHeaders", "extraHeaders"]);
  } catch (e) {
    // Firefox rejects the Chrome-only "extraHeaders" value (and doesn't need it to
    // expose Authorization), which previously threw here with .done already set,
    // so Teams capture silently never registered there.
    chrome.webRequest.onSendHeaders.addListener(onTeamsHeaders, filter, ["requestHeaders"]);
  }
}

registerTeamsWebRequestListener();
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener((added) => {
    if (added.permissions && added.permissions.includes("webRequest")) {
      registerTeamsWebRequestListener();
    }
  });
}
// Chrome tears down webRequest listeners when the optional permission is revoked, but
// registerTeamsWebRequestListener.done stays true for the life of the service worker --
// without resetting it here, a later re-grant (permissions.onAdded) would return early
// and never actually re-attach the listener until the worker itself restarts.
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener((removed) => {
    if (removed.permissions && removed.permissions.includes("webRequest")) {
      registerTeamsWebRequestListener.done = false;
    }
  });
}
