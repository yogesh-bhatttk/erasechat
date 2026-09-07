// Bulk Clean for Slack - Playwright E2E: per-platform permission-request + connect flow
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

    const stored = await page.evaluate(() => chrome.storage.local.get(['reddit_modhash', 'reddit_username']));
    expect(stored.reddit_modhash).toBe('abc123');
    expect(stored.reddit_username).toBe('testuser');
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

    const created = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.permissions.request = (_req, cb) => cb(true);
        chrome.cookies = { getAll: async (query) => query.domain === 'x.com' ? [{ name: 'ct0', value: 'csrf-token-value' }] : [] };
        chrome.tabs.create = (opts) => { resolve(opts); return Promise.resolve({}); };
        window.close = () => {};

        document.querySelector('.platform-row[data-platform="x"]').click();
      });
    });

    expect(created.url).toMatch(/dashboard-x\.html$/);

    const stored = await page.evaluate(() => chrome.storage.local.get(['x_csrf']));
    expect(stored.x_csrf).toBe('csrf-token-value');
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

    const stored = await page.evaluate(() => chrome.storage.local.get(['mstdn_host', 'mstdn_token', 'mstdn_user_id', 'mstdn_username']));
    expect(stored.mstdn_host).toBe('example.social');
    expect(stored.mstdn_token).toBe('tok123');
    expect(stored.mstdn_user_id).toBe('999');
    expect(stored.mstdn_username).toBe('mstdnuser');
  } finally {
    await context.close();
  }
});
