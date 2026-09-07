import { TelegramClient, Api, errors, extensions } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

let client;
let currentResults = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries an invoke() call when Telegram signals a flood-wait, pausing for the
// duration the server asked for instead of letting the whole batch throw.
async function invokeWithFloodWait(invokeFn, { maxRetries = 5, onWait } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await invokeFn();
    } catch (err) {
      const isFloodWait = err instanceof errors.FloodWaitError ||
        (typeof err.seconds === 'number' && /FLOOD_WAIT/i.test(err.message || ''));
      if (!isFloodWait || attempt >= maxRetries) {
        throw err;
      }
      const waitMs = (err.seconds || 1) * 1000 + 250; // small buffer past the required wait
      if (onWait) onWait(err.seconds || 1, attempt + 1);
      await sleep(waitMs);
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(['tg_session', 'tg_api_id', 'tg_api_hash']);
  if (!data.tg_session || !data.tg_api_id || !data.tg_api_hash) {
    alert("Not logged in. Please log in from the extension popup first.");
    window.close();
    return;
  }

  const stringSession = new StringSession(data.tg_session);
  client = new TelegramClient(stringSession, data.tg_api_id, data.tg_api_hash, {
    connectionRetries: 5,
    // Browsers cannot open raw TCP sockets — teleproto defaults to
    // PromisedNetSockets (Node's `net`), so we must explicitly force
    // the WebSocket transport here.
    networkSocket: extensions.PromisedWebSockets,
  });

  try {
    await client.connect(); // Connect without login prompt
    document.getElementById('connected-as').textContent = '(Connected)';
  } catch (e) {
    alert("Failed to connect to Telegram. " + e.message);
    window.close();
    return;
  }

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const targetChatInput = document.getElementById('target-chat');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');
  
  scanBtn.addEventListener('click', async () => {
    const peer = targetChatInput.value.trim() || 'me';
    const filterText = filterInput.value.trim().toLowerCase();
    
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Scanning messages...</div>';
    currentResults = [];

    try {
      let offsetId = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await client.invoke(
          new Api.messages.Search({
            peer: peer,
            q: filterText,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetId: offsetId,
            addOffset: 0,
            limit: 100,
            maxId: 0,
            minId: 0,
            fromId: new Api.InputPeerSelf(),
            hash: 0n,
          })
        );

        if (!result.messages || result.messages.length === 0) {
          hasMore = false;
          break;
        }

        for (const msg of result.messages) {
          if (msg.className === 'Message' || msg.className === 'MessageService') {
            currentResults.push(msg);
          }
        }
        
        offsetId = result.messages[result.messages.length - 1].id;
        if (result.messages.length < 100) hasMore = false;
      }
      
      resultsCount.textContent = `${currentResults.length} items found`;
      
      if (currentResults.length > 0) {
        itemList.innerHTML = '';
        currentResults.forEach(msg => {
          const div = document.createElement('div');
          div.className = 'post-item';
          div.innerHTML = `
            <div class="post-time">${new Date(msg.date * 1000).toLocaleString()}</div>
            <div>${msg.message || '<i>[No text/Media only]</i>'}</div>
          `;
          itemList.appendChild(div);
        });
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">No messages matched your criteria.</div>';
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
    const confirmation = prompt(`Type DELETE to permanently delete ${currentResults.length} messages for everyone.`);
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
      const BATCH_SIZE = 100;
      
      for (let i = 0; i < currentResults.length; i += BATCH_SIZE) {
        const chunk = currentResults.slice(i, i + BATCH_SIZE).map(m => m.id);

        await invokeWithFloodWait(
          () => client.invoke(
            new Api.messages.DeleteMessages({
              id: chunk,
              revoke: true, // Delete for everyone
            })
          ),
          {
            onWait: (seconds, attempt) => {
              progressText.textContent = `Rate limited by Telegram — waiting ${seconds}s (retry ${attempt})...`;
            },
          }
        );

        const deletedCount = Math.min(i + BATCH_SIZE, currentResults.length);
        progressText.textContent = `Deleted ${deletedCount} of ${currentResults.length}`;
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
