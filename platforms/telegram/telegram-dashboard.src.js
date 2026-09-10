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
  // tg_session lives in chrome.storage.session (memory-only) -- see the matching
  // comment in telegram-popup.src.js; api_id/api_hash are app identity, not user
  // credentials, and stay in local storage.
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['tg_session']),
    chrome.storage.local.get(['tg_api_id', 'tg_api_hash'])
  ]);
  const data = { ...sessionData, ...localData };
  if (!data.tg_session || !data.tg_api_id || !data.tg_api_hash) {
    await showAlert("Not logged in. Please log in from the extension popup first.");
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
    await showAlert("Failed to connect to Telegram. " + e.message);
    window.close();
    return;
  }

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
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

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a cancelled delete leaves some scanned items un-deleted -- those
  // stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    items.forEach(msg => {
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
      addRowCheckbox(div, msg, rowCheckboxes);
      itemList.appendChild(div);
    });
    wireSelectAll(selectAllBox, items, rowCheckboxes);
  }

  scanBtn.addEventListener('click', async () => {
    const peer = targetChatInput.value.trim() || 'me';
    lastPeer = peer;
    const filterText = filterInput.value.trim().toLowerCase();

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    itemList.innerHTML = '<div class="empty-state">Scanning messages...</div>';
    currentResults = [];

    try {
      let offsetId = 0;
      let hasMore = true;
      let pageCount = 0;
      let truncated = false;
      // Cap pagination like the mastodon/reddit/x dashboards so a large saved-messages
      // history or long-lived chat can't be scanned in full on every click.
      const MAX_PAGES = 20; // 100 messages per page * 20 = 2000 messages per scan
      while (hasMore && pageCount < MAX_PAGES) {
        const result = await invokeWithFloodWait(
          () => client.invoke(
            new Api.messages.Search({
              peer: peer,
              // Always search with an empty query and filter locally below (see the
              // loop just under this call) instead of sending filterText to
              // Telegram's own server-side search. That search is token/word-based --
              // a substring like "wor" would not match "word" the way it does on
              // every other platform's dashboard, which does a plain
              // case-insensitive .includes() -- so relying on it here would give the
              // same "Text Filter" control silently different semantics depending on
              // which platform is active.
              q: '',
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
          if (msg.className !== 'Message' && msg.className !== 'MessageService') continue;
          // Same case-insensitive substring match as every other platform dashboard,
          // applied locally so "Text Filter" means the same thing everywhere.
          if (filterText && !(msg.message || '').toLowerCase().includes(filterText)) continue;
          currentResults.push(msg);
        }
        
        offsetId = result.messages[result.messages.length - 1].id;
        if (result.messages.length < 100) hasMore = false;
        pageCount++;
        truncated = pageCount >= MAX_PAGES && hasMore;
      }

      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: "older messages may exist"
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        itemList.innerHTML = '<div class="empty-state">No messages matched your criteria.</div>';
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
    // confirmBulkDelete's own copy talks about "items"/a generic noun; Telegram's
    // deletion is instead "for everyone" (revoke: true below), which matters enough
    // to say explicitly rather than reuse the generic prompt text.
    if (!(await confirmBulkDelete(selected.length, "messages for everyone"))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;

    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController);

    const BATCH_SIZE = 100;
    let deletedCount = 0;
    const failedChunks = [];
    let cancelledEarly = false;

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
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: selected.length, done: 0 } });
      for (let i = 0; i < selected.length; i += BATCH_SIZE) {
        if (cancelController.cancelled) { cancelledEarly = true; break; }
        const chunk = selected.slice(i, i + BATCH_SIZE).map(m => m.id);

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

        progressText.textContent = `Deleted ${deletedCount} of ${selected.length}`;
        const processedSoFar = deletedCount + failedChunks.reduce((sum, c) => sum + c.count, 0);
        await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: selected.length, done: processedSoFar } });
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);

      // Whether the run finished, partly failed, or was cancelled, the whole
      // scanned set is now stale (some of it may have just been deleted) --
      // a rescan is required before another delete, same as the failure path
      // below always required.
      currentResults = [];
      resultsCount.textContent = "0 items found";

      if (cancelledEarly) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${selected.length} processed.`, [String(deletedCount), String(selected.length)]);
        statusText.style.color = "#ef4444";
        itemList.innerHTML = '<div class="empty-state">Deletion finished.</div>';
      } else if (failedChunks.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
        itemList.innerHTML = '<div class="empty-state">Deletion finished.</div>';
      } else {
        const failedCount = failedChunks.reduce((sum, c) => sum + c.count, 0);
        statusText.textContent = `Deletion finished: ${deletedCount} deleted, ${failedCount} failed.`;
        statusText.style.color = "#ef4444";
        itemList.innerHTML = '<div class="empty-state">Deletion finished (see error summary).</div>';
        console.warn("Telegram delete chunk failures:", failedChunks);
        await showAlert(
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
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${selected.length} messages were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      resetCancelButton(cancelBtn);
    }
  });
});
