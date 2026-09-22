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
