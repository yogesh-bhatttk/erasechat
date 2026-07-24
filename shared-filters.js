// SlackClean Premium - Shared filtering & safety logic (SINGLE SOURCE OF TRUTH)
//
// Loaded by:
//   - background.js  (Chrome: via importScripts; Firefox: via background.scripts array)
//   - tests/*.js     (Node: via require)
//
// Do NOT fork this logic. The content script deliberately does NOT reimplement it —
// scanning/filtering is delegated to the background service worker.

const MAX_REGEX_PATTERN_LENGTH = 100;
// A real keyword/regex filter rarely uses more than a handful of quantifiers;
// dozens are a hallmark of a backtracking foot-gun (see the chain check below).
const MAX_QUANTIFIERS = 10;

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

  return true;
}

// ReDoS-shielded qualification checker used by the background scan engine.
function qualifies(msg, userId, senderMode, textFilter, onlyAttachments) {
  if (senderMode === "me" && msg.user !== userId) {
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
          if (!regex.test(msgText)) return false;
        } catch (e) {
          if (!msgText.includes(pattern.toLowerCase())) return false;
        }
      }
    } else {
      if (!msgText.includes(keyword)) return false;
    }
  }

  // Drop system/no-op subtype messages (channel_join, channel_leave, etc.) —
  // those carry a subtype, no text, AND no files/attachments. A caption-less
  // file upload also has a subtype ("file_share") and no text, but it IS the
  // user's own content and must be deletable in EVERY mode (a full "delete my
  // messages" run should not silently leave the user's bare uploads behind),
  // so genuine attachment carriers are kept regardless of the attachments toggle.
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
