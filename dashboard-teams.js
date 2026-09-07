document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(['teams_token', 'teams_base_url']);
  if (!data.teams_token || !data.teams_base_url) {
    alert("Not linked to MS Teams. Please open the extension popup first.");
    window.close();
    return;
  }

  const { teams_base_url: baseUrl } = data;

  const loadChatsBtn = document.getElementById('load-chats-btn');
  const chatSelect = document.getElementById('chat-select');
  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const filterInput = document.getElementById('text-filter');
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

  async function apiFetch(endpoint, method = 'GET') {
    // Dynamically fetch token to handle expirations during long runs
    const storageData = await chrome.storage.local.get(['teams_token']);
    const token = storageData.teams_token;

    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': token,
        'Accept': 'application/json'
      }
    };
    let response = await fetchWithRetry(url, options);

    // A 401 means the token we sent has expired. background.js passively
    // re-captures a fresh token whenever the user's own Teams tab makes a
    // request, so there may already be a newer one sitting in storage by
    // the time we see this failure. Re-read storage and retry the single
    // request once before giving up - don't let one stale token abort an
    // entire in-progress batch delete.
    if (response.status === 401) {
      const refreshedData = await chrome.storage.local.get(['teams_token']);
      const refreshedToken = refreshedData.teams_token;
      if (refreshedToken && refreshedToken !== token) {
        const retryOptions = {
          method,
          headers: {
            'Authorization': refreshedToken,
            'Accept': 'application/json'
          }
        };
        response = await fetchWithRetry(url, retryOptions);
      }
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("API Error 403: Teams message deletion was blocked. This usually means the signed-in account is a personal Microsoft account, or your organization's messaging policy does not allow deleting sent messages. A work/school account with a policy that permits message deletion is required.");
      }
      throw new Error(`API Error ${response.status}`);
    }

    // DELETE requests may return empty body
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  loadChatsBtn.addEventListener('click', async () => {
    loadChatsBtn.disabled = true;
    statusText.textContent = "Loading chats...";
    try {
      // Fetch recent conversations
      const res = await apiFetch('/v1/users/ME/conversations');
      const conversations = res.conversations || [];
      
      chatSelect.innerHTML = '<option value="">-- Select a Chat --</option>';
      for (const conv of conversations) {
        // Teams chat IDs usually start with '19:'
        if (conv.id && conv.id.startsWith('19:')) {
          const opt = document.createElement('option');
          opt.value = conv.id;
          opt.textContent = conv.threadProperties?.topic || conv.id.split('@')[0];
          chatSelect.appendChild(opt);
        }
      }
      
      statusText.textContent = "Chats loaded.";
      scanBtn.disabled = false;
    } catch (err) {
      alert("Failed to load chats: " + err.message);
      statusText.textContent = "Error";
    } finally {
      loadChatsBtn.disabled = false;
    }
  });

  scanBtn.addEventListener('click', async () => {
    const chatId = chatSelect.value;
    const filterText = filterInput.value.trim().toLowerCase();
    
    if (!chatId) return alert("Please select a chat first.");
    
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Scanning messages...</div>';
    currentResults = [];

    try {
      // Fetch recent messages in chat
      // Note: We scan up to 100 messages for the MVP
      let endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?pageSize=100`;
      
      while (endpoint) {
        const res = await apiFetch(endpoint);
        const messages = res.messages || [];
        
        for (const msg of messages) {
          if (msg.from && (msg.from.includes('ME') || msg.imdisplayname) && msg.content && !msg.deleted) {
            const text = msg.content.replace(/<[^>]+>/g, '') || '';
            
            if (!filterText || text.toLowerCase().includes(filterText)) {
              currentResults.push({
                id: msg.id,
                text: text,
                time: msg.originalarrivaltime
              });
            }
          }
        }
        
        endpoint = res.nextLink || null;
        if (endpoint) await delay(1000); // 1s delay for pagination
      }
      
      resultsCount.textContent = `${currentResults.length} items found`;
      
      if (currentResults.length > 0) {
        itemList.innerHTML = '';
        currentResults.forEach(msg => {
          const div = document.createElement('div');
          div.className = 'post-item';
          div.innerHTML = `
            <div class="post-time">${new Date(msg.time).toLocaleString()}</div>
            <div>${msg.text}</div>
          `;
          itemList.appendChild(div);
        });
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">No matching messages found in this chat.</div>';
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
    const chatId = chatSelect.value;
    const confirmation = prompt(`Type DELETE to permanently delete ${currentResults.length} messages.`);
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
      for (const msg of currentResults) {
        // DELETE /v1/users/ME/conversations/{chatId}/messages/{messageId}
        const endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages/${msg.id}`;
        await apiFetch(endpoint, 'DELETE');
        
        deletedCount++;
        progressText.textContent = `Deleted ${deletedCount} of ${currentResults.length}`;
        
        // Strict 2.5 second delay to avoid enterprise security alarms / rate limits
        await delay(2500); 
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
