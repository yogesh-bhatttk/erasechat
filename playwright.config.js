// Playwright config for SlackClean Premium E2E / logic specs.
// Note: unit.test.js uses the Node built-in test runner (`npm test`), so it is
// deliberately excluded here to avoid the two runners colliding.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: false,
  reporter: [['list']]
});
