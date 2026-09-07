// Erasechat - Playwright E2E Test Suite

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../');

test('should load popup page and render the platform picker by default', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false, // Browser extensions must run in headful mode
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  // Retrieve extension background pages/service workers to locate the ID
  let [backgroundPage] = context.serviceWorkers();
  if (!backgroundPage) {
    backgroundPage = await context.waitForEvent('serviceworker');
  }

  const extensionId = backgroundPage.url().split('/')[2];
  expect(extensionId).toBeDefined();

  // Test the popup page UI structure
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const title = await page.locator('h1').innerText();
  expect(title).toBe('Erasechat');

  // The platform picker is the default entry point (this test runs outside any
  // matching platform's tab, so nothing auto-skips it).
  const platformList = page.locator('#platform-list-state');
  await expect(platformList).not.toHaveClass(/hidden/);
  const rows = page.locator('.platform-row');
  await expect(rows).toHaveCount(7);
  await expect(page.locator('.platform-row[data-platform="slack"]')).toBeVisible();

  await context.close();
});

test('clicking the Slack row enters the Slack view and renders offline state', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  let [backgroundPage] = context.serviceWorkers();
  if (!backgroundPage) {
    backgroundPage = await context.waitForEvent('serviceworker');
  }
  const extensionId = backgroundPage.url().split('/')[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.locator('.platform-row[data-platform="slack"]').click();

  // Slack's own three-state flow, unchanged from before the platform picker existed.
  const offlineState = page.locator('#slack-inactive-state');
  await expect(offlineState).not.toHaveClass(/hidden/);

  const gotoBtn = page.locator('#btn-goto-slack');
  await expect(gotoBtn).toBeVisible();

  // The back link returns to the picker.
  await page.locator('#btn-back-to-platforms').click();
  await expect(page.locator('#platform-list-state')).not.toHaveClass(/hidden/);

  await context.close();
});
