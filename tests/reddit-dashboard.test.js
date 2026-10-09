// Erasechat - Reddit dashboard unit tests (node --test)
//
// dashboard-reddit.js's per-page item extraction was previously inline in the scan
// handler with zero test coverage -- one of the audit's flagged gaps (Reddit had no
// dedicated test file at all, unlike Mastodon/X). Extracted to module scope
// (mirroring dashboard-x.js's extractTweetsFromEntries) so it's testable directly.

const test = require('node:test');
const assert = require('node:assert/strict');

// dashboard-fetch-utils.js's t() isn't loaded under node -- stand in with the
// English fallback it would return when chrome.i18n has no message.
globalThis.t = (key, fallback) => fallback;

const {
  extractRedditItemsFromChildren,
  redditDeleteFailureFromBody,
  redditListingSweeps,
  buildRedditListingUrl,
  isRedditListingCapped,
  buildRedditPermalink,
  redditRetryAfterMs,
  friendlyRedditError,
  REDDIT_LISTING_PAGE_SIZE
} = require('../platforms/reddit/dashboard-reddit.js');

function comment(overrides) {
  return { kind: 't1', data: { name: 't1_c1', author: 'me', body: 'a comment', subreddit_name_prefixed: 'r/test', created_utc: 1700000000, ...overrides } };
}
function post(overrides) {
  return { kind: 't3', data: { name: 't3_p1', author: 'me', title: 'a post', subreddit_name_prefixed: 'r/test', created_utc: 1700000000, ...overrides } };
}

test('extractRedditItemsFromChildren: maps a comment (t1_) with its body as text', () => {
  const results = extractRedditItemsFromChildren([comment()], '');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 't1_c1');
  assert.equal(results[0].type, 'Comment');
  assert.equal(results[0].text, 'a comment');
  assert.equal(results[0].subreddit, 'r/test');
  assert.equal(results[0].time, 1700000000 * 1000);
});

test('extractRedditItemsFromChildren: maps a post (t3_) with its title as text, not body', () => {
  const results = extractRedditItemsFromChildren([post({ name: 't3_p2', title: 'my title' })], '');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'Post');
  assert.equal(results[0].text, 'my title');
});

test('extractRedditItemsFromChildren: skips an already-deleted item ([deleted] author)', () => {
  const results = extractRedditItemsFromChildren([comment({ author: '[deleted]' })], '');
  assert.deepEqual(results, []);
});

test('extractRedditItemsFromChildren: keeps a mod-removed item (the author can still delete it) and flags it removed', () => {
  const results = extractRedditItemsFromChildren([comment({ removed_by_category: 'moderator' })], '');
  assert.equal(results.length, 1);
  assert.equal(results[0].removed, true);
});

test('extractRedditItemsFromChildren: a normal item is not flagged removed', () => {
  const results = extractRedditItemsFromChildren([post()], '');
  assert.equal(results[0].removed, false);
});

test('extractRedditItemsFromChildren: skips an item the author already deleted (removed_by_category deleted/author)', () => {
  assert.deepEqual(extractRedditItemsFromChildren([post({ removed_by_category: 'deleted' })], ''), []);
  assert.deepEqual(extractRedditItemsFromChildren([post({ removed_by_category: 'author' })], ''), []);
});

test('extractRedditItemsFromChildren: skips a "more"-type stub child with no real data', () => {
  const results = extractRedditItemsFromChildren([{ kind: 'more', data: { children: [] } }], '');
  assert.deepEqual(results, []);
});

test('extractRedditItemsFromChildren: skips a child whose data has no `name` at all', () => {
  const results = extractRedditItemsFromChildren([{ kind: 't1', data: { author: 'me', body: 'x' } }], '');
  assert.deepEqual(results, []);
});

test('extractRedditItemsFromChildren: applies the case-insensitive text filter (already lowercased by the caller)', () => {
  const children = [
    comment({ name: 't1_a', body: 'CONFIDENTIAL project update' }),
    comment({ name: 't1_b', body: 'unrelated chatter' })
  ];
  const results = extractRedditItemsFromChildren(children, 'confidential');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 't1_a');
});

test('extractRedditItemsFromChildren: an empty filter keeps everything (no filter applied)', () => {
  const children = [comment({ name: 't1_a' }), post({ name: 't3_b' })];
  const results = extractRedditItemsFromChildren(children, '');
  assert.equal(results.length, 2);
});

test('extractRedditItemsFromChildren: preserves page order across a mixed comment/post page', () => {
  const children = [post({ name: 't3_1', title: 'first' }), comment({ name: 't1_2', body: 'second' }), post({ name: 't3_3', title: 'third' })];
  const results = extractRedditItemsFromChildren(children, '');
  assert.deepEqual(results.map(r => r.id), ['t3_1', 't1_2', 't3_3']);
});

test('extractRedditItemsFromChildren: an empty children array returns an empty result, not an error', () => {
  assert.deepEqual(extractRedditItemsFromChildren([], ''), []);
});

// ============================================================
// Cross-page de-dup (mirrors dashboard-x.js's seenTweetIds guard)
// ============================================================

test('extractRedditItemsFromChildren: with no seenIds set, de-dup is opt-in (backward compatible)', () => {
  const children = [comment({ name: 't1_a' }), comment({ name: 't1_a' })];
  const results = extractRedditItemsFromChildren(children, '');
  assert.equal(results.length, 2, 'no seenIds passed -> no de-dup, same as before the fix');
});

test('extractRedditItemsFromChildren: a fullname already in seenIds is skipped, even within the same page', () => {
  const seenIds = new Set();
  const children = [comment({ name: 't1_a' }), comment({ name: 't1_a' }), post({ name: 't3_b' })];
  const results = extractRedditItemsFromChildren(children, '', seenIds);
  assert.deepEqual(results.map(r => r.id), ['t1_a', 't3_b']);
});

test('extractRedditItemsFromChildren: a repeated/overlapping page (stuck `after` cursor) is fully deduped against the running set', () => {
  const seenIds = new Set();
  const page1 = [comment({ name: 't1_a' }), post({ name: 't3_b' })];
  const page2 = [comment({ name: 't1_a' }), post({ name: 't3_b' })]; // Reddit returned the same page again
  const firstResults = extractRedditItemsFromChildren(page1, '', seenIds);
  const secondResults = extractRedditItemsFromChildren(page2, '', seenIds);
  assert.equal(firstResults.length, 2);
  assert.deepEqual(secondResults, [], 'a fully-repeated page must not inflate results or re-queue a duplicate delete');
});

// ============================================================
// redditDeleteFailureFromBody -- audit Fix 1: HTTP 200 alone doesn't mean
// Reddit actually deleted anything; the JSON body must be inspected too.
// ============================================================

test('redditDeleteFailureFromBody: an empty {} body (Reddit\'s real success shape) is not a failure', () => {
  assert.equal(redditDeleteFailureFromBody({}), null);
});

test('redditDeleteFailureFromBody: a 200 response with a top-level errors array is treated as a failure', () => {
  const message = redditDeleteFailureFromBody({ errors: [['RATELIMIT', 'you are doing that too much']] });
  assert.ok(message, 'a non-null message means the caller must throw');
  assert.match(message, /RATELIMIT/);
});

test('redditDeleteFailureFromBody: a 200 response with a json.errors array (legacy API shape) is treated as a failure', () => {
  const message = redditDeleteFailureFromBody({ json: { errors: [['USER_REQUIRED', 'please log in']] } });
  assert.ok(message);
  assert.match(message, /USER_REQUIRED/);
});

test('redditDeleteFailureFromBody: an unexpected non-empty body with no errors array is still treated as a failure', () => {
  // Reddit's own success response for /api/del is an empty {} -- anything else,
  // even something that isn't an explicit error shape, means the delete wasn't
  // confirmed and must not be silently counted as succeeded.
  const message = redditDeleteFailureFromBody({ kind: 'Listing', data: {} });
  assert.ok(message);
});

test('redditDeleteFailureFromBody: null/undefined body is not treated as a failure (mirrors an empty {})', () => {
  assert.equal(redditDeleteFailureFromBody(null), null);
  assert.equal(redditDeleteFailureFromBody(undefined), null);
});

// ============================================================
// Listing requests: limit=100 + Reddit's ~1000-item cap (audit: "the cap was
// presented as a complete scan" / "limit=25 could be 100")
// ============================================================

test('buildRedditListingUrl: requests 100 items per page (Reddit\'s max), not 25', () => {
  assert.equal(REDDIT_LISTING_PAGE_SIZE, 100);
  const url = new URL(buildRedditListingUrl('someone', 'all', { sort: 'new' }, ''));
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.pathname, '/user/someone/overview.json');
  assert.equal(url.searchParams.get('sort'), 'new');
  assert.equal(url.searchParams.get('raw_json'), '1');
  assert.equal(url.searchParams.has('after'), false);
});

test('buildRedditListingUrl: picks the comments/submitted path and carries sort, t and after', () => {
  const c = new URL(buildRedditListingUrl('me', 'comments', { sort: 'top', t: 'all' }, 't1_abc'));
  assert.equal(c.pathname, '/user/me/comments.json');
  assert.equal(c.searchParams.get('sort'), 'top');
  assert.equal(c.searchParams.get('t'), 'all');
  assert.equal(c.searchParams.get('after'), 't1_abc');
  assert.equal(new URL(buildRedditListingUrl('me', 'submitted', { sort: 'new' }, '')).pathname, '/user/me/submitted.json');
});

test('buildRedditListingUrl: encodes the username so it cannot alter the path', () => {
  const url = new URL(buildRedditListingUrl('a/../b?x', 'all', { sort: 'new' }, ''));
  assert.equal(url.pathname, '/user/a%2F..%2Fb%3Fx/overview.json');
});

test('redditListingSweeps: a normal scan reads only `new`; Deep Scan adds top/controversial (all time) and hot', () => {
  assert.deepEqual(redditListingSweeps(false), [{ sort: 'new' }]);
  assert.deepEqual(redditListingSweeps(true), [
    { sort: 'new' }, { sort: 'top', t: 'all' }, { sort: 'controversial', t: 'all' }, { sort: 'hot' }
  ]);
});

test('Deep Scan sweeps dedupe by fullname across listings', () => {
  const seen = new Set();
  const fromNew = extractRedditItemsFromChildren([comment({ name: 't1_a' }), post({ name: 't3_b' })], '', seen);
  const fromTop = extractRedditItemsFromChildren([post({ name: 't3_b' }), comment({ name: 't1_old' })], '', seen);
  assert.deepEqual(fromNew.map(r => r.id), ['t1_a', 't3_b']);
  assert.deepEqual(fromTop.map(r => r.id), ['t1_old']);
});

test('isRedditListingCapped: a listing that ran out of `after` near ~1000 items is reported as capped, not complete', () => {
  assert.equal(isRedditListingCapped(1000, ''), true);
  assert.equal(isRedditListingCapped(997, null), true);
});

test('isRedditListingCapped: a short history that ended naturally is complete', () => {
  assert.equal(isRedditListingCapped(250, ''), false);
});

test('isRedditListingCapped: a listing that still has an `after` cursor is not "capped" (it was stopped by us)', () => {
  assert.equal(isRedditListingCapped(1000, 't1_next'), false);
});

// ============================================================
// Permalinks (built only from validated ids)
// ============================================================

test('buildRedditPermalink: posts and comments get reddit.com permalinks', () => {
  assert.equal(buildRedditPermalink({ name: 't3_abc12' }), 'https://www.reddit.com/comments/abc12/');
  assert.equal(buildRedditPermalink({ name: 't1_def34', link_id: 't3_abc12' }), 'https://www.reddit.com/comments/abc12/_/def34/');
});

test('buildRedditPermalink: rejects anything that is not a plain base-36 id', () => {
  assert.equal(buildRedditPermalink({ name: 't3_javascript:alert(1)' }), null);
  assert.equal(buildRedditPermalink({ name: 't1_ok', link_id: 't3_../../x' }), null);
  assert.equal(buildRedditPermalink({ name: 't1_ok' }), null);
  assert.equal(buildRedditPermalink({}), null);
});

test('extractRedditItemsFromChildren: attaches the validated permalink', () => {
  const [r] = extractRedditItemsFromChildren([comment({ name: 't1_zz', link_id: 't3_yy' })], '');
  assert.equal(r.permalink, 'https://www.reddit.com/comments/yy/_/zz/');
});

// ============================================================
// Friendly errors
// ============================================================

test('redditRetryAfterMs: reads x-ratelimit-reset (seconds) into ms', () => {
  assert.equal(redditRetryAfterMs(new Map([['x-ratelimit-reset', '42']])), 42000);
  assert.equal(redditRetryAfterMs(new Map()), null);
});

test('friendlyRedditError: never surfaces a bare "API Error 403"', () => {
  for (const status of [401, 403, 404, 429, 500, 418]) {
    const msg = friendlyRedditError(Object.assign(new Error(`HTTP ${status}`), { status }));
    assert.doesNotMatch(msg, /^API Error/);
    assert.ok(msg.length > 20);
  }
  assert.match(friendlyRedditError(Object.assign(new Error('x'), { status: 429, retryAfterMs: 120000 })), /2 minute/);
  assert.match(friendlyRedditError(new TypeError('Failed to fetch')), /internet connection/);
});

// ============================================================
// Feature round: advanced filters, overwrite-then-delete, export import
// ============================================================

const {
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
  REDDIT_EDIT_URL
} = require('../platforms/reddit/dashboard-reddit.js');

// Prefer the real shared helpers (platform-filters.js) when present; otherwise a
// minimal stand-in with the spec's contract so these tests still run.
const fs = require('node:fs');
const path = require('node:path');
let parseCsv;
let buildTextMatcher;
const sharedFiltersPath = path.join(__dirname, '../platforms/shared/platform-filters.js');
if (fs.existsSync(sharedFiltersPath)) {
  if (typeof globalThis.isSafeRegex !== 'function') {
    try { globalThis.isSafeRegex = require('../shared-filters.js').isSafeRegex; } catch (e) { /* optional */ }
  }
  ({ parseCsv, buildTextMatcher } = require(sharedFiltersPath));
}
if (typeof parseCsv !== 'function') {
  parseCsv = (text) => {
    const rows = []; let row = []; let field = ''; let q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  };
}
if (typeof buildTextMatcher !== 'function') {
  buildTextMatcher = (raw, invert) => {
    const needle = String(raw || '').trim().toLowerCase();
    return { warning: null, isRegex: false, test: (s) => !needle || ((s || '').toLowerCase().includes(needle) !== !!invert) };
  };
}

test('redditTextPasses: accepts the legacy lowercased string or a buildTextMatcher() matcher', () => {
  assert.equal(redditTextPasses('', 'anything'), true);
  assert.equal(redditTextPasses('foo', 'a FOO b'), true);
  assert.equal(redditTextPasses('foo', 'bar'), false);
  const inverted = buildTextMatcher('foo', true);
  assert.equal(redditTextPasses(inverted, 'a foo'), false);
  assert.equal(redditTextPasses(inverted, 'bar'), true);
});

test('extractRedditItemsFromChildren: keeps the listing score and the is_self flag', () => {
  const [p] = extractRedditItemsFromChildren([post({ score: 42, is_self: true })], '');
  assert.equal(p.score, 42);
  assert.equal(p.isSelf, true);
  const [c] = extractRedditItemsFromChildren([comment({ score: -3 })], '');
  assert.equal(c.score, -3);
  assert.equal(c.isSelf, false);
  const [noScore] = extractRedditItemsFromChildren([post({ name: 't3_x' })], '');
  assert.equal(noScore.score, null);
  assert.equal(noScore.isSelf, false);
});

test('extractRedditItemsFromChildren: works with a matcher object as the filter', () => {
  const children = [comment({ name: 't1_a', body: 'keep me' }), comment({ name: 't1_b', body: 'drop' })];
  const results = extractRedditItemsFromChildren(children, buildTextMatcher('keep', false));
  assert.deepEqual(results.map(r => r.id), ['t1_a']);
});

test('REDDIT_FILTER_ACCESSORS: time/score in ms/number, null when unknown', () => {
  assert.equal(REDDIT_FILTER_ACCESSORS.time({ time: 5 }), 5);
  assert.equal(REDDIT_FILTER_ACCESSORS.time({ time: null }), null);
  assert.equal(REDDIT_FILTER_ACCESSORS.score({ score: 7 }), 7);
  assert.equal(REDDIT_FILTER_ACCESSORS.score({ score: null }), null);
});

test('redditPageReachedFromDate: only the `new` sweep stops early, and only once the page is older than From', () => {
  const page = [comment({ created_utc: 2000 }), comment({ created_utc: 1000 })];
  assert.equal(redditPageReachedFromDate({ sort: 'new' }, page, 1500 * 1000), true);
  assert.equal(redditPageReachedFromDate({ sort: 'new' }, page, 500 * 1000), false);
  assert.equal(redditPageReachedFromDate({ sort: 'top', t: 'all' }, page, 1500 * 1000), false);
  assert.equal(redditPageReachedFromDate({ sort: 'hot' }, page, 1500 * 1000), false);
  assert.equal(redditPageReachedFromDate({ sort: 'new' }, page, null), false);
  assert.equal(redditPageReachedFromDate({ sort: 'new' }, [], 1), false);
});

test('normalizeRedditOverwriteText: defaults to "." and caps at 10,000 chars', () => {
  assert.equal(normalizeRedditOverwriteText(''), '.');
  assert.equal(normalizeRedditOverwriteText('   '), '.');
  assert.equal(normalizeRedditOverwriteText(undefined), '.');
  assert.equal(normalizeRedditOverwriteText('  gone  '), 'gone');
  assert.equal(normalizeRedditOverwriteText('x'.repeat(20000)).length, 10000);
});

test('isRedditItemEditable: comments and self posts yes, link posts no', () => {
  assert.equal(isRedditItemEditable({ id: 't1_a' }), true);
  assert.equal(isRedditItemEditable({ id: 't3_a', isSelf: true }), true);
  assert.equal(isRedditItemEditable({ id: 't3_a', isSelf: false }), false);
  assert.equal(isRedditItemEditable({ id: 't3_a' }), false);
  assert.equal(isRedditItemEditable(null), false);
});

test('buildRedditEditBody: form-encodes api_type, thing_id, text and uh', () => {
  assert.equal(REDDIT_EDIT_URL, 'https://www.reddit.com/api/editusertext');
  const params = new URLSearchParams(buildRedditEditBody('t1_abc', 'a & b=c', 'mh123'));
  assert.equal(params.get('api_type'), 'json');
  assert.equal(params.get('thing_id'), 't1_abc');
  assert.equal(params.get('text'), 'a & b=c');
  assert.equal(params.get('uh'), 'mh123');
});

test('redditEditFailureFromBody: success only for a json envelope with no errors', () => {
  assert.equal(redditEditFailureFromBody({ json: { errors: [], data: { things: [] } } }), null);
  assert.match(redditEditFailureFromBody({ json: { errors: [['TOO_OLD', 'that is too old to edit']] } }), /TOO_OLD/);
  assert.match(redditEditFailureFromBody({ errors: ['USER_REQUIRED'] }), /USER_REQUIRED/);
  assert.ok(redditEditFailureFromBody({}));
  assert.ok(redditEditFailureFromBody(null));
  assert.ok(redditEditFailureFromBody('nope'));
});

test('findCsvColumn: case-insensitive, trims, -1 when missing', () => {
  assert.equal(findCsvColumn([' ID ', 'Body'], ['id']), 0);
  assert.equal(findCsvColumn(['x', 'BODY'], ['body']), 1);
  assert.equal(findCsvColumn(['x'], ['id']), -1);
});

test('parseRedditExportDate: Reddit "YYYY-MM-DD HH:MM:SS UTC" and ISO forms', () => {
  assert.equal(parseRedditExportDate('2023-01-15 12:34:56 UTC'), Date.UTC(2023, 0, 15, 12, 34, 56));
  assert.equal(parseRedditExportDate('2023-01-15T12:34:56Z'), Date.UTC(2023, 0, 15, 12, 34, 56));
  assert.equal(parseRedditExportDate('2023-01-15 12:34:56'), Date.UTC(2023, 0, 15, 12, 34, 56));
  assert.equal(parseRedditExportDate(''), null);
  assert.equal(parseRedditExportDate('not a date'), null);
});

test('normalizeRedditSubreddit / redditPostIdFromUrl', () => {
  assert.equal(normalizeRedditSubreddit('AskReddit'), 'r/AskReddit');
  assert.equal(normalizeRedditSubreddit('r/AskReddit'), 'r/AskReddit');
  assert.equal(normalizeRedditSubreddit(''), '');
  assert.equal(redditPostIdFromUrl('https://www.reddit.com/r/x/comments/abc12/some_title/'), 'abc12');
  assert.equal(redditPostIdFromUrl('https://www.reddit.com/r/x/comments/abc12'), 'abc12');
  assert.equal(redditPostIdFromUrl('https://example.com/page'), '');
});

test('detectRedditExportKind: by file name first, then by headers', () => {
  assert.equal(detectRedditExportKind('comments.csv', []), 'comments');
  assert.equal(detectRedditExportKind('POSTS.csv', []), 'posts');
  assert.equal(detectRedditExportKind('export.csv', ['id', 'title', 'url']), 'posts');
  assert.equal(detectRedditExportKind('export.csv', ['id', 'body']), 'comments');
  assert.equal(detectRedditExportKind('other.csv', ['id', 'foo']), null);
});

const COMMENTS_CSV = 'id,permalink,date,ip,subreddit,gildings,link,parent,body,media\r\n'
  + 'c1,https://www.reddit.com/r/test/comments/p1/t/c1/,2023-01-15 12:34:56 UTC,,test,0,https://www.reddit.com/r/test/comments/p1/t/,,"hello, ""world""\nline 2",\r\n'
  + 'bad id!,x,2023-01-15 12:34:56 UTC,,test,0,,,skip me,\r\n'
  + 'c2,,2022-06-01 00:00:00 UTC,,other,0,,,no link,\r\n';
const POSTS_CSV = '﻿ID,Permalink,Date,IP,Subreddit,Gildings,Title,URL,Body\n'
  + 'p9,https://www.reddit.com/r/test/comments/p9/x/,2021-03-03 03:03:03 UTC,,test,0,A self post,https://www.reddit.com/r/test/comments/p9/x/,\n'
  + 'p8,https://www.reddit.com/r/test/comments/p8/y/,2021-03-03 03:03:03 UTC,,test,0,A link post,https://example.com/article,\n'
  + 'p7,,2021-03-03 03:03:03 UTC,,test,0,Text body post,,some body\n';

test('mapRedditExportRows: maps comments.csv to t1_ items with validated ids and permalinks', () => {
  const res = mapRedditExportRows(parseCsv(COMMENTS_CSV), 'comments.csv');
  assert.equal(res.error, null);
  assert.equal(res.kind, 'comments');
  assert.equal(res.skipped, 1);
  assert.equal(res.items.length, 2);
  const [a, b] = res.items;
  assert.equal(a.id, 't1_c1');
  assert.equal(a.type, 'Comment');
  assert.equal(a.text, 'hello, "world"\nline 2');
  assert.equal(a.subreddit, 'r/test');
  assert.equal(a.time, Date.UTC(2023, 0, 15, 12, 34, 56));
  assert.equal(a.score, null);
  assert.equal(a.fromExport, true);
  assert.equal(a.permalink, 'https://www.reddit.com/comments/p1/_/c1/');
  assert.equal(b.id, 't1_c2');
  assert.equal(b.permalink, null, 'no post id -> no permalink rather than a guessed one');
});

test('mapRedditExportRows: maps posts.csv to t3_ items (title as text) and tells self from link posts', () => {
  const res = mapRedditExportRows(parseCsv(POSTS_CSV), 'posts.csv');
  assert.equal(res.error, null);
  assert.equal(res.kind, 'posts');
  assert.deepEqual(res.items.map(i => i.id), ['t3_p9', 't3_p8', 't3_p7']);
  assert.equal(res.items[0].text, 'A self post');
  assert.equal(res.items[0].isSelf, true);
  assert.equal(res.items[1].isSelf, false, 'external url -> link post, not editable');
  assert.equal(res.items[2].isSelf, true, 'body text -> self post');
  assert.equal(res.items[0].permalink, 'https://www.reddit.com/comments/p9/');
  assert.equal(isRedditItemEditable(res.items[1]), false);
});

test('mapRedditExportRows: requires an id column and a recognisable file', () => {
  assert.equal(mapRedditExportRows(parseCsv('date,body\n2023-01-01,x\n'), 'comments.csv').error, 'no-id');
  assert.equal(mapRedditExportRows(parseCsv('id,foo\n1,2\n'), 'messages.csv').error, 'unknown-kind');
  assert.equal(mapRedditExportRows([], 'comments.csv').error, 'empty');
});

test('mapRedditExportRows: an id that is already a fullname is accepted; injection-y ids are rejected', () => {
  const res = mapRedditExportRows([['id', 'body'], ['t1_abc', 'x'], ['../x', 'y'], ['javascript:1', 'z']], 'comments.csv');
  assert.deepEqual(res.items.map(i => i.id), ['t1_abc']);
  assert.equal(res.skipped, 2);
});

test('dedupeRedditItems: keeps the first occurrence across files', () => {
  const out = dedupeRedditItems([[{ id: 't1_a', n: 1 }, { id: 't3_b' }], [{ id: 't1_a', n: 2 }], null]);
  assert.deepEqual(out.map(i => i.id), ['t1_a', 't3_b']);
  assert.equal(out[0].n, 1);
});

test('redditItemMatchesTarget: honours the target select for imported items', () => {
  assert.equal(redditItemMatchesTarget({ id: 't1_a' }, 'comments'), true);
  assert.equal(redditItemMatchesTarget({ id: 't3_a' }, 'comments'), false);
  assert.equal(redditItemMatchesTarget({ id: 't3_a' }, 'submitted'), true);
  assert.equal(redditItemMatchesTarget({ id: 't1_a' }, 'all'), true);
});

test('REDDIT_EXPORT_COLUMNS: type, subreddit, ISO date, score, text, permalink', () => {
  assert.deepEqual(REDDIT_EXPORT_COLUMNS.map(c => c.label), ['type', 'subreddit', 'date', 'score', 'text', 'permalink']);
  const item = { type: 'Comment', subreddit: 'r/x', time: Date.UTC(2020, 0, 1), score: 3, text: 'hi', permalink: 'https://www.reddit.com/comments/a/' };
  assert.deepEqual(REDDIT_EXPORT_COLUMNS.map(c => c.get(item)), ['Comment', 'r/x', '2020-01-01T00:00:00.000Z', 3, 'hi', 'https://www.reddit.com/comments/a/']);
  assert.deepEqual(REDDIT_EXPORT_COLUMNS.map(c => c.get({ type: 'Post', time: null, score: null })), ['Post', '', '', '', '', '']);
});

test('passesAdvancedFilters + REDDIT_FILTER_ACCESSORS: keepMin drops well-upvoted items; unknown (imported) score is not filtered', { skip: !fs.existsSync(sharedFiltersPath) }, () => {
  const { passesAdvancedFilters } = require(sharedFiltersPath);
  const filters = { fromMs: null, toMs: null, invert: false, keepMin: 10, keepPinned: false };
  assert.equal(passesAdvancedFilters({ time: 1, score: 50 }, filters, REDDIT_FILTER_ACCESSORS), false);
  assert.equal(passesAdvancedFilters({ time: 1, score: 2 }, filters, REDDIT_FILTER_ACCESSORS), true);
  assert.equal(passesAdvancedFilters({ time: 1, score: null }, filters, REDDIT_FILTER_ACCESSORS), true);
  const dated = { fromMs: 1000, toMs: 2000, invert: false, keepMin: null, keepPinned: false };
  assert.equal(passesAdvancedFilters({ time: 1500, score: null }, dated, REDDIT_FILTER_ACCESSORS), true);
  assert.equal(passesAdvancedFilters({ time: 500, score: null }, dated, REDDIT_FILTER_ACCESSORS), false);
});
