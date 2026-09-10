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

async function connectX() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "x.com", name: "ct0" });
    const fallbackCookies = await chrome.cookies.getAll({ domain: ".twitter.com", name: "ct0" });

    const ct0 = cookies.length > 0 ? cookies[0].value : (fallbackCookies.length > 0 ? fallbackCookies[0].value : null);
    if (!ct0) {
      return { ok: false, message: xT("xConnectNoSession", "Could not find an active X.com session. Please log in to X.com in this browser first.") };
    }

    await chrome.storage.session.set({ x_csrf: ct0 });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: xT("xConnectCookieError", "Error accessing cookies. Make sure you have the correct permissions.") };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectX };
}
