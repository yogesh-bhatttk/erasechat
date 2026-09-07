import { Agent } from '@atproto/api';
import { BrowserOAuthClient } from '@atproto/oauth-client-browser';

// Hosted "discoverable client" id -- see the matching comment in
// bluesky-popup.src.js for the full explanation. Must stay in sync with that file
// (both the CLIENT_ID value itself and this whole clientMetadata shape) since both
// need to resolve to the same client identity for @atproto/oauth-client-browser's
// shared IndexedDB session store to recognize a session popup.js created.
const OAUTH_SCOPE = "atproto transition:generic";
const CLIENT_ID = "https://yogesh-bhatttk.github.io/bulk-clean-oauth/oauth-client-metadata.json";

// Built lazily, inside the DOMContentLoaded handler's own try/catch below, not at
// module top-level -- identity is an OPTIONAL permission here (unlike the
// standalone bulk-clean-for-bluesky this was ported from, where it was required
// and therefore always already granted). chrome.identity.getRedirectURL() throws
// if that permission isn't currently held, and reaching the dashboard at all
// without it means the popup's own login never completed successfully -- so
// treating that the same as "no active session" (the existing catch block below)
// is the correct behavior, not a crash.
function buildClient() {
  const redirectUri = chrome.identity.getRedirectURL();
  return new BrowserOAuthClient({
    handleResolver: 'https://bsky.social',
    clientMetadata: {
      client_id: CLIENT_ID,
      client_name: "Erasechat",
      client_uri: "https://yogesh-bhatttk.github.io/bulk-clean-oauth/",
      redirect_uris: [redirectUri],
      scope: OAUTH_SCOPE,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      dpop_bound_access_tokens: true
    }
  });
}

let agent = null;
let currentSession = null;
let currentResults = [];
const BATCH_SIZE = 200;

const delay = ms => new Promise(res => setTimeout(res, ms));

async function executeWithRetry(apiCall, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiCall();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      
      const errMsg = err.message ? err.message.toLowerCase() : "";
      if (errMsg.includes('dpop') || errMsg.includes('nonce')) {
         // Give the ATProto client a moment to internally rotate the nonce
         await delay(500); 
      } else {
         await delay(Math.pow(2, i) * 1000);
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const connectedAs = document.getElementById('connected-as');
  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const includeRepliesSelect = document.getElementById('include-replies');
  const textFilterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  try {
    const client = buildClient();
    const result = await client.init();
    if (result && result.session) {
      currentSession = result.session;
      agent = new Agent(currentSession);
      connectedAs.textContent = `(Connected: ${currentSession.sub})`;
    } else {
      throw new Error("No active session");
    }
  } catch (err) {
    alert("Not logged in or session expired. Please log in via the extension popup.");
    window.close();
    return;
  }

  // See the matching comment in platforms/reddit/dashboard-reddit.js: this marker
  // only informs the next session that a delete was interrupted -- it does not
  // resume the delete itself, since a fresh scan is required to see current state.
  const DELETE_PROGRESS_KEY = 'bluesky_delete_progress';
  const leftover = (await chrome.storage.local.get([DELETE_PROGRESS_KEY]))[DELETE_PROGRESS_KEY];
  if (leftover) {
    statusText.textContent = `A previous deletion was interrupted (${leftover.done} of ${leftover.total} processed). Scan again to see current state.`;
    await chrome.storage.local.remove([DELETE_PROGRESS_KEY]);
  }

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Scanning...";
    itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">Scanning your feed...</div>';
    
    const includeReplies = includeRepliesSelect.value === "true";
    const filterText = textFilterInput.value.trim().toLowerCase();

    currentResults = [];
    let cursor = undefined;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 20;

    try {
      while (hasMore && pageCount < maxPages) {
        const { data } = await executeWithRetry(() => agent.app.bsky.feed.getAuthorFeed({
          actor: currentSession.sub,
          limit: 100,
          cursor: cursor,
          filter: includeReplies ? "posts_with_replies" : "posts_no_replies"
        }));

        for (const item of data.feed) {
          const post = item.post;
          const text = post.record?.text || "";
          
          if (post.author.did !== agent.accountDid) {
            if (!item.reason) continue;
          }
          
          let matches = true;
          if (filterText) {
             matches = text.toLowerCase().includes(filterText);
          }

          if (matches) {
            const uri = item.reason 
              ? item.reason.$type === 'app.bsky.feed.defs#reasonRepost' 
                ? item.reason.by.did === agent.accountDid 
                  ? item.reason.uri 
                  : post.uri 
                : post.uri 
              : post.uri;
            
            const collection = uri.includes('app.bsky.feed.repost') 
              ? 'app.bsky.feed.repost' 
              : 'app.bsky.feed.post';
            
            currentResults.push({
              uri: uri,
              cid: post.cid,
              text: text,
              time: post.record?.createdAt || new Date().toISOString(),
              collection: collection
            });
          }
        }
        
        cursor = data.cursor;
        hasMore = !!cursor;
        pageCount++;
      }

      // hasMore stays true only when the loop stopped because it hit maxPages,
      // not on a natural end (no cursor) -- so "N items found" doesn't imply an
      // exhaustive scan when older posts may still exist.
      const truncated = pageCount >= maxPages && hasMore;
      resultsCount.textContent = truncated
        ? `${currentResults.length} items found (stopped after ${maxPages} pages -- older posts may exist)`
        : `${currentResults.length} items found`;

      if (currentResults.length > 0) {
        itemList.innerHTML = '';
        currentResults.forEach(item => {
          const div = document.createElement('div');
          div.className = 'post-item';

          const timeDiv = document.createElement('div');
          timeDiv.className = 'post-time';
          timeDiv.textContent = new Date(item.time).toLocaleString();

          const textDiv = document.createElement('div');
          if (item.text) {
            textDiv.textContent = item.text;
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
        itemList.innerHTML = '<div style="color: #64748b; text-align: center; padding-top: 40px;">No posts matched your criteria.</div>';
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
    // low-friction confirm regardless of whether 2 or thousands of posts are
    // about to be permanently destroyed. Require typing the exact count
    // instead, so the number is something the user has to actually notice and
    // act on, not just habitually retype.
    const count = currentResults.length;
    const LARGE_DELETE_THRESHOLD = 100;
    const isLarge = count > LARGE_DELETE_THRESHOLD;
    const expected = isLarge ? String(count) : "DELETE";
    const promptText = isLarge
      ? `You are about to permanently delete ${count} posts -- more than ${LARGE_DELETE_THRESHOLD}. Type the exact number ${count} to confirm.`
      : `Type DELETE to permanently delete ${count} posts.`;
    const confirmation = prompt(promptText);
    if (confirmation !== expected) {
      alert("Deletion cancelled.");
      return;
    }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Deleting...";
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion of ${currentResults.length} items...`;

    let deletedCount = 0;
    const failedChunks = [];
    try {
      // The inner per-chunk try/catch below isolates one chunk's failure from
      // the rest of the batch. This outer try/finally is separate: it guards
      // the chrome.storage.local calls (progress marker) and everything else in
      // this handler against an unexpected exception so the loop can never die
      // silently, leaving scanBtn disabled and the progress marker stuck.
      await chrome.storage.local.set({ [DELETE_PROGRESS_KEY]: { total: currentResults.length, done: 0 } });
      for (let i = 0; i < currentResults.length; i += BATCH_SIZE) {
        const chunk = currentResults.slice(i, i + BATCH_SIZE);
        const writes = chunk.map(item => {
          const rkey = item.uri.split("/").pop();
          return {
            $type: "com.atproto.repo.applyWrites#delete",
            collection: item.collection,
            rkey: rkey
          };
        });

        try {
          // applyWrites is transactional per call -- a failure here means NONE of
          // this chunk's posts were deleted, not a partial chunk. Isolate it so one
          // failed chunk (transient network/server error) doesn't abort every
          // later chunk in the batch.
          await executeWithRetry(() => agent.com.atproto.repo.applyWrites({
            repo: agent.accountDid,
            writes: writes
          }));
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
        console.warn("Bluesky delete chunk failures:", failedChunks);
        alert(
          `Delete failed for ${failedCount} of ${deletedCount + failedCount} post(s). ` +
          `The Delete button will stay disabled -- please Scan again before retrying, ` +
          `since some of the originally scanned posts may already be gone.`
        );
      }
      // deleteBtn deliberately stays disabled: a rescan is required before another
      // delete, since results that already succeeded (or partially changed) should
      // not be re-submitted from stale in-memory state.
    } catch (err) {
      console.error("Bluesky delete loop stopped unexpectedly:", err);
      alert(`Deletion stopped unexpectedly: ${err.message}\n\n${deletedCount} of ${currentResults.length} posts were deleted before this happened.`);
      statusText.textContent = "Error";
      statusText.style.color = "#ef4444";
    } finally {
      scanBtn.disabled = false;
    }
  });
});
