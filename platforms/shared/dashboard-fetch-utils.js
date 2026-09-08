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

// Above LARGE_DELETE_THRESHOLD, a fixed literal like "DELETE" is the same
// low-friction confirm regardless of whether 2 or thousands of items are about to
// be permanently destroyed. Require typing the exact count instead, so the number
// is something the user has to actually notice and act on, not just habitually
// retype. Returns true if the user confirmed, false if the delete should be
// aborted (caller shows its own "Deletion cancelled." alert on false only if it
// wants one -- this one already does).
function confirmBulkDelete(count, noun) {
  const isLarge = count > LARGE_DELETE_THRESHOLD;
  const expected = isLarge ? String(count) : "DELETE";
  const promptText = isLarge
    ? `You are about to permanently delete ${count} ${noun} -- more than ${LARGE_DELETE_THRESHOLD}. Type the exact number ${count} to confirm.`
    : `Type DELETE to permanently delete ${count} ${noun}.`;
  const confirmation = prompt(promptText);
  if (confirmation !== expected) {
    alert("Deletion cancelled.");
    return false;
  }
  return true;
}

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
    ? `${count} items found (stopped after ${maxPages} pages -- ${note})`
    : `${count} items found`;
}
