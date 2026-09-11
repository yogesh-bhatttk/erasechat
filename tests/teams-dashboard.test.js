// Erasechat - Teams dashboard unit tests (node --test)
//
// dashboard-teams.js's JWT decode was previously closure-private with zero test
// coverage -- one of the audit's flagged gaps, and the more consequential of the
// two functions here (getOwnUserId) is the actual "is this my message" security
// check, not just cosmetic. Both are now hoisted to module scope (see the file's
// own comment) specifically so they're testable without a DOM.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getOwnUserId, getOwnDisplayIdentity } = require('../platforms/teams/dashboard-teams.js');

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
