// Decodes a JWT's payload (no signature verification -- this only ever reads claims
// from a token we already trust, captured passively from the user's own Teams
// traffic, never used to authenticate anything). Kept at module scope, with the two
// functions below, so both are unit-testable without a DOM -- see
// tests/teams-dashboard.test.js.
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

// The captured Bearer token is a JWT whose `oid` (or `sub`) claim is the signed-in
// user's own AAD object id. Teams' internal chatsvc API embeds that same GUID inside
// a message's `from` MRI string (e.g. "8:orgid:<oid>") regardless of exact MRI shape,
// so matching on the GUID substring is more robust than assuming a fixed prefix.
// This is the only reliable way to tell "my message" from "someone else's message" --
// `imdisplayname` is present on every message regardless of sender and must never be
// used as an ownership signal.
function getOwnUserId(bearerToken) {
  try {
    const jwt = bearerToken.replace(/^Bearer\s+/i, '');
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(base64UrlDecode(payload));
    return claims.oid || claims.sub || null;
  } catch {
    return null;
  }
}

// Purely cosmetic "Connected as ..." label (unlike getOwnUserId, which is
// security-relevant -- the "is this my message" check). A missing/unusual claim
// here just leaves the label blank; it never affects what gets deleted. Falls
// back through the AAD claims most likely to carry a human-readable identity.
function getOwnDisplayIdentity(bearerToken) {
  try {
    const jwt = bearerToken.replace(/^Bearer\s+/i, '');
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(base64UrlDecode(payload));
    return claims.preferred_username || claims.upn || claims.unique_name || claims.name || null;
  } catch {
    return null;
  }
}

// True when a freshly-refreshed token (see apiFetch's 401 retry path below) decodes
// to a DIFFERENT own-identity than the one the current scan/delete run started with.
// Only compares two actual, decoded ids -- a refreshed token that fails to decode at
// all (null) is a decode failure, not evidence of a different identity, and is left
// for the normal expired-auth handling to deal with instead of being misreported as
// an identity change. Module-scope and pure so it's unit-testable without a DOM --
// see tests/teams-dashboard.test.js.
function identityChangedMidRun(originalOwnUserId, refreshedOwnUserId) {
  return !!(originalOwnUserId && refreshedOwnUserId && originalOwnUserId !== refreshedOwnUserId);
}

// chatsvc pages OLDER history via `_metadata.backwardLink` (a full URL), not a
// top-level `nextLink` -- following only nextLink stopped every scan after the
// first page while still reporting it as complete. `_metadata.syncState` is
// deliberately NOT followed: it points FORWARD (a poll for newer activity), so
// treating it as "the next page" would re-read the newest page or loop. nextLink
// stays as a fallback for any tenant/API version that still returns it. Pure so
// it's unit-testable -- see tests/teams-dashboard.test.js.
function pickOlderPageLink(res) {
  if (!res || typeof res !== 'object') return null;
  const md = res._metadata || {};
  const link = md.backwardLink || res.nextLink || md.nextLink || null;
  return typeof link === 'string' && link ? link : null;
}

// A page link from chatsvc may name a different Teams host than the one the
// token was captured on (e.g. a regional *.msg.teams.microsoft.com vs the bare
// teams.microsoft.com/api/chatsvc/<region> prefix). apiFetch refuses foreign
// origins (the bearer token must not leave the captured host), so re-point such a
// link at the captured base when it is the same chat API on a Teams host; anything
// else returns null and the caller stops paginating (reported as truncated).
// Pure -- see tests/teams-dashboard.test.js.
function rebasePageLink(link, baseUrl) {
  if (!link) return null;
  let parsed, base;
  try {
    base = new URL(baseUrl);
    parsed = new URL(link, base);
  } catch {
    return null;
  }
  if (parsed.origin === base.origin) return parsed.href;
  const host = parsed.hostname;
  const isTeamsHost = host === 'teams.microsoft.com' || host.endsWith('.teams.microsoft.com') ||
    host === 'teams.cloud.microsoft' || host.endsWith('.teams.cloud.microsoft');
  const apiIdx = parsed.pathname.indexOf('/v1/users/ME/');
  if (parsed.protocol !== 'https:' || !isTeamsHost || apiIdx === -1) return null;
  return baseUrl.replace(/\/+$/, '') + parsed.pathname.slice(apiIdx) + parsed.search;
}

// chatsvc returns system/event entries (member added, call started/ended, topic
// renamed, typing/control signals...) in the same `messages` array as real chat
// messages, and keeps soft-deleted messages around with `properties.deletetime`
// set. Neither is something the user can (or needs to) delete -- offering them
// only inflates the count and queues delete requests that fail or no-op. A
// message with no messagetype at all is kept, so an unexpected payload shape
// degrades to the previous behavior rather than hiding everything.
function isDeletableTeamsMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.deleted) return false;
  const deleteTime = msg.properties && msg.properties.deletetime;
  if (deleteTime && String(deleteTime) !== '0') return false;
  const type = msg.messagetype || msg.messageType;
  if (type && !/^(Text|RichText)(\/|$)/i.test(String(type))) return false;
  return true;
}

// Human-readable parts for a chat-picker entry, instead of the raw `19:abc...`
// thread id an untitled group chat or 1:1 chat would otherwise show. Returns one
// of { topic } / { names, more } / { date } / {} -- the caller formats it
// (localized) so this stays pure and DOM-free. Member names are only used when
// the payload actually carries them; the last message's sender name is used for
// a chat with no member list (typically a 1:1), but never the user's own name.
function buildChatLabelParts(conv, ownUserId) {
  if (!conv || typeof conv !== 'object') return {};
  const tp = conv.threadProperties || {};
  const topic = typeof tp.topic === 'string' ? tp.topic.trim() : '';
  if (topic) return { topic };

  const isSelf = (id) => !!(ownUserId && typeof id === 'string' && id.includes(ownUserId));
  const names = [];
  const addName = (name, id) => {
    if (typeof name !== 'string') return;
    const n = name.trim();
    if (n && !isSelf(id) && !names.includes(n)) names.push(n);
  };
  let members = Array.isArray(conv.members) ? conv.members : null;
  if (!members && typeof tp.members === 'string') {
    try {
      const parsed = JSON.parse(tp.members);
      if (Array.isArray(parsed)) members = parsed;
    } catch { /* not JSON -- no names available from it */ }
  }
  for (const m of members || []) {
    if (m && typeof m === 'object') addName(m.friendlyName || m.displayName || m.name, m.id || m.mri);
  }
  const last = conv.lastMessage || {};
  if (names.length === 0) addName(last.imdisplayname, last.from);
  if (names.length > 0) {
    const MAX_NAMES = 3;
    return { names: names.slice(0, MAX_NAMES), more: Math.max(0, names.length - MAX_NAMES) };
  }

  const date = last.composetime || last.originalarrivaltime ||
    (conv.properties && conv.properties.lastimreceivedtime) || null;
  if (date && !Number.isNaN(new Date(date).getTime())) return { date };
  return {};
}

// Maps a failed chatsvc response status to a short kind the UI turns into a
// friendly, localized message instead of a bare "API Error N".
function classifyTeamsHttpStatus(status) {
  if (status === 401) return 'expired';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'server';
  return 'http';
}

// Pure: a chatsvc message's arrival time in ms (originalarrivaltime, falling back
// to composetime), or null when missing/unparseable.
function teamsMessageTimeMs(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const raw = msg.originalarrivaltime || msg.composetime || msg.time;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Pure: chatsvc pages newest -> older (see pickOlderPageLink), so once EVERY
// message on a page (with a known time, anyone's -- not just mine) is older than
// the "From" date, every older page is too: stop following backwardLink instead
// of spending requests on history the date filter would discard. A page with no
// datable message never triggers the stop (unknown != old).
function isTeamsPageOlderThan(messages, fromMs) {
  if (fromMs === null || fromMs === undefined || !Array.isArray(messages) || messages.length === 0) return false;
  let dated = 0;
  for (const m of messages) {
    const ms = teamsMessageTimeMs(m);
    if (ms === null) continue;
    if (ms >= fromMs) return false;
    dated++;
  }
  return dated > 0;
}

// Pure: ISO 8601 string for an export cell ("" for a missing/invalid date).
function teamsIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// Pure: CSV/JSON export columns for scanned results ({ id, text, time, chat,
// sender }) -- see mountExportButtons in platforms/shared/platform-filters.js.
function buildTeamsExportColumns() {
  return [
    { label: t("teamsDashColChat", "Chat"), get: (m) => String(m.chat || '') },
    { label: t("teamsDashColDate", "Date"), get: (m) => teamsIsoDate(m.time) },
    { label: t("teamsDashColSender", "Sender"), get: (m) => String(m.sender || '') },
    { label: t("teamsDashColText", "Text"), get: (m) => String(m.text || '') }
  ];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    teamsMessageTimeMs, isTeamsPageOlderThan, teamsIsoDate, buildTeamsExportColumns,
    rebasePageLink,
    getOwnUserId, getOwnDisplayIdentity, identityChangedMidRun,
    pickOlderPageLink, isDeletableTeamsMessage, buildChatLabelParts, classifyTeamsHttpStatus
  };
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(['teams_token']),
    chrome.storage.local.get(['teams_base_url'])
  ]);
  if (!sessionData.teams_token || !localData.teams_base_url) {
    await showAlert(t("teamsDashNotLinked", "Not linked to MS Teams. Please open the extension popup first."));
    window.close();
    return;
  }

  const { teams_base_url: baseUrl } = localData;
  const data = sessionData;

  // let, not const: the 401-retry-refresh path in apiFetch below can replace
  // cachedToken with a token captured from a DIFFERENT Teams identity (see
  // teams-webrequest.js -- its listener is always-on and passively captures a
  // Bearer token from ANY teams.microsoft.com tab, not just the one this dashboard
  // was opened for), so both of these are recomputed from the new token whenever
  // that happens, and compared against the identity the current run started with.
  let ownUserId = getOwnUserId(data.teams_token);
  let ownDisplayIdentity = getOwnDisplayIdentity(data.teams_token);
  const connectedAsEl = document.getElementById('connected-as');
  if (connectedAsEl && ownDisplayIdentity) {
    connectedAsEl.textContent = t("dashConnectedAs", `(Connected: ${ownDisplayIdentity})`, [ownDisplayIdentity]);
  }

  // Cached rather than re-read from chrome.storage.local on every apiFetch call
  // (every scan page, up to MAX_PAGES, and every delete item) -- the token rarely
  // changes mid-session, and the 401 handler below already re-reads storage and
  // updates this cache on the rare occasion it actually has expired.
  let cachedToken = data.teams_token;

  const loadChatsBtn = document.getElementById('load-chats-btn');
  const chatSelect = document.getElementById('chat-select');
  const scanBtn = document.getElementById('scan-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const cancelBtn = document.getElementById('sc-btn-cancel');
  const filterInput = document.getElementById('text-filter');
  const itemList = document.getElementById('item-list');
  const resultsCount = document.getElementById('results-count');
  const statusText = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');

  resultsCount.textContent = formatScanCount(0, { truncated: false, keepTruncated: false });

  const DELETE_PROGRESS_KEY = 'teams_delete_progress';
  await reportInterruptedDelete(DELETE_PROGRESS_KEY, statusText);
  initActivityLog('sc-activity-log');

  let currentResults = [];

  // Date range / invert controls (no keep rules -- chatsvc has no reactions
  // count or pin state worth keeping on) and the CSV/JSON export buttons -- see
  // platforms/shared/platform-filters.js.
  mountAdvancedFilters();
  const exporter = mountExportButtons({
    platform: 'teams',
    columns: buildTeamsExportColumns(),
    getItems: () => currentResults
  });

  // delay/fetchWithRetry: see platforms/shared/dashboard-fetch-utils.js, loaded
  // before this file by dashboard-teams.html.

  // A localized, actionable message per failure kind (see classifyTeamsHttpStatus)
  // instead of a bare "API Error N".
  function httpError(status) {
    const kind = classifyTeamsHttpStatus(status);
    let message;
    if (kind === 'forbidden') {
      message = t("teamsDashErrForbidden", "Teams refused this request (403). This can happen for a few different reasons -- a personal Microsoft account, an organization messaging policy that doesn't allow deleting sent messages, or the message being past Teams' own edit/delete window. A work/school account with a policy that permits message deletion is required for the first two.");
    } else if (kind === 'expired') {
      message = t("teamsDashErrExpired", "Your Teams session appears to have expired. Reopen teams.cloud.microsoft, make sure you're signed in, then click the Erasechat toolbar icon again to reconnect.");
    } else if (kind === 'notFound') {
      message = t("teamsDashErrNotFound", "Teams couldn't find this chat or message -- it may have been deleted, or you may no longer be a member.");
    } else if (kind === 'rateLimited') {
      message = t("teamsDashErrRateLimited", "Teams is limiting how fast requests can be made. Wait a minute, then try again.");
    } else if (kind === 'server') {
      message = t("teamsDashErrServer", `Teams' servers had a problem (error ${status}). Try again in a moment.`, [String(status)]);
    } else {
      message = t("teamsDashErrHttp", `Teams returned an unexpected response (error ${status}).`, [String(status)]);
    }
    const err = new Error(message);
    err.status = status;
    if (kind === 'expired') err.expiredAuth = true;
    return err;
  }

  // The running delete's cancel controller, so a long Retry-After wait inside
  // fetchWithRetry ends as soon as the user cancels. Null during scans.
  let activeDeleteCancel = null;

  async function apiFetch(endpoint, method = 'GET') {
    const token = cachedToken;

    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
    // Pagination links come from the API response; never send the bearer token
    // anywhere but the captured Teams origin.
    if (new URL(url).origin !== new URL(baseUrl).origin) {
      throw new Error(t("teamsDashErrUnexpectedHost", "Refusing to follow a Teams link to an unexpected host."));
    }
    const options = {
      method,
      headers: {
        'Authorization': token,
        'Accept': 'application/json'
      }
    };
    // fetch() itself only throws on a network-level failure (offline, DNS, the
    // request blocked) -- surfaced as "Failed to fetch", which says nothing useful.
    const fetchOrNetworkError = async (opts) => {
      try {
        return await fetchWithRetry(url, opts, undefined, deleteRetryOptions(activeDeleteCancel, progressText));
      } catch (e) {
        const err = new Error(t("teamsDashErrNetwork", "Couldn't reach Teams. Check your internet connection and try again."));
        err.cause = e;
        throw err;
      }
    };
    let response = await fetchOrNetworkError(options);

    // A 401 means the token we sent has expired. background.js passively
    // re-captures a fresh token whenever the user's own Teams tab makes a
    // request, so there may already be a newer one sitting in storage by
    // the time we see this failure. Re-read storage and retry the single
    // request once before giving up - don't let one stale token abort an
    // entire in-progress batch delete.
    if (response.status === 401) {
      const refreshedData = await chrome.storage.session.get(['teams_token']);
      const refreshedToken = refreshedData.teams_token;
      if (refreshedToken && refreshedToken !== token) {
        const refreshedOwnUserId = getOwnUserId(refreshedToken);
        // The newly captured token may belong to a completely different signed-in
        // Teams identity than the one this scan/delete run started with (see
        // teams-webrequest.js's listener). Continuing would mean filtering "my
        // messages" against the OLD identity while issuing API calls with the NEW
        // token's credentials -- silently acting on whichever account happens to
        // own the just-captured token. Hard-abort instead, the same way an
        // actually-expired session hard-aborts below.
        if (identityChangedMidRun(ownUserId, refreshedOwnUserId)) {
          const err = new Error(t("teamsDashErrIdentityChanged", "Your signed-in Teams identity changed during this session — stopping to avoid acting on the wrong account. Please reconnect and try again."));
          // Not literally an expired-auth failure, but reused so a running delete
          // loop stops immediately instead of retrying every remaining item the
          // same doomed way -- runDeleteLoop (dashboard-fetch-utils.js) only
          // fast-stops on `err.expiredAuth`/`err.staleQueryId`, and this condition
          // is just as systemic and just as unrecoverable mid-run. `identityMismatch`
          // is what the delete handler below checks to show this message instead of
          // the generic session-expired one.
          err.expiredAuth = true;
          err.identityMismatch = true;
          throw err;
        }

        cachedToken = refreshedToken;
        ownUserId = refreshedOwnUserId;
        ownDisplayIdentity = getOwnDisplayIdentity(refreshedToken);
        if (connectedAsEl) {
          connectedAsEl.textContent = ownDisplayIdentity
            ? t("dashConnectedAs", `(Connected: ${ownDisplayIdentity})`, [ownDisplayIdentity])
            : '';
        }
        const retryOptions = {
          method,
          headers: {
            'Authorization': refreshedToken,
            'Accept': 'application/json'
          }
        };
        response = await fetchOrNetworkError(retryOptions);
      }
    }

    if (!response.ok) throw httpError(response.status);

    // DELETE requests may return empty body
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  function formatChatLabel(conv) {
    const parts = buildChatLabelParts(conv, ownUserId);
    if (parts.topic) return parts.topic;
    if (parts.names) {
      const joined = parts.names.join(', ');
      return parts.more > 0
        ? t("teamsDashChatNamesMore", `${joined} +${parts.more} more`, [joined, String(parts.more)])
        : joined;
    }
    if (parts.date) {
      const when = new Date(parts.date).toLocaleDateString();
      return t("teamsDashChatDated", `Chat (last message ${when})`, [when]);
    }
    return t("teamsDashChatUntitled", "Untitled chat");
  }

  // Shared by the scan-success render and the post-delete "remaining items"
  // render (a partial/cancelled/selective delete leaves some scanned items
  // un-deleted -- those stay visible with fresh checkboxes, not discarded).
  function renderResultRows(items) {
    itemList.innerHTML = '';
    resetSelection(items);
    const selectAllBox = renderSelectAllControl(itemList);
    const rowCheckboxes = [];
    visibleRows(items).forEach(msg => {
      const div = document.createElement('div');
      div.className = 'post-item';

      const timeDiv = document.createElement('div');
      timeDiv.className = 'post-time';
      timeDiv.textContent = new Date(msg.time).toLocaleString();

      const textDiv = document.createElement('div');
      textDiv.textContent = msg.text;

      div.appendChild(timeDiv);
      div.appendChild(textDiv);
      addRowCheckbox(div, msg, rowCheckboxes);
      itemList.appendChild(div);
    });
    appendHiddenRowsNote(itemList, items.length);
    wireSelectAll(selectAllBox, items, rowCheckboxes);
    exporter.refresh();
  }

  loadChatsBtn.addEventListener('click', async () => {
    loadChatsBtn.disabled = true;
    statusText.style.color = "";
    statusText.textContent = t("teamsDashLoadingChats", "Loading chats...");
    try {
      // The conversation list pages the same way messages do (see
      // pickOlderPageLink) -- reading only the first page silently hid every
      // chat past it. Bounded so a huge tenant history can't stall the picker.
      const MAX_CHAT_PAGES = 10;
      let endpoint = '/v1/users/ME/conversations?pageSize=100';
      let pageCount = 0;
      const seenLinks = new Set();
      let unfollowableLink = false;
      const seenChatIds = new Set();
      const chats = [];
      while (endpoint && pageCount < MAX_CHAT_PAGES) {
        seenLinks.add(endpoint);
        const res = await apiFetch(endpoint);
        for (const conv of res.conversations || []) {
          // Teams chat IDs usually start with '19:'
          if (conv.id && conv.id.startsWith('19:') && !seenChatIds.has(conv.id)) {
            seenChatIds.add(conv.id);
            chats.push(conv);
          }
        }
        pageCount++;
        const rawNext = pickOlderPageLink(res);
        const next = rebasePageLink(rawNext, baseUrl);
        if (rawNext && !next) unfollowableLink = true;
        // An empty page or a link we already followed means there's nothing older.
        endpoint = (next && !seenLinks.has(next) && (res.conversations || []).length > 0) ? next : null;
        if (endpoint && pageCount < MAX_CHAT_PAGES) await delay(500);
      }
      const chatsTruncated = !!endpoint || unfollowableLink;

      chatSelect.innerHTML = '';
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.textContent = t("teamsDashSelectChatPlaceholder", "-- Select a Chat --");
      chatSelect.appendChild(placeholderOpt);
      for (const conv of chats) {
        const opt = document.createElement('option');
        opt.value = conv.id;
        opt.textContent = formatChatLabel(conv);
        chatSelect.appendChild(opt);
      }

      statusText.textContent = chatsTruncated
        ? t("teamsDashChatsLoadedTruncated", `${chats.length} chats loaded (stopped after ${MAX_CHAT_PAGES} pages -- older chats aren't listed).`, [String(chats.length), String(MAX_CHAT_PAGES)])
        : t("teamsDashChatsLoaded", `${chats.length} chats loaded.`, [String(chats.length)]);
      scanBtn.disabled = false;
    } catch (err) {
      await showAlert(t("teamsDashLoadChatsFailed", `Failed to load chats: ${err.message}`, [err.message]));
      statusText.textContent = t("teamsDashStatusLoadChatsFailed", "Couldn't load chats.");
      statusText.style.color = "#ef4444";
    } finally {
      loadChatsBtn.disabled = false;
    }
  });

  scanBtn.addEventListener('click', async () => {
    const chatId = chatSelect.value;
    const chatLabel = chatId ? (chatSelect.selectedOptions[0]?.textContent || chatId) : '';
    const filterText = filterInput.value.trim();
    const filters = readAdvancedFilters();
    const matcher = buildTextMatcher(filterText, filters.invert);

    if (!chatId) { await showAlert(t("teamsDashSelectChatFirst", "Please select a chat first.")); return; }
    if (!ownUserId) {
      await showAlert(t("teamsDashNoIdentity", "Could not determine your own Teams identity from the captured token, so scanning was refused for safety (this would otherwise risk surfacing other participants' messages). Try reconnecting to Teams."));
      return;
    }

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.style.color = "";
    statusText.textContent = t("dashScanning", "Scanning...");
    renderEmptyState(itemList, t("teamsDashScanningMessages", "Scanning messages..."));
    currentResults = [];
    exporter.refresh();
    logActivity('sc-activity-log', filterText
      ? t("teamsDashLogScanStartedFilter", `Scan started (chat: ${chatLabel}, filter: "${filterText}").`, [chatLabel, filterText])
      : t("teamsDashLogScanStarted", `Scan started (chat: ${chatLabel}).`, [chatLabel]));
    const activeFilters = describeActiveFilters(filters);
    if (activeFilters) logActivity('sc-activity-log', activeFilters);
    if (matcher.warning) {
      logActivity('sc-activity-log', matcher.warning === 'unsafe'
        ? t("teamsDashRegexUnsafe", "That /regex/ could be very slow, so it was matched as plain text instead.")
        : t("teamsDashRegexInvalid", "That /regex/ isn't valid, so it was matched as plain text instead."), 'warn');
    }
    const accessors = { time: teamsMessageTimeMs };

    try {
      // Fetch recent messages in chat, capped at MAX_PAGES (like the mastodon/reddit/x
      // dashboards) so a long-lived chat can't be scanned in full on every click.
      let endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages?pageSize=100`;
      let pageCount = 0;
      const MAX_PAGES = 20; // 100 messages per page * 20 = 2000 messages per scan
      // Defensive de-dup: without this, a repeated/overlapping page (new activity
      // shifting the listing mid-scan) shows the same message twice, inflating
      // "N items found" and queuing a redundant delete request for it later.
      // Mirrors dashboard-reddit.js's/dashboard-x.js's seenIds guard.
      const seenIds = new Set();
      const seenLinks = new Set();
      let unfollowableLink = false;

      while (endpoint && pageCount < MAX_PAGES) {
        seenLinks.add(endpoint);
        const res = await apiFetch(endpoint);
        const messages = res.messages || [];

        for (const msg of messages) {
          if (seenIds.has(msg.id)) continue;
          seenIds.add(msg.id);
          if (msg.from && msg.from.includes(ownUserId) && isDeletableTeamsMessage(msg)) {
            // A media-only message (image/file share) has an EMPTY `content` of its
            // own -- but a message that's pure markup (e.g. a bare inline image tag)
            // has a TRUTHY `content` that strips down to nothing, so the check must
            // happen on the stripped text, not the raw content (matching mastodon's
            // equivalent check on `plainText`, not raw `content`). Without this
            // fallback such messages never enter currentResults and can never be
            // selected for deletion here.
            const strippedContent = msg.content ? msg.content.replace(/<[^>]+>/g, '') : '';
            const text = strippedContent || t("teamsDashMediaOnly", "[Media only]");

            if (matcher.test(text) && passesAdvancedFilters(msg, filters, accessors)) {
              currentResults.push({
                id: msg.id,
                text: text,
                time: msg.originalarrivaltime,
                chat: chatLabel,
                sender: (typeof msg.imdisplayname === 'string' && msg.imdisplayname) || ownDisplayIdentity || ''
              });
            }
          }
        }

        pageCount++;
        // Newest -> older: a page entirely before the "From" date means every
        // older page is too, so the scan is complete (not truncated).
        if (isTeamsPageOlderThan(messages, filters.fromMs)) {
          endpoint = null;
          unfollowableLink = false;
          break;
        }
        const rawNext = pickOlderPageLink(res);
        const next = rebasePageLink(rawNext, baseUrl);
        if (rawNext && !next) unfollowableLink = true;
        // An empty page, or a link already followed (the API handing back the same
        // cursor), means there's no older history -- stop instead of looping.
        endpoint = (next && !seenLinks.has(next) && messages.length > 0) ? next : null;
        if (endpoint && pageCount < MAX_PAGES) await delay(1000); // 1s delay for pagination
      }
      // Truncated only when the cap stopped us with an older page still on offer --
      // never claim a complete scan in that case.
      const truncated = !!endpoint || unfollowableLink;

      resultsCount.textContent = formatScanCount(currentResults.length, {
        truncated, maxPages: MAX_PAGES, note: t("teamsDashOlderMayExist", "older messages may exist")
      });

      if (currentResults.length > 0) {
        renderResultRows(currentResults);
        deleteBtn.disabled = false;
        statusText.textContent = t("teamsDashScanComplete", "Scan complete. Review results before deleting.");
        logActivity('sc-activity-log', truncated
          ? t("teamsDashLogScanCompleteTruncated", `Scan complete: ${currentResults.length} message(s) found (truncated -- more may exist).`, [String(currentResults.length)])
          : t("teamsDashLogScanComplete", `Scan complete: ${currentResults.length} message(s) found.`, [String(currentResults.length)]));
      } else {
        renderEmptyState(itemList, t("teamsDashNoMatches", "No matching messages found in this chat. Try widening your text filter, or pick a different chat."));
        statusText.textContent = t("dashReady", "Ready");
        logActivity('sc-activity-log', t("teamsDashLogScanComplete", "Scan complete: 0 message(s) found.", ["0"]));
      }
    } catch (err) {
      await showAlert(t("teamsDashScanFailed", `Scan failed: ${err.message}`, [err.message]));
      statusText.textContent = t("teamsDashStatusScanFailed", "Scan failed.");
      statusText.style.color = "#ef4444";
      logActivity('sc-activity-log', t("teamsDashScanFailed", `Scan failed: ${err.message}`, [err.message]), 'error');
    } finally {
      scanBtn.disabled = false;
      exporter.refresh();
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const chatId = chatSelect.value;
    const selected = getSelectedItems(currentResults);
    if (selected.length === 0) {
      await showAlert(t("dashNoItemsSelected", "No items are selected. Check at least one item, or use Select All, before deleting."));
      return;
    }
    if (!(await confirmBulkDelete(selected.length, t("teamsDashNounMessages", "messages")))) return;

    scanBtn.disabled = true;
    deleteBtn.disabled = true;
    statusText.textContent = t("dashDeleting", "Deleting...");
    statusText.style.color = "#ef4444";
    progressText.textContent = t("teamsDashStartingDeletion", "Starting deletion...");

    const cancelController = createCancelController();
    activeDeleteCancel = cancelController;
    armCancelButton(cancelBtn, cancelController);

    const totalCount = selected.length;
    const total = String(totalCount);
    let deletedCount = 0;
    let failures = [];
    logActivity('sc-activity-log', t("teamsDashLogDeleteStarted", `Delete started: ${totalCount} message(s) selected.`, [total]));
    try {
      const result = await runDeleteLoop(selected, {
        cancelController,
        progressKey: DELETE_PROGRESS_KEY,
        progressText,
        // Strict 2.5 second delay to avoid enterprise security alarms / rate limits
        postItemDelayMs: 2500,
        deleteItem: async (msg) => {
          // DELETE /v1/users/ME/conversations/{chatId}/messages/{messageId}
          const endpoint = `/v1/users/ME/conversations/${encodeURIComponent(chatId)}/messages/${msg.id}`;
          await apiFetch(endpoint, 'DELETE');
        }
      });
      deletedCount = result.deletedCount;
      failures = result.failures;
      const { succeededItems, expiredAuth, rateLimited, forbidden, cancelled } = result;
      const done = String(deletedCount);

      // Anything scanned but not selected, anything selected but never reached
      // because a cancel/expired-auth break happened early, AND anything that
      // was attempted but failed to delete all stay visible -- only items
      // actually deleted are removed from view, so a failed delete never looks
      // indistinguishable from a successful one. A Set lookup here (rather than
      // Array#includes) keeps this O(n) instead of O(n^2) -- succeededItems is
      // typically most/all of currentResults on a normal run.
      const succeededSet = new Set(succeededItems);
      currentResults = currentResults.filter(item => !succeededSet.has(item));
      if (currentResults.length > 0) {
        renderResultRows(currentResults);
      } else {
        itemList.innerHTML = '';
      }
      resultsCount.textContent = formatScanCount(currentResults.length, { truncated: false });

      if (expiredAuth) {
        // The failure that triggered the expiredAuth fast-stop is always the last
        // one pushed (runDeleteLoop breaks right after pushing it) -- inspect its
        // original error to tell an actually-expired session apart from an
        // identity-changed-mid-run abort (see apiFetch's 401 retry path above),
        // since both use the same expiredAuth fast-stop but need different wording.
        const lastFailureErr = failures.length > 0 ? failures[failures.length - 1].error : null;
        if (lastFailureErr && lastFailureErr.identityMismatch) {
          statusText.textContent = t("teamsDashStatusIdentityChanged", "Teams identity changed — reconnect required.");
          statusText.style.color = "#ef4444";
          logActivity('sc-activity-log', t("teamsDashLogIdentityChanged", `Delete stopped: signed-in Teams identity changed mid-session (${deletedCount}/${totalCount} deleted).`, [done, total]), 'error');
          await showAlert(t("teamsDashAlertIdentityChanged", `Stopped: your signed-in Teams identity changed during this session — stopping to avoid acting on the wrong account. ${deletedCount} of ${totalCount} messages were deleted before this happened. Please reconnect and try again.`, [done, total]));
        } else {
          statusText.textContent = t("teamsDashStatusExpired", "Session expired — reconnect required.");
          statusText.style.color = "#ef4444";
          logActivity('sc-activity-log', t("teamsDashLogExpired", `Delete stopped: session expired (${deletedCount}/${totalCount} deleted).`, [done, total]), 'error');
          await showAlert(t("teamsDashAlertExpired", `Stopped: your Teams session appears to have expired. ${deletedCount} of ${totalCount} messages were deleted before this happened. Reopen teams.cloud.microsoft, sign in, then click the Erasechat toolbar icon again to reconnect and finish.`, [done, total]));
        }
      } else if (forbidden) {
        statusText.textContent = t("teamsDashStatusForbidden", "Teams refused the deletions — stopped early.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("teamsDashLogForbidden", `Delete stopped: repeated 403 Forbidden from Teams (${deletedCount}/${totalCount} deleted).`, [done, total]), 'error');
        await showAlert(t("teamsDashAlertForbidden", `Stopped: Teams refused several delete requests in a row (403 Forbidden). Your organization's messaging policy may not allow deleting sent messages. ${deletedCount} of ${totalCount} messages were deleted before this happened.`, [done, total]));
      } else if (rateLimited) {
        // The shared circuit breaker stopped the run after repeated 429s; without
        // this branch it was reported as "finished with N failure(s)" even though
        // most selected items were never attempted.
        statusText.textContent = t("teamsDashStatusRateLimited", "Rate limited by Teams — stopped early.");
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("teamsDashLogRateLimited", `Delete stopped: repeated rate limiting (429) from Teams (${deletedCount}/${totalCount} deleted).`, [done, total]), 'error');
        await showAlert(t("teamsDashAlertRateLimited", `Stopped: Teams rate-limited several delete requests in a row. ${deletedCount} of ${totalCount} messages were deleted before this happened. Wait a while, then try again.`, [done, total]));
      } else if (cancelled) {
        statusText.textContent = t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [done, total]);
        statusText.style.color = "#ef4444";
        logActivity('sc-activity-log', t("dashCancelledPartial", `Cancelled: ${deletedCount} of ${totalCount} processed.`, [done, total]), 'warn');
      } else if (failures.length === 0) {
        statusText.textContent = t("teamsDashDeletionComplete", "Deletion complete!");
        statusText.style.color = "#10b981";
        logActivity('sc-activity-log', t("teamsDashLogDeleteComplete", `Delete complete: ${deletedCount}/${totalCount} deleted.`, [done, total]));
      } else {
        const failed = String(failures.length);
        statusText.textContent = t("teamsDashStatusPartialFail", `Deletion finished with ${failures.length} failure(s) out of ${totalCount}.`, [failed, total]);
        statusText.style.color = "#ef4444";
        console.warn("Teams delete failures:", failures);
        logActivity('sc-activity-log', t("teamsDashLogPartialFail", `Delete finished: ${deletedCount} deleted, ${failures.length} failed out of ${totalCount}.`, [done, failed, total]), 'warn');
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
      console.error("Teams delete loop stopped unexpectedly:", err);
      logActivity('sc-activity-log', t("teamsDashLogUnexpected", `Delete stopped unexpectedly: ${err.message}`, [err.message]), 'error');
      await showAlert(t("teamsDashAlertUnexpected", `Deletion stopped unexpectedly: ${err.message}\n\n${progress.deletedCount} of ${totalCount} messages were deleted before this happened.`, [err.message, String(progress.deletedCount), total]));
      statusText.textContent = t("teamsDashStatusUnexpected", "Deletion stopped unexpectedly.");
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
