const test = require('node:test');
const assert = require('node:assert');

const { resolveXScriptUrl } = require('../platforms/x/dashboard-x.js');

test('resolveXScriptUrl resolves root-relative X bundles against x.com', () => {
  assert.strictEqual(
    resolveXScriptUrl('/responsive-web/client-web/main.abc123.js'),
    'https://x.com/responsive-web/client-web/main.abc123.js'
  );
});

test('resolveXScriptUrl preserves absolute bundle URLs', () => {
  assert.strictEqual(
    resolveXScriptUrl('https://abs.twimg.com/responsive-web/client-web/main.abc123.js'),
    'https://abs.twimg.com/responsive-web/client-web/main.abc123.js'
  );
});