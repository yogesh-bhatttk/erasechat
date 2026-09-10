import { TelegramClient, Api, extensions } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

let client;
let resolveCode, resolvePassword;

document.addEventListener('DOMContentLoaded', async () => {
  const stepCredentials = document.getElementById('step-credentials');
  const stepCode = document.getElementById('step-code');
  const stepPassword = document.getElementById('step-password');
  const stepSuccess = document.getElementById('step-success');
  const errorMsg = document.getElementById('error-msg-telegram');

  const btnRequest = document.getElementById('btn-request-code');
  const btnCode = document.getElementById('btn-submit-code');
  const btnPassword = document.getElementById('btn-submit-password');
  const btnDashboard = document.getElementById('btn-dashboard');
  const btnLogout = document.getElementById('btn-logout');

  function showStep(id) {
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    errorMsg.style.display = 'none';
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
  }

  // Check existing session. tg_session is a saved MTProto auth key -- functionally
  // equivalent to a standing login, with no password/2FA gate of its own -- so it
  // lives in chrome.storage.session (memory-only, cleared on browser close),
  // matching the Slack token's own discipline. api_id/api_hash identify the app,
  // not the user's account, and stay in local storage across restarts.
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['tg_session']),
    chrome.storage.local.get(['tg_api_id', 'tg_api_hash'])
  ]);
  const data = { ...sessionData, ...localData };
  if (data.tg_session && data.tg_api_id && data.tg_api_hash) {
    showStep('step-success');
  }

  btnRequest.addEventListener('click', async () => {
    const apiId = parseInt(document.getElementById('api-id').value.trim());
    const apiHash = document.getElementById('api-hash').value.trim();
    const phone = document.getElementById('phone').value.trim();

    if (!apiId || !apiHash || !phone) {
      showError('All fields are required.');
      return;
    }

    btnRequest.disabled = true;
    btnRequest.textContent = 'Requesting...';

    const stringSession = new StringSession('');
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      // Browsers cannot open raw TCP sockets — teleproto defaults to
      // PromisedNetSockets (Node's `net`), so we must explicitly force
      // the WebSocket transport here.
      networkSocket: extensions.PromisedWebSockets,
    });

    try {
      client.start({
        phoneNumber: async () => phone,
        password: async () => {
          showStep('step-password');
          return new Promise(r => resolvePassword = r);
        },
        phoneCode: async () => {
          showStep('step-code');
          return new Promise(r => resolveCode = r);
        },
        onError: (err) => {
          showError(err.message || String(err));
          // onError fires regardless of which step the user was on when the
          // auth flow failed (initial request, code entry, or password entry) --
          // reset all three so whichever one is actually stuck disabled/"Submitting..."
          // is always recoverable without reopening the popup.
          btnRequest.disabled = false;
          btnRequest.textContent = 'Request Code';
          btnCode.disabled = false;
          btnCode.textContent = 'Submit Code';
          btnPassword.disabled = false;
          btnPassword.textContent = 'Submit Password';
        },
      }).then(() => {
        const sessionStr = client.session.save();
        chrome.storage.session.set({ tg_session: sessionStr });
        chrome.storage.local.set({ tg_api_id: apiId, tg_api_hash: apiHash });
        showStep('step-success');
      }).catch(err => {
        // A rejection that bypasses the onError auth hook (e.g. a transport-level
        // WebSocket failure inside teleproto) would otherwise leave the button stuck
        // disabled reading "Requesting..." with no way to retry short of reopening
        // the popup.
        showError(err.message || String(err));
        btnRequest.disabled = false;
        btnRequest.textContent = 'Request Code';
      });
    } catch (err) {
      showError(err.message || String(err));
      btnRequest.disabled = false;
      btnRequest.textContent = 'Request Code';
    }
  });

  btnCode.addEventListener('click', () => {
    const code = document.getElementById('auth-code').value.trim();
    if (code && resolveCode) {
      btnCode.disabled = true;
      btnCode.textContent = 'Submitting...';
      resolveCode(code);
    }
  });

  btnPassword.addEventListener('click', () => {
    const password = document.getElementById('2fa-password').value.trim();
    if (password && resolvePassword) {
      btnPassword.disabled = true;
      btnPassword.textContent = 'Submitting...';
      resolvePassword(password);
    }
  });

  btnDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('platforms/telegram/dashboard-telegram.html') });
  });

  btnLogout.addEventListener('click', async () => {
    // Merely forgetting the session locally leaves it valid on Telegram's own
    // servers indefinitely (visible/revocable only from Telegram's own "Active
    // Sessions" settings). Connect with the stored session and call auth.LogOut so the
    // session is actually invalidated server-side, then clear local storage
    // either way (a network failure here shouldn't trap the user unable to log
    // out of the extension itself).
    btnLogout.disabled = true;
    try {
      const [sessionExisting, localExisting] = await Promise.all([
        chrome.storage.session.get(['tg_session']),
        chrome.storage.local.get(['tg_api_id', 'tg_api_hash'])
      ]);
      const existing = { ...sessionExisting, ...localExisting };
      if (existing.tg_session && existing.tg_api_id && existing.tg_api_hash) {
        const logoutClient = new TelegramClient(
          new StringSession(existing.tg_session),
          existing.tg_api_id,
          existing.tg_api_hash,
          { connectionRetries: 3, networkSocket: extensions.PromisedWebSockets }
        );
        await logoutClient.connect();
        await logoutClient.invoke(new Api.auth.LogOut());
        await logoutClient.disconnect();
      }
    } catch (err) {
      console.error("Telegram server-side logout failed (clearing local session anyway):", err);
    } finally {
      await Promise.all([
        chrome.storage.session.remove(['tg_session']),
        chrome.storage.local.remove(['tg_api_id', 'tg_api_hash'])
      ]);
      showStep('step-credentials');
      btnLogout.disabled = false;
    }
  });
});
