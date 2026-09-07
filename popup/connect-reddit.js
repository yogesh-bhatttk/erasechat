// Reddit's "connect" step: verify a reddit_session cookie exists, then hit
// /api/me.json (with the session riding along via credentials: "include") to get
// the modhash and username dashboard-reddit.js needs for every delete call.
//
// This is the exact logic that used to run automatically in bulk-clean-for-reddit's
// own popup.js on open; here it's a function the unified popup calls once the user
// has picked Reddit from the platform list and granted its optional permission.
//
// Returns { ok: true, username } on success, { ok: false, message } on failure --
// never throws, so callers don't need their own try/catch for the network fetch.
async function connectReddit() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "reddit.com", name: "reddit_session" });
    if (cookies.length === 0) {
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
    await chrome.storage.local.set({ reddit_modhash: modhash, reddit_username: name });

    return { ok: true, username: name };
  } catch (err) {
    return { ok: false, message: "Error connecting to Reddit. Make sure you are logged in. " + err.message };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectReddit };
}
