// Replaces the `function-bind` package (a transitive dependency pulled in somewhere
// under teleproto/crypto-browserify) for this webpack build only -- see the matching
// comment in webpack.telegram.config.js. The real package is `Function.prototype.bind
// || implementation`, where `implementation` is an ES5-era polyfill that constructs a
// function via `Function('binder', 'return function (...)...')`. Every browser this
// Manifest V3 extension targets has had native Function.prototype.bind for well over a
// decade, so that fallback never runs -- but webpack still bundles it either way, since
// `require('./implementation')` is a static import regardless of which branch of `||`
// wins at runtime. That gave the Firefox Add-on validator a DANGEROUS_EVAL finding for
// dead code. This shim exports only the native bind, so the polyfill is never bundled
// at all instead of merely being unreachable.
module.exports = Function.prototype.bind;
