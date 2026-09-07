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
