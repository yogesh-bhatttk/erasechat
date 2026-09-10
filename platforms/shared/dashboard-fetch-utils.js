// Shared by the mastodon/reddit/teams/x dashboards (loaded via <script> before each
// platform's own dashboard-*.js) -- was previously copy-pasted byte-for-byte into
// all four files. A classic (non-module) <script> tag shares one global scope with
// every other <script> in the same document, so `delay`/`fetchWithRetry` declared
// here are already in scope for the platform script loaded right after this one.

// Delay helper for rate limiting / retry backoff.
const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) throw new Error(`Rate limit or Server error (${res.status})`);
      return res;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
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
function showPrompt(message, title, { placeholder = "" } = {}) {
  ensureModalHost();
  return new Promise((resolve) => {
    const modal = document.getElementById("sc-prompt-modal");
    document.getElementById("sc-prompt-title").textContent = title || t("dashPromptTitle", "Input Required");
    document.getElementById("sc-prompt-message").textContent = message || "";
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
  const promptText = isLarge
    ? `You are about to permanently delete ${count} ${noun} -- more than ${LARGE_DELETE_THRESHOLD}. Type the exact number ${count} to confirm.`
    : `Type DELETE to permanently delete ${count} ${noun}.`;
  const confirmation = await showPrompt(promptText, t("dashVerifyTitle", "Critical Action Verification"), {
    placeholder: t("dashVerifyInputPlaceholder", "Type DELETE to confirm")
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

function armCancelButton(cancelBtn, controller) {
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = t("dashCancel", "Cancel");
  function onClick() {
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
}
