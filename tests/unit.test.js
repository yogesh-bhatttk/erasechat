// Erasechat - Node.js Unit Test Suite
// Runs with zero dependencies:  node --test tests/unit.test.js
//
// These tests import the ACTUAL production logic from shared-filters.js — the same
// module the background service worker loads — so there is no risk of testing a fork.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSafeRegex,
  qualifies,
  decideItemAction,
  stringToColor,
  isSlackHostname
} = require('../shared-filters.js');

// ============================================================
// isSafeRegex — Comprehensive ReDoS Detection
// ============================================================

test('isSafeRegex: accepts safe simple patterns', () => {
  assert.equal(isSafeRegex('hello'), true);
  assert.equal(isSafeRegex('ERR_\\d+'), true);
  assert.equal(isSafeRegex('[a-z]+'), true);
  assert.equal(isSafeRegex('foo|bar'), true);
  assert.equal(isSafeRegex('^start.*end$'), true);
  assert.equal(isSafeRegex('\\b\\w+\\b'), true);
});

test('isSafeRegex: rejects consecutive quantifiers', () => {
  assert.equal(isSafeRegex('a**'), false);
  assert.equal(isSafeRegex('a++'), false);
  assert.equal(isSafeRegex('a*+'), false);
  assert.equal(isSafeRegex('a+?+'), false);
  assert.equal(isSafeRegex('a??'), false);
});

test('isSafeRegex: rejects nested quantifiers in groups', () => {
  assert.equal(isSafeRegex('(a+)+'), false);
  assert.equal(isSafeRegex('(a*)+'), false);
  assert.equal(isSafeRegex('(a+)*'), false);
  assert.equal(isSafeRegex('(a*)*'), false);
  assert.equal(isSafeRegex('(a+){2,}'), false);
  assert.equal(isSafeRegex('(x+)?'), false);
});

test('isSafeRegex: rejects doubly-nested quantified groups', () => {
  // Inner quantifier not adjacent to the outer group close — missed by the
  // simple nested-quantifier rule, still catastrophic.
  assert.equal(isSafeRegex('((a+))+'), false);
  assert.equal(isSafeRegex('((a+)b)*'), false);
  assert.equal(isSafeRegex('((a|b)+)+'), false);
  // Benign nested groups WITHOUT an inner quantifier must still be accepted.
  assert.equal(isSafeRegex('((a))'), true);
  assert.equal(isSafeRegex('(ab)(cd)'), true);
});

test('isSafeRegex: rejects overlapping alternation in quantified groups', () => {
  assert.equal(isSafeRegex('(a|a)+'), false);
  assert.equal(isSafeRegex('(\\d|\\w)*'), false);
  assert.equal(isSafeRegex('(x|y)+'), false);
});

test('isSafeRegex: rejects nested quantifiers with braces', () => {
  assert.equal(isSafeRegex('(a{1,100}){1,100}'), false);
  assert.equal(isSafeRegex('(a{2,})+'), false);
  assert.equal(isSafeRegex('(a{1,10})*'), false);
});

test('isSafeRegex: rejects backreferences in quantified groups', () => {
  assert.equal(isSafeRegex('(a\\1)+'), false);
  assert.equal(isSafeRegex('(a)\\1'), true);
});

test('isSafeRegex: rejects patterns exceeding max length', () => {
  assert.equal(isSafeRegex('a'.repeat(101)), false);
  assert.equal(isSafeRegex('a'.repeat(100)), true);
});

test('isSafeRegex: accepts common safe patterns used in real filtering', () => {
  assert.equal(isSafeRegex('error'), true);
  assert.equal(isSafeRegex('\\d{4}-\\d{2}-\\d{2}'), true);
  assert.equal(isSafeRegex('https?://'), true);
  assert.equal(isSafeRegex('v\\d+\\.\\d+'), true);
  assert.equal(isSafeRegex('[A-Z]{2,5}'), true);
});

test('isSafeRegex: rejects long quantifier chains that backtrack without grouping', () => {
  // Exponential: a?a?a?…a?aaaa… — no parens and no adjacent quantifiers, so it
  // slips past every structural rule, yet backtracks catastrophically.
  assert.equal(isSafeRegex('a?'.repeat(30) + 'a'.repeat(20)), false);
  // Polynomial: a*a*a*…b
  assert.equal(isSafeRegex('a*'.repeat(20) + 'b'), false);
  // A modest number of quantifiers is still accepted (escaped metachars, which
  // are literals, are not counted).
  assert.equal(isSafeRegex('\\d?\\d?\\d?-\\d+'), true);
  assert.equal(isSafeRegex('a\\+b\\*c\\?d'), true);
});

// ============================================================
// qualifies — Sender Mode Filtering
// ============================================================

const CURRENT_USER = 'U123456';

test('qualifies: sender=me filters to current user only', () => {
  const myMsg = { ts: '100.0', user: CURRENT_USER, text: 'Hello' };
  const otherMsg = { ts: '101.0', user: 'U999999', text: 'Hi there' };

  assert.equal(qualifies(myMsg, CURRENT_USER, 'me', '', false), true);
  assert.equal(qualifies(otherMsg, CURRENT_USER, 'me', '', false), false);
});

test('qualifies: sender=all includes all users', () => {
  const otherMsg = { ts: '101.0', user: 'U999999', text: 'Hi there' };
  assert.equal(qualifies(otherMsg, CURRENT_USER, 'all', '', false), true);
});

// ============================================================
// qualifies — Attachment Filtering
// ============================================================

test('qualifies: onlyAttachments=true rejects text-only messages', () => {
  const textOnly = { ts: '100.0', user: CURRENT_USER, text: 'Just text' };
  assert.equal(qualifies(textOnly, CURRENT_USER, 'all', '', true), false);
});

test('qualifies: onlyAttachments=true accepts messages with files', () => {
  const withFile = { ts: '101.0', user: CURRENT_USER, text: 'File attached', files: [{ id: 'F123' }] };
  assert.equal(qualifies(withFile, CURRENT_USER, 'all', '', true), true);
});

test('qualifies: onlyAttachments=true accepts messages with attachments', () => {
  const withAttach = { ts: '102.0', user: CURRENT_USER, text: 'Link', attachments: [{ fallback: 'link' }] };
  assert.equal(qualifies(withAttach, CURRENT_USER, 'all', '', true), true);
});

test('qualifies: onlyAttachments=false does not filter by files', () => {
  const textOnly = { ts: '100.0', user: CURRENT_USER, text: 'Just text' };
  assert.equal(qualifies(textOnly, CURRENT_USER, 'all', '', false), true);
});

// ============================================================
// qualifies — Keyword Filtering
// ============================================================

test('qualifies: case-insensitive keyword matching', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'CONFIDENTIAL: Project Launch' };

  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'confidential', false), true);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'CONFIDENTIAL', false), true);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'ConFiDeNtIaL', false), true);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'secret', false), false);
});

test('qualifies: keyword searches file names and titles', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'Check this', files: [{ name: 'report.pdf', title: 'Q4 Report' }] };

  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'report.pdf', false), true);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'Q4 Report', false), true);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', 'spreadsheet', false), false);
});

test('qualifies: empty text filter matches everything', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'Anything' };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '', false), true);
});

test('qualifies: keyword searches attachment text/fallback/title (link-unfurl preview content)', () => {
  // Attachments (e.g. link unfurls) carry their own visible text separate from
  // files/message text — a filter must be able to match what the user actually
  // sees in Slack's preview card.
  const byText = { ts: '1', user: CURRENT_USER, text: '', attachments: [{ text: 'Quarterly Report Draft' }] };
  const byFallback = { ts: '2', user: CURRENT_USER, text: '', attachments: [{ fallback: 'Project Falcon status' }] };
  const byTitle = { ts: '3', user: CURRENT_USER, text: '', attachments: [{ title: 'Falcon Launch Update' }] };

  assert.equal(qualifies(byText, CURRENT_USER, 'all', 'quarterly', false), true);
  assert.equal(qualifies(byFallback, CURRENT_USER, 'all', 'falcon', false), true);
  assert.equal(qualifies(byTitle, CURRENT_USER, 'all', 'launch', false), true);
  assert.equal(qualifies(byText, CURRENT_USER, 'all', 'unrelated-keyword', false), false);
});

// ============================================================
// qualifies — Regex Pattern Filtering
// ============================================================

test('qualifies: valid regex pattern matching', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'Error code: ERR_404_NOT_FOUND' };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '/ERR_\\d+/', false), true);
});

test('qualifies: regex that does not match returns false', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'All good here' };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '/ERR_\\d+/', false), false);
});

test('qualifies: invalid regex falls back to literal match', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'Something with [bad regex' };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '/[bad regex/', false), true);
});

test('qualifies: single-slash strings are NOT treated as regex', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'path/to/file' };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '/', false), true);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '/x', false), false);
});

// ============================================================
// qualifies — ReDoS Protection
// ============================================================

test('qualifies: ReDoS patterns are blocked and execute quickly', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!' };

  const dangerousPatterns = ['/(a+)+/', '/(a*)*/', '/(a+)*/', '/(a|a)+/'];

  for (const pattern of dangerousPatterns) {
    const startTime = Date.now();
    qualifies(msg, CURRENT_USER, 'all', pattern, false);
    const duration = Date.now() - startTime;
    assert.ok(duration < 100, `Pattern ${pattern} took ${duration}ms — expected <100ms`);
  }
});

test('qualifies: oversized regex pattern falls back to literal match', () => {
  const longPattern = '/' + 'a'.repeat(101) + '/';
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'a'.repeat(101) };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', longPattern, false), true);
});

test('qualifies: quantifier-chain ReDoS pattern is blocked and executes quickly', () => {
  // Without the quantifier-count guard, this pattern hangs the regex engine on a
  // run of "a"s. It must be rejected as unsafe and fall back to a literal match.
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'a'.repeat(40) + '!' };
  const pattern = '/' + 'a?'.repeat(25) + 'a'.repeat(25) + '/'; // <=100 inner chars
  const start = Date.now();
  qualifies(msg, CURRENT_USER, 'all', pattern, false);
  assert.ok(Date.now() - start < 100, 'quantifier-chain regex must not backtrack');
});

test('isSafeRegex: rejects sequential UNBOUNDED quantifiers (polynomial ReDoS under the count cap)', () => {
  // 3-10 sequential unbounded quantifiers slip past every structural rule and the
  // count cap (<=10) yet backtrack polynomially — degree = number of stars. Reject.
  assert.equal(isSafeRegex('a*a*a*b'), false);       // cubic
  assert.equal(isSafeRegex('a*a*a*a*b'), false);     // quartic
  assert.equal(isSafeRegex('a*a*a*a*a*a*b'), false); // was ~739ms on 40 chars
  assert.equal(isSafeRegex('a*'.repeat(10) + 'b'), false); // degree-10, was a hang
  assert.equal(isSafeRegex('\\d+\\d+\\d+x'), false); // same family, different atom
  // Two unbounded quantifiers separated by a REQUIRED literal are safe and common.
  assert.equal(isSafeRegex('v\\d+\\.\\d+'), true);
  assert.equal(isSafeRegex('ERR_\\d+'), true);
  assert.equal(isSafeRegex('^start.*end$'), true);
});

test('qualifies: sequential-unbounded ReDoS pattern is blocked and executes quickly', () => {
  // The concrete case that hung the scan: 9-10 stars on a run of "a" with no "b".
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'a'.repeat(60) + '!' };
  const pattern = '/' + 'a*'.repeat(9) + 'b/';
  const start = Date.now();
  const q = qualifies(msg, CURRENT_USER, 'all', pattern, false);
  assert.ok(Date.now() - start < 100, 'sequential-unbounded regex must not backtrack');
  // Rejected as unsafe -> literal fallback for "a*a*...b", which the text lacks.
  assert.equal(q, false);
});

test('isSafeRegex: bounded-quantifier-sandwiched-between-unbounded-quantifiers pattern is still admitted (documents the known heuristic gap MAX_REGEX_INPUT backstops)', () => {
  // `a*[ab]{4}a*b` has exactly 2 unbounded quantifiers (allowed) and they are NOT
  // narrowly adjacent (8 chars of "[ab]{4}" sit between them), so it slips past every
  // structural rule in isSafeRegex() — this is a real, previously-unguarded ReDoS
  // shape (confirmed to take ~10 SECONDS against a single ordinary 4000-char message
  // before the MAX_REGEX_INPUT cap below was tightened). No pattern-shape heuristic
  // catches every ReDoS shape, so isSafeRegex() is expected to still say "safe" here —
  // the fix is the deterministic input-length backstop, asserted next.
  assert.equal(isSafeRegex('a*[ab]{4}a*b'), true);
});

test('qualifies: the heuristic-bypassing pattern above now executes in bounded time regardless of message length (MAX_REGEX_INPUT backstop)', () => {
  const pattern = '/a*[ab]{4}a*b/';
  // Its worst case is a run of "a" with no trailing "b" (never matches, exhausts
  // every backtracking split). Test at several lengths well past Slack's own
  // 4000-char default message limit — previously ~10s at 4000 chars alone.
  for (const len of [300, 1000, 4000, 20000]) {
    const msg = { ts: '100.0', user: CURRENT_USER, text: 'a'.repeat(len) };
    const start = Date.now();
    const q = qualifies(msg, CURRENT_USER, 'all', pattern, false);
    const duration = Date.now() - start;
    assert.ok(duration < 500, `len=${len} took ${duration}ms — expected well under 500ms (was ~10000ms at 4000 chars pre-fix)`);
    assert.equal(q, false); // no "b" anywhere -> never matches -> literal message not selected
  }
});

test('qualifies: a valid regex match past MAX_REGEX_INPUT increments the optional truncationStats counter', () => {
  // The MAX_REGEX_INPUT backstop above is a silent under-match unless something
  // reports it happened -- background.js's scan loop opts in via
  // options.truncationStats so content.js can warn the user (see CHANGELOG).
  const longMsg = { ts: '1', user: CURRENT_USER, text: 'x'.repeat(400) };
  const shortMsg = { ts: '2', user: CURRENT_USER, text: 'x'.repeat(50) };

  const stats = { count: 0 };
  qualifies(longMsg, CURRENT_USER, 'all', '/y/', false, { truncationStats: stats });
  assert.equal(stats.count, 1, 'a message longer than MAX_REGEX_INPUT must be counted');

  qualifies(shortMsg, CURRENT_USER, 'all', '/y/', false, { truncationStats: stats });
  assert.equal(stats.count, 1, 'a message at/under MAX_REGEX_INPUT must not be counted');

  // No options/truncationStats passed at all (every other caller, and every existing
  // test above this one) must behave exactly as before -- no throw, no side effect.
  assert.doesNotThrow(() => qualifies(longMsg, CURRENT_USER, 'all', '/y/', false));
});

test('qualifies: empty-string-matching regex selects NOTHING (never the whole channel)', () => {
  const unrelated = { ts: '1', user: 'U_OTHER', text: 'totally unrelated message' };
  // These all match "" -> would otherwise qualify every message (mass over-delete).
  for (const pat of ['/a?/', '/x*/', '/^/', '/.*/', '/(secret)?/', '/\\d*/']) {
    assert.equal(qualifies(unrelated, CURRENT_USER, 'all', pat, false), false, `pattern ${pat} must not select everything`);
  }
  // A non-degenerate regex still matches normally.
  assert.equal(qualifies({ ts: '1', user: 'U_OTHER', text: 'ERR_500' }, CURRENT_USER, 'all', '/ERR_\\d+/', false), true);
});

test('qualifies: system messages that CARRY TEXT are still dropped (channel_join etc.)', () => {
  // Slack join/leave/topic messages have text ("<@U> has joined the channel").
  const join = { ts: '1', user: CURRENT_USER, subtype: 'channel_join', text: '<@U123456> has joined the channel' };
  const topic = { ts: '2', user: CURRENT_USER, subtype: 'channel_topic', text: 'set the channel topic: Q4 planning' };
  assert.equal(qualifies(join, CURRENT_USER, 'me', '', false), false);
  assert.equal(qualifies(topic, CURRENT_USER, 'me', '', false), false);
  // A text filter must not be able to select a system message either.
  assert.equal(qualifies(join, CURRENT_USER, 'me', 'joined', false), false);
  // Real content-bearing subtypes are still kept.
  assert.equal(qualifies({ ts: '3', user: CURRENT_USER, subtype: 'me_message', text: 'waves' }, CURRENT_USER, 'me', '', false), true);
  assert.equal(qualifies({ ts: '4', user: CURRENT_USER, subtype: 'file_share', files: [{ id: 'F1' }] }, CURRENT_USER, 'me', '', false), true);
});

test('qualifies: "me" mode with undefined userId fails CLOSED (no user-less over-delete)', () => {
  const botMsg = { ts: '1', subtype: 'bot_message', bot_id: 'B1', text: 'deploy finished' };
  assert.equal(qualifies(botMsg, undefined, 'me', '', false), false);
  // A real user message with a defined userId still qualifies.
  assert.equal(qualifies({ ts: '2', user: CURRENT_USER, text: 'hi' }, CURRENT_USER, 'me', '', false), true);
});

// ============================================================
// qualifies — Subtype / Attachment interaction (regression for the
// "Only Delete Attachments misses caption-less uploads" bug)
// ============================================================

test('qualifies: subtype + no text is filtered out in normal modes', () => {
  const subtypeMsg = { ts: '100.0', user: CURRENT_USER, subtype: 'channel_join' };
  assert.equal(qualifies(subtypeMsg, CURRENT_USER, 'all', '', false), false);
});

test('qualifies: subtype AND text are kept', () => {
  const subtypeMsg = { ts: '100.0', user: CURRENT_USER, subtype: 'me_message', text: 'is away' };
  assert.equal(qualifies(subtypeMsg, CURRENT_USER, 'all', '', false), true);
});

test('qualifies: caption-less file upload (subtype, no text) is kept in ALL modes', () => {
  const upload = { ts: '100.0', user: CURRENT_USER, subtype: 'file_share', files: [{ id: 'F1' }] };
  // A file the user uploaded is their own content, so it must be deletable
  // whether or not "Only Delete Attachments" is on — a full clean should never
  // silently leave bare uploads behind. Only true system messages (subtype, no
  // text, AND no files/attachments) are dropped.
  assert.equal(qualifies(upload, CURRENT_USER, 'all', '', true), true);
  assert.equal(qualifies(upload, CURRENT_USER, 'all', '', false), true);
});

test('qualifies: messages with null/undefined text are handled', () => {
  assert.equal(qualifies({ ts: '100.0', user: CURRENT_USER, text: null }, CURRENT_USER, 'all', '', false), true);
  assert.equal(qualifies({ ts: '100.0', user: CURRENT_USER }, CURRENT_USER, 'all', '', false), true);
});

test('qualifies: empty files array', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'Hello', files: [] };
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '', true), false);
  assert.equal(qualifies(msg, CURRENT_USER, 'all', '', false), true);
});

test('qualifies: combined filters — sender + keyword + attachments', () => {
  const msg = { ts: '100.0', user: CURRENT_USER, text: 'Report data', files: [{ id: 'F1', name: 'data.csv' }] };
  assert.equal(qualifies(msg, CURRENT_USER, 'me', 'report', true), true);
  assert.equal(qualifies(msg, 'U_OTHER', 'me', 'report', true), false);
  assert.equal(qualifies(msg, CURRENT_USER, 'me', 'budget', true), false);
});

// ============================================================
// qualifies — excludePinned (safety toggle: never delete a pinned message)
// ============================================================

test('qualifies: excludePinned=true drops a message with a non-empty pinned_to', () => {
  const pinned = { ts: '1', user: CURRENT_USER, text: 'hello', pinned_to: ['C123'] };
  assert.equal(qualifies(pinned, CURRENT_USER, 'all', '', false, { excludePinned: true }), false);
});

test('qualifies: excludePinned=false (or omitted) does not touch pinned messages', () => {
  const pinned = { ts: '1', user: CURRENT_USER, text: 'hello', pinned_to: ['C123'] };
  assert.equal(qualifies(pinned, CURRENT_USER, 'all', '', false, { excludePinned: false }), true);
  // Backward compatible: an absent options arg (existing positional callers) must
  // behave exactly as before this feature — pinned status is simply ignored.
  assert.equal(qualifies(pinned, CURRENT_USER, 'all', '', false), true);
});

test('qualifies: excludePinned=true still accepts an unpinned message', () => {
  const notPinned = { ts: '1', user: CURRENT_USER, text: 'hello', pinned_to: [] };
  assert.equal(qualifies(notPinned, CURRENT_USER, 'all', '', false, { excludePinned: true }), true);
  assert.equal(qualifies({ ts: '2', user: CURRENT_USER, text: 'hello' }, CURRENT_USER, 'all', '', false, { excludePinned: true }), true);
});

// ============================================================
// qualifies — invertText ("keep if matches" instead of "delete if matches")
// ============================================================

test('qualifies: invertText=true keeps a non-matching message and drops a matching one', () => {
  const matches = { ts: '1', user: CURRENT_USER, text: 'this is confidential' };
  const other = { ts: '2', user: CURRENT_USER, text: 'totally unrelated' };
  assert.equal(qualifies(matches, CURRENT_USER, 'all', 'confidential', false, { invertText: true }), false);
  assert.equal(qualifies(other, CURRENT_USER, 'all', 'confidential', false, { invertText: true }), true);
  // Non-inverted behavior is unchanged.
  assert.equal(qualifies(matches, CURRENT_USER, 'all', 'confidential', false, { invertText: false }), true);
  assert.equal(qualifies(other, CURRENT_USER, 'all', 'confidential', false, { invertText: false }), false);
});

test('qualifies: invertText=true works with a regex filter too', () => {
  const matches = { ts: '1', user: CURRENT_USER, text: 'ERR_500 occurred' };
  const other = { ts: '2', user: CURRENT_USER, text: 'all clear' };
  assert.equal(qualifies(matches, CURRENT_USER, 'all', '/ERR_\\d+/', false, { invertText: true }), false);
  assert.equal(qualifies(other, CURRENT_USER, 'all', '/ERR_\\d+/', false, { invertText: true }), true);
});

test('qualifies: invertText=true STILL selects nothing for a degenerate empty-matching pattern', () => {
  // Inverting a filter that (mistakenly) matches everything must not flip into
  // "delete everything" — the single worst failure mode for a permanent-delete tool.
  const anyMsg = { ts: '1', user: CURRENT_USER, text: 'totally unrelated message' };
  for (const pat of ['/a?/', '/x*/', '/^/', '/.*/']) {
    assert.equal(qualifies(anyMsg, CURRENT_USER, 'all', pat, false, { invertText: true }), false,
      `inverted degenerate pattern ${pat} must still select nothing`);
  }
});

test('qualifies: invertText=true STILL selects nothing when the pattern is unsafe (ReDoS) or invalid regex', () => {
  // An unsafe/invalid pattern falls back to a literal substring match against the
  // raw regex SOURCE text, which almost never matches real messages. In normal
  // mode that's a safe under-match, but inverting it would otherwise flip into
  // "delete virtually everything" for a very ordinary mistake (a ReDoS-shaped
  // pattern, or a simple typo like an unbalanced bracket) — the same whole-channel
  // wipe the degenerate-empty-pattern guard above exists to prevent.
  const messages = [
    { ts: '1', user: CURRENT_USER, text: 'totally unrelated message' },
    { ts: '2', user: CURRENT_USER, text: 'another ordinary message' },
    { ts: '3', user: CURRENT_USER, text: 'yet another one' },
  ];
  for (const pat of ['/(a+)+/', '/[unclosed/']) {
    for (const msg of messages) {
      assert.equal(qualifies(msg, CURRENT_USER, 'all', pat, false, { invertText: true }), false,
        `inverted unsafe/invalid pattern ${pat} must still select nothing (got a match on "${msg.text}")`);
    }
  }
});

// ============================================================
// decideItemAction — trim (preserve text) vs full delete
// (regression coverage for the attachment-mode data-loss fix)
// ============================================================

test('decideItemAction: not cleaning attachments -> always delete', () => {
  assert.equal(decideItemAction({ text: 'hi', files: [{ id: 'F1' }] }, false), 'delete');
  assert.equal(decideItemAction({ text: 'hi' }, false), 'delete');
});

test('decideItemAction: attachment mode + files + text -> trim (keep text)', () => {
  assert.equal(decideItemAction({ text: 'caption', files: [{ id: 'F1' }] }, true), 'trim');
});

test('decideItemAction: attachment mode + attachments-only + text -> trim', () => {
  // Link-unfurl style attachments (no file IDs) must still be trimmable.
  assert.equal(decideItemAction({ text: 'see link', hasAttachments: true }, true), 'trim');
  assert.equal(decideItemAction({ text: 'see link', attachments: [{ fallback: 'x' }] }, true), 'trim');
});

test('decideItemAction: attachment mode + files but NO text -> delete', () => {
  // Nothing to preserve, so the whole message goes.
  assert.equal(decideItemAction({ files: [{ id: 'F1' }] }, true), 'delete');
  assert.equal(decideItemAction({ text: '   ', files: [{ id: 'F1' }] }, true), 'delete');
});

test('decideItemAction: attachment mode + files but NO text + WITH blocks -> trim', () => {
  // Block kit message with empty top-level text but content in blocks
  assert.equal(decideItemAction({ files: [{ id: 'F1' }], blocks: [{ type: 'section' }] }, true), 'trim');
  assert.equal(decideItemAction({ text: '', files: [{ id: 'F1' }], blocks: [{ type: 'rich_text' }] }, true), 'trim');
});

test('decideItemAction: attachment mode + no attachments/files -> skip (never delete)', () => {
  // In "Only Delete Attachments" mode a message with nothing to clean must be
  // skipped, not destroyed — e.g. when the toggle is turned on after a broad scan.
  assert.equal(decideItemAction({ text: 'plain' }, true), 'skip');
  assert.equal(decideItemAction({ text: 'plain', files: [] }, true), 'skip');
  assert.equal(decideItemAction({ files: [] }, true), 'skip');
});



// ============================================================
// stringToColor — Deterministic Color Assignment
// ============================================================

test('stringToColor: returns default color for null/empty input', () => {
  assert.equal(stringToColor(null), "#8B5CF6");
  assert.equal(stringToColor(""), "#8B5CF6");
  assert.equal(stringToColor(undefined), "#8B5CF6");
});

test('stringToColor: returns consistent color for same input', () => {
  assert.equal(stringToColor("U123456"), stringToColor("U123456"));
});

test('stringToColor: returns a color from the predefined palette', () => {
  const palette = [
    "#8B5CF6", "#EC4899", "#3B82F6", "#10B981", "#F59E0B",
    "#EF4444", "#06B6D4", "#14B8A6", "#84CC16", "#A855F7"
  ];
  assert.ok(palette.includes(stringToColor("TestUser123")));
});

// ============================================================
// isSlackHostname — Origin validation (verifies the SECURE behavior,
// i.e. exact-hostname matching that rejects subdomain spoofing)
// ============================================================

test('isSlackHostname: accepts any genuine slack.com subdomain over HTTPS', () => {
  assert.equal(isSlackHostname("https://app.slack.com/client/T1234/C5678"), true);
  assert.equal(isSlackHostname("https://app.slack.com/"), true);
  assert.equal(isSlackHostname("https://sackmate.slack.com/"), true);   // workspace subdomain
  assert.equal(isSlackHostname("https://fake-app.slack.com/"), true);   // still a slack-controlled subdomain
});

test('isSlackHostname: rejects spoofed, wrong-scheme, and unrelated origins', () => {
  assert.equal(isSlackHostname("https://app.slack.com.attacker.com/"), false); // suffix spoof
  assert.equal(isSlackHostname("https://slack.com.evil.com/"), false);
  assert.equal(isSlackHostname("https://evilslack.com/"), false);             // no dot before slack.com
  assert.equal(isSlackHostname("https://evil.com/app.slack.com"), false);
  assert.equal(isSlackHostname("http://app.slack.com/"), false);              // not HTTPS
  assert.equal(isSlackHostname("https://slack.com/"), false);                 // bare domain (client is on a subdomain)
  assert.equal(isSlackHostname("not a url"), false);
  assert.equal(isSlackHostname(""), false);
});
