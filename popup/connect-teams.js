// Teams' "connect" step is unlike every other platform's: there's no login form and
// no session cookie to check synchronously. background/teams-webrequest.js passively
// captures a Bearer token from the user's own teams.microsoft.com traffic once the
// permission grant lets it see that traffic at all -- so after permission is granted,
// this polls storage for a short while waiting for that capture to happen, rather than
// making any request of its own.
//
// If a token from a previous session is already stored, this resolves immediately.
async function connectTeams({ timeoutMs = 15000, pollIntervalMs = 1000 } = {}) {
  const existing = await chrome.storage.local.get(["teams_token", "teams_base_url"]);
  if (existing.teams_token && existing.teams_base_url) {
    return { ok: true };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const data = await chrome.storage.local.get(["teams_token", "teams_base_url"]);
    if (data.teams_token && data.teams_base_url) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    message: "Could not detect a Teams session. Open teams.microsoft.com in another tab, make sure you're signed in and active there, then try again."
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectTeams };
}
