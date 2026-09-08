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

  // Open the Teams tab immediately, before polling -- not only after the full
  // timeout. Nothing can succeed here until this tab exists for
  // background/teams-webrequest.js to observe (the token is captured from THIS
  // tab's own traffic), so waiting out the whole poll first would leave a
  // first-time user staring at "Connecting..." for the entire timeout before
  // being told to sign in anywhere. A click already granted the permission, so no
  // extra browser prompt appears; chrome.tabs is always available in this popup
  // context (same as popup.js's own unguarded chrome.tabs.create calls).
  chrome.tabs.create({ url: "https://teams.microsoft.com/" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const data = await chrome.storage.local.get(["teams_token", "teams_base_url"]);
    if (data.teams_token && data.teams_base_url) {
      return { ok: true };
    }
  }

  // This poll runs inside the action popup's own document, which the browser tears
  // down the instant it loses focus -- so telling the user to go manually switch to
  // the tab we just opened would kill this very poll mid-flight and silently abort
  // the whole connect flow with no feedback (the popup just closes, nothing
  // resumes). Instead, tell them the truth: reopening the icon is the next step,
  // not staying on this one. The `existing.teams_token` short-circuit at the top of
  // this function then resolves immediately once the token has been captured.
  return {
    ok: false,
    message: "Could not detect a Teams session yet. Sign in on the teams.microsoft.com tab we opened, then click the Erasechat toolbar icon again to finish connecting."
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectTeams };
}
