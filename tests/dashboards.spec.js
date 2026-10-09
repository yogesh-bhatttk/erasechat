// Erasechat - Playwright E2E: platform dashboards against mocked platform APIs.
//
// A substitute for live-site testing: each test loads the REAL dashboard page
// (chrome-extension://<id>/platforms/<p>/dashboard-<p>.html) inside the loaded
// extension, seeds chrome.storage exactly the way the popup's connect flow does,
// and answers every network call the page makes with a mocked platform response
// via context.route(). Anything not explicitly mocked is aborted, so no test can
// ever reach a real platform.
//
// CORS: the dashboards fetch cross-origin from chrome-extension://<id> without the
// optional host permission granted (that grant needs a native prompt Playwright
// can't drive). Playwright's Chromium interception auto-answers CORS preflights
// for routed requests, and every mocked response below carries
// Access-Control-Allow-Origin (the exact extension origin, so credentialed
// requests pass) + Allow-Credentials, so the page sees the mock as a normal
// successful cross-origin response.
//
// Telegram is intentionally NOT covered here: its dashboard talks MTProto over a
// WebSocket (GramJS), not HTTP. context.route() can't intercept or fake that
// encrypted, stateful binary protocol, so a meaningful mocked-server test would
// need a full fake MTProto server -- out of scope for this suite.
//
// Pacing: the dashboards deliberately wait between requests (Reddit 1.5 s/item
// plus 1 s between overwrite and delete, X and Teams 2.5 s/item, Mastodon
// 0.75 s/item), so item counts are kept tiny and per-test timeouts are raised.

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '../');

test.setTimeout(90000);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function launch() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  const origin = `chrome-extension://${extensionId}`;

  // Default: abort every non-extension request so nothing can hit a real
  // platform. Registered FIRST -- Playwright tries the most recently
  // registered matching route first, so the per-test mocks below win.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('chrome-extension://') || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });

  // Every request a mock handled, in order: { method, url, body }.
  const calls = [];

  function corsHeaders(extra = {}) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-csrf-token, accept',
      'access-control-expose-headers': '*',
      ...extra,
    };
  }

  // mock(predicate(url, request) => bool, handler(request, url) => response | Promise)
  // response: { status?, json?, body?, contentType?, headers? }
  async function mock(predicate, handler) {
    await context.route((u) => predicate(u), async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: corsHeaders() });
      }
      const url = new URL(req.url());
      calls.push({ method: req.method(), url: req.url(), body: req.postData(), headers: await req.allHeaders() });
      const res = (await handler(req, url)) || {};
      const body = res.json !== undefined ? JSON.stringify(res.json) : (res.body !== undefined ? res.body : '');
      return route.fulfill({
        status: res.status || 200,
        contentType: res.contentType || (res.json !== undefined ? 'application/json' : 'text/plain'),
        headers: corsHeaders(res.headers),
        body,
      });
    });
  }

  // Seeds storage from the service worker (the dashboards read it on
  // DOMContentLoaded, so this must happen before navigation).
  async function seed({ session = {}, local = {} }) {
    await sw.evaluate(async ({ session, local }) => {
      await chrome.storage.session.set(session);
      await chrome.storage.local.set(local);
    }, { session, local });
  }

  async function open(dashboardPath) {
    const page = await context.newPage();
    // A blocking failure here should be loud, not a silent hang.
    page.on('pageerror', (err) => { page._scErrors = (page._scErrors || []).concat(String(err)); });
    await page.goto(`${origin}/${dashboardPath}`);
    return page;
  }

  return { context, extensionId, origin, sw, calls, mock, seed, open };
}

// Types DELETE into the shared confirmBulkDelete gate and confirms.
async function confirmTypedDelete(page, expectedCount) {
  const modal = page.locator('#sc-prompt-modal');
  await expect(modal).toBeVisible();
  if (expectedCount !== undefined) {
    await expect(page.locator('#sc-prompt-message')).toContainText(String(expectedCount));
  }
  // OK stays disabled until the typed text matches.
  await expect(page.locator('#sc-prompt-ok-btn')).toBeDisabled();
  await page.locator('#sc-prompt-input').fill('DELETE');
  await expect(page.locator('#sc-prompt-ok-btn')).toBeEnabled();
  await page.locator('#sc-prompt-ok-btn').click();
  await expect(modal).toBeHidden();
}

async function openMoreFilters(page) {
  const details = page.locator('#af-block');
  if (!(await details.evaluate((d) => d.open))) await page.locator('#af-block > summary').click();
}

async function setToggle(page, selector, checked) {
  // These toggles are visually hidden checkboxes inside a styled .switch.
  await page.locator(selector).evaluate((el, checked) => {
    if (el.checked !== checked) { el.checked = checked; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, checked);
}

const rows = (page) => page.locator('#item-list .post-item');
const logBody = (page) => page.locator('#sc-activity-log .activity-log-body');

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

const REDDIT_MODHASH = 'mh_test_123';
const REDDIT_USER = 'testuser';
const NOW_S = Math.floor(Date.now() / 1000);

function redditListing() {
  const child = (data) => ({ kind: data.name.slice(0, 2), data: { author: REDDIT_USER, created_utc: NOW_S - 3600, ...data } });
  return {
    kind: 'Listing',
    data: {
      after: null,
      children: [
        child({ name: 't1_c1', body: 'a regular comment', link_id: 't3_p9', subreddit_name_prefixed: 'r/test', score: 5 }),
        child({ name: 't3_s1', title: 'my self post', is_self: true, subreddit_name_prefixed: 'r/test', score: 3 }),
        child({ name: 't3_l1', title: 'my link post', is_self: false, subreddit_name_prefixed: 'r/links', score: 1 }),
        // A well-upvoted comment, excluded by "Keep items with at least N upvotes".
        child({ name: 't1_c2', body: 'my popular comment', link_id: 't3_p9', subreddit_name_prefixed: 'r/test', score: 500 }),
      ],
    },
  };
}

async function setupReddit(h, { holdFirstDelete } = {}) {
  await h.seed({ session: { reddit_modhash: REDDIT_MODHASH }, local: { reddit_username: REDDIT_USER } });
  await h.mock((u) => u.hostname === 'www.reddit.com' && u.pathname === `/user/${REDDIT_USER}/overview.json`,
    () => ({ json: redditListing() }));
  await h.mock((u) => u.hostname === 'www.reddit.com' && u.pathname === '/api/editusertext',
    () => ({ json: { json: { errors: [], data: { things: [] } } } }));
  let delCount = 0;
  await h.mock((u) => u.hostname === 'www.reddit.com' && u.pathname === '/api/del', async () => {
    delCount++;
    if (delCount === 1 && holdFirstDelete) await holdFirstDelete;
    return { json: {} };
  });
}

test('Reddit: scan, keep-min filter, overwrite+delete, CSV export', async () => {
  const h = await launch();
  try {
    await setupReddit(h);
    const page = await h.open('platforms/reddit/dashboard-reddit.html');
    await expect(page.locator('#connected-as')).toContainText(`u/${REDDIT_USER}`);

    // Scan -> all 4 listing items.
    await page.locator('#scan-btn').click();
    await expect(rows(page)).toHaveCount(4, { timeout: 15000 });
    await expect(page.locator('#selected-count')).toHaveText('4 of 4 selected');
    const listingCall = h.calls.find((c) => c.url.includes('/overview.json'));
    const lu = new URL(listingCall.url);
    expect(lu.searchParams.get('sort')).toBe('new');
    expect(lu.searchParams.get('raw_json')).toBe('1');
    expect(lu.searchParams.get('limit')).toBe('100');

    // Keep items with >= 100 upvotes -> the 500-score comment is excluded.
    await openMoreFilters(page);
    await page.locator('#af-keep-min').fill('100');
    await page.locator('#scan-btn').click();
    await expect(page.locator('#status-text')).toContainText(/Scan complete/i, { timeout: 15000 });
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator('#item-list')).not.toContainText('my popular comment');
    await expect(logBody(page)).toContainText('keeping items scoring 100 or more');

    // Export CSV of the current results.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#af-export-csv').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^erasechat-reddit-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
    const lines = csv.trim().split(/\r\n/);
    expect(lines[0]).toBe('"type","subreddit","date","score","text","permalink"');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('"Comment","r/test"');
    expect(csv).toContain('"a regular comment","https://www.reddit.com/comments/p9/_/c1/"');
    expect(csv).toContain('"my self post"');
    expect(csv).toContain('"my link post"');
    expect(csv).not.toContain('my popular comment');
    await expect(logBody(page)).toContainText(/Exported 3 items to erasechat-reddit-/);

    // Overwrite, then delete all 3.
    await setToggle(page, '#overwrite-toggle', true);
    await expect(page.locator('#overwrite-text-group')).toBeVisible();
    await page.locator('#overwrite-text').fill('[removed by owner]');
    await page.locator('#delete-btn').click();
    await confirmTypedDelete(page, 3);
    await expect(page.locator('#status-text')).toHaveText('Deletion complete!', { timeout: 30000 });

    const edits = h.calls.filter((c) => c.url.endsWith('/api/editusertext'));
    const dels = h.calls.filter((c) => c.url.endsWith('/api/del'));
    // Only the comment and the self post are editable; the link post is only deleted.
    expect(edits.map((c) => new URLSearchParams(c.body).get('thing_id'))).toEqual(['t1_c1', 't3_s1']);
    for (const e of edits) {
      const p = new URLSearchParams(e.body);
      expect(e.method).toBe('POST');
      expect(p.get('uh')).toBe(REDDIT_MODHASH);
      expect(p.get('text')).toBe('[removed by owner]');
      expect(p.get('api_type')).toBe('json');
    }
    expect(dels.map((c) => new URLSearchParams(c.body).get('id'))).toEqual(['t1_c1', 't3_s1', 't3_l1']);
    for (const d of dels) {
      expect(d.method).toBe('POST');
      expect(new URLSearchParams(d.body).get('uh')).toBe(REDDIT_MODHASH);
    }
    // Each overwrite precedes its own delete.
    const idx = (pred) => h.calls.findIndex(pred);
    expect(idx((c) => c.url.endsWith('/api/editusertext') && c.body.includes('t1_c1')))
      .toBeLessThan(idx((c) => c.url.endsWith('/api/del') && c.body.includes('t1_c1')));

    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator('#item-list')).toContainText('Deletion finished.');
    await expect(logBody(page)).toContainText('Delete started: 3 item(s) selected.');
    await expect(logBody(page)).toContainText('Delete complete: 3/3 deleted.');
    // Export is disabled once nothing is left.
    await expect(page.locator('#af-export-csv')).toBeDisabled();
    expect(page._scErrors || []).toEqual([]);
  } finally {
    await h.context.close();
  }
});

test('Reddit: import comments.csv from the data export shows "from export" rows', async () => {
  const h = await launch();
  try {
    await setupReddit(h);
    const page = await h.open('platforms/reddit/dashboard-reddit.html');
    await expect(page.locator('#connected-as')).toContainText(`u/${REDDIT_USER}`);

    const csv = [
      'id,permalink,date,ip,subreddit,gildings,link,parent,body,media',
      'abc1,https://www.reddit.com/r/test/comments/p1/x/abc1/,2023-01-15 12:34:56 UTC,,test,0,https://www.reddit.com/r/test/comments/p1/x/,,"old comment, with a comma",',
      'abc2,https://www.reddit.com/r/foo/comments/p2/y/abc2/,2022-05-01 08:00:00 UTC,,foo,0,https://www.reddit.com/r/foo/comments/p2/y/,,another old one,',
      'not valid!,,,,,,,,skipped row,',
    ].join('\n');
    await page.locator('#import-files').setInputFiles({ name: 'comments.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#results-count')).toHaveText('2 items from your Reddit data export');
    await expect(page.locator('#item-list .badge-export')).toHaveCount(2);
    await expect(page.locator('#item-list .badge-export').first()).toHaveText('from export');
    await expect(page.locator('#item-list')).toContainText('old comment, with a comma');
    await expect(page.locator('#item-list')).toContainText('r/foo');
    await expect(page.locator('#item-list a.post-open-link').first())
      .toHaveAttribute('href', 'https://www.reddit.com/comments/p1/_/abc1/');
    await expect(logBody(page)).toContainText('Imported 2 comment(s) and 0 post(s) from the export');
    await expect(logBody(page)).toContainText('Skipped 1 row(s) without a valid id.');
    await expect(page.locator('#delete-btn')).toBeEnabled();
    // Import never touches the network.
    expect(h.calls).toEqual([]);
  } finally {
    await h.context.close();
  }
});

test('Reddit: Cancel during a delete stops after the in-flight item', async () => {
  const h = await launch();
  let release;
  const hold = new Promise((r) => { release = r; });
  try {
    await setupReddit(h, { holdFirstDelete: hold });
    const page = await h.open('platforms/reddit/dashboard-reddit.html');
    await page.locator('#scan-btn').click();
    await expect(rows(page)).toHaveCount(4, { timeout: 15000 });

    // Deselect the popular comment: counter updates.
    await rows(page).filter({ hasText: 'my popular comment' }).locator('input.msg-checkbox').uncheck();
    await expect(page.locator('#selected-count')).toHaveText('3 of 4 selected');

    await page.locator('#delete-btn').click();
    await confirmTypedDelete(page, 3);

    // The first /api/del is held open; Cancel -> confirm "Stop deleting".
    await expect.poll(() => h.calls.filter((c) => c.url.endsWith('/api/del')).length).toBe(1);
    const cancelBtn = page.locator('#sc-btn-cancel');
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(page.locator('#sc-confirm-modal')).toBeVisible();
    await expect(page.locator('#sc-confirm-title')).toHaveText(/Stop deleting\?/);
    await page.locator('#sc-confirm-ok-btn').click();
    await expect(cancelBtn).toHaveText(/Cancelling/);
    release();

    await expect(page.locator('#status-text')).toHaveText('Cancelled: 1 of 3 processed.', { timeout: 15000 });
    // Only the in-flight item was deleted; the rest (2 selected + 1 unselected) remain.
    await page.waitForTimeout(2000); // past the 1.5 s pacing: no further deletes may start
    const dels = h.calls.filter((c) => c.url.endsWith('/api/del'));
    expect(dels.map((c) => new URLSearchParams(c.body).get('id'))).toEqual(['t1_c1']);
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator('#item-list')).not.toContainText('a regular comment');
    await expect(page.locator('#selected-count')).toHaveText('3 of 3 selected');
    await expect(cancelBtn).toBeHidden();
    await expect(logBody(page)).toContainText('Delete cancelled: 1/3 processed.');
  } finally {
    release && release();
    await h.context.close();
  }
});

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

const X_USER = 'xtester';
const X_USER_ID = '42';
const X_CSRF = 'ct0_test_value';
// Live ids "scraped" from the mocked main bundle -- distinct from
// DEFAULT_X_QUERY_IDS so the test proves extraction is used.
const X_QIDS = { UserByScreenName: 'qUBSN1', UserTweets: 'qUT1', DeleteTweet: 'qDT1', DeleteRetweet: 'qDRT1' };

function xTweet(id, text, extraLegacy = {}) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: { full_text: text, created_at: 'Wed Oct 01 10:00:00 +0000 2025', favorite_count: 2, user_id_str: X_USER_ID, ...extraLegacy },
  };
}

function xTimeline() {
  const entry = (id, result) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result } } } });
  return {
    data: { user: { result: { timeline_v2: { timeline: { instructions: [
      { type: 'TimelinePinEntry', entry: entry('3003', xTweet('3003', 'my pinned post')) },
      { type: 'TimelineAddEntries', entries: [
        entry('1001', xTweet('1001', 'a normal post')),
        entry('1002', xTweet('1002', 'RT @someone: their post', {
          retweeted_status_result: { result: { __typename: 'Tweet', rest_id: '2002', legacy: { full_text: 'their post', user_id_str: '777' } } },
        })),
        { entryId: 'cursor-bottom-1', content: { value: '' } },
      ] },
    ] } } } } },
  };
}

async function setupX(h) {
  await h.seed({ session: { x_csrf: X_CSRF }, local: { x_username: X_USER } });
  await h.mock((u) => u.hostname === 'x.com' && u.pathname === '/', () => ({
    contentType: 'text/html',
    body: '<html><head><script type="text/javascript" src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script></head></html>',
  }));
  await h.mock((u) => u.hostname === 'abs.twimg.com', () => ({
    contentType: 'application/javascript',
    body: Object.entries(X_QIDS).map(([op, id]) => `e.exports={queryId:"${id}",operationName:"${op}",operationType:"x"};`).join('\n'),
  }));
  await h.mock((u) => u.hostname === 'x.com' && u.pathname.endsWith('/UserByScreenName'),
    () => ({ json: { data: { user: { result: { __typename: 'User', rest_id: X_USER_ID } } } } }));
  await h.mock((u) => u.hostname === 'x.com' && u.pathname.endsWith('/UserTweets'), () => ({ json: xTimeline() }));
  await h.mock((u) => u.hostname === 'x.com' && u.pathname.endsWith('/DeleteTweet'),
    () => ({ json: { data: { delete_tweet: { tweet_results: {} } } } }));
  await h.mock((u) => u.hostname === 'x.com' && u.pathname.endsWith('/DeleteRetweet'),
    () => ({ json: { data: { unretweet: { source_tweet_results: { result: { rest_id: '2002' } } } } } }));
}

test('X: scan with Repost/Pinned badges, Keep pinned, correct delete mutation per row', async () => {
  const h = await launch();
  try {
    await setupX(h);
    const page = await h.open('platforms/x/dashboard-x.html');
    await expect(page.locator('#username')).toHaveValue(X_USER);
    await expect(page.locator('#connected-as')).toContainText(`@${X_USER}`);

    await page.locator('#scan-btn').click();
    await expect(rows(page)).toHaveCount(3, { timeout: 20000 });
    await expect(rows(page).filter({ hasText: 'my pinned post' }).locator('.badge-pinned')).toHaveText('Pinned');
    await expect(rows(page).filter({ hasText: 'their post' }).locator('.badge-repost')).toHaveText('Repost');
    await expect(rows(page).filter({ hasText: 'a normal post' }).locator('.badge')).toHaveCount(0);

    // Scraped query ids are used; auth headers are sent.
    const ut = h.calls.find((c) => c.url.includes('/UserTweets'));
    expect(new URL(ut.url).pathname).toBe(`/i/api/graphql/${X_QIDS.UserTweets}/UserTweets`);
    expect(JSON.parse(new URL(ut.url).searchParams.get('variables')).userId).toBe(X_USER_ID);
    expect(ut.headers['x-csrf-token']).toBe(X_CSRF);
    expect(ut.headers['authorization']).toMatch(/^Bearer AAAA/);
    const ubsn = h.calls.find((c) => c.url.includes('/UserByScreenName'));
    expect(new URL(ubsn.url).pathname).toBe(`/i/api/graphql/${X_QIDS.UserByScreenName}/UserByScreenName`);

    // Keep pinned -> rescan -> pinned post excluded.
    await openMoreFilters(page);
    await page.locator('#af-keep-pinned').check();
    await page.locator('#scan-btn').click();
    await expect(page.locator('#status-text')).toContainText(/Scan complete/i, { timeout: 20000 });
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#item-list')).not.toContainText('my pinned post');
    await expect(page.locator('#selected-count')).toHaveText('2 of 2 selected');

    await page.locator('#delete-btn').click();
    await confirmTypedDelete(page, 2);
    await expect(page.locator('#status-text')).toHaveText('Deletion complete!', { timeout: 30000 });

    const muts = h.calls.filter((c) => /\/(DeleteTweet|DeleteRetweet)$/.test(new URL(c.url).pathname));
    expect(muts).toHaveLength(2);
    expect(muts[0].method).toBe('POST');
    expect(new URL(muts[0].url).pathname).toBe(`/i/api/graphql/${X_QIDS.DeleteTweet}/DeleteTweet`);
    expect(JSON.parse(muts[0].body)).toEqual({ variables: { tweet_id: '1001', dark_request: false }, queryId: X_QIDS.DeleteTweet });
    expect(new URL(muts[1].url).pathname).toBe(`/i/api/graphql/${X_QIDS.DeleteRetweet}/DeleteRetweet`);
    expect(JSON.parse(muts[1].body)).toEqual({ variables: { source_tweet_id: '2002', dark_request: false }, queryId: X_QIDS.DeleteRetweet });
    // The pinned post was never touched.
    expect(h.calls.some((c) => (c.body || '').includes('3003'))).toBe(false);

    await expect(rows(page)).toHaveCount(0);
    await expect(logBody(page)).toContainText('Delete complete: 2/2 deleted.');
    expect(page._scErrors || []).toEqual([]);
  } finally {
    await h.context.close();
  }
});

test('X: archive import -- tweets.js needs an ownership confirm, a foreign tweet-headers.js is refused', async () => {
  const h = await launch();
  try {
    await setupX(h);
    const page = await h.open('platforms/x/dashboard-x.html');
    await expect(page.locator('#username')).toHaveValue(X_USER);

    const tweetsJs = 'window.YTD.tweets.part0 = ' + JSON.stringify([
      { tweet: { id_str: '5001', full_text: 'archived post one', created_at: 'Mon Jan 02 10:00:00 +0000 2017', favorite_count: '3' } },
      { tweet: { id_str: '5002', full_text: 'RT @other: archived repost', created_at: 'Sun Jan 01 10:00:00 +0000 2017', favorite_count: '0' } },
    ]);
    await page.locator('#archive-files').setInputFiles({ name: 'tweets.js', mimeType: 'application/javascript', buffer: Buffer.from(tweetsJs) });
    await page.locator('#archive-import-btn').click();

    // tweets.js carries no author id -> explicit ownership confirm.
    await expect(page.locator('#sc-confirm-modal')).toBeVisible();
    await expect(page.locator('#sc-confirm-message')).toContainText(`@${X_USER}`);
    await page.locator('#sc-confirm-ok-btn').click();

    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#results-count')).toHaveText('2 of 2 archived posts match');
    await expect(page.locator('#item-list .badge-archive')).toHaveCount(2);
    await expect(rows(page).filter({ hasText: 'archived repost' }).locator('.badge-repost')).toHaveCount(1);
    await expect(logBody(page)).toContainText(`Archive confirmed by you as @${X_USER}'s.`);
    await expect(page.locator('#delete-btn')).toBeEnabled();

    // A tweet-headers.js whose user_id isn't the connected account's id is refused.
    const headersJs = 'window.YTD.tweet_headers.part0 = ' + JSON.stringify([
      { tweet: { tweet_id: '6001', user_id: '999', created_at: 'Mon Jan 02 10:00:00 +0000 2017' } },
    ]);
    await page.locator('#archive-files').setInputFiles({ name: 'tweet-headers.js', mimeType: 'application/javascript', buffer: Buffer.from(headersJs) });
    await page.locator('#archive-import-btn').click();
    await expect(page.locator('#sc-alert-modal')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#sc-alert-message')).toContainText('belongs to a different X account');
    await page.locator('#sc-alert-ok-btn').click();
    // The previous (confirmed) import is left as it was.
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#item-list')).not.toContainText('6001');
    // The ownership check resolved the connected id through UserByScreenName.
    expect(h.calls.some((c) => c.url.includes('/UserByScreenName'))).toBe(true);
    // No delete was ever sent.
    expect(h.calls.some((c) => /Delete(Re)?[Tt]weet/.test(c.url))).toBe(false);
  } finally {
    await h.context.close();
  }
});

// ---------------------------------------------------------------------------
// Mastodon
// ---------------------------------------------------------------------------

const M_HOST = 'example.social';
const M_TOKEN = 'mstdn_token_abc';
const M_ACCT = '109';

function mStatus(id, html, extra = {}) {
  return { id, created_at: '2025-09-01T10:00:00.000Z', content: html, visibility: 'public', favourites_count: 1, reblogs_count: 0, account: { acct: 'alice' }, ...extra };
}

test('Mastodon: scan with pinned badge, partial selection, DELETE ?delete_media=true', async () => {
  const h = await launch();
  try {
    await h.seed({
      session: { mstdn_token: M_TOKEN },
      local: { mstdn_host: M_HOST, mstdn_user_id: M_ACCT, mstdn_username: 'alice' },
    });
    await h.mock((u) => u.hostname === M_HOST && u.pathname === `/api/v1/accounts/${M_ACCT}/statuses`, (req, u) => {
      if (u.searchParams.get('pinned') === 'true') return { json: [mStatus('903', '<p>pinned toot</p>')] };
      return {
        json: [
          mStatus('901', '<p>hello &amp; welcome<br>second line</p>'),
          mStatus('902', '<p>another toot</p>'),
          mStatus('903', '<p>pinned toot</p>'),
        ],
      };
    });
    await h.mock((u) => u.hostname === M_HOST && u.pathname.startsWith('/api/v1/statuses/'), () => ({ json: {} }));

    const page = await h.open('platforms/mastodon/dashboard-mastodon.html');
    await expect(page.locator('#connected-as')).toContainText('@alice');
    await page.locator('#scan-btn').click();
    await expect(rows(page)).toHaveCount(3, { timeout: 15000 });
    await expect(rows(page).filter({ hasText: 'pinned toot' }).locator('.badge-pinned')).toHaveText('Pinned');
    await expect(page.locator('#item-list')).toContainText('hello & welcome');
    await expect(rows(page).first().locator('a.post-open-link')).toHaveAttribute('href', `https://${M_HOST}/@alice/901`);

    // Pinned list fetched first, then the timeline; bearer token on both.
    const reads = h.calls.filter((c) => c.method === 'GET');
    expect(new URL(reads[0].url).searchParams.get('pinned')).toBe('true');
    expect(new URL(reads[1].url).searchParams.get('limit')).toBe('40');
    for (const r of reads) expect(r.headers['authorization']).toBe(`Bearer ${M_TOKEN}`);

    // Deselect two rows -> only one delete.
    await rows(page).filter({ hasText: 'another toot' }).locator('input.msg-checkbox').uncheck();
    await rows(page).filter({ hasText: 'pinned toot' }).locator('input.msg-checkbox').uncheck();
    await expect(page.locator('#selected-count')).toHaveText('1 of 3 selected');

    await page.locator('#delete-btn').click();
    // Fewer than 31 items: no "30 per 30 min" ETA confirm, straight to the typed gate.
    await expect(page.locator('#sc-prompt-modal')).toBeVisible();
    await expect(page.locator('#sc-confirm-modal')).toBeHidden();
    await confirmTypedDelete(page, 1);
    await expect(page.locator('#status-text')).toHaveText('Deletion complete!', { timeout: 15000 });

    const deletes = h.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const du = new URL(deletes[0].url);
    expect(du.pathname).toBe('/api/v1/statuses/901');
    expect(du.searchParams.get('delete_media')).toBe('true');

    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#item-list')).not.toContainText('hello & welcome');
    await expect(page.locator('#selected-count')).toHaveText('2 of 2 selected');
    await expect(logBody(page)).toContainText('Delete started: 1 item(s) selected.');
    await expect(logBody(page)).toContainText('Delete complete: 1/1 deleted.');
    expect(page._scErrors || []).toEqual([]);
  } finally {
    await h.context.close();
  }
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const T_BASE = 'https://teams.cloud.microsoft/api/chatsvc/emea';
const T_OID = '11111111-2222-3333-4444-555555555555';
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
}
const T_TOKEN = 'Bearer ' + fakeJwt({ oid: T_OID, preferred_username: 'me@contoso.com' });
const T_CHAT_TOPIC = '19:topicchat@thread.v2';
const T_CHAT_UNTITLED = '19:untitled@unq.gbl.spaces';
const T_ME = `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:${T_OID}`;
const T_OTHER = 'https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:99999999-0000-0000-0000-000000000000';

test('Teams: chat labels, backwardLink rebased onto the base URL, system messages filtered, DELETE URLs', async () => {
  const h = await launch();
  try {
    await h.seed({ session: { teams_token: T_TOKEN }, local: { teams_base_url: T_BASE } });
    const msgPath = `/api/chatsvc/emea/v1/users/ME/conversations/${encodeURIComponent(T_CHAT_TOPIC)}/messages`;

    await h.mock((u) => u.hostname === 'teams.cloud.microsoft' && u.pathname === '/api/chatsvc/emea/v1/users/ME/conversations', () => ({
      json: {
        conversations: [
          { id: T_CHAT_TOPIC, threadProperties: { topic: 'Project Phoenix' } },
          { id: T_CHAT_UNTITLED, threadProperties: {} },
          { id: '48:notifications', threadProperties: {} }, // not a chat (no 19: prefix)
        ],
        _metadata: {},
      },
    }));
    await h.mock((u) => u.hostname === 'teams.cloud.microsoft' && u.pathname === msgPath && u.searchParams.get('syncState') === 'page2', () => ({
      json: {
        messages: [
          { id: '1003', from: T_ME, messagetype: 'RichText/Html', content: '<p>older <b>message</b></p>', originalarrivaltime: '2025-08-01T09:00:00.000Z' },
        ],
        _metadata: {},
      },
    }));
    await h.mock((u) => u.hostname === 'teams.cloud.microsoft' && u.pathname === msgPath && !u.searchParams.has('syncState'), () => ({
      json: {
        messages: [
          { id: '1001', from: T_ME, messagetype: 'Text', content: 'hello team', originalarrivaltime: '2025-09-01T09:00:00.000Z' },
          { id: '1002', from: T_ME, messagetype: 'ThreadActivity/AddMember', content: '<addmember>...</addmember>', originalarrivaltime: '2025-09-01T08:00:00.000Z' },
          { id: '1004', from: T_OTHER, messagetype: 'Text', content: 'someone else', originalarrivaltime: '2025-09-01T07:00:00.000Z' },
          { id: '1005', from: T_ME, messagetype: 'Text', content: 'already gone', properties: { deletetime: '1690000000000' }, originalarrivaltime: '2025-09-01T06:00:00.000Z' },
        ],
        // Teams hands back a link on its own msg host; it must be rebased onto
        // the captured base URL (the bare-host /api/chatsvc/emea variant).
        _metadata: { backwardLink: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(T_CHAT_TOPIC)}/messages?syncState=page2&pageSize=100` },
      },
    }));
    await h.mock((u) => u.hostname === 'teams.cloud.microsoft' && u.pathname.startsWith(`${msgPath}/`), (req) => {
      expect(req.method()).toBe('DELETE');
      return { status: 200, body: '' };
    });

    const page = await h.open('platforms/teams/dashboard-teams.html');
    await expect(page.locator('#connected-as')).toContainText('me@contoso.com');
    await page.locator('#load-chats-btn').click();
    await expect(page.locator('#status-text')).toHaveText('2 chats loaded.');
    const options = await page.locator('#chat-select option').allTextContents();
    expect(options).toEqual(['-- Select a Chat --', 'Project Phoenix', 'Untitled chat']);
    // Token is sent as-is in Authorization.
    const listCall = h.calls[0];
    expect(listCall.headers['authorization']).toBe(T_TOKEN);
    expect(new URL(listCall.url).searchParams.get('pageSize')).toBe('100');

    await page.locator('#chat-select').selectOption(T_CHAT_TOPIC);
    await page.locator('#scan-btn').click();
    await expect(page.locator('#status-text')).toContainText(/Scan complete/i, { timeout: 15000 });
    // System message, other sender, already-deleted: all filtered out.
    await expect(rows(page)).toHaveCount(2);
    await expect(page.locator('#item-list')).toContainText('hello team');
    await expect(page.locator('#item-list')).toContainText('older message');
    await expect(page.locator('#item-list')).not.toContainText('addmember');
    await expect(page.locator('#item-list')).not.toContainText('someone else');
    await expect(page.locator('#item-list')).not.toContainText('already gone');

    // Page 2 was requested on the base URL host, never on *.msg.teams.microsoft.com.
    const page2 = h.calls.find((c) => c.url.includes('syncState=page2'));
    expect(page2).toBeTruthy();
    expect(page2.url.startsWith(`${T_BASE}/v1/users/ME/conversations/`)).toBe(true);
    expect(h.calls.some((c) => new URL(c.url).hostname.endsWith('teams.microsoft.com'))).toBe(false);
    await expect(logBody(page)).toContainText('Scan started (chat: Project Phoenix).');

    await page.locator('#delete-btn').click();
    await confirmTypedDelete(page, 2);
    await expect(page.locator('#status-text')).toHaveText('Deletion complete!', { timeout: 20000 });

    const deletes = h.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toEqual([
      `${T_BASE}/v1/users/ME/conversations/${encodeURIComponent(T_CHAT_TOPIC)}/messages/1001`,
      `${T_BASE}/v1/users/ME/conversations/${encodeURIComponent(T_CHAT_TOPIC)}/messages/1003`,
    ]);
    await expect(rows(page)).toHaveCount(0);
    await expect(logBody(page)).toContainText('Delete complete: 2/2 deleted.');
    expect(page._scErrors || []).toEqual([]);
  } finally {
    await h.context.close();
  }
});
