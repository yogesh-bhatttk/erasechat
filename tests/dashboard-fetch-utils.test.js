// Erasechat - shared dashboard-fetch-utils.js unit tests (node --test)
//
// runDeleteLoop() is the bulk-delete loop skeleton extracted out of Reddit/
// Mastodon/Teams/X's four previously-duplicated (and already drifting -- see
// CHANGELOG) delete handlers. This file exercises it in isolation, against a
// minimal in-memory chrome.storage.local mock, so its cancel/expiredAuth/pacing
// behavior is covered directly rather than only indirectly through whichever
// platform happens to be touched next.

const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeChromeStorage() {
  const store = {};
  return {
    local: {
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => { for (const k of keys) delete store[k]; },
      get: async (keys) => {
        const out = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      }
    },
    _store: store
  };
}

global.chrome = { storage: makeFakeChromeStorage() };
global.window = {}; // armCancelButton/resetCancelButton aren't exercised here, but the file checks typeof window

const { runDeleteLoop, createCancelController } = require('../platforms/shared/dashboard-fetch-utils.js');

function fakeProgressText() {
  return { textContent: '' };
}

test('runDeleteLoop: deletes every item, reporting a clean "Deleted N of M" when nothing fails', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const deleted = [];
  const progressText = fakeProgressText();
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_1',
    progressText,
    deleteItem: async (item) => { deleted.push(item.id); }
  });

  assert.deepEqual(deleted, ['a', 'b', 'c']);
  assert.equal(result.deletedCount, 3);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.processedItems, items);
  assert.deepEqual(result.succeededItems, items);
  assert.equal(result.expiredAuth, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.totalCount, 3);
  assert.equal(progressText.textContent, 'Deleted 3 of 3 · 100%');
});

test('runDeleteLoop: the progress marker is cleared from storage once the loop finishes', async () => {
  const key = 'test_progress_marker_cleared';
  const storage = global.chrome.storage;
  await runDeleteLoop([{ id: '1' }], {
    cancelController: createCancelController(),
    progressKey: key,
    progressText: fakeProgressText(),
    deleteItem: async () => {}
  });
  assert.equal(key in storage._store, false, 'progress marker must not be left behind after a normal finish');
});

test('runDeleteLoop: an ordinary per-item failure is recorded but does not stop the run', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const progressText = fakeProgressText();
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_2',
    progressText,
    deleteItem: async (item) => {
      if (item.id === 'b') throw new Error('transient failure');
    }
  });

  assert.equal(result.deletedCount, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].id, 'b');
  assert.equal(result.failures[0].message, 'transient failure');
  assert.equal(result.processedItems.length, 3, 'every item is still attempted after an ordinary failure');
  assert.deepEqual(result.succeededItems.map(i => i.id), ['a', 'c'],
    'the failed item must be excluded from succeededItems so a caller filtering by it stays visible, not silently vanish like a real delete');
  assert.equal(progressText.textContent, 'Processed 3 of 3 (2 deleted, 1 failed) · 100%');
});

test('runDeleteLoop: an error with expiredAuth stops immediately, leaving later items unprocessed', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_3',
    progressText: fakeProgressText(),
    deleteItem: async (item) => {
      attempted.push(item.id);
      if (item.id === 'b') {
        const err = new Error('token invalid');
        err.expiredAuth = true;
        throw err;
      }
    }
  });

  assert.deepEqual(attempted, ['a', 'b'], 'must stop at the failing item, never attempting c/d');
  assert.equal(result.expiredAuth, true);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.processedItems.length, 2);
});

test('runDeleteLoop: a custom field on a thrown error (e.g. staleQueryId) survives on failures[].error for the caller to inspect', async () => {
  const err = new Error('bad query id');
  err.staleQueryId = true;
  const result = await runDeleteLoop([{ id: 'x' }], {
    cancelController: createCancelController(),
    progressKey: 'test_progress_4',
    progressText: fakeProgressText(),
    deleteItem: async () => { throw err; }
  });

  assert.equal(result.failures[0].error, err);
  assert.equal(result.failures[0].error.staleQueryId, true);
});

test('runDeleteLoop: cancelling mid-run stops before the next item and reports cancelled: true', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const cancelController = createCancelController();
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController,
    progressKey: 'test_progress_5',
    progressText: fakeProgressText(),
    deleteItem: async (item) => {
      attempted.push(item.id);
      if (item.id === 'a') cancelController.cancel(); // simulate a Cancel click during item a's own delete
    }
  });

  assert.deepEqual(attempted, ['a'], 'item a still completes (it was already in flight), but b/c are never attempted');
  assert.equal(result.cancelled, true);
  assert.equal(result.expiredAuth, false);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.processedItems.length, 1);
});

test('runDeleteLoop: preItemWait runs BEFORE an item is attempted or added to processedItems, and can itself observe cancellation', async () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const cancelController = createCancelController();
  const waitCalls = [];
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController,
    progressKey: 'test_progress_6',
    progressText: fakeProgressText(),
    preItemWait: async (controller) => {
      waitCalls.push('waited');
      if (waitCalls.length === 2) controller.cancel(); // cancel during the SECOND item's pre-wait
    },
    deleteItem: async (item) => { attempted.push(item.id); }
  });

  assert.equal(waitCalls.length, 2, 'preItemWait runs once per item, including the one that gets cancelled during its own wait');
  assert.deepEqual(attempted, ['a'], 'b is never attempted -- cancellation observed right after its preItemWait');
  assert.equal(result.processedItems.length, 1, 'b must not be marked processed since its wait was cancelled before the attempt');
  assert.equal(result.cancelled, true);
});

// Spies on the global setTimeout that delay()/runDeleteLoop's real (non-injectable)
// pacing goes through, resolving instantly instead of actually waiting -- avoids a
// wall-clock-timing-based assertion (flaky under CI/machine load) while still
// proving exactly how many delay() calls happened and with what duration.
async function withInstantTimers(fn) {
  const original = global.setTimeout;
  const calls = [];
  global.setTimeout = (cb, ms) => { calls.push(ms); cb(); return 0; };
  try {
    await fn(calls);
  } finally {
    global.setTimeout = original;
  }
}

test('runDeleteLoop: postItemDelayMs runs after every completed item, including the last one (matches all four original implementations -- none special-cased "is this the last item")', async () => {
  await withInstantTimers(async (calls) => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    await runDeleteLoop(items, {
      cancelController: createCancelController(),
      progressKey: 'test_progress_7',
      progressText: fakeProgressText(),
      postItemDelayMs: 200,
      deleteItem: async () => {}
    });
    assert.deepEqual(calls, [200, 200, 200]);
  });
});

test('runDeleteLoop: postItemDelayMs is never invoked after a break (expiredAuth or cancelled)', async () => {
  await withInstantTimers(async (calls) => {
    await runDeleteLoop([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
      cancelController: createCancelController(),
      progressKey: 'test_progress_7b',
      progressText: fakeProgressText(),
      postItemDelayMs: 200,
      deleteItem: async (item) => {
        if (item.id === 'a') {
          const err = new Error('invalid');
          err.expiredAuth = true;
          throw err;
        }
      }
    });
    assert.deepEqual(calls, [], 'the loop breaks on expiredAuth before ever reaching the delay call');
  });
});

test('runDeleteLoop: a fatal (non-per-item) exception mid-run still surfaces how far the run got, via err.deleteLoopProgress', async () => {
  // Simulates the extension context being invalidated mid-run (a real risk every
  // original per-platform implementation's own outer try/catch existed to guard
  // against) by making maybeSaveDeleteProgress's underlying storage call throw
  // after the 2nd item -- this is NOT a per-item deleteItem() failure, so it must
  // propagate as a real rejection, not get swallowed into `failures`.
  const originalSet = global.chrome.storage.local.set;
  let setCallCount = 0;
  global.chrome.storage.local.set = async (obj) => {
    setCallCount++;
    // Call #1 is the initial progress marker (before any item runs). With
    // PROGRESS_SAVE_INTERVAL=10 and only 2 items, maybeSaveDeleteProgress only
    // actually writes when processed===total -- i.e. call #2 is item b's save,
    // made right after item a has already completed successfully.
    if (setCallCount === 2) throw new Error('storage unavailable');
    return originalSet(obj);
  };

  try {
    await assert.rejects(
      runDeleteLoop([{ id: 'a' }, { id: 'b' }], {
        cancelController: createCancelController(),
        progressKey: 'test_progress_fatal',
        progressText: fakeProgressText(),
        deleteItem: async () => {}
      }),
      (err) => {
        assert.equal(err.message, 'storage unavailable');
        assert.ok(err.deleteLoopProgress, 'the rethrown error must carry a deleteLoopProgress snapshot');
        // Both items' deleteItem() calls already succeeded (deletedCount reflects
        // that) by the time item b's own progress-save throws -- the exception
        // happens strictly AFTER deletedCount++ for the item being processed.
        assert.equal(err.deleteLoopProgress.deletedCount, 2);
        assert.equal(err.deleteLoopProgress.totalCount, 2);
        return true;
      }
    );
  } finally {
    global.chrome.storage.local.set = originalSet;
  }
});

// ============================================================
// Rate-limit circuit breaker (audit Fix 3) -- several consecutive `.status ===
// 429` failures must stop the whole run early, the same way expiredAuth does,
// instead of burning through the rest of a large batch at full pacing.
// ============================================================

function rateLimitError() {
  const err = new Error('status 429');
  err.status = 429;
  return err;
}

test('runDeleteLoop: N consecutive 429 failures trip the circuit breaker and stop the run early', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }];
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_ratelimit_1',
    progressText: fakeProgressText(),
    deleteItem: async (item) => {
      attempted.push(item.id);
      throw rateLimitError();
    }
  });

  assert.equal(result.rateLimited, true);
  assert.equal(result.expiredAuth, false);
  assert.equal(result.cancelled, false);
  assert.ok(attempted.length < items.length, 'must stop before attempting every item');
  assert.equal(attempted.length, 4, 'stops right after the 4th consecutive 429 (the threshold)');
  assert.equal(result.failures.length, 4);
});

test('runDeleteLoop: fewer than the threshold worth of 429s in a row does not trip the breaker', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_ratelimit_2',
    progressText: fakeProgressText(),
    deleteItem: async (item) => {
      attempted.push(item.id);
      throw rateLimitError();
    }
  });

  assert.deepEqual(attempted, ['a', 'b', 'c'], 'every item attempted -- only 3 consecutive 429s, below the threshold');
  assert.equal(result.rateLimited, false);
  assert.equal(result.failures.length, 3);
});

test('runDeleteLoop: a successful delete in between resets the consecutive-429 streak', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }];
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_ratelimit_3',
    progressText: fakeProgressText(),
    deleteItem: async (item) => {
      attempted.push(item.id);
      // 3 consecutive 429s (a, b, c), then a real success (d) resets the streak,
      // then 3 more 429s (e, f, g) -- never 4 in a row, so the breaker must not trip.
      if (item.id === 'd') return;
      throw rateLimitError();
    }
  });

  assert.deepEqual(attempted, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'every item attempted -- the success at d resets the streak');
  assert.equal(result.rateLimited, false);
  assert.equal(result.deletedCount, 1);
});

test('runDeleteLoop: a non-429 failure in between resets the consecutive-429 streak', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }];
  const attempted = [];
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_ratelimit_4',
    progressText: fakeProgressText(),
    deleteItem: async (item) => {
      attempted.push(item.id);
      if (item.id === 'd') throw new Error('ordinary per-item failure, no .status');
      throw rateLimitError();
    }
  });

  assert.deepEqual(attempted, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'every item attempted -- the ordinary failure at d resets the streak');
  assert.equal(result.rateLimited, false);
});

test('runDeleteLoop: rateLimited stops before an expiredAuth-style break would even matter -- both are early-abort, mutually exclusive outcomes', async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const result = await runDeleteLoop(items, {
    cancelController: createCancelController(),
    progressKey: 'test_progress_ratelimit_5',
    progressText: fakeProgressText(),
    deleteItem: async () => { throw rateLimitError(); }
  });
  assert.equal(result.rateLimited, true);
  assert.equal(result.expiredAuth, false);
});

test('runDeleteLoop: with no preItemWait/postItemDelayMs supplied, runs with no artificial delay at all', async () => {
  await withInstantTimers(async (calls) => {
    await runDeleteLoop([{ id: 'a' }, { id: 'b' }], {
      cancelController: createCancelController(),
      progressKey: 'test_progress_8',
      progressText: fakeProgressText(),
      deleteItem: async () => {}
    });
    assert.deepEqual(calls, [], 'no delay hooks supplied means no waiting between items');
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetry: Retry-After / x-rate-limit-reset handling, cap, cancellation.
// ---------------------------------------------------------------------------
const {
  fetchWithRetry, parseRetryAfterMs, computeRetryDelayMs,
  formatScanCount, formatDeleteProgress,
  resetSelection, renderSelectAllControl, addRowCheckbox, wireSelectAll,
  getSelectedCount, getSelectedItems, resolveDocumentLanguage
} = require('../platforms/shared/dashboard-fetch-utils.js');

function fakeResponse(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => lower[k.toLowerCase()] ?? null } };
}

async function withFetchSequence(responses, fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(url);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

test('parseRetryAfterMs: Retry-After seconds, HTTP-date, x-rate-limit-reset epoch, x-ratelimit-reset delta', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  assert.equal(parseRetryAfterMs(fakeResponse(429, { 'Retry-After': '7' }), now), 7000);
  assert.equal(parseRetryAfterMs(fakeResponse(429, { 'Retry-After': new Date(now + 15000).toUTCString() }), now), 15000);
  assert.equal(parseRetryAfterMs(fakeResponse(429, { 'x-rate-limit-reset': String(now / 1000 + 42) }), now), 42000);
  assert.equal(parseRetryAfterMs(fakeResponse(429, { 'x-ratelimit-reset': '12' }), now), 12000);
  assert.equal(parseRetryAfterMs(fakeResponse(429, { 'x-ratelimit-reset': new Date(now + 3000).toISOString() }), now), 3000);
  assert.equal(parseRetryAfterMs(fakeResponse(429, {}), now), null);
  assert.equal(parseRetryAfterMs(fakeResponse(429, { 'Retry-After': 'garbage' }), now), null);
});

test('computeRetryDelayMs: server hint honoured for 429/503 and capped; exponential fallback otherwise', () => {
  assert.equal(computeRetryDelayMs(fakeResponse(429, { 'Retry-After': '30' }), 0), 30000);
  assert.equal(computeRetryDelayMs(fakeResponse(503, { 'Retry-After': '30' }), 0), 30000);
  assert.equal(computeRetryDelayMs(fakeResponse(429, { 'Retry-After': '900' }), 0), 120000, 'capped at 120s');
  assert.equal(computeRetryDelayMs(fakeResponse(500, { 'Retry-After': '30' }), 0), 2000, 'only 429/503 use the hint');
  assert.equal(computeRetryDelayMs(fakeResponse(429, {}), 0), 2000);
  assert.equal(computeRetryDelayMs(fakeResponse(429, {}), 1), 4000);
});

test('fetchWithRetry: waits for Retry-After before retrying a 429, then returns the success', async () => {
  const waits = [];
  const ok = fakeResponse(200);
  await withFetchSequence([fakeResponse(429, { 'Retry-After': '5' }), ok], async (calls) => {
    const res = await fetchWithRetry('https://example.test/a', {}, 3, { _sleep: async (ms) => { waits.push(ms); } });
    assert.equal(res, ok);
    assert.equal(calls.length, 2);
  });
  assert.equal(waits.reduce((a, b) => a + b, 0), 5000);
});

test('fetchWithRetry: persistent 5xx still returns the last bad Response after exponential backoff', async () => {
  const waits = [];
  const bad = fakeResponse(502);
  await withFetchSequence([bad], async (calls) => {
    const res = await fetchWithRetry('https://example.test/b', {}, 3, { _sleep: async (ms) => { waits.push(ms); } });
    assert.equal(res, bad);
    assert.equal(calls.length, 3);
  });
  assert.equal(waits.reduce((a, b) => a + b, 0), 2000 + 4000);
});

test('fetchWithRetry: cancelling during a long Retry-After wait returns the bad Response without retrying', async () => {
  const controller = createCancelController();
  const bad = fakeResponse(429, { 'Retry-After': '60' });
  let slept = 0;
  await withFetchSequence([bad, fakeResponse(200)], async (calls) => {
    const res = await fetchWithRetry('https://example.test/c', {}, 3, {
      cancelController: controller,
      _sleep: async (ms) => { slept += ms; if (slept >= 1000) controller.cancel(); }
    });
    assert.equal(res, bad);
    assert.equal(calls.length, 1, 'no retry after cancel');
  });
  assert.ok(slept < 60000, `stopped waiting early (slept ${slept}ms)`);
});

test('fetchWithRetry: a cancel controller can also be passed directly as the 4th argument', async () => {
  const controller = createCancelController();
  controller.cancel();
  const bad = fakeResponse(503, { 'Retry-After': '30' });
  await withFetchSequence([bad, fakeResponse(200)], async (calls) => {
    const res = await fetchWithRetry('https://example.test/d', {}, 3, controller);
    assert.equal(res, bad);
    assert.equal(calls.length, 1);
  });
});

test('fetchWithRetry: the original 3-argument call shape still works', async () => {
  const ok = fakeResponse(200);
  await withFetchSequence([ok], async () => {
    assert.equal(await fetchWithRetry('https://example.test/e', {}, 3), ok);
  });
});

// ---------------------------------------------------------------------------
// formatScanCount: the "more may exist" note survives post-delete recounts.
// ---------------------------------------------------------------------------
test('formatScanCount: a bare post-delete recount keeps the truncated note from the last scan', () => {
  assert.equal(formatScanCount(50, { truncated: true, maxPages: 5, note: 'more may exist' }),
    '50 items found (stopped after 5 pages -- more may exist)');
  assert.equal(formatScanCount(40, { truncated: false }),
    '40 items found (stopped after 5 pages -- more may exist)');
  assert.equal(formatScanCount(40, { truncated: false, keepTruncated: false }), '40 items found');
});

test('formatScanCount: a fresh, complete scan clears the remembered truncation', () => {
  formatScanCount(50, { truncated: true, maxPages: 5, note: 'older toots may exist' });
  assert.equal(formatScanCount(12, { truncated: false, maxPages: 5, note: 'older toots may exist' }), '12 items found');
  assert.equal(formatScanCount(10, { truncated: false }), '10 items found');
});

test('formatScanCount: keepTruncated: true reuses the remembered note explicitly', () => {
  formatScanCount(9, { truncated: true, maxPages: 3, note: 'n' });
  assert.equal(formatScanCount(8, { truncated: false, maxPages: 3, note: 'n', keepTruncated: true }),
    '8 items found (stopped after 3 pages -- n)');
});

// ---------------------------------------------------------------------------
// Progress percent + ETA.
// ---------------------------------------------------------------------------
test('formatDeleteProgress: percent and an ETA from the measured average per-item time', () => {
  assert.equal(formatDeleteProgress({ deletedCount: 1, failedCount: 0, totalCount: 3, elapsedMs: 2000 }),
    'Deleted 1 of 3 · 33%, about 4 s left');
  assert.equal(formatDeleteProgress({ deletedCount: 10, failedCount: 2, totalCount: 100, elapsedMs: 60000 }),
    'Processed 12 of 100 (10 deleted, 2 failed) · 12%, about 7 min left');
  assert.equal(formatDeleteProgress({ deletedCount: 5, failedCount: 0, totalCount: 5, elapsedMs: 1 }),
    'Deleted 5 of 5 · 100%');
});

// ---------------------------------------------------------------------------
// Selection counter + Select All indeterminate state (minimal fake DOM).
// ---------------------------------------------------------------------------
function makeFakeDom() {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attrs = {};
      this.listeners = {};
      this.textContent = '';
      this.id = '';
      this.className = '';
      this.checked = false;
      this.indeterminate = false;
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  }
  const body = new El('body');
  const find = (node, id) => {
    if (node.id === id) return node;
    for (const c of node.children) { const f = find(c, id); if (f) return f; }
    return null;
  };
  return {
    body,
    createElement: (tag) => new El(tag),
    getElementById: (id) => find(body, id),
    querySelectorAll: () => [],
    querySelector: () => null
  };
}

test('selection: "N of M selected" counter and indeterminate Select All track every change', () => {
  const doc = makeFakeDom();
  const prevDoc = global.document;
  global.document = doc;
  try {
    const items = [{ id: 1, mine: true }, { id: 2, mine: false }, { id: 3, mine: false }];
    const list = doc.createElement('div');
    doc.body.appendChild(list);

    resetSelection(items, (i) => i.mine);
    const selectAll = renderSelectAllControl(list);
    const counter = doc.getElementById('selected-count');
    assert.ok(counter, 'renderSelectAllControl creates #selected-count');
    assert.equal(counter.textContent, '1 of 3 selected');
    assert.equal(selectAll.checked, false);
    assert.equal(selectAll.indeterminate, true, 'partial pre-selection shows as indeterminate');

    const boxes = [];
    for (const item of items) {
      const row = doc.createElement('div');
      row.textContent = `item ${item.id}`;
      addRowCheckbox(row, item, boxes);
    }
    wireSelectAll(selectAll, items, boxes);

    boxes[1].checked = true; boxes[1].fire('change');
    assert.equal(counter.textContent, '2 of 3 selected');
    assert.equal(getSelectedCount(), 2);

    boxes[2].checked = true; boxes[2].fire('change');
    assert.equal(counter.textContent, '3 of 3 selected');
    assert.equal(selectAll.checked, true);
    assert.equal(selectAll.indeterminate, false);

    selectAll.checked = false; selectAll.fire('change');
    assert.equal(counter.textContent, '0 of 3 selected');
    assert.equal(getSelectedItems(items).length, 0);
    assert.equal(selectAll.indeterminate, false);
    assert.ok(boxes.every((b) => b.checked === false));

    // A re-render replaces (never duplicates) the counter element.
    renderSelectAllControl(list);
    let n = 0;
    const count = (node) => { if (node.id === 'selected-count') n++; node.children.forEach(count); };
    count(doc.body);
    assert.equal(n, 1);
  } finally {
    global.document = prevDoc;
  }
});

test('resolveDocumentLanguage: shipped locales keep their tag, anything else falls back to English', () => {
  assert.equal(resolveDocumentLanguage('de'), 'de');
  assert.equal(resolveDocumentLanguage('fr_CA'), 'fr-CA');
  assert.equal(resolveDocumentLanguage('ja'), 'en');
  assert.equal(resolveDocumentLanguage(''), 'en');
});
