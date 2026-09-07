import { Agent } from '@atproto/api';
import { BrowserOAuthClient } from '@atproto/oauth-client-browser';

// AT Protocol "loopback client" pattern -- see the matching comment in
// bluesky-popup.src.js for the full explanation. Must stay in sync with that file
// since both need to resolve to the same client_id/session for
// @atproto/oauth-client-browser's shared IndexedDB session store to work.
const OAUTH_SCOPE = "atproto transition:generic";
const LOOPBACK_CLIENT_ID = `http://localhost?scope=${encodeURIComponent(OAUTH_SCOPE)}`;

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
      client_id: LOOPBACK_CLIENT_ID,
      client_name: "Bulk Clean for Bluesky",
      client_uri: "https://github.com/bulk-clean",
      redirect_uris: [redirectUri],
      scope: OAUTH_SCOPE,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
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

      resultsCount.textContent = `${currentResults.length} items found`;
      
      if (currentResults.length > 0) {
        itemList.innerHTML = '';
        currentResults.forEach(item => {
          const div = document.createElement('div');
          div.className = 'post-item';
          div.innerHTML = `
            <div class="post-time">${new Date(item.time).toLocaleString()}</div>
            <div>${item.text || '<i>[No text/Media only]</i>'}</div>
          `;
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
    const confirmation = prompt(`Type DELETE to permanently delete ${currentResults.length} posts.`);
    if (confirmation !== "DELETE") {
      alert("Deletion cancelled.");
      return;
    }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = "Deleting...";
    statusText.style.color = "#ef4444";
    progressText.textContent = `Starting deletion of ${currentResults.length} items...`;

    try {
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

        await executeWithRetry(() => agent.com.atproto.repo.applyWrites({
          repo: agent.accountDid,
          writes: writes
        }));

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
