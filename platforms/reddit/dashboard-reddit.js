document.addEventListener('DOMContentLoaded', async () => {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['reddit_modhash']),
    chrome.storage.local.get(['reddit_username'])
  ]);
  if (!sessionData.reddit_modhash || !localData.reddit_username) {
    await showAlert("Not linked to Reddit. Please open the extension popup first.");
    window.close();
    return;
  }

  const { reddit_modhash: modhash } = sessionData;
  const { reddit_username: username } = localData;
  document.getElementById('connected-as').textContent = t("dashConnectedAs", `(u/${username})`, [`u/${username}`]);

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const targetTypeInput = document.getElementById('target-type');
  const deepScanInput = document.getElementById('deep-scan');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  const DELETE_PROGRESS_KEY = 'reddit_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);

  let currentResults = [];

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-reddit.html.

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a partial/cancelled/selective delete leaves some scanned items
  // un-deleted -- those stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'post-item';
      const badgeClass = item.type === 'Comment' ? 'badge-comment' : 'badge-post';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      const badge = document.createElement('span');
      badge.className = `badge ${badgeClass}`;
      badge.textContent = item.type;
      timeDiv.appendChild(badge);
      timeDiv.appendChild(document.createTextNode(
        ` in ${item.subreddit} on ${new Date(item.time).toLocaleString()}`
      ));

      const textDiv = document.createElement('div');
      textDiv.textContent = item.text;

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, item, rowCheckboxes);
      itemList.appendChild(div);
    });
    wireSelectAll(selectAllBox, items, rowCheckboxes);
  }

  scanBtn.addEventListener('click', async () => {
    const targetType = targetTypeInput.value;
    const isDeepScan = deepScanInput.checked;
    const filterText = filterInput.value.trim().toLowerCase();

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    renderEmptyState(itemList, "Scanning history...");
    currentResults = [];

    try {
      let after = '';
      let pageCount = 0;
      const MAX_PAGES = isDeepScan ? 1000 : 10; // ~25 items per page

      while (pageCount < MAX_PAGES) {
        let url = `https://www.reddit.com/user/${username}/`;
        if (targetType === 'comments') url += 'comments.json?limit=25';
        else if (targetType === 'submitted') url += 'submitted.json?limit=25';
        else url += 'overview.json?limit=25'; // all
        
        if (after) url += `&after=${after}`;
        
        const response = await fetchWithRetry(url, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`API Error ${response.status}`);
        }
        
        const resJson = await response.json();
        const children = resJson.data?.children || [];
        if (children.length === 0) break;

        for (const child of children) {
          const item = child.data;
          // Skip items that are already deleted/removed — nothing left to clean up.
          if (!item || !item.name) continue; // e.g. a "more"-type stub child, not a real post/comment
          if (item.author === '[deleted]' || item.removed_by_category) continue;
          const isComment = item.name.startsWith('t1_');
          const text = isComment ? item.body : item.title;
          if (filterText && !(text || '').toLowerCase().includes(filterText)) continue;
          currentResults.push({
            id: item.name, // e.g. t1_xxxx or t3_xxxx
            type: isComment ? 'Comment' : 'Post',
            text: text,
            subreddit: item.subreddit_name_prefixed,
            time: item.created_utc * 1000 // Convert to ms
          });
        }
        
        after = resJson.data.after;
        if (!after) break;
        
        pageCount++;
        await delay(1000); // 1s delay between pagination requests
      }

      // The loop above can also exit because pageCount hit MAX_PAGES while
      // Reddit still had more pages (`after` truthy) -- as opposed to a natural
      // end (no more children, or no `after` cursor). Surface that distinction
      // so "N items found" doesn't imply an exhaustive scan when it wasn't one.
      const truncated = pageCount >= MAX_PAGES && !!after;
      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: `more may exist${isDeepScan ? '' : ', try Deep Scan'}`
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        renderEmptyState(itemList, "No items found.");
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
    if (!(await confirmBulkDelete(selected.length, "items"))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;

    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController);

    const totalCount = selected.length;
    let deletedCount = 0;
    const failures = [];
    const processedItems = [];
    try {
      // The inner per-item try/catch below isolates one item's failure from the
      // rest of the batch. This outer try/finally is separate: it guards the
      // chrome.storage.local calls (progress marker) and everything else in this
      // handler against an unexpected exception (e.g. the extension being
      // reloaded mid-run invalidates the extension context) so the loop can never
      // die silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: totalCount, done: 0 } });
      let expiredAuth = false;
      for (const item of selected) {
        if (cancelController.cancelled) break;
        processedItems.push(item);
        try {
          // POST to /api/del
          const formData = new URLSearchParams();
          formData.append('id', item.id);
          formData.append('uh', modhash);

          const response = await fetchWithRetry('https://www.reddit.com/api/del', {
            method: 'POST',
            credentials: "include",
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData.toString()
          });

          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              const authErr = new Error("Your Reddit session or modhash appears to be invalid. Reconnect from the extension popup.");
              authErr.expiredAuth = true;
              throw authErr;
            }
            throw new Error(`status ${response.status}`);
          }
          deletedCount++;
        } catch (err) {
          failures.push({ id: item.id, message: err.message });
          // An invalid session/modhash fails every remaining item identically --
          // stop immediately with one clear reconnect message instead of retrying
          // each remaining item only to fail the same way.
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
        // strict 1.5 second delay to avoid rate limits
        await delay(1500);
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
        statusText.textContent = "Session invalid — reconnect required.";
        statusText.style.color = "#ef4444";
        await showAlert(`Stopped: your Reddit session appears to be invalid. ${deletedCount} of ${totalCount} items were deleted before this happened. Reconnect from the extension popup to finish.`);
      } else if (cancelController.cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [String(deletedCount), String(totalCount)]);
        statusText.style.color = "#ef4444";
      } else if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
      } else {
        statusText.textContent = `Deletion finished with ${failures.length} failure(s) out of ${totalCount}.`;
        statusText.style.color = "#ef4444";
        console.warn("Reddit delete failures:", failures);
      }
      if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
    } catch (err) {
      console.error("Reddit delete loop stopped unexpectedly:", err);
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${totalCount} items were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
