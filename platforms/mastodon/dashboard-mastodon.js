// Pure helper: given already-pruned delete timestamps (i.e. only the ones still
// inside the rolling rate-limit window), returns the timestamp new deletes may
// resume at, or null if we're already under the cap and don't need to wait at
// all. Extracted to module scope (and exported below) so this arithmetic is
// unit-testable without a live DOM -- see tests/mastodon-dashboard.test.js.
function computeRateLimitResumeAt(prunedTimestamps, max, windowMs) {
  if (prunedTimestamps.length < max) return null;
  return prunedTimestamps[0] + windowMs + 1000; // +1s buffer past the oldest delete's window
}

// Cancel-aware wait loop, decoupled from the real clock/sleep/progress-UI so it's
// unit testable (see tests/mastodon-dashboard.test.js) without waiting out a real
// 30-minute rate-limit window. `sleep`/`now` are injected by the real caller
// (delay/Date.now) and faked by tests. Returns true the instant cancellation is
// observed, instead of running the full remaining wait out first -- this is what
// makes the Cancel button responsive during a paced rate-limit wait.
async function runCancelableWait(resumeAt, cancelController, sleep, now, onTick) {
  while (now() < resumeAt) {
    if (cancelController && cancelController.cancelled) return true;
    const remainingMs = resumeAt - now();
    if (onTick) onTick(remainingMs);
    await sleep(Math.min(1000, remainingMs));
  }
  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeRateLimitResumeAt, runCancelableWait };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get(['mstdn_host', 'mstdn_user_id', 'mstdn_username']),
    chrome.storage.session.get(['mstdn_token'])
  ]);
  if (!localData.mstdn_host || !sessionData.mstdn_token || !localData.mstdn_user_id) {
    await showAlert("Not connected. Please connect Mastodon from the extension popup first.");
    window.close();
    return;
  }

  const { mstdn_host: host, mstdn_user_id: accountId, mstdn_username: username } = localData;
  const { mstdn_token: token } = sessionData;
  document.getElementById('connected-as').textContent = t("dashConnectedAs", `(Connected: @${username})`, [`@${username}`]);

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  const DELETE_PROGRESS_KEY = 'mastodon_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  let currentResults = [];

  // Mastodon's delete rate limit (shared with un-reblog) is 30 requests per
  // rolling 30-minute window, not the general 300-per-5-minutes API limit.
  // We track the timestamp of every delete we issue and, once we're about to
  // exceed the cap, actually pause until the oldest delete in the window
  // ages out — rather than firing rapidly and getting locked out.
  const DELETE_RATE_LIMIT_MAX = 30;
  const DELETE_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;
  const DELETE_MIN_SPACING_MS = 750; // baseline spacing between deletes within a window
  let deleteTimestamps = [];

  function pruneDeleteTimestamps() {
    const cutoff = Date.now() - DELETE_RATE_LIMIT_WINDOW_MS;
    deleteTimestamps = deleteTimestamps.filter(t => t > cutoff);
  }

  // Blocks (with a live countdown in progressText) until issuing another
  // delete would stay within the 30-per-30-minute window. Checks
  // cancelController every tick (via runCancelableWait) so a Cancel click during
  // this wait -- which can be up to ~30 minutes -- stops promptly instead of
  // running the full remaining wait out first.
  async function waitForDeleteRateLimit(cancelController) {
    pruneDeleteTimestamps();
    const resumeAt = computeRateLimitResumeAt(deleteTimestamps, DELETE_RATE_LIMIT_MAX, DELETE_RATE_LIMIT_WINDOW_MS);
    if (resumeAt === null) return;

    const cancelled = await runCancelableWait(resumeAt, cancelController, delay, Date.now, (remainingMs) => {
      const remainingSec = Math.ceil(remainingMs / 1000);
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      progressText.textContent =
        `Rate limit paced: 30 deletes per 30 min reached. Resuming in ${mins}m ${secs}s...`;
    });
    if (cancelled) return;

    pruneDeleteTimestamps();
  }

  // Helper for Mastodon API fetches
  async function apiFetch(endpoint, method = 'GET') {
    const url = `https://${host}${endpoint}`;
    const options = {
      method,
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const response = await fetchWithRetry(url, options);
    if (!response.ok) {
      if (response.status === 429) throw new Error('Rate limit exceeded');
      if (response.status === 401) {
        const authErr = new Error("Your Mastodon access token appears to be invalid or revoked. Reconnect from the extension popup with a fresh token.");
        authErr.expiredAuth = true;
        throw authErr;
      }
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `API Error ${response.status} on ${endpoint}`);
    }
    // DELETE requests usually return empty JSON or 200 OK
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-mastodon.html.

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a partial/cancelled/selective delete leaves some scanned items
  // un-deleted -- those stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    items.forEach(status => {
      const plainText = (status.content || status.reblog?.content || '').replace(/<[^>]+>/g, '');
      const div = document.createElement('div');
      div.className = 'post-item';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      timeDiv.textContent = new Date(status.created_at).toLocaleString();

      const textDiv = document.createElement('div');
      if (plainText) {
        textDiv.textContent = plainText;
      } else {
        const i = document.createElement('i');
        i.textContent = '[Media only / Reblog]';
        textDiv.appendChild(i);
      }

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, status, rowCheckboxes);
      itemList.appendChild(div);
    });
    wireSelectAll(selectAllBox, items, rowCheckboxes);
  }

  scanBtn.addEventListener('click', async () => {
    const filterText = filterInput.value.trim().toLowerCase();
    
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    renderEmptyState(itemList, "Scanning toots...");
    currentResults = [];
    logActivity('sc-activity-log', `Scan started${filterText ? ` (filter: "${filterText}")` : ''}.`);

    try {
      let maxId = '';
      let pageCount = 0;
      let truncated = false;
      const MAX_PAGES = 10; // 40 items per page * 10 = 400 toots per scan
      // Defensive de-dup: without this, a repeated/overlapping `max_id` page (a
      // non-standard instance/fork, or new activity shifting the listing mid-scan)
      // shows the same toot twice, inflating "N items found" and queuing a
      // redundant delete request for it later. Mirrors dashboard-reddit.js's/
      // dashboard-x.js's seenIds guard.
      const seenIds = new Set();

      while (pageCount < MAX_PAGES) {
        let endpoint = `/api/v1/accounts/${accountId}/statuses?limit=40`;
        if (maxId) endpoint += `&max_id=${maxId}`;

        const statuses = await apiFetch(endpoint);
        if (!statuses || statuses.length === 0) break;

        for (const status of statuses) {
          if (seenIds.has(status.id)) continue;
          seenIds.add(status.id);

          // Exclude reblogs if you only want to delete your own content,
          // but deleting a reblog (unreblogging) uses the same endpoint if it's the reblog ID.
          // The API returns the raw HTML in `content` for regular statuses.

          let matches = true;
          if (filterText) {
            // A boost/reblog wrapper status has an EMPTY `content` of its own --
            // the real text lives on `status.reblog.content`. Without this
            // fallback, typing any filter would always exclude every boost
            // regardless of what the boosted post actually says, while leaving
            // the filter blank would unconditionally pull in all boosts --
            // silently inconsistent filter behavior.
            const rawContent = status.content || status.reblog?.content || '';
            // strip HTML tags for simple text matching
            const plainText = rawContent.replace(/<[^>]+>/g, '').toLowerCase();
            matches = plainText.includes(filterText);
          }

          if (matches) {
            currentResults.push(status);
          }
        }
        
        maxId = statuses[statuses.length - 1].id;
        pageCount++;
        // Only a FULL page (limit=40) at the cap is real evidence more toots may
        // exist -- a partial last page (< 40) is itself proof the account's
        // history ended naturally on this exact page, even though it happens to
        // be the MAX_PAGES-th one. Without this check, an account with e.g.
        // exactly 385 toots would be reported as "may not be exhaustive" when
        // the scan actually reached the true end.
        truncated = pageCount >= MAX_PAGES && statuses.length === 40;

        // A partial page is already proof the account's history just ended (see
        // the comment above) -- stop now instead of spending one more request +
        // delay on a page that's guaranteed to come back empty.
        if (statuses.length < 40) break;

        // Slight delay to avoid hitting rate limits on scan
        await delay(500);
      }

      // truncated stays true only when the loop stopped because it hit MAX_PAGES
      // on a full page, not on a natural end (an empty or partial page) -- so
      // "N items found" doesn't imply an exhaustive scan when older toots may
      // still exist.
      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: "older toots may exist"
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
        logActivity('sc-activity-log', `Scan complete: ${currentResults.length} toot(s) found${truncated ? ' (truncated -- more may exist)' : ''}.`);
      } else {
        renderEmptyState(itemList, "No toots matched your criteria. Try widening your text filter.");
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', 'Scan complete: 0 toots found.');
      }
    } catch (err) {
      await showAlert("Scan failed: " + err.message);
      statusText.textContent = "Error";
      logActivity('sc-activity-log', `Scan failed: ${err.message}`, 'error');
    } finally {
      scanBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const selected = getSelectedItems(currentResults);
    if (selected.length === 0) {
      await showAlert(t("dashNoItemsSelected", "No items are selected. Check at least one item, or use Select All, before deleting."));
      return;
    }
    if (!(await confirmBulkDelete(selected.length, "toots"))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;

    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController);

    // Mastodon does not support batch deletion. We must delete one by one.
    // Deletes (shared with un-reblog) are capped at 30 per rolling 30-minute
    // window, so we pace against that real limit instead of a flat delay.
    deleteTimestamps = [];

    const totalCount = selected.length;
    let deletedCount = 0;
    let failures = [];
    logActivity('sc-activity-log', `Delete started: ${totalCount} toot(s) selected.`);
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        preItemWait: waitForDeleteRateLimit,
        postItemDelayMs: DELETE_MIN_SPACING_MS,
        deleteItem: async (status) => {
          await apiFetch(`/api/v1/statuses/${status.id}`, 'DELETE');
          deleteTimestamps.push(Date.now());
        }
      });
      deletedCount = result.deletedCount;
      failures = result.failures;
      const { succeededItems, expiredAuth, cancelled } = result;

      // Anything scanned but not selected, anything selected but never reached
      // because a cancel/expired-auth break happened early, AND anything that
      // was attempted but failed to delete all stay visible -- only items
      // actually deleted are removed from view, so a failed delete never looks
      // indistinguishable from a successful one. A Set lookup here (rather than
      // Array#includes) keeps this O(n) instead of O(n^2) -- succeededItems is
      // typically most/all of currentResults on a normal run.
      const succeededSet = new Set(succeededItems);
      currentResults = currentResults.filter(item => !succeededSet.has(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        itemList.innerHTML = '';
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });

      if (expiredAuth) {
        statusText.textContent = "Access token invalid — reconnect required.";
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', `Delete stopped: access token invalid (${deletedCount}/${totalCount} deleted).`, 'error');
        await showAlert(`Stopped: your Mastodon access token appears to be invalid or revoked. ${deletedCount} of ${totalCount} toots were deleted before this happened. Reconnect from the extension popup with a fresh token to finish.`);
      } else if (cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [String(deletedCount), String(totalCount)]);
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', `Delete cancelled: ${deletedCount}/${totalCount} processed.`, 'warn');
      } else if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
        logActivity('sc-activity-log', `Delete complete: ${deletedCount}/${totalCount} deleted.`);
      } else {
        statusText.textContent = `Deletion finished with ${failures.length} failure(s) out of ${totalCount}.`;
        statusText.style.color = "#ef4444";
        console.warn("Mastodon delete failures:", failures);
        logActivity('sc-activity-log', `Delete finished: ${deletedCount} deleted, ${failures.length} failed out of ${totalCount}.`, 'warn');
      }
      if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
    } catch (err) {
      const progress = err.deleteLoopProgress || { deletedCount, succeededItems: [] };
      // Prune whatever succeeded before the throw, mirroring the normal-completion
      // path above -- otherwise an aborted run (e.g. service-worker restart,
      // storage error) leaves already-deleted items checked and re-submittable
      // on the next Delete click.
      const succeededSet = new Set(progress.succeededItems || []);
      currentResults = currentResults.filter(item => !succeededSet.has(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });
      console.error("Mastodon delete loop stopped unexpectedly:", err);
      logActivity('sc-activity-log', `Delete stopped unexpectedly: ${err.message}`, 'error');
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${progress.deletedCount} of ${totalCount} toots were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
