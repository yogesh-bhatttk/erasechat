// Reddit's own listing size cap: every user listing (overview/comments/submitted,
// under any sort) stops handing out an `after` cursor at roughly 1000 items, no
// matter how much older history the account really has. A listing that ends
// "naturally" (no `after`) after at least this many raw children almost certainly
// hit that cap rather than the true end of the account's history -- the scan must
// say so instead of presenting ~1000 items as a complete result.
const REDDIT_LISTING_CAP = 1000;
const REDDIT_LISTING_CAP_THRESHOLD = 900;
// Reddit's maximum page size for listings (it silently clamps anything larger).
const REDDIT_LISTING_PAGE_SIZE = 100;

// The listings a scan walks, in order. A normal scan reads only `new` (your
// newest ~1000). Deep Scan additionally sweeps top/controversial (all time) and
// hot -- each is its own ~1000-item window over the same history, so together
// they can surface older items that `new` alone can never reach. Results are
// de-duplicated by fullname across sweeps.
function redditListingSweeps(isDeepScan) {
  const sweeps = [{ sort: 'new' }];
  if (isDeepScan) {
    sweeps.push({ sort: 'top', t: 'all' }, { sort: 'controversial', t: 'all' }, { sort: 'hot' });
  }
  return sweeps;
}

// Pure: builds one listing page URL. raw_json=1 makes Reddit return body/title
// text unescaped (otherwise "&amp;"/"&lt;" leak into the preview and the filter).
function buildRedditListingUrl(username, targetType, sweep, after) {
  const path = targetType === 'comments' ? 'comments' : targetType === 'submitted' ? 'submitted' : 'overview';
  const params = new URLSearchParams({ limit: String(REDDIT_LISTING_PAGE_SIZE), raw_json: '1', sort: sweep.sort });
  if (sweep.t) params.set('t', sweep.t);
  if (after) params.set('after', after);
  return `https://www.reddit.com/user/${encodeURIComponent(username)}/${path}.json?${params.toString()}`;
}

// Pure: true when a listing that ended without an `after` cursor most likely ended
// because of Reddit's ~1000-item cap rather than the account's real history.
function isRedditListingCapped(rawCount, after) {
  return !after && rawCount >= REDDIT_LISTING_CAP_THRESHOLD;
}

// Pure: a reddit.com permalink built ONLY from validated base-36 ids (never from a
// server-supplied URL string), or null if the ids don't validate.
function buildRedditPermalink(item) {
  const ID36 = /^[a-z0-9]+$/i;
  if (!item || typeof item.name !== 'string') return null;
  const [kind, id] = item.name.split('_');
  if (!id || !ID36.test(id)) return null;
  if (kind === 't3') return `https://www.reddit.com/comments/${id}/`;
  if (kind === 't1') {
    const linkId = typeof item.link_id === 'string' ? item.link_id.replace(/^t3_/, '') : '';
    if (!linkId || !ID36.test(linkId)) return null;
    return `https://www.reddit.com/comments/${linkId}/_/${id}/`;
  }
  return null;
}

// Values of `removed_by_category` that mean the AUTHOR already deleted it --
// nothing left to clean up. Every other value (moderator, automod_filtered,
// reddit, anti_evil_ops, ...) is a removal by someone else, which hides the item
// from others but leaves it on the account: the author can (and usually wants
// to) still delete it.
const REDDIT_AUTHOR_DELETED_CATEGORIES = new Set(['deleted', 'author']);

// Pure: given one page's raw `children` (from Reddit's overview/comments/submitted
// listing JSON) and the lowercased filter text, returns the result objects to add to
// currentResults. Extracted to module scope (mirroring dashboard-x.js's
// extractTweetsFromEntries) so the "what counts as a real, still-deletable item"
// logic -- skipping already-deleted items and "more"-type stub children,
// telling a comment from a post, applying the text filter -- is unit-tested
// directly instead of only reachable through a live scan. See
// tests/reddit-dashboard.test.js.
//
// `filter` is either the legacy lowercased substring (string; '' = no filter) or
// a matcher from platform-filters.js's buildTextMatcher() ({ test(text) }), which
// adds /regex/ and invert support. Matching is against the same text either way.
function redditTextPasses(filter, text) {
  if (!filter) return true;
  if (typeof filter === 'object' && typeof filter.test === 'function') return filter.test(text || '');
  return (text || '').toLowerCase().includes(String(filter));
}

function extractRedditItemsFromChildren(children, filterText, seenIds) {
  const results = [];
  for (const child of children) {
    const item = child.data;
    if (!item || !item.name) continue; // e.g. a "more"-type stub child, not a real post/comment
    // Skip items the author already deleted -- nothing left to clean up. Items
    // removed by a moderator/Reddit are NOT skipped (see
    // REDDIT_AUTHOR_DELETED_CATEGORIES): they're still on the account.
    if (item.author === '[deleted]' || REDDIT_AUTHOR_DELETED_CATEGORIES.has(item.removed_by_category)) continue;
    // Defensive de-dup: without this, a repeated/overlapping `after` page (a
    // stuck cursor, new activity shifting the listing mid-scan, or the same item
    // showing up in several Deep Scan sort sweeps) shows the same post/comment
    // twice, inflating "N items found" and issuing a redundant delete request
    // for it later. Mirrors dashboard-x.js's seenTweetIds guard.
    if (seenIds) {
      if (seenIds.has(item.name)) continue;
      seenIds.add(item.name);
    }
    const isComment = item.name.startsWith('t1_');
    const text = isComment ? item.body : item.title;
    if (!redditTextPasses(filterText, text)) continue;
    results.push({
      id: item.name, // e.g. t1_xxxx or t3_xxxx
      type: isComment ? 'Comment' : 'Post',
      text: text,
      subreddit: item.subreddit_name_prefixed,
      time: item.created_utc * 1000, // Convert to ms
      // Listing score (upvotes), kept for the "keep items with at least N
      // upvotes" filter and for export. null when Reddit didn't send one.
      score: Number.isFinite(item.score) ? item.score : null,
      // Only comments and self (text) posts have editable text -- link posts
      // can't be overwritten, only deleted.
      isSelf: !isComment && item.is_self === true,
      removed: !!item.removed_by_category,
      permalink: buildRedditPermalink(item)
    });
  }
  return results;
}

// Pure: given the parsed JSON body of a POST to /api/del, returns an error
// message string if the body signals the delete did NOT actually happen (an
// explicit errors/json.errors array, or any other unexpected non-empty body --
// Reddit's own real success response is an empty `{}`), or null if the body
// looks like a genuine success. HTTP status alone was never enough to know a
// delete actually happened -- the most important finding of the audit that
// added this check. Extracted to module scope (mirroring
// extractRedditItemsFromChildren above) so it's unit tested directly instead
// of only reachable through a live delete. See tests/reddit-dashboard.test.js.
function redditDeleteFailureFromBody(body) {
  const errors = (body && body.json && body.json.errors) || (body && body.errors);
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors.map(e => Array.isArray(e) ? e.join(': ') : String(e)).join('; ');
    return t("redditDashDeleteRejected", `Reddit rejected the delete: ${detail}`, [detail]);
  }
  if (body && typeof body === 'object' && Object.keys(body).length > 0) {
    const raw = JSON.stringify(body);
    return t("redditDashDeleteUnconfirmed", `Reddit did not confirm the delete (unexpected response: ${raw}).`, [raw]);
  }
  return null;
}

// Pure: Reddit's x-ratelimit-reset header is "seconds until the window resets".
// Returns ms, or null if absent/unparseable.
function redditRetryAfterMs(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('x-ratelimit-reset') : null;
  const secs = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs) * 1000 : null;
}

// Maps a failed request to a friendly, actionable, localized sentence instead of
// a bare "API Error 403". `err.status` is set by this file's own throws; a
// thrown TypeError with no status is fetch() itself failing (offline/DNS).
function friendlyRedditError(err) {
  const status = err && err.status;
  if (!status) {
    if (err && err.name === 'TypeError') return t("socialDashErrNetwork", "Couldn't reach Reddit. Check your internet connection and try again.", ["Reddit"]);
    return (err && err.message) || t("socialDashErrUnknown", "Something unexpected went wrong. Try again.");
  }
  if (status === 401 || status === 403) return t("socialDashErrAuth", "Reddit rejected the request -- your session may have expired. Log in on Reddit, reconnect it from the extension popup, and try again.", ["Reddit"]);
  if (status === 404) return t("redditDashErrNotFound", "Reddit couldn't find that account's history. Check that you're still logged in as the connected user, then reconnect.");
  if (status === 429) {
    if (err.retryAfterMs) {
      const mins = String(Math.max(1, Math.ceil(err.retryAfterMs / 60000)));
      return t("socialDashErrRateLimitedFor", `Reddit is rate-limiting requests. Try again in about ${mins} minute(s).`, ["Reddit", mins]);
    }
    return t("socialDashErrRateLimited", "Reddit is rate-limiting requests. Wait a few minutes and try again.", ["Reddit"]);
  }
  if (status >= 500) return t("socialDashErrServer", `Reddit is having trouble right now (HTTP ${status}). Try again in a few minutes.`, ["Reddit", String(status)]);
  return t("socialDashErrGeneric", `Reddit returned an unexpected error (HTTP ${status}). Try again; if it keeps happening, reconnect from the extension popup.`, ["Reddit", String(status)]);
}

// ============================================================
// Date-bounded early stop for the `new` listing
// ============================================================

// Pure: true when a page of the newest-first `new` listing already reached items
// older than the "From" date -- every later page is older still, so the scan can
// stop paginating that listing. Only valid for sort=new (top/controversial/hot
// aren't chronological). Uses the page's oldest created_utc, not just the last
// child, so a pinned/out-of-order child can't trigger a premature stop.
function redditPageReachedFromDate(sweep, children, fromMs) {
  if (!sweep || sweep.sort !== 'new' || fromMs == null || !Array.isArray(children)) return false;
  let oldest = Infinity;
  for (const child of children) {
    const created = child && child.data && child.data.created_utc;
    if (Number.isFinite(created) && created * 1000 < oldest) oldest = created * 1000;
  }
  return oldest !== Infinity && oldest < fromMs;
}

// ============================================================
// Overwrite-then-delete (opt-in)
// ============================================================

const REDDIT_EDIT_URL = 'https://www.reddit.com/api/editusertext';
const REDDIT_OVERWRITE_DEFAULT_TEXT = '.';
// Reddit's own limit for a comment body is 10,000 characters.
const REDDIT_OVERWRITE_MAX_LENGTH = 10000;
// Pause between the edit and the delete of the same item.
const REDDIT_EDIT_TO_DELETE_DELAY_MS = 1000;

// Pure: the replacement text to write, falling back to "." for empty input and
// capped to Reddit's length limit.
function normalizeRedditOverwriteText(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return (text || REDDIT_OVERWRITE_DEFAULT_TEXT).slice(0, REDDIT_OVERWRITE_MAX_LENGTH);
}

// Pure: only comments (t1_) and self/text posts (t3_ with isSelf) have editable
// text. Link posts can't be edited -- they're only deleted.
function isRedditItemEditable(item) {
  if (!item || typeof item.id !== 'string') return false;
  if (item.id.startsWith('t1_')) return true;
  return item.id.startsWith('t3_') && item.isSelf === true;
}

// Pure: the x-www-form-urlencoded body for POST /api/editusertext.
function buildRedditEditBody(fullname, text, modhash) {
  const form = new URLSearchParams();
  form.append('api_type', 'json');
  form.append('thing_id', fullname);
  form.append('text', text);
  form.append('uh', modhash);
  return form.toString();
}

// Pure: given the parsed JSON body of /api/editusertext (api_type=json), returns
// an error message if the edit did NOT happen, or null on success. Reddit
// answers an edit with { json: { errors: [], data: { things: [...] } } } -- a
// non-empty json.errors, a top-level errors array, or a body without the
// `json` envelope at all all mean the edit wasn't confirmed.
function redditEditFailureFromBody(body) {
  const errors = (body && body.json && body.json.errors) || (body && body.errors);
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors.map(e => Array.isArray(e) ? e.join(': ') : String(e)).join('; ');
    return t("redditDashEditRejected", `Reddit rejected the overwrite: ${detail}`, [detail]);
  }
  if (!body || typeof body !== 'object' || !body.json || typeof body.json !== 'object') {
    return t("redditDashEditUnconfirmed", "Reddit did not confirm the overwrite.");
  }
  return null;
}

// ============================================================
// Import from Reddit's data export (GDPR "Request data" archive)
// ============================================================

const REDDIT_ID36 = /^[a-z0-9]+$/i;

// Pure: index of the first header matching any of `names`, case-insensitively
// and ignoring surrounding whitespace; -1 if none.
function findCsvColumn(headers, names) {
  const wanted = names.map(n => n.toLowerCase());
  for (let i = 0; i < headers.length; i++) {
    if (wanted.includes(String(headers[i] || '').trim().toLowerCase())) return i;
  }
  return -1;
}

// Pure: Reddit export dates look like "2023-01-15 12:34:56 UTC" (sometimes
// ISO). Returns ms or null.
function parseRedditExportDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let iso = s.replace(/\s+UTC$/i, 'Z');
  if (/^\d{4}-\d{2}-\d{2} \d/.test(iso)) iso = iso.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(iso)) iso += 'Z'; // no zone -> export is UTC
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Pure: "r/name" for a plain subreddit name, unchanged if already prefixed.
function normalizeRedditSubreddit(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(r|u)\//i.test(s)) return s;
  return `r/${s}`;
}

// Pure: the base-36 post id from a reddit.com ".../comments/<id>/..." URL, or ''.
function redditPostIdFromUrl(url) {
  const m = /\/comments\/([a-z0-9]+)(?:[/?#]|$)/i.exec(String(url || ''));
  return m ? m[1] : '';
}

// Pure: decides comments vs posts from the file name, falling back to headers
// (posts.csv has a `title` column, comments.csv doesn't).
function detectRedditExportKind(fileName, headers) {
  const name = String(fileName || '').toLowerCase();
  if (/(^|[\\/])comments\.csv$/.test(name)) return 'comments';
  if (/(^|[\\/])posts\.csv$/.test(name)) return 'posts';
  if (findCsvColumn(headers, ['title']) !== -1) return 'posts';
  if (findCsvColumn(headers, ['body']) !== -1) return 'comments';
  return null;
}

// Pure: turns one parsed export CSV (rows from parseCsv, header first) into
// result items shaped like a scan's. Returns { kind, items, skipped, error }
// where error is 'empty' | 'no-id' | 'unknown-kind' | null. Item ids are only
// ever built from validated base-36 ids; permalinks only from validated ids.
function mapRedditExportRows(rows, fileName) {
  const out = { kind: null, items: [], skipped: 0, error: null };
  if (!Array.isArray(rows) || rows.length === 0) { out.error = 'empty'; return out; }
  const headers = rows[0].map(h => String(h || '').replace(/^﻿/, ''));
  const kind = detectRedditExportKind(fileName, headers);
  if (!kind) { out.error = 'unknown-kind'; return out; }
  out.kind = kind;
  const col = {
    id: findCsvColumn(headers, ['id']),
    date: findCsvColumn(headers, ['date', 'created', 'created_utc']),
    subreddit: findCsvColumn(headers, ['subreddit']),
    body: findCsvColumn(headers, ['body']),
    title: findCsvColumn(headers, ['title']),
    url: findCsvColumn(headers, ['url']),
    link: findCsvColumn(headers, ['link']),
    permalink: findCsvColumn(headers, ['permalink'])
  };
  if (col.id === -1) { out.error = 'no-id'; return out; }
  const cell = (row, i) => (i === -1 || i >= row.length) ? '' : String(row[i] == null ? '' : row[i]);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.every(c => !String(c || '').trim())) continue; // blank line
    const id = cell(row, col.id).trim().replace(/^t[13]_/i, '');
    if (!id || !REDDIT_ID36.test(id)) { out.skipped++; continue; }
    const body = cell(row, col.body);
    const subreddit = normalizeRedditSubreddit(cell(row, col.subreddit));
    const time = parseRedditExportDate(cell(row, col.date));
    if (kind === 'comments') {
      const postId = redditPostIdFromUrl(cell(row, col.link)) || redditPostIdFromUrl(cell(row, col.permalink));
      out.items.push({
        id: `t1_${id}`,
        type: 'Comment',
        text: body,
        subreddit,
        time,
        score: null,
        isSelf: false,
        removed: false,
        fromExport: true,
        permalink: buildRedditPermalink({ name: `t1_${id}`, link_id: postId ? `t3_${postId}` : '' })
      });
    } else {
      const title = cell(row, col.title);
      const url = cell(row, col.url);
      // A self post either has body text or its `url` points back at its own
      // comments page; anything else is a link post (not editable).
      const isSelf = body.trim() !== '' || redditPostIdFromUrl(url).toLowerCase() === id.toLowerCase();
      out.items.push({
        id: `t3_${id}`,
        type: 'Post',
        text: title || body,
        subreddit,
        time,
        score: null,
        isSelf,
        removed: false,
        fromExport: true,
        permalink: buildRedditPermalink({ name: `t3_${id}` })
      });
    }
  }
  return out;
}

// Pure: concatenates item lists, keeping the first occurrence of each fullname.
function dedupeRedditItems(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// Pure: the target-type select applied to imported items.
function redditItemMatchesTarget(item, targetType) {
  if (targetType === 'comments') return item.id.startsWith('t1_');
  if (targetType === 'submitted') return item.id.startsWith('t3_');
  return true;
}

// Accessors for platform-filters.js's passesAdvancedFilters().
const REDDIT_FILTER_ACCESSORS = {
  time: i => (Number.isFinite(i.time) ? i.time : null),
  score: i => (Number.isFinite(i.score) ? i.score : null)
};

// Columns for platform-filters.js's export buttons. Headers are kept as stable
// machine-readable English names (the file is data, not UI).
const REDDIT_EXPORT_COLUMNS = [
  { label: 'type', get: i => i.type },
  { label: 'subreddit', get: i => i.subreddit || '' },
  { label: 'date', get: i => (Number.isFinite(i.time) ? new Date(i.time).toISOString() : '') },
  { label: 'score', get: i => (Number.isFinite(i.score) ? i.score : '') },
  { label: 'text', get: i => i.text || '' },
  { label: 'permalink', get: i => i.permalink || '' }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractRedditItemsFromChildren,
    redditDeleteFailureFromBody,
    redditListingSweeps,
    buildRedditListingUrl,
    isRedditListingCapped,
    buildRedditPermalink,
    redditRetryAfterMs,
    friendlyRedditError,
    redditTextPasses,
    redditPageReachedFromDate,
    normalizeRedditOverwriteText,
    isRedditItemEditable,
    buildRedditEditBody,
    redditEditFailureFromBody,
    findCsvColumn,
    parseRedditExportDate,
    normalizeRedditSubreddit,
    redditPostIdFromUrl,
    detectRedditExportKind,
    mapRedditExportRows,
    dedupeRedditItems,
    redditItemMatchesTarget,
    REDDIT_FILTER_ACCESSORS,
    REDDIT_EXPORT_COLUMNS,
    REDDIT_EDIT_URL,
    REDDIT_LISTING_CAP,
    REDDIT_LISTING_PAGE_SIZE
  };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['reddit_modhash']),
    chrome.storage.local.get(['reddit_username'])
  ]);
  // connect-reddit.js only ever stores a non-empty modhash (an empty one can't
  // authorize /api/del, so connect fails clearly instead) -- so "missing" and
  // "empty" both genuinely mean "not linked" here.
  if (typeof sessionData.reddit_modhash !== 'string' || !sessionData.reddit_modhash || !localData.reddit_username) {
    await showAlert(t("socialDashNotLinked", "Not connected to Reddit. Connect it from the extension popup first.", ["Reddit"]));
    window.close();
    return;
  }

  const { reddit_modhash: modhash } = sessionData;
  const { reddit_username: username } = localData;
  document.getElementById('connected-as').textContent = t("dashConnectedAs", `(Connected: u/${username})`, [`u/${username}`]);

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const targetTypeInput = document.getElementById('target-type');
  const deepScanInput = document.getElementById('deep-scan');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');
  const importInput = document.getElementById('import-files');
  const importLabel = document.getElementById('import-label');
  const overwriteToggle = document.getElementById('overwrite-toggle');
  const overwriteTextGroup = document.getElementById('overwrite-text-group');
  const overwriteTextInput = document.getElementById('overwrite-text');

  // platform-filters.js (loaded before this file) provides the date/invert/
  // keep-min filters and the export buttons. Guarded so a missing shared file
  // degrades to the plain keyword filter instead of breaking the dashboard.
  const hasAdvancedFilters = typeof mountAdvancedFilters === 'function' && typeof readAdvancedFilters === 'function'
    && typeof buildTextMatcher === 'function' && typeof passesAdvancedFilters === 'function';
  if (hasAdvancedFilters) {
    mountAdvancedFilters({ keepMinLabel: t("redditDashKeepMinLabel", "Keep items with at least N upvotes") });
  }
  let currentResults = [];
  const exportControls = typeof mountExportButtons === 'function'
    ? mountExportButtons({ platform: 'reddit', columns: REDDIT_EXPORT_COLUMNS, getItems: () => currentResults })
    : { refresh() {} };

  overwriteToggle.addEventListener('change', () => {
    overwriteTextGroup.hidden = !overwriteToggle.checked;
  });

  // One busy flag for scan / import / delete so none of them can start while
  // another is running.
  function setBusy(busy) {
    scanBtn.disabled = busy;
    importInput.disabled = busy;
    importLabel.setAttribute('aria-disabled', busy ? 'true' : 'false');
    if (busy) deleteBtn.disabled = true;
  }

  // Reads the filter form once per scan/import: { matcher, filters }.
  function readRedditFilters() {
    const raw = filterInput.value.trim();
    if (!hasAdvancedFilters) {
      return { raw, matcher: raw.toLowerCase(), filters: null };
    }
    const filters = readAdvancedFilters();
    const matcher = buildTextMatcher(raw, filters.invert);
    if (matcher.warning) {
      logActivity('sc-activity-log', matcher.warning === 'unsafe'
        ? t("redditDashRegexUnsafe", "That /regex/ could be very slow, so it's matched as plain text instead.")
        : t("redditDashRegexInvalid", "That /regex/ isn't valid, so it's matched as plain text instead."), 'warn');
    }
    const summary = typeof describeActiveFilters === 'function' ? describeActiveFilters(filters) : '';
    if (summary) logActivity('sc-activity-log', summary);
    return { raw, matcher, filters };
  }

  function passesRedditAdvanced(item, filters) {
    return !filters || passesAdvancedFilters(item, filters, REDDIT_FILTER_ACCESSORS);
  }

  const DELETE_PROGRESS_KEY = 'reddit_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  // Whether the last scan's `new` listing ran into Reddit's ~1000-item cap (see
  // isRedditListingCapped) -- kept so the post-delete count can repeat the note.
  let lastScanCapped = false;
  let lastScanDeep = false;

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-reddit.html.

  // `afterDelete` re-renders the count for the items still listed: it must keep
  // the scan's "stopped after N pages" note (formatScanCount's keepTruncated)
  // instead of being treated as a fresh, complete scan.
  function renderCount(count, { truncated = false, maxPages = 0, afterDelete = false } = {}) {
    if (lastScanCapped) {
      resultsCount.textContent = lastScanDeep
        ? t("redditDashScanCountCappedDeep", `${count} items found -- Reddit only lists ~1000 items per listing. Deep Scan also checked your top, controversial and hot listings, but older items may still exist.`, [String(count)])
        : t("redditDashScanCountCapped", `${count} items found -- Reddit only lists your newest ~1000 items per listing; older items may exist. Try Deep Scan to reach more.`, [String(count)]);
      return;
    }
    if (afterDelete) {
      resultsCount.textContent = formatScanCount(count, { truncated: false, keepTruncated: true });
      return;
    }
    resultsCount.textContent = formatScanCount(count, {
      truncated,
      maxPages,
      note: lastScanDeep
        ? t("socialDashMoreMayExist", "more may exist")
        : t("socialDashMoreMayExistTryDeep", "more may exist, try Deep Scan")
    });
  }

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a partial/cancelled/selective delete leaves some scanned items
  // un-deleted -- those stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    visibleRows(items).forEach(item => {
      const div = document.createElement('div');
      div.className = 'post-item';
      const badgeClass = item.type === 'Comment' ? 'badge-comment' : 'badge-post';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      const badge = document.createElement('span');
      badge.className = `badge ${badgeClass}`;
      badge.textContent = item.type === 'Comment'
        ? t("redditDashTypeComment", "Comment")
        : t("redditDashTypePost", "Post");
      timeDiv.appendChild(badge);
      if (item.fromExport) {
        const exportBadge = document.createElement('span');
        exportBadge.className = 'badge badge-export';
        exportBadge.textContent = t("redditDashFromExportLabel", "from export");
        exportBadge.title = t("redditDashFromExportHint", "Imported from your Reddit data export -- it may already be deleted on Reddit.");
        timeDiv.appendChild(document.createTextNode(' '));
        timeDiv.appendChild(exportBadge);
      }
      if (item.removed) {
        const removedBadge = document.createElement('span');
        removedBadge.className = 'badge badge-removed';
        removedBadge.textContent = t("redditDashRemovedLabel", "removed");
        removedBadge.title = t("redditDashRemovedHint", "Removed by a moderator or Reddit -- hidden from others, but still on your account until you delete it.");
        timeDiv.appendChild(document.createTextNode(' '));
        timeDiv.appendChild(removedBadge);
      }
      const when = Number.isFinite(item.time)
        ? new Date(item.time).toLocaleString()
        : t("redditDashUnknownDate", "unknown date");
      timeDiv.appendChild(document.createTextNode(
        ' ' + t("redditDashRowMeta", `in ${item.subreddit} on ${when}`, [item.subreddit || '', when])
      ));

      const textDiv = document.createElement('div');
      textDiv.textContent = item.text;

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, item, rowCheckboxes);
      // Appended after addRowCheckbox so the checkbox's aria-label (built from
      // the row's text) doesn't include "Open". item.permalink is built only
      // from validated ids (buildRedditPermalink), never a server URL string.
      if (item.permalink) {
        const link = document.createElement('a');
        link.className = 'post-open-link';
        link.href = item.permalink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t("socialDashOpenLink", "Open");
        link.setAttribute('aria-label', t("socialDashOpenLinkAria", "Open on Reddit in a new tab", ["Reddit"]));
        timeDiv.appendChild(document.createTextNode(' '));
        timeDiv.appendChild(link);
      }
      itemList.appendChild(div);
    });
    appendHiddenRowsNote(itemList, items.length);
    wireSelectAll(selectAllBox, items, rowCheckboxes);
    exportControls.refresh();
  }

  scanBtn.addEventListener('click', async () => {
    const targetType = targetTypeInput.value;
    const isDeepScan = deepScanInput.checked;
    const filterText = filterInput.value.trim();
    const { matcher, filters } = readRedditFilters();
    const fromMs = filters ? filters.fromMs : null;

    setBusy(true);
    statusText.style.color = "";
    statusText.textContent = t("dashScanning", "Scanning...");
    renderEmptyState(itemList, t("redditDashScanningHistory", "Scanning your Reddit history..."));
    currentResults = [];
    exportControls.refresh();
    lastScanCapped = false;
    lastScanDeep = isDeepScan;
    logActivity('sc-activity-log', filterText
      ? t("socialDashLogScanStartedFilter", `Scan started (filter: "${filterText}").`, [filterText])
      : t("socialDashLogScanStarted", "Scan started."));

    try {
      const seenIds = new Set();
      const sweeps = redditListingSweeps(isDeepScan);
      // 100 items/page: 12 pages comfortably covers one ~1000-item listing.
      // This is a safety bound, not the expected stop -- Reddit itself stops
      // handing out `after` at the cap.
      const MAX_PAGES_PER_LISTING = 12;
      let truncated = false;
      let totalPages = 0;

      for (let s = 0; s < sweeps.length; s++) {
        const sweep = sweeps[s];
        let after = '';
        let pageCount = 0;
        let rawCount = 0;
        // Stuck-cursor guard, per listing: if Reddit keeps returning pages whose
        // items were all already seen IN THIS LISTING (an overlapping/non-
        // advancing `after`), stop it. Checked against this listing's own set,
        // not the global seenIds -- a Deep Scan sweep of `top` legitimately
        // returns mostly items `new` already found, and that must not be
        // mistaken for a stuck cursor.
        const listingSeen = new Set();
        let consecutiveEmptyPages = 0;
        const MAX_CONSECUTIVE_EMPTY_PAGES = 3;
        let stuckCursor = false;
        let reachedFromDate = false;

        while (pageCount < MAX_PAGES_PER_LISTING) {
          const response = await fetchWithRetry(buildRedditListingUrl(username, targetType, sweep, after), { credentials: "include" });
          if (!response.ok) {
            const httpErr = new Error(`HTTP ${response.status}`);
            httpErr.status = response.status;
            httpErr.retryAfterMs = response.status === 429 ? redditRetryAfterMs(response.headers) : null;
            throw httpErr;
          }

          const resJson = await response.json();
          const children = resJson.data?.children || [];
          if (children.length === 0) { after = ''; break; }
          rawCount += children.length;

          const listingSeenBefore = listingSeen.size;
          for (const child of children) if (child.data?.name) listingSeen.add(child.data.name);
          currentResults.push(...extractRedditItemsFromChildren(children, matcher, seenIds)
            .filter(item => passesRedditAdvanced(item, filters)));
          consecutiveEmptyPages = (listingSeen.size === listingSeenBefore) ? consecutiveEmptyPages + 1 : 0;
          if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) {
            stuckCursor = true;
            break;
          }

          after = resJson.data.after || '';
          pageCount++;
          totalPages++;
          statusText.textContent = t("redditDashScanningProgress",
            `Scanning listing ${s + 1} of ${sweeps.length}... (page ${pageCount}, ${currentResults.length} found)`,
            [String(s + 1), String(sweeps.length), String(pageCount), String(currentResults.length)]);
          if (!after) break;
          // `new` is newest-first: once a page reaches items older than the
          // From date, every later page is older still -- stop this listing.
          if (redditPageReachedFromDate(sweep, children, fromMs)) { reachedFromDate = true; break; }
          await delay(1000); // 1s between pagination requests
        }

        // Only the primary `new` listing decides whether to warn about the cap
        // -- it's the one that defines "your newest ~1000".
        // A listing we stopped early on purpose (date bound reached) is
        // complete for the chosen range -- neither capped nor truncated.
        if (!reachedFromDate) {
          if (s === 0 && isRedditListingCapped(rawCount, after)) lastScanCapped = true;
          if (stuckCursor || (pageCount >= MAX_PAGES_PER_LISTING && after)) truncated = true;
        }

        // Conservative pacing between Deep Scan sweeps.
        if (s < sweeps.length - 1) await delay(2000);
      }

      renderCount(currentResults.length, { truncated, maxPages: totalPages });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = t("socialDashScanComplete", "Scan complete. Review results before deleting.");
        logActivity('sc-activity-log', (truncated || lastScanCapped)
          ? t("socialDashLogScanCompleteTruncated", `Scan complete: ${currentResults.length} item(s) found (more may exist).`, [String(currentResults.length)])
          : t("socialDashLogScanComplete", `Scan complete: ${currentResults.length} item(s) found.`, [String(currentResults.length)]));
      } else {
        renderEmptyState(itemList, t("redditDashNoItems", "No items found. Try widening your filters, or enable Deep Scan for more history."));
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', t("socialDashLogScanComplete", "Scan complete: 0 item(s) found.", ["0"]));
      }
    } catch (err) {
      // Partial results were never rendered -- don't leave them deletable.
      currentResults = [];
      const friendly = friendlyRedditError(err);
      await showAlert(t("socialDashScanFailed", `Scan failed: ${friendly}`, [friendly]));
      statusText.textContent = t("socialDashScanFailedStatus", "Scan failed. Nothing was deleted.");
      logActivity('sc-activity-log', t("socialDashScanFailed", `Scan failed: ${err.message}`, [err.message]), 'error');
    } finally {
      setBusy(false);
      deleteBtn.disabled = currentResults.length === 0;
      exportControls.refresh();
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const selected = getSelectedItems(currentResults);
    if (selected.length === 0) {
      await showAlert(t("dashNoItemsSelected", "No items are selected. Check at least one item, or use Select All, before deleting."));
      return;
    }
    const overwrite = overwriteToggle.checked;
    const overwriteText = normalizeRedditOverwriteText(overwriteTextInput.value);
    if (overwrite) overwriteTextInput.value = overwriteText;
    const noun = overwrite
      ? t("redditDashNounItemsOverwrite", "items (text overwritten first)")
      : t("socialDashNounItems", "items");
    if (!(await confirmBulkDelete(selected.length, noun))) return;

    setBusy(true);
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = t("socialDashStartingDeletion", "Starting deletion...");

    const cancelController = createCancelController();
    armCancelButton(cancelBtn, cancelController);

    const totalCount = selected.length;
    let deletedCount = 0;
    let failures = [];
    logActivity('sc-activity-log', t("socialDashLogDeleteStarted", `Delete started: ${totalCount} item(s) selected.`, [String(totalCount)]));
    if (overwrite) {
      logActivity('sc-activity-log', t("redditDashLogOverwriteOn", `Overwriting comments and text posts with "${overwriteText}" before deleting them. Link posts are only deleted.`, [overwriteText]));
    }

    // Overwrite step: failures are logged, never fatal -- the delete still runs.
    async function overwriteItem(item) {
      try {
        const response = await fetchWithRetry(REDDIT_EDIT_URL, {
          method: 'POST',
          credentials: "include",
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: buildRedditEditBody(item.id, overwriteText, modhash)
        }, undefined, deleteRetryOptions(cancelController, progressText));
        if (!response.ok) {
          const statusErr = new Error(`HTTP ${response.status}`);
          statusErr.status = response.status;
          throw new Error(friendlyRedditError(statusErr));
        }
        let body;
        try {
          body = await response.json();
        } catch (e) {
          throw new Error(t("redditDashEditUnconfirmed", "Reddit did not confirm the overwrite."));
        }
        const failure = redditEditFailureFromBody(body);
        if (failure) throw new Error(failure);
      } catch (err) {
        const message = friendlyRedditError(err);
        logActivity('sc-activity-log', t("redditDashLogOverwriteFailed", `Couldn't overwrite ${item.id} (${message}); deleting it anyway.`, [item.id, message]), 'warn');
      }
      await cancellableDelay(REDDIT_EDIT_TO_DELETE_DELAY_MS, cancelController);
    }
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        // strict 1.5 second delay to avoid rate limits
        postItemDelayMs: 1500,
        deleteItem: async (item) => {
          // Opt-in: overwrite the text first (comments and self posts only).
          // A cancel during the overwrite pause still deletes this item, so it
          // never stays on Reddit half-processed (overwritten but listed).
          if (overwrite && isRedditItemEditable(item)) await overwriteItem(item);

          // POST to /api/del
          const formData = new URLSearchParams();
          formData.append('id', item.id);
          formData.append('uh', modhash);

          const response = await fetchWithRetry('https://www.reddit.com/api/del', {
            method: 'POST',
            credentials: "include",
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData.toString()
          }, undefined, deleteRetryOptions(cancelController, progressText));

          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              const authErr = new Error(t("redditDashSessionInvalidError", "Your Reddit session or modhash appears to be invalid. Reconnect from the extension popup."));
              authErr.expiredAuth = true;
              throw authErr;
            }
            // .status is read by runDeleteLoop's rate-limit circuit breaker
            // (see dashboard-fetch-utils.js) to detect several 429s in a row.
            const statusErr = new Error(`HTTP ${response.status}`);
            statusErr.status = response.status;
            if (response.status === 429) statusErr.retryAfterMs = redditRetryAfterMs(response.headers);
            statusErr.message = friendlyRedditError(statusErr);
            throw statusErr;
          }

          // HTTP 200 alone doesn't mean Reddit actually deleted anything -- the
          // most important finding of the audit that prompted this fix. See
          // redditDeleteFailureFromBody above for what counts as a real success.
          let body;
          try {
            body = await response.json();
          } catch (e) {
            throw new Error(t("redditDashUnreadableResponse", "Reddit returned an unreadable response for the delete request -- the item may not have been deleted."));
          }
          const failureMessage = redditDeleteFailureFromBody(body);
          if (failureMessage) throw new Error(failureMessage);
        }
      });
      deletedCount = result.deletedCount;
      failures = result.failures;
      const { succeededItems, expiredAuth, rateLimited, cancelled } = result;

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
      renderCount(currentResults.length, { afterDelete: true });

      const done = String(deletedCount);
      const total = String(totalCount);
      if (expiredAuth) {
        statusText.textContent = t("socialDashSessionInvalidStatus", "Session invalid -- reconnect required.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("socialDashLogDeleteSessionInvalid", `Delete stopped: session invalid (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(t("socialDashExpiredAuthAlert", `Stopped: your Reddit session appears to be invalid or expired. ${done} of ${total} items were deleted before this happened. Reconnect Reddit from the extension popup to finish.`, ["Reddit", done, total]));
      } else if (rateLimited) {
        statusText.textContent = t("socialDashRateLimitedStatus", "Rate limited by Reddit -- stopped early.", ["Reddit"]);
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("socialDashLogDeleteRateLimited", `Delete stopped: repeated rate limiting (429) (${done}/${total} deleted).`, [done, total]), 'error');
        const lastRetry = failures.length ? failures[failures.length - 1].error?.retryAfterMs : null;
        const mins = lastRetry ? String(Math.max(1, Math.ceil(lastRetry / 60000))) : null;
        await showAlert(
          t("socialDashRateLimitedAlert", `Stopped: Reddit rate-limited several delete requests in a row. ${done} of ${total} items were deleted before this happened.`, ["Reddit", done, total]) + ' ' +
          (mins
            ? t("socialDashRetryInMinutes", `Try again in about ${mins} minute(s).`, [mins])
            : t("socialDashRetryLater", "Wait a while, then try again."))
        );
      } else if (cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${done} of ${total} processed.`, [done, total]);
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("socialDashLogDeleteCancelled", `Delete cancelled: ${done}/${total} processed.`, [done, total]), 'warn');
      } else if (failures.length === 0) {
        statusText.textContent = t("socialDashDeletionComplete", "Deletion complete!");
        statusText.style.color = "#10b981";
        logActivity('sc-activity-log', t("socialDashLogDeleteComplete", `Delete complete: ${done}/${total} deleted.`, [done, total]));
      } else {
        const failed = String(failures.length);
        statusText.textContent = t("socialDashDeletionFinishedFailures", `Deletion finished: ${done} deleted, ${failed} failed out of ${total}.`, [done, failed, total]);
        statusText.style.color = "#ef4444";
        console.warn("Reddit delete failures:", failures);
        logActivity('sc-activity-log', t("socialDashDeletionFinishedFailures", `Deletion finished: ${done} deleted, ${failed} failed out of ${total}.`, [done, failed, total]), 'warn');
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
      renderCount(currentResults.length, { afterDelete: true });
      console.error("Reddit delete loop stopped unexpectedly:", err);
      const friendly = friendlyRedditError(err);
      logActivity('sc-activity-log', t("socialDashLogDeleteUnexpected", `Delete stopped unexpectedly: ${err.message}`, [err.message]), 'error');
      await showAlert(t("socialDashDeleteStoppedAlert",
        `Deletion stopped unexpectedly: ${friendly}\n\n${progress.deletedCount} of ${totalCount} items were deleted before this happened. Scan again to see what's left.`,
        [friendly, String(progress.deletedCount), String(totalCount)]));
      statusText.textContent = t("socialDashDeleteStoppedStatus", "Deletion stopped unexpectedly -- scan again to see what's left.");
      statusText.style.color = "#ef4444";
    } finally {
      setBusy(false);
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
      exportControls.refresh();
    }
  });
  // ============================================================
  // Import from Reddit's data export (comments.csv / posts.csv)
  // ============================================================
  importInput.addEventListener('change', async () => {
    const files = Array.from(importInput.files || []);
    // Reset so picking the same file again re-triggers `change`.
    importInput.value = '';
    if (files.length === 0) return;
    if (typeof parseCsv !== 'function') {
      await showAlert(t("redditDashImportUnavailable", "Import isn't available: a required file failed to load. Reload the dashboard and try again."));
      return;
    }

    setBusy(true);
    statusText.style.color = "";
    statusText.textContent = t("redditDashImporting", "Reading your Reddit data export...");
    try {
      const { matcher, filters } = readRedditFilters();
      const targetType = targetTypeInput.value;
      const lists = [];
      let comments = 0;
      let posts = 0;
      let skipped = 0;
      for (const file of files) {
        const name = String(file.name || '');
        let text;
        try {
          text = await file.text();
        } catch (e) {
          logActivity('sc-activity-log', t("redditDashImportReadFailed", `Couldn't read ${name}.`, [name]), 'error');
          continue;
        }
        const mapped = mapRedditExportRows(parseCsv(text), name);
        if (mapped.error) {
          const msg = mapped.error === 'no-id'
            ? t("redditDashImportNoId", `${name} has no "id" column -- pick comments.csv or posts.csv from the Reddit export.`, [name])
            : t("redditDashImportUnknownFile", `${name} doesn't look like Reddit's comments.csv or posts.csv -- skipped.`, [name]);
          logActivity('sc-activity-log', msg, 'warn');
          continue;
        }
        if (mapped.kind === 'comments') comments += mapped.items.length; else posts += mapped.items.length;
        skipped += mapped.skipped;
        lists.push(mapped.items);
      }
      const all = dedupeRedditItems(lists);
      const kept = all.filter(item => redditItemMatchesTarget(item, targetType)
        && redditTextPasses(matcher, item.text)
        && passesRedditAdvanced(item, filters));

      logActivity('sc-activity-log', t("redditDashLogImported",
        `Imported ${comments} comment(s) and ${posts} post(s) from the export; ${kept.length} match your filters.`,
        [String(comments), String(posts), String(kept.length)]));
      if (skipped > 0) {
        logActivity('sc-activity-log', t("redditDashLogImportSkipped", `Skipped ${skipped} row(s) without a valid id.`, [String(skipped)]), 'warn');
      }
      if (filters && filters.keepMin != null) {
        logActivity('sc-activity-log', t("redditDashLogImportNoScore", "The data export has no upvote counts, so \"Keep items with at least N upvotes\" isn't applied to imported items."), 'warn');
      }
      logActivity('sc-activity-log', t("redditDashLogImportDeletedNote", "Items you already deleted on Reddit are still in the export; deleting them again is harmless (Reddit skips them silently)."));

      currentResults = kept;
      lastScanCapped = false;
      if (kept.length > 0) {
        renderResultRows(kept);
        resultsCount.textContent = t("redditDashImportCount", `${kept.length} items from your Reddit data export`, [String(kept.length)]);
        statusText.textContent = t("redditDashImportComplete", "Import complete. Review results before deleting -- items already deleted on Reddit are skipped by Reddit silently.");
      } else {
        exportControls.refresh();
        resultsCount.textContent = t("redditDashImportCount", "0 items from your Reddit data export", ["0"]);
        renderEmptyState(itemList, t("redditDashImportNoItems", "No items from the export match your filters."));
        statusText.textContent = t("dashReady", "Ready");
      }
    } catch (err) {
      console.error("Reddit export import failed:", err);
      const message = (err && err.message) || String(err);
      logActivity('sc-activity-log', t("redditDashImportFailed", `Import failed: ${message}`, [message]), 'error');
      await showAlert(t("redditDashImportFailed", `Import failed: ${message}`, [message]));
      statusText.textContent = t("dashReady", "Ready");
    } finally {
      setBusy(false);
      deleteBtn.disabled = currentResults.length === 0;
    }
  });
});
