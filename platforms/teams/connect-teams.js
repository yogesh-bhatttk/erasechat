// Teams' "connect" step is unlike every other platform's: there's no login form and
// no session cookie to check synchronously. background/teams-webrequest.js passively
// captures a Bearer token from the user's own teams.microsoft.com traffic once the
// permission grant lets it see that traffic at all -- so after permission is granted,
// this opens Teams so its authenticated traffic can be observed, rather than
// making any request of its own.
//
// If a token from a previous session is already stored, this resolves immediately.

// Tiny, dependency-free i18n helper (same shape as popup.js's own t()) so this file's
// English fallback keeps working under Node's test runtime (tests/teams-connect.test.js
// mocks a minimal `chrome` global with no `i18n` at all) without depending on popup.js
// having already run first.
function teamsT(key, fallback) {
  try {
    const m = chrome.i18n.getMessage(key);
    if (m) return m;
  } catch (e) { /* i18n unavailable (e.g. under the Node test runtime) */ }
  return fallback;
}

async function connectTeams() {
  const [sessionExisting, localExisting] = await Promise.all([
    chrome.storage.session.get(["teams_token"]),
    chrome.storage.local.get(["teams_base_url"])
  ]);
  if (sessionExisting.teams_token && localExisting.teams_base_url) {
    // Connected: clear any pending-hint flag a previous, still-incomplete attempt
    // left behind (see below) so a later popup open doesn't show a stale "sign in"
    // reminder for a platform that is already connected.
    try {
      if (chrome.storage.session && typeof chrome.storage.session.remove === "function") {
        chrome.storage.session.remove(["teams_connect_pending"]);
      }
    } catch (e) { /* best-effort cleanup only */ }
    return { ok: true };
  }

  const hint = teamsT(
    "teamsConnectSignInHint",
    "Sign in on the teams.microsoft.com tab we opened, then click the Erasechat toolbar icon again to finish connecting."
  );

  // Persist the instruction so a popup reopened later (see popup.js's
  // showPendingTeamsConnectHint(), run on DOMContentLoaded) can show it again even if
  // THIS popup closes before the user reads it -- belt-and-suspenders alongside
  // opening the tab as inactive below. Best-effort only: the tab still opens, and the
  // ok:false message below still tries to render immediately, either way.
  try {
    if (chrome.storage.session && typeof chrome.storage.session.set === "function") {
      chrome.storage.session.set({ teams_connect_pending: hint });
    }
  } catch (e) { /* best-effort only */ }

  // Opening a tab moves focus away from the action popup, and Chromium destroys
  // that popup when it does. `active: false` keeps the new tab in the background so
  // creating it does not itself steal focus and close the popup out from under the
  // message below. A poll running in this document would still be cancelled if the
  // popup closes some other way regardless, which is why this doesn't start one:
  // open Teams and have the user reopen the action once its authenticated traffic has
  // been observed by the background listener. The storage check above then opens the
  // dashboard immediately on that next open.
  chrome.tabs.create({ url: "https://teams.microsoft.com/", active: false });
  return { ok: false, message: hint };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { connectTeams };
}
