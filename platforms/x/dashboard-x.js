document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(['x_csrf']);
  if (!data.x_csrf) {
    alert("Not linked to X.com. Please open the extension popup first.");
    window.close();
    return;
  }

  const ct0 = data.x_csrf;
  const BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"; // Standard public X.com web client token

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const usernameInput = document.getElementById('username');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  // See the matching comment in platforms/reddit/dashboard-reddit.js: this marker
  // only informs the next session that a delete was interrupted -- it does not
  // resume the delete itself, since a fresh scan is required to see current state.
  const DELETE_PROGRESS_KEY = 'x_delete_progress';
  const leftover = (await chrome.storage.local.get([DELETE_PROGRESS_KEY]))[DELETE_PROGRESS_KEY];
  if (leftover) {
    statusText.textContent = `A previous deletion was interrupted (${leftover.done} of ${leftover.total} processed). Scan again to see current state.`;
    await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);
  }

  let currentResults = [];
  let userRestId = null;

  let queryIds = {
    UserByScreenName: 's70IQxZ5sQ-b40B2gP37Tw',
    UserTweets: 'Q6aAvPw7azHZhmCBjomMeA',
    DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg'
  };

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

      for (const m of scriptMatches) {
        const jsRes = await fetchWithRetry(m[1], { credentials: 'include' });
        const js = await jsRes.text();
        const matches = [...js.matchAll(/queryId:"([^"]+)",operationName:"(UserTweets|DeleteTweet|UserByScreenName)"/g)];
        for (const match of matches) {
          queryIds[match[2]] = match[1];
        }
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



  scanBtn.addEventListener('click', async () => {
    const screenName = usernameInput.value.trim().replace('@', '');
    const filterText = filterInput.value.trim().toLowerCase();
    
    if (!screenName) return alert("Please enter your X.com username.");
    
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Scanning tweets...</div>';
    currentResults = [];

    try {
      await extractQueryIds();

      if (!userRestId) {
        userRestId = await resolveUserId(screenName);
      }

      let cursor = '';
      let pageCount = 0;
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

        for (const entry of entries) {
          if (entry.entryId.startsWith('tweet-')) {
            const result = entry.itemContent?.tweet_results?.result;
            if (result) {
              const tweetId = result.rest_id;
              const text = result.legacy?.full_text || '';
              const createdAt = result.legacy?.created_at || '';
              
              if (!filterText || text.toLowerCase().includes(filterText)) {
                currentResults.push({ id: tweetId, text, time: createdAt });
              }
            }
          } else if (entry.entryId.startsWith('cursor-bottom')) {
            cursor = entry.content?.value || '';
          }
        }
        
        if (!cursor) break;
        pageCount++;
        await delay(1000); // 1s delay between pagination requests
      }

      // The loop can also exit because pageCount hit MAX_PAGES while X still had
      // more pages (cursor truthy) -- distinguish that from a natural end (no
      // entries, or no cursor) so "N items found" doesn't imply an exhaustive scan.
      const truncated = pageCount >= MAX_PAGES && !!cursor;
      resultsCount.textContent = truncated
        ? `${currentResults.length} items found (stopped after ${MAX_PAGES} pages -- more may exist)`
        : `${currentResults.length} items found`;

      if (currentResults.length > 0) {
        itemList.innerHTML = '';
        currentResults.forEach(tweet => {
          const div = document.createElement('div');
          div.className = 'post-item';

          const timeDiv = document.createElement('div');
          timeDiv.className = 'post-time';
          timeDiv.textContent = new Date(tweet.time).toLocaleString();

          const textDiv = document.createElement('div');
          textDiv.textContent = tweet.text;

          div.appendChild(timeDiv);
          div.appendChild(textDiv);
          itemList.appendChild(div);
        });
        deleteBtn.disabled = false;
        statusText.textContent = "Scan complete. Review results before deleting.";
      } else {
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">No tweets matched your criteria.</div>';
        statusText.textContent = "Ready";
      }
    } catch (err) {
      if (err.staleQueryId) {
        alert(
          "Scan failed: " + err.message +
          "\n\nThis looks like X.com's API rejected one of this extension's built-in query IDs. " +
          "X frequently rotates these; the extension may need an update with refreshed query IDs."
        );
      } else {
        alert("Scan failed: " + err.message);
      }
      statusText.textContent = "Error";
    } finally {
      scanBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    // Above LARGE_DELETE_THRESHOLD, a fixed literal like "DELETE" is the same
    // low-friction confirm regardless of whether 2 or thousands of tweets are
    // about to be permanently destroyed. Require typing the exact count
    // instead, so the number is something the user has to actually notice and
    // act on, not just habitually retype.
    const count = currentResults.length;
    const LARGE_DELETE_THRESHOLD = 100;
    const isLarge = count > LARGE_DELETE_THRESHOLD;
    const expected = isLarge ? String(count) : "DELETE";
    const promptText = isLarge
      ? `You are about to permanently delete ${count} tweets -- more than ${LARGE_DELETE_THRESHOLD}. Type the exact number ${count} to confirm.`
      : `Type DELETE to permanently delete ${count} tweets.`;
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
    
    const totalCount = currentResults.length;
    let deletedCount = 0;
    const failures = []; // { id, message }
    let staleQueryIdSuspected = false;

    try {
      // The inner per-item try/catch below isolates one item's failure from the
      // rest of the batch. This outer try/finally is separate: it guards the
      // chrome.storage.local calls (progress marker) and everything else in this
      // handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: totalCount, done: 0 } });
      for (const tweet of currentResults) {
        try {
          // GraphQL DeleteTweet mutation
          const variables = { tweet_id: tweet.id, dark_request: false };
          const queryId = queryIds.DeleteTweet;
          const url = `https://x.com/i/api/graphql/${queryId}/DeleteTweet`;

          await apiFetch(url, 'POST', {
            variables,
            queryId
          });

          deletedCount++;
        } catch (err) {
          // Isolate this item's failure so a single bad tweet (400/403/network
          // error) doesn't abort the rest of the batch.
          console.error(`Failed to delete tweet ${tweet.id}:`, err);
          failures.push({ id: tweet.id, message: err.message });
          if (err.staleQueryId) staleQueryIdSuspected = true;
        }

        progressText.textContent = failures.length > 0
          ? `Processed ${deletedCount + failures.length} of ${totalCount} (${deletedCount} deleted, ${failures.length} failed)`
          : `Deleted ${deletedCount} of ${totalCount}`;
        await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: totalCount, done: deletedCount + failures.length } });

        // strict 2.5 second delay to avoid rate limits and account suspension flags
        await delay(2500);
      }
      await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);

      currentResults = [];
      resultsCount.textContent = "0 items found";

      if (failures.length === 0) {
        statusText.textContent = "Deletion Complete!";
        statusText.style.color = "#10b981";
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Deletion finished.</div>';
      } else {
        statusText.textContent = `Deletion finished: ${deletedCount} deleted, ${failures.length} failed.`;
        statusText.style.color = "#ef4444";
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Deletion finished (see error summary).</div>';

        const shown = failures.slice(0, 10).map(f => `#${f.id}: ${f.message}`).join('\n');
        const more = failures.length > 10 ? `\n...and ${failures.length - 10} more (see console for full list)` : '';
        const hint = staleQueryIdSuspected
          ? "\n\nSome failures look like X.com rejected this extension's DeleteTweet query ID. " +
            "X frequently rotates these; the extension may need an update with refreshed query IDs."
          : '';
        alert(`Delete failed for ${failures.length} of ${totalCount} tweet(s):\n\n${shown}${more}${hint}`);
      }
    } catch (err) {
      console.error("X delete loop stopped unexpectedly:", err);
      alert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${totalCount} tweets were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
    }
  });
});
