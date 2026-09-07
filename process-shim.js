// Minimal global `process` shim. Some bundled legacy Node polyfills (e.g.
// readable-stream, pulled in transitively by teleproto) read
// process.browser/process.version/process.nextTick at module top-level;
// webpack's polyfill plugin doesn't reach every such module, so this must
// exist as a real global before the webpack bundle starts executing. Loaded
// as an external file (not an inline <script>) because MV3 extension pages'
// CSP blocks inline script execution unconditionally.
self.process = self.process || {
  browser: true,
  env: {},
  version: '',
  argv: [],
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
};
