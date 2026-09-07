// Bulk Clean for Slack - Playwright E2E: host-permission gating in the popup
//
// Declaring a host permission is not the same as HAVING it. Chrome lets a user set an
// extension's site access to "On click" / "On specific sites", and Firefox MV3 can
// leave host permissions awaiting opt-in. In that state the content script never
// auto-injects and chrome.scripting.executeScript is refused too, so the popup has to
// detect it and say something actionable — it used to advise reloading the Slack page,
// which never fixes it.
//
// Chrome offers no automation hook to revoke a REQUIRED host permission, so these
// specs verify the two halves separately: that detection reports "granted" correctly
// in a normally-installed profile, and that the ungranted branch renders a real,
// wired-up grant affordance when it runs.

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

test('a normally-installed profile is not shown the site-access wall', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Slack host access is granted at install here, so the gate must stay out of the
    // way entirely — a false positive would block every user from the whole extension.
    await expect(page.locator('#permission-required-state')).toBeHidden();

    // The popup's own tab is not Slack, so it lands on the platform picker; entering
    // the Slack view (as a real user would by clicking its row) then lands on the
    // offline state via normal detection.
    await page.locator('.platform-row[data-platform="slack"]').click();
    await expect(page.locator('#slack-inactive-state')).toBeVisible();

    // And the detection helper agrees with the browser.
    const granted = await page.evaluate(() => hasSlackAccess());
    expect(granted).toBe(true);
  } finally {
    await context.close();
  }
});

test('detection fails OPEN so a browser that cannot answer is never locked out', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // hasSlackAccess() is a diagnostic, not a security boundary — the browser's own
    // permission model is the real enforcement. If the check itself cannot run, the
    // user must still reach the extension rather than a wall they cannot dismiss.
    const results = await page.evaluate(async () => {
      const real = chrome.permissions;
      const out = {};
      try {
        // API entirely absent (older/limited browser).
        delete chrome.permissions;
        out.missingApi = await hasSlackAccess();

        // API present but throwing.
        chrome.permissions = { contains: () => { throw new Error('nope'); } };
        out.throwingApi = await hasSlackAccess();
      } finally {
        chrome.permissions = real;
      }
      return out;
    });

    expect(results.missingApi).toBe(true);
    expect(results.throwingApi).toBe(true);
  } finally {
    await context.close();
  }
});

test('the site-access wall replaces the other states and offers a working grant button', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Drive the ungranted branch directly: Chrome exposes no way to revoke a required
    // host permission from automation.
    await page.evaluate(() => showPermissionRequiredState());

    const wall = page.locator('#permission-required-state');
    await expect(wall).toBeVisible();
    // Exactly one state at a time — overlapping states would show contradictory advice.
    await expect(page.locator('#slack-active-state')).toBeHidden();
    await expect(page.locator('#slack-inactive-state')).toBeHidden();

    // The copy must explain the situation, not just name it.
    await expect(wall).toContainText(/slack\.com/i);

    // The manual fallback stays hidden until an in-popup grant actually fails.
    await expect(page.locator('#grant-manual-hint')).toBeHidden();

    // Clicking grant must not dead-end: either access is confirmed and normal
    // detection resumes, or the manual instructions appear.
    await page.locator('#btn-grant-access').click();
    await expect
      .poll(async () => {
        const offline = await page.locator('#slack-inactive-state').isVisible();
        const active = await page.locator('#slack-active-state').isVisible();
        const hint = await page.locator('#grant-manual-hint').isVisible();
        return offline || active || hint;
      })
      .toBe(true);
  } finally {
    await context.close();
  }
});

test('where permissions.request does not exist, the manual steps replace the dead button', async () => {
  // Firefox for Android implements no permissions.request at all — addons-linter flags
  // it as ANDROID_INCOMPATIBLE_API. Offering a button that cannot work would strand the
  // user with no explanation, so the manual instructions must take its place.
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.evaluate(() => {
      chrome.permissions = { contains: (_p, cb) => cb(false) }; // no `request`
      showPermissionRequiredState();
    });

    await expect(page.locator('#permission-required-state')).toBeVisible();
    await expect(page.locator('#grant-manual-hint')).toBeVisible();
    await expect(page.locator('#btn-grant-access')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('a failed content-script injection routes to the wall, not to "reload the page"', async () => {
  const { context, extensionId } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // Reproduce the real ungranted-access failure: executeScript is refused AND the
    // permission check reports "not granted". The popup must show the actionable wall
    // instead of telling the user to reload a page, which would never help.
    await page.evaluate(() => {
      chrome.tabs.sendMessage = (_tabId, _msg, cb) => {
        chrome.runtime.lastError = { message: 'Could not establish connection.' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      };
      chrome.scripting.executeScript = (_opts, cb) => {
        chrome.runtime.lastError = { message: 'Cannot access contents of the page.' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      };
      chrome.permissions.contains = (_p, cb) => cb(false);

      showActiveState(1234);
    });

    await expect(page.locator('#permission-required-state')).toBeVisible();
    await expect(page.locator('#slack-active-state')).toBeHidden();
  } finally {
    await context.close();
  }
});
