const test = require('node:test');
const assert = require('node:assert');

const { resolveXScriptUrl, extractTweetsFromEntries } = require('../platforms/x/dashboard-x.js');

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