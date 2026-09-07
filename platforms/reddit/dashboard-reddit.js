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
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');
  
  let currentResults = [];

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

  scanBtn.addEventListener('click', async () => {
    const targetType = targetTypeInput.value;
    const isDeepScan = deepScanInput.checked;
    
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Scanning history...</div>';
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
          if (item.author === '[deleted]' || item.removed_by_category) continue;
          const isComment = item.name.startsWith('t1_');
          currentResults.push({
            id: item.name, // e.g. t1_xxxx or t3_xxxx
            type: isComment ? 'Comment' : 'Post',
            text: isComment ? item.body : item.title,
            subreddit: item.subreddit_name_prefixed,
            time: item.created_utc * 1000 // Convert to ms
          });
        }
        
        after = resJson.data.after;
        if (!after) break;
        
        pageCount++;
        await delay(1000); // 1s delay between pagination requests
      }
      
      resultsCount.textContent = `${currentResults.length} items found`;
      
      if (currentResults.length > 0) {
        itemList.innerHTML = '';
        currentResults.forEach(item => {
          const div = document.createElement('div');
          div.className = 'post-item';
          const badgeClass = item.type === 'Comment' ? 'badge-comment' : 'badge-post';
          div.innerHTML = `
            <div class="post-time">
              <span class="badge ${badgeClass}">${item.type}</span>
              in ${item.subreddit} on ${new Date(item.time).toLocaleString()}
            </div>
            <div>${item.text}</div>
          `;
          itemList.appendChild(div);
        });
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">No items found.</div>';
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
    const confirmation = prompt(`Type DELETE to permanently delete ${currentResults.length} items.`);
    if (confirmation !== "DELETE") {
      alert("Deletion cancelled.");
      return;
    }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Deleting...";
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;
    
    try {
      let deletedCount = 0;
      for (const item of currentResults) {
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
           throw new Error(`Deletion failed on item ${item.id} with status ${response.status}`);
        }
        
        deletedCount++;
        progressText.textContent = `Deleted ${deletedCount} of ${currentResults.length}`;
        
        // strict 1.5 second delay to avoid rate limits
        await delay(1500); 
      }

      statusText.textContent = "Deletion Complete!";
      statusText.style.color = "#10b981";
      currentResults = [];
      itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Deletion finished.</div>';
      resultsCount.textContent = "0 items found";
    } catch (err) {
      alert("Deletion failed: " + err.message);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
    }
  });
});
