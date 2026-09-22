import { TelegramClient, Api, errors, extensions } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { FloodWaitCancelledError, cancelableDelay } from './telegram-utils.js';

let client;
let currentResults = [];

// delay: see platforms/shared/dashboard-fetch-utils.js, loaded before this bundle
// by dashboard-telegram.html -- used in place of a local sleep()/setTimeout
// helper so pacing logic isn't duplicated per platform.
//
// FloodWaitCancelledError/cancelableDelay: see telegram-utils.js -- split out into
// their own dependency-free module so they're unit-tested directly (see
// tests/telegram-utils.test.js) rather than only reachable through a live client.

// Retries an invoke() call when Telegram signals a flood-wait, pausing for the
// duration the server asked for instead of letting the whole batch throw. When
// a cancelController is supplied (the delete path; scanning has no Cancel
// button today) a Cancel click during that wait is honored immediately rather
// than only being noticed once this chunk's retries are exhausted.
async function invokeWithFloodWait(invokeFn, { maxRetries = 5, onWait, cancelController } = {}) {
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
      const cancelled = await cancelableDelay(waitMs, cancelController);
      if (cancelled) throw new FloodWaitCancelledError();
    }
  }
}

// An invalid/revoked/expired session (session logged out elsewhere, account
// deactivated, auth key unregistered, etc.) surfaces from teleproto as an
// errors.UnauthorizedError subclass (AuthKeyUnregisteredError,
// AuthKeyInvalidError, SessionExpiredError, SessionRevokedError,
// UserDeactivatedError/-BanError all extend it, per RPCBaseErrors.js), so
// checking the base class covers every variant without enumerating each one;
// the errorMessage regex is a defensive fallback should a future teleproto
// version surface the same condition as a plain error. Every remaining chunk
// would fail identically, so this is Telegram's equivalent of Reddit/Mastodon/
// Teams/X's `expiredAuth` fail-fast.
function isTelegramAuthError(err) {
  return err instanceof errors.UnauthorizedError ||
    /AUTH_KEY_(UNREGISTERED|INVALID|PERM_EMPTY)|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED/i.test(
      (err && (err.errorMessage || err.message)) || ''
    );
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

  // reportInterruptedDelete: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this bundle by dashboard-telegram.html -- this marker only informs the
  // next session that a delete was interrupted; it does not resume the delete
  // itself, since a fresh scan is required to see current state.
  const DELETE_PROGRESS_KEY = 'telegram_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

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
    renderEmptyState(itemList, "Scanning messages...");
    currentResults = [];
    logActivity('sc-activity-log', `Scan started (target: ${peer}${filterText ? `, filter: "${filterText}"` : ''}).`);

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
        logActivity('sc-activity-log', `Scan complete: ${currentResults.length} message(s) found${truncated ? ' (truncated -- more may exist)' : ''}.`);
      } else {
        renderEmptyState(itemList, "No messages matched your criteria. Try widening your text filter, or check the target chat.");
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', 'Scan complete: 0 messages found.');
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
    logActivity('sc-activity-log', `Delete started: ${selected.length} message(s) selected.`);

    const BATCH_SIZE = 100;
    let deletedCount = 0;
    const failedChunks = [];
    let cancelledEarly = false;
    let expiredAuth = false;

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
      // A transient failure here (network blip, swallowed flood-wait) must NOT be
      // treated the same as "genuinely isn't a channel" -- doing so would silently
      // call messages.DeleteMessages against a channel-space ID, which Telegram
      // accepts without error but deletes nothing, reporting false success. Retry
      // a few times with a short backoff (mirroring invokeWithFloodWait's
      // retry-delay pattern above) before giving up.
      let channelEntity = null;
      let entityResolutionFailed = false;
      {
        const ENTITY_RESOLVE_ATTEMPTS = 3;
        let lastErr = null;
        let resolved = false;
        for (let attempt = 0; attempt < ENTITY_RESOLVE_ATTEMPTS; attempt++) {
          try {
            const entity = await client.getEntity(lastPeer || 'me');
            if (entity && entity.className === 'Channel') {
              channelEntity = entity;
            }
            resolved = true;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < ENTITY_RESOLVE_ATTEMPTS - 1) {
              const cancelled = await cancelableDelay(500 * (attempt + 1), cancelController);
              if (cancelled) break;
            }
          }
        }
        if (!resolved) {
          console.warn("Could not resolve Telegram peer entity after retries; skipping delete to avoid a false success.", lastErr);
          entityResolutionFailed = true;
        }
      }

      // The inner per-chunk try/catch below isolates one chunk's failure from
      // the rest of the batch. This outer try/finally is separate: it guards
      // the chrome.storage.local calls (progress marker) and everything else in
      // this handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: selected.length, done: 0 } });
      if (cancelController.cancelled) {
        // A Cancel click during the entity-resolution backoff above is a cancel,
        // not an unverifiable chat type -- don't mislabel it.
        cancelledEarly = true;
      } else if (entityResolutionFailed) {
        // Could not confirm whether this peer is a channel/supergroup (needing
        // channels.DeleteMessages) or not (needing messages.DeleteMessages) --
        // guessing wrong silently no-ops against a real channel while reporting
        // success. Fail the whole selection closed instead of guessing.
        failedChunks.push({
          count: selected.length,
          message: "Could not verify this chat type — skipped to avoid a false success.",
        });
        progressText.textContent = "Could not verify this chat type — skipped to avoid a false success.";
        logActivity('sc-activity-log', `Delete skipped: could not verify chat type for "${lastPeer}" after retries — skipped to avoid a false success (0/${selected.length} processed).`, 'error');
      }
      for (let i = 0; !entityResolutionFailed && i < selected.length; i += BATCH_SIZE) {
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
              cancelController,
              onWait: (seconds, attempt) => {
                progressText.textContent = `Rate limited by Telegram — waiting ${seconds}s (retry ${attempt})...`;
              },
            }
          );
          // messages.AffectedMessages/channels.AffectedMessages (both call's response
          // type) only carry `pts`/`ptsCount` -- PTS event-log bookkeeping, not a
          // per-ID or even a reliable per-count confirmation of which/how many
          // messages were actually deleted. Not throwing is the only signal MTProto
          // gives here, so this count is "accepted by Telegram", not independently
          // verified -- see the softened wording below where this is reported.
          deletedCount += chunk.length;
        } catch (err) {
          if (err instanceof FloodWaitCancelledError) {
            cancelledEarly = true;
            break;
          }
          failedChunks.push({ count: chunk.length, message: err.message });
          // A revoked/expired session fails every remaining chunk identically --
          // stop immediately with one clear reconnect message instead of
          // retrying each remaining chunk only to fail the same way (matches
          // Reddit/Mastodon/Teams/X's expiredAuth fail-fast).
          if (isTelegramAuthError(err)) {
            expiredAuth = true;
          }
        }

        const failedSoFar = failedChunks.reduce((sum, c) => sum + c.count, 0);
        const processedSoFar = deletedCount + failedSoFar;
        progressText.textContent = failedSoFar > 0
          ? `Processed ${processedSoFar} of ${selected.length} (${deletedCount} deleted, ${failedSoFar} failed)`
          : `Deleted ${deletedCount} of ${selected.length}`;
        await maybeSaveDeleteProgress(DELETE_PROGRESS_KEY, processedSoFar, selected.length);

        if (expiredAuth) break;
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);

      // Whether the run finished, partly failed, or was cancelled, the whole
      // scanned set is now stale (some of it may have just been deleted) --
      // a rescan is required before another delete, same as the failure path
      // below always required.
      currentResults = [];
      resultsCount.textContent = "0 items found";

      if (expiredAuth) {
        statusText.textContent = "Session invalid — reconnect required.";
        statusText.style.color = "#ef4444";
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete stopped: session invalid (${deletedCount}/${selected.length} deleted).`, 'error');
        await showAlert(`Stopped: your Telegram session appears to be invalid or revoked. ${deletedCount} of ${selected.length} messages were deleted before this happened. Reconnect from the extension popup to finish.`);
      } else if (cancelledEarly) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${selected.length} processed.`, [String(deletedCount), String(selected.length)]);
        statusText.style.color = "#ef4444";
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete cancelled: ${deletedCount}/${selected.length} processed.`, 'warn');
      } else if (failedChunks.length === 0) {
        // Telegram's delete calls confirm nothing more specific than "didn't throw"
        // (see the comment above `deletedCount += chunk.length`) -- worded as
        // "requests completed" rather than an unqualified "N deleted" so this
        // doesn't overstate a per-message-verified count.
        statusText.textContent = "Deletion requests completed!";
        statusText.style.color = "#10b981";
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete requests completed: ${deletedCount}/${selected.length} accepted by Telegram.`);
      } else {
        const failedCount = failedChunks.reduce((sum, c) => sum + c.count, 0);
        statusText.textContent = `Deletion finished: ${deletedCount} deleted, ${failedCount} failed.`;
        statusText.style.color = "#ef4444";
        renderEmptyState(itemList, "Deletion finished (see error summary).");
        console.warn("Telegram delete chunk failures:", failedChunks);
        logActivity('sc-activity-log', `Delete finished: ${deletedCount} deleted, ${failedCount} failed out of ${deletedCount + failedCount}.`, 'warn');
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
      logActivity('sc-activity-log', `Delete stopped unexpectedly: ${err.message}`, 'error');
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${selected.length} messages were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      resetCancelButton(cancelBtn);
    }
  });
});
