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

const {
  matchesActiveWorkspaceChannel, isSafeRegexPreview, checkTextFilterPattern,
  computeScanTimeRange, csvSafe, buildMessagesCsv, buildDeleteQueueFromIndices
} = require('../content.js');
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

// ============================================================
// computeScanTimeRange — the actual "how much history gets swept" decision,
// previously inline in runScan() with zero test coverage.
// ============================================================

test('computeScanTimeRange: no date filter ("all time") covers oldest=0 through now', () => {
  const now = 1700000000;
  const result = computeScanTimeRange('all', {}, now);
  assert.deepEqual(result, { ok: true, oldest: 0, latest: now });
});

test('computeScanTimeRange: "older_than" subtracts the given number of days from now', () => {
  const now = 1700000000;
  const result = computeScanTimeRange('older_than', { days: '10' }, now);
  assert.equal(result.ok, true);
  assert.equal(result.oldest, 0);
  assert.equal(result.latest, now - 10 * 24 * 60 * 60);
});

test('computeScanTimeRange: "older_than" defaults to 30 days when the field is blank', () => {
  const now = 1700000000;
  const result = computeScanTimeRange('older_than', { days: '' }, now);
  assert.equal(result.latest, now - 30 * 24 * 60 * 60);
});

test('computeScanTimeRange: "custom" with either bound missing is rejected as incomplete (never silently covers all history)', () => {
  assert.deepEqual(computeScanTimeRange('custom', { startVal: '', endVal: '2024-01-02' }), { ok: false, error: 'incomplete' });
  assert.deepEqual(computeScanTimeRange('custom', { startVal: '2024-01-01', endVal: '' }), { ok: false, error: 'incomplete' });
  assert.deepEqual(computeScanTimeRange('custom', {}), { ok: false, error: 'incomplete' });
});

test('computeScanTimeRange: "custom" with start after end is rejected as invalid', () => {
  const result = computeScanTimeRange('custom', { startVal: '2024-06-01', endVal: '2024-01-01' });
  assert.deepEqual(result, { ok: false, error: 'invalid' });
});

test('computeScanTimeRange: "custom" with a valid range anchors start to local midnight and end to local end-of-day', () => {
  const result = computeScanTimeRange('custom', { startVal: '2024-01-01', endVal: '2024-01-31' });
  const expectedOldest = Math.floor(new Date('2024-01-01T00:00:00').getTime() / 1000);
  const expectedLatest = Math.floor(new Date('2024-01-31T23:59:59').getTime() / 1000);
  assert.deepEqual(result, { ok: true, oldest: expectedOldest, latest: expectedLatest });
});

test('computeScanTimeRange: "custom" with start === end is a valid same-day range', () => {
  const result = computeScanTimeRange('custom', { startVal: '2024-01-01', endVal: '2024-01-01' });
  assert.equal(result.ok, true);
  assert.ok(result.oldest < result.latest);
});

// ============================================================
// csvSafe / buildMessagesCsv — formula-injection defense on "Export Messages as
// CSV", previously an inline closure inside a click handler with zero coverage.
// ============================================================

test('csvSafe: neutralizes formula-injection lead-in characters', () => {
  assert.equal(csvSafe('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvSafe('+1-800-555'), "'+1-800-555");
  assert.equal(csvSafe('-5'), "'-5");
  assert.equal(csvSafe('@mention'), "'@mention");
});

test('csvSafe: leaves an ordinary message untouched', () => {
  assert.equal(csvSafe('just a normal message'), 'just a normal message');
});

test('csvSafe: escapes embedded double quotes and collapses newlines', () => {
  assert.equal(csvSafe('she said "hi"'), 'she said ""hi""');
  assert.equal(csvSafe('line one\nline two\r\nline three'), 'line one line two line three');
});

test('csvSafe: null/undefined become an empty string, not the literal "null"/"undefined"', () => {
  assert.equal(csvSafe(null), '');
  assert.equal(csvSafe(undefined), '');
});

test('buildMessagesCsv: emits a header row and one correctly-shaped row per message', () => {
  const scanResults = [
    { ts: '100.1', user: 'U1', text: 'hello', time: '1/1/2024', isThreadReply: false, files: [] },
    { ts: '100.2', user: 'U2', text: 'a reply', time: '1/1/2024', isThreadReply: true, files: [{ id: 'F1' }, { id: 'F2' }] }
  ];
  const userCache = { U1: 'Alice', U2: 'Bob' };
  const csv = buildMessagesCsv(scanResults, userCache);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Timestamp,User,Text,ThreadReply,Time,Attachments');
  assert.equal(lines[1], '"100.1","Alice","hello","No","1/1/2024","0"');
  assert.equal(lines[2], '"100.2","Bob","a reply","Yes","1/1/2024","2"');
});

test('buildMessagesCsv: falls back to the raw user id when the name cache has no entry, and neutralizes formula-like text', () => {
  const scanResults = [{ ts: '1', user: 'U999', text: '=cmd|/bin/sh', time: 't', isThreadReply: false, files: [] }];
  const csv = buildMessagesCsv(scanResults, {});
  assert.match(csv, /"U999"/);
  assert.match(csv, /"'=cmd\|\/bin\/sh"/);
});

// ============================================================
// buildDeleteQueueFromIndices — the SC-BUG-03 stale-index guard: a checkbox's
// data-idx must be re-validated against the CURRENT scanResults array, since it can
// be modified/replaced between a scan finishing and the user clicking Delete.
// ============================================================

test('buildDeleteQueueFromIndices: resolves valid indices to their scanResults entries, in order', () => {
  const scanResults = [{ ts: '1' }, { ts: '2' }, { ts: '3' }];
  const queue = buildDeleteQueueFromIndices(['2', '0'], scanResults);
  assert.deepEqual(queue, [{ ts: '3' }, { ts: '1' }]);
});

test('buildDeleteQueueFromIndices: silently drops an out-of-range index instead of throwing or inserting undefined', () => {
  const scanResults = [{ ts: '1' }, { ts: '2' }];
  const queue = buildDeleteQueueFromIndices(['0', '5', '-1'], scanResults);
  assert.deepEqual(queue, [{ ts: '1' }]);
});

test('buildDeleteQueueFromIndices: drops every index once scanResults has been replaced with a shorter array (SC-BUG-03 scenario)', () => {
  // Simulates: user checks rows from a 10-result scan, scanResults gets replaced by
  // a fresh (shorter) scan before Delete is clicked -- none of the old indices
  // should resolve to the new array's (different) entries.
  const staleIndices = ['7', '8', '9'];
  const freshScanResults = [{ ts: 'new-1' }, { ts: 'new-2' }];
  assert.deepEqual(buildDeleteQueueFromIndices(staleIndices, freshScanResults), []);
});

test('buildDeleteQueueFromIndices: non-numeric data-idx values are dropped, not coerced to 0', () => {
  const scanResults = [{ ts: '1' }, { ts: '2' }];
  const queue = buildDeleteQueueFromIndices(['not-a-number', '1'], scanResults);
  assert.deepEqual(queue, [{ ts: '2' }]);
});
