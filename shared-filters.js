// Erasechat - Shared filtering & safety logic (SINGLE SOURCE OF TRUTH)
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
// against. This is deliberately SMALL, and the smallness is load-bearing rather than
// a nicety — measured directly against the worst adversarial-but-"safe" pattern this
// guard is known to still admit (`a*[ab]{4}a*b`, which isSafeRegex() above passes:
// only 2 unbounded quantifiers, not narrowly adjacent), run against a string of
// repeated "a"s (its worst case — no trailing "b", so it never matches and exhausts
// every backtracking split):
//   input length -> time to test (measured cold, i.e. worst case for a service worker
//   that just woke from idle and has no JIT warm-up yet):
//     300 chars ->  ~36ms   325 chars -> ~45ms   350 chars -> ~55ms
//     500 chars -> ~156ms   600 chars -> ~263ms  4000 chars -> ~10 SECONDS
// The growth is worse than the quadratic this file's comments used to assume (2x
// input roughly 7-8x's the time, i.e. degree ~3), so the previous 20000-char cap —
// chosen on that quadratic assumption — left a multi-second stall reachable via one
// ordinary-length Slack message (well under Slack's own 4000-char default limit, no
// adversarial input needed) on the single-threaded background worker. No static
// pattern-shape heuristic can cover every ReDoS shape (this is the ~4th such patch to
// this file per CHANGELOG.md), so this cap is a DETERMINISTIC backstop independent of
// the heuristic above: even a pattern the heuristic wrongly admits can only ever run
// against this many characters. 300 is chosen to keep the measured worst case
// comfortably under ~50ms even cold/unwarmed; ordinary text-filter matching is
// unaffected in practice (nobody filters on content past the first ~300 characters of
// a message) and, as before, over-long input under-matches rather than over-matches —
// the safe direction for a permanent-delete tool.
const MAX_REGEX_INPUT = 300;

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

  // Stricter check for adjacent or narrowly separated unbounded quantifiers (e.g. .*.*)
  if (/(?<!\\)[*+].{0,3}(?<!\\)[*+]/.test(pattern)) return false;

  return true;
}

// ReDoS-shielded qualification checker used by the background scan engine.
//
// `options`:
//   invertText     -> the text/regex filter means "keep if it matches" instead of
//                     "delete if it matches", i.e. delete everything EXCEPT matches.
//                     A degenerate (empty-matching) pattern still selects NOTHING in
//                     either mode — inverting a broken filter must never expand
//                     scope to the whole channel.
//   excludePinned  -> never qualify a message Slack currently shows as pinned
//                     (msg.pinned_to non-empty). Off by default for backward
//                     compatibility with existing positional callers/tests.
function qualifies(msg, userId, senderMode, textFilter, onlyAttachments, options) {
  const { invertText = false, excludePinned = false } = options || {};

  // "me" mode must be able to identify the current user. If userId is missing
  // (upstream resolution failure), fail CLOSED — otherwise `undefined !== undefined`
  // lets a user-less message (bot/integration/system) slip through as "mine".
  if (senderMode === "me" && (!userId || msg.user !== userId)) {
    return false;
  }

  // A message the user deliberately pinned is the opposite of throwaway content —
  // protect it from an otherwise-matching bulk filter unless the user opts out.
  if (excludePinned && Array.isArray(msg.pinned_to) && msg.pinned_to.length > 0) {
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

    // Attachments (e.g. link unfurls) carry their own visible text separate from
    // files — `text`/`fallback` is the body Slack renders in the preview card and
    // `title` is its heading. Without these a text filter could silently fail to
    // match content the user plainly sees in the message, in either direction:
    // missing a match that should qualify, or (with Invert Text) wrongly qualifying
    // something the user meant to keep because its visible attachment text was
    // invisible to the filter.
    if (hasAttach) {
      msg.attachments.forEach(a => {
        if (a) {
          if (a.text) msgText += " " + a.text.toLowerCase();
          if (a.fallback) msgText += " " + a.fallback.toLowerCase();
          if (a.title) msgText += " " + a.title.toLowerCase();
        }
      });
    }

    const keyword = textFilter.toLowerCase();
    let matched;
    // Set only when the pattern matches the empty string (see the comment at the
    // regex.test("") check below) — never toggled for the plain-substring path.
    let degenerate = false;

    if (keyword.startsWith("/") && keyword.endsWith("/") && keyword.length > 2) {
      const pattern = textFilter.substring(1, textFilter.length - 1);

      if (!isSafeRegex(pattern)) {
        // Dangerous or oversized pattern — fall back to literal substring match
        matched = msgText.includes(pattern.toLowerCase());
      } else {
        try {
          const regex = new RegExp(pattern, "i");
          // A regex that matches the empty string matches EVERY message — almost
          // always a mistyped filter (a stray trailing `*`/`?`, a lone `^`/`$`, `.*`,
          // an all-optional group). For a permanent-delete tool, silently selecting
          // the entire channel is the worst failure mode, so treat a degenerate
          // empty-matching pattern as selecting NOTHING — in EITHER mode: normal
          // mode already refuses to match, and inverting "match nothing" would
          // otherwise mean "delete everything", the exact failure this guards
          // against. The user gets 0 results and fixes the filter instead.
          if (regex.test("")) {
            degenerate = true;
            matched = false;
          } else {
            // Bound the input a safe regex actually runs against (see
            // MAX_REGEX_INPUT) — a final backstop so even a ≤2-unbounded
            // (quadratic) pattern on a very long repeated run can't stall the worker.
            matched = regex.test(msgText.slice(0, MAX_REGEX_INPUT));
          }
        } catch (e) {
          matched = msgText.includes(pattern.toLowerCase());
        }
      }
    } else {
      matched = msgText.includes(keyword);
    }

    if (degenerate) return false;
    if (invertText ? matched : !matched) return false;
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
// (text preserved); caption-less attachment carriers fall through to "delete" via
// chat.delete. The underlying file objects themselves are NOT separately removed
// (files.delete was deliberately dropped to avoid collateral data loss in unseen
// private channels the file may also be shared into — see background.js's
// executeQueue) — the file remains in Slack's workspace storage. Outside
// attachment mode every qualifying item is a full delete.
function decideItemAction(item, filterAttachments) {
  const hasFiles = !!(item.files && item.files.length > 0);
  const hasAttach = !!item.hasAttachments || !!(item.attachments && item.attachments.length > 0);
  const hasText = !!(item.text && item.text.trim().length > 0);
  const hasBlocks = !!(Array.isArray(item.blocks) && item.blocks.some(b => b && b.type !== "image" && b.type !== "file"));
  if (filterAttachments) {
    if (!hasFiles && !hasAttach) return "skip";
    if (hasText || hasBlocks) return "trim";
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
    stringToColor
  };
}
