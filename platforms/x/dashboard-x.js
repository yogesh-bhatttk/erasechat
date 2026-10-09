function resolveXScriptUrl(src) {
  return new URL(src, 'https://x.com/').href;
}

// GraphQL query ids end up in a URL path (`/i/api/graphql/<id>/<Operation>`).
// They're scraped out of x.com's JS bundle, so validate them before use -- a
// malformed/hostile value must never be able to inject path segments or a query.
function isValidQueryId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

// Fallbacks used until (or if) extractQueryIds() scrapes live ones. X rotates
// these; a stale one surfaces as apiFetch's staleQueryId flag.
const DEFAULT_X_QUERY_IDS = Object.freeze({
  UserByScreenName: 's70IQxZ5sQ-b40B2gP37Tw',
  UserTweets: 'Q6aAvPw7azHZhmCBjomMeA',
  DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg',
  DeleteRetweet: 'iQtK4dl5hBmXewYZuEOKVw'
});

// Pure: pulls every `queryId:"...",operationName:"<Op>"` pair for the operations
// this dashboard uses out of one JS bundle, keeping only ids that validate.
function extractQueryIdsFromBundle(js) {
  const found = {};
  const re = /queryId:"([^"]+)",operationName:"(UserTweets|DeleteTweet|DeleteRetweet|UserByScreenName)"/g;
  for (const match of js.matchAll(re)) {
    if (isValidQueryId(match[1])) found[match[2]] = match[1];
  }
  return found;
}

// X wraps some tweets (age-gated, limited-visibility, "withheld in" etc.) as
// { __typename: 'TweetWithVisibilityResults', tweet: { rest_id, legacy, ... } }
// -- the real tweet is one level down. Without unwrapping, rest_id is undefined
// and the tweet was silently dropped from the scan.
function unwrapTweetResult(result) {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults' || (!result.rest_id && result.tweet)) {
    return result.tweet || null;
  }
  return result;
}

// Pure: a status permalink built only from a validated numeric id.
function buildXPermalink(id) {
  return typeof id === 'string' && /^\d+$/.test(id) ? `https://x.com/i/status/${id}` : null;
}

// Pure: one tweet_results.result -> a result row, or null if it has no id. A
// repost (retweet) by the user carries legacy.retweeted_status_result; removing
// it needs the DeleteRetweet mutation keyed on the SOURCE tweet's id, not
// DeleteTweet on the wrapper's.
function tweetFromResult(rawResult) {
  const result = unwrapTweetResult(rawResult);
  if (!result || !result.rest_id) return null;
  const legacy = result.legacy || {};
  const source = unwrapTweetResult(legacy.retweeted_status_result?.result);
  const sourceTweetId = source?.rest_id || null;
  const isRepost = !!sourceTweetId;
  const likes = Number(legacy.favorite_count);
  return {
    id: result.rest_id,
    text: legacy.full_text || '',
    time: legacy.created_at || '',
    timeMs: parseXTimeMs(legacy.created_at),
    likes: Number.isFinite(likes) && likes >= 0 ? likes : null,
    pinned: false,
    ownerId: legacy.user_id_str || result.core?.user_results?.result?.rest_id || null,
    isRepost,
    sourceTweetId,
    permalink: buildXPermalink(isRepost ? sourceTweetId : result.rest_id)
  };
}

// Pure: X's created_at ("Wed Oct 10 20:19:24 +0000 2018", same in the API and
// the archive) -> epoch ms, or null if absent/unparseable.
function parseXTimeMs(createdAt) {
  if (typeof createdAt !== 'string' || !createdAt) return null;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

// UserTweets puts the pinned tweet in its own TimelinePinEntry instruction (not
// in TimelineAddEntries), so it was never scanned. Pinned entry first, then the
// page's ordinary entries.
function collectTimelineEntries(instructions) {
  const entries = [];
  for (const ins of instructions || []) {
    // Shallow copy tagged xPinned so extractTweetsFromEntries can flag the
    // pinned post (for the "Keep pinned" filter) without mutating X's response.
    if (ins.type === 'TimelinePinEntry' && ins.entry) entries.push({ ...ins.entry, xPinned: true });
  }
  for (const ins of instructions || []) {
    if (ins.type === 'TimelineAddEntries' && Array.isArray(ins.entries)) entries.push(...ins.entries);
  }
  return entries;
}

// Pulls tweets + the next pagination cursor out of one UserTweets timeline page.
// Extracted as a pure-ish helper (its only side effect is recording ids into the
// caller-owned `seenTweetIds` Set) so the cursor-advance and de-dup logic is unit
// testable without a live GraphQL response -- see tests/x-dashboard.test.js.
//
// Handles plain `tweet-*` entries (item content under entry.content.itemContent
// in real responses; entry.itemContent tolerated too), self-thread
// `profile-conversation-*` modules (several tweets under content.items[]), and
// the TimelinePinEntry's pinned tweet (see collectTimelineEntries). `ownerId`,
// when given, drops anything not authored by that account (a conversation
// module can carry someone else's tweet).
//
// `filter` is either a plain lower-cased substring (legacy form, '' = keep all)
// or a predicate (tweet) => boolean -- the scan passes the advanced-filter
// predicate built by makeXItemPredicate.
//
// Returns { tweets, nextCursor, rawCount, newestMs }: `nextCursor` is null when the page
// carried no cursor-bottom entry at all -- the caller must stop rather than reuse
// a stale cursor and silently re-request the same page forever. An entry present
// but with an empty value is the ordinary "no more pages" signal. `rawCount` is
// how many tweet results the page held at all (before de-dup/filtering) -- 0
// means the timeline is exhausted even though X still sends a cursor.
// `newestMs` is the newest created_at among the page's non-pinned tweets (null
// if none had a date): the timeline is newest-first, so once that is older than
// the "From" date every later page is too and the scan can stop.
function extractTweetsFromEntries(entries, seenTweetIds, filter, ownerId) {
  const tweets = [];
  let nextCursor = null;
  let rawCount = 0;
  let newestMs = null;
  const keep = typeof filter === 'function'
    ? filter
    : (tweet) => !filter || tweet.text.toLowerCase().includes(filter);

  function consider(tweetResults, pinned) {
    const tweet = tweetFromResult(tweetResults?.result);
    if (!tweet) return;
    rawCount++;
    if (pinned) tweet.pinned = true;
    else if (tweet.timeMs != null && (newestMs == null || tweet.timeMs > newestMs)) newestMs = tweet.timeMs;
    // Defensive de-dup: a repeated page, or the pinned tweet also appearing in
    // the ordinary timeline, must not show the same tweet twice.
    if (seenTweetIds.has(tweet.id)) return;
    if (ownerId && tweet.ownerId && tweet.ownerId !== ownerId) return;
    seenTweetIds.add(tweet.id);
    if (keep(tweet)) {
      tweets.push(tweet);
    }
  }

  for (const entry of entries) {
    const entryId = entry?.entryId || '';
    if (entryId.startsWith('tweet-')) {
      const itemContent = entry.content?.itemContent || entry.itemContent;
      consider(itemContent?.tweet_results, !!entry.xPinned);
    } else if (entryId.startsWith('profile-conversation-')) {
      const items = entry.content?.items || entry.items || [];
      for (const it of items) {
        const itemContent = it?.item?.itemContent || it?.itemContent;
        consider(itemContent?.tweet_results, !!entry.xPinned);
      }
    } else if (entryId.startsWith('cursor-bottom')) {
      nextCursor = entry.content?.value || '';
    }
  }
  return { tweets, nextCursor, rawCount, newestMs };
}

// Pure: true once a whole timeline page is older than the "From" date (see
// extractTweetsFromEntries' newestMs) -- no later page can match.
function pageOlderThanFrom(newestMs, fromMs) {
  return fromMs != null && newestMs != null && newestMs < fromMs;
}

// Accessors handed to passesAdvancedFilters (platforms/shared/platform-filters.js).
const X_FILTER_ACCESSORS = Object.freeze({
  time: (tweet) => (tweet.timeMs != null ? tweet.timeMs : null),
  score: (tweet) => (typeof tweet.likes === 'number' ? tweet.likes : null),
  pinned: (tweet) => !!tweet.pinned
});

// Pure: the per-item keep/skip predicate for both the timeline scan and an
// archive import. `matcher` is buildTextMatcher()'s result; `passes` is
// passesAdvancedFilters (injected so this is testable without the shared file).
// An archive item imported from tweet-headers.js has no text at all
// (textUnknown) -- with a text filter active it is skipped rather than
// matched against '' (which an inverted filter would turn into "delete it").
function makeXItemPredicate(matcher, filters, passes, hasTextFilter) {
  return (tweet) => {
    if (tweet.textUnknown) {
      if (hasTextFilter) return false;
    } else if (matcher && !matcher.test(tweet.text || '')) {
      return false;
    }
    return !passes || !filters || passes(tweet, filters, X_FILTER_ACCESSORS);
  };
}

// ============================================================
// X archive import (Settings -> Download an archive of your data). The profile
// timeline only reaches back ~3200 posts; the archive lists every one.
//   data/tweets.js (+ tweets-part1.js, ...):
//     window.YTD.tweets.part0 = [ { "tweet": { id_str, created_at, full_text, favorite_count, ... } }, ... ]
//   data/tweet-headers.js (ids/dates only, plus the author's user_id):
//     window.YTD.tweet_headers.part0 = [ { "tweet": { tweet_id, user_id, created_at } }, ... ]
// ============================================================

// Hard cap on one archive file read into memory (File.text() + JSON.parse
// roughly triples it). Even very heavy accounts' tweets.js parts stay below this.
const X_ARCHIVE_MAX_FILE_BYTES = 256 * 1024 * 1024;

function isValidXId(id) {
  return typeof id === 'string' && /^\d{1,25}$/.test(id);
}

// Pure: one archive array entry -> an item shaped like a scanned tweet, or null
// if it has no valid numeric id. `kind` is 'tweets' or 'headers'.
function archiveEntryToItem(entry, kind) {
  const tw = entry && typeof entry === 'object' ? (entry.tweet && typeof entry.tweet === 'object' ? entry.tweet : entry) : null;
  if (!tw) return null;
  const rawId = tw.id_str != null ? tw.id_str : (tw.tweet_id != null ? tw.tweet_id : tw.id);
  const id = rawId == null ? null : String(rawId);
  if (!isValidXId(id)) return null;
  const isHeader = kind === 'headers' || (typeof tw.full_text !== 'string' && typeof tw.text !== 'string');
  const text = isHeader ? '' : (typeof tw.full_text === 'string' ? tw.full_text : tw.text);
  const likes = Number(tw.favorite_count);
  const owner = tw.user_id_str != null ? String(tw.user_id_str) : (tw.user_id != null ? String(tw.user_id) : null);
  return {
    id,
    text,
    textUnknown: isHeader,
    time: typeof tw.created_at === 'string' ? tw.created_at : '',
    timeMs: parseXTimeMs(tw.created_at),
    likes: !isHeader && tw.favorite_count != null && Number.isFinite(likes) && likes >= 0 ? likes : null,
    pinned: false,
    ownerId: isValidXId(owner) ? owner : null,
    // The archive marks a retweet only by its "RT @user:" text and carries no
    // source id -- it's deleted with DeleteTweet on its own id (see
    // xDeleteOperation), which removes the retweet.
    isRepost: /^RT @/.test(text),
    sourceTweetId: null,
    fromArchive: true,
    permalink: buildXPermalink(id)
  };
}

// Pure: parses one archive file's text. Returns
//   { ok: true, kind: 'tweets'|'headers', items, skipped, ownerIds: string[] }
// or { ok: false, error: 'json'|'shape'|'unsupported', name? }.
// Everything up to the first '=' (the `window.YTD.<name>.partN` assignment) is
// stripped; a bare JSON array is accepted too.
function parseXArchiveText(text) {
  if (typeof text !== 'string') return { ok: false, error: 'shape' };
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  let prefix = '';
  let body = trimmed;
  if (!trimmed.startsWith('[')) {
    const eq = trimmed.indexOf('=');
    if (eq === -1) return { ok: false, error: 'shape' };
    prefix = trimmed.slice(0, eq);
    body = trimmed.slice(eq + 1);
  }
  let kind = null;
  const named = /YTD\.([A-Za-z0-9_]+)\.part\d+/.exec(prefix);
  if (named) {
    if (named[1] === 'tweets') kind = 'tweets';
    else if (named[1] === 'tweet_headers') kind = 'headers';
    else return { ok: false, error: 'unsupported', name: named[1] };
  }
  let data;
  try {
    data = JSON.parse(body.trim().replace(/;\s*$/, ''));
  } catch (_) {
    return { ok: false, error: 'json' };
  }
  if (!Array.isArray(data)) return { ok: false, error: 'shape' };
  if (!kind) {
    const first = data.find(e => e && typeof e === 'object');
    const tw = first && (first.tweet || first);
    kind = tw && tw.tweet_id != null && tw.full_text == null ? 'headers' : 'tweets';
  }
  const items = [];
  const ownerIds = new Set();
  let skipped = 0;
  for (const entry of data) {
    const item = archiveEntryToItem(entry, kind);
    if (!item) { skipped++; continue; }
    if (item.ownerId) ownerIds.add(item.ownerId);
    items.push(item);
  }
  return { ok: true, kind, items, skipped, ownerIds: [...ownerIds] };
}

// Pure: merges the items of several parsed files, de-duplicated by id. A full
// tweets.js entry wins over a text-less tweet-headers.js one for the same id
// (keeping the header's ownerId). Sorted newest-first, undated last.
function mergeArchiveItems(itemLists) {
  const byId = new Map();
  for (const list of itemLists) {
    for (const item of list || []) {
      const existing = byId.get(item.id);
      if (!existing) { byId.set(item.id, item); continue; }
      if (existing.textUnknown && !item.textUnknown) {
        byId.set(item.id, { ...item, ownerId: item.ownerId || existing.ownerId });
      } else if (!existing.ownerId && item.ownerId) {
        existing.ownerId = item.ownerId;
      }
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.timeMs == null) return b.timeMs == null ? 0 : 1;
    if (b.timeMs == null) return -1;
    return b.timeMs - a.timeMs;
  });
}

// Pure: does the archive's author id (from tweet-headers.js) match the connected
// account's? 'match' | 'mismatch' | 'unknown' (no ids in the archive, or the
// connected account's id couldn't be resolved).
function archiveOwnerCheck(ownerIds, connectedUserId) {
  if (!ownerIds || ownerIds.length === 0 || !connectedUserId) return 'unknown';
  return ownerIds.every(id => id === String(connectedUserId)) ? 'match' : 'mismatch';
}

// Pure: export columns for mountExportButtons / csvRows.
const X_EXPORT_COLUMNS = Object.freeze([
  { label: 'id', get: (tweet) => tweet.id },
  { label: 'date', get: (tweet) => (tweet.timeMs != null ? new Date(tweet.timeMs).toISOString() : '') },
  { label: 'type', get: (tweet) => (tweet.isRepost ? 'repost' : 'post') },
  { label: 'likes', get: (tweet) => (typeof tweet.likes === 'number' ? tweet.likes : '') },
  { label: 'text', get: (tweet) => tweet.text || '' },
  { label: 'url', get: (tweet) => tweet.permalink || '' }
]);

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
    return t("xDashDeleteUnconfirmed", "X did not confirm the post was deleted (unexpected response).");
  }
  return null;
}

// Same contract for the DeleteRetweet mutation (success shape: data.unretweet).
function deleteRetweetFailureFromResult(result) {
  if (result && Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.map(e => (e && e.message) || JSON.stringify(e)).join('; ');
  }
  if (!result || !result.data || !result.data.unretweet) {
    return t("xDashRepostUnconfirmed", "X did not confirm the repost was removed (unexpected response).");
  }
  return null;
}

// Pure: which mutation removes this row. A timeline repost needs DeleteRetweet
// keyed on the SOURCE post; an archive repost has no source id, so it (like any
// own post) goes through DeleteTweet on its own id.
function xDeleteOperation(tweet) {
  return tweet.isRepost && !tweet.fromArchive && tweet.sourceTweetId ? 'DeleteRetweet' : 'DeleteTweet';
}

// Pure: the GraphQL request for removing one scanned row -- see
// xDeleteOperation. Returns null if the needed query id doesn't validate (never
// interpolated into the URL unchecked).
function buildXDeleteRequest(tweet, queryIds) {
  const operation = xDeleteOperation(tweet);
  const queryId = queryIds[operation];
  if (!isValidQueryId(queryId)) return null;
  const variables = operation === 'DeleteRetweet'
    ? { source_tweet_id: tweet.sourceTweetId, dark_request: false }
    : { tweet_id: tweet.id, dark_request: false };
  return { operation, url: `https://x.com/i/api/graphql/${queryId}/${operation}`, body: { variables, queryId } };
}

// Pure: X's x-rate-limit-reset header is the epoch SECOND the window resets.
// Returns how long to wait in ms, or null if absent/unparseable.
function xRetryAfterMs(headers, now) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('x-rate-limit-reset') : null;
  const resetSec = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(resetSec) || resetSec <= 0) return null;
  return Math.max(0, resetSec * 1000 - now);
}

// Maps a failed request to a friendly, actionable, localized sentence instead of
// a bare "API Error 403".
function friendlyXError(err) {
  const status = err && err.status;
  if (err && err.staleQueryId) {
    return t("xDashStaleHint", "X changed something on their end that this version of the extension doesn't recognize yet. Check your browser's extensions page for an update, or try again later -- this isn't something you did wrong.");
  }
  if (!status) {
    if (err && err.name === 'TypeError') return t("socialDashErrNetwork", "Couldn't reach X. Check your internet connection and try again.", ["X"]);
    return (err && err.message) || t("socialDashErrUnknown", "Something unexpected went wrong. Try again.");
  }
  if (status === 401 || status === 403) return t("socialDashErrAuth", "X rejected the request -- your session may have expired. Log in on X, reconnect it from the extension popup, and try again.", ["X"]);
  if (status === 404) return t("xDashErrNotFound", "X couldn't find that account. Check the username and try again.");
  if (status === 429) {
    if (err.retryAfterMs) {
      const mins = String(Math.max(1, Math.ceil(err.retryAfterMs / 60000)));
      return t("socialDashErrRateLimitedFor", `X is rate-limiting requests. Try again in about ${mins} minute(s).`, ["X", mins]);
    }
    return t("socialDashErrRateLimited", "X is rate-limiting requests. Wait a few minutes and try again.", ["X"]);
  }
  if (status >= 500) return t("socialDashErrServer", `X is having trouble right now (HTTP ${status}). Try again in a few minutes.`, ["X", String(status)]);
  return t("socialDashErrGeneric", `X returned an unexpected error (HTTP ${status}). Try again; if it keeps happening, reconnect from the extension popup.`, ["X", String(status)]);
}

// X's own profile timeline only ever serves roughly the newest 3200 posts.
const X_TIMELINE_CAP = 3200;

if (typeof module !== 'undefined') module.exports = {
  resolveXScriptUrl,
  isValidQueryId,
  extractQueryIdsFromBundle,
  DEFAULT_X_QUERY_IDS,
  unwrapTweetResult,
  tweetFromResult,
  collectTimelineEntries,
  extractTweetsFromEntries,
  deleteTweetFailureFromResult,
  deleteRetweetFailureFromResult,
  buildXDeleteRequest,
  xDeleteOperation,
  buildXPermalink,
  parseXTimeMs,
  pageOlderThanFrom,
  X_FILTER_ACCESSORS,
  makeXItemPredicate,
  isValidXId,
  archiveEntryToItem,
  parseXArchiveText,
  mergeArchiveItems,
  archiveOwnerCheck,
  X_EXPORT_COLUMNS,
  X_ARCHIVE_MAX_FILE_BYTES,
  xRetryAfterMs,
  friendlyXError,
  X_TIMELINE_CAP
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['x_csrf']),
    chrome.storage.local.get(['x_username'])
  ]);
  if (!sessionData.x_csrf) {
    await showAlert(t("socialDashNotLinked", "Not connected to X. Connect it from the extension popup first.", ["X"]));
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
  const deepScanInput = document.getElementById('deep-scan');
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

  // True while a scan or delete is running -- username edits must not re-enable
  // Delete then (that started a second concurrent delete loop, or armed Delete on
  // a half-finished scan).
  let busy = false;
  // The handle the current results were scanned for. Checked alongside the typed
  // value so "scan @someone_else, then retype your own handle" can't arm Delete
  // on another account's tweets.
  let scannedScreenName = null;

  function isUsernameMismatched() {
    if (!authenticatedUsername) return false;
    const auth = authenticatedUsername.toLowerCase();
    const typed = usernameInput.value.trim().replace('@', '').toLowerCase();
    if (typed && typed !== auth) return true;
    return !!scannedScreenName && scannedScreenName.toLowerCase() !== auth;
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
    } else if (currentResults.length > 0 && !busy) {
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
  const archiveInput = document.getElementById('archive-files');
  const archiveBtn = document.getElementById('archive-import-btn');

  const DELETE_PROGRESS_KEY = 'x_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  let currentResults = [];
  // Advanced filters + export (platforms/shared/platform-filters.js). Guarded so
  // a failed load of that file degrades to the plain keyword filter instead of
  // breaking scanning.
  const hasAdvancedFilters = typeof mountAdvancedFilters === 'function';
  if (hasAdvancedFilters) {
    mountAdvancedFilters({
      keepMinLabel: t("xDashKeepMinLikes", "Keep posts with at least N likes"),
      keepPinned: true
    });
  }
  const exporter = typeof mountExportButtons === 'function'
    ? mountExportButtons({ platform: 'x', columns: X_EXPORT_COLUMNS, getItems: () => currentResults })
    : null;
  function refreshExport() {
    if (exporter) exporter.refresh();
  }

  // Builds the keep/skip predicate from the text field + advanced filters, and
  // logs a warning when a /regex/ had to fall back to plain text.
  function buildScanPredicate() {
    const raw = filterInput.value.trim();
    const filters = hasAdvancedFilters ? readAdvancedFilters() : null;
    let matcher;
    if (typeof buildTextMatcher === 'function') {
      matcher = buildTextMatcher(raw, !!(filters && filters.invert));
      if (matcher.warning === 'unsafe') {
        logActivity('sc-activity-log', t("xDashRegexUnsafe", "That /regex/ could be very slow, so it was matched as plain text instead."), 'warn');
      } else if (matcher.warning === 'invalid') {
        logActivity('sc-activity-log', t("xDashRegexInvalid", "That /regex/ isn't valid, so it was matched as plain text instead."), 'warn');
      }
    } else {
      const lower = raw.toLowerCase();
      matcher = { test: (text) => !lower || text.toLowerCase().includes(lower) };
    }
    const summary = filters && typeof describeActiveFilters === 'function' ? describeActiveFilters(filters) : '';
    if (summary) logActivity('sc-activity-log', summary);
    return {
      raw,
      filters,
      predicate: makeXItemPredicate(matcher, filters, hasAdvancedFilters ? passesAdvancedFilters : null, !!raw)
    };
  }

  updateUsernameMismatchState(); // reflect the pre-filled value now that currentResults exists (always matches at this point, but keeps this the single source of truth)
  let userRestId = null;
  // Tracks which screenName userRestId was actually resolved for -- without this,
  // scanning once then editing the username field and scanning again would reuse
  // the FIRST account's userRestId (since it's merely truthy), silently scanning
  // and offering to delete the wrong account's tweets while the input shows the
  // newly-typed name.
  let userRestIdForScreenName = null;

  let queryIds = { ...DEFAULT_X_QUERY_IDS };
  // Once extractQueryIds() has run successfully this session, the scraped ids stay
  // good until X actually rotates them (signaled by apiFetch's staleQueryId flag) --
  // re-running it on every single Scan click re-downloads and regex-scans x.com's
  // full main JS bundle (often multi-MB) for no reason.
  let queryIdsExtracted = false;
  let queryIdsStale = false;

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-x.html.

  // The running delete's cancel controller, so a long Retry-After wait inside
  // fetchWithRetry ends as soon as the user cancels. Null during scans.
  let activeDeleteCancel = null;

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

    const response = await fetchWithRetry(url, options, undefined, deleteRetryOptions(activeDeleteCancel, progressText));
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
        const authErr = new Error(t("xDashSessionInvalidError", "Your X session (ct0) appears to be invalid or expired. Reconnect from the extension popup."));
        authErr.status = response.status;
        authErr.expiredAuth = true;
        throw authErr;
      }
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.body = bodyText;
      // Honor X's own reset time on a 429 (x-rate-limit-reset, epoch seconds)
      // so the scan can wait it out and the delete summary can say how long.
      if (response.status === 429) {
        err.retryAfterMs = xRetryAfterMs(response.headers, Date.now());
      }
      // Twitter/X rotates GraphQL queryIds regularly. When the hardcoded
      // fallback ids (used if extractQueryIds() couldn't scrape live ones) go
      // stale, the API typically responds with a 400/404 whose body mentions
      // the query itself. Flag that so callers can surface a clearer message.
      err.staleQueryId = (response.status === 400 || response.status === 404) &&
        /quer(y|yid)|operationname|does not match|unable to find|features cannot be null/i.test(bodyText);
      err.message = friendlyXError(err);
      throw err;
    }
    return response.json();
  }

  // Every operation the dashboard actually calls (see apiFetch/resolveUserId) --
  // extraction isn't "done" until all three have a live queryId, not just any one.
  const REQUIRED_QUERY_OPERATIONS = ['UserTweets', 'DeleteTweet', 'UserByScreenName'];

  async function extractQueryIds() {
    try {
      statusText.textContent = t("xDashFetchingSignatures", "Fetching X's latest API signatures...");
      const htmlRes = await fetchWithRetry("https://x.com/", { credentials: 'include' });
      const html = await htmlRes.text();
      // Look for the main JS bundle which usually contains the query IDs
      const scriptMatches = [...html.matchAll(/<script[^>]+src="([^"]+main\.[a-z0-9]+\.js)"/g)];

      // Independent bundle fetches -- run them concurrently instead of one at a
      // time, since each is a full (often multi-MB) download+parse.
      const foundOperations = new Set();
      await Promise.all(scriptMatches.map(async (m) => {
        // The bundle is public and served from abs.twimg.com, which this extension
        // has no host permission for -- so the request is subject to CORS, and a
        // credentialed request is rejected against the CDN's wildcard
        // Access-Control-Allow-Origin. 'include' made every extraction fail
        // silently onto the hardcoded (eventually stale) defaults.
        const jsRes = await fetchWithRetry(resolveXScriptUrl(m[1]), { credentials: 'omit' });
        const js = await jsRes.text();
        // Only ids matching /^[A-Za-z0-9_-]+$/ are kept (see
        // extractQueryIdsFromBundle) -- they're interpolated into a URL path.
        const found = extractQueryIdsFromBundle(js);
        for (const [operation, id] of Object.entries(found)) {
          queryIds[operation] = id;
          foundOperations.add(operation);
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
    const url = `${graphqlBase('UserByScreenName')}?variables=${variables}&features=${features}`;
    
    const res = await apiFetch(url);
    if (res && res.data && res.data.user && res.data.user.result) {
      return res.data.user.result.rest_id;
    }
    const notFound = new Error(t("xDashErrNotFound", "X couldn't find that account. Check the username and try again."));
    notFound.userNotFound = true;
    throw notFound;
  }

  // Every GraphQL URL goes through here so a query id is validated right before
  // it's interpolated into a path, even if it came from somewhere other than
  // extractQueryIdsFromBundle. An invalid one falls back to the default.
  function graphqlBase(operation) {
    if (!isValidQueryId(queryIds[operation])) queryIds[operation] = DEFAULT_X_QUERY_IDS[operation];
    return `https://x.com/i/api/graphql/${queryIds[operation]}/${operation}`;
  }



  // Shared by the scan-success render and the post-delete "remaining items" render
  // (a partial/cancelled/selective delete leaves some scanned items un-deleted --
  // those stay visible with fresh checkboxes rather than being discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    visibleRows(items).forEach(tweet => {
      const div = document.createElement('div');
      div.className = 'post-item';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      if (tweet.fromArchive) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-archive';
        badge.textContent = t("xDashFromArchiveBadge", "From archive");
        timeDiv.appendChild(badge);
        timeDiv.appendChild(document.createTextNode(' '));
      }
      if (tweet.pinned) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-pinned';
        badge.textContent = t("xDashPinnedBadge", "Pinned");
        timeDiv.appendChild(badge);
        timeDiv.appendChild(document.createTextNode(' '));
      }
      if (tweet.isRepost) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-repost';
        badge.textContent = t("xDashRepostLabel", "Repost");
        badge.title = t("xDashRepostHint", "Your repost of someone else's post -- deleting removes only your repost, not their post.");
        timeDiv.appendChild(badge);
        timeDiv.appendChild(document.createTextNode(' '));
      }
      timeDiv.appendChild(document.createTextNode(tweet.timeMs != null
        ? new Date(tweet.timeMs).toLocaleString()
        : (tweet.time ? new Date(tweet.time).toLocaleString() : '')));
      if (typeof tweet.likes === 'number' && tweet.likes > 0) {
        timeDiv.appendChild(document.createTextNode(' · ' + t("xDashLikesCount", `${tweet.likes} likes`, [String(tweet.likes)])));
      }

      const textDiv = document.createElement('div');
      if (tweet.textUnknown) {
        textDiv.className = 'post-text-unknown';
        textDiv.textContent = t("xDashArchiveNoText", "(Post text isn't included in tweet-headers.js)");
      } else {
        textDiv.textContent = tweet.text;
      }

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, tweet, rowCheckboxes);
      // After addRowCheckbox so "Open" isn't folded into the checkbox's
      // aria-label. tweet.permalink is built only from a validated numeric id.
      if (tweet.permalink) {
        const link = document.createElement('a');
        link.className = 'post-open-link';
        link.href = tweet.permalink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t("socialDashOpenLink", "Open");
        link.setAttribute('aria-label', t("socialDashOpenLinkAria", "Open on X in a new tab", ["X"]));
        timeDiv.appendChild(document.createTextNode(' '));
        timeDiv.appendChild(link);
      }
      itemList.appendChild(div);
    });
    appendHiddenRowsNote(itemList, items.length);
    wireSelectAll(selectAllBox, items, rowCheckboxes);
    refreshExport();
  }

  scanBtn.addEventListener('click', async () => {
    const screenName = usernameInput.value.trim().replace('@', '');
    const isDeepScan = !!(deepScanInput && deepScanInput.checked);
    if (!screenName) { await showAlert(t("xDashEnterUsername", "Please enter your X username.")); return; }

    busy = true;
    scannedScreenName = screenName;
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    if (archiveBtn) archiveBtn.disabled = true;
    statusText.style.color = "";
    statusText.textContent = t("dashScanning", "Scanning...");
    renderEmptyState(itemList, t("socialDashScanningPosts", "Scanning your posts..."));
    currentResults = [];
    // A Deep Scan can sit in X's rate-limit wait (below) for many minutes, so the
    // scan gets the same Cancel button the delete loop uses. Stopping keeps the
    // posts found so far, marked as an incomplete scan.
    const scanCancel = createCancelController();
    armCancelButton(cancelBtn, scanCancel, t("xDashStopScanConfirm", "Stop scanning? Nothing has been deleted -- the posts found so far stay listed."), scanCancelLabels());
    let scanStopped = false;
    const { raw: filterText, filters: scanFilters, predicate } = buildScanPredicate();
    const fromMs = scanFilters ? scanFilters.fromMs : null;
    let reachedFromDate = false;
    refreshExport();
    logActivity('sc-activity-log', filterText
      ? t("socialDashLogScanStartedFilter", `Scan started (filter: "${filterText}").`, [filterText])
      : t("socialDashLogScanStarted", "Scan started."));

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
      // ~40 posts/page. A normal scan reads the newest ~400; Deep Scan keeps
      // going up to X's own ~3200-post timeline limit (X_TIMELINE_CAP) -- enough
      // pages to cover it even if X returns only ~20 per page.
      const MAX_PAGES = isDeepScan ? 170 : 10;
      let rawSeen = 0;
      let rateLimitWaits = 0;
      const MAX_RATE_LIMIT_WAITS = 3;

      while (pageCount < MAX_PAGES) {
        if (scanCancel.cancelled) { scanStopped = true; break; }
        const variables = {
          userId: userRestId,
          count: 40,
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

        const url = `${graphqlBase('UserTweets')}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;

        let res;
        try {
          res = await apiFetch(url);
        } catch (err) {
          // A long (Deep) scan can run into X's UserTweets rate limit. Wait out
          // X's own reset time (x-rate-limit-reset) and retry this same page,
          // instead of throwing away everything scanned so far.
          if (err.status === 429 && err.retryAfterMs != null && err.retryAfterMs <= 16 * 60 * 1000 && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
            rateLimitWaits++;
            const waitMs = err.retryAfterMs + 2000;
            logActivity('sc-activity-log', t("socialDashLogRateLimitWait", `Rate limited by X -- waiting ${Math.ceil(waitMs / 1000)} s before continuing.`, ["X", String(Math.ceil(waitMs / 1000))]), 'warn');
            const resumeAt = Date.now() + waitMs;
            while (Date.now() < resumeAt) {
              const remainingSec = Math.ceil((resumeAt - Date.now()) / 1000);
              statusText.textContent = t("socialDashRateLimitResuming",
                `X rate limit reached -- resuming in ${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s...`,
                ["X", String(Math.floor(remainingSec / 60)), String(remainingSec % 60)]);
              if (!(await cancellableDelay(Math.min(1000, resumeAt - Date.now()), scanCancel))) {
                scanStopped = true;
                break;
              }
            }
            if (scanStopped) break;
            continue;
          }
          throw err;
        }
        const instructions = res?.data?.user?.result?.timeline_v2?.timeline?.instructions
          || res?.data?.user?.result?.timeline?.timeline?.instructions || [];

        const entries = collectTimelineEntries(instructions);
        if (entries.length === 0) break;

        const { tweets, nextCursor, rawCount, newestMs } = extractTweetsFromEntries(entries, seenTweetIds, predicate, userRestId);
        currentResults.push(...tweets);
        rawSeen += rawCount;
        // X keeps sending a cursor-bottom entry even past the end of the
        // timeline; a page with no posts at all is the real end.
        if (rawCount === 0) { cursor = ''; break; }
        // Newest-first timeline: once a whole page predates the "From" date,
        // nothing further back can match -- a natural end, not a truncation.
        if (pageOlderThanFrom(newestMs, fromMs)) { cursor = ''; reachedFromDate = true; break; }

        // No cursor-bottom entry at all means X gave us nothing to advance
        // on -- continuing would re-request this SAME page (bounded only by
        // MAX_PAGES, not by ever making real progress) instead of stopping like
        // a genuine end-of-timeline does. An entry present but with an empty
        // value is the ordinary "no more pages" signal, same as before.
        if (!nextCursor) { cursor = ''; break; }
        // X handing back the cursor it was just given would re-request the same
        // page until MAX_PAGES (170 on a Deep Scan) -- treat it as the end.
        if (nextCursor === cursor) { cursor = ''; break; }
        cursor = nextCursor;
        pageCount++;
        statusText.textContent = t("socialDashScanningProgress", `Scanning... (page ${pageCount}, ${currentResults.length} found)`, [String(pageCount), String(currentResults.length)]);
        await delay(1000); // 1s delay between pagination requests
      }

      // The loop can also exit because pageCount hit MAX_PAGES while X still had
      // more pages (cursor truthy) -- distinguish that from a natural end (no
      // entries, or no cursor) so "N items found" doesn't imply an exhaustive scan.
      const truncated = (pageCount >= MAX_PAGES && !!cursor) || scanStopped;
      // A natural end close to ~3200 posts is X's own timeline cap, not the
      // account's real history -- say so instead of implying a complete scan.
      const timelineCapped = !truncated && !reachedFromDate && rawSeen >= X_TIMELINE_CAP - 300;
      if (timelineCapped) {
        // Clear the remembered "stopped after N pages" note from an earlier scan,
        // so a post-delete recount can't bring it back (see formatScanCount).
        formatScanCount(0, { truncated: false, keepTruncated: false });
        resultsCount.textContent = t("xDashScanCountTimelineCap",
          `${currentResults.length} posts found -- X's timeline only goes back about 3200 posts; older posts may exist but can't be listed here.`,
          [String(currentResults.length)]);
        logActivity('sc-activity-log', t("xDashArchiveTip", "To reach posts older than X's ~3200-post timeline limit, use \"Import from X archive\"."));
      } else {
        resultsCount.textContent = formatScanCount(currentResults.length, {
          truncated, maxPages: MAX_PAGES,
          note: isDeepScan ? t("socialDashMoreMayExist", "more may exist") : t("socialDashMoreMayExistTryDeep", "more may exist, try Deep Scan")
        });
      }

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        // Scanning a mismatched username is allowed (read-only), but Delete must
        // stay disabled until the username field matches the authenticated
        // account again -- see updateUsernameMismatchState.
        deleteBtn.disabled = isUsernameMismatched();
        statusText.textContent = t("socialDashScanComplete", "Scan complete. Review results before deleting.");
        logActivity('sc-activity-log', (truncated || timelineCapped)
          ? t("socialDashLogScanCompleteTruncated", `Scan complete: ${currentResults.length} item(s) found (more may exist).`, [String(currentResults.length)])
          : t("socialDashLogScanComplete", `Scan complete: ${currentResults.length} item(s) found.`, [String(currentResults.length)]));
      } else {
        renderEmptyState(itemList, t("xDashNoMatches", "No posts matched your criteria. Try widening your text filter, or enable Deep Scan."));
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', t("socialDashLogScanComplete", "Scan complete: 0 item(s) found.", ["0"]));
      }
    } catch (err) {
      if (err.staleQueryId) queryIdsStale = true;
      // apiFetch already turned HTTP failures into a friendly message (see
      // friendlyXError); a network-level TypeError gets one here.
      const friendly = err.status || err.expiredAuth || err.userNotFound ? err.message : friendlyXError(err);
      await showAlert(t("socialDashScanFailed", `Scan failed: ${friendly}`, [friendly]));
      statusText.textContent = t("socialDashScanFailedStatus", "Scan failed. Nothing was deleted.");
      logActivity('sc-activity-log', t("socialDashScanFailed", `Scan failed: ${err.message}`, [err.message]), 'error');
    } finally {
      busy = false;
      scanBtn.disabled = false;
      if (archiveBtn) archiveBtn.disabled = false;
      resetCancelButton(cancelBtn);
      refreshExport();
    }
  });

  // ------------------------------------------------------------------
  // Import from X archive -- lists posts beyond the ~3200-post timeline cap.
  //
  // Account safety: the archive's tweets.js carries no author id, so it can't
  // prove which account it came from on its own. Deleting still rides the
  // CONNECTED session (X refuses to delete another account's posts), and on top
  // of that the import is only offered for deletion when:
  //   - the existing username guard passes (typed handle == connected handle),
  //     with the results pinned to that handle via scannedScreenName, AND
  //   - if tweet-headers.js was included, its user_id matches the connected
  //     account's id (a mismatch rejects the import outright); otherwise the
  //     user explicitly confirms the archive belongs to that handle.
  // ------------------------------------------------------------------
  async function connectedUserIdFor(handle) {
    if (userRestId && userRestIdForScreenName && userRestIdForScreenName.toLowerCase() === handle.toLowerCase()) {
      return userRestId;
    }
    if (!queryIdsExtracted || queryIdsStale) await extractQueryIds();
    const id = await resolveUserId(handle);
    userRestId = id;
    userRestIdForScreenName = handle;
    return id;
  }

  async function importArchive() {
    const files = archiveInput ? [...(archiveInput.files || [])] : [];
    if (files.length === 0) {
      await showAlert(t("xDashArchiveNoFiles", "Choose data/tweets.js (and any tweets-part1.js, ... files) or data/tweet-headers.js from your X archive first."));
      return;
    }
    const typed = usernameInput.value.trim().replace('@', '');
    const handle = authenticatedUsername || typed;
    if (!handle) {
      await showAlert(t("xDashEnterUsername", "Please enter your X username."));
      return;
    }
    if (authenticatedUsername && typed && typed.toLowerCase() !== authenticatedUsername.toLowerCase()) {
      await showAlert(t("xDashArchiveMismatch", `The username field doesn't match the connected account (@${authenticatedUsername}). Fix it before importing an archive.`, [`@${authenticatedUsername}`]));
      return;
    }

    busy = true;
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    archiveBtn.disabled = true;
    statusText.style.color = "";
    statusText.textContent = t("xDashArchiveReading", "Reading archive files...");
    try {
      const lists = [];
      const ownerIds = new Set();
      for (const file of files) {
        if (file.size > X_ARCHIVE_MAX_FILE_BYTES) {
          logActivity('sc-activity-log', t("xDashArchiveTooLarge", `${file.name}: too large to read here -- skipped.`, [file.name]), 'error');
          continue;
        }
        let parsed;
        try {
          parsed = parseXArchiveText(await file.text());
        } catch (_) {
          parsed = { ok: false, error: 'json' };
        }
        if (!parsed.ok) {
          const msg = parsed.error === 'unsupported'
            ? t("xDashArchiveUnsupported", `${file.name}: not a posts file (${parsed.name}) -- choose tweets.js or tweet-headers.js.`, [file.name, parsed.name])
            : t("xDashArchiveUnreadable", `${file.name}: couldn't read this as an X archive posts file -- skipped.`, [file.name]);
          logActivity('sc-activity-log', msg, 'error');
          continue;
        }
        parsed.ownerIds.forEach(id => ownerIds.add(id));
        lists.push(parsed.items);
        logActivity('sc-activity-log', t("xDashArchiveFileRead", `${file.name}: ${parsed.items.length} post(s) read, ${parsed.skipped} skipped.`, [file.name, String(parsed.items.length), String(parsed.skipped)]));
      }
      const all = mergeArchiveItems(lists);
      if (all.length === 0) {
        await showAlert(t("xDashArchiveEmpty", "No posts could be read from the chosen files. Choose data/tweets.js or data/tweet-headers.js from your X archive."));
        statusText.textContent = t("dashReady", "Ready");
        return;
      }

      // Verify the archive's account (see the comment block above).
      let connectedId = null;
      if (ownerIds.size > 0) {
        try { connectedId = await connectedUserIdFor(handle); } catch (e) {
          if (e && e.staleQueryId) queryIdsStale = true;
          connectedId = null;
        }
      }
      const ownerState = archiveOwnerCheck([...ownerIds], connectedId);
      if (ownerState === 'mismatch') {
        logActivity('sc-activity-log', t("xDashArchiveWrongAccount", `This archive belongs to a different X account than @${handle} -- import refused.`, [`@${handle}`]), 'error');
        await showAlert(t("xDashArchiveWrongAccount", `This archive belongs to a different X account than @${handle} -- import refused.`, [`@${handle}`]));
        statusText.textContent = t("dashReady", "Ready");
        return;
      }
      if (ownerState !== 'match') {
        const ok = await showConfirm(
          t("xDashArchiveConfirmOwner", `Is this archive from your own account, @${handle}? Only import an archive you downloaded from the account that's connected here.`, [`@${handle}`]),
          t("xDashArchiveConfirmTitle", "Confirm archive account"),
          { okLabel: t("xDashArchiveConfirmOk", "Yes, it's mine") }
        );
        if (!ok) {
          statusText.textContent = t("dashReady", "Ready");
          return;
        }
      }
      logActivity('sc-activity-log', ownerState === 'match'
        ? t("xDashArchiveVerified", `Archive account verified: matches @${handle}.`, [`@${handle}`])
        : t("xDashArchiveConfirmed", `Archive confirmed by you as @${handle}'s.`, [`@${handle}`]));

      const { raw, predicate } = buildScanPredicate();
      if (raw && all.some(item => item.textUnknown)) {
        logActivity('sc-activity-log', t("xDashArchiveTextFilterSkipped", "tweet-headers.js has no post text, so posts known only from it were left out while a text filter is set."), 'warn');
      }
      currentResults = all.filter(predicate);
      scannedScreenName = handle;
      updateUsernameMismatchState();
      // Keep the timeline-scan "stopped after N pages" note from bleeding in.
      formatScanCount(0, { truncated: false, keepTruncated: false });
      resultsCount.textContent = t("xDashArchiveCount", `${currentResults.length} of ${all.length} archived posts match`, [String(currentResults.length), String(all.length)]);
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        statusText.textContent = t("xDashArchiveReady", "Archive imported. Review results before deleting -- posts already deleted on X will show as failures.");
      } else {
        renderEmptyState(itemList, t("xDashArchiveNoMatches", "No archived posts matched your filters."));
        statusText.textContent = t("dashReady", "Ready");
      }
      logActivity('sc-activity-log', t("xDashArchiveCount", `${currentResults.length} of ${all.length} archived posts match`, [String(currentResults.length), String(all.length)]));
    } catch (err) {
      console.error('X archive import failed:', err);
      logActivity('sc-activity-log', t("xDashArchiveFailed", "Archive import failed. Nothing was deleted."), 'error');
      await showAlert(t("xDashArchiveFailed", "Archive import failed. Nothing was deleted."));
      statusText.textContent = t("xDashArchiveFailed", "Archive import failed. Nothing was deleted.");
    } finally {
      busy = false;
      scanBtn.disabled = false;
      archiveBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0 || isUsernameMismatched();
      refreshExport();
    }
  }
  if (archiveBtn) archiveBtn.addEventListener('click', importArchive);

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
    if (!(await confirmBulkDelete(selected.length, t("socialDashNounPosts", "posts")))) return;

    busy = true;
    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    if (archiveBtn) archiveBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = t("socialDashStartingDeletion", "Starting deletion...");

    const cancelController = createCancelController();
    activeDeleteCancel = cancelController;
    armCancelButton(cancelBtn, cancelController);

    const totalCount = selected.length;
    let deletedCount = 0;
    let failures = []; // { id, message, error }

    logActivity('sc-activity-log', t("socialDashLogDeleteStarted", `Delete started: ${totalCount} item(s) selected.`, [String(totalCount)]));
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        // strict 2.5 second delay to avoid rate limits and account suspension flags
        postItemDelayMs: 2500,
        deleteItem: async (tweet) => {
          try {
            // GraphQL DeleteTweet mutation -- or DeleteRetweet (keyed on the
            // source post's id) for a repost; see buildXDeleteRequest.
            graphqlBase(xDeleteOperation(tweet)); // re-validates/falls back the id
            const request = buildXDeleteRequest(tweet, queryIds);
            if (!request) {
              const badId = new Error(friendlyXError({ staleQueryId: true }));
              badId.staleQueryId = true;
              throw badId;
            }

            const result = await apiFetch(request.url, 'POST', request.body);

            // apiFetch only throws on a non-2xx HTTP status; a GraphQL mutation
            // can still come back HTTP 200 with a body-level failure -- the most
            // important finding of the audit that prompted this fix. See
            // deleteTweetFailureFromResult above for what counts as a real success.
            const failureMessage = request.operation === 'DeleteRetweet'
              ? deleteRetweetFailureFromResult(result)
              : deleteTweetFailureFromResult(result);
            if (failureMessage) throw new Error(failureMessage);
          } catch (err) {
            // Isolate this item's failure so a single bad tweet (400/403/network
            // error) doesn't abort the rest of the batch (runDeleteLoop still
            // records it and decides whether to stop, via err.expiredAuth).
            console.error(`Failed to delete post ${tweet.id}:`, err);
            if (err.staleQueryId) queryIdsStale = true;
            // DeleteRetweet's id is scraped/defaulted separately from DeleteTweet's;
            // a stale one must only fail the reposts, not stop ordinary posts that
            // would delete fine (staleQueryId makes runDeleteLoop stop the run).
            if (err.staleQueryId && xDeleteOperation(tweet) === 'DeleteRetweet') {
              const repostErr = new Error(err.message);
              repostErr.status = err.status;
              repostErr.repostStaleQueryId = true;
              throw repostErr;
            }
            throw err;
          }
        }
      });
      deletedCount = result.deletedCount;
      failures = result.failures;
      const { succeededItems, expiredAuth, rateLimited, cancelled } = result;
      const staleQueryIdSuspected = failures.some(f => f.error && (f.error.staleQueryId || f.error.repostStaleQueryId));

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
        itemList.textContent = '';
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });

      const done = String(deletedCount);
      const total = String(totalCount);
      if (expiredAuth) {
        statusText.textContent = t("socialDashSessionInvalidStatus", "Session invalid -- reconnect required.");
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', t("socialDashLogDeleteSessionInvalid", `Delete stopped: session invalid (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(t("socialDashExpiredAuthAlert", `Stopped: your X session appears to be invalid or expired. ${done} of ${total} items were deleted before this happened. Reconnect X from the extension popup to finish.`, ["X", done, total]));
      } else if (rateLimited) {
        statusText.textContent = t("socialDashRateLimitedStatus", "Rate limited by X -- stopped early.", ["X"]);
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        const lastRetry = failures.length ? failures[failures.length - 1].error?.retryAfterMs : null;
        const mins = lastRetry ? String(Math.max(1, Math.ceil(lastRetry / 60000))) : null;
        logActivity('sc-activity-log', t("socialDashLogDeleteRateLimited", `Delete stopped: repeated rate limiting (429) (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(
          t("socialDashRateLimitedAlert", `Stopped: X rate-limited several delete requests in a row. ${done} of ${total} items were deleted before this happened.`, ["X", done, total]) + ' ' +
          (mins
            ? t("socialDashRetryInMinutes", `Try again in about ${mins} minute(s).`, [mins])
            : t("socialDashRetryLater", "Wait a while, then try again."))
        );
      } else if (cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${done} of ${total} processed.`, [done, total]);
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', t("socialDashLogDeleteCancelled", `Delete cancelled: ${done}/${total} processed.`, [done, total]), 'warn');
      } else if (failures.length === 0) {
        statusText.textContent = t("socialDashDeletionComplete", "Deletion complete!");
        statusText.style.color = "#10b981";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
        logActivity('sc-activity-log', t("socialDashLogDeleteComplete", `Delete complete: ${done}/${total} deleted.`, [done, total]));
      } else {
        const failed = String(failures.length);
        statusText.textContent = t("socialDashDeletionFinishedFailures", `Deletion finished: ${done} deleted, ${failed} failed out of ${total}.`, [done, failed, total]);
        statusText.style.color = "#ef4444";
        if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));

        const shown = failures.slice(0, 10).map(f => `#${f.id}: ${f.message}`).join('\n');
        const more = failures.length > 10
          ? '\n' + t("socialDashMoreFailures", `...and ${failures.length - 10} more (see the browser console for the full list)`, [String(failures.length - 10)])
          : '';
        const hint = staleQueryIdSuspected ? '\n\n' + friendlyXError({ staleQueryId: true }) : '';
        logActivity('sc-activity-log', t("socialDashDeletionFinishedFailures", `Deletion finished: ${done} deleted, ${failed} failed out of ${total}.`, [done, failed, total]), 'warn');
        await showAlert(t("socialDashDeleteFailedList", `Delete failed for ${failed} of ${total} item(s):`, [failed, total]) + `\n\n${shown}${more}${hint}`);
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
      const friendly = err.status ? err.message : friendlyXError(err);
      logActivity('sc-activity-log', t("socialDashLogDeleteUnexpected", `Delete stopped unexpectedly: ${err.message}`, [err.message]), 'error');
      await showAlert(t("socialDashDeleteStoppedAlert",
        `Deletion stopped unexpectedly: ${friendly}\n\n${progress.deletedCount} of ${totalCount} items were deleted before this happened. Scan again to see what's left.`,
        [friendly, String(progress.deletedCount), String(totalCount)]));
      statusText.textContent = t("socialDashDeleteStoppedStatus", "Deletion stopped unexpectedly -- scan again to see what's left.");
      statusText.style.color = "#ef4444";
    } finally {
      activeDeleteCancel = null;
      busy = false;
      scanBtn.disabled = false;
      if (archiveBtn) archiveBtn.disabled = false;
      refreshExport();
      deleteBtn.disabled = currentResults.length === 0 || isUsernameMismatched();
      resetCancelButton(cancelBtn);
    }
  });
});
