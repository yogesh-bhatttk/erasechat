// t(): see popup.js, loaded before this bundle by popup.html -- same bare-global
// reliance pattern telegram-dashboard.src.js already uses for dashboard-fetch-utils.js's
// t(), so this view's labels/buttons/validation text localize the same way every other
// platform's UI does instead of staying hardcoded English.
//
// This view is only a LAUNCHER now. The phone -> code -> 2FA login used to run right
// here, but reading the login code means switching to the Telegram app, which closes
// the action popup and killed the login mid-flow. The whole flow (and the MTProto
// client, so teleproto is no longer bundled into every popup open) lives in the
// dashboard tab instead -- see telegram-dashboard.src.js. The popup keeps its
// existing markup (popup.html's #telegram-view): the credentials step's fields are
// handed off to the dashboard, which requests the code there; the success step opens
// the dashboard or sends the user there to log out (auth.LogOut needs the client).

const DASHBOARD_URL = 'platforms/telegram/dashboard-telegram.html';

function openTelegramDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(DASHBOARD_URL) + hash });
}

document.addEventListener('DOMContentLoaded', async () => {
  const errorMsg = document.getElementById('error-msg-telegram');
  const btnRequest = document.getElementById('btn-request-code');
  const btnDashboard = document.getElementById('btn-dashboard');
  const btnLogout = document.getElementById('btn-logout');
  const apiIdInput = document.getElementById('api-id');
  const apiHashInput = document.getElementById('api-hash');
  const phoneInput = document.getElementById('phone');
  if (!btnRequest || !btnDashboard || !btnLogout) return;

  let currentStepId = null;

  function showStep(id) {
    document.querySelectorAll('#telegram-view .step').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    // Only clear the error on a genuine step change, so a message shown just
    // before re-showing the same step isn't erased unseen (the dashboard's
    // showLoginStep follows the same rule for teleproto's retry loop).
    if (id !== currentStepId) {
      errorMsg.style.display = 'none';
    }
    currentStepId = id;
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
  }

  // The button no longer requests the code itself -- say where it goes.
  const requestLabel = btnRequest.querySelector('span') || btnRequest;
  requestLabel.textContent = t('telegramPopupContinueInTab', 'Continue in a new tab');
  const tabNote = document.createElement('p');
  tabNote.className = 'hint-text';
  tabNote.textContent = t('telegramPopupLoginInTabNote', "Login continues in a full tab, so it isn't lost when you switch to the Telegram app to read your code.");
  btnRequest.insertAdjacentElement('afterend', tabNote);

  // tg_session is a saved MTProto auth key and only ever lives in
  // chrome.storage.session (memory-only, cleared on browser close); api_id/api_hash
  // identify the app, not the user's account, and stay in local storage. The popup
  // can't verify the session without the client -- the dashboard does that on open
  // and falls back to its own login form if it's no longer valid.
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['tg_session']),
    chrome.storage.local.get(['tg_api_id', 'tg_api_hash'])
  ]);
  if (localData.tg_api_id && !apiIdInput.value) apiIdInput.value = String(localData.tg_api_id);
  if (localData.tg_api_hash && !apiHashInput.value) apiHashInput.value = localData.tg_api_hash;
  if (sessionData.tg_session && localData.tg_api_id && localData.tg_api_hash) {
    showStep('step-success');
  }

  btnRequest.addEventListener('click', async () => {
    const apiIdRaw = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    const phone = phoneInput.value.trim();
    if (apiIdRaw && !/^\d+$/.test(apiIdRaw)) {
      showError(t('telegramDashApiIdNotNumber', 'The API ID is a number (digits only), e.g. 123456.'));
      return;
    }
    btnRequest.disabled = true;
    try {
      // Hand whatever was typed to the dashboard so nothing has to be retyped there.
      // The phone number is a one-shot, memory-only hand-off the dashboard removes
      // as soon as it reads it.
      if (apiIdRaw && apiHash) {
        await chrome.storage.local.set({ tg_api_id: parseInt(apiIdRaw, 10), tg_api_hash: apiHash });
      }
      if (phone) await chrome.storage.session.set({ tg_login_handoff: { phone } });
    } catch (err) {
      console.warn('Telegram login hand-off could not be saved (the dashboard will ask again):', err);
    } finally {
      btnRequest.disabled = false;
    }
    openTelegramDashboard();
  });

  btnDashboard.addEventListener('click', () => openTelegramDashboard());

  // auth.LogOut needs a connected MTProto client, which only the dashboard loads --
  // it handles #logout by ending the session server-side and clearing storage.
  btnLogout.addEventListener('click', () => openTelegramDashboard('#logout'));
  // once: popup.js may lazy-inject this bundle and re-dispatch DOMContentLoaded.
}, { once: true });
