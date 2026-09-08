document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(['reddit_modhash', 'reddit_username']);
  if (!data.reddit_modhash || !data.reddit_username) {
    alert("Not linked to Reddit. Please open the extension popup first.");
    window.close();
    return;
  }

  const { reddit_modhash: modhash, reddit_username: username } = data;
  document.getElementById('connected-as').textContent = `(u/${username})`;

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
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
        itemList.innerHTML = '';
        currentResults.forEach(item => {
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
          itemList.appendChild(div);
        });
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        renderEmptyState(itemList, "No items found.");
        statusText.textContent = "Ready";
      }
    } catch (err) {
      alert("Scan failed: " + err.message);
      statusText.textContent = "Error";
    } finally {
      scanBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    if (!confirmBulkDelete(currentResults.length, "items")) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Deleting...";
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;
    
    const totalCount = currentResults.length;
    let deletedCount = 0;
    const failures = [];
    try {
      // The inner per-item try/catch below isolates one item's failure from the
      // rest of the batch. This outer try/finally is separate: it guards the
      // chrome.storage.local calls (progress marker) and everything else in this
      // handler against an unexpected exception (e.g. the extension being
      // reloaded mid-run invalidates the extension context) so the loop can never
      // die silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: totalCount, done: 0 } });
      for (const item of currentResults) {
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
            throw new Error(`status ${response.status}`);
          }
          deletedCount++;
        } catch (err) {
          failures.push({ id: item.id, message: err.message });
        }
        progressText.textContent = `Deleted ${deletedCount} of ${totalCount}`;
        await maybeSaveDeleteProgress(DELETE_PROGRESS_KEY, deletedCount + failures.length, totalCount);

        // strict 1.5 second delay to avoid rate limits
        await delay(1500);
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);

      if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
      } else {
        statusText.textContent = `Deletion finished with ${failures.length} failure(s) out of ${totalCount}.`;
        statusText.style.color = "#ef4444";
        console.warn("Reddit delete failures:", failures);
      }
      currentResults = [];
      renderEmptyState(itemList, "Deletion finished.");
      resultsCount.textContent = "0 items found";
    } catch (err) {
      console.error("Reddit delete loop stopped unexpectedly:", err);
      alert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${totalCount} items were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
    }
  });
});
