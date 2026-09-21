// Pure: given one page's raw `children` (from Reddit's overview/comments/submitted
// listing JSON) and the lowercased filter text, returns the result objects to add to
// currentResults. Extracted to module scope (mirroring dashboard-x.js's
// extractTweetsFromEntries) so the "what counts as a real, still-deletable item"
// logic -- skipping already-deleted/removed items and "more"-type stub children,
// telling a comment from a post, applying the text filter -- is unit-tested
// directly instead of only reachable through a live scan. See
// tests/reddit-dashboard.test.js.
function extractRedditItemsFromChildren(children, filterText, seenIds) {
  const results = [];
  for (const child of children) {
    const item = child.data;
    // Skip items that are already deleted/removed -- nothing left to clean up.
    if (!item || !item.name) continue; // e.g. a "more"-type stub child, not a real post/comment
    if (item.author === '[deleted]' || item.removed_by_category) continue;
    // Defensive de-dup: without this, a repeated/overlapping `after` page (a
    // stuck cursor, or new activity shifting the listing mid-scan -- Deep Scan
    // can run up to 1000 pages) shows the same post/comment twice, inflating
    // "N items found" and issuing a redundant delete request for it later.
    // Mirrors dashboard-x.js's seenTweetIds guard.
    if (seenIds) {
      if (seenIds.has(item.name)) continue;
      seenIds.add(item.name);
    }
    const isComment = item.name.startsWith('t1_');
    const text = isComment ? item.body : item.title;
    if (filterText && !(text || '').toLowerCase().includes(filterText)) continue;
    results.push({
      id: item.name, // e.g. t1_xxxx or t3_xxxx
      type: isComment ? 'Comment' : 'Post',
      text: text,
      subreddit: item.subreddit_name_prefixed,
      time: item.created_utc * 1000 // Convert to ms
    });
  }
  return results;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractRedditItemsFromChildren };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
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
  initActivityLog('sc-activity-log');

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
    logActivity('sc-activity-log', `Scan started (target: ${targetType}${isDeepScan ? ', deep scan' : ''}${filterText ? `, filter: "${filterText}"` : ''}).`);

    try {
      let after = '';
      let pageCount = 0;
      const seenIds = new Set();
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

        currentResults.push(...extractRedditItemsFromChildren(children, filterText, seenIds));
        
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
        logActivity('sc-activity-log', `Scan complete: ${currentResults.length} item(s) found${truncated ? ' (truncated -- more may exist)' : ''}.`);
      } else {
        renderEmptyState(itemList, "No items found. Try widening your filters, or enable Deep Scan for more history.");
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', 'Scan complete: 0 items found.');
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
    let failures = [];
    logActivity('sc-activity-log', `Delete started: ${totalCount} item(s) selected.`);
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        // strict 1.5 second delay to avoid rate limits
        postItemDelayMs: 1500,
        deleteItem: async (item) => {
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
        statusText.textContent = "Session invalid — reconnect required.";
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', `Delete stopped: session invalid (${deletedCount}/${totalCount} deleted).`, 'error');
        await showAlert(`Stopped: your Reddit session appears to be invalid. ${deletedCount} of ${totalCount} items were deleted before this happened. Reconnect from the extension popup to finish.`);
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
        console.warn("Reddit delete failures:", failures);
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
      console.error("Reddit delete loop stopped unexpectedly:", err);
      logActivity('sc-activity-log', `Delete stopped unexpectedly: ${err.message}`, 'error');
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${progress.deletedCount} of ${totalCount} items were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
