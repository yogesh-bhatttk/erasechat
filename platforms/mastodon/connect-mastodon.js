// Mastodon's "connect" step: verify a user-supplied instance URL + personal access
// token against that instance's own verify_credentials endpoint, then store what
// dashboard-mastodon.js needs.
//
// Ported from bulk-clean-for-mastodon's own popup.js. Unlike Reddit/X's connect
// functions, this one takes the form values the unified popup collected (see
// platform-registry.js's "form" field) instead of reading cookies -- there's no
// ambient session to check for a federated, self-hosted service.
async function connectMastodon(values) {
  let host = (values["instance-url"] || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token = (values["access-token"] || "").trim();

  if (!host || !token) {
    return { ok: false, message: "Instance URL and Access Token are required." };
  }

  try {
    const response = await fetch(`https://${host}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Authentication failed (${response.status})`);
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
    return { ok: false, message: err.message || "Failed to connect. Check your URL and token." };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectMastodon };
}
