// Shared by the mastodon/reddit/teams/x dashboards (loaded via <script> before each
// platform's own dashboard-*.js) -- was previously copy-pasted byte-for-byte into
// all four files. A classic (non-module) <script> tag shares one global scope with
// every other <script> in the same document, so `delay`/`fetchWithRetry` declared
// here are already in scope for the platform script loaded right after this one.

// Delay helper for rate limiting / retry backoff.
const delay = ms => new Promise(res => setTimeout(res, ms));

// Upper bound on any single server-requested wait (Retry-After / rate-limit reset).
// A server asking for 15 minutes shouldn't freeze a dashboard silently for 15
// minutes -- after this cap the retry happens anyway, and if it's still throttled
// the bad Response is returned to the caller (see fetchWithRetry) so the existing
// 429 circuit breaker in runDeleteLoop can take over.
const RETRY_AFTER_MAX_MS = 120000;
// Cap per wait when no cancel controller is attached (scans): there is no Cancel
// button wired to the wait then, so it must stay short instead of silently
// freezing the page for minutes.
const UNCANCELLABLE_RETRY_MAX_MS = 10000;
// Fallback exponential backoff when the server gives no hint: 2s, 4s, 8s...
// (was 1s + 2s, which is shorter than every one of these APIs' rate windows).
const RETRY_BASE_BACKOFF_MS = 2000;

// How long the server asked us to wait, in ms, or null if it didn't say.
// Understands:
//  - Retry-After: <seconds>            (RFC 9110, Reddit/Mastodon/Teams)
//  - Retry-After: <HTTP-date>          (RFC 9110)
//  - x-rate-limit-reset: <epoch secs>  (X)
//  - x-ratelimit-reset: <secs-from-now | epoch secs | ISO date>
//                                      (Reddit sends a delta, Mastodon an ISO date)
function parseRetryAfterMs(res, now = Date.now()) {
  const headers = res && res.headers && typeof res.headers.get === "function" ? res.headers : null;
  if (!headers) return null;

  const retryAfter = headers.get("retry-after");
  if (retryAfter != null && String(retryAfter).trim() !== "") {
    const raw = String(retryAfter).trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) * 1000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }

  const reset = headers.get("x-rate-limit-reset") ?? headers.get("x-ratelimit-reset");
  if (reset != null && String(reset).trim() !== "") {
    const raw = String(reset).trim();
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      // Anything this large is an absolute Unix timestamp (seconds); a small
      // number is a "seconds from now" delta (Reddit's flavour of this header).
      return n > 1e9 ? Math.max(0, n * 1000 - now) : Math.max(0, n * 1000);
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return null;
}

// Wait before retry attempt `attempt` (0-based) after a bad response `res`.
function computeRetryDelayMs(res, attempt, { maxWaitMs = RETRY_AFTER_MAX_MS, now = Date.now() } = {}) {
  const backoff = Math.pow(2, attempt) * RETRY_BASE_BACKOFF_MS;
  if (res && (res.status === 429 || res.status === 503)) {
    const requested = parseRetryAfterMs(res, now);
    if (requested != null) return Math.min(Math.max(requested, 0), maxWaitMs);
  }
  return Math.min(backoff, maxWaitMs);
}

// delay() that wakes up early (resolving false) once `controller.cancelled` is set,
// so a long server-requested wait never outlives the user pressing Cancel.
async function cancellableDelay(ms, controller, sleep = delay) {
  if (!controller) {
    await sleep(ms);
    return true;
  }
  const STEP_MS = 250;
  let remaining = ms;
  while (remaining > 0) {
    if (controller.cancelled) return false;
    const step = Math.min(STEP_MS, remaining);
    await sleep(step);
    remaining -= step;
  }
  return !controller.cancelled;
}

// fetch() with retries on 429/5xx. Fourth argument is optional and may be either
// a cancel controller (createCancelController()) or an options object:
//   { cancelController, maxWaitMs, onWait(ms) }
// maxWaitMs defaults to 120 s with a cancel controller, 10 s without one.
// onWait is called before each rate-limit/5xx wait so the page can say why it's
// paused. Existing three-argument callers keep the exact same contract.
async function fetchWithRetry(url, options = {}, maxRetries = 3, retryOptions = {}) {
  const opts = retryOptions && typeof retryOptions.cancelled === "boolean"
    ? { cancelController: retryOptions }
    : (retryOptions || {});
  const cancelController = opts.cancelController || null;
  const maxWaitMs = opts.maxWaitMs !== undefined
    ? opts.maxWaitMs
    : (cancelController ? RETRY_AFTER_MAX_MS : UNCANCELLABLE_RETRY_MAX_MS);
  const onWait = typeof opts.onWait === "function" ? opts.onWait : null;
  // Test hook only (lets the unit suite observe waits without real timers).
  const sleep = typeof opts._sleep === "function" ? opts._sleep : delay;

  let lastBadResponse = null;
  for (let i = 0; i < maxRetries; i++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      // A true network failure (fetch() itself threw -- offline, DNS, CORS) has
      // no Response to fall back to, so on the last attempt it still throws.
      if (i === maxRetries - 1) {
        if (lastBadResponse) return lastBadResponse;
        throw err;
      }
      if (!(await cancellableDelay(computeRetryDelayMs(null, i, { maxWaitMs }), cancelController, sleep))) {
        if (lastBadResponse) return lastBadResponse;
        throw err;
      }
      continue;
    }
    if (res.ok) return res;
    if (res.status >= 500 || res.status === 429) {
      lastBadResponse = res;
      // Retries exhausted. A persistent bad-status response (429/5xx, not a
      // network-level failure) must be returned, not thrown as a bare Error --
      // every apiFetch() caller's status-specific branching (401 re-auth
      // detection, Teams' token-refresh-and-retry, X's staleQueryId sniffing)
      // lives inside `if (!response.ok) {...}` and needs the real Response
      // object to run at all.
      if (i === maxRetries - 1) return res;
      const waitMs = computeRetryDelayMs(res, i, { maxWaitMs });
      if (onWait) onWait(waitMs);
      // Cancelled mid-wait: hand back the bad Response immediately rather than
      // sitting out the rest of a (possibly two-minute) server-requested wait.
      if (!(await cancellableDelay(waitMs, cancelController, sleep))) return res;
      continue;
    }
    return res;
  }
  return lastBadResponse;
}

// fetchWithRetry options for a dashboard's apiFetch: during a delete (controller
// present) long server waits are honoured, cancellable, and shown in `statusEl`;
// during a scan (no controller) the short default cap applies.
function deleteRetryOptions(cancelController, statusEl) {
  if (!cancelController) return {};
  return {
    cancelController,
    onWait: (ms) => {
      if (!statusEl) return;
      const secs = String(Math.ceil(ms / 1000));
      statusEl.textContent = t("dashRateLimitWaiting", `Rate limited -- waiting ${secs}s before retrying...`, [secs]);
    }
  };
}

const LARGE_DELETE_THRESHOLD = 100;
// confirmBulkDelete() itself is defined further down, after the custom modal
// helpers it depends on (showPrompt/showAlert) -- see there for the
// LARGE_DELETE_THRESHOLD type-to-confirm behavior.

// Delete progress is tracked in-memory only for the loop itself, but this one
// marker is persisted so a tab closed (or crashed) mid-delete can tell the next
// session something was left unfinished -- it does not resume the delete itself,
// since a fresh scan is required to see current state, but at least the user is
// told, instead of silently having no idea how far it got. Call once on load,
// before the delete-progress key would otherwise be checked.
async function reportInterruptedDelete(progressKey, statusEl) {
  const leftover = (await chrome.storage.local.get([progressKey]))[progressKey];
  if (leftover) {
    statusEl.textContent = t(
      "dashInterruptedDelete",
      `A previous deletion was interrupted (${leftover.done} of ${leftover.total} processed). Scan again to see current state.`,
      [String(leftover.done), String(leftover.total)]
    );
    await chrome.storage.local.remove([progressKey]);
  }
}

// Same batching rationale as background.js's own STORAGE_BATCH_INTERVAL: the
// persisted marker above is purely informational, so writing chrome.storage.local
// on every single processed item -- thousands of writes for a large delete -- is
// unnecessary storage I/O. Write every Nth item, and always the final one, so the
// marker is exactly accurate the instant the loop actually finishes or is
// interrupted right at the end.
const PROGRESS_SAVE_INTERVAL = 10;

async function maybeSaveDeleteProgress(key, processed, total) {
  if (processed % PROGRESS_SAVE_INTERVAL === 0 || processed === total) {
    await chrome.storage.local.set({ [key]: { total, done: processed } });
  }
}

// Replaces `container`'s contents with the shared "nothing to show" placeholder
// (see .empty-state in dashboard-base.css) instead of each dashboard inlining the
// same style attribute on its own ad hoc div.
function renderEmptyState(container, message) {
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = message;
  container.appendChild(div);
}

// Lightweight activity log for the five non-Slack dashboards -- collapsed by
// default (see .activity-log in dashboard-base.css), so troubleshooting a failed
// scan/delete has somewhere to look beyond a transient alert() popup, closer to
// (though intentionally much simpler than) Slack's own live execution console.
// Capped the same way Slack's own console log is, so a very long-running delete
// can't grow this unboundedly.
const ACTIVITY_LOG_MAX_LINES = 200;

// Wires up the collapse/expand toggle for a log block built from
// renderActivityLogHtml() (see below). Call once, after inserting that markup.
function initActivityLog(rootId) {
  const root = document.getElementById(rootId);
  if (!root) return;
  const toggle = root.querySelector('.activity-log-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(root.classList.contains('open')));
  toggle.addEventListener('click', () => {
    const open = root.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// Appends one line to the activity log identified by `rootId` (a no-op if that
// dashboard hasn't included the log markup, so this is always safe to call).
function logActivity(rootId, message, level = 'info') {
  if (typeof document === 'undefined') return;
  const body = document.querySelector(`#${rootId} .activity-log-body`);
  if (!body) return;
  const line = document.createElement('div');
  line.className = `activity-log-line ${level}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  body.appendChild(line);
  while (body.children.length > ACTIVITY_LOG_MAX_LINES) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

// `note` is the platform-specific tail after "stopped after N pages -- ", e.g.
// "older toots may exist" or "more may exist, try Deep Scan". Centralizes the
// truncated/not-truncated branch every dashboard's pagination loop otherwise
// duplicated verbatim.
//
// Post-delete recounts call this as formatScanCount(n, { truncated: false }) with
// no maxPages/note -- the scan's own "more may exist" caveat used to vanish at
// that point even though deleting some results doesn't make the unscanned pages
// disappear. The last truncated scan is remembered, and such a bare recount keeps
// its note. Pass `keepTruncated: false` to force the plain form, or
// `keepTruncated: true` to force reuse of the remembered note. A fresh scan
// (any call that passes maxPages or note) replaces the remembered state.
let lastTruncatedScan = null;

function formatScanCount(count, { truncated, maxPages, note, keepTruncated } = {}) {
  const isFreshScan = maxPages !== undefined || note !== undefined;
  if (truncated) {
    lastTruncatedScan = { maxPages, note };
  } else if ((isFreshScan && keepTruncated !== true) || keepTruncated === false) {
    // keepTruncated:false is a reset (cancelled scan, lost session): an older
    // scan's "stopped after N pages" note must not resurface later.
    lastTruncatedScan = null;
  }

  const reuse = !truncated && lastTruncatedScan &&
    (keepTruncated === true || (keepTruncated !== false && !isFreshScan));
  if (truncated || reuse) {
    const pages = truncated ? maxPages : lastTruncatedScan.maxPages;
    const tail = truncated ? note : lastTruncatedScan.note;
    return t("dashScanCountTruncated", `${count} items found (stopped after ${pages} pages -- ${tail})`, [String(count), String(pages), tail]);
  }
  return t("dashScanCountFound", `${count} items found`, [String(count)]);
}

// ---------------------------------------------------------------------------
// i18n. Same pattern as popup.js/content.js's own t()/localizeI18n(): localized
// text is applied OVER the English already in each dashboard's HTML, so a
// missing key or a browser without chrome.i18n simply keeps the English -- no
// blank labels, no regression. `substitutions` forwards to chrome.i18n's own
// positional $1/$2/$3 replacement.
// ---------------------------------------------------------------------------
function t(key, fallback, substitutions) {
  try {
    const m = chrome.i18n.getMessage(key, substitutions);
    if (m) return m;
  } catch (e) { /* i18n unavailable */ }
  return fallback !== undefined ? fallback : key;
}

function localizeI18n(root) {
  root = root || document;
  try {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
      if (m) el.textContent = m;
    });
    root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-ph"));
      if (m) el.setAttribute("placeholder", m);
    });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
      if (m) el.setAttribute("aria-label", m);
    });
  } catch (e) { /* i18n unavailable */ }
}

// Locales actually shipped in _locales/. A UI language outside this list renders
// the English default_locale, so <html lang> must say "en" in that case, not the
// browser's language -- otherwise a screen reader would read English text with,
// say, Japanese pronunciation rules. Keep in sync with _locales/.
const SHIPPED_LOCALES = ["en", "de", "es", "fr"];
const RTL_LANGUAGES = ["ar", "he", "fa", "ur"];

// Resolves the language tag the dashboard's text is really rendered in.
function resolveDocumentLanguage(uiLanguage) {
  const tag = String(uiLanguage || "").replace(/_/g, "-");
  const base = tag.split("-")[0].toLowerCase();
  return SHIPPED_LOCALES.includes(base) ? tag : "en";
}

// <html lang="en"> was hardcoded in every dashboard; set it from the browser's UI
// language (falling back to English when that language isn't shipped).
function applyDocumentLanguage(doc) {
  doc = doc || (typeof document !== "undefined" ? document : null);
  if (!doc || !doc.documentElement) return null;
  let ui = "";
  try { ui = chrome.i18n.getUILanguage(); } catch (e) { /* i18n unavailable */ }
  const lang = resolveDocumentLanguage(ui);
  doc.documentElement.lang = lang;
  doc.documentElement.dir = RTL_LANGUAGES.includes(lang.split("-")[0]) ? "rtl" : "ltr";
  return lang;
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    applyDocumentLanguage(document);
    localizeI18n(document);
    ensureDangerNote();
  }, { once: true });
}

// ---------------------------------------------------------------------------
// Persistent irreversibility warning. Every dashboard's #status-text starts out
// as "Items deleted will be unrecoverable." -- but status updates (scan results,
// empty states, "Deleting...") overwrite it, so the warning was gone exactly when
// the user was about to press Delete. This injects a separate, never-overwritten
// note above #status-text (once; idempotent). Runs automatically on
// DOMContentLoaded and again from confirmBulkDelete(), so no dashboard HTML/JS
// change is needed.
// ---------------------------------------------------------------------------
function ensureDangerNote() {
  if (typeof document === "undefined" || !document.querySelector) return null;
  const existing = document.getElementById("sc-danger-note");
  if (existing) return existing;
  const summary = document.querySelector(".selected-channel-summary");
  if (!summary) return null;
  const warning = t("dashUnrecoverableWarning", "Items deleted will be unrecoverable.");
  const note = document.createElement("p");
  note.id = "sc-danger-note";
  note.className = "sc-danger-note";
  note.textContent = warning;
  const statusEl = document.getElementById("status-text");
  if (statusEl && statusEl.parentNode === summary) {
    summary.insertBefore(note, statusEl);
    // The status line's initial text is this same warning -- now that it lives
    // in its own element, don't show it twice.
    const current = (statusEl.textContent || "").trim();
    if (current === warning || current === "Items deleted will be unrecoverable.") {
      statusEl.textContent = "";
    }
  } else {
    summary.appendChild(note);
  }
  return note;
}

// ---------------------------------------------------------------------------
// Custom alert/confirm/prompt modals, replacing native window.alert/confirm/
// prompt on every non-Slack dashboard. Two reasons this isn't cosmetic: (1) a
// themed dashboard popping a stock OS dialog is jarring, and (2) both Chrome and
// Firefox offer "Prevent this page from creating additional dialogs" after a
// couple of native prompts in a row -- once a user (reasonably) checks that box,
// the type-to-confirm delete safety gate silently stops appearing with no
// fallback UI at all. Markup/CSS/ids are the same ones content.js's Slack
// dashboard already uses (dashboard-base.css), reused here via plain
// document.getElementById since these dashboards run as top-level pages, not a
// shadow DOM. Built lazily so a platform's HTML doesn't need to hand-author it.
//
// Accessibility contract shared by all three:
//  - alert/confirm are role="alertdialog" with aria-describedby on the message;
//  - focus returns to whatever element opened the modal once it closes;
//  - Escape cancels (cancelling is never the destructive choice);
//  - modals are serialized: a showAlert() fired while a confirm/prompt is still
//    open (e.g. a delete finishing while the "Stop this deletion?" confirm is up)
//    waits for it instead of stacking on top of it.
// ---------------------------------------------------------------------------
function ensureModalHost() {
  if (document.getElementById("sc-alert-modal")) return;
  const host = document.createElement("div");
  host.innerHTML = `
    <div class="verification-overlay hidden" id="sc-alert-modal" role="alertdialog" aria-modal="true" aria-labelledby="sc-alert-title" aria-describedby="sc-alert-message">
      <div class="verification-card sc-card-purple">
        <h4 id="sc-alert-title"></h4>
        <p id="sc-alert-message"></p>
        <div class="sc-modal-actions">
          <button type="button" class="dashboard-btn btn-delete" id="sc-alert-ok-btn"></button>
        </div>
      </div>
    </div>
    <div class="verification-overlay hidden" id="sc-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="sc-confirm-title" aria-describedby="sc-confirm-message">
      <div class="verification-card sc-card-purple">
        <h4 id="sc-confirm-title"></h4>
        <p id="sc-confirm-message"></p>
        <div class="sc-modal-actions">
          <button type="button" class="dashboard-btn btn-scan" id="sc-confirm-cancel-btn"></button>
          <button type="button" class="dashboard-btn btn-delete" id="sc-confirm-ok-btn"></button>
        </div>
      </div>
    </div>
    <div class="verification-overlay hidden" id="sc-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="sc-prompt-title" aria-describedby="sc-prompt-message">
      <div class="verification-card sc-card-purple">
        <h4 id="sc-prompt-title"></h4>
        <p id="sc-prompt-message"></p>
        <label for="sc-prompt-input" id="sc-prompt-label" class="sc-prompt-label"></label>
        <input type="text" id="sc-prompt-input" autocomplete="off" spellcheck="false" aria-describedby="sc-prompt-error">
        <p id="sc-prompt-error" class="sc-prompt-error" role="alert" hidden></p>
        <div class="sc-modal-actions">
          <button type="button" class="dashboard-btn btn-scan" id="sc-prompt-cancel-btn"></button>
          <button type="button" class="dashboard-btn btn-delete" id="sc-prompt-ok-btn"></button>
        </div>
      </div>
    </div>`;
  while (host.firstElementChild) document.body.appendChild(host.firstElementChild);

  // Focus trap + Escape-to-cancel, mirroring content.js's Slack dashboard shadow-root
  // keydown handler (same modal markup/ids, just at document level instead of a
  // shadow root -- these five dashboards are top-level pages, not a shadow DOM).
  // Without this, Tab could leave an open modal into the still-interactive page
  // behind it. Escape always maps to the modal's safe/cancel action.
  document.addEventListener("keydown", (e) => {
    const alertModal = document.getElementById("sc-alert-modal");
    const confirmModal = document.getElementById("sc-confirm-modal");
    const promptModal = document.getElementById("sc-prompt-modal");

    let openModal = null;
    let cancelBtnId = null;
    if (alertModal && !alertModal.classList.contains("hidden")) {
      openModal = alertModal;
      cancelBtnId = "sc-alert-ok-btn"; // no separate cancel affordance on a plain alert
    } else if (confirmModal && !confirmModal.classList.contains("hidden")) {
      openModal = confirmModal;
      cancelBtnId = "sc-confirm-cancel-btn";
    } else if (promptModal && !promptModal.classList.contains("hidden")) {
      openModal = promptModal;
      cancelBtnId = "sc-prompt-cancel-btn";
    }
    if (!openModal) return;

    if (e.key === "Escape") {
      document.getElementById(cancelBtnId)?.click();
      e.preventDefault();
      return;
    }

    if (e.key === "Tab") {
      const focusableSelectors = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusables = Array.from(openModal.querySelectorAll(focusableSelectors));
      if (focusables.length === 0) return;

      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        if (activeEl === firstEl || !focusables.includes(activeEl)) {
          lastEl.focus();
          e.preventDefault();
        }
      } else {
        if (activeEl === lastEl || !focusables.includes(activeEl)) {
          firstEl.focus();
          e.preventDefault();
        }
      }
    }
  });
}

// One modal at a time, in call order (see the section comment above).
let modalQueue = Promise.resolve();
function enqueueModal(open) {
  const run = modalQueue.then(open);
  modalQueue = run.catch(() => {});
  return run;
}

// Remembers the element that had focus when a modal opened, and returns focus
// to it when the modal closes (if it's still in the document and focusable).
function captureFocusReturn() {
  const opener = typeof document !== "undefined" ? document.activeElement : null;
  return () => {
    try {
      if (opener && opener !== document.body && typeof opener.focus === "function" &&
          (!document.contains || document.contains(opener)) && !opener.disabled) {
        opener.focus();
      }
    } catch (e) { /* best-effort only */ }
  };
}

function showAlert(message, title) {
  return enqueueModal(() => new Promise((resolve) => {
    ensureModalHost();
    const restoreFocus = captureFocusReturn();
    const modal = document.getElementById("sc-alert-modal");
    document.getElementById("sc-alert-title").textContent = title || t("dashAlertTitle", "Notification");
    document.getElementById("sc-alert-message").textContent = message;
    const okBtn = document.getElementById("sc-alert-ok-btn");
    okBtn.textContent = t("dashOk", "OK");
    modal.classList.remove("hidden");
    function onOk() {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      restoreFocus();
      resolve();
    }
    okBtn.addEventListener("click", onOk);
    okBtn.focus();
  }));
}

// opts (optional): { okLabel, cancelLabel, danger } -- danger renders the OK
// button red. Focus starts on Cancel, never on the affirmative action, so a
// stray Enter/Space can't confirm by accident.
function showConfirm(message, title, { okLabel, cancelLabel, danger = false } = {}) {
  return enqueueModal(() => new Promise((resolve) => {
    ensureModalHost();
    const restoreFocus = captureFocusReturn();
    const modal = document.getElementById("sc-confirm-modal");
    document.getElementById("sc-confirm-title").textContent = title || t("dashConfirmTitle", "Confirmation");
    document.getElementById("sc-confirm-message").textContent = message;
    const okBtn = document.getElementById("sc-confirm-ok-btn");
    const cancelBtn = document.getElementById("sc-confirm-cancel-btn");
    okBtn.textContent = okLabel || t("dashConfirm", "Confirm");
    cancelBtn.textContent = cancelLabel || t("dashCancel", "Cancel");
    okBtn.classList.toggle("danger", !!danger);
    modal.querySelector(".verification-card")?.classList.toggle("sc-card-danger", !!danger);
    modal.classList.remove("hidden");
    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      restoreFocus();
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    cancelBtn.focus();
  }));
}

// Resolves to the typed string on confirm, or null on cancel/dismiss -- the same
// contract as window.prompt(), so callers written against it port over directly.
// message may be a plain string (existing callers keep working unchanged) or an
// array of parts -- each either a string or { text, strong: true } -- rendered as
// real DOM nodes (never innerHTML, so this stays safe even though nothing here is
// currently untrusted input) so a specific piece (e.g. the item count in
// confirmBulkDelete) can be visually emphasized, matching Slack's own dedicated
// count element instead of every non-Slack platform burying it in one plain
// sentence.
function renderPromptMessage(el, message) {
  if (!Array.isArray(message)) {
    el.textContent = message || "";
    return;
  }
  el.textContent = "";
  for (const part of message) {
    if (part && typeof part === "object" && part.strong) {
      const strong = document.createElement("strong");
      strong.textContent = part.text;
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(typeof part === "string" ? part : part.text));
    }
  }
}

// opts (all optional):
//   placeholder      input placeholder
//   label            visible <label> for the input (defaults to the placeholder,
//                    then a generic "Your answer")
//   expected         when set, OK stays disabled until the trimmed input equals it,
//                    and a mismatch shows `mismatchMessage` inline instead of
//                    resolving -- a typo can no longer silently abort a delete
//   mismatchMessage  inline validation text for the above
//   okLabel/cancelLabel, danger (red OK button + red card accent)
function showPrompt(message, title, {
  placeholder = "", label, expected, mismatchMessage, okLabel, cancelLabel, danger = false
} = {}) {
  return enqueueModal(() => new Promise((resolve) => {
    ensureModalHost();
    const restoreFocus = captureFocusReturn();
    const modal = document.getElementById("sc-prompt-modal");
    document.getElementById("sc-prompt-title").textContent = title || t("dashPromptTitle", "Input Required");
    renderPromptMessage(document.getElementById("sc-prompt-message"), message);
    const labelEl = document.getElementById("sc-prompt-label");
    if (labelEl) labelEl.textContent = label || placeholder || t("dashPromptInputLabel", "Your answer");
    const errorEl = document.getElementById("sc-prompt-error");
    const input = document.getElementById("sc-prompt-input");
    input.value = "";
    input.placeholder = placeholder;
    input.removeAttribute("aria-invalid");
    const okBtn = document.getElementById("sc-prompt-ok-btn");
    const cancelBtn = document.getElementById("sc-prompt-cancel-btn");
    okBtn.textContent = okLabel || t("dashConfirm", "Confirm");
    cancelBtn.textContent = cancelLabel || t("dashCancel", "Cancel");
    okBtn.classList.toggle("danger", !!danger);
    modal.querySelector(".verification-card")?.classList.toggle("sc-card-danger", !!danger);
    const hasExpected = expected !== undefined && expected !== null;
    const matches = () => !hasExpected || input.value.trim() === String(expected);

    function setError(show) {
      if (!errorEl) return;
      errorEl.hidden = !show;
      errorEl.textContent = show ? (mismatchMessage || t("dashPromptMismatch", "That doesn't match. Check what you typed and try again.")) : "";
      if (show) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    function sync() {
      okBtn.disabled = !matches();
      if (!hasExpected) return;
      // Flag a mismatch as soon as the input can no longer become the expected
      // value (not on every keystroke of a correct-so-far entry).
      const v = input.value.trim();
      const target = String(expected);
      setError(v.length > 0 && !target.startsWith(v));
    }
    setError(false);
    sync();
    modal.classList.remove("hidden");

    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("input", sync);
      okBtn.disabled = false;
      setError(false);
      restoreFocus();
      resolve(result);
    }
    function onOk() {
      if (!matches()) {
        setError(true);
        input.focus();
        return;
      }
      cleanup(hasExpected ? input.value.trim() : input.value);
    }
    function onCancel() { cleanup(null); }
    function onKeydown(e) {
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("input", sync);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    // Typing is the only way forward, so the input (not OK) takes focus; OK is
    // disabled until the confirmation matches, so Enter can't confirm early.
    input.focus();
  }));
}

// Splits a localized sentence around a marker substitution so the count can be
// rendered as its own <strong> part (see renderPromptMessage).
const COUNT_MARKER = "⁣#COUNT#⁣";
function emphasizeCount(sentence, count) {
  const parts = String(sentence).split(COUNT_MARKER);
  const out = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push({ text: String(count), strong: true });
    if (p) out.push(p);
  });
  return out;
}

// Unified destructive-confirmation gate shared by all five non-Slack dashboards.
// Up to LARGE_DELETE_THRESHOLD items: type DELETE. Above it: type the exact count.
// The red OK button is labelled with what it does ("Delete 42 items") and stays
// disabled until the typed text matches; a typo shows an inline message instead of
// silently cancelling. Resolves true only on an explicit, matching confirmation.
//
// confirmBulkDelete is async -- every caller must `await` it. `noun` is optional
// (defaults to a localized "items").
async function confirmBulkDelete(count, noun) {
  ensureDangerNote();
  const n = Number(count) || 0;
  const what = noun || t("dashItemsNoun", "items");
  const isLarge = n > LARGE_DELETE_THRESHOLD;
  const expected = isLarge ? String(n) : "DELETE";
  const sentence = isLarge
    ? t("dashConfirmDeleteLarge",
      `You are about to permanently delete ${COUNT_MARKER} ${what} — more than ${LARGE_DELETE_THRESHOLD}. This cannot be undone. Type the exact number ${n} to confirm.`,
      [COUNT_MARKER, what, String(LARGE_DELETE_THRESHOLD), String(n)])
    : t("dashConfirmDeleteSmall",
      `You are about to permanently delete ${COUNT_MARKER} ${what}. This cannot be undone. Type DELETE to confirm.`,
      [COUNT_MARKER, what]);
  const placeholder = isLarge
    ? t("dashVerifyInputPlaceholderCount", `Type ${n} to confirm`, [String(n)])
    : t("dashVerifyInputPlaceholder", "Type DELETE to confirm");
  const mismatchMessage = isLarge
    ? t("dashConfirmMismatchCount", `That doesn't match. Type the number ${n} exactly to continue.`, [String(n)])
    : t("dashConfirmMismatchWord", "That doesn't match. Type DELETE in capital letters to continue.");
  const confirmation = await showPrompt(emphasizeCount(sentence, n), t("dashVerifyTitle", "Confirm Deletion"), {
    placeholder,
    label: placeholder,
    expected,
    mismatchMessage,
    okLabel: t("dashDeleteCountButton", `Delete ${n} ${what}`, [String(n), what]),
    cancelLabel: t("dashVerifyGoBack", "Go Back"),
    danger: true
  });
  return confirmation === expected;
}

// ---------------------------------------------------------------------------
// Per-item selection. Every non-Slack dashboard used to delete everything a
// scan returned with no way to exclude specific items -- a preview that can't
// be edited isn't really a preview. `selectionState` tracks which of the
// CURRENT scan's result objects (by reference) are checked; a fresh call to
// resetSelection() at the start of each render replaces it wholesale so a
// leftover selection can never leak into a later, unrelated scan.
//
// Selection feedback (all automatic, no dashboard change needed):
//  - an "N of M selected" counter (#selected-count) next to Select All;
//  - Select All shows checked / unchecked / indeterminate to match the rows;
//  - any element with [data-count-label] (e.g. the Delete button, opt-in) gets
//    "Delete N selected" written into its [data-count-target] child (or itself).
// Dashboards can also call getSelectedCount()/updateSelectionCount() directly.
// ---------------------------------------------------------------------------
let selectionState = new Set();
let selectionUniverse = [];
let selectAllBoxRef = null;

// `isPreselected` (optional) limits which items start checked -- Telegram uses it
// so other people's messages are never selected by default.
function resetSelection(items, isPreselected) {
  selectionUniverse = Array.isArray(items) ? items.slice() : [];
  selectionState = new Set(isPreselected ? selectionUniverse.filter(isPreselected) : selectionUniverse);
  selectAllBoxRef = null;
  updateSelectionCount();
}

function getSelectedItems(items) {
  return items.filter((item) => selectionState.has(item));
}

// Number of currently-selected items among the current scan's results.
function getSelectedCount() {
  let n = 0;
  for (const item of selectionUniverse) if (selectionState.has(item)) n++;
  return n;
}

// Refreshes every piece of selection feedback. Safe to call any time (no-op
// without a DOM). `counterEl` optionally targets a dashboard's own counter element.
function updateSelectionCount(counterEl) {
  const selected = getSelectedCount();
  const total = selectionUniverse.length;
  if (selectAllBoxRef) {
    selectAllBoxRef.checked = total > 0 && selected === total;
    selectAllBoxRef.indeterminate = selected > 0 && selected < total;
  }
  if (typeof document === "undefined" || !document.getElementById) return { selected, total };
  const text = t("dashSelectedCount", `${selected} of ${total} selected`, [String(selected), String(total)]);
  const targets = [counterEl, document.getElementById("selected-count")].filter(Boolean);
  for (const el of new Set(targets)) el.textContent = text;
  if (document.querySelectorAll) {
    document.querySelectorAll("[data-count-label]").forEach((el) => {
      const target = el.querySelector("[data-count-target]") || el;
      target.textContent = t("dashDeleteSelectedCount", `Delete ${selected} selected`, [String(selected)]);
    });
  }
  return { selected, total };
}

// Appends a "Select All" checkbox row (plus the "N of M selected" counter) to
// `container` (called once per render, before any item rows) and returns the
// checkbox element.
function renderSelectAllControl(container) {
  const row = document.createElement("div");
  row.className = "sc-selectall-row";
  const label = document.createElement("label");
  label.className = "sc-selectall-label";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = true;
  const span = document.createElement("span");
  span.setAttribute("data-i18n", "dashSelectAll");
  span.textContent = t("dashSelectAll", "Select All");
  label.appendChild(box);
  label.appendChild(span);
  const previous = document.getElementById("selected-count");
  if (previous) previous.remove();
  const counter = document.createElement("span");
  counter.id = "selected-count";
  counter.className = "sc-selected-count";
  counter.setAttribute("aria-live", "polite");
  row.appendChild(label);
  row.appendChild(counter);
  container.appendChild(row);
  selectAllBoxRef = box;
  updateSelectionCount();
  return box;
}

// Inserts a checkbox at the front of `row` bound to `item`; pushes it into
// `rowCheckboxes` (if given) so the caller's Select-All handler can sync them.
function addRowCheckbox(row, item, rowCheckboxes) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "msg-checkbox";
  checkbox.checked = selectionState.has(item);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectionState.add(item);
    else selectionState.delete(item);
    updateSelectionCount();
  });
  // Without a name a screen reader announces only "checkbox, checked" for every
  // row of a destructive selection list -- label it with the row's own text.
  const rowText = (row.textContent || "").replace(/\s+/g, " ").trim();
  if (rowText) checkbox.setAttribute("aria-label", rowText.slice(0, 140));
  row.insertBefore(checkbox, row.firstChild);
  if (rowCheckboxes) rowCheckboxes.push(checkbox);
  return checkbox;
}

// Wires `selectAllBox` to check/uncheck every row checkbox and keep
// selectionState in sync with `items`.
// An imported X archive or Reddit data export can hold tens of thousands of
// items; drawing a row (and checkbox) for each would freeze the tab. Only the
// first MAX_RENDERED_ROWS are drawn. The rest keep their selection state, and
// Select All, the selected count, Delete and Export all still cover every item.
const MAX_RENDERED_ROWS = 1000;

function visibleRows(items) {
  return items.length > MAX_RENDERED_ROWS ? items.slice(0, MAX_RENDERED_ROWS) : items;
}

function appendHiddenRowsNote(container, totalCount) {
  if (!container || typeof document === "undefined" || totalCount <= MAX_RENDERED_ROWS) return;
  const note = document.createElement("p");
  note.className = "empty-state hidden-rows-note";
  const hidden = String(totalCount - MAX_RENDERED_ROWS);
  note.textContent = t("dashHiddenRowsNote",
    `${hidden} more items aren't shown here, to keep this page responsive. They follow Select All and are included in Delete and Export.`,
    [hidden]);
  container.appendChild(note);
}

function wireSelectAll(selectAllBox, items, rowCheckboxes) {
  selectAllBoxRef = selectAllBox;
  selectAllBox.addEventListener("change", () => {
    items.forEach((item, i) => {
      if (rowCheckboxes[i]) rowCheckboxes[i].checked = selectAllBox.checked;
      if (selectAllBox.checked) selectionState.add(item);
      else selectionState.delete(item);
    });
    updateSelectionCount();
  });
  updateSelectionCount();
}

// ---------------------------------------------------------------------------
// Cancel support. A delete loop checks `controller.cancelled` after each item
// (or chunk) and stops early instead of requiring the tab to be closed --
// previously the only way to stop a running delete on any of these dashboards.
// ---------------------------------------------------------------------------
function createCancelController() {
  return {
    cancelled: false,
    cancel() { this.cancelled = true; }
  };
}

// Unlike Slack's dashboard (a resumable background job that survives the tab, even
// the service worker, being torn down), none of these five platforms can resume a
// delete that's interrupted mid-run -- closing this tab abandons whatever hasn't
// been reached yet with only a post-hoc "N of M processed" note on next open (see
// reportInterruptedDelete). A user who's used Slack's dashboard first may
// reasonably assume the same safety net exists here; it doesn't, so warn before the
// tab actually closes rather than let that assumption go undiscovered until it's
// too late to matter. Single module-level handler (only one delete can run per
// dashboard page at a time) armed/disarmed in lockstep with the Cancel button,
// which every platform already calls at exactly the right two moments.
let unloadWarningHandler = null;

function onBeforeUnload(e) {
  e.preventDefault();
  // Chrome/Firefox both show their own fixed generic warning regardless of this
  // string's content, but returnValue must still be set (empty string included)
  // for the confirmation dialog to appear at all.
  e.returnValue = "";
}

// Confirm wording for a Cancel button armed during a scan (nothing is deleted).
function scanCancelLabels() {
  return {
    title: t("dashStopScanTitle", "Stop scanning?"),
    okLabel: t("dashStopScanning", "Stop scanning"),
    cancelLabel: t("dashKeepScanning", "Keep scanning")
  };
}

// The button whose "Stop?" confirm may still be open (see dismissStaleCancelConfirm).
let armedCancelBtn = null;

// `labels` (optional) overrides the confirm's title/buttons -- a scan passes
// "Stop scanning?" wording so the dialog doesn't talk about deleting.
function armCancelButton(cancelBtn, controller, confirmMessage, labels = {}) {
  armedCancelBtn = cancelBtn;
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = t("dashCancel", "Cancel");
  // Unlike Slack's dashboard (Start -> Pause -> Resume), none of these five
  // platforms can pause and resume a running delete -- Cancel is a full stop.
  // A discoverable tooltip rather than another modal/banner, since this is
  // secondary information most users won't need.
  cancelBtn.title = t("dashCancelNoResumeHint", "Stops the current run entirely -- there's no pause/resume on this platform.");
  if (typeof window !== "undefined") {
    unloadWarningHandler = onBeforeUnload;
    window.addEventListener("beforeunload", unloadWarningHandler);
  }
  async function onClick() {
    // A real yes/no gate, not just an alert: cancelling mid-run doesn't undo
    // anything already deleted, and a stray/accidental click on a button that
    // sits right next to Delete shouldn't interrupt a live run with no way to
    // back out. Disable immediately so a second click can't stack a duplicate
    // confirm dialog while this one is still open.
    cancelBtn.disabled = true;
    cancelBtn._scConfirmOpen = true;
    const confirmed = await showConfirm(
      confirmMessage ||
      t("dashCancelConfirmMessage", "Stop this deletion? Items already processed will stay deleted; anything not yet reached will remain, and can be reviewed again after a rescan."),
      labels.title || t("dashCancelConfirmTitle", "Stop deleting?"),
      {
        okLabel: labels.okLabel || t("dashStopDeleting", "Stop deleting"),
        cancelLabel: labels.cancelLabel || t("dashKeepDeleting", "Keep going")
      }
    );
    cancelBtn._scConfirmOpen = false;
    if (!confirmed) {
      cancelBtn.disabled = false;
      return;
    }
    controller.cancel();
    cancelBtn.disabled = true;
    cancelBtn.textContent = t("dashCancelling", "Cancelling...");
  }
  cancelBtn.addEventListener("click", onClick);
  cancelBtn._scCancelHandler = onClick;
}

// The run already ended (finished, failed, or was cancelled) while the "Stop?"
// confirm was still open -- dismiss it as "Keep going" (a no-op now) rather than
// leave a stale question up, which would also hold back the completion alert
// queued behind it (see enqueueModal). runDeleteLoop calls this as soon as the
// loop settles, before the caller awaits its result alert.
function dismissStaleCancelConfirm(cancelBtn = armedCancelBtn) {
  if (!cancelBtn || !cancelBtn._scConfirmOpen) return;
  if (typeof document !== "undefined" && document.getElementById) {
    const confirmModal = document.getElementById("sc-confirm-modal");
    if (confirmModal && !confirmModal.classList.contains("hidden")) {
      document.getElementById("sc-confirm-cancel-btn")?.click();
    }
  }
  cancelBtn._scConfirmOpen = false;
}

function resetCancelButton(cancelBtn) {
  dismissStaleCancelConfirm(cancelBtn);
  if (armedCancelBtn === cancelBtn) armedCancelBtn = null;
  if (cancelBtn._scCancelHandler) {
    cancelBtn.removeEventListener("click", cancelBtn._scCancelHandler);
    cancelBtn._scCancelHandler = null;
  }
  cancelBtn.hidden = true;
  cancelBtn.disabled = false;
  cancelBtn.textContent = t("dashCancel", "Cancel");
  if (unloadWarningHandler && typeof window !== "undefined") {
    window.removeEventListener("beforeunload", unloadWarningHandler);
    unloadWarningHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Shared bulk-delete loop skeleton. Reddit/Mastodon/Teams/X each used to hand-roll
// their own ~90-120 line version of this -- structurally identical (cancel-check,
// progress-marker persistence, live progress text, per-item try/catch with
// expiredAuth fail-fast, inter-item pacing) but differing only in the actual
// per-item delete call and the pacing shape, and the copies had already begun to
// drift (see CHANGELOG). What's deliberately NOT shared here is what happens AFTER
// the loop -- status-text branching, auth-invalid wording, and X's extra
// query-id-staleness reporting differ enough per platform that forcing them
// through one generic template would trade real clarity for a marginal line-count
// win. Callers get back the raw outcome and still do their own rendering.
//
// deleteItem(item): async, must throw on failure. A thrown error with
// `.expiredAuth` set stops the whole run immediately (every remaining item would
// fail the identical way); any other custom field a caller sets on its own thrown
// error (e.g. X's `.staleQueryId`) survives untouched on that failure's `error`
// property for the caller to inspect after the loop. A thrown error whose
// `.status === 429` is counted toward the rate-limit circuit breaker below --
// fetchWithRetry already surfaces the real HTTP status on the Response it
// returns once retries are exhausted (see its own comment), so a deleteItem
// throwing on a persistent 429 just needs to copy `response.status` onto the
// error it throws for this to work, the same way X's apiFetch already does for
// every non-ok status.
//
// preItemWait(cancelController): optional async hook run BEFORE each item is
// attempted, and BEFORE it's added to processedItems -- this is Mastodon's real
// rate-limit gate (usually a no-op, occasionally a long forced wait), not a fixed
// pacing delay, so it sits at a different point in the loop than postItemDelayMs.
//
// postItemDelayMs: fixed pacing delay applied AFTER an item is processed (success
// or failure) and BEFORE the next one is attempted -- Reddit/Teams/X/Mastodon's
// flat per-item throttle. Defaults to 0 (no delay).
//
// Returns { deletedCount, failures, processedItems, expiredAuth, rateLimited,
// cancelled, totalCount }. `failures` entries are { id, message, error } --
// `error` is the original thrown error object, not just its message, so a caller
// can read any platform-specific field it set. `rateLimited: true` means the run
// stopped early after RATE_LIMIT_CIRCUIT_BREAKER_THRESHOLD consecutive
// `.status === 429` failures -- a caller should report this the same way it
// already reports `expiredAuth`, not just as one more ordinary failure.
// ---------------------------------------------------------------------------

// A single 429 is an ordinary per-item failure (recorded, loop moves on). But
// several IN A ROW means the whole run is being throttled, not just one item --
// without this, a large batch would burn through every remaining item at full
// pacing, each failing the identical way, instead of stopping once the pattern
// is clear. Reset to 0 on any success or any non-429 failure, so a single
// transient 429 sandwiched between real successes never trips it.
// Human-friendly "about N min left" duration (rounded, never "0 s").
function formatEta(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return t("dashDurationSeconds", `${totalSec} s`, [String(totalSec)]);
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return t("dashDurationMinutes", `${totalMin} min`, [String(totalMin)]);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return t("dashDurationHours", `${h} h ${m} min`, [String(h), String(m)]);
}

// Live progress line for runDeleteLoop: counts, percent, and an ETA from the
// measured average time per processed item (which already includes each
// platform's pacing delay and any rate-limit waits). Also mirrors the numbers
// onto progressbar ARIA attributes so assistive tech can query the value.
function formatDeleteProgress({ deletedCount, failedCount = 0, totalCount, elapsedMs = 0 }) {
  const processed = deletedCount + failedCount;
  const pct = totalCount > 0 ? Math.floor((processed / totalCount) * 100) : 100;
  const base = failedCount > 0
    ? t("dashProgressProcessed",
      `Processed ${processed} of ${totalCount} (${deletedCount} deleted, ${failedCount} failed)`,
      [String(processed), String(totalCount), String(deletedCount), String(failedCount)])
    : t("dashProgressDeleted", `Deleted ${deletedCount} of ${totalCount}`, [String(deletedCount), String(totalCount)]);
  const remaining = totalCount - processed;
  if (remaining > 0 && processed > 0 && elapsedMs > 0) {
    const eta = formatEta((elapsedMs / processed) * remaining);
    return `${base} · ${t("dashProgressPercentEta", `${pct}%, about ${eta} left`, [String(pct), eta])}`;
  }
  return `${base} · ${t("dashProgressPercent", `${pct}%`, [String(pct)])}`;
}

function renderDeleteProgress(progressText, stats) {
  if (!progressText) return;
  const text = formatDeleteProgress(stats);
  // Plain text only: #progress-text is already a polite live region, and
  // progressbar/aria-value* attributes went stale as soon as other code wrote
  // "Starting deletion..." or a rate-limit notice into the same element.
  progressText.textContent = text;
}

const RATE_LIMIT_CIRCUIT_BREAKER_THRESHOLD = 4;
// Consecutive 403s before the run stops with `forbidden: true` (see runDeleteLoop).
const FORBIDDEN_CIRCUIT_BREAKER_THRESHOLD = 3;

async function runDeleteLoop(selected, {
  cancelController,
  progressKey,
  progressText,
  deleteItem,
  preItemWait,
  postItemDelayMs = 0
}) {
  const totalCount = selected.length;
  const startedAt = Date.now();
  let deletedCount = 0;
  const failures = [];
  const processedItems = [];
  // Distinct from processedItems: only items that were ACTUALLY deleted. A caller
  // that removed processedItems from its visible results would make a failed
  // delete (e.g. a transient 5xx that exhausted fetchWithRetry) disappear from
  // the list exactly as if it had succeeded, with no way to find and retry it
  // short of a full rescan -- the `failures` array alone isn't enough to
  // reconstruct that mapping, since it only stores bare ids/messages.
  const succeededItems = [];
  let expiredAuth = false;
  let rateLimited = false;
  let consecutiveRateLimitFailures = 0;
  // Same idea for 403: a token without write scope or an org policy that forbids
  // deleting fails every remaining item identically -- at Mastodon/Teams pacing
  // that was hours of guaranteed failures.
  let forbidden = false;
  let consecutiveForbiddenFailures = 0;

  // Everything in this function besides deleteItem() itself is wrapped in one
  // try/catch: a storage call here throwing (e.g. the extension context is
  // invalidated by a reload mid-run, same risk every original per-platform
  // implementation's own outer try/catch existed to guard against) must not
  // silently swallow how far the run actually got. Attaching the progress so far
  // to the rethrown error, rather than just losing it, is what lets every caller's
  // OWN outer catch block keep reporting an accurate "N of M deleted before this
  // happened" -- exactly as it did before this loop was shared.
  try {
    await chrome.storage.local.set({ [progressKey]: { total: totalCount, done: 0 } });

    for (const item of selected) {
      if (cancelController.cancelled) break;

      if (preItemWait) {
        await preItemWait(cancelController);
        if (cancelController.cancelled) break;
      }

      processedItems.push(item);
      try {
        await deleteItem(item);
        deletedCount++;
        succeededItems.push(item);
        consecutiveRateLimitFailures = 0;
        consecutiveForbiddenFailures = 0;
      } catch (err) {
        failures.push({ id: item.id, message: err.message, error: err });
        if (err.expiredAuth) {
          expiredAuth = true;
          break;
        }
        // A caller-flagged systemic failure (e.g. dashboard-x.js's staleQueryId:
        // the API signature itself is wrong, not this particular item) will
        // recur identically on every remaining item. Stop instead of burning
        // through the whole batch one failure at a time at full pacing.
        if (err.staleQueryId) break;

        if (err.status === 429) {
          consecutiveRateLimitFailures++;
          if (consecutiveRateLimitFailures >= RATE_LIMIT_CIRCUIT_BREAKER_THRESHOLD) {
            rateLimited = true;
            break;
          }
        } else {
          consecutiveRateLimitFailures = 0;
        }
        if (err.status === 403) {
          consecutiveForbiddenFailures++;
          if (consecutiveForbiddenFailures >= FORBIDDEN_CIRCUIT_BREAKER_THRESHOLD) {
            forbidden = true;
            break;
          }
        } else {
          consecutiveForbiddenFailures = 0;
        }
      }

      renderDeleteProgress(progressText, {
        deletedCount, failedCount: failures.length, totalCount, elapsedMs: Date.now() - startedAt
      });
      await maybeSaveDeleteProgress(progressKey, deletedCount + failures.length, totalCount);

      if (expiredAuth || rateLimited || forbidden || cancelController.cancelled) break;

      if (postItemDelayMs > 0) await delay(postItemDelayMs);
    }

    await chrome.storage.local.remove([progressKey]);
  } catch (err) {
    dismissStaleCancelConfirm();
    err.deleteLoopProgress = { deletedCount, failures, processedItems, succeededItems, expiredAuth, rateLimited, forbidden, cancelled: cancelController.cancelled, totalCount };
    throw err;
  }

  dismissStaleCancelConfirm();
  return { deletedCount, failures, processedItems, succeededItems, expiredAuth, rateLimited, forbidden, cancelled: cancelController.cancelled, totalCount };
}

// Export for Node (tests/lint); in a dashboard page these stay plain globals, shared
// with the platform script loaded right after this one (see the file header comment).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    delay,
    fetchWithRetry,
    deleteRetryOptions,
    dismissStaleCancelConfirm,
    scanCancelLabels,
    parseRetryAfterMs,
    computeRetryDelayMs,
    cancellableDelay,
    resolveDocumentLanguage,
    applyDocumentLanguage,
    ensureDangerNote,
    getSelectedCount,
    updateSelectionCount,
    formatDeleteProgress,
    formatEta,
    t,
    localizeI18n,
    showAlert,
    showConfirm,
    showPrompt,
    confirmBulkDelete,
    reportInterruptedDelete,
    maybeSaveDeleteProgress,
    renderEmptyState,
    formatScanCount,
    resetSelection,
    getSelectedItems,
    renderSelectAllControl,
    addRowCheckbox,
    wireSelectAll,
    visibleRows,
    appendHiddenRowsNote,
    MAX_RENDERED_ROWS,
    createCancelController,
    armCancelButton,
    resetCancelButton,
    runDeleteLoop,
    initActivityLog,
    logActivity
  };
}
