// X's "connect" step: read the ct0 (CSRF) cookie x.com/twitter.com sets for its own
// logged-in web client and stash it for dashboard-x.js, which rides the rest of the
// session via credentials: "include" on each GraphQL call.
//
// Ported from bulk-clean-for-x's own popup.js. Returns { ok: true } on success,
// { ok: false, message } on failure -- never throws.
//
// ct0 is stored in chrome.storage.session (memory-only, cleared on browser close),
// matching the Slack token's own storage discipline -- never chrome.storage.local,
// so nothing here survives to disk.
// Tiny, dependency-free i18n helper (same shape as popup.js's own t()) -- self-contained
// so this file's fallback English text doesn't depend on script load order or on any
// other file having run first.
function xT(key, fallback, substitutions) {
  try {
    const m = chrome.i18n.getMessage(key, substitutions);
    if (m) return m;
  } catch (e) { /* i18n unavailable */ }
  return fallback;
}

// Same public web-client bearer token dashboard-x.js's own apiFetch() uses --
// required alongside the ct0 CSRF header for X to treat this as an authenticated
// web-client request rather than an anonymous one.
const BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Resolves the signed-in user's own @handle via the stable legacy REST endpoint
// (not GraphQL, so this doesn't depend on dashboard-x.js's scraped/rotating query
// IDs) so the dashboard can pre-fill it instead of making every user recall and
// type their own username on every visit. Best-effort only: returns null on any
// failure (endpoint blocked, network error, unexpected shape) rather than
// throwing -- a user can always type their username manually, so this must never
// block connecting.
async function resolveXUsername(ct0) {
  try {
    const res = await fetch("https://api.x.com/1.1/account/verify_credentials.json", {
      credentials: "include",
      headers: {
        "Authorization": `Bearer ${BEARER_TOKEN}`,
        "x-csrf-token": ct0
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.screen_name === "string" && data.screen_name) || null;
  } catch (e) {
    return null;
  }
}

async function connectX() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "x.com", name: "ct0" });
    const fallbackCookies = await chrome.cookies.getAll({ domain: ".twitter.com", name: "ct0" });

    const ct0 = cookies.length > 0 ? cookies[0].value : (fallbackCookies.length > 0 ? fallbackCookies[0].value : null);
    if (!ct0) {
      return { ok: false, message: xT("xConnectNoSession", "Could not find an active X.com session. Please log in to X.com in this browser first.") };
    }

    await chrome.storage.session.set({ x_csrf: ct0 });

    // Non-sensitive (just a handle, like Reddit's stored username) and best-effort:
    // only written on success, so a transient failure here never erases a
    // previously-resolved username or blocks the connect itself.
    const username = await resolveXUsername(ct0);
    if (username) {
      await chrome.storage.local.set({ x_username: username });
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, message: xT("xConnectCookieError", "Error accessing cookies. Make sure you have the correct permissions.") };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectX, resolveXUsername };
}
