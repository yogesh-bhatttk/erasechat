// Erasechat — content.js unit tests (node --test)
//
// content.js is otherwise untestable without a full DOM: its dashboard logic lives
// inside an IIFE gated by `if (!window.slackCleanInitialized)`, all closure-private,
// with no exports. matchesActiveWorkspaceChannel() is a small pure predicate kept at
// module scope (outside that IIFE) specifically so it can be covered here without any
// DOM/chrome mocking — see the comment above its definition in content.js for why it
// exists (the JOB_UPDATE/JOB_RATELIMIT/JOB_LOG cross-workspace filtering bug it fixes).
//
// Setting window.slackCleanInitialized = true before requiring the file makes the
// IIFE's own guard skip its body entirely, so this file loads with zero DOM/chrome
// setup — module.exports is assigned before that guard is even reached.
global.window = { slackCleanInitialized: true };

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchesActiveWorkspaceChannel, isSafeRegexPreview, checkTextFilterPattern } = require('../content.js');
const { isSafeRegex } = require('../shared-filters.js');

test('matchesActiveWorkspaceChannel: matches when both channelId and teamId agree', () => {
  const activeChannel = { id: 'C123' };
  const activeTeam = { id: 'T1' };
  assert.equal(matchesActiveWorkspaceChannel('C123', 'T1', activeChannel, activeTeam), true);
});

test('matchesActiveWorkspaceChannel: rejects a same-channelId broadcast from a different workspace', () => {
  // The exact scenario this predicate exists for: two independently-created
  // workspaces can plausibly share a channel ID (e.g. an early #general), so a
  // job update meant for team T2's C123 must not be applied to this tab, which is
  // sitting in team T1's C123.
  const activeChannel = { id: 'C123' };
  const activeTeam = { id: 'T1' };
  assert.equal(matchesActiveWorkspaceChannel('C123', 'T2', activeChannel, activeTeam), false);
});

test('matchesActiveWorkspaceChannel: rejects a mismatched channelId within the same workspace', () => {
  const activeChannel = { id: 'C123' };
  const activeTeam = { id: 'T1' };
  assert.equal(matchesActiveWorkspaceChannel('C999', 'T1', activeChannel, activeTeam), false);
});

test('matchesActiveWorkspaceChannel: fails closed when there is no active channel yet', () => {
  assert.equal(matchesActiveWorkspaceChannel('C123', 'T1', null, { id: 'T1' }), false);
});

test('matchesActiveWorkspaceChannel: fails closed when there is no active team yet', () => {
  assert.equal(matchesActiveWorkspaceChannel('C123', 'T1', { id: 'C123' }, null), false);
});

test('matchesActiveWorkspaceChannel: fails closed when both are missing', () => {
  assert.equal(matchesActiveWorkspaceChannel('C123', 'T1', null, null), false);
});

test('matchesActiveWorkspaceChannel: always returns a real boolean, not a truthy/falsy object', () => {
  // Guards against a future edit reintroducing the pre-fix `if (a && b && ...)`
  // shape directly in a call site, which returns the last operand rather than a
  // boolean -- fine for an `if`, but a footgun for any future caller that expects
  // a real boolean.
  assert.strictEqual(matchesActiveWorkspaceChannel('C123', 'T1', { id: 'C123' }, { id: 'T1' }), true);
  assert.strictEqual(matchesActiveWorkspaceChannel('C123', 'T1', null, { id: 'T1' }), false);
});

// ============================================================
// isSafeRegexPreview / checkTextFilterPattern
//
// isSafeRegexPreview is an ADVISORY-ONLY duplicate of shared-filters.js's real
// isSafeRegex(), used solely to warn the user before a scan that their pattern will
// be downgraded to a literal match — it never decides what gets scanned/deleted
// (that stays exclusively in shared-filters.js, loaded only into the background
// worker). The drift-guard test below asserts both copies agree across a shared
// battery of patterns so an edit to one without the other fails CI instead of
// silently diverging.
// ============================================================

test('isSafeRegexPreview: agrees with the real shared-filters.js isSafeRegex on a shared pattern battery (drift guard)', () => {
  const patterns = [
    'hello', 'ERR_\\d+', '[a-z]+', 'foo|bar', '^start.*end$', '\\b\\w+\\b',
    'a**', 'a++', 'a*+', '(a+)+', '(a*)*', '((a+))+', '(a|a)+',
    '(a{1,100}){1,100}', 'a'.repeat(101),
    'a*a*a*b', 'a*a*a*a*b', '\\d+\\d+\\d+x', 'v\\d+\\.\\d+',
    'a*[ab]{4}a*b', // the heuristic-bypassing pattern MAX_REGEX_INPUT now backstops
  ];
  for (const p of patterns) {
    assert.equal(isSafeRegexPreview(p), isSafeRegex(p),
      `isSafeRegexPreview/isSafeRegex disagree on pattern: ${p}`);
  }
});

test('checkTextFilterPattern: null for a plain (non-regex) text filter', () => {
  assert.equal(checkTextFilterPattern('meeting notes'), null);
  assert.equal(checkTextFilterPattern(''), null);
});

test('checkTextFilterPattern: null for a safe, valid /regex/', () => {
  assert.equal(checkTextFilterPattern('/ERR_\\d+/'), null);
  assert.equal(checkTextFilterPattern('/cancell?ed/'), null);
});

test('checkTextFilterPattern: "unsafe" for a ReDoS-shaped pattern the real isSafeRegex also rejects', () => {
  assert.equal(checkTextFilterPattern('/(a+)+/'), 'unsafe');
  assert.equal(checkTextFilterPattern('/a*a*a*b/'), 'unsafe');
  assert.equal(isSafeRegex('(a+)+'), false); // cross-check against the real gate
});

test('checkTextFilterPattern: "unsafe" for an oversized pattern', () => {
  assert.equal(checkTextFilterPattern('/' + 'a'.repeat(101) + '/'), 'unsafe');
});

test('checkTextFilterPattern: "invalid" for a syntactically broken regex', () => {
  assert.equal(checkTextFilterPattern('/[unclosed/'), 'invalid');
  assert.equal(checkTextFilterPattern('/a(b/'), 'invalid');
});

test('checkTextFilterPattern: a single slash or empty regex body is treated as plain text, not a pattern', () => {
  assert.equal(checkTextFilterPattern('/'), null);
  assert.equal(checkTextFilterPattern('//'), null);
});
