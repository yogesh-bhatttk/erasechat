// Mastodon's "connect" step: verify a user-supplied instance URL + personal access
// token against that instance's own verify_credentials endpoint, then store what
// dashboard-mastodon.js needs.
//
// Ported from bulk-clean-for-mastodon's own popup.js. Unlike Reddit/X's connect
// functions, this one takes the form values the unified popup collected (see
// platform-registry.js's "form" field) instead of reading cookies -- there's no
// ambient session to check for a federated, self-hosted service.
// Tiny, dependency-free i18n helper (same shape as popup.js's own t()) -- self-contained
// so this file's fallback English text doesn't depend on script load order or on any
// other file having run first.
function mastodonT(key, fallback, substitutions) {
  try {
    const m = chrome.i18n.getMessage(key, substitutions);
    if (m) return m;
  } catch (e) { /* i18n unavailable */ }
  return fallback;
}

async function connectMastodon(values) {
  let host = (values["instance-url"] || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token = (values["access-token"] || "").trim();

  if (!host || !token) {
    return { ok: false, message: mastodonT("mastodonConnectMissingFields", "Instance URL and Access Token are required.") };
  }

  // Defense-in-depth hostname validation, mirroring popup/platform-registry.js's
  // resolveOrigin() for this same "mastodon" platform entry. resolveOrigin already
  // gates the popup's own connect flow (host permissions are requested, and this
  // function only ever gets called, against a value it already validated), but this
  // file has no visibility into that caller and shouldn't rely on it alone -- a bare
  // `https://${host}/...` fetch below, given only the scheme-strip + trailing-slash-
  // strip done above, would otherwise trust a userinfo trick like
  // "real.mastodon.social@attacker.com" (per URL parsing rules, "@" starts userinfo,
  // so the actual host becomes attacker.com) and send the bearer token there. Reject
  // anything that isn't a plain hostname before it's ever used in a fetch.
  if (/[^\x00-\x7F]/.test(host)) {
    // Raw Unicode/IDN hostname (e.g. "münchen.social") -- punycode-normalize via URL
    // before the ASCII-only regex below, same as resolveOrigin does.
    try {
      const url = new URL(`https://${host}`);
      if ((url.pathname !== "/" && url.pathname !== "") || url.port) {
        return { ok: false, message: mastodonT("mastodonConnectInvalidHost", "Invalid instance URL.") };
      }
      host = url.hostname;
    } catch {
      return { ok: false, message: mastodonT("mastodonConnectInvalidHost", "Invalid instance URL.") };
    }
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)) {
    return { ok: false, message: mastodonT("mastodonConnectInvalidHost", "Invalid instance URL.") };
  }

  try {
    const response = await fetch(`https://${host}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(mastodonT("mastodonConnectAuthFailed", `Authentication failed (${response.status})`, [String(response.status)]));
    }

    const account = await response.json();
    // The access token is a durable, often broad-scope credential -- equivalent to
    // a standing login, not a short CSRF value -- so it's stored session-only
    // (chrome.storage.session, memory-only, cleared on browser close), matching the
    // Slack token's own discipline. Everything else here is non-secret display/
    // routing metadata and stays in local storage across restarts.
    await chrome.storage.session.set({ mstdn_token: token });
    await chrome.storage.local.set({
      mstdn_host: host,
      mstdn_user_id: account.id,
      mstdn_username: account.username
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message || mastodonT("mastodonConnectFailed", "Failed to connect. Check your URL and token.") };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectMastodon };
}
