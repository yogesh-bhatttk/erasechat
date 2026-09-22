// Regression coverage for connect-mastodon.js's defense-in-depth hostname
// validation. popup/platform-registry.js's resolveOrigin() already gates the
// popup's own connect flow with the same strict hostname regex, but that's a
// single point of enforcement in a different file -- this checks the same rule
// is enforced locally, so a future caller can't bypass it by skipping
// resolveOrigin. See connect-mastodon.js's own comment on this check.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { connectMastodon } = require(path.resolve(__dirname, '../platforms/mastodon/connect-mastodon.js'));

function installChromeStub() {
  const stored = { session: {}, local: {} };
  global.chrome = {
    i18n: { getMessage: () => '' }, // no translations under Node -- English fallback text is asserted on below
    storage: {
      session: { set: async (obj) => Object.assign(stored.session, obj) },
      local: { set: async (obj) => Object.assign(stored.local, obj) }
    }
  };
  return stored;
}

test('connectMastodon: rejects a userinfo-trick instance URL instead of sending the token to the attacker host', async () => {
  installChromeStub();
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch should never be reached'); };

  const result = await connectMastodon({
    "instance-url": "real.mastodon.social@attacker.com",
    "access-token": "secret-token"
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /invalid/i);
  assert.equal(fetchCalled, false, 'must reject before ever making a request, so the bearer token is never sent anywhere');
});

test('connectMastodon: rejects a hostname carrying a path, port, or "*"', async () => {
  installChromeStub();
  global.fetch = async () => { throw new Error('fetch should never be reached'); };

  for (const badHost of ['mastodon.social/evil', 'mastodon.social:8080', '*']) {
    const result = await connectMastodon({ "instance-url": badHost, "access-token": "secret-token" });
    assert.equal(result.ok, false, `expected "${badHost}" to be rejected`);
  }
});

test('connectMastodon: still accepts a plain, valid instance hostname', async () => {
  installChromeStub();
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ id: '123', username: 'alice' })
    };
  };

  const result = await connectMastodon({
    "instance-url": "https://mastodon.social/",
    "access-token": "secret-token"
  });

  assert.deepStrictEqual(result, { ok: true });
  assert.equal(requestedUrl, 'https://mastodon.social/api/v1/accounts/verify_credentials');
});

test('connectMastodon: punycode-normalizes a Unicode/IDN hostname instead of rejecting it outright', async () => {
  installChromeStub();
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ id: '1', username: 'bob' }) };
  };

  const result = await connectMastodon({
    "instance-url": "münchen.social",
    "access-token": "secret-token"
  });

  assert.equal(result.ok, true);
  assert.ok(requestedUrl.startsWith('https://xn--mnchen-3ya.social/'), `expected punycode host, got: ${requestedUrl}`);
});
