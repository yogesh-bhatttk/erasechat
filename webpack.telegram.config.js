// Bundles Telegram's popup/dashboard source (telegram-{popup,dashboard}.src.js) with
// teleproto (a real MTProto client) into telegram-{popup,dashboard}.bundle.js, which
// popup.html's #telegram-view and dashboard-telegram.html load directly as
// <script src>. Run by scripts/build.sh before it copies/zips runtime assets.
//
// Ported from bulk-clean-for-telegram's own webpack.config.js -- entry/output names
// changed to avoid colliding with the other platforms' own dashboard-*.* files and
// this repo's own popup.js, otherwise unchanged.
const path = require('path');
const webpack = require('webpack');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: {
    'telegram-popup.bundle': './platforms/telegram/telegram-popup.src.js',
    'telegram-dashboard.bundle': './platforms/telegram/telegram-dashboard.src.js'
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'platforms/telegram'),
    // Without this, webpack's own runtime emits a `new Function('return this')()`
    // fallback (see node_modules/webpack/lib/runtime/GlobalRuntimeModule.js) to find the
    // global object portably across environments that might predate globalThis --
    // exactly the kind of eval-adjacent construct addons-linter's DANGEROUS_EVAL check
    // flags (found in both bundles at review time). This target is always a Manifest V3
    // extension page in a current Chrome/Firefox, where globalThis is guaranteed to
    // exist, so telling webpack that lets it skip the fallback entirely instead of
    // relying on CSP to block a construct that never needed to exist here.
    environment: { globalThis: true }
  },
  resolve: {
    fallback: {
      "net": false,
      "tls": false,
      "fs": false,
      "readline": false,
      "child_process": false,
      "module": false,
      "dns": false,
      "dgram": false,
      // NodePolyfillPlugin would otherwise pull in vm-browserify, whose
      // runInThisContext is a literal eval(this.code) -- reachable (harmlessly, via a
      // caught CSP violation) from a transitive asn1.js call inside teleproto. CSP
      // blocks it today, but that safety is then resting entirely on an incidental
      // try/catch rather than this codebase's own no-eval design. Disabling the
      // polyfill here forces asn1.js's own non-eval fallback path deterministically;
      // there is no legitimate use of Node's `vm` module in a browser bundle anyway.
      "vm": false
    },
    alias: {
      'node:crypto': 'crypto-browserify',
      'node:net': false,
      'node:events': 'events',
      'node:stream': 'stream-browserify',
      'node:buffer': 'buffer',
      'node:process': 'process/browser',
      'node:path': 'path-browserify',
      // See platforms/telegram/function-bind-shim.js: the real `function-bind` package
      // bundles an eval-based ES5 polyfill (dead code in any real browser) alongside its
      // native-bind fast path; this alias keeps only the fast path.
      'function-bind': path.resolve(__dirname, 'platforms/telegram/function-bind-shim.js')
    }
  },
  // webpack's default 244 KiB budget is for pages fetched over the network; these
  // bundles load from the extension package on disk, and ~1.8 MiB is teleproto's
  // generated Telegram API definitions, which can't be split out. Budget for the
  // real size instead of disabling the check, so unexpected growth still warns.
  performance: {
    hints: 'warning',
    maxAssetSize: 4 * 1024 * 1024,
    maxEntrypointSize: 4 * 1024 * 1024
  },
  module: {
    rules: [
      // See scripts/strip-intrinsic-eval-loader.js.
      {
        test: /[\\/]get-intrinsic[\\/]index\.js$/,
        loader: path.resolve(__dirname, 'scripts/strip-intrinsic-eval-loader.js')
      }
    ]
  },
  plugins: [
    new NodePolyfillPlugin(),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, '');
    })
  ]
};
