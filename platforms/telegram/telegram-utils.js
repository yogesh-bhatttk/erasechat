// Erasechat - Telegram dashboard: small, dependency-free helpers split out of
// telegram-dashboard.src.js into their own plain CommonJS module so they're
// unit-testable directly (see tests/telegram-utils.test.js) without needing
// teleproto or a live MTProto client. isTelegramAuthError stays in
// telegram-dashboard.src.js itself -- it depends on teleproto's
// errors.UnauthorizedError, so it isn't dependency-free the way these two are.
// Bundled into telegram-dashboard.bundle.js by webpack like any other local import
// (see webpack.telegram.config.js); also require()-able directly from a plain
// Node test, unlike that file (which uses `import`/DOM APIs at module scope).

// Thrown when a Cancel click interrupts a flood-wait sleep inside
// invokeWithFloodWait, so callers can tell "the user cancelled" apart from "this
// chunk genuinely failed" without inspecting error message text.
class FloodWaitCancelledError extends Error {
  constructor() {
    super('Cancelled during flood-wait');
    this.name = 'FloodWaitCancelledError';
  }
}

// Cancel-aware sleep: ticks in <=1s steps and bails out the moment
// cancelController.cancelled flips, instead of sleeping the full duration in one
// shot -- the same pattern as Mastodon's runCancelableWait
// (platforms/mastodon/dashboard-mastodon.js), needed here because a flood-wait can
// run for minutes on a large "delete for everyone" batch. `sleep`/`now` are
// injectable (defaulting to a real setTimeout/Date.now) so tests don't have to
// wait out a real multi-minute flood-wait -- see tests/telegram-utils.test.js.
async function cancelableDelay(
  ms,
  cancelController,
  sleep = (t) => new Promise((res) => setTimeout(res, t)),
  now = () => Date.now()
) {
  const deadline = now() + ms;
  while (now() < deadline) {
    if (cancelController && cancelController.cancelled) return true;
    await sleep(Math.min(1000, deadline - now()));
  }
  return !!(cancelController && cancelController.cancelled);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FloodWaitCancelledError, cancelableDelay };
}
