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

// Pure: given the parsed JSON body of a DeleteTweet GraphQL mutation response,
// returns an error message string if the body signals the delete did NOT
// actually happen (a GraphQL-level `errors` array, or a missing/null
// `data.delete_tweet` result -- X's own real success shape), or null if the
// body looks like a genuine success. apiFetch() only throws on a non-2xx HTTP
// status, so this is what actually catches a body-level failure riding along
// on an HTTP 200 -- the most important finding of the audit that added this
// check. Extracted to module scope (mirroring extractTweetsFromEntries above)
// so it's unit tested directly. See tests/x-dashboard.test.js.
function deleteTweetFailureFromResult(result) {
  if (result && Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.map(e => (e && e.message) || JSON.stringify(e)).join('; ');
  }
  if (!result || !result.data || !result.data.delete_tweet) {
    return "X did not confirm the tweet was deleted (unexpected response).";
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { resolveXScriptUrl, extractTweetsFromEntries, deleteTweetFailureFromResult };

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

  // let, not const: if the user reconnects to a different X account from the
  // popup while this dashboard tab is already open, connect-x.js overwrites
  // x_csrf/x_username in storage, but nothing reloads this tab. Without picking
  // that change up live (see the storage.onChanged listener below), this tab
  // would keep sending the OLD account's ct0 alongside the NEW account's cookie
  // jar -- X's CSRF check fails that mismatched pair, so it's not a wrong-account
  // deletion risk, but it does surface a confusing "session expired" error right
  // after the user just successfully reconnected.
  let ct0 = sessionData.x_csrf;
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
  }

  // The username field above is free text, not locked to the authenticated
  // account -- a user can type a different handle and scan (harmless, read-only)
  // or, without this guard, attempt to DELETE a stranger's tweets. `x_username`
  // is the handle actually resolved from the authenticated session at connect
  // time (connect-x.js's resolveXUsername), independent of whatever currently
  // sits in the input; compare the two and keep Delete disabled whenever they
  // don't match. If x_username was never resolved (older connection, or the
  // lookup failed at connect time -- see resolveXUsername) there's nothing to
  // compare against, so this can't block anything: same as before this existed.
  let authenticatedUsername = localData.x_username || null;
  const usernameWarningEl = document.getElementById('username-mismatch-warning');
  const connectedAsEl = document.getElementById('connected-as');

  function renderConnectedAs() {
    if (!connectedAsEl) return;
    connectedAsEl.textContent = authenticatedUsername
      ? t("dashConnectedAs", `(Connected: @${authenticatedUsername})`, [`@${authenticatedUsername}`])
      : '';
  }
  renderConnectedAs();

  // Keep ct0/authenticatedUsername in sync with a reconnect that happens while
  // this tab stays open, instead of only reading them once at load (see the
  // `let ct0` comment above).
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes.x_csrf) {
      ct0 = changes.x_csrf.newValue;
    }
    if (areaName === 'local' && changes.x_username) {
      authenticatedUsername = changes.x_username.newValue || null;
      renderConnectedAs();
      updateUsernameMismatchState();
    }
  });

  function isUsernameMismatched() {
    if (!authenticatedUsername) return false;
    const typed = usernameInput.value.trim().replace('@', '').toLowerCase();
    return !!typed && typed !== authenticatedUsername.toLowerCase();
  }

  // Called on every username edit, and again right before Delete is armed, so
  // the warning/disabled state can never go stale relative to the input.
  function updateUsernameMismatchState() {
    const mismatched = isUsernameMismatched();
    if (usernameWarningEl) {
      usernameWarningEl.textContent = mismatched
        ? t("xDashUsernameMismatch",
            `This isn't the connected account (@${authenticatedUsername}). You can still scan, but deletion is disabled until it matches.`,
            [`@${authenticatedUsername}`])
        : '';
      usernameWarningEl.classList.toggle('hidden', !mismatched);
    }
    if (mismatched) {
      deleteBtn.disabled = true;
    } else if (currentResults.length > 0) {
      deleteBtn.disabled = false;
    }
    return mismatched;
  }
  usernameInput.addEventListener('input', updateUsernameMismatchState);

  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  const DELETE_PROGRESS_KEY = 'x_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  let currentResults = [];
  updateUsernameMismatchState(); // reflect the pre-filled value now that currentResults exists (always matches at this point, but keeps this the single source of truth)
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
      //
      // Known imprecision (audit Fix 4): a 403 here could in principle also be
      // X rejecting an attempt to delete a tweet that isn't the authenticated
      // account's (relevant to the username-mismatch guard below), which isn't
      // really an expired session. X's own response body gives no reliable,
      // documented way to tell the two apart at this status-code layer, so this
      // is left as-is rather than guessing at a distinction the API doesn't
      // actually expose. In practice this matters less than it looks: a GraphQL
      // permission rejection from DeleteTweet more commonly comes back as HTTP
      // 200 with a body-level `errors` array, which is now caught as an ordinary
      // per-item failure by the check in deleteItem below, not misrouted through
      // this expiredAuth branch at all.
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

  // Every operation the dashboard actually calls (see apiFetch/resolveUserId) --
  // extraction isn't "done" until all three have a live queryId, not just any one.
  const REQUIRED_QUERY_OPERATIONS = ['UserTweets', 'DeleteTweet', 'UserByScreenName'];

  async function extractQueryIds() {
    try {
      statusText.textContent = "Fetching latest API signatures...";
      const htmlRes = await fetchWithRetry("https://x.com/", { credentials: 'include' });
      const html = await htmlRes.text();
      // Look for the main JS bundle which usually contains the query IDs
      const scriptMatches = [...html.matchAll(/<script[^>]+src="([^"]+main\.[a-z0-9]+\.js)"/g)];

      // Independent bundle fetches -- run them concurrently instead of one at a
      // time, since each is a full (often multi-MB) download+parse.
      const foundOperations = new Set();
      await Promise.all(scriptMatches.map(async (m) => {
        const jsRes = await fetchWithRetry(resolveXScriptUrl(m[1]), { credentials: 'include' });
        const js = await jsRes.text();
        const matches = [...js.matchAll(/queryId:"([^"]+)",operationName:"(UserTweets|DeleteTweet|UserByScreenName)"/g)];
        for (const match of matches) {
          queryIds[match[2]] = match[1];
          foundOperations.add(match[2]);
        }
      }));
      // Only mark extraction "done" once ALL required signatures were found, not
      // just any one of them. X restructuring its bundle (or these regexes going
      // stale) still resolves this fetch without throwing, and a PARTIAL match
      // (e.g. UserTweets/UserByScreenName found but DeleteTweet's regex stops
      // matching) would otherwise still flip queryIdsExtracted permanently true,
      // stranding that one operation on its possibly-wrong hardcoded default
      // with no automatic retry on any future scan.
      const missing = REQUIRED_QUERY_OPERATIONS.filter(op => !foundOperations.has(op));
      if (missing.length === 0) {
        queryIdsExtracted = true;
        queryIdsStale = false;
      } else {
        console.warn(`extractQueryIds: missing query ID(s) for ${missing.join(", ")} in the fetched bundle(s) -- will retry on next scan.`);
      }
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
        // Scanning a mismatched username is allowed (read-only), but Delete must
        // stay disabled until the username field matches the authenticated
        // account again -- see updateUsernameMismatchState.
        deleteBtn.disabled = isUsernameMismatched();
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
    // Defense in depth: the button is already kept disabled while mismatched
    // (see updateUsernameMismatchState), but re-check here too rather than
    // trust only a disabled attribute to have prevented this click from firing.
    if (updateUsernameMismatchState()) {
      await showAlert(t("xDashUsernameMismatchBlocked",
        `Can't delete: "@${usernameInput.value.trim().replace('@', '')}" doesn't match the connected account (@${authenticatedUsername}). Fix the username field, or reconnect from the extension popup if you've switched accounts.`,
        [usernameInput.value.trim().replace('@', ''), authenticatedUsername]));
      return;
    }
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

            const result = await apiFetch(url, 'POST', {
              variables,
              queryId
            });

            // apiFetch only throws on a non-2xx HTTP status; a GraphQL mutation
            // can still come back HTTP 200 with a body-level failure -- the most
            // important finding of the audit that prompted this fix. See
            // deleteTweetFailureFromResult above for what counts as a real success.
            const failureMessage = deleteTweetFailureFromResult(result);
            if (failureMessage) throw new Error(failureMessage);
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
      const { succeededItems, expiredAuth, rateLimited, cancelled } = result;
      const staleQueryIdSuspected = failures.some(f => f.error && f.error.staleQueryId);

      // Anything scanned but not selected, anything selected but never reached
      // because a cancel broke the loop early, AND anything that was attempted
      // but failed to delete all stay visible -- only items actually deleted are
      // removed from view, so a failed delete never looks indistinguishable from
      // a successful one. A Set lookup here (rather than Array#includes) keeps
      // this O(n) instead of O(n^2) -- succeededItems is typically most/all of
      // currentResults on a normal run.
      const succeededSet = new Set(succeededItems);
      currentResults = currentResults.filter(item => !succeededSet.has(item));
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
      } else if (rateLimited) {
        statusText.textContent = "Rate limited by X — stopped early.";
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', `Delete stopped: repeated rate limiting (429) from X (${deletedCount}/${totalCount} deleted).`, 'error');
        await showAlert(`Stopped: X rate-limited several delete requests in a row. ${deletedCount} of ${totalCount} tweets were deleted before this happened. Wait a while, then try again.`);
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
      console.error("X delete loop stopped unexpectedly:", err);
      logActivity('sc-activity-log', `Delete stopped unexpectedly: ${err.message}`, 'error');
      await showAlert(`Deletion stopped unexpectedly: ${err.message}\n\n${progress.deletedCount} of ${totalCount} tweets were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0 || isUsernameMismatched();
      resetCancelButton(cancelBtn);
    }
  });
});
