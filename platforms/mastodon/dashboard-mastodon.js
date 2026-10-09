// Pure helper: given already-pruned delete timestamps (i.e. only the ones still
// inside the rolling rate-limit window), returns the timestamp new deletes may
// resume at, or null if we're already under the cap and don't need to wait at
// all. Extracted to module scope (and exported below) so this arithmetic is
// unit-testable without a live DOM -- see tests/mastodon-dashboard.test.js.
function computeRateLimitResumeAt(prunedTimestamps, max, windowMs) {
  if (prunedTimestamps.length < max) return null;
  return prunedTimestamps[0] + windowMs + 1000; // +1s buffer past the oldest delete's window
}

// Pure: the server's own view of the limit. Mastodon sends X-RateLimit-Remaining
// and X-RateLimit-Reset (an ISO 8601 timestamp) on API responses; once
// remaining hits 0, nothing more will succeed until reset -- so pause until
// then (+1s buffer) instead of firing requests that are guaranteed to 429.
// Returns the resume timestamp (ms), or null if no wait is needed / headers are
// absent or unparseable (the local 30-per-30-min model still applies then).
function computeServerRateLimitResumeAt(remaining, reset, now) {
  if (remaining === null || remaining === undefined || remaining === '') return null;
  const left = Number(remaining);
  if (!Number.isFinite(left) || left > 0) return null;
  const resetMs = Date.parse(reset);
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  return resetMs + 1000;
}

// Cancel-aware wait loop, decoupled from the real clock/sleep/progress-UI so it's
// unit testable (see tests/mastodon-dashboard.test.js) without waiting out a real
// 30-minute rate-limit window. `sleep`/`now` are injected by the real caller
// (delay/Date.now) and faked by tests. Returns true the instant cancellation is
// observed, instead of running the full remaining wait out first -- this is what
// makes the Cancel button responsive during a paced rate-limit wait.
async function runCancelableWait(resumeAt, cancelController, sleep, now, onTick) {
  while (now() < resumeAt) {
    if (cancelController && cancelController.cancelled) return true;
    const remainingMs = resumeAt - now();
    if (onTick) onTick(remainingMs);
    await sleep(Math.min(1000, remainingMs));
  }
  return false;
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// Pure: Mastodon status `content` is HTML (<p>, <br>, links, and entities like
// &#39; &amp; &quot;). Strip tags AND decode entities, once, so the same text
// feeds both the filter and the row preview -- previously only tags were
// stripped, so "don't" was stored as "don&#39;t" and a filter for "don't"
// never matched. Uses the browser's DOMParser (an inert document: no scripts
// run, no images load) when available; under node it falls back to a small
// decoder for the entities Mastodon actually emits.
function htmlToPlainText(html) {
  if (!html) return '';
  // Paragraph/line breaks become whitespace so adjacent words don't fuse.
  const spaced = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  const Parser = typeof window !== 'undefined' && window.DOMParser;
  if (Parser) {
    const doc = new Parser().parseFromString(spaced, 'text/html');
    return (doc.body ? doc.body.textContent : '').trim();
  }
  return spaced
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, code.toLowerCase()) ? HTML_ENTITIES[code.toLowerCase()] : m;
    })
    .trim();
}

// Pure: plain text for one status -- a boost/reblog wrapper has an EMPTY
// `content` of its own; the real text lives on `status.reblog.content`.
function statusPlainText(status) {
  return htmlToPlainText((status && (status.content || status.reblog?.content)) || '');
}

// Pure: the DELETE endpoint for one status. delete_media=true makes the server
// also remove the post's media attachments right away instead of leaving them
// orphaned until the server's own cleanup (and without it, Mastodon keeps them
// around so a "delete & redraft" could reuse them). Ids are validated before
// being put in the path; returns null for anything that doesn't look like one.
function buildDeleteStatusEndpoint(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return `/api/v1/statuses/${id}?delete_media=true`;
}

// Pure: a link to the status on the user's OWN (already validated) instance,
// built from validated parts only -- never the server-supplied `url`, which
// could be any scheme/host.
const MASTODON_HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
function buildMastodonPermalink(host, username, status) {
  if (typeof host !== 'string' || !MASTODON_HOST_RE.test(host) || !status) return null;
  const ID = /^[A-Za-z0-9_-]+$/;
  const reblog = status.reblog;
  if (reblog) {
    const acct = reblog.account && reblog.account.acct;
    if (typeof acct !== 'string' || !/^[A-Za-z0-9_.-]+(@[A-Za-z0-9.-]+)?$/.test(acct) || !ID.test(String(reblog.id || ''))) return null;
    return `https://${host}/@${acct}/${reblog.id}`;
  }
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(username) || !ID.test(String(status.id || ''))) return null;
  return `https://${host}/@${username}/${status.id}`;
}

// Pure: Mastodon's 403 for a token without write:statuses says so in its body.
function isScopeError(status, errorText) {
  return status === 403 && /outside the authorized scopes|scope/i.test(String(errorText || ''));
}

// Pure: rough wall-clock time for `count` deletes under the 30-per-30-minute
// limit, given `alreadyUsed` deletes already inside the current window. Each
// full window beyond the first costs a 30-minute wait; spacing adds the rest.
function estimateMastodonDeleteMs(count, alreadyUsed, max, windowMs, spacingMs) {
  if (count <= 0) return 0;
  const used = Math.max(0, Math.min(alreadyUsed || 0, max));
  const windowsToWait = Math.max(0, Math.ceil((used + count) / max) - 1);
  return windowsToWait * windowMs + count * spacingMs;
}

// Pure: a short localized duration ("2 h 15 min", "40 min", "under a minute").
function formatDurationShort(ms) {
  const totalMin = Math.ceil(ms / 60000);
  if (ms < 60000) return t("socialDashDurationUnderMinute", "under a minute");
  if (totalMin < 60) return t("socialDashDurationMinutes", `${totalMin} min`, [String(totalMin)]);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return t("socialDashDurationHoursMinutes", `${h} h ${m} min`, [String(h), String(m)]);
}

// Maps a failed request to a friendly, actionable, localized sentence instead of
// a bare "API Error 403".
function friendlyMastodonError(err) {
  const status = err && err.status;
  if (err && err.scopeMissing) {
    return t("mastodonDashErrScope", "Your Mastodon access token can read your posts but isn't allowed to delete them (it lacks the write:statuses scope). Create a new token with the write:statuses (or write) scope under Preferences > Development, then reconnect.");
  }
  if (!status) {
    if (err && err.name === 'TypeError') return t("socialDashErrNetwork", "Couldn't reach Mastodon. Check your internet connection and try again.", ["Mastodon"]);
    return (err && err.message) || t("socialDashErrUnknown", "Something unexpected went wrong. Try again.");
  }
  if (status === 401 || status === 403) return t("socialDashErrAuth", "Mastodon rejected the request -- your session may have expired. Log in on Mastodon, reconnect it from the extension popup, and try again.", ["Mastodon"]);
  if (status === 404) return t("mastodonDashErrNotFound", "Mastodon couldn't find that post or account -- it may already be deleted. Scan again to refresh the list.");
  if (status === 429) {
    if (err.retryAfterMs) {
      const mins = String(Math.max(1, Math.ceil(err.retryAfterMs / 60000)));
      return t("socialDashErrRateLimitedFor", `Mastodon is rate-limiting requests. Try again in about ${mins} minute(s).`, ["Mastodon", mins]);
    }
    return t("socialDashErrRateLimited", "Mastodon is rate-limiting requests. Wait a few minutes and try again.", ["Mastodon"]);
  }
  if (status >= 500) return t("socialDashErrServer", `Mastodon is having trouble right now (HTTP ${status}). Try again in a few minutes.`, ["Mastodon", String(status)]);
  return t("socialDashErrGeneric", `Mastodon returned an unexpected error (HTTP ${status}). Try again; if it keeps happening, reconnect from the extension popup.`, ["Mastodon", String(status)]);
}

// Pure: a status's creation time in ms, or null when missing/unparseable.
function statusTimeMs(status) {
  const ms = status ? Date.parse(status.created_at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Pure: ISO 8601 string for an export cell ("" for a missing/invalid date).
function mastodonIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// Pure: the account statuses listing is newest-first, so once EVERY status on a
// page (with a known date) is older than the "From" date, every later page is
// too -- stop paginating instead of spending requests (and the scan's page
// budget) on history the date filter would discard anyway. A page with no
// datable status never triggers the stop (unknown != old).
function isMastodonPageOlderThan(statuses, fromMs) {
  if (fromMs === null || fromMs === undefined || !Array.isArray(statuses) || statuses.length === 0) return false;
  let dated = 0;
  for (const s of statuses) {
    const ms = statusTimeMs(s);
    if (ms === null) continue;
    if (ms >= fromMs) return false;
    dated++;
  }
  return dated > 0;
}

// Pure: ids from GET /api/v1/accounts/:id/statuses?pinned=true. The regular
// listing only carries a `pinned` field on some servers, so "Keep pinned"
// consults this set as well as status.pinned.
function buildPinnedIdSet(statuses) {
  const ids = new Set();
  if (!Array.isArray(statuses)) return ids;
  for (const s of statuses) {
    if (s && (typeof s.id === 'string' || typeof s.id === 'number')) ids.add(String(s.id));
  }
  return ids;
}

function isStatusPinned(status, pinnedIds) {
  if (!status) return false;
  return status.pinned === true || !!(pinnedIds && pinnedIds.has(String(status.id)));
}

// Pure: CSV/JSON export columns for scanned statuses (see mountExportButtons in
// platforms/shared/platform-filters.js). The URL column uses the same
// validated permalink as the row's "Open" link -- never the server-supplied url.
function buildMastodonExportColumns(host, username) {
  return [
    { label: t("mastodonDashColId", "ID"), get: (s) => String(s.id ?? '') },
    { label: t("mastodonDashColDate", "Date"), get: (s) => mastodonIsoDate(s.created_at) },
    { label: t("mastodonDashColVisibility", "Visibility"), get: (s) => String(s.visibility || '') },
    { label: t("mastodonDashColFavourites", "Favourites"), get: (s) => Number(s.favourites_count) || 0 },
    { label: t("mastodonDashColBoosts", "Boosts"), get: (s) => Number(s.reblogs_count) || 0 },
    { label: t("mastodonDashColText", "Text"), get: (s) => statusPlainText(s) },
    { label: t("mastodonDashColUrl", "URL"), get: (s) => buildMastodonPermalink(host, username, s) || '' }
  ];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    statusTimeMs,
    mastodonIsoDate,
    isMastodonPageOlderThan,
    buildPinnedIdSet,
    isStatusPinned,
    buildMastodonExportColumns,
    computeRateLimitResumeAt,
    computeServerRateLimitResumeAt,
    runCancelableWait,
    htmlToPlainText,
    statusPlainText,
    buildDeleteStatusEndpoint,
    buildMastodonPermalink,
    isScopeError,
    estimateMastodonDeleteMs,
    formatDurationShort,
    friendlyMastodonError
  };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get(['mstdn_host', 'mstdn_user_id', 'mstdn_username']),
    chrome.storage.session.get(['mstdn_token'])
  ]);
  if (!localData.mstdn_host || !sessionData.mstdn_token || !localData.mstdn_user_id) {
    await showAlert(t("socialDashNotLinked", "Not connected to Mastodon. Connect it from the extension popup first.", ["Mastodon"]));
    window.close();
    return;
  }

  const { mstdn_host: host, mstdn_user_id: accountId, mstdn_username: username } = localData;
  const { mstdn_token: token } = sessionData;
  document.getElementById('connected-as').textContent = t("dashConnectedAs", `(Connected: @${username})`, [`@${username}`]);

  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  const DELETE_PROGRESS_KEY = 'mastodon_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  let currentResults = [];
  // Plain text per scanned status (tags stripped, entities decoded), computed
  // once at scan time and reused by both the filter and the row preview.
  const plainTextOf = new WeakMap();
  // Ids of pinned statuses, refreshed at every scan start (see buildPinnedIdSet).
  let pinnedIds = new Set();

  // Date range / invert / keep-favourites / keep-pinned controls and the
  // CSV/JSON export buttons -- see platforms/shared/platform-filters.js.
  mountAdvancedFilters({
    keepMinLabel: t("mastodonDashKeepMinLabel", "Keep posts with at least N favourites"),
    keepPinned: true
  });
  const exporter = mountExportButtons({
    platform: 'mastodon',
    columns: buildMastodonExportColumns(host, username),
    getItems: () => currentResults
  });

  // Mastodon's delete rate limit (shared with un-reblog) is 30 requests per
  // rolling 30-minute window, not the general 300-per-5-minutes API limit.
  // We track the timestamp of every delete we issue and, once we're about to
  // exceed the cap, actually pause until the oldest delete in the window
  // ages out — rather than firing rapidly and getting locked out.
  const DELETE_RATE_LIMIT_MAX = 30;
  const DELETE_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;
  const DELETE_MIN_SPACING_MS = 750; // baseline spacing between deletes within a window
  let deleteTimestamps = [];
  // The server's own X-RateLimit-Remaining / X-RateLimit-Reset from the most
  // recent response -- authoritative when present (an instance can configure
  // different limits, and deletes made from another client count too).
  let serverRateLimit = { remaining: null, reset: null };

  function pruneDeleteTimestamps() {
    const cutoff = Date.now() - DELETE_RATE_LIMIT_WINDOW_MS;
    deleteTimestamps = deleteTimestamps.filter(ts => ts > cutoff);
  }

  // Blocks (with a live countdown in progressText) until issuing another
  // delete would stay within both the server's reported limit and our own
  // 30-per-30-minute model. Checks cancelController every tick (via
  // runCancelableWait) so a Cancel click during this wait -- which can be up to
  // ~30 minutes -- stops promptly instead of running the full wait out first.
  async function waitForDeleteRateLimit(cancelController) {
    pruneDeleteTimestamps();
    const localResumeAt = computeRateLimitResumeAt(deleteTimestamps, DELETE_RATE_LIMIT_MAX, DELETE_RATE_LIMIT_WINDOW_MS);
    const serverResumeAt = computeServerRateLimitResumeAt(serverRateLimit.remaining, serverRateLimit.reset, Date.now());
    if (localResumeAt === null && serverResumeAt === null) return;
    const fromServer = serverResumeAt !== null && (localResumeAt === null || serverResumeAt > localResumeAt);
    const resumeAt = fromServer ? serverResumeAt : localResumeAt;

    const cancelled = await runCancelableWait(resumeAt, cancelController, delay, Date.now, (remainingMs) => {
      const remainingSec = Math.ceil(remainingMs / 1000);
      const mins = String(Math.floor(remainingSec / 60));
      const secs = String(remainingSec % 60);
      progressText.textContent = fromServer
        ? t("mastodonDashServerPaced", `Mastodon's rate limit reached. Resuming in ${mins}m ${secs}s...`, [mins, secs])
        : t("mastodonDashRatePaced", `Rate limit paced: 30 deletes per 30 min reached. Resuming in ${mins}m ${secs}s...`, [mins, secs]);
    });
    if (cancelled) return;

    // The wait is over; the stored "remaining: 0" is stale now.
    if (fromServer) serverRateLimit = { remaining: null, reset: null };
    pruneDeleteTimestamps();
  }

  // Helper for Mastodon API fetches
  // The running delete's cancel controller, so a long Retry-After wait inside
  // fetchWithRetry ends as soon as the user cancels. Null during scans.
  let activeDeleteCancel = null;

  async function apiFetch(endpoint, method = 'GET') {
    const url = `https://${host}${endpoint}`;
    const options = {
      method,
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const response = await fetchWithRetry(url, options, undefined, deleteRetryOptions(activeDeleteCancel, progressText));
    const remaining = response.headers && response.headers.get('X-RateLimit-Remaining');
    if (remaining !== null && remaining !== undefined) {
      serverRateLimit = { remaining, reset: response.headers.get('X-RateLimit-Reset') };
    }
    if (!response.ok) {
      if (response.status === 401) {
        const authErr = new Error(t("mastodonDashTokenInvalidError", "Your Mastodon access token appears to be invalid or revoked. Reconnect from the extension popup with a fresh token."));
        authErr.status = 401;
        authErr.expiredAuth = true;
        throw authErr;
      }
      const errBody = await response.json().catch(() => ({}));
      const apiErr = new Error(`HTTP ${response.status}`);
      apiErr.status = response.status;
      apiErr.serverMessage = errBody.error || '';
      if (response.status === 429) {
        const resetMs = Date.parse(response.headers && response.headers.get('X-RateLimit-Reset'));
        apiErr.retryAfterMs = Number.isFinite(resetMs) ? Math.max(0, resetMs - Date.now()) : null;
      }
      // A read-only token ("This action is outside the authorized scopes")
      // will fail every remaining delete identically -- stop on the FIRST one
      // (expiredAuth makes runDeleteLoop break) with an accurate message,
      // instead of three generic 403s.
      if (isScopeError(response.status, errBody.error)) {
        apiErr.scopeMissing = true;
        apiErr.expiredAuth = true;
      }
      apiErr.message = friendlyMastodonError(apiErr);
      throw apiErr;
    }
    // DELETE requests usually return empty JSON or 200 OK
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-mastodon.html.

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a partial/cancelled/selective delete leaves some scanned items
  // un-deleted -- those stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    visibleRows(items).forEach(status => {
      let plainText = plainTextOf.get(status);
      if (plainText === undefined) {
        plainText = statusPlainText(status);
        plainTextOf.set(status, plainText);
      }
      const div = document.createElement('div');
      div.className = 'post-item';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      if (isStatusPinned(status, pinnedIds)) {
        const pinBadge = document.createElement('span');
        pinBadge.className = 'badge badge-pinned';
        pinBadge.textContent = t("mastodonDashPinnedLabel", "Pinned");
        timeDiv.appendChild(pinBadge);
        timeDiv.appendChild(document.createTextNode(' '));
      }
      if (status.reblog) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-repost';
        badge.textContent = t("mastodonDashBoostLabel", "Boost");
        timeDiv.appendChild(badge);
        timeDiv.appendChild(document.createTextNode(' '));
      }
      timeDiv.appendChild(document.createTextNode(new Date(status.created_at).toLocaleString()));

      const textDiv = document.createElement('div');
      if (plainText) {
        textDiv.textContent = plainText;
      } else {
        const i = document.createElement('i');
        i.textContent = t("mastodonDashMediaOnly", "[Media only]");
        textDiv.appendChild(i);
      }

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, status, rowCheckboxes);
      // After addRowCheckbox so "Open" isn't folded into the checkbox's
      // aria-label. Built only from the validated instance host + ids.
      const permalink = buildMastodonPermalink(host, username, status);
      if (permalink) {
        const link = document.createElement('a');
        link.className = 'post-open-link';
        link.href = permalink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t("socialDashOpenLink", "Open");
        link.setAttribute('aria-label', t("socialDashOpenLinkAria", "Open on Mastodon in a new tab", ["Mastodon"]));
        timeDiv.appendChild(document.createTextNode(' '));
        timeDiv.appendChild(link);
      }
      itemList.appendChild(div);
    });
    appendHiddenRowsNote(itemList, items.length);
    wireSelectAll(selectAllBox, items, rowCheckboxes);
    exporter.refresh();
  }

  scanBtn.addEventListener('click', async () => {
    const filterText = filterInput.value.trim();
    const filters = readAdvancedFilters();
    const matcher = buildTextMatcher(filterText, filters.invert);

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.style.color = "";
    statusText.textContent = t("dashScanning", "Scanning...");
    renderEmptyState(itemList, t("socialDashScanningPosts", "Scanning your posts..."));
    currentResults = [];
    exporter.refresh();
    logActivity('sc-activity-log', filterText
      ? t("socialDashLogScanStartedFilter", `Scan started (filter: "${filterText}").`, [filterText])
      : t("socialDashLogScanStarted", "Scan started."));
    const activeFilters = describeActiveFilters(filters);
    if (activeFilters) logActivity('sc-activity-log', activeFilters);
    if (matcher.warning) {
      logActivity('sc-activity-log', matcher.warning === 'unsafe'
        ? t("mastodonDashRegexUnsafe", "That /regex/ could be very slow, so it was matched as plain text instead.")
        : t("mastodonDashRegexInvalid", "That /regex/ isn't valid, so it was matched as plain text instead."), 'warn');
    }

    try {
      // Pinned posts: the regular listing only flags them on some servers, so
      // ask for the pinned list once up front. Best-effort -- a failure here
      // must not block the scan, but "Keep pinned" then relies on the
      // per-status flag alone, which the user is told about.
      try {
        pinnedIds = buildPinnedIdSet(await apiFetch(`/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?pinned=true&limit=40`));
      } catch (pinErr) {
        pinnedIds = new Set();
        if (filters.keepPinned) {
          logActivity('sc-activity-log', t("mastodonDashPinnedFetchFailed", "Couldn't load your pinned posts; \"Keep pinned items\" can only protect posts the server marks as pinned."), 'warn');
        }
      }
      const accessors = {
        time: statusTimeMs,
        score: (s) => (typeof s.favourites_count === 'number' ? s.favourites_count : null),
        pinned: (s) => isStatusPinned(s, pinnedIds)
      };

      let maxId = '';
      let pageCount = 0;
      let truncated = false;
      const MAX_PAGES = 10; // 40 items per page * 10 = 400 posts per scan
      // Defensive de-dup: without this, a repeated/overlapping `max_id` page (a
      // non-standard instance/fork, or new activity shifting the listing mid-scan)
      // shows the same post twice, inflating "N items found" and queuing a
      // redundant delete request for it later. Mirrors dashboard-reddit.js's/
      // dashboard-x.js's seenIds guard.
      const seenIds = new Set();

      while (pageCount < MAX_PAGES) {
        let endpoint = `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?limit=40`;
        if (maxId) endpoint += `&max_id=${encodeURIComponent(maxId)}`;

        const statuses = await apiFetch(endpoint);
        if (!statuses || statuses.length === 0) break;

        for (const status of statuses) {
          if (seenIds.has(status.id)) continue;
          seenIds.add(status.id);

          // Decoded once (tags stripped, &#39;/&amp;/... resolved) and reused
          // for the row preview -- see htmlToPlainText.
          const plainText = statusPlainText(status);
          plainTextOf.set(status, plainText);
          if (matcher.test(plainText) && passesAdvancedFilters(status, filters, accessors)) {
            currentResults.push(status);
          }
        }

        maxId = statuses[statuses.length - 1].id;
        pageCount++;
        // Newest-first: a page entirely before the "From" date means every
        // later page is too -- nothing older can match, so the scan is complete.
        if (isMastodonPageOlderThan(statuses, filters.fromMs)) {
          truncated = false;
          break;
        }
        // Only a FULL page (limit=40) at the cap is real evidence more posts may
        // exist -- a partial last page (< 40) is itself proof the account's
        // history ended naturally on this exact page, even though it happens to
        // be the MAX_PAGES-th one.
        truncated = pageCount >= MAX_PAGES && statuses.length === 40;

        // A partial page is already proof the account's history just ended --
        // stop now instead of spending one more request + delay on it.
        if (statuses.length < 40) break;

        statusText.textContent = t("socialDashScanningProgress", `Scanning... (page ${pageCount}, ${currentResults.length} found)`, [String(pageCount), String(currentResults.length)]);
        // Slight delay to avoid hitting rate limits on scan
        await delay(500);
      }

      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: t("mastodonDashOlderMayExist", "older posts may exist")
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = t("socialDashScanComplete", "Scan complete. Review results before deleting.");
        logActivity('sc-activity-log', truncated
          ? t("socialDashLogScanCompleteTruncated", `Scan complete: ${currentResults.length} item(s) found (more may exist).`, [String(currentResults.length)])
          : t("socialDashLogScanComplete", `Scan complete: ${currentResults.length} item(s) found.`, [String(currentResults.length)]));
      } else {
        renderEmptyState(itemList, t("mastodonDashNoMatches", "No posts matched your criteria. Try widening your text filter."));
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', t("socialDashLogScanComplete", "Scan complete: 0 item(s) found.", ["0"]));
      }
    } catch (err) {
      const friendly = err.status ? err.message : friendlyMastodonError(err);
      await showAlert(t("socialDashScanFailed", `Scan failed: ${friendly}`, [friendly]));
      statusText.textContent = t("socialDashScanFailedStatus", "Scan failed. Nothing was deleted.");
      logActivity('sc-activity-log', t("socialDashScanFailed", `Scan failed: ${err.message}`, [err.message]), 'error');
    } finally {
      scanBtn.disabled = false;
      exporter.refresh();
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const selected = getSelectedItems(currentResults);
    if (selected.length === 0) {
      await showAlert(t("dashNoItemsSelected", "No items are selected. Check at least one item, or use Select All, before deleting."));
      return;
    }

    // Honest ETA before a long run: at 30 deletes per 30 minutes, a few hundred
    // posts takes hours, and the tab has to stay open the whole time.
    pruneDeleteTimestamps();
    const etaMs = estimateMastodonDeleteMs(selected.length, deleteTimestamps.length, DELETE_RATE_LIMIT_MAX, DELETE_RATE_LIMIT_WINDOW_MS, DELETE_MIN_SPACING_MS);
    const eta = formatDurationShort(etaMs);
    if (etaMs >= DELETE_RATE_LIMIT_WINDOW_MS) {
      const proceed = await showConfirm(t("mastodonDashEtaConfirm",
        `Mastodon only allows 30 deletions per 30 minutes. Deleting ${selected.length} posts will take about ${eta}, and this tab must stay open until it finishes. Continue?`,
        [String(selected.length), eta]));
      if (!proceed) return;
    }
    if (!(await confirmBulkDelete(selected.length, t("socialDashNounPosts", "posts")))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = t("mastodonDashDeletingEta", `Deleting... (estimated time: about ${eta})`, [eta]);
    statusText.style.color = "#ef4444";
    progressText.textContent = t("socialDashStartingDeletion", "Starting deletion...");

    const cancelController = createCancelController();
    activeDeleteCancel = cancelController;
    armCancelButton(cancelBtn, cancelController);

    // Mastodon does not support batch deletion. We must delete one by one.
    // Deletes (shared with un-reblog) are capped at 30 per rolling 30-minute
    // window, so we pace against that real limit instead of a flat delay.
    // deleteTimestamps is NOT reset here: the server's window doesn't restart when
    // a new run starts, so a cancel-and-restart must keep pacing against the
    // deletes already sent (stale entries are pruned on each check).

    const totalCount = selected.length;
    let deletedCount = 0;
    let failures = [];
    logActivity('sc-activity-log', t("socialDashLogDeleteStarted", `Delete started: ${totalCount} item(s) selected.`, [String(totalCount)]));
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        preItemWait: waitForDeleteRateLimit,
        postItemDelayMs: DELETE_MIN_SPACING_MS,
        deleteItem: async (status) => {
          const endpoint = buildDeleteStatusEndpoint(status.id);
          if (!endpoint) throw new Error(t("mastodonDashInvalidId", "This post has an unexpected id and was skipped."));
          try {
            await apiFetch(endpoint, 'DELETE');
          } finally {
            // Count the attempt against the window whether or not it succeeded
            // -- a failed delete still consumed a slot on the server.
            deleteTimestamps.push(Date.now());
          }
        }
      });
      deletedCount = result.deletedCount;
      failures = result.failures;
      const { succeededItems, expiredAuth, rateLimited, forbidden, cancelled } = result;
      const scopeMissing = failures.some(f => f.error && f.error.scopeMissing);

      // Anything scanned but not selected, anything selected but never reached
      // because a cancel/expired-auth break happened early, AND anything that
      // was attempted but failed to delete all stay visible -- only items
      // actually deleted are removed from view, so a failed delete never looks
      // indistinguishable from a successful one.
      const succeededSet = new Set(succeededItems);
      currentResults = currentResults.filter(item => !succeededSet.has(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        itemList.innerHTML = '';
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });

      const done = String(deletedCount);
      const total = String(totalCount);
      if (expiredAuth && scopeMissing) {
        statusText.textContent = t("mastodonDashScopeMissingStatus", "This token can't delete posts -- reconnect with a write-enabled token.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("mastodonDashLogScopeMissing", `Delete stopped: access token lacks the write:statuses scope (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(friendlyMastodonError({ scopeMissing: true }) + '\n\n' +
          t("socialDashDeletedBeforeStop", `${done} of ${total} items were deleted before this happened.`, [done, total]));
      } else if (expiredAuth) {
        statusText.textContent = t("mastodonDashTokenInvalidStatus", "Access token invalid -- reconnect required.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("socialDashLogDeleteSessionInvalid", `Delete stopped: session invalid (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(t("mastodonDashTokenInvalidAlert", `Stopped: your Mastodon access token appears to be invalid or revoked. ${done} of ${total} posts were deleted before this happened. Reconnect from the extension popup with a fresh token to finish.`, [done, total]));
      } else if (forbidden) {
        statusText.textContent = t("mastodonDashForbiddenStatus", "Mastodon refused the deletions -- stopped early.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("socialDashLogDeleteForbidden", `Delete stopped: repeated 403 Forbidden (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(t("mastodonDashForbiddenAlert", `Stopped: Mastodon refused several delete requests in a row (403 Forbidden). Your access token may be missing the write:statuses scope -- create a new token with read and write scopes and reconnect. ${done} of ${total} posts were deleted before this happened.`, [done, total]));
      } else if (rateLimited) {
        // The shared circuit breaker stopped the run after repeated 429s; without
        // this branch it was reported as "finished with N failure(s)" even though
        // most selected items were never attempted.
        statusText.textContent = t("socialDashRateLimitedStatus", "Rate limited by Mastodon -- stopped early.", ["Mastodon"]);
        statusText.style.color = "#ef4444";
        const lastRetry = failures.length ? failures[failures.length - 1].error?.retryAfterMs : null;
        const mins = lastRetry ? String(Math.max(1, Math.ceil(lastRetry / 60000))) : null;
        logActivity('sc-activity-log', t("socialDashLogDeleteRateLimited", `Delete stopped: repeated rate limiting (429) (${done}/${total} deleted).`, [done, total]), 'error');
        await showAlert(
          t("socialDashRateLimitedAlert", `Stopped: Mastodon rate-limited several delete requests in a row. ${done} of ${total} items were deleted before this happened.`, ["Mastodon", done, total]) + ' ' +
          (mins
            ? t("socialDashRetryInMinutes", `Try again in about ${mins} minute(s).`, [mins])
            : t("socialDashRetryLater", "Wait a while, then try again."))
        );
      } else if (cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${done} of ${total} processed.`, [done, total]);
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("socialDashLogDeleteCancelled", `Delete cancelled: ${done}/${total} processed.`, [done, total]), 'warn');
      } else if (failures.length === 0) {
        statusText.textContent = t("socialDashDeletionComplete", "Deletion complete!");
        statusText.style.color = "#10b981";
        logActivity('sc-activity-log', t("socialDashLogDeleteComplete", `Delete complete: ${done}/${total} deleted.`, [done, total]));
      } else {
        const failed = String(failures.length);
        statusText.textContent = t("socialDashDeletionFinishedFailures", `Deletion finished: ${done} deleted, ${failed} failed out of ${total}.`, [done, failed, total]);
        statusText.style.color = "#ef4444";
        console.warn("Mastodon delete failures:", failures);
        logActivity('sc-activity-log', t("socialDashDeletionFinishedFailures", `Deletion finished: ${done} deleted, ${failed} failed out of ${total}.`, [done, failed, total]), 'warn');
      }
      if (currentResults.length === 0) renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
    } catch (err) {
      const progress = err.deleteLoopProgress || { deletedCount, succeededItems: [] };
      // Prune whatever succeeded before the throw, mirroring the normal-completion
      // path above -- otherwise an aborted run (e.g. service-worker restart,
      // storage error) leaves already-deleted items checked and re-submittable
      // on the next Delete click.
      const succeededSet = new Set(progress.succeededItems || []);
      currentResults = currentResults.filter(item => !succeededSet.has(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        renderEmptyState(itemList, t("dashDeletionFinished", "Deletion finished."));
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });
      console.error("Mastodon delete loop stopped unexpectedly:", err);
      const friendly = err.status ? err.message : friendlyMastodonError(err);
      logActivity('sc-activity-log', t("socialDashLogDeleteUnexpected", `Delete stopped unexpectedly: ${err.message}`, [err.message]), 'error');
      await showAlert(t("socialDashDeleteStoppedAlert",
        `Deletion stopped unexpectedly: ${friendly}\n\n${progress.deletedCount} of ${totalCount} items were deleted before this happened. Scan again to see what's left.`,
        [friendly, String(progress.deletedCount), String(totalCount)]));
      statusText.textContent = t("socialDashDeleteStoppedStatus", "Deletion stopped unexpectedly -- scan again to see what's left.");
      statusText.style.color = "#ef4444";
    } finally {
      activeDeleteCancel = null;
      scanBtn.disabled = false;
      deleteBtn.disabled = currentResults.length === 0;
      resetCancelButton(cancelBtn);
      exporter.refresh();
    }
  });
});
