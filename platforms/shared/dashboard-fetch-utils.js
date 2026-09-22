// Shared by the mastodon/reddit/teams/x dashboards (loaded via <script> before each
// platform's own dashboard-*.js) -- was previously copy-pasted byte-for-byte into
// all four files. A classic (non-module) <script> tag shares one global scope with
// every other <script> in the same document, so `delay`/`fetchWithRetry` declared
// here are already in scope for the platform script loaded right after this one.

// Delay helper for rate limiting / retry backoff.
const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastBadResponse = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) {
        lastBadResponse = res;
        throw new Error(`Rate limit or Server error (${res.status})`);
      }
      return res;
    } catch (err) {
      if (i === maxRetries - 1) {
        // Retries exhausted. A persistent bad-status response (429/5xx, not a
        // network-level failure) must be returned, not thrown as a bare Error --
        // every apiFetch() caller's status-specific branching (401 re-auth
        // detection, Teams' token-refresh-and-retry, X's staleQueryId sniffing)
        // lives inside `if (!response.ok) {...}` and needs the real Response
        // object to run at all. A true network failure (fetch() itself threw --
        // offline, DNS, CORS) has no Response to fall back to, so it still throws.
        if (lastBadResponse) return lastBadResponse;
        throw err;
      }
      await delay(Math.pow(2, i) * 1000);
    }
  }
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
    statusEl.textContent = `A previous deletion was interrupted (${leftover.done} of ${leftover.total} processed). Scan again to see current state.`;
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
  toggle.addEventListener('click', () => {
    root.classList.toggle('open');
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
function formatScanCount(count, { truncated, maxPages, note }) {
  return truncated
    ? t("dashScanCountTruncated", `${count} items found (stopped after ${maxPages} pages -- ${note})`, [String(count), String(maxPages), note])
    : t("dashScanCountFound", `${count} items found`, [String(count)]);
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

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => localizeI18n(document), { once: true });
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
// ---------------------------------------------------------------------------
function ensureModalHost() {
  if (document.getElementById("sc-alert-modal")) return;
  const host = document.createElement("div");
  host.innerHTML = `
    <div class="verification-overlay hidden" id="sc-alert-modal" role="dialog" aria-modal="true" aria-labelledby="sc-alert-title">
      <div class="verification-card sc-card-purple">
        <h4 id="sc-alert-title"></h4>
        <p id="sc-alert-message"></p>
        <div class="sc-modal-actions">
          <button type="button" class="dashboard-btn btn-delete" id="sc-alert-ok-btn"></button>
        </div>
      </div>
    </div>
    <div class="verification-overlay hidden" id="sc-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="sc-confirm-title">
      <div class="verification-card sc-card-purple">
        <h4 id="sc-confirm-title"></h4>
        <p id="sc-confirm-message"></p>
        <div class="sc-modal-actions">
          <button type="button" class="dashboard-btn btn-scan" id="sc-confirm-cancel-btn"></button>
          <button type="button" class="dashboard-btn btn-delete" id="sc-confirm-ok-btn"></button>
        </div>
      </div>
    </div>
    <div class="verification-overlay hidden" id="sc-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="sc-prompt-title">
      <div class="verification-card sc-card-purple">
        <h4 id="sc-prompt-title"></h4>
        <p id="sc-prompt-message"></p>
        <input type="text" id="sc-prompt-input">
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
  // behind it, and Escape did nothing on showAlert()/showConfirm() (only showPrompt's
  // own input handled it) -- inconsistent both across platforms and within a single
  // dashboard's own modal types.
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

function showAlert(message, title) {
  ensureModalHost();
  return new Promise((resolve) => {
    const modal = document.getElementById("sc-alert-modal");
    document.getElementById("sc-alert-title").textContent = title || t("dashAlertTitle", "Notification");
    document.getElementById("sc-alert-message").textContent = message;
    const okBtn = document.getElementById("sc-alert-ok-btn");
    okBtn.textContent = t("dashOk", "OK");
    modal.classList.remove("hidden");
    function onOk() {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      resolve();
    }
    okBtn.addEventListener("click", onOk);
    okBtn.focus();
  });
}

function showConfirm(message, title) {
  ensureModalHost();
  return new Promise((resolve) => {
    const modal = document.getElementById("sc-confirm-modal");
    document.getElementById("sc-confirm-title").textContent = title || t("dashConfirmTitle", "Confirmation");
    document.getElementById("sc-confirm-message").textContent = message;
    const okBtn = document.getElementById("sc-confirm-ok-btn");
    const cancelBtn = document.getElementById("sc-confirm-cancel-btn");
    okBtn.textContent = t("dashConfirm", "Confirm");
    cancelBtn.textContent = t("dashCancel", "Cancel");
    modal.classList.remove("hidden");
    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    okBtn.focus();
  });
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

function showPrompt(message, title, { placeholder = "" } = {}) {
  ensureModalHost();
  return new Promise((resolve) => {
    const modal = document.getElementById("sc-prompt-modal");
    document.getElementById("sc-prompt-title").textContent = title || t("dashPromptTitle", "Input Required");
    renderPromptMessage(document.getElementById("sc-prompt-message"), message);
    const input = document.getElementById("sc-prompt-input");
    input.value = "";
    input.placeholder = placeholder;
    const okBtn = document.getElementById("sc-prompt-ok-btn");
    const cancelBtn = document.getElementById("sc-prompt-cancel-btn");
    okBtn.textContent = t("dashConfirm", "Confirm");
    cancelBtn.textContent = t("dashCancel", "Cancel");
    modal.classList.remove("hidden");
    function cleanup(result) {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onOk() { cleanup(input.value); }
    function onCancel() { cleanup(null); }
    function onKeydown(e) {
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    input.addEventListener("keydown", onKeydown);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    input.focus();
  });
}

// confirmBulkDelete is now async (uses the custom prompt/alert above instead of
// native window.prompt/alert) -- every caller must `await` it.
async function confirmBulkDelete(count, noun) {
  const isLarge = count > LARGE_DELETE_THRESHOLD;
  const expected = isLarge ? String(count) : "DELETE";
  // The count is the single most important number in this dialog -- emphasized as
  // its own bold segment (see renderPromptMessage) rather than buried in one plain
  // sentence, matching Slack's own dedicated count element.
  const promptText = isLarge
    ? ["You are about to permanently delete ", { text: String(count), strong: true }, ` ${noun} -- more than ${LARGE_DELETE_THRESHOLD}. Type the exact number ${count} to confirm.`]
    : [`Type DELETE to permanently delete `, { text: String(count), strong: true }, ` ${noun}.`];
  const placeholder = isLarge
    ? t("dashVerifyInputPlaceholderCount", `Type ${count} to confirm`, [String(count)])
    : t("dashVerifyInputPlaceholder", "Type DELETE to confirm");
  const confirmation = await showPrompt(promptText, t("dashVerifyTitle", "Confirm Deletion"), {
    placeholder
  });
  if (confirmation !== expected) {
    await showAlert(t("dashDeletionCancelled", "Deletion cancelled."));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-item selection. Every non-Slack dashboard used to delete everything a
// scan returned with no way to exclude specific items -- a preview that can't
// be edited isn't really a preview. `selectionState` tracks which of the
// CURRENT scan's result objects (by reference) are checked; a fresh call to
// resetSelection() at the start of each render replaces it wholesale so a
// leftover selection can never leak into a later, unrelated scan.
// ---------------------------------------------------------------------------
let selectionState = new Set();

function resetSelection(items) {
  selectionState = new Set(items); // selected by default, matching prior behavior
}

function getSelectedItems(items) {
  return items.filter((item) => selectionState.has(item));
}

// Appends a "Select All" checkbox row to `container` (called once per render,
// before any item rows) and returns the checkbox element.
function renderSelectAllControl(container) {
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
  container.appendChild(label);
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
  });
  row.insertBefore(checkbox, row.firstChild);
  if (rowCheckboxes) rowCheckboxes.push(checkbox);
  return checkbox;
}

// Wires `selectAllBox` to check/uncheck every row checkbox and keep
// selectionState in sync with `items`.
function wireSelectAll(selectAllBox, items, rowCheckboxes) {
  selectAllBox.addEventListener("change", () => {
    items.forEach((item, i) => {
      rowCheckboxes[i].checked = selectAllBox.checked;
      if (selectAllBox.checked) selectionState.add(item);
      else selectionState.delete(item);
    });
  });
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

function armCancelButton(cancelBtn, controller) {
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = t("dashCancel", "Cancel");
  // Unlike Slack's dashboard (Start -> Pause -> Resume), none of these five
  // platforms can pause and resume a running delete -- Cancel is a full stop.
  // A discoverable tooltip rather than another modal/banner, since this is
  // secondary information most users won't need.
  cancelBtn.title = t("dashCancelNoResumeHint", "Stops the delete entirely -- there's no pause/resume on this platform.");
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
    const confirmed = await showConfirm(
      "Stop this deletion? Items already processed will stay deleted; anything not yet reached will remain, and can be reviewed again after a rescan."
    );
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

function resetCancelButton(cancelBtn) {
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
const RATE_LIMIT_CIRCUIT_BREAKER_THRESHOLD = 4;

async function runDeleteLoop(selected, {
  cancelController,
  progressKey,
  progressText,
  deleteItem,
  preItemWait,
  postItemDelayMs = 0
}) {
  const totalCount = selected.length;
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
      }

      progressText.textContent = failures.length > 0
        ? `Processed ${deletedCount + failures.length} of ${totalCount} (${deletedCount} deleted, ${failures.length} failed)`
        : `Deleted ${deletedCount} of ${totalCount}`;
      await maybeSaveDeleteProgress(progressKey, deletedCount + failures.length, totalCount);

      if (expiredAuth || rateLimited || cancelController.cancelled) break;

      if (postItemDelayMs > 0) await delay(postItemDelayMs);
    }

    await chrome.storage.local.remove([progressKey]);
  } catch (err) {
    err.deleteLoopProgress = { deletedCount, failures, processedItems, succeededItems, expiredAuth, rateLimited, cancelled: cancelController.cancelled, totalCount };
    throw err;
  }

  return { deletedCount, failures, processedItems, succeededItems, expiredAuth, rateLimited, cancelled: cancelController.cancelled, totalCount };
}

// Export for Node (tests/lint); in a dashboard page these stay plain globals, shared
// with the platform script loaded right after this one (see the file header comment).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    delay,
    fetchWithRetry,
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
    createCancelController,
    armCancelButton,
    resetCancelButton,
    runDeleteLoop,
    initActivityLog,
    logActivity
  };
}
