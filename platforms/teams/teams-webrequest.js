// Microsoft Teams' "connect" step is passive, unlike every other platform here: there
// is no login form and no session cookie to check. Teams' own web client authenticates
// via a short-lived Bearer token attached to its own API requests, so this listener
// watches the user's own teams.microsoft.com traffic (once the optional permission is
// granted -- see popup/connect-teams.js) and captures that token the moment it sees one
// go out, exactly the way bulk-clean-for-teams' own background.js did as a standalone
// extension.
//
// Registered unconditionally at top level (an MV3 requirement for webRequest
// listeners) -- it simply never fires until the extension actually has both the
// webRequest permission and host access to teams.microsoft.com, which
// chrome.permissions.request() in the popup grants on demand.
//
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
