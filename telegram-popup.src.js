import { TelegramClient, extensions } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

let client;
let resolveCode, resolvePassword;

document.addEventListener('DOMContentLoaded', async () => {
  const stepCredentials = document.getElementById('step-credentials');
  const stepCode = document.getElementById('step-code');
  const stepPassword = document.getElementById('step-password');
  const stepSuccess = document.getElementById('step-success');
  // Renamed from 'error-msg' to avoid colliding with Bluesky's own element of the
  // same original id -- both views' markup now lives in the same document.
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

  // Check existing session
  const data = await chrome.storage.local.get(['tg_session', 'tg_api_id', 'tg_api_hash']);
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
          btnRequest.disabled = false;
          btnRequest.textContent = 'Request Code';
        },
      }).then(() => {
        const sessionStr = client.session.save();
        chrome.storage.local.set({
          tg_session: sessionStr,
          tg_api_id: apiId,
          tg_api_hash: apiHash
        });
        showStep('step-success');
      }).catch(err => {
        showError(err.message || String(err));
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
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  btnLogout.addEventListener('click', async () => {
    await chrome.storage.local.remove(['tg_session', 'tg_api_id', 'tg_api_hash']);
    showStep('step-credentials');
  });
});
