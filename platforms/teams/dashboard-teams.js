document.addEventListener('DOMContentLoaded', async () => {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['teams_token']),
    chrome.storage.local.get(['teams_base_url'])
  ]);
  if (!sessionData.teams_token || !localData.teams_base_url) {
    await showAlert("Not linked to MS Teams. Please open the extension popup first.");
    window.close();
    return;
  }

  const { teams_base_url: baseUrl } = localData;
  const data = sessionData;

  // The captured Bearer token is a JWT whose `oid` (or `sub`) claim is the signed-in
  // user's own AAD object id. Teams' internal chatsvc API embeds that same GUID inside
  // a message's `from` MRI string (e.g. "8:orgid:<oid>") regardless of exact MRI shape,
  // so matching on the GUID substring is more robust than assuming a fixed prefix.
  // This is the only reliable way to tell "my message" from "someone else's message" --
  // `imdisplayname` is present on every message regardless of sender and must never be
  // used as an ownership signal.
  function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return atob(str);
  }

  function getOwnUserId(bearerToken) {
    try {
      const jwt = bearerToken.replace(/^Bearer\s+/i, '');
      const payload = jwt.split('.')[1];
      if (!payload) return null;
      const claims = JSON.parse(base64UrlDecode(payload));
      return claims.oid || claims.sub || null;
    } catch {
      return null;
    }
  }

  const ownUserId = getOwnUserId(data.teams_token);

  // Cached rather than re-read from chrome.storage.local on every apiFetch call
  // (every scan page, up to MAX_PAGES, and every delete item) -- the token rarely
  // changes mid-session, and the 401 handler below already re-reads storage and
  // updates this cache on the rare occasion it actually has expired.
  let cachedToken = data.teams_token;

  const loadChatsBtn = document.getElementById('load-chats-btn');
  const chatSelect = document.getElementById('chat-select');
  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  const DELETE_PROGRESS_KEY = 'teams_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);

  let currentResults = [];

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-teams.html.

  async function apiFetch(endpoint, method = 'GET') {
    const token = cachedToken;

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
      const refreshedData = await chrome.storage.session.get(['teams_token']);
      const refreshedToken = refreshedData.teams_token;
      if (refreshedToken && refreshedToken !== token) {
        cachedToken = refreshedToken;
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
      if (response.status === 401) {
        const err = new Error("Your Teams session appears to have expired. Reopen teams.microsoft.com, make sure you're signed in, then click the Erasechat toolbar icon again to reconnect.");
        err.expiredAuth = true;
        throw err;
      }
      throw new Error(`API Error ${response.status}`);
    }

    // DELETE requests may return empty body
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a partial/cancelled/selective delete leaves some scanned items
  // un-deleted -- those stay visible with fresh checkboxes, not discarded).
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
      timeDiv.textContent = new Date(msg.time).toLocaleString();

      const textDiv = document.createElement('div');
      textDiv.textContent = msg.text;

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, msg, rowCheckboxes);
      itemList.appendChild(div);
    });
    wireSelectAll(selectAllBox, items, rowCheckboxes);
  }

  loadChatsBtn.addEventListener('click', async () => {
    loadChatsBtn.disabled = true;
    statusText.textContent = "Loading chats...";
    try {
      // Fetch recent conversations
      const res = await apiFetch('/v1/users/ME/conversations');
      const conversations = res.conversations || [];

      chatSelect.innerHTML = '';
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.textContent = t("teamsDashSelectChatPlaceholder", "-- Select a Chat --");
      chatSelect.appendChild(placeholderOpt);
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
      await showAlert("Failed to load chats: " + err.message);
      statusText.textContent = "Error";
    } finally {
      loadChatsBtn.disabled = false;
    }
  });

  scanBtn.addEventListener('click', async () => {
    const chatId = chatSelect.value;
    const filterText = filterInput.value.trim().toLowerCase();

    if (!chatId) { await showAlert("Please select a chat first."); return; }
    if (!ownUserId) {
      await showAlert("Could not determine your own Teams identity from the captured token, so scanning was refused for safety (this would otherwise risk surfacing other participants' messages). Try reconnecting to Teams.");
      return;
    }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    renderEmptyState(itemList, "Scanning messages...");
    currentResults = [];

    try {
      // Fetch recent messages in chat, capped at MAX_PAGES (like the mastodon/reddit/x
      // dashboards) so a long-lived chat can't be scanned in full on every click.
      let endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?pageSize=100`;
      let pageCount = 0;
      let truncated = false;
      const MAX_PAGES = 20; // 100 messages per page * 20 = 2000 messages per scan

      while (endpoint && pageCount < MAX_PAGES) {
        const res = await apiFetch(endpoint);
        const messages = res.messages || [];

        for (const msg of messages) {
          if (msg.from && msg.from.includes(ownUserId) && !msg.deleted) {
            // A media-only message (image/file share) has an EMPTY `content` of its
            // own -- but a message that's pure markup (e.g. a bare inline image tag)
            // has a TRUTHY `content` that strips down to nothing, so the check must
            // happen on the stripped text, not the raw content (matching mastodon's
            // equivalent check on `plainText`, not raw `content`). Without this
            // fallback such messages never enter currentResults and can never be
            // selected for deletion here.
            const strippedContent = msg.content ? msg.content.replace(/<[^>]+>/g, '') : '';
            const text = strippedContent || '[Media only]';

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
        pageCount++;
        truncated = pageCount >= MAX_PAGES && !!endpoint;
        if (endpoint) await delay(1000); // 1s delay for pagination
      }

      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: "older messages may exist"
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        renderEmptyState(itemList, "No matching messages found in this chat.");
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
    const chatId = chatSelect.value;
    const selected = getSelectedItems(currentResults);
    if (selected.length === 0) {
      await showAlert(t("dashNoItemsSelected", "No items are selected. Check at least one item, or use Select All, before deleting."));
      return;
    }
    if (!(await confirmBulkDelete(selected.length, "messages"))) return;

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
      // handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: totalCount, done: 0 } });
      let expiredAuth = false;
      for (const msg of selected) {
        if (cancelController.cancelled) break;
        processedItems.push(msg);
        try {
          // DELETE /v1/users/ME/conversations/{chatId}/messages/{messageId}
          const endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages/${msg.id}`;
          await apiFetch(endpoint, 'DELETE');
          deletedCount++;
        } catch (err) {
          failures.push({ id: msg.id, message: err.message });
          // An expired token fails every remaining item identically -- stop
          // immediately with one clear reconnect message instead of retrying each
          // remaining item at the full pacing delay only to fail the same way.
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
        // Strict 2.5 second delay to avoid enterprise security alarms / rate limits
        await delay(2500);
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
        statusText.textContent = "Session expired — reconnect required.";
        statusText.style.color = "#ef4444";
        await showAlert(`Stopped: your Teams session appears to have expired. ${deletedCount} of ${totalCount} messages were deleted before this happened. Reopen teams.microsoft.com, sign in, then click the Erasechat toolbar icon again to reconnect and finish.`);
      } else if (cancelController.cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [String(deletedCount), String(totalCount)]);
        statusText.style.color = "#ef4444";
      } else if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
      } else {
        statusText.textContent = `Deletion finished with ${failures.length} failure(s) out of ${totalCount}.`;
        statusText.style.color = "#ef4444";
        console.warn("Teams delete failures:", failures);
      }
      if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
    } catch (err) {
      console.error("Teams delete loop stopped unexpectedly:", err);
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${totalCount} messages were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
