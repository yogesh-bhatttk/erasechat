// webpack loader for get-intrinsic/index.js (pulled into the Telegram bundles by
// the Node polyfills). Its intrinsics table holds a bare `eval` reference
// ('%eval%': eval) that nothing in these bundles ever looks up, but the reference
// alone trips AMO's DANGEROUS_EVAL check. Replace it with undefined -- same idea as
// platforms/telegram/function-bind-shim.js. Fails the build if the line moves, so a
// get-intrinsic upgrade can't silently bring the warning back.
module.exports = function stripIntrinsicEval(source) {
  const pattern = /'%eval%':\s*eval,/;
  if (!pattern.test(source)) {
    throw new Error("strip-intrinsic-eval-loader: '%eval%': eval entry not found -- re-check get-intrinsic");
  }
  return source.replace(pattern, "'%eval%': undefined,");
};
