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
  if (!chrome.webRequest || registerTeamsWebRequestListener.done) return;
  registerTeamsWebRequestListener.done = true;

  // extraHeaders is required in extraInfoSpec: without it Chrome withholds the
  // Authorization header from ever reaching this listener at all.
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
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
      let path;
      try {
        path = new URL(details.url).pathname;
      } catch {
        return;
      }
      if (!path.includes("/v1/users/ME/")) return;

      chrome.storage.local.set({
        teams_token: authHeader.value,
        teams_base_url: new URL(details.url).origin
      });
    },
    { urls: ["*://*.msg.teams.microsoft.com/v1/users/ME/*", "*://*.teams.microsoft.com/api/*"] },
    ["requestHeaders", "extraHeaders"]
  );
}

registerTeamsWebRequestListener();
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener((added) => {
    if (added.permissions && added.permissions.includes("webRequest")) {
      registerTeamsWebRequestListener();
    }
  });
}
