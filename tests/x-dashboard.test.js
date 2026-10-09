const test = require('node:test');
const assert = require('node:assert');

// dashboard-fetch-utils.js's t() isn't loaded under node -- stand in with the
// English fallback it would return when chrome.i18n has no message.
globalThis.t = (key, fallback) => fallback;

const {
  resolveXScriptUrl,
  extractTweetsFromEntries,
  deleteTweetFailureFromResult,
  deleteRetweetFailureFromResult,
  isValidQueryId,
  extractQueryIdsFromBundle,
  DEFAULT_X_QUERY_IDS,
  collectTimelineEntries,
  buildXDeleteRequest,
  buildXPermalink,
  xRetryAfterMs,
  friendlyXError,
  xDeleteOperation,
  parseXTimeMs,
  pageOlderThanFrom,
  X_FILTER_ACCESSORS,
  makeXItemPredicate,
  archiveEntryToItem,
  parseXArchiveText,
  mergeArchiveItems,
  archiveOwnerCheck,
  X_EXPORT_COLUMNS
} = require('../platforms/x/dashboard-x.js');

test('resolveXScriptUrl resolves root-relative X bundles against x.com', () => {
  assert.strictEqual(
    resolveXScriptUrl('/responsive-web/client-web/main.abc123.js'),
    'https://x.com/responsive-web/client-web/main.abc123.js'
  );
});

test('resolveXScriptUrl preserves absolute bundle URLs', () => {
  assert.strictEqual(
    resolveXScriptUrl('https://abs.twimg.com/responsive-web/client-web/main.abc123.js'),
    'https://abs.twimg.com/responsive-web/client-web/main.abc123.js'
  );
});

// ============================================================
// extractTweetsFromEntries -- pagination cursor-advance + de-dup
// (regression coverage for the "cursor can get stuck on a repeated page" bug)
// ============================================================

function tweetEntry(id, text = 'hello', createdAt = '') {
  return {
    entryId: `tweet-${id}`,
    itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: text, created_at: createdAt } } } }
  };
}

function cursorEntry(value) {
  return { entryId: 'cursor-bottom-abc', content: { value } };
}

test('extractTweetsFromEntries: collects tweets and the next cursor from a normal page', () => {
  const entries = [tweetEntry('1', 'first'), tweetEntry('2', 'second'), cursorEntry('CURSOR_2')];
  const seen = new Set();
  const { tweets, nextCursor } = extractTweetsFromEntries(entries, seen, '');
  assert.deepStrictEqual(tweets.map(t => t.id), ['1', '2']);
  assert.strictEqual(nextCursor, 'CURSOR_2');
  assert.strictEqual(seen.size, 2);
});

test('extractTweetsFromEntries: a page with NO cursor-bottom entry reports nextCursor null (caller must stop, not reuse a stale cursor)', () => {
  const entries = [tweetEntry('1'), tweetEntry('2')]; // no cursor entry at all
  const { nextCursor } = extractTweetsFromEntries(entries, new Set(), '');
  assert.strictEqual(nextCursor, null, 'must be distinguishable from an ordinary empty-string end-of-timeline cursor');
});

test('extractTweetsFromEntries: an empty-string cursor value is a genuine end (falsy, but not null)', () => {
  const entries = [tweetEntry('1'), cursorEntry('')];
  const { nextCursor } = extractTweetsFromEntries(entries, new Set(), '');
  assert.strictEqual(nextCursor, '');
});

test('extractTweetsFromEntries: de-dups a tweet id already seen on a previous page', () => {
  // Simulates the exact failure mode the cursor-stuck bug caused: the same page
  // (and therefore the same tweet ids) being fetched twice.
  const seen = new Set();
  const page1 = [tweetEntry('1', 'a'), tweetEntry('2', 'b'), cursorEntry('C')];
  const first = extractTweetsFromEntries(page1, seen, '');
  assert.strictEqual(first.tweets.length, 2);

  // Same page fetched again (as would happen if the cursor got stuck) -- every
  // tweet id was already recorded in `seen`, so nothing new is collected.
  const second = extractTweetsFromEntries(page1, seen, '');
  assert.strictEqual(second.tweets.length, 0, 'repeated tweets must not be pushed into results twice');
});

test('extractTweetsFromEntries: applies the case-insensitive text filter like every other platform', () => {
  const entries = [tweetEntry('1', 'Hello World'), tweetEntry('2', 'goodbye'), cursorEntry('C')];
  const { tweets } = extractTweetsFromEntries(entries, new Set(), 'hello');
  assert.deepStrictEqual(tweets.map(t => t.id), ['1']);
});

test('extractTweetsFromEntries: skips a tweet-* entry with no resolvable result (no rest_id to key on)', () => {
  const malformed = { entryId: 'tweet-broken', itemContent: {} };
  const entries = [malformed, tweetEntry('1'), cursorEntry('C')];
  const { tweets } = extractTweetsFromEntries(entries, new Set(), '');
  assert.deepStrictEqual(tweets.map(t => t.id), ['1']);
});

// ============================================================
// deleteTweetFailureFromResult -- audit Fix 1: HTTP 200 alone doesn't mean X
// actually deleted the tweet; the GraphQL response body must be inspected too.
// ============================================================

test('deleteTweetFailureFromResult: a real DeleteTweet success shape is not a failure', () => {
  const result = { data: { delete_tweet: { tweet_results: {} } } };
  assert.equal(deleteTweetFailureFromResult(result), null);
});

test('deleteTweetFailureFromResult: an HTTP-200 response with a GraphQL errors array is treated as a failure', () => {
  const result = { errors: [{ message: 'You are not authorized to delete this Tweet.' }] };
  const message = deleteTweetFailureFromResult(result);
  assert.ok(message, 'a non-null message means the caller must throw');
  assert.match(message, /not authorized/);
});

test('deleteTweetFailureFromResult: a missing data.delete_tweet with no errors array is still treated as a failure', () => {
  const message = deleteTweetFailureFromResult({ data: {} });
  assert.ok(message);
});

test('deleteTweetFailureFromResult: a null/undefined result is treated as a failure (nothing to confirm the delete)', () => {
  assert.ok(deleteTweetFailureFromResult(null));
  assert.ok(deleteTweetFailureFromResult(undefined));
});
// ============================================================
// Audit item: TweetWithVisibilityResults, self-thread modules, pinned tweet
// ============================================================

// Real UserTweets shape: item content lives under entry.content.itemContent.
function realTweetEntry(id, result) {
  return { entryId: `tweet-${id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result } } } };
}
function plainResult(id, text = 'hi', userId = '42') {
  return { __typename: 'Tweet', rest_id: id, legacy: { full_text: text, created_at: 'Mon Jan 01 00:00:00 +0000 2024', user_id_str: userId } };
}

test('extractTweetsFromEntries: reads the real entry.content.itemContent shape', () => {
  const { tweets } = extractTweetsFromEntries([realTweetEntry('5', plainResult('5'))], new Set(), '');
  assert.deepStrictEqual(tweets.map(t => t.id), ['5']);
});

test('extractTweetsFromEntries: unwraps TweetWithVisibilityResults (rest_id under result.tweet)', () => {
  const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: plainResult('77', 'limited') };
  const { tweets, rawCount } = extractTweetsFromEntries([realTweetEntry('77', wrapped)], new Set(), '');
  assert.deepStrictEqual(tweets.map(t => t.id), ['77']);
  assert.strictEqual(tweets[0].text, 'limited');
  assert.strictEqual(rawCount, 1);
});

test('extractTweetsFromEntries: includes every tweet of a profile-conversation-* self-thread module', () => {
  const module = {
    entryId: 'profile-conversation-123',
    content: {
      entryType: 'TimelineTimelineModule',
      items: [
        { entryId: 'profile-conversation-123-tweet-10', item: { itemContent: { tweet_results: { result: plainResult('10') } } } },
        { entryId: 'profile-conversation-123-tweet-11', item: { itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: plainResult('11') } } } } }
      ]
    }
  };
  const { tweets } = extractTweetsFromEntries([module, cursorEntry('C')], new Set(), '');
  assert.deepStrictEqual(tweets.map(t => t.id), ['10', '11']);
});

test('extractTweetsFromEntries: with an ownerId, drops a conversation tweet authored by someone else', () => {
  const module = {
    entryId: 'profile-conversation-9',
    content: { items: [
      { item: { itemContent: { tweet_results: { result: plainResult('20', 'mine', '42') } } } },
      { item: { itemContent: { tweet_results: { result: plainResult('21', 'theirs', '99') } } } }
    ] }
  };
  const { tweets } = extractTweetsFromEntries([module], new Set(), '', '42');
  assert.deepStrictEqual(tweets.map(t => t.id), ['20']);
});

test('collectTimelineEntries: includes the TimelinePinEntry pinned tweet, deduped against the timeline', () => {
  const instructions = [
    { type: 'TimelineClearCache' },
    { type: 'TimelinePinEntry', entry: realTweetEntry('1', plainResult('1', 'pinned')) },
    { type: 'TimelineAddEntries', entries: [realTweetEntry('1', plainResult('1', 'pinned')), realTweetEntry('2', plainResult('2')), cursorEntry('NEXT')] }
  ];
  const entries = collectTimelineEntries(instructions);
  const { tweets, nextCursor } = extractTweetsFromEntries(entries, new Set(), '');
  assert.deepStrictEqual(tweets.map(t => t.id), ['1', '2']);
  assert.strictEqual(nextCursor, 'NEXT');
});

test('extractTweetsFromEntries: rawCount is 0 for a cursor-only page (end of timeline even though X still sends a cursor)', () => {
  const { rawCount, nextCursor } = extractTweetsFromEntries([{ entryId: 'cursor-top-1', content: { value: 'T' } }, cursorEntry('B')], new Set(), '');
  assert.strictEqual(rawCount, 0);
  assert.strictEqual(nextCursor, 'B');
});

// ============================================================
// Audit item: reposts need DeleteRetweet, labelled "Repost"
// ============================================================

function retweetResult(id, sourceId) {
  return {
    __typename: 'Tweet', rest_id: id,
    legacy: { full_text: 'RT @other: hello', created_at: '', user_id_str: '42', retweeted_status_result: { result: plainResult(sourceId, 'hello', '99') } }
  };
}

test('extractTweetsFromEntries: a retweet is flagged isRepost with the source tweet id', () => {
  const { tweets } = extractTweetsFromEntries([realTweetEntry('300', retweetResult('300', '200'))], new Set(), '', '42');
  assert.strictEqual(tweets.length, 1);
  assert.strictEqual(tweets[0].isRepost, true);
  assert.strictEqual(tweets[0].sourceTweetId, '200');
  assert.strictEqual(tweets[0].permalink, 'https://x.com/i/status/200');
});

test('extractTweetsFromEntries: a retweet whose source is wrapped in TweetWithVisibilityResults still resolves the source id', () => {
  const rt = retweetResult('301', '201');
  rt.legacy.retweeted_status_result.result = { __typename: 'TweetWithVisibilityResults', tweet: plainResult('201') };
  const { tweets } = extractTweetsFromEntries([realTweetEntry('301', rt)], new Set(), '');
  assert.strictEqual(tweets[0].sourceTweetId, '201');
});

test('buildXDeleteRequest: a repost uses DeleteRetweet with {source_tweet_id}; an own post uses DeleteTweet with {tweet_id}', () => {
  const ids = { ...DEFAULT_X_QUERY_IDS };
  const rt = buildXDeleteRequest({ id: '300', isRepost: true, sourceTweetId: '200' }, ids);
  assert.strictEqual(rt.operation, 'DeleteRetweet');
  assert.strictEqual(rt.url, `https://x.com/i/api/graphql/${ids.DeleteRetweet}/DeleteRetweet`);
  assert.deepStrictEqual(rt.body.variables, { source_tweet_id: '200', dark_request: false });

  const own = buildXDeleteRequest({ id: '5', isRepost: false }, ids);
  assert.strictEqual(own.operation, 'DeleteTweet');
  assert.deepStrictEqual(own.body.variables, { tweet_id: '5', dark_request: false });
});

test('DEFAULT_X_QUERY_IDS has a valid fallback for every operation, including DeleteRetweet', () => {
  for (const op of ['UserByScreenName', 'UserTweets', 'DeleteTweet', 'DeleteRetweet']) {
    assert.ok(isValidQueryId(DEFAULT_X_QUERY_IDS[op]), op);
  }
});

test('deleteRetweetFailureFromResult: data.unretweet is success; errors or a missing unretweet is a failure', () => {
  assert.strictEqual(deleteRetweetFailureFromResult({ data: { unretweet: { source_tweet_results: {} } } }), null);
  assert.match(deleteRetweetFailureFromResult({ errors: [{ message: 'nope' }] }), /nope/);
  assert.ok(deleteRetweetFailureFromResult({ data: {} }));
  assert.ok(deleteRetweetFailureFromResult(null));
});

// ============================================================
// Audit item: scraped query ids are validated before use in a URL
// ============================================================

test('isValidQueryId: accepts X-style ids, rejects anything that could alter the URL', () => {
  assert.strictEqual(isValidQueryId('s70IQxZ5sQ-b40B2gP37Tw'), true);
  assert.strictEqual(isValidQueryId('abc_DEF-123'), true);
  for (const bad of ['', 'a/b', '../x', 'id?x=1', 'id#frag', 'a b', 'id%2F', null, undefined, 42]) {
    assert.strictEqual(isValidQueryId(bad), false, String(bad));
  }
});

test('extractQueryIdsFromBundle: keeps valid ids (incl. DeleteRetweet) and drops invalid ones', () => {
  const js = 'x={queryId:"good_ID-1",operationName:"UserTweets"};' +
    'y={queryId:"evil/../path",operationName:"DeleteTweet"};' +
    'z={queryId:"rt-Id_9",operationName:"DeleteRetweet"};' +
    'w={queryId:"other",operationName:"SomethingElse"}';
  assert.deepStrictEqual(extractQueryIdsFromBundle(js), { UserTweets: 'good_ID-1', DeleteRetweet: 'rt-Id_9' });
});

test('buildXDeleteRequest: refuses to build a URL from an invalid query id', () => {
  assert.strictEqual(buildXDeleteRequest({ id: '1', isRepost: false }, { DeleteTweet: 'x/../y' }), null);
});

// ============================================================
// 429 x-rate-limit-reset, permalinks, friendly errors
// ============================================================

test('xRetryAfterMs: converts the epoch-seconds reset header into a wait from now', () => {
  const now = 1_700_000_000_000;
  const headers = new Map([['x-rate-limit-reset', String(now / 1000 + 90)]]);
  assert.strictEqual(xRetryAfterMs(headers, now), 90_000);
  assert.strictEqual(xRetryAfterMs(new Map([['x-rate-limit-reset', String(now / 1000 - 5)]]), now), 0);
  assert.strictEqual(xRetryAfterMs(new Map(), now), null);
  assert.strictEqual(xRetryAfterMs(new Map([['x-rate-limit-reset', 'soon']]), now), null);
});

test('buildXPermalink: only numeric ids produce a link', () => {
  assert.strictEqual(buildXPermalink('123'), 'https://x.com/i/status/123');
  assert.strictEqual(buildXPermalink('javascript:alert(1)'), null);
  assert.strictEqual(buildXPermalink(undefined), null);
});

test('friendlyXError: maps statuses to actionable text, never a bare "API Error"', () => {
  assert.match(friendlyXError({ status: 429, retryAfterMs: 5 * 60_000 }), /5 minute/);
  assert.match(friendlyXError({ status: 403 }), /reconnect/i);
  assert.match(friendlyXError({ status: 503 }), /503/);
  assert.match(friendlyXError({ staleQueryId: true, status: 400 }), /update/);
  assert.match(friendlyXError(new TypeError('Failed to fetch')), /internet connection/);
});

// ============================================================
// Advanced filters integration: likes/pinned/time on scanned items, predicate
// filters, and the newest-first "From" date early stop
// ============================================================

function likedResult(id, likes, createdAt, text = 'hi') {
  return { __typename: 'Tweet', rest_id: id, legacy: { full_text: text, created_at: createdAt, user_id_str: '42', favorite_count: likes } };
}

// Spec-shaped stand-in for platform-filters.js's passesAdvancedFilters, so these
// tests don't depend on that file's internals.
function stubPasses(item, f, acc) {
  const time = acc.time(item);
  if ((f.fromMs != null || f.toMs != null)) {
    if (time == null) return false;
    if (f.fromMs != null && time < f.fromMs) return false;
    if (f.toMs != null && time > f.toMs) return false;
  }
  const score = acc.score ? acc.score(item) : null;
  if (f.keepMin != null && score != null && score >= f.keepMin) return false;
  if (f.keepPinned && acc.pinned && acc.pinned(item)) return false;
  return true;
}
const NO_FILTERS = { fromMs: null, toMs: null, invert: false, keepMin: null, keepPinned: false };
const substring = (q) => ({ test: (text) => text.toLowerCase().includes(q) });

test('tweetFromResult keeps likes and a parsed timeMs; the TimelinePinEntry tweet is flagged pinned', () => {
  const instructions = [
    { type: 'TimelinePinEntry', entry: realTweetEntry('1', likedResult('1', 50, 'Mon Jan 01 00:00:00 +0000 2018')) },
    { type: 'TimelineAddEntries', entries: [realTweetEntry('2', likedResult('2', '7', 'Tue Jan 02 00:00:00 +0000 2024')), cursorEntry('N')] }
  ];
  const entries = collectTimelineEntries(instructions);
  assert.strictEqual(instructions[0].entry.xPinned, undefined, 'X response must not be mutated');
  const { tweets, newestMs } = extractTweetsFromEntries(entries, new Set(), '');
  assert.deepStrictEqual(tweets.map(t => [t.id, t.pinned, t.likes]), [['1', true, 50], ['2', false, 7]]);
  assert.strictEqual(tweets[1].timeMs, Date.UTC(2024, 0, 2));
  assert.strictEqual(newestMs, Date.UTC(2024, 0, 2), 'the (old) pinned tweet must not count toward the page date');
});

test('extractTweetsFromEntries accepts a predicate in place of the substring filter', () => {
  const entries = [realTweetEntry('1', likedResult('1', 100, 'Mon Jan 01 00:00:00 +0000 2024')), realTweetEntry('2', likedResult('2', 1, 'Mon Jan 01 00:00:00 +0000 2024'))];
  const pred = makeXItemPredicate(substring(''), { ...NO_FILTERS, keepMin: 10 }, stubPasses, false);
  const { tweets, rawCount } = extractTweetsFromEntries(entries, new Set(), pred);
  assert.deepStrictEqual(tweets.map(t => t.id), ['2']);
  assert.strictEqual(rawCount, 2);
});

test('makeXItemPredicate: text matcher, keep-pinned, and date range all apply', () => {
  const day = Date.UTC(2024, 5, 1);
  const items = [
    { id: 'a', text: 'Hello world', timeMs: day, likes: 0, pinned: false },
    { id: 'b', text: 'hello pinned', timeMs: day, likes: 0, pinned: true },
    { id: 'c', text: 'hello old', timeMs: day - 86400000 * 400, likes: 0, pinned: false },
    { id: 'd', text: 'bye', timeMs: day, likes: 0, pinned: false }
  ];
  const pred = makeXItemPredicate(substring('hello'), { ...NO_FILTERS, keepPinned: true, fromMs: day - 86400000 }, stubPasses, true);
  assert.deepStrictEqual(items.filter(pred).map(i => i.id), ['a']);
  // No advanced filter API at all (platform-filters.js failed to load): text only.
  assert.deepStrictEqual(items.filter(makeXItemPredicate(substring('hello'), null, null, true)).map(i => i.id), ['a', 'b', 'c']);
});

test('makeXItemPredicate: a text-less tweet-headers item is skipped (never matched against "") while a text filter is set', () => {
  const header = { id: '9', text: '', textUnknown: true, timeMs: 1, likes: null };
  const inverted = { test: () => true }; // what an inverted filter returns for ''
  assert.strictEqual(makeXItemPredicate(inverted, NO_FILTERS, stubPasses, true)(header), false);
  assert.strictEqual(makeXItemPredicate(inverted, NO_FILTERS, stubPasses, false)(header), true);
});

test('X_FILTER_ACCESSORS expose time/likes/pinned with null for unknowns', () => {
  assert.strictEqual(X_FILTER_ACCESSORS.time({ timeMs: 5 }), 5);
  assert.strictEqual(X_FILTER_ACCESSORS.time({}), null);
  assert.strictEqual(X_FILTER_ACCESSORS.score({ likes: null }), null);
  assert.strictEqual(X_FILTER_ACCESSORS.score({ likes: 3 }), 3);
  assert.strictEqual(X_FILTER_ACCESSORS.pinned({ pinned: true }), true);
});

test('pageOlderThanFrom: stops only when a dated page is entirely before the From date', () => {
  assert.strictEqual(pageOlderThanFrom(100, 200), true);
  assert.strictEqual(pageOlderThanFrom(300, 200), false);
  assert.strictEqual(pageOlderThanFrom(null, 200), false);
  assert.strictEqual(pageOlderThanFrom(100, null), false);
});

test('parseXTimeMs parses X created_at and rejects junk', () => {
  assert.strictEqual(parseXTimeMs('Wed Oct 10 20:19:24 +0000 2018'), Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.strictEqual(parseXTimeMs(''), null);
  assert.strictEqual(parseXTimeMs('not a date'), null);
  assert.strictEqual(parseXTimeMs(undefined), null);
});

test('integration with the real platform-filters.js (when present)', (t) => {
  let pf;
  try {
    globalThis.isSafeRegex = require('../shared-filters.js').isSafeRegex || globalThis.isSafeRegex;
  } catch (_) { /* optional */ }
  try { pf = require('../platforms/shared/platform-filters.js'); } catch (_) { t.skip('platform-filters.js not available'); return; }
  const filters = { ...NO_FILTERS, keepMin: 10, keepPinned: true };
  const matcher = pf.buildTextMatcher('/^hel+o/', false);
  const pred = makeXItemPredicate(matcher, filters, pf.passesAdvancedFilters, true);
  const items = [
    { id: '1', text: 'hello', timeMs: 1, likes: 2, pinned: false },
    { id: '2', text: 'hello', timeMs: 1, likes: 20, pinned: false },
    { id: '3', text: 'hello', timeMs: 1, likes: 0, pinned: true },
    { id: '4', text: 'say hello', timeMs: 1, likes: 0, pinned: false }
  ];
  assert.deepStrictEqual(items.filter(pred).map(i => i.id), ['1']);
});

// ============================================================
// X archive import
// ============================================================

const TWEETS_JS = 'window.YTD.tweets.part0 = ' + JSON.stringify([
  { tweet: { id_str: '1001', created_at: 'Wed Oct 10 20:19:24 +0000 2018', full_text: 'old post', favorite_count: '12' } },
  { tweet: { id_str: '1002', created_at: 'Thu Oct 11 20:19:24 +0000 2018', full_text: 'RT @someone: their post', favorite_count: '0' } },
  { tweet: { id_str: '../evil', created_at: 'Thu Oct 11 20:19:24 +0000 2018', full_text: 'bad id' } },
  { tweet: { id: '1003', created_at: 'garbage', full_text: 'numeric id field' } },
  null
], null, 2);

const HEADERS_JS = 'window.YTD.tweet_headers.part0 = [\n' +
  '  { "tweet": { "tweet_id": "1001", "user_id": "42", "created_at": "Wed Oct 10 20:19:24 +0000 2018" } },\n' +
  '  { "tweet": { "tweet_id": "1004", "user_id": "42", "created_at": "Fri Oct 12 20:19:24 +0000 2018" } }\n]';

test('parseXArchiveText: tweets.js format -> items with id/time/text/likes/isRepost; invalid ids skipped', () => {
  const r = parseXArchiveText(TWEETS_JS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'tweets');
  assert.deepStrictEqual(r.items.map(i => i.id), ['1001', '1002', '1003']);
  assert.strictEqual(r.skipped, 2);
  const [a, b, c] = r.items;
  assert.strictEqual(a.likes, 12);
  assert.strictEqual(a.timeMs, Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.strictEqual(a.isRepost, false);
  assert.strictEqual(a.fromArchive, true);
  assert.strictEqual(a.permalink, 'https://x.com/i/status/1001');
  assert.strictEqual(b.isRepost, true);
  assert.strictEqual(b.sourceTweetId, null);
  assert.strictEqual(c.timeMs, null);
  assert.deepStrictEqual(r.ownerIds, []);
});

test('parseXArchiveText: tweet-headers.js format -> ids/dates/owner ids, no text', () => {
  const r = parseXArchiveText(HEADERS_JS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'headers');
  assert.deepStrictEqual(r.items.map(i => i.id), ['1001', '1004']);
  assert.ok(r.items.every(i => i.textUnknown && i.text === '' && i.likes === null && i.ownerId === '42'));
  assert.deepStrictEqual(r.ownerIds, ['42']);
});

test('parseXArchiveText: tolerates a BOM, a trailing semicolon, later parts, and a bare JSON array', () => {
  const part1 = '\uFEFFwindow.YTD.tweets.part1 = [{"tweet":{"id_str":"7","full_text":"x = y","created_at":""}}];';
  const r = parseXArchiveText(part1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items[0].text, 'x = y');
  const bare = parseXArchiveText('[{"tweet":{"tweet_id":"8","user_id":"1","created_at":""}}]');
  assert.strictEqual(bare.kind, 'headers');
  assert.deepStrictEqual(bare.items.map(i => i.id), ['8']);
});

test('parseXArchiveText: rejects malformed JSON, non-array data, and other archive files', () => {
  assert.deepStrictEqual(parseXArchiveText('window.YTD.tweets.part0 = [ {'), { ok: false, error: 'json' });
  assert.deepStrictEqual(parseXArchiveText('window.YTD.tweets.part0 = {"a":1}'), { ok: false, error: 'shape' });
  assert.deepStrictEqual(parseXArchiveText('window.YTD.like.part0 = []'), { ok: false, error: 'unsupported', name: 'like' });
  assert.deepStrictEqual(parseXArchiveText('window.YTD.deleted_tweets.part0 = []'), { ok: false, error: 'unsupported', name: 'deleted_tweets' });
  assert.deepStrictEqual(parseXArchiveText('no assignment here'), { ok: false, error: 'shape' });
  assert.deepStrictEqual(parseXArchiveText(null), { ok: false, error: 'shape' });
});

test('archiveEntryToItem: accepts the older un-wrapped entry shape and numeric ids only', () => {
  assert.strictEqual(archiveEntryToItem({ id_str: '55', full_text: 'hi', created_at: '' }, 'tweets').id, '55');
  assert.strictEqual(archiveEntryToItem({ tweet: { id_str: '5a' } }, 'tweets'), null);
  assert.strictEqual(archiveEntryToItem({ tweet: { id_str: '1'.repeat(30) } }, 'tweets'), null);
  assert.strictEqual(archiveEntryToItem('nope', 'tweets'), null);
});

test('mergeArchiveItems: dedupes by id, prefers the full tweets.js entry (keeping the header owner id), newest first', () => {
  const tweets = parseXArchiveText(TWEETS_JS).items;
  const headers = parseXArchiveText(HEADERS_JS).items;
  const merged = mergeArchiveItems([headers, tweets, tweets]);
  assert.deepStrictEqual(merged.map(i => i.id), ['1004', '1002', '1001', '1003']);
  const m1001 = merged.find(i => i.id === '1001');
  assert.strictEqual(m1001.text, 'old post');
  assert.strictEqual(m1001.textUnknown, false);
  assert.strictEqual(m1001.ownerId, '42');
});

test('archive items run through the same filters', () => {
  const merged = mergeArchiveItems([parseXArchiveText(TWEETS_JS).items, parseXArchiveText(HEADERS_JS).items]);
  const pred = makeXItemPredicate(substring('post'), { ...NO_FILTERS, keepMin: 10, toMs: Date.UTC(2018, 9, 12) }, stubPasses, true);
  // 1001 has 12 likes (kept), 1004 is text-less, 1003 undated with a date bound set.
  assert.deepStrictEqual(merged.filter(pred).map(i => i.id), ['1002']);
});

test('archiveOwnerCheck: match / mismatch / unknown', () => {
  assert.strictEqual(archiveOwnerCheck(['42'], '42'), 'match');
  assert.strictEqual(archiveOwnerCheck(['42', '7'], '42'), 'mismatch');
  assert.strictEqual(archiveOwnerCheck([], '42'), 'unknown');
  assert.strictEqual(archiveOwnerCheck(['42'], null), 'unknown');
});

test('an archive repost is deleted with DeleteTweet on its own id (the archive has no source id)', () => {
  const item = parseXArchiveText(TWEETS_JS).items.find(i => i.id === '1002');
  assert.strictEqual(xDeleteOperation(item), 'DeleteTweet');
  const req = buildXDeleteRequest(item, { ...DEFAULT_X_QUERY_IDS });
  assert.strictEqual(req.operation, 'DeleteTweet');
  assert.deepStrictEqual(req.body.variables, { tweet_id: '1002', dark_request: false });
  assert.strictEqual(xDeleteOperation({ id: '3', isRepost: true, sourceTweetId: '2' }), 'DeleteRetweet');
});

test('X_EXPORT_COLUMNS: id, ISO date, post/repost, likes, text, url', () => {
  const item = parseXArchiveText(TWEETS_JS).items[1];
  const row = X_EXPORT_COLUMNS.map(c => c.get(item));
  assert.deepStrictEqual(X_EXPORT_COLUMNS.map(c => c.label), ['id', 'date', 'type', 'likes', 'text', 'url']);
  assert.deepStrictEqual(row, ['1002', '2018-10-11T20:19:24.000Z', 'repost', 0, 'RT @someone: their post', 'https://x.com/i/status/1002']);
  assert.strictEqual(X_EXPORT_COLUMNS[1].get({ timeMs: null }), '');
  assert.strictEqual(X_EXPORT_COLUMNS[3].get({ likes: null }), '');
});
