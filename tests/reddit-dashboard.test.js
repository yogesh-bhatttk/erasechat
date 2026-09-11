// Erasechat - Reddit dashboard unit tests (node --test)
//
// dashboard-reddit.js's per-page item extraction was previously inline in the scan
// handler with zero test coverage -- one of the audit's flagged gaps (Reddit had no
// dedicated test file at all, unlike Mastodon/X). Extracted to module scope
// (mirroring dashboard-x.js's extractTweetsFromEntries) so it's testable directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractRedditItemsFromChildren } = require('../platforms/reddit/dashboard-reddit.js');

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

test('extractRedditItemsFromChildren: skips a removed item (removed_by_category set)', () => {
  const results = extractRedditItemsFromChildren([comment({ removed_by_category: 'moderator' })], '');
  assert.deepEqual(results, []);
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
