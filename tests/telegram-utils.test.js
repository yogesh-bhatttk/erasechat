// Erasechat - Telegram dashboard: telegram-utils.js unit tests (node --test)
//
// cancelableDelay is the fix behind today's "Telegram's Cancel didn't interrupt a
// mid-flood-wait retry" bug (see CHANGELOG) -- the same pattern as Mastodon's
// runCancelableWait (tests/mastodon-dashboard.test.js), and tested the same way:
// injected sleep/now so a multi-minute flood-wait doesn't have to be waited out
// for real.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FloodWaitCancelledError, cancelableDelay } = require('../platforms/telegram/telegram-utils.js');

function makeFakeClock(startMs) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('FloodWaitCancelledError: is a real Error with a distinct name, so callers can tell it apart from a genuine chunk failure', () => {
  const err = new FloodWaitCancelledError();
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'FloodWaitCancelledError');
  assert.equal(err.message, 'Cancelled during flood-wait');
});

test('cancelableDelay: runs to completion, pacing in <=1s chunks, when never cancelled', async () => {
  const clock = makeFakeClock(0);
  const controller = { cancelled: false };
  const sleepCalls = [];
  const fakeSleep = async (ms) => { sleepCalls.push(ms); clock.advance(ms); };

  const cancelled = await cancelableDelay(2500, controller, fakeSleep, clock.now);

  assert.equal(cancelled, false);
  assert.deepEqual(sleepCalls, [1000, 1000, 500]); // min(1000, remaining) chunking
});

test('cancelableDelay: stops the instant cancelled is set, not after the full remaining wait', async () => {
  // Regression for the exact bug this backstops: a flood-wait of several minutes
  // must be interrupted at the next 1s tick, not run out in full.
  const clock = makeFakeClock(0);
  const controller = { cancelled: false };
  let sleepCallCount = 0;
  const fakeSleep = async (ms) => {
    sleepCallCount++;
    clock.advance(ms);
    if (sleepCallCount === 2) controller.cancelled = true; // simulate a Cancel click mid-wait
  };

  const cancelled = await cancelableDelay(5 * 60 * 1000, controller, fakeSleep, clock.now);

  assert.equal(cancelled, true);
  assert.equal(sleepCallCount, 2, 'must stop right after the tick where cancellation was observed');
});

test('cancelableDelay: cancelling before the first tick never sleeps at all', async () => {
  const clock = makeFakeClock(0);
  const controller = { cancelled: true };
  let sleepCallCount = 0;
  const fakeSleep = async () => { sleepCallCount++; };

  const cancelled = await cancelableDelay(10_000, controller, fakeSleep, clock.now);

  assert.equal(cancelled, true);
  assert.equal(sleepCallCount, 0);
});

test('cancelableDelay: with no cancelController supplied, runs the full wait and reports false', async () => {
  // invokeWithFloodWait's scan-path call site has no Cancel button today -- this is
  // that call shape.
  const clock = makeFakeClock(0);
  let sleepCallCount = 0;
  const fakeSleep = async (ms) => { sleepCallCount++; clock.advance(ms); };

  const cancelled = await cancelableDelay(1500, undefined, fakeSleep, clock.now);

  assert.equal(cancelled, false);
  assert.equal(sleepCallCount, 2); // 1000 + 500
});

test('cancelableDelay: a deadline already in the past resolves immediately without sleeping', async () => {
  const clock = makeFakeClock(10_000);
  const controller = { cancelled: false };
  let sleepCallCount = 0;
  const fakeSleep = async () => { sleepCallCount++; };

  const cancelled = await cancelableDelay(-5_000, controller, fakeSleep, clock.now);

  assert.equal(cancelled, false);
  assert.equal(sleepCallCount, 0);
});
