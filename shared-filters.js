// Bulk Clean for Slack - Shared filtering & safety logic (SINGLE SOURCE OF TRUTH)
//
// Loaded by:
//   - background.js  (Chrome/Chromium via manifest.json: importScripts in the service
//                     worker; Firefox via manifest.firefox.json: first entry in the
//                     background.scripts array, so it runs before background.js)
//   - tests/*.js     (Node: via require)
//
// Do NOT fork this logic. The content script deliberately does NOT reimplement it —
// scanning/filtering is delegated to the background service worker.

const MAX_REGEX_PATTERN_LENGTH = 100;
// A real keyword/regex filter rarely uses more than a handful of quantifiers;
// dozens are a hallmark of a backtracking foot-gun (see the chain check below).
const MAX_QUANTIFIERS = 10;
// Unbounded quantifiers (*, +, open-ended {n,}) are the ones that cause polynomial /
// catastrophic backtracking when several can match the SAME input. Each extra one
// raises the backtracking degree: `a*a*a*b` on a long run of "a" is cubic and freezes
// the single-threaded worker even though it has no groups, no adjacent quantifiers,
// and stays under MAX_QUANTIFIERS — so it slips past every structural rule above.
// A legitimate filter almost never chains more than two (e.g. `\d+\.\d+`), so cap them
// hard; two is the most that stays merely quadratic (and is further bounded below).
const MAX_UNBOUNDED_QUANTIFIERS = 2;
// Final backstop: the length of text a (safe, ≤2-unbounded) regex is actually run
// against. Slack allows very long messages; capping keeps even a quadratic pattern on
// a pathological repeated run well under a second. Chosen far above any real message,
// so ordinary matching is unaffected (over-long input under-matches, the safe way).
const MAX_REGEX_INPUT = 20000;

// System / no-op message subtypes that are never the user's own deletable content.
// Dropped by subtype regardless of text: Slack's join/leave/topic/purpose/name/archive
// messages DO carry a `text` ("<@U> has joined the channel"), so a text-presence proxy
// leaks them into a "delete all my messages" run. Content-bearing subtypes
// (me_message, thread_broadcast, bot_message, file_share, …) are deliberately excluded
// so genuine user content — including caption-less file uploads — stays deletable.
const SYSTEM_MESSAGE_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name",
  "channel_archive", "channel_unarchive",
  "group_join", "group_leave", "group_topic", "group_purpose", "group_name",
  "group_archive", "group_unarchive",
  "pinned_item", "unpinned_item", "bot_add", "bot_remove", "app_conversation_join"
]);

// Comprehensive ReDoS safety checker.
function isSafeRegex(pattern) {
  // Reject excessively long patterns
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;

  // Consecutive quantifiers: a**, a++, a*+, a+?, etc.
  if (/[+*?]{2,}/.test(pattern)) return false;

  // Nested quantifiers: (x+)+, (x*)+, (x+)*, (x+){2,}, etc.
  if (/\([^)]*[+*]\)[+*?{]/.test(pattern)) return false;

  // Doubly-nested quantified groups the rule above misses because the inner
  // quantifier is not directly adjacent to the outer group's close paren:
  // ((a+))+, ((a+)b)*, etc. Requires a quantifier inside an inner level, then a
  // second group-close, then an outer quantifier. The [^()] bounds keep this
  // from rejecting benign nested groups without an inner quantifier (e.g. ((a))+).
  if (/\([^()]*[+*][^()]*\)[^(]*\)[+*?{]/.test(pattern)) return false;

  // Alternation with potential overlap inside quantified groups: (a|a)+, (\d|\w)+
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) return false;

  // Quantified groups containing other quantifiers: (a{1,100}){1,100}
  if (/\([^)]*\{[^}]+\}[^)]*\)[+*{]/.test(pattern)) return false;

  // Backreferences inside quantified groups
  if (/\([^)]*\\[0-9]+[^)]*\)[+*]/.test(pattern)) return false;

  // Long chains of quantifiers with no grouping — these slip past every rule
  // above (no parens, no adjacent quantifiers) yet still backtrack
  // catastrophically/polynomially: e.g. `a?a?a?…a?aaaa…` (exponential) or
  // `a*a*a*…b` (polynomial). A legitimate keyword/regex filter never needs many
  // quantifiers, so cap the count. Escaped metacharacters (\*, \+, \?, \{) are
  // literals and must not be counted.
  const quantifiers = (pattern.match(/(?<!\\)[*+?{]/g) || []).length;
  if (quantifiers > MAX_QUANTIFIERS) return false;

  // Unbounded-quantifier chain guard (see MAX_UNBOUNDED_QUANTIFIERS). Count *, +, and
  // open-ended {n,} braces; escaped metacharacters (\*, \+) are literals and don't
  // count. This catches the polynomial `a*a*a*…b` / `\d+\d+\d+…` family that the count
  // cap above lets through (10 stars is degree-10 catastrophic, not safe).
  const unbounded = (pattern.match(/(?<!\\)[*+]/g) || []).length
                  + (pattern.match(/(?<!\\)\{\d*,\}/g) || []).length;
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) return false;

  return true;
}

// ReDoS-shielded qualification checker used by the background scan engine.
function qualifies(msg, userId, senderMode, textFilter, onlyAttachments) {
  // "me" mode must be able to identify the current user. If userId is missing
  // (upstream resolution failure), fail CLOSED — otherwise `undefined !== undefined`
  // lets a user-less message (bot/integration/system) slip through as "mine".
  if (senderMode === "me" && (!userId || msg.user !== userId)) {
    return false;
  }

  // Explicit system-message subtypes are never deletable user content — drop them up
  // front so neither a text filter nor the attachment toggle can select one.
  if (msg.subtype && SYSTEM_MESSAGE_SUBTYPES.has(msg.subtype)) {
    return false;
  }

  const hasFiles = !!(msg.files && msg.files.length > 0);
  const hasAttach = !!(msg.attachments && msg.attachments.length > 0);

  if (onlyAttachments && !hasFiles && !hasAttach) {
    return false;
  }

  if (textFilter) {
    let msgText = (msg.text || "").toLowerCase();

    if (hasFiles) {
      msg.files.forEach(f => {
        if (f) {
          if (f.name) msgText += " " + f.name.toLowerCase();
          if (f.title) msgText += " " + f.title.toLowerCase();
        }
      });
    }

    const keyword = textFilter.toLowerCase();

    if (keyword.startsWith("/") && keyword.endsWith("/") && keyword.length > 2) {
      const pattern = textFilter.substring(1, textFilter.length - 1);

      if (!isSafeRegex(pattern)) {
        // Dangerous or oversized pattern — fall back to literal substring match
        if (!msgText.includes(pattern.toLowerCase())) return false;
      } else {
        try {
          const regex = new RegExp(pattern, "i");
          // A regex that matches the empty string matches EVERY message — almost
          // always a mistyped filter (a stray trailing `*`/`?`, a lone `^`/`$`, `.*`,
          // an all-optional group). For a permanent-delete tool, silently selecting
          // the entire channel is the worst failure mode, so treat a degenerate
          // empty-matching pattern as selecting NOTHING: the user gets 0 results and
          // fixes the filter instead of nuking everything.
          if (regex.test("")) return false;
          // Bound the input a safe regex actually runs against (see MAX_REGEX_INPUT) —
          // a final backstop so even a ≤2-unbounded (quadratic) pattern on a very long
          // repeated run can't stall the worker.
          if (!regex.test(msgText.slice(0, MAX_REGEX_INPUT))) return false;
        } catch (e) {
          if (!msgText.includes(pattern.toLowerCase())) return false;
        }
      }
    } else {
      if (!msgText.includes(keyword)) return false;
    }
  }

  // Fallback for any OTHER (unlisted) subtype: drop it only when it carries no text
  // AND no files/attachments — generic system noise. Known system subtypes were
  // already dropped above; a caption-less file upload ("file_share") is kept here
  // because it has files, so a full "delete my messages" run never silently leaves
  // the user's bare uploads behind.
  if (msg.subtype && !msg.text && !(hasFiles || hasAttach)) {
    return false;
  }

  return true;
}

// Decide the concrete action for a queued message. Single source of truth,
// computed once by the background worker at enqueue time and then persisted, so
// the decision is deterministic across service-worker restarts.
//
//   "trim"   -> delete file attachments but keep the message text
//               (chat.update stripping files/attachments/blocks)
//   "delete" -> full chat.delete
//   "skip"   -> do nothing (attachment-only mode, but the item has no attachment
//               to clean — never destroy such a message)
//
// In attachment-only mode: items with no files/attachments are SKIPPED (deleting
// them would contradict "only delete attachments"); items with text are trimmed
// (text preserved); caption-less attachment carriers fall through to "delete",
// and the worker also removes their underlying file objects. Outside attachment
// mode every qualifying item is a full delete.
function decideItemAction(item, filterAttachments) {
  const hasFiles = !!(item.files && item.files.length > 0);
  const hasAttach = !!item.hasAttachments || !!(item.attachments && item.attachments.length > 0);
  const hasText = !!(item.text && item.text.trim().length > 0);
  if (filterAttachments) {
    if (!hasFiles && !hasAttach) return "skip";
    if (hasText) return "trim";
  }
  return "delete";
}

// Origin check: HTTPS on a slack.com subdomain (app.slack.com, <workspace>.slack.com).
// Only Slack controls *.slack.com DNS, so any real subdomain is trustworthy, while
// spoofs like app.slack.com.attacker.com, slack.com.evil.com, or evilslack.com are
// rejected because they do not end in ".slack.com".
function isSlackHostname(urlStr) {
  if (!urlStr) return false;
  try {
    const url = new URL(urlStr);
    return url.protocol === "https:" && url.hostname.endsWith(".slack.com");
  } catch (e) {
    return false;
  }
}

// Count how many places a Slack file is currently shared, from a files.info
// `file` object. Slack's `files.delete` purges a file from its store entirely —
// removing it from EVERY channel/DM it was ever shared into, not just the message
// being cleaned. Before hard-deleting we use this to confirm the file lives in
// exactly one place; a file shared elsewhere must be preserved so cleaning one
// conversation never destroys content in another (the "current chat scope" promise).
//
// `file.shares` looks like { public: { C123: [ {ts,...}, ... ] }, private: {...} }.
// Each entry in those per-channel arrays is one share; total them across scopes.
// A missing/empty shares map yields 0 (not shared anywhere we can see).
function fileShareCount(file) {
  const shares = (file && file.shares) || {};
  let count = 0;
  for (const scope of Object.keys(shares)) {
    const channels = shares[scope] || {};
    for (const chId of Object.keys(channels)) {
      const arr = channels[chId];
      if (Array.isArray(arr)) count += arr.length;
    }
  }
  return count;
}

// Deterministic avatar color from an arbitrary string (UI helper, pure).
function stringToColor(str) {
  if (!str) return "#8B5CF6";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "#8B5CF6", "#EC4899", "#3B82F6", "#10B981", "#F59E0B",
    "#EF4444", "#06B6D4", "#14B8A6", "#84CC16", "#A855F7"
  ];
  const idx = Math.abs(hash) % colors.length;
  return colors[idx];
}

// Export for Node (tests). In the service worker / event page these become globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_REGEX_PATTERN_LENGTH,
    isSafeRegex,
    qualifies,
    decideItemAction,
    isSlackHostname,
    fileShareCount,
    stringToColor
  };
}
