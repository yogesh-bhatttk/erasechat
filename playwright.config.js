// Playwright config for Bulk Clean for Slack E2E / logic specs.
// Note: unit.test.js uses the Node built-in test runner (`npm test`), so it is
// deliberately excluded here to avoid the two runners colliding.
const { defineConfig } = require('@playwright/test');

const isCI = !!process.env.CI;

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: false,

  // Browser extensions cannot be loaded headless, so every extension spec launches a
  // HEADFUL Chromium via launchPersistentContext — each one a real browser process with
  // a real window, not a lightweight page. Playwright's default worker count (cores/2)
  // is tuned for headless pages and starts far too many of those at once: on a loaded
  // machine they starve each other and time out, and on a 2-core CI runner cores/2 is
  // barely better. Observed directly during development — three specs failed at load
  // average 26, then all twelve passed unchanged on an idle machine.
  //
  // That failure mode is worse than slow. A gate that fails for reasons unrelated to the
  // code trains you to re-run until green, which is exactly how a real failure gets
  // waved through — on a tool whose whole job is permanently deleting data. Two workers
  // keeps the suite quick (~7s) while leaving headroom for the browsers to start.
  workers: 2,

  // One retry on CI only. Locally a flake should be seen and fixed, not papered over;
  // on CI a single infrastructure hiccup should not block a release. Any test needing
  // the retry still shows as "flaky" in the report rather than passing silently.
  retries: isCI ? 1 : 0,

  // Fail the run if a spec is left with test.only committed, which would silently
  // shrink the gate to one test while still reporting green.
  forbidOnly: isCI,

  reporter: [['list']]
});
