document.addEventListener('DOMContentLoaded', async () => {
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
  // delete would stay within the 30-per-30-minute window.
  async function waitForDeleteRateLimit() {
    pruneDeleteTimestamps();
    if (deleteTimestamps.length < DELETE_RATE_LIMIT_MAX) return;

    const oldest = deleteTimestamps[0];
    let resumeAt = oldest + DELETE_RATE_LIMIT_WINDOW_MS + 1000; // +1s buffer

    while (Date.now() < resumeAt) {
      const remainingMs = resumeAt - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      progressText.textContent =
        `Rate limit paced: 30 deletes per 30 min reached. Resuming in ${mins}m ${secs}s...`;
      await delay(Math.min(1000, remainingMs));
    }

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

    try {
      let maxId = '';
      let pageCount = 0;
      let truncated = false;
      const MAX_PAGES = 10; // 40 items per page * 10 = 400 toots per scan

      while (pageCount < MAX_PAGES) {
        let endpoint = `/api/v1/accounts/${accountId}/statuses?limit=40`;
        if (maxId) endpoint += `&max_id=${maxId}`;

        const statuses = await apiFetch(endpoint);
        if (!statuses || statuses.length === 0) break;

        for (const status of statuses) {
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
      } else {
        renderEmptyState(itemList, "No toots matched your criteria.");
        statusText.textContent = t("dashReady", "Ready");
      }
    } catch (err) {
      await showAlert("Scan failed: " + err.message);
      statusText.textContent = "Error";
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
    const failures = [];
    const processedItems = [];
    try {
      // The inner per-item try/catch below isolates one item's failure from the
      // rest of the batch. This outer try/finally is separate: it guards the
      // chrome.storage.local calls (progress marker) and everything else in this
      // handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: totalCount, done: 0 } });
      let expiredAuth = false;
      for (const status of selected) {
        if (cancelController.cancelled) break;
        await waitForDeleteRateLimit();
        if (cancelController.cancelled) break;
        processedItems.push(status);

        try {
          await apiFetch(`/api/v1/statuses/${status.id}`, 'DELETE');
          deleteTimestamps.push(Date.now());
          deletedCount++;
        } catch (err) {
          failures.push({ id: status.id, message: err.message });
          // An invalid/revoked token fails every remaining item identically -- stop
          // immediately with one clear reconnect message instead of retrying each
          // remaining item only to fail the same way.
          if (err.expiredAuth) {
            expiredAuth = true;
            break;
          }
        }
        progressText.textContent = failures.length > 0
          ? `Processed ${deletedCount + failures.length} of ${totalCount} (${deletedCount} deleted, ${failures.length} failed)`
          : `Deleted ${deletedCount} of ${totalCount}`;
        await maybeSaveDeleteProgress(DELETE_PROGRESS_KEY, deletedCount + failures.length, totalCount);
        if (expiredAuth || cancelController.cancelled) break;
        await delay(DELETE_MIN_SPACING_MS);
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);

      // Anything scanned but not selected, plus anything selected but never
      // reached because a cancel/expired-auth break happened early, stays
      // visible -- only items actually attempted are removed from view.
      currentResults = currentResults.filter(item => !processedItems.includes(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        itemList.innerHTML = '';
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });

      if (expiredAuth) {
        statusText.textContent = "Access token invalid — reconnect required.";
        statusText.style.color = "#ef4444";
        await showAlert(`Stopped: your Mastodon access token appears to be invalid or revoked. ${deletedCount} of ${totalCount} toots were deleted before this happened. Reconnect from the extension popup with a fresh token to finish.`);
      } else if (cancelController.cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [String(deletedCount), String(totalCount)]);
        statusText.style.color = "#ef4444";
      } else if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
      } else {
        statusText.textContent = `Deletion finished with ${failures.length} failure(s) out of ${totalCount}.`;
        statusText.style.color = "#ef4444";
        console.warn("Mastodon delete failures:", failures);
      }
      if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
    } catch (err) {
      console.error("Mastodon delete loop stopped unexpectedly:", err);
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${totalCount} toots were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
