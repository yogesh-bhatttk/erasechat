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
    path: path.resolve(__dirname, 'platforms/telegram')
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
      "dgram": false
    },
    alias: {
      'node:crypto': 'crypto-browserify',
      'node:net': false,
      'node:events': 'events',
      'node:stream': 'stream-browserify',
      'node:buffer': 'buffer',
      'node:process': 'process/browser',
      'node:path': 'path-browserify'
    }
  },
  plugins: [
    new NodePolyfillPlugin(),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, '');
    })
  ],
  optimization: {
    minimize: false
  }
};
