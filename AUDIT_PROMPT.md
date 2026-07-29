# Audit Prompt — Bulk Clean for Slack (browser extension)

Copy everything below the line into a fresh Claude Code / agent session running in this
repository. It is written to be pasted as-is.

---

## Role & goal

You are auditing **Bulk Clean for Slack**, a Manifest V3 browser extension (Chrome + Firefox)
that bulk-deletes and cleans a user's Slack messages using the Slack web API. Because this
tool **permanently deletes user data**, correctness and safety matter more than anything
else. Your #1 job is: **find everything that could break, silently misbehave, delete the
wrong thing, or fail to delete what the user asked for.** Secondary: security, privacy,
performance, cross-browser compatibility, and store-review compliance.

Treat this as a read-and-report audit. **Do not change code** unless I explicitly ask you to
fix something afterward. Investigate the actual code — do not assume behavior from names.

## What the extension is (so you can orient fast)

- `manifest.json` — MV3, permissions `storage`/`scripting`/`alarms`, host `*.slack.com`,
  CSP `script-src 'self'`, Firefox `gecko` settings, popup + keyboard command, i18n via
  `__MSG_*__`.
- `background.js` (service worker) — Slack API proxy (`slackAPICall` / `...WithRetry`),
  per-channel **job queue** with `chrome.alarms`, a **watchdog** alarm, rate-limit (HTTP 429)
  handling, retry/backoff, job persistence in `chrome.storage.local`, and Slack **tokens kept
  only in `chrome.storage.session`** (never in local).
- `content.js` — the in-page dashboard injected into Slack: scan UI, filters, progress,
  console log, theme, SPA URL observer, resume-on-reload flow, custom alert/confirm modals.
- `popup.js` / `popup.html` / `popup.css` — launcher: detects a Slack tab, injects/activates
  the dashboard, onboarding.
- `shared-filters.js` — the filter/decision logic shared between scan and delete:
  `qualifies()`, `decideItemAction()`, `isSafeRegex()` (ReDoS guard), `isSlackHostname()`,
  `stringToColor()`. This is the heart of "what gets deleted" — scrutinize it hardest.
- `_locales/en/` — i18n messages. `tests/` — `node --test` unit tests + Playwright e2e.

## Priority 1 — Functional correctness & data-loss safety (spend most effort here)

Trace the real code paths and answer concretely (cite `file:line`):

1. **Filter accuracy — the delete/keep decision.** In `shared-filters.js`, does `qualifies()`
   / `decideItemAction()` ever mark a message for deletion that the user's filters did NOT
   ask for? Check every filter combination: sender mode (me / everyone / specific user),
   text filter (plain keyword vs. `/regex/`), attachments-only, threads vs. root messages,
   files vs. attachments vs. plain text. Look for off-by-one, truthy/falsy bugs
   (`!!` chains), case sensitivity, empty-filter defaults, and "no filter set" behavior
   (does an empty filter select *everything*? is that guarded by a confirm?).
2. **Regex safety.** Verify `isSafeRegex()` + `MAX_REGEX_PATTERN_LENGTH` actually block
   catastrophic-backtracking / ReDoS patterns and malformed regex. What happens when the
   pattern is invalid — does the scan throw, silently match nothing, or fall back to
   matching everything (dangerous)?
3. **Scan ↔ delete consistency.** Confirm the item that gets deleted is exactly the item that
   was scanned and shown to the user — no re-fetch that could reorder, no stale index, no
   pagination cursor bug (`next_cursor`) that skips or double-counts messages.
4. **Job queue & alarms lifecycle** (`background.js`): scheduling (`scheduleNextStep`),
   execution (`executeQueue`), watchdog sweep, `onStartup`/`onInstalled`/`onSuspend`,
   `recoverAllJobs`. Can a job get stuck, run twice concurrently (`markRunning` /
   `isAutoResumeAllowed` race), resume without user consent, or resume against the wrong
   channel/team? Verify `queueKeyFor(teamId, channelId)` keys never collide.
5. **Service-worker suspension.** MV3 workers die at any time. What in-flight state is lost on
   suspend mid-delete? Confirm persisted state is enough to resume correctly and idempotently
   (no re-deleting, no skipping). Check that alarms re-arm after wake.
6. **Rate limiting & retries.** `slackAPICallWithRetry`, 429 handling, `broadcastRateLimit`,
   `Retry-After`. Does backoff respect Slack's header? Is there an infinite-retry or
   tight-loop risk? Does the countdown UI in content.js stay in sync with the actual pause?
7. **Token handling flow.** Token lives only in `chrome.storage.session`. Trace: what happens
   when the token is missing/expired mid-job (`ensureToken`)? Does the job fail loudly, or
   silently stall / drop items? Is a re-auth path present?
8. **Slack API contract.** Check the endpoints/params used (e.g. `conversations.history`,
   `chat.delete`, user lookups) against Slack's real API: required params, `ok:false` error
   handling (`not_allowed_token_type`, `message_not_found`, `cant_delete_message`), and
   whether per-item failures abort the whole job or are counted and skipped.
9. **SPA navigation** (`startUrlObserver`, `handleUrlChange`, `switchTargetChannel`): when the
   user switches channels/workspaces mid-session, does the dashboard rebind to the correct
   channel, or can it delete in the *previously* active channel? This is a high-risk path.
10. **Message passing** (`content.js` ↔ `background.js` ↔ `popup.js`): every
    `sendMessage`/`onMessage`, `sender` validation (`isValidSender`), `chrome.runtime.lastError`
    handling, and responses to closed tabs. Any unhandled message type or dropped response
    that leaves the UI hung?
11. **UI state integrity**: `syncButtonStates`, progress/percent math (`CIRCLE_CIRCUMFERENCE`),
    resume prompt (`checkAndResumeState`), and confirm modals. Can the user start a second job
    while one runs? Does the large-delete threshold (`LARGE_DELETE_THRESHOLD = 100`) confirm
    fire correctly? Do cancel/stop actually stop the background job?
12. **Edge cases**: 0 results, exactly 1 result, thousands of results (chunked render
    `RENDER_CHUNK_SIZE`), deleted/deactivated users, bot messages, messages you can't delete,
    multiple Slack workspaces open in different tabs simultaneously.

## Priority 2 — Security & privacy

- CSP correctness; no `eval`/inline handlers; no injection via message text rendered as HTML
  (XSS from Slack message content into the dashboard DOM — check how message text is inserted).
- Token never logged, never written to `storage.local`, never sent anywhere but `slack.com`.
- `isSlackHostname()` / host checks — can any request or injection target a non-Slack origin?
- `web_accessible_resources` exposure; sender/origin validation on all messages.
- Confirm `PRIVACY_POLICY.md` matches actual data flows (what's collected/stored, where).

## Priority 3 — Compatibility, i18n, performance, store compliance

- **Firefox vs. Chrome**: `chrome.storage.session` availability (code has a fallback — verify
  it), `browser_specific_settings`, service-worker vs. event-page differences, `minimum_chrome_version`.
- **i18n**: every user-facing string uses `__MSG_*__` / `chrome.i18n.getMessage`; no missing
  keys in `_locales/en/messages.json`; no hardcoded English left in JS/HTML.
- **Performance/memory**: leaks from `setInterval`/observers not cleared, unbounded caches
  (`loadUserCache`, `MAX_USER_CACHE_PAGES`, `USER_CACHE_TTL_MS`), console log cap
  (`CONSOLE_LOG_MAX_LINES`).
- **Manifest/store review**: permissions justified and minimal, description/version consistency
  across `manifest.json`, `package.json`, `CHANGELOG.md`, store assets.

## Method

1. Read `shared-filters.js`, `background.js`, `content.js`, `popup.js`, `manifest.json` fully.
2. Run the existing tests and report results: `npm test` (unit) and, if feasible,
   `npm run test:e2e` (Playwright). Note anything that fails or is untested.
3. For each finding, verify by reading the code — don't speculate. Where a bug could delete or
   skip messages, describe a concrete trigger scenario (inputs → wrong outcome).
4. Note gaps in test coverage, especially around the filter-decision logic and job resume.

## Output format

Produce a report grouped by the priorities above. For each finding:

- **Severity**: Critical (data loss / deletes wrong messages / security) · High · Medium · Low.
- **Location**: `file:line`.
- **What**: the bug/risk in one or two sentences.
- **Trigger**: concrete steps or inputs that cause it.
- **Impact**: what the user experiences.
- **Fix**: recommended change (do not apply it yet).

End with: (a) a ranked short-list of the top issues to fix first, (b) test-coverage gaps, and
(c) anything you could not verify and why. Be specific and skeptical — if something looks fine,
say why it's fine; if you're unsure, say so rather than guessing.
