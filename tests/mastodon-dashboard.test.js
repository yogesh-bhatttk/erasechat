// Regression coverage for the Mastodon delete-rate-limit wait: Cancel must stop
// the (up to ~30-minute) paced wait promptly instead of running the whole
// remaining wait out first. See dashboard-mastodon.js's waitForDeleteRateLimit,
// which is a thin wrapper around the two pure/injectable functions tested here.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRateLimitResumeAt,
  runCancelableWait
} = require('../platforms/mastodon/dashboard-mastodon.js');

// ============================================================
// computeRateLimitResumeAt
// ============================================================

test('computeRateLimitResumeAt: returns null when under the cap (no wait needed)', () => {
  assert.strictEqual(computeRateLimitResumeAt([1000, 2000, 3000], 30, 1_800_000), null);
  assert.strictEqual(computeRateLimitResumeAt([], 1, 1_800_000), null);
});

test('computeRateLimitResumeAt: at/over the cap resumes 1s past the oldest timestamp\'s window', () => {
  const timestamps = [1000, 2000, 3000];
  assert.strictEqual(
    computeRateLimitResumeAt(timestamps, 3, 1_800_000),
    1000 + 1_800_000 + 1000
  );
  // Over the cap (caller is expected to have already pruned to the window, but
  // the arithmetic itself only cares about the oldest entry and the count).
  assert.strictEqual(
    computeRateLimitResumeAt(timestamps, 2, 1_800_000),
    1000 + 1_800_000 + 1000
  );
});

// ============================================================
// runCancelableWait -- the actual "does Cancel stop it promptly" behavior
// ============================================================

function makeFakeClock(startMs) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('runCancelableWait: runs to completion, pacing in <=1s chunks, when never cancelled', async () => {
  const clock = makeFakeClock(0);
  const resumeAt = 2500;
  const sleepCalls = [];
  const ticks = [];
  const controller = { cancelled: false };
  const fakeSleep = async (ms) => { sleepCalls.push(ms); clock.advance(ms); };

  const cancelled = await runCancelableWait(resumeAt, controller, fakeSleep, clock.now, (remaining) => ticks.push(remaining));

  assert.strictEqual(cancelled, false);
  assert.deepStrictEqual(sleepCalls, [1000, 1000, 500]); // min(1000, remaining) chunking
  assert.strictEqual(ticks.length, 3);
});

test('runCancelableWait: stops the instant cancelled is set, not after the full remaining wait', async () => {
  // Regression for the bug: a 5-minute wait would previously run out ~300
  // one-second ticks before a Cancel click had any effect. It must now stop
  // after the very next check.
  const clock = makeFakeClock(0);
  const resumeAt = 5 * 60 * 1000; // 5 minutes
  const controller = { cancelled: false };
  let sleepCallCount = 0;
  const fakeSleep = async (ms) => {
    sleepCallCount++;
    clock.advance(ms);
    if (sleepCallCount === 2) controller.cancelled = true; // simulate a Cancel click mid-wait
  };

  const cancelled = await runCancelableWait(resumeAt, controller, fakeSleep, clock.now, () => {});

  assert.strictEqual(cancelled, true);
  assert.strictEqual(sleepCallCount, 2, 'must stop right after the tick where cancellation was observed, not run out the full window');
});

test('runCancelableWait: cancelling before the first tick never sleeps at all', async () => {
  const clock = makeFakeClock(0);
  const controller = { cancelled: true };
  let sleepCallCount = 0;
  const fakeSleep = async () => { sleepCallCount++; };

  const cancelled = await runCancelableWait(10_000, controller, fakeSleep, clock.now, () => {});

  assert.strictEqual(cancelled, true);
  assert.strictEqual(sleepCallCount, 0);
});

test('runCancelableWait: resumeAt already in the past resolves immediately without cancelling', async () => {
  const clock = makeFakeClock(10_000);
  const controller = { cancelled: false };
  let sleepCallCount = 0;
  const fakeSleep = async () => { sleepCallCount++; };

  const cancelled = await runCancelableWait(5_000, controller, fakeSleep, clock.now, () => {});

  assert.strictEqual(cancelled, false);
  assert.strictEqual(sleepCallCount, 0);
});
