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

const { matchesActiveWorkspaceChannel } = require('../content.js');

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
