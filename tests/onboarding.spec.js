// Bulk Clean for Slack - Playwright E2E: first-run onboarding flow
//
// Exercises real extension behavior (popup JS + chrome.storage.local) without
// needing a live Slack session. Requires: npx playwright install

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '../');

async function launch() {
  const context = await chromium.launchPersistentContext('', {
    headless: false, // extensions require headful mode
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

test('onboarding shows on first run, then stays dismissed', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // First run: the onboarding card is visible.
    const onboarding = page.locator('#onboarding-card');
    await expect(onboarding).toBeVisible();

    // The disclosure names its independence from Slack (C4 transparency).
    await expect(onboarding).toContainText(/not affiliated with or endorsed by Slack/i);

    // Dismiss persists the flag.
    await page.locator('#btn-dismiss-onboarding').click();
    await expect(onboarding).toBeHidden();

    // Reopening the popup does not show onboarding again.
    const page2 = await context.newPage();
    await page2.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page2.locator('#onboarding-card')).toBeHidden();
  } finally {
    await context.close();
  }
});
