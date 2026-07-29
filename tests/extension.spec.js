// Bulk Clean for Slack - Playwright E2E Test Suite

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../');

test('should load popup page and render offline state by default', async () => {
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

  // Verify UI elements are present
  const offlineState = page.locator('#slack-inactive-state');
  await expect(offlineState).not.toHaveClass(/hidden/);
  
  const title = await page.locator('h1').innerText();
  expect(title).toBe('Bulk Clean');

  // Verify presence of redirect action button
  const gotoBtn = page.locator('#btn-goto-slack');
  await expect(gotoBtn).toBeVisible();

  await context.close();
});
