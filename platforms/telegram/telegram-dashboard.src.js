import { TelegramClient, Api, errors, extensions } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import {
  FloodWaitCancelledError, cancelableDelay, formatTelegramAccount, buildDialogOption,
  filterDialogOptions, resolveTargetPeer, splitByOwnership, telegramLoginErrorKind,
  searchDateBounds
} from './telegram-utils.js';

let client;
let currentResults = [];

// delay: see platforms/shared/dashboard-fetch-utils.js, loaded before this bundle
// by dashboard-telegram.html -- used in place of a local sleep()/setTimeout
// helper so pacing logic isn't duplicated per platform.
//
// mountAdvancedFilters/readAdvancedFilters/buildTextMatcher/passesAdvancedFilters/
// describeActiveFilters/mountExportButtons: see platforms/shared/platform-filters.js,
// likewise a classic script loaded before this bundle (after shared-filters.js,
// whose isSafeRegex it relies on for /regex/ text filters).
//
// FloodWaitCancelledError/cancelableDelay: see telegram-utils.js -- split out into
// their own dependency-free module so they're unit-tested directly (see
// tests/telegram-utils.test.js) rather than only reachable through a live client.

// Retries an invoke() call when Telegram signals a flood-wait, pausing for the
// duration the server asked for instead of letting the whole batch throw. When
// a cancelController is supplied (the delete path; scanning has no Cancel
// button today) a Cancel click during that wait is honored immediately rather
// than only being noticed once this chunk's retries are exhausted.
async function invokeWithFloodWait(invokeFn, { maxRetries = 5, onWait, cancelController } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await invokeFn();
    } catch (err) {
      const isFloodWait = err instanceof errors.FloodWaitError ||
        (typeof err.seconds === 'number' && /FLOOD_WAIT/i.test(err.message || ''));
      if (!isFloodWait || attempt >= maxRetries) {
        throw err;
      }
      const waitMs = (err.seconds || 1) * 1000 + 250; // small buffer past the required wait
      if (onWait) onWait(err.seconds || 1, attempt + 1);
      const cancelled = await cancelableDelay(waitMs, cancelController);
      if (cancelled) throw new FloodWaitCancelledError();
    }
  }
}

// An invalid/revoked/expired session (session logged out elsewhere, account
// deactivated, auth key unregistered, etc.) surfaces from teleproto as an
// errors.UnauthorizedError subclass (AuthKeyUnregisteredError,
// AuthKeyInvalidError, SessionExpiredError, SessionRevokedError,
// UserDeactivatedError/-BanError all extend it, per RPCBaseErrors.js), so
// checking the base class covers every variant without enumerating each one;
// the errorMessage regex is a defensive fallback should a future teleproto
// version surface the same condition as a plain error. Every remaining chunk
// would fail identically, so this is Telegram's equivalent of Reddit/Mastodon/
// Teams/X's `expiredAuth` fail-fast.
function isTelegramAuthError(err) {
  return err instanceof errors.UnauthorizedError ||
    /AUTH_KEY_(UNREGISTERED|INVALID|PERM_EMPTY)|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED/i.test(
      (err && (err.errorMessage || err.message)) || ''
    );
}

// Every client this page creates goes through here. Browsers cannot open raw TCP
// sockets -- teleproto defaults to PromisedNetSockets (Node's `net`), so the
// WebSocket transport must be forced explicitly.
function createClient(sessionString, apiId, apiHash) {
  return new TelegramClient(new StringSession(sessionString || ''), apiId, apiHash, {
    connectionRetries: 5,
    networkSocket: extensions.PromisedWebSockets,
  });
}

// teleproto's own checkAuthorization() returns false on ANY failure, network
// blips included -- which would throw away a perfectly good session whenever the
// connection hiccups. Probe directly instead and only report "unauthorized" for
// an actual auth error; anything else is rethrown as a connection problem.
async function isClientAuthorized(c) {
  try {
    await c.invoke(new Api.updates.GetState());
    return true;
  } catch (err) {
    if (isTelegramAuthError(err)) return false;
    throw err;
  }
}

// Friendly, localized text for a login/RPC failure instead of raw MTProto codes
// like PHONE_CODE_INVALID -- see telegramLoginErrorKind (telegram-utils.js).
function friendlyTelegramError(err) {
  const raw = (err && (err.errorMessage || err.message)) || String(err);
  switch (telegramLoginErrorKind(err)) {
    case 'phoneInvalid': return t("telegramDashErrPhoneInvalid", "That phone number isn't valid for Telegram. Include the country code, e.g. +1 555 555 5555.");
    case 'phoneBanned': return t("telegramDashErrPhoneBanned", "Telegram has blocked this phone number or account from logging in.");
    case 'codeInvalid': return t("telegramDashErrCodeInvalid", "That code isn't right. Check the latest message from Telegram and try again.");
    case 'codeExpired': return t("telegramDashErrCodeExpired", "That code has expired. Click Request Code to get a new one.");
    case 'passwordInvalid': return t("telegramDashErrPasswordInvalid", "Wrong 2FA password. Check it (spaces count) and try again.");
    case 'apiIdInvalid': return t("telegramDashErrApiIdInvalid", "Telegram rejected this API ID / API Hash pair. Copy both again from my.telegram.org/apps.");
    case 'flood': return t("telegramDashErrFlood", "Too many attempts. Telegram asks you to wait a while before trying again.");
    case 'session': return t("telegramDashErrSession", "Your Telegram session is no longer valid (it may have been ended from another device). Please log in again.");
    case 'network': return t("telegramDashErrNetwork", "Couldn't reach Telegram. Check your internet connection and try again.");
    default: return t("telegramDashErrGeneric", `Telegram reported an error: ${raw}`, [raw]);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const connectedAsEl = document.getElementById('connected-as');
  const logoutBtn = document.getElementById('logout-btn');
  const sessionNote = document.getElementById('tg-session-note');
  const loginSection = document.getElementById('tg-login');
  const mainSection = document.getElementById('tg-main');
  const loginError = document.getElementById('tg-login-error');
  const credentialsForm = document.getElementById('tg-form-credentials');
  const codeForm = document.getElementById('tg-form-code');
  const passwordForm = document.getElementById('tg-form-password');
  const apiIdInput = document.getElementById('api-id');
  const apiHashInput = document.getElementById('api-hash');
  const phoneInput = document.getElementById('phone');
  const codeInput = document.getElementById('auth-code');
  const passwordInput = document.getElementById('2fa-password');
  const passwordUsername = document.getElementById('password-username');
  const btnRequest = document.getElementById('btn-request-code');
  const btnCode = document.getElementById('btn-submit-code');
  const btnPassword = document.getElementById('btn-submit-password');

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const chatSearch = document.getElementById('chat-search');
  const chatSelect = document.getElementById('chat-select');
  const targetChatInput = document.getElementById('target-chat');
  const filterInput = document.getElementById('text-filter');
  const onlyMineToggle = document.getElementById('only-mine');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  resultsCount.textContent = formatScanCount(0, { truncated: false, keepTruncated: false });

  // An MTProto client holds an open WebSocket; without this, closing or
  // navigating away from the tab just abandons it. pagehide (not only
  // beforeunload) also fires for bfcache navigations and on mobile.
  window.addEventListener('pagehide', () => {
    if (client) client.disconnect().catch(() => {});
    if (loginClient) loginClient.disconnect().catch(() => {});
  });
  // Restored from the back/forward cache: the clients above were disconnected on
  // pagehide and nothing reconnects them, so start this page over cleanly.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });

  // ---------------------------------------------------------------------------
  // Login (phone -> code -> optional 2FA), run here in a full tab rather than the
  // action popup: reading the code means switching to the Telegram app, which
  // closes the popup and used to kill the login mid-flow.
  // ---------------------------------------------------------------------------

  // tg_session is a saved MTProto auth key -- functionally a standing login with
  // no password/2FA gate of its own -- so it lives in chrome.storage.session
  // (memory-only, cleared on browser close), matching the Slack token's own
  // discipline. api_id/api_hash identify the app, not the user's account, and stay
  // in local storage across restarts. Same keys the popup used before the login
  // moved here, so an existing session keeps working.
  let loginClient = null;
  let loginGeneration = 0; // bumped by "Start over" so a stale flow's callbacks are ignored
  let pendingCode = null;
  let pendingPassword = null;
  let currentLoginStep = null;

  function setLoginMessage(message, isError = true) {
    loginError.textContent = message || '';
    loginError.style.color = isError ? '' : 'var(--text-secondary)';
  }

  function resetLoginButtons() {
    btnRequest.disabled = false;
    btnRequest.textContent = t('telegramPopupRequestCode', 'Request Code');
    btnCode.disabled = false;
    btnCode.textContent = t('telegramPopupSubmitCode', 'Submit Code');
    btnPassword.disabled = false;
    btnPassword.textContent = t('telegramPopupSubmitPassword', 'Submit Password');
  }

  function showLoginStep(step) {
    credentialsForm.hidden = step !== 'credentials';
    codeForm.hidden = step !== 'code';
    passwordForm.hidden = step !== 'password';
    // teleproto's sign-in loop re-enters the SAME step right after a "wrong
    // code"/"wrong password" error -- only clear the message on a real transition,
    // or it would vanish before the user sees it.
    if (step !== currentLoginStep) setLoginMessage('');
    currentLoginStep = step;
    const focusTarget = step === 'code' ? codeInput
      : step === 'password' ? passwordInput
        : [apiIdInput, apiHashInput, phoneInput].find(el => !el.value) || btnRequest;
    focusTarget.focus();
    if (focusTarget.select && step !== 'credentials') focusTarget.select();
  }

  async function showLogin(message, isError = true) {
    mainSection.hidden = true;
    loginSection.hidden = false;
    logoutBtn.hidden = true;
    sessionNote.hidden = false;
    connectedAsEl.textContent = t("telegramDashNotLoggedIn", "(Not logged in)");
    const stored = await chrome.storage.local.get(['tg_api_id', 'tg_api_hash']);
    if (!apiIdInput.value && stored.tg_api_id) apiIdInput.value = String(stored.tg_api_id);
    if (!apiHashInput.value && stored.tg_api_hash) apiHashInput.value = stored.tg_api_hash;
    resetLoginButtons();
    showLoginStep('credentials');
    setLoginMessage(message, isError);
  }

  function abandonLoginFlow() {
    loginGeneration++;
    pendingCode = null;
    pendingPassword = null;
    if (loginClient) loginClient.disconnect().catch(() => {});
    loginClient = null;
  }

  credentialsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const apiIdRaw = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    const phone = phoneInput.value.trim();
    if (!apiIdRaw || !apiHash || !phone) {
      setLoginMessage(t('telegramPopupAllFieldsRequired', 'All fields are required.'));
      ([apiIdInput, apiHashInput, phoneInput].find(el => !el.value.trim()) || apiIdInput).focus();
      return;
    }
    if (!/^\d+$/.test(apiIdRaw)) {
      setLoginMessage(t("telegramDashApiIdNotNumber", "The API ID is a number (digits only), e.g. 123456."));
      apiIdInput.focus();
      return;
    }
    const apiId = parseInt(apiIdRaw, 10);

    abandonLoginFlow();
    const generation = loginGeneration;
    const isCurrent = () => generation === loginGeneration;
    setLoginMessage('');
    btnRequest.disabled = true;
    btnRequest.textContent = t('telegramPopupRequesting', 'Requesting...');
    passwordUsername.value = phone;

    const c = createClient('', apiId, apiHash);
    loginClient = c;
    // Which part of the flow onError is reporting for -- see onError below.
    let stage = 'phone';
    let stoppedAfterError = false;

    c.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        if (!isCurrent()) return new Promise(() => {});
        stage = 'code';
        resetLoginButtons();
        showLoginStep('code');
        return new Promise(r => { pendingCode = r; });
      },
      password: async () => {
        if (!isCurrent()) return new Promise(() => {});
        stage = 'password';
        resetLoginButtons();
        showLoginStep('password');
        return new Promise(r => { pendingPassword = r; });
      },
      // Without this, teleproto signs a number with no Telegram account up for a
      // brand-new one (named "first name"). This tool only cleans existing accounts.
      firstAndLastNames: async () => {
        stage = 'signup';
        const err = new Error('PHONE_NUMBER_UNOCCUPIED');
        err.errorMessage = 'PHONE_NUMBER_UNOCCUPIED';
        throw err;
      },
      onError: async (err) => {
        if (!isCurrent()) return true;
        setLoginMessage(friendlyTelegramError(err));
        resetLoginButtons();
        // In the phone stage teleproto's loop would call phoneNumber() again, get
        // the same rejected number, and fail forever -- stop instead, and let the
        // user fix the form (a fresh client is created on the next submit). The
        // code/password stages loop back to their own prompt, which is what we want
        // -- except an EXPIRED code: re-prompting would only collect more codes for
        // a dead login attempt, so stop and return to the first step (phone kept)
        // where Request Code starts a fresh one.
        if (stage === 'phone' || stage === 'signup' || telegramLoginErrorKind(err) === 'codeExpired') {
          stoppedAfterError = true;
          return true;
        }
        return false;
      },
    }).then(async () => {
      if (!isCurrent()) { c.disconnect().catch(() => {}); return; }
      loginClient = null;
      client = c;
      await Promise.all([
        chrome.storage.session.set({ tg_session: c.session.save() }),
        chrome.storage.local.set({ tg_api_id: apiId, tg_api_hash: apiHash })
      ]);
      codeInput.value = '';
      passwordInput.value = '';
      await enterMain();
    }).catch(err => {
      if (!isCurrent()) return;
      // A rejection that bypasses onError (e.g. a transport-level WebSocket
      // failure inside teleproto) would otherwise leave the button stuck on
      // "Requesting..." with no way to retry.
      if (!stoppedAfterError) setLoginMessage(friendlyTelegramError(err));
      loginClient = null;
      c.disconnect().catch(() => {});
      const message = loginError.textContent;
      resetLoginButtons();
      showLoginStep('credentials');
      setLoginMessage(message);
    });
  });

  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!code) { codeInput.focus(); return; }
    if (!pendingCode) return;
    btnCode.disabled = true;
    btnCode.textContent = t('telegramPopupSubmitting', 'Submitting...');
    const resolve = pendingCode;
    pendingCode = null;
    resolve(code);
  });

  passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // Deliberately NOT trimmed: leading/trailing spaces are legal in a Telegram
    // cloud password, and trimming them made such passwords impossible to enter.
    const password = passwordInput.value;
    if (!password) { passwordInput.focus(); return; }
    if (!pendingPassword) return;
    btnPassword.disabled = true;
    btnPassword.textContent = t('telegramPopupSubmitting', 'Submitting...');
    const resolve = pendingPassword;
    pendingPassword = null;
    resolve(password);
  });

  document.querySelectorAll('.tg-restart').forEach(btn => btn.addEventListener('click', () => {
    abandonLoginFlow();
    codeInput.value = '';
    passwordInput.value = '';
    resetLoginButtons();
    showLoginStep('credentials');
  }));

  // ---------------------------------------------------------------------------
  // Session lifecycle: verify on open, show who is connected, log out for real.
  // ---------------------------------------------------------------------------

  // The stored session stopped working (revoked from another device, expired,
  // account deactivated): forget it and go straight back to the login form.
  async function handleAuthLost(message) {
    if (client) client.disconnect().catch(() => {});
    client = null;
    await chrome.storage.session.remove(['tg_session']);
    currentResults = [];
    itemList.innerHTML = '';
    renderEmptyState(itemList, t("dashScanPromptEmpty", "Enter parameters and click Scan to begin."));
    resultsCount.textContent = formatScanCount(0, { truncated: false, keepTruncated: false });
    deleteBtn.disabled = true;
    refreshExport();
    await showLogin(message || friendlyTelegramError({ errorMessage: 'AUTH_KEY_UNREGISTERED' }));
  }

  let mainInitialized = false;
  // Export CSV/JSON controls (mountExportButtons), created once by initMain();
  // refreshExport() re-evaluates their enabled state after every change to
  // currentResults (render, reset, logout, auth loss).
  let exportControls = null;
  function refreshExport() {
    if (exportControls) exportControls.refresh();
  }

  async function enterMain() {
    loginSection.hidden = true;
    mainSection.hidden = false;
    logoutBtn.hidden = false;
    sessionNote.hidden = false;
    connectedAsEl.textContent = t("telegramPopupConnected", "Connected");
    try {
      const me = await client.getMe();
      const label = formatTelegramAccount(me);
      if (label) connectedAsEl.textContent = t("dashConnectedAs", `(Connected: ${label})`, [label]);
    } catch (err) {
      if (isTelegramAuthError(err)) { await handleAuthLost(); return; }
      console.warn("Telegram getMe failed (non-fatal):", err);
    }
    if (!mainInitialized) {
      mainInitialized = true;
      await initMain();
    }
    loadDialogs();
  }

  async function logOut() {
    logoutBtn.disabled = true;
    let serverLogoutFailed = false;
    try {
      // Merely forgetting the session locally leaves it valid on Telegram's own
      // servers indefinitely (listed under Settings -> Devices) -- invalidate it
      // server-side, then clear local storage either way so a network failure
      // can't trap the user unable to log out of the extension itself.
      if (client) await client.invoke(new Api.auth.LogOut());
    } catch (err) {
      serverLogoutFailed = true;
      console.error("Telegram server-side logout failed (clearing local session anyway):", err);
    } finally {
      if (client) client.disconnect().catch(() => {});
      client = null;
      await Promise.all([
        chrome.storage.session.remove(['tg_session']),
        chrome.storage.local.remove(['tg_api_id', 'tg_api_hash'])
      ]);
      apiIdInput.value = '';
      apiHashInput.value = '';
      currentResults = [];
      refreshExport();
      logoutBtn.disabled = false;
      await showLogin(serverLogoutFailed
        ? t("telegramDashLogoutPartial", "Logged out of Erasechat, but Telegram couldn't be reached to end the session. End it yourself under Telegram → Settings → Devices.")
        : t("telegramDashLoggedOut", "Logged out. The session was ended on Telegram's side too."), serverLogoutFailed);
    }
  }

  // The popup's "Log out" (#logout) must always forget the local login, even when
  // there is no usable session or Telegram can't be reached -- the popup used to
  // clear these keys itself in a finally block.
  async function forgetLocalLogin(message, isError) {
    if (client) client.disconnect().catch(() => {});
    client = null;
    await Promise.all([
      chrome.storage.session.remove(['tg_session']),
      chrome.storage.local.remove(['tg_api_id', 'tg_api_hash'])
    ]);
    apiIdInput.value = '';
    apiHashInput.value = '';
    currentResults = [];
    refreshExport();
    connectedAsEl.textContent = '';
    await showLogin(message, isError);
  }

  logoutBtn.addEventListener('click', async () => {
    const ok = await showConfirm(
      t("telegramDashLogoutConfirm", "Log out of Telegram here? This also ends the session on Telegram's side, so it disappears from Settings → Devices.")
    );
    if (ok) await logOut();
  });

  // ---------------------------------------------------------------------------
  // Chat picker: the first ~100 dialogs, searchable, with Saved Messages as the
  // default; a typed username/phone still overrides it (resolveTargetPeer).
  // ---------------------------------------------------------------------------
  let dialogOptions = [];
  const dialogEntities = new Map();

  function renderDialogOptions() {
    const previous = chatSelect.value;
    const filtered = filterDialogOptions(dialogOptions, chatSearch.value);
    chatSelect.innerHTML = '';
    const saved = document.createElement('option');
    saved.value = 'me';
    saved.textContent = t("telegramDashSavedMessages", "Saved Messages");
    chatSelect.appendChild(saved);
    for (const o of filtered) {
      const opt = document.createElement('option');
      opt.value = o.key;
      opt.textContent = o.username ? `${o.label} (@${o.username})` : o.label;
      chatSelect.appendChild(opt);
    }
    if (chatSearch.value.trim() && filtered.length === 0) {
      const none = document.createElement('option');
      none.disabled = true;
      none.textContent = t("telegramDashNoChatsMatch", "No chats match your search");
      chatSelect.appendChild(none);
    }
    if ([...chatSelect.options].some(o => o.value === previous && !o.disabled)) {
      chatSelect.value = previous;
    } else if (filtered.length > 0 && chatSearch.value.trim()) {
      chatSelect.value = filtered[0].key;
    }
  }

  async function loadDialogs() {
    chatSearch.disabled = true;
    chatSearch.placeholder = t("telegramDashLoadingChats", "Loading your chats...");
    try {
      const dialogs = await invokeWithFloodWait(() => client.getDialogs({ limit: 100 }));
      dialogOptions = [];
      dialogEntities.clear();
      for (const d of dialogs || []) {
        const opt = buildDialogOption(d);
        if (!opt || dialogEntities.has(opt.key)) continue;
        dialogEntities.set(opt.key, { entity: d.entity, input: d.inputEntity || d.entity });
        dialogOptions.push(opt);
      }
    } catch (err) {
      if (isTelegramAuthError(err)) { await handleAuthLost(); return; }
      logActivity('sc-activity-log', t("telegramDashDialogsFailed", `Couldn't load your chat list (${friendlyTelegramError(err)}). You can still type a username or phone number.`, [friendlyTelegramError(err)]), 'warn');
    } finally {
      chatSearch.disabled = false;
      chatSearch.placeholder = t("telegramDashChatSearchPlaceholder", "Search your chats");
    }
    renderDialogOptions();
  }

  chatSearch.addEventListener('input', renderDialogOptions);

  // ---------------------------------------------------------------------------
  // Startup: restore an existing session if it's still authorized, otherwise
  // show the login form (prefilled from the popup's hand-off, if any).
  // ---------------------------------------------------------------------------
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['tg_session', 'tg_login_handoff']),
    chrome.storage.local.get(['tg_api_id', 'tg_api_hash'])
  ]);
  // One-shot: the popup's "Continue" button leaves the phone number here (memory-
  // only) so the login can start without retyping it.
  const handoff = sessionData.tg_login_handoff || null;
  if (handoff) await chrome.storage.session.remove(['tg_login_handoff']);
  const wantsLogout = location.hash === '#logout';
  if (wantsLogout) history.replaceState(null, '', location.pathname);

  if (sessionData.tg_session && localData.tg_api_id && localData.tg_api_hash) {
    client = createClient(sessionData.tg_session, localData.tg_api_id, localData.tg_api_hash);
    let authorized;
    try {
      await client.connect();
      authorized = await isClientAuthorized(client);
    } catch (e) {
      if (wantsLogout) {
        await forgetLocalLogin(t("telegramDashLogoutPartial", "Logged out of Erasechat, but Telegram couldn't be reached to end the session. End it yourself under Telegram → Settings → Devices."), true);
        return;
      }
      client.disconnect().catch(() => {});
      client = null;
      connectedAsEl.textContent = '';
      await showLogin(t("telegramDashConnectFailed", `Couldn't connect to Telegram: ${friendlyTelegramError(e)} Reload this tab to try again, or log in again below.`, [friendlyTelegramError(e)]));
      return;
    }
    if (!authorized && wantsLogout) {
      // Already invalid on Telegram's side -- nothing to end there.
      await forgetLocalLogin(t("telegramDashLoggedOut", "Logged out. The session was ended on Telegram's side too."));
    } else if (!authorized) {
      await handleAuthLost(t("telegramDashSessionInvalid", "Your saved Telegram session is no longer valid. Please log in again."));
    } else if (wantsLogout) {
      await logOut();
    } else {
      await enterMain();
    }
  } else if (wantsLogout) {
    await forgetLocalLogin(t("telegramDashLoggedOut", "Logged out. The session was ended on Telegram's side too."));
  } else {
    await showLogin();
    if (handoff && handoff.phone) {
      phoneInput.value = handoff.phone;
      if (apiIdInput.value && apiHashInput.value) credentialsForm.requestSubmit();
    }
  }

  // ---------------------------------------------------------------------------
  // Scan / delete -- wired once, the first time a logged-in session is shown.
  // ---------------------------------------------------------------------------
  async function initMain() {
  // reportInterruptedDelete: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this bundle by dashboard-telegram.html -- this marker only informs the
  // next session that a delete was interrupted; it does not resume the delete
  // itself, since a fresh scan is required to see current state.
  const DELETE_PROGRESS_KEY = 'telegram_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  // Date range + invert ("keep matches, delete the rest") + /regex/ hint, injected
  // into this section's .filter-form right before #scan-btn. initMain() runs once
  // per page (mainInitialized), and the helper is idempotent besides, so this
  // never mounts twice. No keep-min/keep-pinned rules: Telegram messages carry
  // no score, and pins aren't exposed by messages.Search results reliably.
  mountAdvancedFilters();

  // Set by the scan handler, read by the delete handler -- see the delete handler
  // for why the resolved entity (not just the raw peer string) matters. A chat
  // picked from the dialog list already carries its entity (lastPeerEntity).
  let lastPeer = 'me';
  let lastPeerEntity = null;
  let lastPeerLabel = '';
  // Saved Messages (your own chat): everything in it is yours, but messages you
  // forwarded there carry out === false, so `out` alone would label them
  // "Someone else", leave them unselected and miscount them as unconfirmed.
  let lastPeerIsSelf = true;
  const isOwnMessage = (msg) => lastPeerIsSelf || msg.out === true;

  // Export exactly what the last scan found (currentResults), labeled with the
  // same You/Someone else ownership the rows show. Read-only: exporting never
  // deletes anything, and the delete flow stays preview-first as before.
  exportControls = mountExportButtons({
    platform: 'telegram',
    columns: [
      { label: 'id', get: (msg) => msg.id },
      { label: 'date', get: (msg) => (msg.date ? new Date(msg.date * 1000).toISOString() : '') },
      { label: 'author', get: (msg) => (isOwnMessage(msg) ? t("telegramDashAuthorYou", "You") : t("telegramDashAuthorOther", "Someone else")) },
      { label: 'text', get: (msg) => msg.message || '' },
      { label: 'chat', get: () => lastPeerLabel }
    ],
    getItems: () => currentResults
  });
  refreshExport();

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a cancelled delete leaves some scanned items un-deleted -- those
  // stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    // Only the user's own messages start selected -- another person's message is
    // deleted for both sides, so it must be an explicit opt-in per row.
    resetSelection(items, isOwnMessage);
    const selectAllBox = renderSelectAllControl(itemList);
    selectAllBox.checked = items.every(isOwnMessage);
    const rowCheckboxes = [];
    visibleRows(items).forEach(msg => {
      const div = document.createElement('div');
      div.className = 'post-item';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      timeDiv.textContent = new Date(msg.date * 1000).toLocaleString();

      const textDiv = document.createElement('div');
      if (msg.message) {
        textDiv.textContent = msg.message;
      } else {
        const i = document.createElement('i');
        i.textContent = t("telegramDashNoTextMedia", "[No text/Media only]");
        textDiv.appendChild(i);
      }

      // Deletion is "for everyone" (revoke: true), so when the scan includes other
      // people's messages every row must say whose it is.
      const authorDiv = document.createElement('div');
      authorDiv.className = 'post-time';
      const own = isOwnMessage(msg);
      authorDiv.textContent = own ? t("telegramDashAuthorYou", "You") : t("telegramDashAuthorOther", "Someone else");
      if (!own) authorDiv.style.color = '#ef4444';

      div.appendChild(timeDiv);
      div.appendChild(authorDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, msg, rowCheckboxes);
      itemList.appendChild(div);
    });
    appendHiddenRowsNote(itemList, items.length);
    wireSelectAll(selectAllBox, items, rowCheckboxes);
    refreshExport();
  }

  function showScanCancelled(logMessage) {
    currentResults = [];
    refreshExport();
    renderEmptyState(itemList, t("telegramDashScanCancelled", "Scan cancelled."));
    resultsCount.textContent = formatScanCount(0, { truncated: false, keepTruncated: false });
    statusText.textContent = t("telegramDashScanCancelled", "Scan cancelled.");
    logActivity('sc-activity-log', logMessage, 'warn');
  }

  scanBtn.addEventListener('click', async () => {
    const target = resolveTargetPeer(targetChatInput.value, chatSelect.value);
    if (target.kind === 'dialog') {
      const known = dialogEntities.get(target.value);
      if (!known) {
        await showAlert(t("telegramDashPickChatAgain", "That chat is no longer in the list. Pick it again, or type its username."));
        return;
      }
      lastPeer = known.input;
      lastPeerEntity = known.entity;
      lastPeerIsSelf = !!(known.entity && known.entity.self);
      lastPeerLabel = chatSelect.selectedOptions[0]?.textContent || target.value;
    } else {
      lastPeer = target.value;
      lastPeerEntity = null;
      lastPeerIsSelf = target.kind === 'self' || /^(me|self)$/i.test(target.value);
      lastPeerLabel = target.kind === 'self' ? t("telegramDashSavedMessages", "Saved Messages") : target.value;
    }
    const peer = lastPeer;
    const filterText = filterInput.value.trim();
    const filters = readAdvancedFilters();
    if (filters.fromMs != null && filters.toMs != null && filters.fromMs > filters.toMs) {
      await showAlert(t("telegramDashDateRangeInvalid", "The \"From\" date is after the \"To\" date. Fix the date range and scan again."));
      return;
    }
    // Plain text is a case-insensitive substring (as before); a /slash-wrapped/
    // value is a regex, guarded by isSafeRegex -- an unsafe or invalid pattern
    // falls back to a literal match and is reported below rather than silently.
    const matcher = buildTextMatcher(filterText, filters.invert);
    // Telegram narrows the date range itself (messages.Search minDate/maxDate), so
    // a narrow window doesn't page through the whole chat; passesAdvancedFilters
    // below is still the exact, inclusive check.
    const { minDate, maxDate } = searchDateBounds(filters);
    const onlyMine = onlyMineToggle.checked;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    logoutBtn.disabled = true;
    statusText.style.color = "";
    statusText.textContent = t("dashScanning", "Scanning...");
    renderEmptyState(itemList, t("telegramDashScanningMessages", "Scanning messages..."));
    currentResults = [];
    refreshExport();
    const authorsLabel = onlyMine
      ? t("telegramDashLogOnlyMine", "only my messages")
      : t("telegramDashLogAllAuthors", "all authors");
    logActivity('sc-activity-log', filterText
      ? t("telegramDashLogScanStartedFilter", `Scan started (target: ${lastPeerLabel}, ${authorsLabel}, filter: "${filterText}").`, [lastPeerLabel, authorsLabel, filterText])
      : t("telegramDashLogScanStarted", `Scan started (target: ${lastPeerLabel}, ${authorsLabel}).`, [lastPeerLabel, authorsLabel]));
    const activeFilters = describeActiveFilters(filters);
    if (activeFilters) logActivity('sc-activity-log', activeFilters);
    if (matcher.warning === 'unsafe') {
      logActivity('sc-activity-log', t("telegramDashLogRegexUnsafe", "That /regex/ could be very slow to run, so it was matched as plain text instead."), 'warn');
    } else if (matcher.warning === 'invalid') {
      logActivity('sc-activity-log', t("telegramDashLogRegexInvalid", "That /regex/ isn't valid, so it was matched as plain text instead."), 'warn');
    }

    // Scanning has no Cancel button on any of these platform dashboards -- their
    // own scan loops are quick bounded pagination with no indefinite wait. Telegram
    // is the exception: a server-issued flood-wait mid-scan can run for minutes
    // (see invokeWithFloodWait), and without this the only way out was closing the
    // tab. Wire the same cancel machinery the delete loop below already uses, just
    // with scan-appropriate confirm copy (nothing has been deleted yet to lose).
    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController, t("telegramDashStopScanConfirm", "Stop scanning? Nothing has been deleted yet -- this only discards the in-progress scan."), scanCancelLabels());
    let cancelledEarly = false;

    try {
      let offsetId = 0;
      let hasMore = true;
      let pageCount = 0;
      let truncated = false;
      // Cap pagination like the mastodon/reddit/x dashboards so a large saved-messages
      // history or long-lived chat can't be scanned in full on every click.
      const MAX_PAGES = 20; // 100 messages per page * 20 = 2000 messages per scan
      while (hasMore && pageCount < MAX_PAGES) {
        if (cancelController.cancelled) { cancelledEarly = true; break; }
        const result = await invokeWithFloodWait(
          () => client.invoke(
            new Api.messages.Search({
              peer: peer,
              // Always search with an empty query and filter locally below (see the
              // loop just under this call) instead of sending filterText to
              // Telegram's own server-side search. That search is token/word-based --
              // a substring like "wor" would not match "word" the way it does on
              // every other platform's dashboard, which does a plain
              // case-insensitive .includes() -- so relying on it here would give the
              // same "Text Filter" control silently different semantics depending on
              // which platform is active. The same goes for /regex/ filters, which
              // Telegram's search can't express at all.
              q: '',
              filter: new Api.InputMessagesFilterEmpty(),
              // Date range IS pushed down (0 = unbounded): unlike text, Telegram's
              // date bounds mean the same thing as ours, just exclusive -- see
              // searchDateBounds, which widens each by a second to compensate.
              minDate,
              maxDate,
              offsetId: offsetId,
              addOffset: 0,
              limit: 100,
              maxId: 0,
              minId: 0,
              // "Only my messages" (on by default) restricts to self-authored
              // messages. Deletion is "for everyone" (revoke: true), so scanning
              // the whole chat would let one Select All + Delete erase the other
              // party's side of a DM. Turning the toggle off is an explicit opt-in
              // for chats the user administers; rows then show their author and
              // other people's messages start unselected (see renderResultRows).
              // Not in Saved Messages: forwarded items there may not carry you as
              // the sender, and every message in it is yours anyway.
              ...(onlyMine && !lastPeerIsSelf ? { fromId: new Api.InputPeerSelf() } : {}),
              hash: 0n,
            })
          ),
          {
            cancelController,
            onWait: (seconds, attempt) => {
              statusText.textContent = t("telegramDashScanFloodWait", `Rate limited by Telegram while scanning — waiting ${seconds}s (retry ${attempt})...`, [String(seconds), String(attempt)]);
            },
          }
        );

        if (!result.messages || result.messages.length === 0) {
          hasMore = false;
          break;
        }

        for (const msg of result.messages) {
          if (msg.className !== 'Message' && msg.className !== 'MessageService') continue;
          // Same text matcher (substring or guarded /regex/, optionally inverted)
          // as every other platform dashboard, applied locally so "Text Filter"
          // means the same thing everywhere; the date check is the exact backstop
          // for the server-side minDate/maxDate above.
          if (!matcher.test(msg.message || '')) continue;
          if (!passesAdvancedFilters(msg, filters, { time: (m) => (m.date ? m.date * 1000 : null) })) continue;
          currentResults.push(msg);
        }

        offsetId = result.messages[result.messages.length - 1].id;
        if (result.messages.length < 100) hasMore = false;
        pageCount++;
        truncated = pageCount >= MAX_PAGES && hasMore;
      }

      if (cancelledEarly) {
        // Matches the confirm dialog's own promise ("nothing has been deleted, this
        // only discards the in-progress scan") -- keeping a partial, unreviewed
        // result set around with Delete enabled would be surprising given the user
        // just explicitly asked to stop.
        showScanCancelled(t("telegramDashLogScanCancelled", `Scan cancelled (${pageCount} page(s) read before stopping).`, [String(pageCount)]));
      } else {
        resultsCount.textContent = formatScanCount(currentResults.length, {
          truncated, maxPages: MAX_PAGES, note: t("telegramDashOlderMayExist", "older messages may exist")
        });

        if (currentResults.length > 0) {
          renderResultRows(currentResults);
          deleteBtn.disabled = false;
          statusText.textContent = t("telegramDashScanComplete", "Scan complete. Review results before deleting.");
          logActivity('sc-activity-log', truncated
            ? t("telegramDashLogScanCompleteTruncated", `Scan complete: ${currentResults.length} message(s) found (truncated -- more may exist).`, [String(currentResults.length)])
            : t("telegramDashLogScanComplete", `Scan complete: ${currentResults.length} message(s) found.`, [String(currentResults.length)]));
        } else {
          renderEmptyState(itemList, t("telegramDashNoMatches", "No messages matched your criteria. Try widening your text filter, or check the target chat."));
          statusText.textContent = t("dashReady", "Ready");
          logActivity('sc-activity-log', t("telegramDashLogScanComplete", "Scan complete: 0 message(s) found.", ["0"]));
        }
      }
    } catch (err) {
      if (err instanceof FloodWaitCancelledError) {
        showScanCancelled(t("telegramDashLogScanCancelledFlood", "Scan cancelled during a flood-wait."));
      } else if (isTelegramAuthError(err)) {
        // A revoked/expired session can't be fixed by retrying -- say so plainly
        // and go straight to the login form.
        logActivity('sc-activity-log', t("telegramDashLogSessionInvalid", "Scan stopped: the Telegram session is no longer valid."), 'error');
        await showAlert(t("telegramDashErrSession", "Your Telegram session is no longer valid (it may have been ended from another device). Please log in again."));
        await handleAuthLost();
      } else {
        const message = friendlyTelegramError(err);
        await showAlert(t("telegramDashScanFailed", `Scan failed: ${message}`, [message]));
        statusText.textContent = t("telegramDashStatusScanFailed", "Scan failed.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("telegramDashScanFailed", `Scan failed: ${message}`, [message]), 'error');
      }
    } finally {
      scanBtn.disabled = false;
      logoutBtn.disabled = false;
      resetCancelButton(cancelBtn);
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const selected = getSelectedItems(currentResults);
    if (selected.length === 0) {
      await showAlert(t("dashNoItemsSelected", "No items are selected. Check at least one item, or use Select All, before deleting."));
      return;
    }
    // confirmBulkDelete's own copy talks about "items"/a generic noun; Telegram's
    // deletion is instead "for everyone" (revoke: true below), which matters enough
    // to say explicitly rather than reuse the generic prompt text.
    if (!(await confirmBulkDelete(selected.length, t("telegramDashNounMessagesForEveryone", "messages for everyone")))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    logoutBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = t("telegramDashStartingDeletion", "Starting deletion...");

    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController);
    const total = String(selected.length);
    logActivity('sc-activity-log', t("telegramDashLogDeleteStarted", `Delete started: ${selected.length} message(s) selected.`, [total]));

    const BATCH_SIZE = 100;
    // deletedCount: messages Telegram can be trusted to have deleted. For a
    // non-channel chat, a request to delete SOMEONE ELSE's message is accepted
    // without error even when Telegram ignores it (basic group, not an admin), so
    // those are tracked separately as "requested" rather than inflating this count.
    let deletedCount = 0;
    let requestedOthersCount = 0;
    const failedChunks = [];
    let cancelledEarly = false;
    let expiredAuth = false;

    try {
      // messages.DeleteMessages operates on the user/basic-group message-ID
      // space only -- a channel or supergroup's messages live in a SEPARATE
      // ID space owned by that channel, and deleting them requires
      // channels.DeleteMessages({channel, id}) instead. messages.Search (the
      // scan call above) happily accepts a channel/supergroup peer and returns
      // real results, but messages.DeleteMessages against those same IDs
      // doesn't throw -- it just silently affects nothing, since the ID space
      // it's checking is the wrong one. Resolve the actual entity so the right
      // API gets called.
      // A transient failure here (network blip, swallowed flood-wait) must NOT be
      // treated the same as "genuinely isn't a channel" -- doing so would silently
      // call messages.DeleteMessages against a channel-space ID, which Telegram
      // accepts without error but deletes nothing, reporting false success. Retry
      // a few times with a short backoff (mirroring invokeWithFloodWait's
      // retry-delay pattern above) before giving up.
      let channelEntity = null;
      let entityResolutionFailed = false;
      if (lastPeerEntity) {
        // Picked from the dialog list: the entity (and so its type) is already known.
        if (lastPeerEntity.className === 'Channel') channelEntity = lastPeerEntity;
      } else {
        const ENTITY_RESOLVE_ATTEMPTS = 3;
        let lastErr = null;
        let resolved = false;
        for (let attempt = 0; attempt < ENTITY_RESOLVE_ATTEMPTS; attempt++) {
          try {
            const entity = await client.getEntity(lastPeer || 'me');
            if (entity && entity.className === 'Channel') {
              channelEntity = entity;
            }
            resolved = true;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < ENTITY_RESOLVE_ATTEMPTS - 1) {
              const cancelled = await cancelableDelay(500 * (attempt + 1), cancelController);
              if (cancelled) break;
            }
          }
        }
        if (!resolved) {
          console.warn("Could not resolve Telegram peer entity after retries; skipping delete to avoid a false success.", lastErr);
          entityResolutionFailed = true;
        }
      }
      // Channel deletes either really happen or throw (e.g. not an admin), so only
      // a non-channel chat needs the own/others split described above.
      const othersUnconfirmed = !channelEntity && !lastPeerIsSelf;

      // The inner per-chunk try/catch below isolates one chunk's failure from
      // the rest of the batch. This outer try/finally is separate: it guards
      // the chrome.storage.local calls (progress marker) and everything else in
      // this handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: selected.length, done: 0 } });
      if (cancelController.cancelled) {
        // A Cancel click during the entity-resolution backoff above is a cancel,
        // not an unverifiable chat type -- don't mislabel it.
        cancelledEarly = true;
      } else if (entityResolutionFailed) {
        // Could not confirm whether this peer is a channel/supergroup (needing
        // channels.DeleteMessages) or not (needing messages.DeleteMessages) --
        // guessing wrong silently no-ops against a real channel while reporting
        // success. Fail the whole selection closed instead of guessing.
        const skippedMsg = t("telegramDashChatTypeUnverified", "Could not verify this chat type — skipped to avoid a false success.");
        failedChunks.push({ count: selected.length, message: skippedMsg });
        progressText.textContent = skippedMsg;
        logActivity('sc-activity-log', t("telegramDashLogChatTypeUnverified", `Delete skipped: could not verify the chat type for "${lastPeerLabel}" after retries — skipped to avoid a false success (0/${selected.length} processed).`, [lastPeerLabel, total]), 'error');
      }
      for (let i = 0; !entityResolutionFailed && i < selected.length; i += BATCH_SIZE) {
        if (cancelController.cancelled) { cancelledEarly = true; break; }
        const chunkMsgs = selected.slice(i, i + BATCH_SIZE);
        const chunk = chunkMsgs.map(m => m.id);

        try {
          // DeleteMessages is atomic per call -- isolate each chunk so one failed
          // chunk (transient network/server error, past the flood-wait retries)
          // doesn't abort every later chunk in the batch.
          await invokeWithFloodWait(
            () => client.invoke(
              channelEntity
                ? new Api.channels.DeleteMessages({ channel: channelEntity, id: chunk })
                : new Api.messages.DeleteMessages({ id: chunk, revoke: true }) // Delete for everyone
            ),
            {
              cancelController,
              onWait: (seconds, attempt) => {
                progressText.textContent = t("telegramDashDeleteFloodWait", `Rate limited by Telegram — waiting ${seconds}s (retry ${attempt})...`, [String(seconds), String(attempt)]);
              },
            }
          );
          // messages.AffectedMessages/channels.AffectedMessages (both call's response
          // type) only carry `pts`/`ptsCount` -- PTS event-log bookkeeping, not a
          // per-ID or even a reliable per-count confirmation of which/how many
          // messages were actually deleted. Not throwing is the only signal MTProto
          // gives here, so this count is "accepted by Telegram", not independently
          // verified -- see the softened wording below where this is reported.
          if (othersUnconfirmed) {
            const { own, others } = splitByOwnership(chunkMsgs);
            deletedCount += own.length;
            requestedOthersCount += others.length;
          } else {
            deletedCount += chunk.length;
          }
        } catch (err) {
          if (err instanceof FloodWaitCancelledError) {
            cancelledEarly = true;
            break;
          }
          failedChunks.push({ count: chunk.length, message: friendlyTelegramError(err) });
          // A revoked/expired session fails every remaining chunk identically --
          // stop immediately with one clear reconnect message instead of
          // retrying each remaining chunk only to fail the same way (matches
          // Reddit/Mastodon/Teams/X's expiredAuth fail-fast).
          if (isTelegramAuthError(err)) {
            expiredAuth = true;
          }
        }

        const failedSoFar = failedChunks.reduce((sum, c) => sum + c.count, 0);
        const processedSoFar = deletedCount + requestedOthersCount + failedSoFar;
        progressText.textContent = failedSoFar > 0
          ? t("telegramDashProgressWithFailures", `Processed ${processedSoFar} of ${selected.length} (${deletedCount} deleted, ${failedSoFar} failed)`, [String(processedSoFar), total, String(deletedCount), String(failedSoFar)])
          : t("telegramDashProgress", `Processed ${processedSoFar} of ${selected.length}`, [String(processedSoFar), total]);
        await maybeSaveDeleteProgress(DELETE_PROGRESS_KEY, processedSoFar, selected.length);

        if (expiredAuth) break;
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);
      // The run is over -- close a still-open "Stop deleting?" confirm so the
      // result alerts below aren't queued behind an out-of-date question.
      dismissStaleCancelConfirm();

      // Whether the run finished, partly failed, or was cancelled, the whole
      // scanned set is now stale (some of it may have just been deleted) --
      // a rescan is required before another delete, same as the failure path
      // below always required.
      currentResults = [];
      refreshExport();
      resultsCount.textContent = formatScanCount(0, { truncated: false, keepTruncated: false });
      const done = String(deletedCount);
      const others = String(requestedOthersCount);
      // Appended wherever other people's messages were only "requested".
      const othersNote = requestedOthersCount > 0
        ? ' ' + t("telegramDashOthersRequested", `${requestedOthersCount} message(s) from other people were requested for deletion — Telegram may ignore deletes of other people's messages unless you're an admin of this chat.`, [others])
        : '';

      if (expiredAuth) {
        statusText.textContent = t("telegramDashStatusSessionInvalid", "Session invalid — log in again.");
        statusText.style.color = "#ef4444";
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', t("telegramDashLogSessionInvalidDelete", `Delete stopped: session invalid (${deletedCount}/${selected.length} deleted).`, [done, total]), 'error');
        await showAlert(t("telegramDashAlertSessionInvalid", `Stopped: your Telegram session appears to be invalid or revoked. ${deletedCount} of ${selected.length} messages were deleted before this happened. Log in again in this tab, then scan again to finish.`, [done, total]) + othersNote);
        await handleAuthLost();
      } else if (cancelledEarly) {
        const processed = deletedCount + requestedOthersCount;
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${processed} of ${selected.length} processed.`, [String(processed), total]);
        statusText.style.color = "#ef4444";
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', t("dashCancelledPartial", `Cancelled: ${processed} of ${selected.length} processed.`, [String(processed), total]) + othersNote, 'warn');
      } else if (failedChunks.length === 0) {
        // Telegram's delete calls confirm nothing more specific than "didn't throw"
        // (see the comment above `deletedCount += ...`) -- worded as "requests
        // completed" rather than an unqualified "N deleted" so this doesn't
        // overstate a per-message-verified count.
        statusText.textContent = t("telegramDashRequestsCompleted", "Deletion requests completed!");
        statusText.style.color = "#10b981";
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', t("telegramDashLogRequestsCompleted", `Delete requests completed: ${deletedCount}/${selected.length} accepted by Telegram.`, [done, total]) + othersNote);
        if (othersNote) {
          progressText.textContent = t("telegramDashProgressOwnAndOthers", `${deletedCount} of your messages deleted; ${requestedOthersCount} from other people requested.`, [done, others]);
          await showAlert(othersNote.trim());
        }
      } else {
        const failedCount = failedChunks.reduce((sum, c) => sum + c.count, 0);
        const failed = String(failedCount);
        const attempted = String(deletedCount + requestedOthersCount + failedCount);
        statusText.textContent = t("telegramDashStatusPartialFail", `Deletion finished: ${deletedCount} deleted, ${failedCount} failed.`, [done, failed]);
        statusText.style.color = "#ef4444";
        renderEmptyState(itemList, t("telegramDashDeletionFinishedErrors", "Deletion finished (see error summary)."));
        console.warn("Telegram delete chunk failures:", failedChunks);
        logActivity('sc-activity-log', t("telegramDashLogPartialFail", `Delete finished: ${deletedCount} deleted, ${failedCount} failed out of ${attempted}.`, [done, failed, attempted]) + othersNote, 'warn');
        await showAlert(
          t("telegramDashAlertPartialFail", `Delete failed for ${failedCount} of ${attempted} message(s) (${failedChunks[0].message}). The Delete button will stay disabled -- please Scan again before retrying, since some of the originally scanned messages may already be gone.`, [failed, attempted, failedChunks[0].message]) + othersNote
        );
      }
      // deleteBtn deliberately stays disabled: a rescan is required before another
      // delete, since results that already succeeded should not be re-submitted
      // from stale in-memory state.
    } catch (err) {
      dismissStaleCancelConfirm();
      console.error("Telegram delete loop stopped unexpectedly:", err);
      const message = friendlyTelegramError(err);
      logActivity('sc-activity-log', t("telegramDashLogUnexpected", `Delete stopped unexpectedly: ${message}`, [message]), 'error');
      await showAlert(t("telegramDashAlertUnexpected", `Deletion stopped unexpectedly: ${message}\n\n${deletedCount} of ${selected.length} messages were deleted before this happened.`, [message, String(deletedCount), total]));
      statusText.textContent = t("telegramDashStatusUnexpected", "Deletion stopped unexpectedly.");
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      logoutBtn.disabled = false;
      resetCancelButton(cancelBtn);
    }
  });
  }
});
