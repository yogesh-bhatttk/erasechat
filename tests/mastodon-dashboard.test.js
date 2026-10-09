// Regression coverage for the Mastodon delete-rate-limit wait: Cancel must stop
// the (up to ~30-minute) paced wait promptly instead of running the whole
// remaining wait out first. See dashboard-mastodon.js's waitForDeleteRateLimit,
// which is a thin wrapper around the two pure/injectable functions tested here.
const test = require('node:test');
const assert = require('node:assert/strict');

// dashboard-fetch-utils.js's t() isn't loaded under node -- stand in with the
// English fallback it would return when chrome.i18n has no message.
globalThis.t = (key, fallback) => fallback;

const {
  computeRateLimitResumeAt,
  computeServerRateLimitResumeAt,
  runCancelableWait,
  htmlToPlainText,
  statusPlainText,
  buildDeleteStatusEndpoint,
  buildMastodonPermalink,
  isScopeError,
  estimateMastodonDeleteMs,
  friendlyMastodonError
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

// ============================================================
// HTML entity decoding (audit: "&#39; &amp; not decoded in filter/preview")
// ============================================================

test('htmlToPlainText: strips tags AND decodes the entities Mastodon emits', () => {
  assert.equal(htmlToPlainText('<p>don&#39;t &amp; won&apos;t &quot;quote&quot; &lt;tag&gt;</p>'), `don't & won't "quote" <tag>`);
  assert.equal(htmlToPlainText('caf&#xE9; &#128512;'), 'caf\u00e9 \u{1F600}');
});

test('htmlToPlainText: paragraph and line breaks become whitespace, not fused words', () => {
  assert.equal(htmlToPlainText('<p>one</p><p>two<br>three</p>'), 'one\n\ntwo\nthree');
});

test('htmlToPlainText: an unknown entity is left as-is; empty input is empty', () => {
  assert.equal(htmlToPlainText('a &bogus; b'), 'a &bogus; b');
  assert.equal(htmlToPlainText(''), '');
  assert.equal(htmlToPlainText(null), '');
});

test('htmlToPlainText: uses window.DOMParser when the browser provides one', () => {
  const calls = [];
  globalThis.window = { DOMParser: class { parseFromString(html, type) { calls.push([html, type]); return { body: { textContent: ' parsed ' } }; } } };
  try {
    assert.equal(htmlToPlainText('<p>x</p>'), 'parsed');
    assert.deepEqual(calls, [['<p>x</p>', 'text/html']]);
  } finally {
    delete globalThis.window;
  }
});

test('statusPlainText: a filter for an apostrophe now matches (decoded text is used for filtering)', () => {
  const status = { content: '<p>I don&#39;t like Mondays</p>' };
  assert.ok(statusPlainText(status).toLowerCase().includes("don't"));
});

test('statusPlainText: a boost uses the reblogged content', () => {
  assert.equal(statusPlainText({ content: '', reblog: { content: '<p>boosted &amp; shared</p>' } }), 'boosted & shared');
});

// ============================================================
// delete_media=true (audit: media attachments left behind)
// ============================================================

test('buildDeleteStatusEndpoint: deletes media attachments too', () => {
  assert.equal(buildDeleteStatusEndpoint('109876543210'), '/api/v1/statuses/109876543210?delete_media=true');
  const url = new URL('https://example.social' + buildDeleteStatusEndpoint('abc_DEF-1'));
  assert.equal(url.searchParams.get('delete_media'), 'true');
});

test('buildDeleteStatusEndpoint: rejects an id that could alter the path', () => {
  for (const bad of ['../accounts/1', '1?x=2', '1/2', '', undefined, 5]) {
    assert.equal(buildDeleteStatusEndpoint(bad), null, String(bad));
  }
});

// ============================================================
// Server rate-limit headers, scope errors, ETA, permalinks, friendly errors
// ============================================================

test('computeServerRateLimitResumeAt: pauses until X-RateLimit-Reset when remaining hits 0', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(computeServerRateLimitResumeAt('0', '2026-01-01T00:10:00Z', now), Date.parse('2026-01-01T00:10:00Z') + 1000);
  assert.equal(computeServerRateLimitResumeAt('5', '2026-01-01T00:10:00Z', now), null);
  assert.equal(computeServerRateLimitResumeAt('0', '2025-12-31T23:59:00Z', now), null, 'reset already passed');
  assert.equal(computeServerRateLimitResumeAt(null, null, now), null);
  assert.equal(computeServerRateLimitResumeAt('0', 'garbage', now), null);
});

test('isScopeError: recognizes Mastodon\'s read-only token 403', () => {
  assert.equal(isScopeError(403, 'This action is outside the authorized scopes'), true);
  assert.equal(isScopeError(403, 'Forbidden'), false);
  assert.equal(isScopeError(401, 'This action is outside the authorized scopes'), false);
});

test('friendlyMastodonError: a scope failure names write:statuses; statuses never surface as "API Error"', () => {
  assert.match(friendlyMastodonError({ scopeMissing: true, status: 403 }), /write:statuses/);
  assert.match(friendlyMastodonError({ status: 429, retryAfterMs: 10 * 60_000 }), /10 minute/);
  assert.match(friendlyMastodonError({ status: 502 }), /502/);
  assert.match(friendlyMastodonError(new TypeError('Failed to fetch')), /internet connection/);
});

test('estimateMastodonDeleteMs: 30 per 30 minutes', () => {
  const W = 30 * 60_000;
  assert.equal(estimateMastodonDeleteMs(0, 0, 30, W, 750), 0);
  assert.equal(estimateMastodonDeleteMs(30, 0, 30, W, 750), 30 * 750, 'one window, no wait');
  assert.equal(estimateMastodonDeleteMs(31, 0, 30, W, 750), W + 31 * 750);
  assert.equal(estimateMastodonDeleteMs(300, 0, 30, W, 750), 9 * W + 300 * 750, '300 posts is ~4.5 hours');
  assert.equal(estimateMastodonDeleteMs(10, 25, 30, W, 750), W + 10 * 750, 'deletes already in the window count');
});

test('buildMastodonPermalink: built from the validated host and ids only', () => {
  assert.equal(buildMastodonPermalink('mastodon.social', 'alice', { id: '123' }), 'https://mastodon.social/@alice/123');
  assert.equal(buildMastodonPermalink('mastodon.social', 'alice', { id: '9', reblog: { id: '77', account: { acct: 'bob@other.example' } } }), 'https://mastodon.social/@bob@other.example/77');
  assert.equal(buildMastodonPermalink('evil.com/x', 'alice', { id: '1' }), null);
  assert.equal(buildMastodonPermalink('mastodon.social', 'alice', { id: 'javascript:alert(1)' }), null);
  assert.equal(buildMastodonPermalink('mastodon.social', 'a/../b', { id: '1' }), null);
});

// ============================================================
// Advanced filters / export helpers
// ============================================================
{
  const {
    statusTimeMs, mastodonIsoDate, isMastodonPageOlderThan,
    buildPinnedIdSet, isStatusPinned, buildMastodonExportColumns
  } = require('../platforms/mastodon/dashboard-mastodon.js');

  test('statusTimeMs: parses created_at, null for missing/invalid', () => {
    assert.strictEqual(statusTimeMs({ created_at: '2026-01-02T03:04:05.000Z' }), Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.strictEqual(statusTimeMs({}), null);
    assert.strictEqual(statusTimeMs({ created_at: 'nope' }), null);
    assert.strictEqual(statusTimeMs(null), null);
  });

  test('mastodonIsoDate: ISO for valid dates, empty string otherwise', () => {
    assert.strictEqual(mastodonIsoDate('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
    assert.strictEqual(mastodonIsoDate(''), '');
    assert.strictEqual(mastodonIsoDate(undefined), '');
    assert.strictEqual(mastodonIsoDate('garbage'), '');
  });

  test('isMastodonPageOlderThan: only a page entirely before fromMs stops paging', () => {
    const from = Date.UTC(2026, 0, 10);
    const old = { created_at: '2026-01-01T00:00:00Z' };
    const fresh = { created_at: '2026-01-15T00:00:00Z' };
    assert.strictEqual(isMastodonPageOlderThan([old, old], from), true);
    assert.strictEqual(isMastodonPageOlderThan([fresh, old], from), false);
    assert.strictEqual(isMastodonPageOlderThan([old, old], null), false, 'no From date -> never stop early');
    assert.strictEqual(isMastodonPageOlderThan([], from), false);
    assert.strictEqual(isMastodonPageOlderThan([{}, {}], from), false, 'undatable page is not evidence of age');
    assert.strictEqual(isMastodonPageOlderThan([{}, old], from), true);
  });

  test('buildPinnedIdSet / isStatusPinned: pinned list ids or the per-status flag', () => {
    const ids = buildPinnedIdSet([{ id: '1' }, { id: 2 }, null, { id: {} }]);
    assert.deepStrictEqual([...ids].sort(), ['1', '2']);
    assert.strictEqual(buildPinnedIdSet(undefined).size, 0);
    assert.strictEqual(buildPinnedIdSet({ error: 'x' }).size, 0);
    assert.strictEqual(isStatusPinned({ id: '1' }, ids), true);
    assert.strictEqual(isStatusPinned({ id: '9', pinned: true }, new Set()), true);
    assert.strictEqual(isStatusPinned({ id: '9', pinned: false }, ids), false);
    assert.strictEqual(isStatusPinned(null, ids), false);
  });

  test('buildMastodonExportColumns: id, ISO date, visibility, counts, plain text, validated permalink', () => {
    const cols = buildMastodonExportColumns('mastodon.social', 'alice');
    assert.deepStrictEqual(cols.map(c => c.label), ['ID', 'Date', 'Visibility', 'Favourites', 'Boosts', 'Text', 'URL']);
    const status = {
      id: '42', created_at: '2026-03-04T05:06:07Z', visibility: 'public',
      favourites_count: 3, reblogs_count: 1, content: '<p>don&#39;t</p>', url: 'javascript:alert(1)'
    };
    assert.deepStrictEqual(cols.map(c => c.get(status)),
      ['42', '2026-03-04T05:06:07.000Z', 'public', 3, 1, "don't", 'https://mastodon.social/@alice/42']);
    const bad = buildMastodonExportColumns('not a host', 'alice');
    assert.strictEqual(bad[6].get(status), '', 'never falls back to the server-supplied url');
    assert.deepStrictEqual(cols.map(c => c.get({})), ['', '', '', 0, 0, '', '']);
  });
}
