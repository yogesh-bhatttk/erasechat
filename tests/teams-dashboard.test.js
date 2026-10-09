// Erasechat - Teams dashboard unit tests (node --test)
//
// dashboard-teams.js's JWT decode was previously closure-private with zero test
// coverage -- one of the audit's flagged gaps, and the more consequential of the
// two functions here (getOwnUserId) is the actual "is this my message" security
// check, not just cosmetic. Both are now hoisted to module scope (see the file's
// own comment) specifically so they're testable without a DOM.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getOwnUserId, getOwnDisplayIdentity, identityChangedMidRun } = require('../platforms/teams/dashboard-teams.js');

function fakeJwt(claims) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'none' })}.${b64url(claims)}.signature`;
}

// ============================================================
// getOwnUserId -- the actual "is this my message" ownership check
// ============================================================

test('getOwnUserId: reads the oid claim when present', () => {
  const jwt = fakeJwt({ oid: 'user-oid-123', sub: 'other-sub-456' });
  assert.equal(getOwnUserId(jwt), 'user-oid-123');
});

test('getOwnUserId: falls back to sub when oid is absent', () => {
  const jwt = fakeJwt({ sub: 'user-sub-789' });
  assert.equal(getOwnUserId(jwt), 'user-sub-789');
});

test('getOwnUserId: strips a leading "Bearer " prefix before decoding', () => {
  const jwt = fakeJwt({ oid: 'user-oid-123' });
  assert.equal(getOwnUserId(`Bearer ${jwt}`), 'user-oid-123');
});

test('getOwnUserId: returns null (fails closed) for a malformed token, never throwing', () => {
  assert.equal(getOwnUserId('not-a-jwt'), null);
  assert.equal(getOwnUserId(''), null);
  assert.equal(getOwnUserId('a.b.c'), null); // valid shape, invalid base64/JSON payload
});

test('getOwnUserId: returns null when neither oid nor sub is present', () => {
  const jwt = fakeJwt({ name: 'Jane Doe' });
  assert.equal(getOwnUserId(jwt), null);
});

// ============================================================
// getOwnDisplayIdentity -- purely cosmetic "Connected as ..." label
// ============================================================

test('getOwnDisplayIdentity: prefers preferred_username', () => {
  const jwt = fakeJwt({ preferred_username: 'jane@contoso.com', upn: 'jane@fallback.com', name: 'Jane Doe' });
  assert.equal(getOwnDisplayIdentity(jwt), 'jane@contoso.com');
});

test('getOwnDisplayIdentity: falls back through upn, unique_name, then name in order', () => {
  assert.equal(getOwnDisplayIdentity(fakeJwt({ upn: 'jane@upn.com', unique_name: 'jane-unique', name: 'Jane Doe' })), 'jane@upn.com');
  assert.equal(getOwnDisplayIdentity(fakeJwt({ unique_name: 'jane-unique', name: 'Jane Doe' })), 'jane-unique');
  assert.equal(getOwnDisplayIdentity(fakeJwt({ name: 'Jane Doe' })), 'Jane Doe');
});

test('getOwnDisplayIdentity: returns null when no identity-shaped claim exists (label just stays blank)', () => {
  assert.equal(getOwnDisplayIdentity(fakeJwt({ oid: 'user-oid-123' })), null);
});

test('getOwnDisplayIdentity: returns null (never throws) for a malformed token', () => {
  assert.equal(getOwnDisplayIdentity('garbage'), null);
});

// ============================================================
// identityChangedMidRun -- guards against a mid-run token refresh (apiFetch's 401
// retry path) silently swapping in a DIFFERENT signed-in Teams identity than the
// one the current scan/delete run started with. See dashboard-teams.js's own
// comment on this function and on the 401 retry branch that calls it.
// ============================================================

test('identityChangedMidRun: false when the refreshed token decodes to the same identity', () => {
  assert.equal(identityChangedMidRun('user-oid-123', 'user-oid-123'), false);
});

test('identityChangedMidRun: true when the refreshed token decodes to a DIFFERENT identity', () => {
  assert.equal(identityChangedMidRun('user-oid-123', 'someone-else-oid-456'), true);
});

test('identityChangedMidRun: false (fails closed to "not a mismatch") when either id is missing -- a decode failure is not evidence of a changed identity', () => {
  assert.equal(identityChangedMidRun(null, 'user-oid-123'), false);
  assert.equal(identityChangedMidRun('user-oid-123', null), false);
  assert.equal(identityChangedMidRun(null, null), false);
});

test('identityChangedMidRun: end-to-end through real (fake) JWTs -- the actual apiFetch 401-refresh scenario this guards against', () => {
  // Simulates: dashboard opened while signed in as Alice (ownUserId captured at
  // page load), then teams-webrequest.js's always-on listener passively captures a
  // token from a DIFFERENT teams.microsoft.com tab signed in as Bob, and apiFetch's
  // 401 retry path picks it up mid-run.
  const aliceToken = fakeJwt({ oid: 'alice-oid-111' });
  const bobToken = fakeJwt({ oid: 'bob-oid-222' });

  const runStartOwnUserId = getOwnUserId(aliceToken);
  const refreshedOwnUserId = getOwnUserId(bobToken);

  assert.equal(identityChangedMidRun(runStartOwnUserId, refreshedOwnUserId), true,
    'a token refresh that swaps in a different signed-in identity must be flagged so the run aborts instead of silently mixing credentials');

  // A same-identity refresh (token rotated, but still Alice) must NOT abort.
  const aliceTokenRotated = fakeJwt({ oid: 'alice-oid-111', iat: Date.now() });
  assert.equal(identityChangedMidRun(runStartOwnUserId, getOwnUserId(aliceTokenRotated)), false);
});

// ============================================================
// pickOlderPageLink / isDeletableTeamsMessage / buildChatLabelParts /
// classifyTeamsHttpStatus -- pure helpers behind pagination, message filtering,
// the chat picker's readable labels, and friendly error mapping.
// ============================================================

const {
  pickOlderPageLink, isDeletableTeamsMessage, buildChatLabelParts, classifyTeamsHttpStatus, rebasePageLink
} = require('../platforms/teams/dashboard-teams.js');

test('pickOlderPageLink: prefers _metadata.backwardLink over nextLink', () => {
  assert.equal(pickOlderPageLink({
    _metadata: { backwardLink: 'https://x/older', syncState: 'https://x/sync' },
    nextLink: 'https://x/next'
  }), 'https://x/older');
});

test('pickOlderPageLink: falls back to nextLink, never follows syncState', () => {
  assert.equal(pickOlderPageLink({ nextLink: 'https://x/next' }), 'https://x/next');
  assert.equal(pickOlderPageLink({ _metadata: { syncState: 'https://x/sync' } }), null);
  assert.equal(pickOlderPageLink({}), null);
  assert.equal(pickOlderPageLink(null), null);
  assert.equal(pickOlderPageLink({ _metadata: { backwardLink: '' } }), null);
});

test('isDeletableTeamsMessage: keeps Text/RichText messages', () => {
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Text' }), true);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'RichText/Html' }), true);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'RichText/UriObject' }), true);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'RichText' }), true);
});

test('isDeletableTeamsMessage: drops system/event messages', () => {
  assert.equal(isDeletableTeamsMessage({ messagetype: 'ThreadActivity/AddMember' }), false);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Event/Call' }), false);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Control/Typing' }), false);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'RichTextual' }), false);
});

test('isDeletableTeamsMessage: treats deletetime / deleted as already deleted', () => {
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Text', properties: { deletetime: 1700000000000 } }), false);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Text', properties: { deletetime: '1700000000000' } }), false);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Text', deleted: true }), false);
  assert.equal(isDeletableTeamsMessage({ messagetype: 'Text', properties: { deletetime: '0' } }), true);
});

test('isDeletableTeamsMessage: a message without a messagetype is kept (no regression)', () => {
  assert.equal(isDeletableTeamsMessage({ content: 'hi' }), true);
  assert.equal(isDeletableTeamsMessage(null), false);
});

test('buildChatLabelParts: uses the topic when present', () => {
  assert.deepEqual(buildChatLabelParts({ threadProperties: { topic: ' Team sync ' } }, 'me'), { topic: 'Team sync' });
});

test('buildChatLabelParts: falls back to member display names, excluding self', () => {
  const conv = {
    members: [
      { id: '8:orgid:me-oid', friendlyName: 'Me Myself' },
      { id: '8:orgid:a', friendlyName: 'Alice' },
      { id: '8:orgid:b', displayName: 'Bob' },
      { id: '8:orgid:c', name: 'Carol' },
      { id: '8:orgid:d', friendlyName: 'Dave' }
    ]
  };
  assert.deepEqual(buildChatLabelParts(conv, 'me-oid'), { names: ['Alice', 'Bob', 'Carol'], more: 1 });
});

test('buildChatLabelParts: parses a JSON members string in threadProperties', () => {
  const conv = { threadProperties: { members: JSON.stringify([{ id: '8:orgid:x', friendlyName: 'Xena' }]) } };
  assert.deepEqual(buildChatLabelParts(conv, 'me'), { names: ['Xena'], more: 0 });
});

test('buildChatLabelParts: uses the last sender name for a 1:1 chat, but not my own', () => {
  const other = { lastMessage: { imdisplayname: 'Alice', from: 'https://x/8:orgid:alice', composetime: '2026-01-02T00:00:00Z' } };
  assert.deepEqual(buildChatLabelParts(other, 'me-oid'), { names: ['Alice'], more: 0 });
  const mine = { lastMessage: { imdisplayname: 'Me', from: 'https://x/8:orgid:me-oid', composetime: '2026-01-02T00:00:00Z' } };
  assert.deepEqual(buildChatLabelParts(mine, 'me-oid'), { date: '2026-01-02T00:00:00Z' });
});

test('buildChatLabelParts: returns {} with nothing usable (never the raw id)', () => {
  assert.deepEqual(buildChatLabelParts({ id: '19:abc@thread.v2' }, 'me'), {});
  assert.deepEqual(buildChatLabelParts({ id: '19:abc', lastMessage: { composetime: 'garbage' } }, 'me'), {});
});

test('classifyTeamsHttpStatus: maps statuses to friendly-error kinds', () => {
  assert.equal(classifyTeamsHttpStatus(401), 'expired');
  assert.equal(classifyTeamsHttpStatus(403), 'forbidden');
  assert.equal(classifyTeamsHttpStatus(404), 'notFound');
  assert.equal(classifyTeamsHttpStatus(429), 'rateLimited');
  assert.equal(classifyTeamsHttpStatus(503), 'server');
  assert.equal(classifyTeamsHttpStatus(400), 'http');
});

test('rebasePageLink: same-origin links pass, other Teams hosts are re-pointed at the captured base, others are refused', () => {
  const base = 'https://teams.microsoft.com/api/chatsvc/amer';
  assert.equal(rebasePageLink('https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/conversations?startTime=1', base),
    'https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/conversations?startTime=1');
  assert.equal(rebasePageLink('https://amer.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19:x/messages?startTime=5', base),
    'https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/conversations/19:x/messages?startTime=5');
  assert.equal(rebasePageLink('https://evil.example/v1/users/ME/conversations', base), null);
  assert.equal(rebasePageLink('http://amer.ng.msg.teams.microsoft.com/v1/users/ME/x', base), null);
  assert.equal(rebasePageLink(null, base), null);
});

test('rebasePageLink: teams.cloud.microsoft (Teams on the web since Sep 2026) is a Teams host too', () => {
  const base = 'https://teams.cloud.microsoft/api/chatsvc/emea';
  assert.equal(rebasePageLink('https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations?startTime=9', base),
    'https://teams.cloud.microsoft/api/chatsvc/emea/v1/users/ME/conversations?startTime=9');
  assert.equal(rebasePageLink('https://x.teams.cloud.microsoft/v1/users/ME/conversations', 'https://teams.microsoft.com/api/chatsvc/emea'),
    'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations');
  assert.equal(rebasePageLink('https://teams.cloud.microsoft.evil.example/v1/users/ME/x', base), null);
});

// ============================================================
// Advanced filters / export helpers
// ============================================================
{
  const {
    teamsMessageTimeMs, isTeamsPageOlderThan, teamsIsoDate, buildTeamsExportColumns
  } = require('../platforms/teams/dashboard-teams.js');
  // dashboard-fetch-utils.js's t() isn't loaded under node -- English fallback.
  if (typeof globalThis.t !== 'function') globalThis.t = (key, fallback) => fallback;

  test('teamsMessageTimeMs: originalarrivaltime, then composetime; null when unusable', () => {
    assert.strictEqual(teamsMessageTimeMs({ originalarrivaltime: '2026-02-01T00:00:00Z' }), Date.UTC(2026, 1, 1));
    assert.strictEqual(teamsMessageTimeMs({ composetime: '2026-02-02T00:00:00Z' }), Date.UTC(2026, 1, 2));
    assert.strictEqual(teamsMessageTimeMs({ originalarrivaltime: 'bad' }), null);
    assert.strictEqual(teamsMessageTimeMs({}), null);
    assert.strictEqual(teamsMessageTimeMs(null), null);
  });

  test('isTeamsPageOlderThan: stops only when every datable message is before fromMs', () => {
    const from = Date.UTC(2026, 1, 10);
    const old = { originalarrivaltime: '2026-02-01T00:00:00Z' };
    const fresh = { originalarrivaltime: '2026-02-11T00:00:00Z' };
    assert.strictEqual(isTeamsPageOlderThan([old, old], from), true);
    assert.strictEqual(isTeamsPageOlderThan([fresh, old], from), false);
    assert.strictEqual(isTeamsPageOlderThan([old], null), false);
    assert.strictEqual(isTeamsPageOlderThan([], from), false);
    assert.strictEqual(isTeamsPageOlderThan([{}], from), false);
  });

  test('teamsIsoDate: ISO for valid dates, empty otherwise', () => {
    assert.strictEqual(teamsIsoDate('2026-02-01T00:00:00Z'), '2026-02-01T00:00:00.000Z');
    assert.strictEqual(teamsIsoDate(null), '');
    assert.strictEqual(teamsIsoDate('nope'), '');
  });

  test('buildTeamsExportColumns: chat, ISO date, sender, text', () => {
    const cols = buildTeamsExportColumns();
    assert.deepStrictEqual(cols.map(c => c.label), ['Chat', 'Date', 'Sender', 'Text']);
    const row = { id: '1', chat: 'Team chat', time: '2026-02-01T00:00:00Z', sender: 'Me', text: 'hello' };
    assert.deepStrictEqual(cols.map(c => c.get(row)), ['Team chat', '2026-02-01T00:00:00.000Z', 'Me', 'hello']);
    assert.deepStrictEqual(cols.map(c => c.get({})), ['', '', '', '']);
  });
}
