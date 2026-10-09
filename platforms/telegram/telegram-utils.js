// Erasechat - Telegram dashboard: small, dependency-free helpers split out of
// telegram-dashboard.src.js into their own plain CommonJS module so they're
// unit-testable directly (see tests/telegram-utils.test.js) without needing
// teleproto or a live MTProto client. isTelegramAuthError stays in
// telegram-dashboard.src.js itself -- it depends on teleproto's
// errors.UnauthorizedError, so it isn't dependency-free the way these are.
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

// "First Last (@username)" for the dashboard's "Connected as" label, falling back
// to the username alone, then the phone number -- so the user can see WHICH
// account is about to be cleaned, not just that some account is connected.
function formatTelegramAccount(user) {
  if (!user || typeof user !== 'object') return '';
  const name = [user.firstName, user.lastName]
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim())
    .join(' ');
  const username = typeof user.username === 'string' && user.username ? `@${user.username}` : '';
  if (name && username) return `${name} (${username})`;
  if (name || username) return name || username;
  return user.phone ? `+${String(user.phone).replace(/^\+/, '')}` : '';
}

// Plain picker entry for one dialog from client.getDialogs(): a stable key, the
// display label, and the username (so typing "@alice" in the search box finds
// Alice even if her display name differs). Returns null for the self dialog --
// the picker already has a fixed "Saved Messages" entry for that.
function buildDialogOption(dialog) {
  if (!dialog || typeof dialog !== 'object') return null;
  const entity = dialog.entity || {};
  if (entity.self) return null;
  const id = dialog.id != null ? String(dialog.id) : (entity.id != null ? String(entity.id) : '');
  if (!id) return null;
  const label = String(dialog.title || dialog.name || entity.title ||
    [entity.firstName, entity.lastName].filter(Boolean).join(' ') || '').trim();
  const username = typeof entity.username === 'string' ? entity.username : '';
  return { key: id, label: label || (username ? `@${username}` : id), username };
}

// Case-insensitive substring filter for the picker's search box, over both the
// display label and the @username.
function filterDialogOptions(options, query) {
  const q = String(query || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return options.slice();
  return options.filter((o) =>
    o.label.toLowerCase().includes(q) || (o.username && o.username.toLowerCase().includes(q))
  );
}

// A typed username/phone always wins over the list selection, so a chat that
// isn't among the first page of dialogs can still be targeted; nothing at all
// means Saved Messages ('me').
function resolveTargetPeer(typedValue, selectedKey) {
  const typed = String(typedValue || '').trim();
  if (typed) return { kind: 'typed', value: typed };
  if (selectedKey && selectedKey !== 'me') return { kind: 'dialog', value: String(selectedKey) };
  return { kind: 'self', value: 'me' };
}

// Splits a delete selection into the user's own messages and everyone else's.
// For a non-channel peer, messages.DeleteMessages "succeeds" even when Telegram
// ignores the request for other people's messages (basic group, not an admin),
// so only the user's own messages can honestly be counted as deleted.
function splitByOwnership(messages) {
  const own = [];
  const others = [];
  for (const m of messages || []) (m && m.out === true ? own : others).push(m);
  return { own, others };
}

// Maps a teleproto login/RPC error to a short kind the dashboard turns into a
// friendly, localized message (instead of raw "PHONE_CODE_INVALID"-style codes).
function telegramLoginErrorKind(err) {
  const msg = String((err && (err.errorMessage || err.message)) || '');
  if (/PHONE_NUMBER_INVALID|PHONE_NUMBER_UNOCCUPIED/i.test(msg)) return 'phoneInvalid';
  if (/PHONE_NUMBER_BANNED|USER_DEACTIVATED/i.test(msg)) return 'phoneBanned';
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/i.test(msg)) return 'codeInvalid';
  if (/PHONE_CODE_EXPIRED/i.test(msg)) return 'codeExpired';
  if (/PASSWORD_HASH_INVALID/i.test(msg)) return 'passwordInvalid';
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i.test(msg)) return 'apiIdInvalid';
  if (/FLOOD_WAIT|FLOOD/i.test(msg)) return 'flood';
  if (/AUTH_KEY_(UNREGISTERED|INVALID|PERM_EMPTY)|SESSION_(REVOKED|EXPIRED)|AUTH_RESTART/i.test(msg)) return 'session';
  if (/websocket|network|timeout|timed out|disconnect|connection/i.test(msg)) return 'network';
  return 'unknown';
}

// Converts the advanced-filter date range (readAdvancedFilters()'s fromMs/toMs,
// epoch milliseconds, toMs already end-of-day) into messages.Search's
// minDate/maxDate (unix seconds; 0 = unbounded) so Telegram narrows the scan
// server-side instead of paging through the whole chat. Telegram treats both
// bounds as exclusive ("bigger/smaller than"), so each is widened by one second;
// the dashboard still applies passesAdvancedFilters() locally as the exact,
// inclusive backstop. Clamped to the signed 32-bit range the TL `int` field takes.
const TG_MAX_INT32 = 2147483647;
function searchDateBounds(filters) {
  const f = filters || {};
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  let minDate = 0;
  let maxDate = 0;
  if (valid(f.fromMs)) minDate = Math.max(0, Math.floor(f.fromMs / 1000) - 1);
  if (valid(f.toMs)) maxDate = Math.min(TG_MAX_INT32, Math.floor(f.toMs / 1000) + 1);
  if (minDate > TG_MAX_INT32) minDate = TG_MAX_INT32;
  return { minDate, maxDate };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FloodWaitCancelledError, cancelableDelay,
    formatTelegramAccount, buildDialogOption, filterDialogOptions, resolveTargetPeer,
    splitByOwnership, telegramLoginErrorKind, searchDateBounds
  };
}
