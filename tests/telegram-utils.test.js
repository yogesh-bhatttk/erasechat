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

// ============================================================
// Pure helpers behind the dashboard's account label, chat picker, delete
// accounting, and friendly login errors.
// ============================================================

const {
  formatTelegramAccount, buildDialogOption, filterDialogOptions, resolveTargetPeer,
  splitByOwnership, telegramLoginErrorKind
} = require('../platforms/telegram/telegram-utils.js');

test('formatTelegramAccount: name + username, then either alone, then phone', () => {
  assert.equal(formatTelegramAccount({ firstName: 'Ada', lastName: 'Lovelace', username: 'ada' }), 'Ada Lovelace (@ada)');
  assert.equal(formatTelegramAccount({ firstName: 'Ada' }), 'Ada');
  assert.equal(formatTelegramAccount({ username: 'ada' }), '@ada');
  assert.equal(formatTelegramAccount({ phone: '15555555555' }), '+15555555555');
  assert.equal(formatTelegramAccount({ firstName: '  ', phone: '+1555' }), '+1555');
  assert.equal(formatTelegramAccount(null), '');
});

test('buildDialogOption: label, username, stable key; skips the self dialog', () => {
  assert.deepEqual(
    buildDialogOption({ id: 42n, title: 'Family', entity: { className: 'Chat' } }),
    { key: '42', label: 'Family', username: '' }
  );
  assert.deepEqual(
    buildDialogOption({ id: 7, name: '', entity: { username: 'bob', firstName: 'Bob' } }),
    { key: '7', label: 'Bob', username: 'bob' }
  );
  assert.deepEqual(
    buildDialogOption({ id: 9, entity: { username: 'ghost' } }),
    { key: '9', label: '@ghost', username: 'ghost' }
  );
  assert.equal(buildDialogOption({ id: 1, title: 'Saved', entity: { self: true } }), null);
  assert.equal(buildDialogOption({ title: 'No id' }), null);
});

test('filterDialogOptions: case-insensitive over label and @username', () => {
  const opts = [
    { key: '1', label: 'Family Group', username: '' },
    { key: '2', label: 'Robert', username: 'bobby' },
  ];
  assert.deepEqual(filterDialogOptions(opts, 'family').map(o => o.key), ['1']);
  assert.deepEqual(filterDialogOptions(opts, '@BOB').map(o => o.key), ['2']);
  assert.deepEqual(filterDialogOptions(opts, '  ').map(o => o.key), ['1', '2']);
  assert.deepEqual(filterDialogOptions(opts, 'zzz'), []);
});

test('resolveTargetPeer: typed input wins, then a picked dialog, else Saved Messages', () => {
  assert.deepEqual(resolveTargetPeer(' @alice ', '42'), { kind: 'typed', value: '@alice' });
  assert.deepEqual(resolveTargetPeer('', '42'), { kind: 'dialog', value: '42' });
  assert.deepEqual(resolveTargetPeer('', 'me'), { kind: 'self', value: 'me' });
  assert.deepEqual(resolveTargetPeer(undefined, ''), { kind: 'self', value: 'me' });
});

test('splitByOwnership: only msg.out === true counts as own', () => {
  const a = { id: 1, out: true }, b = { id: 2, out: false }, c = { id: 3 };
  const { own, others } = splitByOwnership([a, b, c]);
  assert.deepEqual(own, [a]);
  assert.deepEqual(others, [b, c]);
  assert.deepEqual(splitByOwnership(null), { own: [], others: [] });
});

test('telegramLoginErrorKind: maps MTProto error codes to friendly kinds', () => {
  const k = (m) => telegramLoginErrorKind({ errorMessage: m });
  assert.equal(k('PHONE_NUMBER_INVALID'), 'phoneInvalid');
  assert.equal(k('PHONE_NUMBER_UNOCCUPIED'), 'phoneInvalid');
  assert.equal(k('PHONE_NUMBER_BANNED'), 'phoneBanned');
  assert.equal(k('PHONE_CODE_INVALID'), 'codeInvalid');
  assert.equal(k('PHONE_CODE_EXPIRED'), 'codeExpired');
  assert.equal(k('PASSWORD_HASH_INVALID'), 'passwordInvalid');
  assert.equal(k('API_ID_INVALID'), 'apiIdInvalid');
  assert.equal(k('FLOOD_WAIT_X'), 'flood');
  assert.equal(k('AUTH_KEY_UNREGISTERED'), 'session');
  assert.equal(telegramLoginErrorKind(new Error('WebSocket connection failed')), 'network');
  assert.equal(telegramLoginErrorKind(new Error('something odd')), 'unknown');
  assert.equal(telegramLoginErrorKind(null), 'unknown');
});

test('searchDateBounds: no range -> unbounded (0/0) for messages.Search', () => {
  const { searchDateBounds } = require('../platforms/telegram/telegram-utils.js');
  assert.deepEqual(searchDateBounds({ fromMs: null, toMs: null }), { minDate: 0, maxDate: 0 });
  assert.deepEqual(searchDateBounds(undefined), { minDate: 0, maxDate: 0 });
  assert.deepEqual(searchDateBounds({ fromMs: NaN, toMs: -5 }), { minDate: 0, maxDate: 0 });
});

test('searchDateBounds: ms -> unix seconds, widened by 1s since Telegram bounds are exclusive', () => {
  const { searchDateBounds } = require('../platforms/telegram/telegram-utils.js');
  const fromMs = Date.UTC(2026, 0, 1);              // 1767225600 s
  const toMs = Date.UTC(2026, 0, 31, 23, 59, 59, 999); // end of day
  const { minDate, maxDate } = searchDateBounds({ fromMs, toMs });
  assert.equal(minDate, 1767225600 - 1);
  assert.equal(maxDate, Math.floor(toMs / 1000) + 1);
  // A message sent exactly at either inclusive edge still falls strictly inside.
  assert.ok(Math.floor(fromMs / 1000) > minDate);
  assert.ok(Math.floor(toMs / 1000) < maxDate);
});

test('searchDateBounds: one-sided ranges leave the other bound at 0', () => {
  const { searchDateBounds } = require('../platforms/telegram/telegram-utils.js');
  assert.deepEqual(searchDateBounds({ fromMs: 10_000, toMs: null }), { minDate: 9, maxDate: 0 });
  assert.deepEqual(searchDateBounds({ fromMs: null, toMs: 10_999 }), { minDate: 0, maxDate: 11 });
});

test('searchDateBounds: clamps to the TL int32 range', () => {
  const { searchDateBounds } = require('../platforms/telegram/telegram-utils.js');
  const far = 2 ** 33 * 1000;
  assert.deepEqual(searchDateBounds({ fromMs: far, toMs: far }), { minDate: 2147483647, maxDate: 2147483647 });
});
