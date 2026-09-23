// Decodes a JWT's payload (no signature verification -- this only ever reads claims
// from a token we already trust, captured passively from the user's own Teams
// traffic, never used to authenticate anything). Kept at module scope, with the two
// functions below, so both are unit-testable without a DOM -- see
// tests/teams-dashboard.test.js.
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

// The captured Bearer token is a JWT whose `oid` (or `sub`) claim is the signed-in
// user's own AAD object id. Teams' internal chatsvc API embeds that same GUID inside
// a message's `from` MRI string (e.g. "8:orgid:<oid>") regardless of exact MRI shape,
// so matching on the GUID substring is more robust than assuming a fixed prefix.
// This is the only reliable way to tell "my message" from "someone else's message" --
// `imdisplayname` is present on every message regardless of sender and must never be
// used as an ownership signal.
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

// Purely cosmetic "Connected as ..." label (unlike getOwnUserId, which is
// security-relevant -- the "is this my message" check). A missing/unusual claim
// here just leaves the label blank; it never affects what gets deleted. Falls
// back through the AAD claims most likely to carry a human-readable identity.
function getOwnDisplayIdentity(bearerToken) {
  try {
    const jwt = bearerToken.replace(/^Bearer\s+/i, '');
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(base64UrlDecode(payload));
    return claims.preferred_username || claims.upn || claims.unique_name || claims.name || null;
  } catch {
    return null;
  }
}

// True when a freshly-refreshed token (see apiFetch's 401 retry path below) decodes
// to a DIFFERENT own-identity than the one the current scan/delete run started with.
// Only compares two actual, decoded ids -- a refreshed token that fails to decode at
// all (null) is a decode failure, not evidence of a different identity, and is left
// for the normal expired-auth handling to deal with instead of being misreported as
// an identity change. Module-scope and pure so it's unit-testable without a DOM --
// see tests/teams-dashboard.test.js.
function identityChangedMidRun(originalOwnUserId, refreshedOwnUserId) {
  return !!(originalOwnUserId && refreshedOwnUserId && originalOwnUserId !== refreshedOwnUserId);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getOwnUserId, getOwnDisplayIdentity, identityChangedMidRun };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
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

  // let, not const: the 401-retry-refresh path in apiFetch below can replace
  // cachedToken with a token captured from a DIFFERENT Teams identity (see
  // teams-webrequest.js -- its listener is always-on and passively captures a
  // Bearer token from ANY teams.microsoft.com tab, not just the one this dashboard
  // was opened for), so both of these are recomputed from the new token whenever
  // that happens, and compared against the identity the current run started with.
  let ownUserId = getOwnUserId(data.teams_token);
  let ownDisplayIdentity = getOwnDisplayIdentity(data.teams_token);
  const connectedAsEl = document.getElementById('connected-as');
  if (connectedAsEl && ownDisplayIdentity) {
    connectedAsEl.textContent = t("dashConnectedAs", `(Connected: ${ownDisplayIdentity})`, [ownDisplayIdentity]);
  }

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
  initActivityLog('sc-activity-log');

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
        const refreshedOwnUserId = getOwnUserId(refreshedToken);
        // The newly captured token may belong to a completely different signed-in
        // Teams identity than the one this scan/delete run started with (see
        // teams-webrequest.js's listener). Continuing would mean filtering "my
        // messages" against the OLD identity while issuing API calls with the NEW
        // token's credentials -- silently acting on whichever account happens to
        // own the just-captured token. Hard-abort instead, the same way an
        // actually-expired session hard-aborts below.
        if (identityChangedMidRun(ownUserId, refreshedOwnUserId)) {
          const err = new Error("Your signed-in Teams identity changed during this session — stopping to avoid acting on the wrong account. Please reconnect and try again.");
          // Not literally an expired-auth failure, but reused so a running delete
          // loop stops immediately instead of retrying every remaining item the
          // same doomed way -- runDeleteLoop (dashboard-fetch-utils.js) only
          // fast-stops on `err.expiredAuth`/`err.staleQueryId`, and this condition
          // is just as systemic and just as unrecoverable mid-run. `identityMismatch`
          // is what the delete handler below checks to show this message instead of
          // the generic session-expired one.
          err.expiredAuth = true;
          err.identityMismatch = true;
          throw err;
        }

        cachedToken = refreshedToken;
        ownUserId = refreshedOwnUserId;
        ownDisplayIdentity = getOwnDisplayIdentity(refreshedToken);
        if (connectedAsEl) {
          connectedAsEl.textContent = ownDisplayIdentity
            ? t("dashConnectedAs", `(Connected: ${ownDisplayIdentity})`, [ownDisplayIdentity])
            : '';
        }
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
        throw new Error("API Error 403: Couldn't delete this message. This can happen for a few different reasons -- a personal Microsoft account, an organization messaging policy that doesn't allow deleting sent messages, or the message being past Teams' own edit/delete window. A work/school account with a policy that permits message deletion is required for the first two.");
      }
      if (response.status === 401) {
        const err = new Error("Your Teams session appears to have expired. Reopen teams.microsoft.com, make sure you're signed in, then click the Erasechat toolbar icon again to reconnect.");
        err.expiredAuth = true;
        throw err;
      }
      const err = new Error(`API Error ${response.status}`);
      err.status = response.status;
      throw err;
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
    logActivity('sc-activity-log', `Scan started (chat: ${chatId}${filterText ? `, filter: "${filterText}"` : ''}).`);

    try {
      // Fetch recent messages in chat, capped at MAX_PAGES (like the mastodon/reddit/x
      // dashboards) so a long-lived chat can't be scanned in full on every click.
      let endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?pageSize=100`;
      let pageCount = 0;
      let truncated = false;
      const MAX_PAGES = 20; // 100 messages per page * 20 = 2000 messages per scan
      // Defensive de-dup: without this, a repeated/overlapping `nextLink` page (new
      // activity shifting the listing mid-scan) shows the same message twice,
      // inflating "N items found" and queuing a redundant delete request for it
      // later. Mirrors dashboard-reddit.js's/dashboard-x.js's seenIds guard.
      const seenIds = new Set();

      while (endpoint && pageCount < MAX_PAGES) {
        const res = await apiFetch(endpoint);
        const messages = res.messages || [];

        for (const msg of messages) {
          if (seenIds.has(msg.id)) continue;
          seenIds.add(msg.id);
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
        logActivity('sc-activity-log', `Scan complete: ${currentResults.length} message(s) found${truncated ? ' (truncated -- more may exist)' : ''}.`);
      } else {
        renderEmptyState(itemList, "No matching messages found in this chat. Try widening your text filter, or pick a different chat.");
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
    let failures = [];
    logActivity('sc-activity-log', `Delete started: ${totalCount} message(s) selected.`);
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        // Strict 2.5 second delay to avoid enterprise security alarms / rate limits
        postItemDelayMs: 2500,
        deleteItem: async (msg) => {
          // DELETE /v1/users/ME/conversations/{chatId}/messages/{messageId}
          const endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages/${msg.id}`;
          await apiFetch(endpoint, 'DELETE');
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
        // The failure that triggered the expiredAuth fast-stop is always the last
        // one pushed (runDeleteLoop breaks right after pushing it) -- inspect its
        // original error to tell an actually-expired session apart from an
        // identity-changed-mid-run abort (see apiFetch's 401 retry path above),
        // since both use the same expiredAuth fast-stop but need different wording.
        const lastFailureErr = failures.length > 0 ? failures[failures.length - 1].error : null;
        if (lastFailureErr && lastFailureErr.identityMismatch) {
          statusText.textContent = "Teams identity changed — reconnect required.";
          statusText.style.color = "#ef4444";
          logActivity('sc-activity-log', `Delete stopped: signed-in Teams identity changed mid-session (${deletedCount}/${totalCount} deleted).`, 'error');
          await showAlert(`Stopped: your signed-in Teams identity changed during this session — stopping to avoid acting on the wrong account. ${deletedCount} of ${totalCount} messages were deleted before this happened. Please reconnect and try again.`);
        } else {
          statusText.textContent = "Session expired — reconnect required.";
          statusText.style.color = "#ef4444";
          logActivity('sc-activity-log', `Delete stopped: session expired (${deletedCount}/${totalCount} deleted).`, 'error');
          await showAlert(`Stopped: your Teams session appears to have expired. ${deletedCount} of ${totalCount} messages were deleted before this happened. Reopen teams.microsoft.com, sign in, then click the Erasechat toolbar icon again to reconnect and finish.`);
        }
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
        console.warn("Teams delete failures:", failures);
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
      console.error("Teams delete loop stopped unexpectedly:", err);
      logActivity('sc-activity-log', `Delete stopped unexpectedly: ${err.message}`, 'error');
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${progress.deletedCount} of ${totalCount} messages were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
