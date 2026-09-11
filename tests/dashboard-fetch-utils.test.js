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
  assert.equal(result.expiredAuth, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.totalCount, 3);
  assert.equal(progressText.textContent, 'Deleted 3 of 3');
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
  assert.equal(progressText.textContent, 'Processed 3 of 3 (2 deleted, 1 failed)');
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
