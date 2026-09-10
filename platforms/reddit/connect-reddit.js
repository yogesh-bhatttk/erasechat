// Reddit's "connect" step: verify a reddit_session cookie exists, then hit
// /api/me.json (with the session riding along via credentials: "include") to get
// the modhash and username dashboard-reddit.js needs for every delete call.
//
// This is the exact logic that used to run automatically in bulk-clean-for-reddit's
// own popup.js on open; here it's a function the unified popup calls once the user
// has picked Reddit from the platform list and granted its optional permission.
//
// The cookie pre-check is a fast, offline "definitely not logged in" short-circuit
// before spending a network round-trip. It is NOT verified against a live account,
// and Reddit has used more than one cookie as its logged-in session marker over the
// years (the legacy "reddit_session", and "token_v2"/"session_tracker" since the
// site's OAuth-backed redesign) -- gating on a single exact name risks a false
// "please log in" for a genuinely logged-in user whose session happens to be
// carried by a different one of these. Checking for ANY of them lowers that risk
// without reintroducing "always hit the network first", which was tried and
// reverted: it makes network reachability load-bearing for a UX path that should
// fail fast and offline, and broke the no-session e2e test's hermeticity (a real
// fetch to reddit.com from a non-mocked test). Still flagging this as a known,
// not-fully-verified gap -- these are the plausible candidates, not a confirmed list.
//
// Returns { ok: true, username } on success, { ok: false, message } on failure --
// never throws, so callers don't need their own try/catch for the network fetch.
const REDDIT_SESSION_COOKIE_NAMES = ["reddit_session", "token_v2", "session_tracker"];

async function connectReddit() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "reddit.com" });
    const hasSessionCookie = cookies.some(c => REDDIT_SESSION_COOKIE_NAMES.includes(c.name));
    if (!hasSessionCookie) {
      return { ok: false, message: "Could not find an active Reddit session. Please log in to Reddit.com first." };
    }

    const response = await fetch("https://www.reddit.com/api/me.json", { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Auth failed (${response.status})`);
    }

    const json = await response.json();
    if (!json.data || typeof json.data.modhash === "undefined" || !json.data.name) {
      throw new Error("Invalid response from Reddit.");
    }

    const { modhash, name } = json.data;
    // modhash is a CSRF-style write token (not the session cookie itself, which is
    // never read or stored here at all -- it rides via credentials: "include") but
    // it's still stored session-only, matching the Slack token's discipline: nothing
    // that authorizes a write on the user's behalf touches chrome.storage.local.
    // The username is plain display metadata, not a credential, so it stays in
    // local storage for convenience across restarts.
    await chrome.storage.session.set({ reddit_modhash: modhash });
    await chrome.storage.local.set({ reddit_username: name });

    return { ok: true, username: name };
  } catch (err) {
    return { ok: false, message: "Error connecting to Reddit. Make sure you are logged in. " + err.message };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectReddit };
}
