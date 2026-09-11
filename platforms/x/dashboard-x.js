function resolveXScriptUrl(src) {
  return new URL(src, 'https://x.com/').href;
}

// Pulls tweets + the next pagination cursor out of one UserTweets timeline page.
// Extracted as a pure-ish helper (its only side effect is recording ids into the
// caller-owned `seenTweetIds` Set) so the cursor-advance and de-dup logic is unit
// testable without a live GraphQL response -- see tests/x-dashboard.test.js.
//
// Returns { tweets, nextCursor }: `nextCursor` is null when the page carried no
// cursor-bottom entry at all -- the caller must stop rather than reuse a stale
// cursor and silently re-request the same page forever (bounded only by
// MAX_PAGES). An entry present but with an empty value is the ordinary "no more
// pages" signal (also treated as "stop"), same as before this fix.
function extractTweetsFromEntries(entries, seenTweetIds, filterText) {
  const tweets = [];
  let nextCursor = null;
  for (const entry of entries) {
    if (entry.entryId.startsWith('tweet-')) {
      const result = entry.itemContent?.tweet_results?.result;
      if (result) {
        const tweetId = result.rest_id;
        // Defensive de-dup: without this, any page that repeats a tweet (the
        // cursor-stuck case this fix closes, or an overlap X's own timeline
        // occasionally returns) would show the same tweet twice in the results
        // and inflate "N items found".
        if (!tweetId || seenTweetIds.has(tweetId)) continue;
        seenTweetIds.add(tweetId);
        const text = result.legacy?.full_text || '';
        const createdAt = result.legacy?.created_at || '';
        if (!filterText || text.toLowerCase().includes(filterText)) {
          tweets.push({ id: tweetId, text, time: createdAt });
        }
      }
    } else if (entry.entryId.startsWith('cursor-bottom')) {
      nextCursor = entry.content?.value || '';
    }
  }
  return { tweets, nextCursor };
}

if (typeof module !== 'undefined') module.exports = { resolveXScriptUrl, extractTweetsFromEntries };

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['x_csrf']),
    chrome.storage.local.get(['x_username'])
  ]);
  if (!sessionData.x_csrf) {
    await showAlert("Not linked to X.com. Please open the extension popup first.");
    window.close();
    return;
  }

  const ct0 = sessionData.x_csrf;
  const BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"; // Standard public X.com web client token

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const usernameInput = document.getElementById('username');
  // Resolved once during connect (see connect-x.js's resolveXUsername) and
  // pre-filled here so the user isn't forced to recall and retype their own
  // handle on every visit -- best-effort: if it wasn't resolved (an older
  // connection, or the lookup failed at connect time), the field is simply left
  // blank for manual entry, same as before this existed.
  if (localData.x_username) {
    usernameInput.value = localData.x_username;
    const connectedAsEl = document.getElementById('connected-as');
    if (connectedAsEl) {
      connectedAsEl.textContent = t("dashConnectedAs", `(Connected: @${localData.x_username})`, [`@${localData.x_username}`]);
    }
  }
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  const DELETE_PROGRESS_KEY = 'x_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  let currentResults = [];
  let userRestId = null;
  // Tracks which screenName userRestId was actually resolved for -- without this,
  // scanning once then editing the username field and scanning again would reuse
  // the FIRST account's userRestId (since it's merely truthy), silently scanning
  // and offering to delete the wrong account's tweets while the input shows the
  // newly-typed name.
  let userRestIdForScreenName = null;

  let queryIds = {
    UserByScreenName: 's70IQxZ5sQ-b40B2gP37Tw',
    UserTweets: 'Q6aAvPw7azHZhmCBjomMeA',
    DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg'
  };
  // Once extractQueryIds() has run successfully this session, the scraped ids stay
  // good until X actually rotates them (signaled by apiFetch's staleQueryId flag) --
  // re-running it on every single Scan click re-downloads and regex-scans x.com's
  // full main JS bundle (often multi-MB) for no reason.
  let queryIdsExtracted = false;
  let queryIdsStale = false;

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-x.html.

  async function apiFetch(url, method = 'GET', body = null) {
    const options = {
      method,
      // Session cookies (auth_token, ct0, etc.) are required for these GraphQL
      // calls to be treated as authenticated; without this they're cross-origin
      // requests from a chrome-extension:// origin and the cookie jar is omitted.
      credentials: 'include',
      headers: {
        'Authorization': `Bearer ${BEARER_TOKEN}`,
        'x-csrf-token': ct0,
        'content-type': 'application/json'
      }
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetchWithRetry(url, options);
    if (!response.ok) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch (_) { /* ignore */ }
      // A 401/403 here means ct0/the session cookie X is riding along is no
      // longer valid (expired, logged out elsewhere, or revoked) -- the same
      // shape Reddit/Mastodon/Teams already fail-fast on. Every remaining
      // selected tweet would fail identically, so flag it the same way their
      // `expiredAuth` does instead of retrying each one at the full pacing delay.
      if (response.status === 401 || response.status === 403) {
        const authErr = new Error("Your X.com session (ct0) appears to be invalid or expired. Reconnect from the extension popup.");
        authErr.status = response.status;
        authErr.expiredAuth = true;
        throw authErr;
      }
      const err = new Error(`API Error ${response.status}`);
      err.status = response.status;
      err.body = bodyText;
      // Twitter/X rotates GraphQL queryIds regularly. When the hardcoded
      // fallback ids (used if extractQueryIds() couldn't scrape live ones) go
      // stale, the API typically responds with a 400/404 whose body mentions
      // the query itself. Flag that so callers can surface a clearer message.
      err.staleQueryId = (response.status === 400 || response.status === 404) &&
        /quer(y|yid)|operationname|does not match|unable to find/i.test(bodyText);
      throw err;
    }
    return response.json();
  }

  async function extractQueryIds() {
    try {
      statusText.textContent = "Fetching latest API signatures...";
      const htmlRes = await fetchWithRetry("https://x.com/", { credentials: 'include' });
      const html = await htmlRes.text();
      // Look for the main JS bundle which usually contains the query IDs
      const scriptMatches = [...html.matchAll(/<script[^>]+src="([^"]+main\.[a-z0-9]+\.js)"/g)];

      // Independent bundle fetches -- run them concurrently instead of one at a
      // time, since each is a full (often multi-MB) download+parse.
      await Promise.all(scriptMatches.map(async (m) => {
        const jsRes = await fetchWithRetry(resolveXScriptUrl(m[1]), { credentials: 'include' });
        const js = await jsRes.text();
        const matches = [...js.matchAll(/queryId:"([^"]+)",operationName:"(UserTweets|DeleteTweet|UserByScreenName)"/g)];
        for (const match of matches) {
          queryIds[match[2]] = match[1];
        }
      }));
      queryIdsExtracted = true;
      queryIdsStale = false;
    } catch(e) {
      console.warn("Failed to extract queryIds dynamically. Falling back to defaults.", e);
    }
  }

  async function resolveUserId(screenName) {
    // Uses the UserByScreenName GraphQL query
    const variables = encodeURIComponent(JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }));
    const features = encodeURIComponent(JSON.stringify({ hidden_profile_likes_enabled: false, responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, subscriptions_verification_info_is_identity_verified_enabled: true, subscriptions_verification_info_verified_since_enabled: true, highlights_tweets_tab_ui_enabled: true, creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true }));
    const url = `https://x.com/i/api/graphql/${queryIds.UserByScreenName}/UserByScreenName?variables=${variables}&features=${features}`;
    
    const res = await apiFetch(url);
    if (res && res.data && res.data.user && res.data.user.result) {
      return res.data.user.result.rest_id;
    }
    throw new Error("Could not find user.");
  }



  // Shared by the scan-success render and the post-delete "remaining items" render
  // (a partial/cancelled/selective delete leaves some scanned items un-deleted --
  // those stay visible with fresh checkboxes rather than being discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    items.forEach(tweet => {
      const div = document.createElement('div');
      div.className = 'post-item';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      timeDiv.textContent = new Date(tweet.time).toLocaleString();

      const textDiv = document.createElement('div');
      textDiv.textContent = tweet.text;

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, tweet, rowCheckboxes);
      itemList.appendChild(div);
    });
    wireSelectAll(selectAllBox, items, rowCheckboxes);
  }

  scanBtn.addEventListener('click', async () => {
    const screenName = usernameInput.value.trim().replace('@', '');
    const filterText = filterInput.value.trim().toLowerCase();
    
    if (!screenName) { await showAlert("Please enter your X.com username."); return; }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    renderEmptyState(itemList, "Scanning tweets...");
    currentResults = [];
    logActivity('sc-activity-log', `Scan started (@${screenName}${filterText ? `, filter: "${filterText}"` : ''}).`);

    try {
      if (!queryIdsExtracted || queryIdsStale) {
        await extractQueryIds();
      }

      if (!userRestId || userRestIdForScreenName !== screenName) {
        userRestId = await resolveUserId(screenName);
        userRestIdForScreenName = screenName;
      }

      let cursor = '';
      let pageCount = 0;
      const seenTweetIds = new Set();
      const MAX_PAGES = 5; // Fetch a reasonable amount to avoid rate limits on scan

      while (pageCount < MAX_PAGES) {
        const variables = {
          userId: userRestId,
          count: 20,
          includePromotedContent: true,
          withQuickPromoteEligibilityTweetFields: true,
          withVoice: true,
          withV2Timeline: true
        };
        if (cursor) variables.cursor = cursor;
        
        const features = {
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          c9s_tweet_anatomy_moderator_badge_enabled: true,
          tweetypie_unmention_optimization_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
          view_counts_everywhere_api_enabled: true,
          longform_notetweets_consumption_enabled: true,
          responsive_web_twitter_article_tweet_consumption_enabled: false,
          tweet_awards_web_tipping_enabled: false,
          freedom_of_speech_not_reach_fetch_enabled: true,
          standardized_nudges_misinfo: true,
          tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
          longform_notetweets_rich_text_read_enabled: true,
          longform_notetweets_inline_media_enabled: true,
          responsive_web_media_download_video_enabled: false,
          responsive_web_enhance_cards_enabled: false
        };

        const url = `https://x.com/i/api/graphql/${queryIds.UserTweets}/UserTweets?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
        
        const res = await apiFetch(url);
        const instructions = res?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];

        const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries || [];
        if (entries.length === 0) break;

        const { tweets, nextCursor } = extractTweetsFromEntries(entries, seenTweetIds, filterText);
        currentResults.push(...tweets);

        // No cursor-bottom entry at all means X gave us nothing to advance
        // on -- continuing would re-request this SAME page (bounded only by
        // MAX_PAGES, not by ever making real progress) instead of stopping like
        // a genuine end-of-timeline does. An entry present but with an empty
        // value is the ordinary "no more pages" signal, same as before.
        if (!nextCursor) break;
        cursor = nextCursor;
        pageCount++;
        await delay(1000); // 1s delay between pagination requests
      }

      // The loop can also exit because pageCount hit MAX_PAGES while X still had
      // more pages (cursor truthy) -- distinguish that from a natural end (no
      // entries, or no cursor) so "N items found" doesn't imply an exhaustive scan.
      const truncated = pageCount >= MAX_PAGES && !!cursor;
      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: "more may exist"
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
        logActivity('sc-activity-log', `Scan complete: ${currentResults.length} tweet(s) found${truncated ? ' (truncated -- more may exist)' : ''}.`);
      } else {
        renderEmptyState(itemList, "No tweets matched your criteria. Try widening your text filter.");
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', 'Scan complete: 0 tweets found.');
      }
    } catch (err) {
      if (err.staleQueryId) {
        queryIdsStale = true;
        await showAlert(
          "Scan failed: " + err.message +
          "\n\nX changed something on their end that this version of the extension doesn't recognize yet. " +
          "Check your browser's extensions page for an update, or try again later -- this isn't something you did wrong."
        );
      } else {
        await showAlert("Scan failed: " + err.message);
      }
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
    if (!(await confirmBulkDelete(selected.length, "tweets"))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion...`;

    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController);

    const totalCount = selected.length;
    let deletedCount = 0;
    let failures = []; // { id, message, error }

    logActivity('sc-activity-log', `Delete started: ${totalCount} tweet(s) selected.`);
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        // strict 2.5 second delay to avoid rate limits and account suspension flags
        postItemDelayMs: 2500,
        deleteItem: async (tweet) => {
          try {
            // GraphQL DeleteTweet mutation
            const variables = { tweet_id: tweet.id, dark_request: false };
            const queryId = queryIds.DeleteTweet;
            const url = `https://x.com/i/api/graphql/${queryId}/DeleteTweet`;

            await apiFetch(url, 'POST', {
              variables,
              queryId
            });
          } catch (err) {
            // Isolate this item's failure so a single bad tweet (400/403/network
            // error) doesn't abort the rest of the batch (runDeleteLoop still
            // records it and decides whether to stop, via err.expiredAuth).
            console.error(`Failed to delete tweet ${tweet.id}:`, err);
            if (err.staleQueryId) queryIdsStale = true;
            throw err;
          }
        }
      });
      deletedCount = result.deletedCount;
      failures = result.failures;
      const { processedItems, expiredAuth, cancelled } = result;
      const staleQueryIdSuspected = failures.some(f => f.error && f.error.staleQueryId);

      // Anything scanned but not selected, plus anything selected but never
      // reached because a cancel broke the loop early, stays visible -- only
      // items actually attempted (succeeded or failed) are removed from view.
      currentResults = currentResults.filter(item => !processedItems.includes(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        itemList.innerHTML = '';
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });

      if (expiredAuth) {
        statusText.textContent = "Session invalid — reconnect required.";
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete stopped: session invalid (${deletedCount}/${totalCount} deleted).`, 'error');
        await showAlert(`Stopped: your X.com session (ct0) appears to be invalid or expired. ${deletedCount} of ${totalCount} tweets were deleted before this happened. Reconnect from the extension popup to finish.`);
      } else if (cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [String(deletedCount), String(totalCount)]);
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete cancelled: ${deletedCount}/${totalCount} processed.`, 'warn');
      } else if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete complete: ${deletedCount}/${totalCount} deleted.`);
      } else {
        statusText.textContent = `Deletion finished: ${deletedCount} deleted, ${failures.length} failed.`;
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, "Deletion finished (see error summary).");

        const shown = failures.slice(0, 10).map(f => `#${f.id}: ${f.message}`).join('\n');
        const more = failures.length > 10 ? `\n...and ${failures.length - 10} more (see console for full list)` : '';
        const hint = staleQueryIdSuspected
          ? "\n\nX changed something on their end that this version of the extension doesn't recognize yet. " +
            "Check your browser's extensions page for an update, or try again later -- this isn't something you did wrong."
          : '';
        logActivity('sc-activity-log', `Delete finished: ${deletedCount} deleted, ${failures.length} failed out of ${totalCount}.`, 'warn');
        await showAlert(`Delete failed for ${failures.length} of ${totalCount} tweet(s):\n\n${shown}${more}${hint}`);
      }
    } catch (err) {
      const progress = err.deleteLoopProgress || { deletedCount };
      console.error("X delete loop stopped unexpectedly:", err);
      logActivity('sc-activity-log', `Delete stopped unexpectedly: ${err.message}`, 'error');
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${progress.deletedCount} of ${totalCount} tweets were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
    }
  });
});
