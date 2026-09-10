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
async function connectX() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "x.com", name: "ct0" });
    const fallbackCookies = await chrome.cookies.getAll({ domain: ".twitter.com", name: "ct0" });

    const ct0 = cookies.length > 0 ? cookies[0].value : (fallbackCookies.length > 0 ? fallbackCookies[0].value : null);
    if (!ct0) {
      return { ok: false, message: "Could not find an active X.com session. Please log in to X.com in this browser first." };
    }

    await chrome.storage.session.set({ x_csrf: ct0 });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: "Error accessing cookies. Make sure you have the correct permissions." };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectX };
}
