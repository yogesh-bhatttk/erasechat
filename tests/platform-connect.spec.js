// Erasechat - Playwright E2E: per-platform permission-request + connect flow
//
// chrome.permissions.request() shows a real, native browser prompt that Playwright
// cannot drive (it's not part of any page's DOM) -- so these specs mock
// chrome.permissions/chrome.cookies/fetch to exercise the grant and deny paths the
// same way tests/permissions.spec.js already does for Slack's own permission gate.

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../');

async function launch() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  return { context, extensionId };
}

test('declining Reddit\'s permission prompt shows an inline error and resets the row', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      chrome.permissions.request = (_req, cb) => cb(false);
    });

    await page.locator('.platform-row[data-platform="reddit"]').click();

    await expect(page.locator('#platform-connect-error')).toBeVisible();
    await expect(page.locator('#platform-connect-error')).toContainText(/permission/i);
    // The row must not be left stuck on "Connecting..." after a denial.
    await expect(page.locator('.platform-row[data-platform="reddit"] .platform-status')).not.toHaveText(/connecting/i);
  } finally {
    await context.close();
  }
});

test('granting permission but finding no Reddit session shows connectReddit\'s own error', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      chrome.permissions.request = (_req, cb) => cb(true);
      chrome.cookies = { getAll: async () => [] }; // no reddit_session cookie
    });

    await page.locator('.platform-row[data-platform="reddit"]').click();

    await expect(page.locator('#platform-connect-error')).toBeVisible();
    await expect(page.locator('#platform-connect-error')).toContainText(/log in to reddit/i);
  } finally {
    await context.close();
  }
});

test('a granted permission and a real session opens the Reddit dashboard tab', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    const created = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (_req, cb) => cb(true);
        // The real flow re-checks chrome.permissions.contains() immediately before
        // opening the dashboard tab (defense-in-depth against a mid-flow revoke);
        // since request() here is faked rather than routed through the real browser
        // grant, contains() must be stubbed to match or that recheck sees "not
        // granted" and the tab never opens.
        chrome.permissions.contains = (_req, cb) => cb(true);
        chrome.cookies = { getAll: async () => [{ name: 'reddit_session', value: 'x' }] };
        window.fetch = async () => ({
          ok: true,
          json: async () => ({ data: { modhash: 'abc123', name: 'testuser' } })
        });
        chrome.tabs.create = (opts) => { resolve(opts); return Promise.resolve({}); };
        // The real flow calls window.close() on success; stub it so the test page
        // (and this evaluate() call) survives to report what happened.
        window.close = () => {};

        document.querySelector('.platform-row[data-platform="reddit"]').click();
      });
    });

    expect(created.url).toMatch(/dashboard-reddit\.html$/);

    // modhash is a write-authorizing token, so it's session-only (memory, cleared on
    // browser close) like the Slack token; the username is non-sensitive display
    // metadata and stays in local storage.
    const storedSession = await page.evaluate(() => chrome.storage.session.get(['reddit_modhash']));
    const storedLocal = await page.evaluate(() => chrome.storage.local.get(['reddit_username']));
    expect(storedSession.reddit_modhash).toBe('abc123');
    expect(storedLocal.reddit_username).toBe('testuser');
  } finally {
    await context.close();
  }
});

test('declining X\'s permission prompt shows an inline error and resets the row', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      chrome.permissions.request = (_req, cb) => cb(false);
    });

    await page.locator('.platform-row[data-platform="x"]').click();

    await expect(page.locator('#platform-connect-error')).toBeVisible();
    await expect(page.locator('.platform-row[data-platform="x"] .platform-status')).not.toHaveText(/connecting/i);
  } finally {
    await context.close();
  }
});

test('granting permission but finding no ct0 cookie shows connectX\'s own error', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      chrome.permissions.request = (_req, cb) => cb(true);
      chrome.cookies = { getAll: async () => [] }; // no ct0 cookie on either domain
    });

    await page.locator('.platform-row[data-platform="x"]').click();

    await expect(page.locator('#platform-connect-error')).toBeVisible();
    await expect(page.locator('#platform-connect-error')).toContainText(/log in to x\.com/i);
  } finally {
    await context.close();
  }
});

test('a granted permission and a real ct0 cookie opens the X dashboard tab', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Stub fetch so connectX()'s best-effort username lookup (resolveXUsername,
    // which hits a real X.com endpoint) never escapes to the network in a test.
    await page.evaluate(() => {
      window.fetch = async () => new Response(JSON.stringify({ screen_name: 'testhandle' }), { status: 200 });
    });

    const created = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (_req, cb) => cb(true);
        chrome.permissions.contains = (_req, cb) => cb(true);
        chrome.cookies = { getAll: async (query) => query.domain === 'x.com' ? [{ name: 'ct0', value: 'csrf-token-value' }] : [] };
        chrome.tabs.create = (opts) => { resolve(opts); return Promise.resolve({}); };
        window.close = () => {};

        document.querySelector('.platform-row[data-platform="x"]').click();
      });
    });

    expect(created.url).toMatch(/dashboard-x\.html$/);

    // The CSRF value is stored session-only (memory, cleared on browser close), like
    // the Slack token -- never chrome.storage.local.
    const stored = await page.evaluate(() => chrome.storage.session.get(['x_csrf']));
    expect(stored.x_csrf).toBe('csrf-token-value');

    // The resolved username is non-sensitive (just a handle, like Reddit's stored
    // username) and IS expected in storage.local, for the dashboard to pre-fill.
    const localStored = await page.evaluate(() => chrome.storage.local.get(['x_username']));
    expect(localStored.x_username).toBe('testhandle');
  } finally {
    await context.close();
  }
});

test('connectX still succeeds even when the best-effort username lookup fails', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      window.fetch = async () => { throw new Error('network unavailable'); };
    });

    const created = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (_req, cb) => cb(true);
        chrome.permissions.contains = (_req, cb) => cb(true);
        chrome.cookies = { getAll: async (query) => query.domain === 'x.com' ? [{ name: 'ct0', value: 'csrf-token-value' }] : [] };
        chrome.tabs.create = (opts) => { resolve(opts); return Promise.resolve({}); };
        window.close = () => {};

        document.querySelector('.platform-row[data-platform="x"]').click();
      });
    });

    expect(created.url).toMatch(/dashboard-x\.html$/);
    const localStored = await page.evaluate(() => chrome.storage.local.get(['x_username']));
    expect(localStored.x_username).toBeUndefined();
  } finally {
    await context.close();
  }
});

test('clicking Mastodon shows an inline form instead of connecting immediately', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // No permission request should fire just from opening the form -- there's
    // nothing to request access to until an instance is named.
    let requested = false;
    await page.evaluate(() => { chrome.permissions.request = () => { window.__requested = true; }; });

    await page.locator('.platform-row[data-platform="mastodon"]').click();

    const form = page.locator('.platform-form[data-platform="mastodon"]');
    await expect(form).toBeVisible();
    await expect(form.locator('#platform-form-mastodon-instance-url')).toBeVisible();
    await expect(form.locator('#platform-form-mastodon-access-token')).toBeVisible();

    requested = await page.evaluate(() => !!window.__requested);
    expect(requested).toBe(false);

    // Clicking the row again collapses the form without connecting.
    await page.locator('.platform-row[data-platform="mastodon"]').click();
    await expect(form).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('submitting the Mastodon form requests permission for the exact typed instance, not a wildcard', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    const requestedOrigins = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (req) => { resolve(req.origins); return Promise.resolve(false); };
        document.querySelector('.platform-row[data-platform="mastodon"]').click();
        document.getElementById('platform-form-mastodon-instance-url').value = 'https://example.social/';
        document.getElementById('platform-form-mastodon-access-token').value = 'tok123';
        document.querySelector('.platform-form-connect').click();
      });
    });

    expect(requestedOrigins).toEqual(['https://example.social/*']);
  } finally {
    await context.close();
  }
});

test('a granted permission and valid credentials opens the Mastodon dashboard tab', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    const created = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (_req, cb) => cb(true);
        chrome.permissions.contains = (_req, cb) => cb(true);
        // verify_credentials response shape from a real Mastodon instance.
        window.fetch = async () => ({ ok: true, json: async () => ({ id: '999', username: 'mstdnuser' }) });
        chrome.tabs.create = (opts) => { resolve(opts); return Promise.resolve({}); };
        window.close = () => {};

        document.querySelector('.platform-row[data-platform="mastodon"]').click();
        document.getElementById('platform-form-mastodon-instance-url').value = 'example.social';
        document.getElementById('platform-form-mastodon-access-token').value = 'tok123';
        document.querySelector('.platform-form-connect').click();
      });
    });

    expect(created.url).toMatch(/dashboard-mastodon\.html$/);

    // The access token is a durable, standing credential -- session-only storage,
    // like the Slack token. Host/id/username are non-sensitive routing/display
    // metadata and stay in local storage.
    const storedLocal = await page.evaluate(() => chrome.storage.local.get(['mstdn_host', 'mstdn_user_id', 'mstdn_username']));
    const storedSession = await page.evaluate(() => chrome.storage.session.get(['mstdn_token']));
    expect(storedLocal.mstdn_host).toBe('example.social');
    expect(storedSession.mstdn_token).toBe('tok123');
    expect(storedLocal.mstdn_user_id).toBe('999');
    expect(storedLocal.mstdn_username).toBe('mstdnuser');
  } finally {
    await context.close();
  }
});

test('Teams opens straight to its dashboard when a token is already stored from a prior session', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    const created = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (_req, cb) => cb(true);
        chrome.permissions.contains = (_req, cb) => cb(true);
        chrome.tabs.create = (opts) => { resolve(opts); return Promise.resolve({}); };
        window.close = () => {};

        chrome.storage.session.set({ teams_token: 'Bearer abc' }, () => {
          chrome.storage.local.set({ teams_base_url: 'https://teams.microsoft.com' }, () => {
            document.querySelector('.platform-row[data-platform="teams"]').click();
          });
        });
      });
    });

    expect(created.url).toMatch(/dashboard-teams\.html$/);
  } finally {
    await context.close();
  }
});

test('clicking Telegram enters its own view with the credentials step, and back returns to the picker', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.locator('.platform-row[data-platform="telegram"]').click();

    await expect(page.locator('#telegram-view')).toBeVisible();
    await expect(page.locator('#platform-list-state')).toBeHidden();
    // No chrome.permissions.request at all for Telegram -- MTProto needs none --
    // so the first (and only initially visible) step is straight to credentials.
    await expect(page.locator('#step-credentials')).toHaveClass(/active/);
    await expect(page.locator('#api-id')).toBeVisible();
    await expect(page.locator('#api-hash')).toBeVisible();
    await expect(page.locator('#phone')).toBeVisible();
    await expect(page.locator('#step-code')).not.toHaveClass(/active/);

    await page.locator('#btn-back-to-platforms-telegram').click();
    await expect(page.locator('#platform-list-state')).toBeVisible();
    await expect(page.locator('#telegram-view')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('Teams opens its sign-in tab and gives actionable next steps when no token is captured', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      chrome.permissions.request = (_req, cb) => cb(true);
      // connectTeams() now opens a real Teams tab itself (see connect-teams.js) --
      // stub it so this test doesn't actually navigate to teams.cloud.microsoft.
      chrome.tabs.create = () => Promise.resolve({});
    });

    await page.locator('.platform-row[data-platform="teams"]').click();

    await expect(page.locator('#platform-connect-error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#platform-connect-error')).toContainText(/teams\.cloud\.microsoft/i);
  } finally {
    await context.close();
  }
});
