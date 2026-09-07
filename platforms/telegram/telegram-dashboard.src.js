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

  // See the matching comment in platforms/reddit/dashboard-reddit.js: this marker
  // only informs the next session that a delete was interrupted -- it does not
  // resume the delete itself, since a fresh scan is required to see current state.
  const DELETE_PROGRESS_KEY = 'telegram_delete_progress';
  const leftover = (await chrome.storage.local.get([DELETE_PROGRESS_KEY]))[DELETE_PROGRESS_KEY];
  if (leftover) {
    statusText.textContent = `A previous deletion was interrupted (${leftover.done} of ${leftover.total} processed). Scan again to see current state.`;
    await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);
  }

  // Set by the scan handler, read by the delete handler -- see the delete handler
  // for why the resolved entity (not just the raw peer string) matters.
  let lastPeer = 'me';

  scanBtn.addEventListener('click', async () => {
    const peer = targetChatInput.value.trim() || 'me';
    lastPeer = peer;
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
        const result = await invokeWithFloodWait(
          () => client.invoke(
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
          ),
          {
            onWait: (seconds, attempt) => {
              statusText.textContent = `Rate limited by Telegram while scanning — waiting ${seconds}s (retry ${attempt})...`;
            },
          }
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

          const timeDiv = document.createElement('div');
          timeDiv.className = 'post-time';
          timeDiv.textContent = new Date(msg.date * 1000).toLocaleString();

          const textDiv = document.createElement('div');
          if (msg.message) {
            textDiv.textContent = msg.message;
          } else {
            const i = document.createElement('i');
            i.textContent = '[No text/Media only]';
            textDiv.appendChild(i);
          }

          div.appendChild(timeDiv);
          div.appendChild(textDiv);
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
    // Above LARGE_DELETE_THRESHOLD, a fixed literal like "DELETE" is the same
    // low-friction confirm regardless of whether 2 or thousands of messages are
    // about to be permanently destroyed for everyone. Require typing the exact
    // count instead, so the number is something the user has to actually
    // notice and act on, not just habitually retype.
    const count = currentResults.length;
    const LARGE_DELETE_THRESHOLD = 100;
    const isLarge = count > LARGE_DELETE_THRESHOLD;
    const expected = isLarge ? String(count) : "DELETE";
    const promptText = isLarge
      ? `You are about to permanently delete ${count} messages for everyone -- more than ${LARGE_DELETE_THRESHOLD}. Type the exact number ${count} to confirm.`
      : `Type DELETE to permanently delete ${count} messages for everyone.`;
    const confirmation = prompt(promptText);
    if (confirmation !== expected) {
      alert("Deletion cancelled.");
      return;
    }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Deleting...";
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;
    
    const BATCH_SIZE = 100;
    let deletedCount = 0;
    const failedChunks = [];

    try {
      // messages.DeleteMessages operates on the user/basic-group message-ID
      // space only -- a channel or supergroup's messages live in a SEPARATE
      // ID space owned by that channel, and deleting them requires
      // channels.DeleteMessages({channel, id}) instead. messages.Search (the
      // scan call above) happily accepts a channel/supergroup peer and returns
      // real results, but messages.DeleteMessages against those same IDs
      // doesn't throw -- it just silently affects nothing, since the ID space
      // it's checking is the wrong one. Resolve the actual entity so the right
      // API gets called.
      let channelEntity = null;
      try {
        const entity = await client.getEntity(lastPeer || 'me');
        if (entity && entity.className === 'Channel') {
          channelEntity = entity;
        }
      } catch (err) {
        console.warn("Could not resolve Telegram peer entity before deleting; assuming a user/basic-group chat.", err);
      }

      // The inner per-chunk try/catch below isolates one chunk's failure from
      // the rest of the batch. This outer try/finally is separate: it guards
      // the chrome.storage.local calls (progress marker) and everything else in
      // this handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: currentResults.length, done: 0 } });
      for (let i = 0; i < currentResults.length; i += BATCH_SIZE) {
        const chunk = currentResults.slice(i, i + BATCH_SIZE).map(m => m.id);

        try {
          // DeleteMessages is atomic per call -- isolate each chunk so one failed
          // chunk (transient network/server error, past the flood-wait retries)
          // doesn't abort every later chunk in the batch.
          await invokeWithFloodWait(
            () => client.invoke(
              channelEntity
                ? new Api.channels.DeleteMessages({ channel: channelEntity, id: chunk })
                : new Api.messages.DeleteMessages({ id: chunk, revoke: true }) // Delete for everyone
            ),
            {
              onWait: (seconds, attempt) => {
                progressText.textContent = `Rate limited by Telegram — waiting ${seconds}s (retry ${attempt})...`;
              },
            }
          );
          deletedCount += chunk.length;
        } catch (err) {
          failedChunks.push({ count: chunk.length, message: err.message });
        }

        progressText.textContent = `Deleted ${deletedCount} of ${currentResults.length}`;
        const processedSoFar = deletedCount + failedChunks.reduce((sum, c) => sum + c.count, 0);
        await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: currentResults.length, done: processedSoFar } });
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);

      currentResults = [];
      resultsCount.textContent = "0 items found";

      if (failedChunks.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Deletion finished.</div>';
      } else {
        const failedCount = failedChunks.reduce((sum, c) => sum + c.count, 0);
        statusText.textContent = `Deletion finished: ${deletedCount} deleted, ${failedCount} failed.`;
        statusText.style.color = "#ef4444";
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Deletion finished (see error summary).</div>';
        console.warn("Telegram delete chunk failures:", failedChunks);
        alert(
          `Delete failed for ${failedCount} of ${deletedCount + failedCount} message(s). ` +
          `The Delete button will stay disabled -- please Scan again before retrying, ` +
          `since some of the originally scanned messages may already be gone.`
        );
      }
      // deleteBtn deliberately stays disabled: a rescan is required before another
      // delete, since results that already succeeded should not be re-submitted
      // from stale in-memory state.
    } catch (err) {
      console.error("Telegram delete loop stopped unexpectedly:", err);
      alert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${currentResults.length} messages were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
    }
  });
});
