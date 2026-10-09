// Tracks whether the user has navigated away from the platform-picker list (into
// the Slack/Telegram special views) while a connectAndLaunchPlatform()
// call for some OTHER platform is still in flight, so that call's eventual
// afterConnect() can tell it should no longer yank the user into a newly-opened
// dashboard tab with the popup closed out from under them.
//
// This is deliberately a single boolean, not "which platform was clicked last" --
// an earlier version tracked the latter (activeConnectPlatformId) and had a real
// bug: starting a connect for one platform (e.g. Teams, which polls up to 15s)
// and then clicking a DIFFERENT platform's row (e.g. Reddit, a few fast fetches)
// while the first is still pending would overwrite that single "current platform"
// value, so Teams' later, entirely legitimate success would be silently dropped
// (no dashboard opened, no error shown) even though the user never left the
// picker at all. Concurrent connects for different platforms are fine; only
// actually leaving the picker (for one of the three special-cased views) should
// suppress a still-pending connect's tab-open.
let leftPlatformPicker = false;

// How many connectAndLaunchPlatform() calls (potentially for DIFFERENT platforms)
// are currently in flight. Without this, whichever platform's connect finishes
// FIRST calls window.close() and tears down the whole popup document -- silently
// aborting any OTHER platform's still-running connect (e.g. Teams' up-to-15s token
// poll) with no error ever shown, even though concurrent connects for different
// platforms are meant to be safe (see leftPlatformPicker's own comment below).
let pendingConnectCount = 0;

// i18n helpers. Localized text is applied over the English already in the HTML,
// so a missing key or a browser without chrome.i18n simply keeps the English —
// no blank strings, no regression.
// `substitutions` (optional) forwards to chrome.i18n's positional $1/$2 replacement.
function t(key, fallback, substitutions) {
  try {
    const m = chrome.i18n.getMessage(key, substitutions);
    if (m) return m;
  } catch (e) { /* i18n unavailable */ }
  return fallback !== undefined ? fallback : key;
}

// Locales actually shipped in _locales/ -- any other UI language renders the
// English default_locale, so <html lang> must say "en" then. Keep in sync with
// _locales/ (same list as dashboard-fetch-utils.js's SHIPPED_LOCALES).
const POPUP_SHIPPED_LOCALES = ["en", "de", "es", "fr"];

// popup.html hardcoded <html lang="en"> regardless of the UI language.
function applyDocumentLanguage() {
  let ui = "";
  try { ui = chrome.i18n.getUILanguage(); } catch (e) { /* i18n unavailable */ }
  const tag = String(ui || "").replace(/_/g, "-");
  const base = tag.split("-")[0].toLowerCase();
  const lang = POPUP_SHIPPED_LOCALES.includes(base) ? tag : "en";
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = lang;
  }
  return lang;
}

function localizeI18n(root) {
  try {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
      if (m) el.textContent = m;
    });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
      if (m) el.setAttribute("aria-label", m);
    });
    // Same pattern dashboard-fetch-utils.js already uses for platform dashboards --
    // added here so the Telegram popup's inputs (API ID/hash, phone, code, password)
    // can have their placeholders translated too, not just their labels/buttons.
    root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-ph"));
      if (m) el.setAttribute("placeholder", m);
    });
  } catch (e) { /* i18n unavailable */ }
}

// The host permissions the manifest declares. Declaring them is not the same as
// HAVING them: Chrome lets a user set an extension's site access to "On click" or
// "On specific sites", and Firefox MV3 can leave host permissions awaiting opt-in.
// In that state nothing works — the content script never auto-injects and the
// chrome.scripting fallback is rejected too — so the popup checks before it
// promises the user anything.
const SLACK_ORIGINS = ["https://*.slack.com/*", "https://slack.com/*"];

// Callback form on purpose: it is the one shape both Chrome and Firefox support on
// the `chrome.*` namespace, matching the rest of this codebase.
//
// Fails OPEN (resolves true) if the check itself cannot run. This is a diagnostic,
// not a security boundary — the real enforcement is the browser's own permission
// model — so a browser that cannot answer must never be shown a blocking wall it
// has no way to dismiss.
function hasSlackAccess() {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.contains !== "function") {
        resolve(true);
        return;
      }
      chrome.permissions.contains({ origins: SLACK_ORIGINS }, (granted) => {
        void chrome.runtime.lastError;
        resolve(granted !== false);
      });
    } catch (e) {
      resolve(true);
    }
  });
}

// Guarded so this file can be `require()`d from a plain Node test (see
// tests/popup.test.js, which exercises isSlackClientTab in isolation) without a
// real `document` to attach to -- every real popup load always has one.
if (typeof document !== "undefined") {
  // { once: true } matters: loadTelegramBundle() re-dispatches a synthetic
  // DOMContentLoaded for the lazily-injected Telegram bundle, which must not
  // re-run this popup's own initialization.
  document.addEventListener("DOMContentLoaded", () => {
    applyDocumentLanguage();
    localizeI18n(document);

    // Check for first-run onboarding
    chrome.storage.local.get(["erasechat_onboarding_complete"], (data) => {
      if (!data.erasechat_onboarding_complete) {
        showOnboarding();
      }
    });

    renderPlatformList();
    showPendingTeamsConnectHint();

    document.getElementById("btn-back-to-platforms").addEventListener("click", showPlatformList);
    document.getElementById("btn-back-to-platforms-telegram").addEventListener("click", showPlatformList);

    // Auto-skip the picker only when the active tab is unambiguously Slack's --
    // every other platform's own migration step decides its own auto-detect
    // behavior when it lands (see popup/platform-registry.js's isTabMatch).
    getActiveTabCached().then((tab) => {
      const hostname = tab && tab.url ? safeHostname(tab.url) : null;
      const slackPlatform = PLATFORMS.find((p) => p.id === "slack");
      if (hostname && slackPlatform.isTabMatch(hostname)) {
        // Automatic, not user-initiated: don't move focus on popup open.
        enterSlackView({ moveFocus: false });
      }
    });
  }, { once: true });
}

// Cached across every call site that needs the active tab on this popup load
// (DOMContentLoaded's auto-skip check, renderPlatformList's "This tab" badge, and
// detectSlackTab) -- they all resolve to the same tab on the same popup open, so
// without this each one paid for its own redundant chrome.tabs.query IPC round-trip
// on a hot path that runs every time the toolbar icon is clicked. Safe to cache for
// the lifetime of a single popup document: switching the active tab closes the
// popup (loses focus), so a stale cached tab can never be observed here.
let activeTabPromise = null;
function getActiveTabCached() {
  if (!activeTabPromise) {
    activeTabPromise = new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
    });
  }
  return activeTabPromise;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

// Build the platform picker from popup/platform-registry.js's PLATFORMS table.
//
// Each <li> holds a real <button class="platform-row" data-platform=...> (was an
// <li role="button" tabindex="0"> with hand-rolled Enter/Space handling, which
// also put a "button" inside a list without list semantics surviving), plus --
// for a connected platform -- a separate Disconnect button beside it (two
// interactive controls can't nest, hence the wrapper).
function renderPlatformList() {
  const list = document.getElementById("platform-list");
  list.innerHTML = "";

  getActiveTabCached().then((tab) => {
    const hostname = tab && tab.url ? safeHostname(tab.url) : null;

    for (const platform of PLATFORMS) {
      const item = document.createElement("li");
      item.className = "platform-item";
      item.dataset.platformItem = platform.id;

      const row = document.createElement("button");
      row.type = "button";
      row.className = "platform-row";
      row.dataset.platform = platform.id;

      const isCurrentTab = hostname && typeof platform.isTabMatch === "function" && platform.isTabMatch(hostname);
      if (isCurrentTab) row.classList.add("is-current-tab");
      if (!platform.ready) {
        row.classList.add("is-disabled");
        // A disabled native button: announced, but not focusable or clickable.
        row.disabled = true;
      }

      const dot = document.createElement("span");
      dot.className = "platform-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.style.background = `linear-gradient(135deg, ${platform.accent[0]}, ${platform.accent[1]})`;

      const name = document.createElement("span");
      name.className = "platform-name";
      name.textContent = platform.name;

      const status = document.createElement("span");
      status.className = "platform-status";
      status.textContent = !platform.ready
        ? t("popupComingSoon", "Coming soon")
        : isCurrentTab
          ? t("popupCurrentTab", "This tab")
          : "";

      row.append(dot, name, status);
      updatePlatformRowLabel(row, platform.name);
      row.addEventListener("click", () => onPlatformRowClick(platform));
      item.appendChild(row);
      list.appendChild(item);
    }

    refreshDisconnectButtons();
  });
}

// Keeps the row button's accessible name in sync with its visible status
// ("Reddit — Connecting...").
function updatePlatformRowLabel(row, platformName) {
  if (!row) return;
  const name = platformName || (row.querySelector(".platform-name") || {}).textContent || "";
  const status = ((row.querySelector(".platform-status") || {}).textContent || "").trim();
  row.setAttribute("aria-label", status ? `${name} — ${status}` : name);
}

function onPlatformRowClick(platform) {
  if (!platform.ready) return; // inert placeholder, nothing to launch yet
  if (platform.id === "slack") {
    leftPlatformPicker = true; // see connectAndLaunchPlatform's afterConnect guard
    enterSlackView();
    return;
  }
  if (platform.id === "telegram") {
    leftPlatformPicker = true;
    enterTelegramView();
    return;
  }
  if (Array.isArray(platform.form)) {
    togglePlatformForm(platform);
    return;
  }
  connectAndLaunchPlatform(platform);
}

// Platforms with no ambient session to check (federated/self-hosted services, or
// anything OAuth-driven that needs a handle first) collect input inline, right
// below their row, before anything is requested or connected -- there's nothing to
// request permission for until the user names a target (see resolveOrigin).
function togglePlatformForm(platform) {
  const existing = document.querySelector(`.platform-form[data-platform="${platform.id}"]`);
  if (existing) {
    removePlatformForms();
    return;
  }
  // Only one form open at a time.
  removePlatformForms();
  clearPlatformConnectError();

  const row = document.querySelector(`.platform-row[data-platform="${platform.id}"]`);
  if (!row) return;
  const item = row.closest(".platform-item") || row;

  // The <li> keeps .platform-form[data-platform] (tests/CSS rely on it); the
  // fields live in a real <form>, so Enter in either input submits it.
  const formEl = document.createElement("li");
  formEl.className = "platform-form";
  formEl.dataset.platform = platform.id;
  const form = document.createElement("form");
  form.className = "platform-form-body";
  form.noValidate = true;
  form.setAttribute("aria-label", t("popupConnectFormAria", `Connect ${platform.name}`, [platform.name]));

  for (const field of platform.form) {
    const label = document.createElement("label");
    label.className = "label";
    label.textContent = field.labelKey ? t(field.labelKey, field.label) : field.label;
    label.htmlFor = `platform-form-${platform.id}-${field.id}`;

    const input = document.createElement("input");
    input.type = field.type || "text";
    input.id = `platform-form-${platform.id}-${field.id}`;
    input.name = field.id;
    input.className = "text-input";
    input.placeholder = field.placeholderKey ? t(field.placeholderKey, field.placeholder || "") : (field.placeholder || "");
    input.autocomplete = "off";
    input.spellcheck = false;
    if (field.inputmode) input.setAttribute("inputmode", field.inputmode);
    input.dataset.field = field.id;

    form.append(label, input);
  }

  if (platform.formHelpKey) {
    const help = document.createElement("p");
    help.className = "hint-text";
    help.textContent = t(platform.formHelpKey, platform.formHelpFallback || "");
    form.appendChild(help);
  }

  const connectBtn = document.createElement("button");
  connectBtn.type = "submit";
  connectBtn.className = "btn btn-primary platform-form-connect";
  connectBtn.textContent = t("popupConnect", "Connect");
  connectBtn.style.background = platform.buttonBackground ||
    `linear-gradient(135deg, ${platform.accent[0]}, ${platform.accent[1]})`;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = {};
    form.querySelectorAll("input[data-field]").forEach((el) => {
      values[el.dataset.field] = el.value;
    });
    connectAndLaunchPlatform(platform, values);
  });
  form.appendChild(connectBtn);
  formEl.appendChild(form);

  item.insertAdjacentElement("afterend", formEl);
  row.setAttribute("aria-expanded", "true");
  const firstInput = formEl.querySelector("input");
  if (firstInput) firstInput.focus();
}

function removePlatformForms() {
  document.querySelectorAll(".platform-form").forEach((el) => el.remove());
  document.querySelectorAll(".platform-row[aria-expanded]").forEach((el) => el.removeAttribute("aria-expanded"));
}

function setPlatformRowStatus(platformId, text, { connecting = false } = {}) {
  const row = document.querySelector(`.platform-row[data-platform="${platformId}"]`);
  if (!row) return;
  row.classList.toggle("is-connecting", connecting);
  if (connecting) row.setAttribute("aria-busy", "true");
  else row.removeAttribute("aria-busy");
  const status = row.querySelector(".platform-status");
  if (status) status.textContent = text;
  updatePlatformRowLabel(row);
}

// isHint: true renders this as a neutral "here's what to do next" note (e.g.
// Teams' "sign in, then reopen the popup" step) instead of red error-text styling
// -- the same box was previously always styled as an error regardless of which
// kind of message it held, which made Teams' perfectly normal two-step connect
// look like something had gone wrong.
function showPlatformConnectError(message, { isHint = false } = {}) {
  const el = document.getElementById("platform-connect-error");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("notice-text", isHint);
  el.classList.toggle("error-text", !isHint);
  el.classList.remove("hidden");
}

function clearPlatformConnectError() {
  const el = document.getElementById("platform-connect-error");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

// Teams' connect() (see connect-teams.js) opens a teams.microsoft.com tab as inactive
// so creating it doesn't itself blur/close this popup, and shows a "sign in, then
// reopen this popup" instruction via showPlatformConnectError. As a belt-and-suspenders
// fallback -- some browser/focus models might still deactivate an action popup on any
// new tab regardless of `active: false` -- connect-teams.js also persists that same
// instruction to chrome.storage.session, so a freshly reopened popup can show it again
// here even if the first popup closed before the user got to read it. connect-teams.js
// clears the stored hint itself once Teams actually finishes connecting, so this never
// shows a stale reminder for an already-connected platform.
function showPendingTeamsConnectHint() {
  try {
    if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.get !== "function") return;
    chrome.storage.session.get(["teams_connect_pending"], (data) => {
      void chrome.runtime.lastError;
      if (data && data.teams_connect_pending) {
        showPlatformConnectError(data.teams_connect_pending, { isHint: true });
      }
    });
  } catch (e) { /* best-effort only -- never block popup load over this */ }
}

// Request a platform's optional permission (from this click's user gesture, as
// required), run its own connect step if it has one, then open its dashboard tab.
// Every failure path resets the row rather than leaving it stuck on "Connecting...".
//
// formValues is only passed for platforms with a `form` (see togglePlatformForm) --
// it's undefined for the cookie-session platforms that connect with no input.
function connectAndLaunchPlatform(platform, formValues) {
  const row = document.querySelector(`.platform-row[data-platform="${platform.id}"]`);
  if (row && row.classList.contains("is-connecting")) {
    // A fast double-click (or double-submit of the inline form) would otherwise
    // fire chrome.permissions.request twice concurrently -- possibly showing two
    // permission prompts back-to-back, or running connect()/opening the dashboard
    // tab twice. No-op while a request for this same platform is already in flight.
    return;
  }

  leftPlatformPicker = false;
  clearPlatformConnectError();

  // A dynamic-origin platform (e.g. Mastodon's user-typed instance) resolves the
  // one specific origin to request from the form values instead of using a fixed
  // list -- optionalHostPermissions in that case is only the broad pattern Chrome
  // requires be declared for the narrow, resolved request to be legal at runtime.
  let origins = platform.optionalHostPermissions || [];
  if (typeof platform.resolveOrigin === "function") {
    const resolved = platform.resolveOrigin(formValues || {});
    if (!resolved) {
      showPlatformConnectError(t("popupConnectFailed", "Could not connect. Please try again."));
      return;
    }
    origins = [resolved];
  }

  setPlatformRowStatus(platform.id, t("popupConnecting", "Connecting..."), { connecting: true });
  // Leaving the inline form: put focus back on the row (it's about to vanish,
  // which would otherwise drop keyboard focus onto <body>).
  const hadFormFocus = !!(document.activeElement && document.activeElement.closest &&
    document.activeElement.closest(".platform-form"));
  removePlatformForms();
  if (hadFormFocus && row && typeof row.focus === "function") row.focus();

  const request = { origins, permissions: platform.optionalPermissions || [] };

  pendingConnectCount++;
  const finishPending = () => { pendingConnectCount = Math.max(0, pendingConnectCount - 1); };

  try {
    chrome.permissions.request(request, (granted) => {
      void chrome.runtime.lastError;
      if (!granted) {
        finishPending();
        setPlatformRowStatus(platform.id, "");
        showPlatformConnectError(t("popupPermissionDenied", "Permission was not granted, so this platform can't be opened."));
        return;
      }

      // Best-effort revocation of the permission just granted for this connect
      // attempt -- used when connect() reports failure. See revokePlatformPermissions.
      const revokeGrantedPermission = () => {
        revokePlatformPermissions(platform.id, request).catch(() => {});
      };

      const afterConnect = (result) => {
        finishPending();
        if (result && result.ok === false) {
          // pending (Teams' "step 1 of 2": open Teams, then reopen) is not a
          // failure -- its webRequest listener needs the permission just granted
          // to capture the token, so revoking here made Teams impossible to connect.
          if (!result.pending) revokeGrantedPermission();
          setPlatformRowStatus(platform.id, "");
          showPlatformConnectError(
            result.message || t("popupConnectFailed", "Could not connect. Please try again."),
            { isHint: !!result.pending }
          );
          return;
        }
        if (leftPlatformPicker) {
          // The user navigated away from the picker (e.g. into the Slack view)
          // while this connect was still in flight. Don't yank them out of that
          // view by opening a dashboard tab and closing the popup out from under
          // them for a platform they're no longer looking at -- just leave the
          // permission granted; they can click this row again if they still want it.
          setPlatformRowStatus(platform.id, "");
          return;
        }
        const openDashboard = () => {
          // Always settle this row: when another platform's connect is still
          // pending the popup stays open below, and the row used to stay stuck
          // on "Connecting..." (is-connecting, which also blocks re-clicking it).
          setPlatformRowStatus(platform.id, "");
          refreshDisconnectButtons();
          chrome.tabs.create({ url: chrome.runtime.getURL(platform.dashboard) });
          // Only close the popup once every in-flight connect has actually settled --
          // closing earlier would tear down another platform's still-running
          // connect (e.g. Teams' token poll) with no warning. See pendingConnectCount.
          if (pendingConnectCount === 0) {
            window.close();
          }
        };
        // Re-check the permission immediately before opening the dashboard tab --
        // it was granted moments ago above, but a narrow async gap (connect()'s
        // own await, another extension surface, the user revoking it from
        // chrome://extensions mid-flow) could have taken it away again since. A
        // dashboard tab opened without it would just fail internally with no
        // clear explanation, so treat "no longer granted" the same as a connect
        // failure and reuse the same error UI instead.
        if (chrome.permissions && typeof chrome.permissions.contains === "function") {
          chrome.permissions.contains(request, (stillGranted) => {
            void chrome.runtime.lastError;
            if (!stillGranted) {
              setPlatformRowStatus(platform.id, "");
              showPlatformConnectError(t("popupConnectFailed", "Could not connect. Please try again."));
              return;
            }
            openDashboard();
          });
        } else {
          openDashboard();
        }
      };

      if (typeof platform.connect === "function") {
        Promise.resolve(platform.connect(formValues)).then(afterConnect).catch((err) => {
          finishPending();
          setPlatformRowStatus(platform.id, "");
          showPlatformConnectError(connectErrorMessage(err));
        });
      } else {
        afterConnect({ ok: true });
      }
    });
  } catch (err) {
    // chrome.permissions.request() throws synchronously (rather than calling
    // back with granted:false) on a malformed match pattern -- e.g. a
    // resolveOrigin() result that isn't a legal Chrome match pattern. Without
    // this catch, the row would be stuck on "Connecting..." forever with no
    // error shown.
    finishPending();
    setPlatformRowStatus(platform.id, "");
    showPlatformConnectError(connectErrorMessage(err));
  }
}

// An unexpected exception's raw message (e.g. a Chrome API error string) is
// English-only and often cryptic -- wrap it in a localized sentence.
function connectErrorMessage(err) {
  const detail = String(err && err.message ? err.message : err || "").trim();
  return detail
    ? t("popupConnectFailedDetail", `Could not connect (${detail}). Please try again.`, [detail])
    : t("popupConnectFailed", "Could not connect. Please try again.");
}

// ---------------------------------------------------------------------------
// Permission revocation + per-platform Disconnect.
// ---------------------------------------------------------------------------

function permissionsContains(request) {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.contains !== "function") return resolve(false);
      chrome.permissions.contains(request, (has) => {
        void chrome.runtime.lastError;
        resolve(!!has);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function permissionsRemove(request) {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.remove !== "function") return resolve(false);
      chrome.permissions.remove(request, (removed) => {
        void chrome.runtime.lastError;
        resolve(!!removed);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

// API permissions (e.g. "cookies") are global and shared between platforms
// (Reddit and X both use it), so one is only revoked when no OTHER platform that
// needs it still holds its own origins -- otherwise disconnecting (or failing to
// connect) Reddit would silently break an already-connected X.
async function permissionsStillNeededElsewhere(platformId, permissions) {
  const sharedNeeds = PLATFORMS.filter((p) => p.id !== platformId && p.ready &&
    (p.optionalPermissions || []).some((perm) => permissions.includes(perm)) &&
    (p.optionalHostPermissions || []).length > 0);
  const stillNeeded = await Promise.all(sharedNeeds.map(async (p) =>
    (await permissionsContains({ origins: p.optionalHostPermissions })) ? (p.optionalPermissions || []) : []));
  return new Set(stillNeeded.flat());
}

// Revokes `request` ({origins, permissions}) for `platformId`, keeping any API
// permission another connected platform still needs. Never throws.
async function revokePlatformPermissions(platformId, request) {
  try {
    const permissions = request.permissions || [];
    const keep = await permissionsStillNeededElsewhere(platformId, permissions);
    const toRemove = {
      origins: request.origins || [],
      permissions: permissions.filter((perm) => !keep.has(perm))
    };
    if (toRemove.origins.length === 0 && toRemove.permissions.length === 0) return toRemove;
    await permissionsRemove(toRemove);
    return toRemove;
  } catch (e) {
    return null; // best-effort only -- never block the caller over this
  }
}

function storageArea(area) {
  try {
    const s = chrome.storage && chrome.storage[area];
    return s && typeof s.get === "function" ? s : null;
  } catch (e) {
    return null;
  }
}

function storageGet(area, keys) {
  return new Promise((resolve) => {
    const s = storageArea(area);
    if (!s || !keys || keys.length === 0) return resolve({});
    try {
      s.get(keys, (data) => {
        void chrome.runtime.lastError;
        resolve(data || {});
      });
    } catch (e) {
      resolve({});
    }
  });
}

function storageRemove(area, keys) {
  return new Promise((resolve) => {
    const s = storageArea(area);
    if (!s || !keys || keys.length === 0) return resolve();
    try {
      s.remove(keys, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

// The host-permission origins this platform was actually granted. Mastodon's
// is the single instance origin (rebuilt from its stored hostname); the others'
// are their fixed optionalHostPermissions.
function grantedOriginsFor(platform, localData) {
  if (typeof platform.resolveOrigin === "function") {
    const host = platform.storedOriginKey && localData ? localData[platform.storedOriginKey] : null;
    const origin = host ? platform.resolveOrigin({ "instance-url": String(host) }) : null;
    return origin ? [origin] : [];
  }
  return platform.optionalHostPermissions || [];
}

// "Connected" = any of the platform's storage keys present, or (for a fixed-origin
// platform) its host permission still granted -- either way there is something
// for Disconnect to clean up.
async function isPlatformConnected(platform) {
  const keys = platform.storageKeys;
  if (!keys) return false;
  const [sessionData, localData] = await Promise.all([
    storageGet("session", keys.session || []),
    storageGet("local", keys.local || [])
  ]);
  if (Object.keys(sessionData).length > 0 || Object.keys(localData).length > 0) return true;
  if (typeof platform.resolveOrigin !== "function" && (platform.optionalHostPermissions || []).length > 0) {
    return permissionsContains({ origins: platform.optionalHostPermissions });
  }
  return false;
}

// Clears every stored credential/metadata key for the platform and revokes its
// optional permissions (keeping shared API permissions another connected platform
// still needs). For Teams, removing "webRequest" also stops the background's
// passive token capture.
async function disconnectPlatform(platform) {
  const keys = platform.storageKeys || {};
  const localData = await storageGet("local", keys.local || []);
  const origins = grantedOriginsFor(platform, localData);
  await Promise.all([
    storageRemove("session", keys.session || []),
    storageRemove("local", keys.local || [])
  ]);
  const revoked = await revokePlatformPermissions(platform.id, {
    origins,
    permissions: platform.optionalPermissions || []
  });
  return { clearedKeys: [...(keys.session || []), ...(keys.local || [])], revoked };
}

function refreshDisconnectButtons() {
  if (typeof document === "undefined") return Promise.resolve();
  return Promise.all(PLATFORMS.filter((p) => p.ready && p.storageKeys).map(async (platform) => {
    const connected = await isPlatformConnected(platform);
    const row = document.querySelector(`.platform-row[data-platform="${platform.id}"]`);
    const item = row && row.closest ? row.closest(".platform-item") : null;
    if (!item) return;
    let btn = item.querySelector(".platform-disconnect");
    if (!connected) {
      if (btn) btn.remove();
      return;
    }
    if (btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "platform-disconnect";
    btn.textContent = t("popupDisconnect", "Disconnect");
    btn.setAttribute("aria-label", t("popupDisconnectAria", `Disconnect ${platform.name}`, [platform.name]));
    btn.title = t("popupDisconnectHint", "Forget this platform's stored login and remove the extension's access to it.");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await disconnectPlatform(platform);
      // Removing the button drops focus -- keep it on the platform's row.
      btn.remove();
      if (row && typeof row.focus === "function") row.focus();
      showPlatformConnectError(t("popupDisconnected", `Disconnected from ${platform.name}.`, [platform.name]), { isHint: true });
    });
    item.appendChild(btn);
  }));
}

// Moves keyboard focus into a newly-shown view (view switches used to leave
// focus on the now-hidden control that triggered them, i.e. on nothing).
function focusFirst(...candidates) {
  for (const el of candidates) {
    if (el && typeof el.focus === "function" && !el.disabled && el.offsetParent !== null) {
      el.focus();
      return el;
    }
  }
  return null;
}

let lastEnteredViewPlatformId = null;

function showPlatformList() {
  document.getElementById("platform-list-state").classList.remove("hidden");
  document.getElementById("slack-view").classList.add("hidden");
  document.getElementById("telegram-view").classList.add("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = t("brandTag", "Choose a platform");
  // Coming back to the picker means any still-pending connect for another
  // platform is fair game to open its dashboard tab again once it resolves.
  leftPlatformPicker = false;
  // Return focus to the row the user left from (or the first row).
  focusFirst(
    lastEnteredViewPlatformId && document.querySelector(`.platform-row[data-platform="${lastEnteredViewPlatformId}"]`),
    document.querySelector(".platform-row:not([disabled])")
  );
  refreshDisconnectButtons();
}

// The Telegram popup bundle (teleproto + polyfills) is large; it used to be
// parsed on EVERY popup open even though most opens never touch Telegram. It is
// now injected the first time the Telegram view is entered.
const TELEGRAM_POPUP_SCRIPTS = [
  "platforms/telegram/process-shim.js",       // must define `process` first
  "platforms/telegram/telegram-popup.bundle.js"
];
let telegramBundlePromise = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-lazy-src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.dataset.lazySrc = src;
    el.onload = () => resolve();
    el.onerror = () => {
      // Remove the failed tag, or the next attempt would see it and "succeed"
      // without loading anything.
      el.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.body.appendChild(el);
  });
}

function loadTelegramBundle() {
  if (!telegramBundlePromise) {
    telegramBundlePromise = TELEGRAM_POPUP_SCRIPTS.reduce(
      (chain, src) => chain.then(() => loadScriptOnce(src)), Promise.resolve()
    ).then(() => {
      // The bundle wires itself up in a DOMContentLoaded listener, which has
      // already fired by the time it's injected -- re-dispatch it. popup.js's own
      // DOMContentLoaded listener is { once: true }, so it won't run twice.
      if (document.readyState !== "loading") {
        document.dispatchEvent(new Event("DOMContentLoaded"));
      }
    }).catch((err) => {
      telegramBundlePromise = null; // allow a retry on the next visit
      const errEl = document.getElementById("error-msg-telegram");
      if (errEl) {
        errEl.textContent = t("popupTelegramLoadFailed", "Couldn't load the Telegram module. Close and reopen this popup to try again.");
        errEl.style.display = "block";
      }
      throw err;
    });
  }
  return telegramBundlePromise;
}

// Telegram's multi-step login flow (credentials -> code -> 2FA -> success) is
// managed entirely by telegram-popup.bundle.js -- this only handles which view
// is visible (and loading that bundle on first entry).
function enterTelegramView({ moveFocus = true } = {}) {
  lastEnteredViewPlatformId = "telegram";
  document.getElementById("platform-list-state").classList.add("hidden");
  const view = document.getElementById("telegram-view");
  view.classList.remove("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = "Telegram";
  if (moveFocus) {
    focusFirst(view.querySelector(".step.active input, .step.active button"),
      document.getElementById("btn-back-to-platforms-telegram"));
  }
  loadTelegramBundle().then(() => {
    // The bundle may switch steps on load (e.g. an existing session -> success).
    if (moveFocus && !view.classList.contains("hidden") && view.contains(document.activeElement) === false) {
      focusFirst(view.querySelector(".step.active input, .step.active button"));
    }
  }).catch(() => {});
}

function enterSlackView({ moveFocus = true } = {}) {
  lastEnteredViewPlatformId = "slack";
  document.getElementById("platform-list-state").classList.add("hidden");
  document.getElementById("slack-view").classList.remove("hidden");
  const badge = document.getElementById("brand-badge");
  if (badge) badge.textContent = "Slack";
  // The automatic entry (moveFocus: false) still has to rescue focus if it sat on a
  // platform row that was just hidden -- otherwise keyboard users land nowhere.
  const listState = document.getElementById("platform-list-state");
  const focusWasHidden = listState && listState.contains(document.activeElement);
  if (moveFocus || focusWasHidden) focusFirst(document.getElementById("btn-back-to-platforms"));

  hasSlackAccess().then((granted) => {
    if (!granted) {
      showPermissionRequiredState();
      return;
    }
    detectSlackTab();
  });
}

function detectSlackTab() {
  getActiveTabCached().then((tab) => {
    if (!tab || !tab.url) {
      showOfflineState();
      return;
    }

    if (isSlackClientTab(tab.url)) {
      showActiveState(tab.id);
    } else {
      showOfflineState();
    }
  });
}

// Show only the named state container, so the three Slack-view states can never overlap.
// Also ensures the Slack view itself (as opposed to the platform picker) is what's
// showing, since each of the three states can be driven directly -- e.g. by a test,
// or a future caller -- without going through enterSlackView() first.
function showOnlyState(id) {
  const platformList = document.getElementById("platform-list-state");
  const slackView = document.getElementById("slack-view");
  if (platformList) platformList.classList.add("hidden");
  if (slackView) slackView.classList.remove("hidden");

  ["slack-active-state", "slack-inactive-state", "permission-required-state"].forEach((stateId) => {
    const el = document.getElementById(stateId);
    if (el) el.classList.toggle("hidden", stateId !== id);
  });
}

function showPermissionRequiredState() {
  showOnlyState("permission-required-state");

  const grantBtn = document.getElementById("btn-grant-access");
  const showManualHint = () => {
    const hint = document.getElementById("grant-manual-hint");
    if (hint) hint.classList.remove("hidden");
  };

  // permissions.request() is not universally implemented — Firefox for Android has no
  // it at all (addons-linter flags exactly this as ANDROID_INCOMPATIBLE_API). A button
  // that cannot possibly work is worse than no button, so where the API is missing go
  // straight to the manual steps instead of offering a dead control.
  const canRequest = !!(chrome.permissions && typeof chrome.permissions.request === "function");
  if (!grantBtn || !canRequest) {
    if (grantBtn) grantBtn.classList.add("hidden");
    showManualHint();
    return;
  }

  // Clone to strip listeners, matching the pattern used by the other state handlers.
  const freshBtn = grantBtn.cloneNode(true);
  freshBtn.classList.remove("hidden");
  grantBtn.parentNode.replaceChild(freshBtn, grantBtn);

  freshBtn.addEventListener("click", () => {
    // permissions.request() must be called from a user gesture, which this click is.
    // It can still legitimately fail: the user dismisses the browser's prompt, or the
    // browser declines to prompt for an already-declared REQUIRED host permission
    // (Chrome's own runtime-host-permission model reserves that for its UI). Any of
    // those lands on the manual-steps hint rather than a dead end.
    try {
      chrome.permissions.request({ origins: SLACK_ORIGINS }, (granted) => {
        void chrome.runtime.lastError;
        if (granted) {
          // Access is live now, so re-run normal detection in place.
          detectSlackTab();
        } else {
          showManualHint();
        }
      });
    } catch (e) {
      showManualHint();
    }
  });
}

// True for the Slack web client on any slack.com subdomain (app.slack.com or a
// workspace subdomain like acme.slack.com). Rejects spoofs and the bare domain.
//
// KEEP THIS IN SYNC WITH shared-filters.js's isSlackHostname() -- duplicated only
// because popup.html can't load shared-filters.js (it's not part of the popup's
// script chain). Asserted against the same hostname-spoof battery as the real
// isSlackHostname() in tests/popup.test.js, so the two can't silently drift apart.
function isSlackClientTab(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".slack.com");
  } catch (e) {
    return false;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isSlackClientTab,
    applyDocumentLanguage,
    connectAndLaunchPlatform,
    setPlatformRowStatus,
    revokePlatformPermissions,
    isPlatformConnected,
    disconnectPlatform,
    grantedOriginsFor,
    _getPendingConnectCount: () => pendingConnectCount
  };
}

function showActiveState(tabId) {
  showOnlyState("slack-active-state");

  const workspaceTitle = document.getElementById("workspace-name");
  const launchBtn = document.getElementById("btn-launch");

  // Attempt to contact content script to get workspace info
  chrome.tabs.sendMessage(tabId, { type: "GET_WORKSPACE_INFO" }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script is not listening yet: programmatically inject it!
      workspaceTitle.innerText = t("popupConnecting", "Connecting...");

      chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["shared-filters.js", "content.js"]
      }, () => {
        if (chrome.runtime.lastError) {
          // Injection was refused. By far the most common cause is that site access
          // to slack.com is not actually granted — in which case "reload the page"
          // is wrong advice that leaves the user stuck forever. Re-check, and route
          // to the grant flow when that is the real problem.
          hasSlackAccess().then((granted) => {
            if (!granted) {
              showPermissionRequiredState();
              return;
            }
            workspaceTitle.innerText = t("popupSetupRequired", "Setup Required");
            const descEl = document.querySelector(".workspace-info .desc");
            if (descEl) descEl.innerText = t("popupSetupRequiredDesc", "Please reload the Slack page to activate the extension.");
          });
          return;
        }
        
        // Poll for content-script readiness instead of guessing a single delay
        // (fixed timeouts flake on slow machines).
        pollWorkspaceInfo(tabId, workspaceTitle, launchBtn, 6);
      });
    } else if (response && response.workspaceName) {
      workspaceTitle.innerText = response.workspaceName;
      setupLaunchButton(tabId, launchBtn);
    } else {
      workspaceTitle.innerText = t("popupClientLoaded", "Slack Client Loaded");
      setupLaunchButton(tabId, launchBtn);
    }
  });
}

// Ping the freshly-injected content script until it answers (or attempts run out).
function pollWorkspaceInfo(tabId, workspaceTitle, launchBtn, attemptsLeft) {
  chrome.tabs.sendMessage(tabId, { type: "GET_WORKSPACE_INFO" }, (response) => {
    const notReady = chrome.runtime.lastError || !response;
    if (notReady && attemptsLeft > 1) {
      setTimeout(() => pollWorkspaceInfo(tabId, workspaceTitle, launchBtn, attemptsLeft - 1), 150);
      return;
    }
    if (response && response.workspaceName) {
      workspaceTitle.innerText = response.workspaceName;
    } else {
      workspaceTitle.innerText = t("popupClientLoaded", "Slack Client Loaded");
    }
    setupLaunchButton(tabId, launchBtn);
  });
}

function setupLaunchButton(tabId, launchBtn) {
  // Clone to strip any previously attached listeners (SC-BUG-04)
  const freshBtn = launchBtn.cloneNode(true);
  launchBtn.parentNode.replaceChild(freshBtn, launchBtn);

  freshBtn.addEventListener("click", () => {
    chrome.tabs.sendMessage(tabId, { type: "LAUNCH_DASHBOARD" }, (response) => {
      if (chrome.runtime.lastError) {
        // Remove any alert from a previous failed click first -- otherwise
        // repeated clicks (e.g. retrying while the content script is still
        // unreachable) stack up identical banners indefinitely.
        const existing = document.getElementById("sc-launch-connection-lost");
        if (existing) existing.remove();
        // Styled by .connection-lost-banner (AA colours; the old inline
        // white-on-#ef4444 was 3.8:1) and announced via role="alert".
        const customAlert = document.createElement("div");
        customAlert.id = "sc-launch-connection-lost";
        customAlert.className = "connection-lost-banner";
        customAlert.setAttribute("role", "alert");
        customAlert.textContent = t("popupConnectionLost", "Connection lost. Please reload the page.");
        document.body.appendChild(customAlert);
      } else {
        window.close();
      }
    });
  });
}

function showOfflineState() {
  showOnlyState("slack-inactive-state");

  const gotoBtn = document.getElementById("btn-goto-slack");
  // Clone to prevent duplicate listeners if showOfflineState is called multiple times
  const freshBtn = gotoBtn.cloneNode(true);
  gotoBtn.parentNode.replaceChild(freshBtn, gotoBtn);

  freshBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://app.slack.com/client" });
    window.close();
  });
}

// First-run onboarding experience (SC-UX-01)
function showOnboarding() {
  const onboardingEl = document.getElementById("onboarding-card");
  if (!onboardingEl) return;

  onboardingEl.classList.remove("hidden");

  const dismissBtn = document.getElementById("btn-dismiss-onboarding");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      onboardingEl.classList.add("hidden");
      chrome.storage.local.set({ erasechat_onboarding_complete: true });
      // The dismiss button just vanished -- land focus on the first platform.
      focusFirst(document.querySelector(".platform-row:not([disabled])"));
    });
  }
}
