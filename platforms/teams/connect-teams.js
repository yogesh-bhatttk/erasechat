// Teams' "connect" step is unlike every other platform's: there's no login form and
// no session cookie to check synchronously. background/teams-webrequest.js passively
// captures a Bearer token from the user's own teams.microsoft.com traffic once the
// permission grant lets it see that traffic at all -- so after permission is granted,
// this opens Teams so its authenticated traffic can be observed, rather than
// making any request of its own.
//
// If a token from a previous session is already stored, this resolves immediately.
async function connectTeams() {
  const existing = await chrome.storage.local.get(["teams_token", "teams_base_url"]);
  if (existing.teams_token && existing.teams_base_url) {
    return { ok: true };
  }

  // Opening a tab moves focus away from the action popup, and Chromium destroys
  // that popup. A poll running in this document is therefore cancelled before it
  // can observe the token that Teams produces while the user signs in. Do not
  // start a doomed 15-second poll here: open Teams and have the user reopen the
  // action once its authenticated traffic has been observed by the background
  // listener. The storage check above then opens the dashboard immediately.
  chrome.tabs.create({ url: "https://teams.microsoft.com/" });
  return {
    ok: false,
    message: "Sign in on the teams.microsoft.com tab we opened, then click the Erasechat toolbar icon again to finish connecting."
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectTeams };
}
