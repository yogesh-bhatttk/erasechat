# Changelog

## Unreleased — Data-loss scope, workspace switching & scan completeness

Fourth functional pass. Focused audit of the delete/keep decision, scan↔delete
consistency, and job lifecycle, plus the fixes below.

### High — data-loss scope (`shared-filters.js`, `background.js`)

- **A clean could delete files that were shared in OTHER conversations, breaking
  the "current chat scope" promise.** `files.delete` purges a file from Slack
  *entirely* — every channel/DM it was ever shared into — so cleaning one channel
  silently removed files that also lived elsewhere. The engine now looks up each
  file's live share count (`files.info`) before deleting and **hard-deletes only
  files that exist in exactly one place**; a file shared elsewhere is left intact
  and logged (a full delete still removes the message, a trim keeps the text). An
  unverifiable share count is treated conservatively — never hard-deleted. New pure
  `fileShareCount()` in `shared-filters.js`, covered by unit tests.

### Medium — correctness (`background.js`, `content.js`)

- **Switching workspaces in the same tab left the dashboard operating against the
  previous workspace's credentials.** Slack's unified client changes the team in
  the URL on a workspace switch, but only the channel was re-detected — `activeTeam`
  (token/userId) went stale, so scans/deletes failed against the new workspace until
  a reload. `handleUrlChange` and the dashboard re-open path now detect the team
  change and re-point credentials (new `switchWorkspace()`); a running job
  auto-pauses and stays pinned to its origin workspace. _`content.js`._
- **Thread replies were silently missed when their parent fell outside a custom
  date range.** `conversations.history` only returns messages whose own timestamp
  is inside the window, so a thread whose root predated the range was never expanded
  and its in-range replies were skipped — with no truncation warning. When threads
  are included and a lower date bound is set, the history sweep now drops the
  server-side lower bound to discover older parents, and root messages are filtered
  to the window client-side so an out-of-window root is never itself queued.
  Scoped so "Older than X days" / "All Time" (already `oldest=0`) are unaffected.
  _`background.js`._
- **A perpetually rate-limited item could stall a job forever.** The delete queue
  retried a 429'd item indefinitely (honoring `Retry-After`) with no cap, so
  sustained throttling left a job stuck at N% with no terminal state. Consecutive
  429s on one item are now capped (20); on exceeding it the job **pauses
  (recoverable)** instead of looping. A shared 429 handler also keeps the dashboard
  countdown in sync with the actual backoff (previously off by 1s). _`background.js`._

### Low — UI / copy (`content.js`, `_locales/en/messages.json`)

- **"Only Delete Attachments" copy oversold text preservation.** A caption-less
  attachment/blocks-only message is fully deleted (nothing to preserve); the toggle
  subtitle now says so.
- **Delete button stayed enabled during a scan** — now disabled at scan start until
  fresh results finish rendering (was guarded by an empty-queue check, but sloppy).
- **"Select All" toggled mid-render** left later cards checked regardless; new cards
  now follow the live Select-All state.

`npm test` → **47/47** (5 new `fileShareCount` tests). All four JS files
syntax-checked; `messages.json` valid.

## Unreleased — Deletion completeness & internationalization

Follow-up to the deep audit, expanding what a clean actually removes and making
the UI translatable.

- **Caption-less file uploads are now deletable in a normal clean.** `qualifies()`
  previously dropped every subtype-bearing, text-less message outside "attachment"
  mode, so a `file_share` posted without a caption survived a full "delete my
  messages" run. The system-message guard now only drops messages that also have
  no files/attachments (channel_join, etc.); genuine uploads are kept in every
  mode. _`shared-filters.js`; test updated._
- **A full delete now also purges the message's uploaded files.** `files.delete`
  ran only in attachment-cleaning mode, so a normal delete removed the message but
  left the file in Slack's store (still downloadable/searchable). Files are now
  deleted for every item that has them. Attachment mode still aborts the item if a
  file can't be removed (never orphan); a normal delete removes the message on a
  best-effort basis and logs any file it couldn't delete. _`background.js`._
- **Internationalization wired up (English-fallback pattern).** Added a `t()`
  helper and a `data-i18n` localizer to `popup.js` and `content.js`, `data-i18n*`
  attributes across `popup.html` and the injected dashboard markup, and ~85 UI
  strings to `_locales/en/messages.json`. Translations are applied over the English
  already in the markup, so a missing key or a browser without `chrome.i18n` keeps
  the English — no blank labels, no regression. Covers all static UI chrome plus
  the dynamic scan/delete button and status labels. Verbose diagnostic console-log
  lines and interactive alert/confirm dialog bodies remain English for now (they
  interpolate runtime values); adding a second locale is now a
  messages-file-only task for the covered surface.

`npm test` → **42/42**. All JS syntax-checked; `messages.json` valid; every
referenced i18n key resolves.

## Unreleased — Deep audit fixes (engine safety, resumption & UI state)

Third functional pass. Two independent code reviews of the delete engine and the
content-script UI, cross-checked against the code and unit tests.

### Critical / High — deletion engine (`background.js`)

- **PAUSE / RESUME / CANCEL silently no-op'd after a service-worker idle-death,
  so a running job could not be stopped and would keep deleting.** These handlers
  operated only on the in-memory `activeJobs` map. If the SW was idle-killed
  during a long rate-limit backoff (the alarm branch the code explicitly expects
  to outlive the SW) and was woken *by the pause/cancel message itself*,
  `activeJobs` was empty, the handler body was skipped, yet `success:true` was
  returned — while the on-disk state and the `sc_run_` session flag still said
  "running", so a pending alarm/watchdog later **resumed the cancelled job**. All
  three now recover the job from storage before acting (async response).
- **Recovery after a mid-batch SW death re-deleted already-gone messages and
  counted the real successes as failures.** Progress was persisted every 10 items,
  so recovery could rewind up to 9. Already-deleted messages (`message_not_found`)
  are now treated as an idempotent **success**, so re-processing is harmless and
  the failure tally is honest.
- **Transient errors permanently skipped messages.** Only `rate_limited` was
  retried; a `network_error`/exception counted the item as failed and advanced
  past it forever. Transient failures now retry the same item up to 3× with a
  short backoff before giving up.
- **Attachment mode could destroy a message and orphan its file.** When
  `files.delete` hit a hard (non-rate-limit) error, the code logged a warning and
  still ran `chat.delete`, leaving the file in Slack's store. The message op is
  now aborted when a file can't be removed — the message and file both stay intact
  and the item is marked failed for retry.
- **`thread_broadcast` replies were scanned, queued and deleted twice** (they
  appear in both `conversations.history` and the parent thread). Scan results are
  now de-duplicated by timestamp.
- **Completion could strand a job at 100%.** Completion was only detected on the
  tick *after* the last item; pausing in that ~throttle window cancelled the tick
  and the "finished" alert never fired. The job now finalizes immediately after
  the last item.

### High — ReDoS (`shared-filters.js`)

- **`isSafeRegex` admitted catastrophic quantifier chains** (`a?a?…a?aaaa`,
  `a*a*…b`) that have no groups/adjacent quantifiers and slipped past every
  structural rule — hanging the single-threaded service worker. Added a
  quantifier-count cap (escaped metacharacters excluded). New unit tests cover it.

### Medium — content-script UI/state (`content.js`)

- **Custom date range with a blank bound silently scanned all history.** A missing
  start/end date fell back to `oldest=0`/`latest=now`; the confirm dialog only
  shows a count, so the user could delete far more than intended. Both bounds are
  now required.
- **Reopening the dashboard after a channel switch missed the resume prompt.** The
  resume check ran synchronously before the async channel load set `activeChannel`,
  so it queried job status for the stale channel. It's now chained after the load.
- **Delete button was clickable before the chunked render finished**, so on a large
  result set the queue was built from only the ~50 rendered checkboxes
  (under-deletion). The button/export now enable only when rendering completes, and
  a checkbox toggle mid-render can't enable them early.
- **A second scan didn't cancel the previous render loop**, so a stale
  `requestAnimationFrame` loop kept appending cards indexed into the new results.
  Added a render-generation guard.
- **Scan results weren't cleared after a completed deletion**, so the user could
  re-run a delete against already-deleted messages. The preview now resets on
  completion.
- **Skipped items ("attachment-only" mode with nothing to clean) were reported as
  "successfully deleted"** and inflated the success count. They're now tracked in a
  separate `skipped` stat and reported honestly.
- The "Vibe" theme switcher now also updates `--accent-soft`, so thread badges
  follow the chosen accent instead of staying purple.

`npm test` → **42/42** (added 2 ReDoS regression tests). All JS syntax-checked.

## Unreleased — Functional audit fixes

Data-loss & correctness pass across the scan/delete engine and dashboard.

- **Deletion could be dispatched against the wrong conversation (channel drift).**
  The delete queue was built for the open channel but re-read the *current*
  `activeChannel` at send time, so switching channels while the confirmation modal
  was open could fire the queue at the new channel — including deleting file objects
  by ID (channel-independent). The queue is now pinned to the channel it was built
  against; `startDeletionProcess` aborts if the target changed, and `resetScanResultsUI`
  clears any pending queue. _`content.js`._

- **"Only Delete Attachments" left files behind / deleted the wrong things.** Three
  related fixes: (1) `files.delete` failures — including rate limits — were swallowed
  and the item still counted as success, orphaning the file; the file step now backs
  off and retries the whole item on 429 and marks the item failed if a file survives.
  (2) Caption-less file uploads took the `chat.delete`-only path, leaving the uploaded
  file in Slack's file store; the worker now removes the file objects for these too.
  (3) Turning the toggle on *after* a broad scan full-deleted text-only messages; such
  items are now **skipped**, never destroyed. _`shared-filters.js`, `background.js`._

- **ReDoS guard missed doubly-nested quantified groups** (e.g. `((a+))+`), which could
  stall the service worker on adversarial message text. `isSafeRegex` now rejects them
  (benign nested groups without an inner quantifier are still allowed). _`shared-filters.js`._

- **Custom date range scanned the wrong window near day boundaries.** The start date
  was parsed as UTC midnight while the end date was parsed in local time; both bounds
  are now anchored to local time. _`content.js`._

- **Navigating channels while a delete was paused orphaned the job**, misrouting
  subsequent pause/resume/cancel to the wrong channel. Re-targeting is now refused
  while any job is active. _`content.js`._

- **Hardening:** resume/pause/cancel and the resume-prompt callback now check
  `chrome.runtime.lastError` (no more phantom "Deleting…" state when the worker is
  gone); the completion alert is guarded against double-firing; unset API params are
  omitted instead of being sent as the string `"undefined"`; thread-reply date bounds
  are coerced to numbers with safe defaults. _`content.js`, `background.js`._

## Unreleased — Bug fixes

- **Extension failed to load in Chromium: "'background.scripts' requires manifest
  version of 2 or lower."** MV3 Chromium only accepts `background.service_worker`;
  the `background.scripts` array (intended for Firefox event pages) is rejected and
  blocks loading. Removed `scripts`; the worker loads `shared-filters.js` via
  `importScripts`. _Chrome/Brave/Edge now load cleanly._ Firefox support would need a
  browser-specific manifest (see note below). _`manifest.json`._

- **Token could be lost between scan and delete (deletion silently failed to start).**
  In-memory tokens are cleared when the MV3 service worker idles out (~30s). If that
  happened after a scan, `START_DELETION` (and `RUN_SCAN`/`BG_API_CALL`) returned
  `not_authed` and nothing ran. Added `ensureToken()`, which recovers the token from
  `chrome.storage.session` on demand before those handlers act. _`background.js`._

- **Channel detection hardened (dashboard couldn't find the open conversation).**
  Three fixes:
  - **Works on workspace subdomains, not just `app.slack.com`.** `content_scripts`,
    `host_permissions`, `web_accessible_resources`, the popup's active-tab check,
    and the worker's tab queries now cover `https://*.slack.com/*` (e.g.
    `acme.slack.com`). Origin validation (`isSlackHostname`) accepts any real
    `*.slack.com` subdomain while still rejecting spoofs
    (`app.slack.com.attacker.com`, `evilslack.com`, bare `slack.com`).
  - **More tolerant URL parsing.** `getActiveTeamInfo` recognizes `/client/TEAM`
    with the channel segment optional, and legacy `/messages/CHANNEL` /
    `/archives/CHANNEL` routes; the workspace resolves even when no conversation
    is open.
  - **Fixed a false-positive from the earlier L1 change.** The channel validator
    was `/^[A-Z][A-Z0-9]{7,}$/i`, which wrongly accepted route keywords like
    `activity`. It now requires a real conversation prefix — `/^[CDG][A-Z0-9]{6,}$/i`
    — correctly rejecting `threads`/`activity`/`saved`/`drafts`.
  _`manifest.json`, `content.js`, `popup.js`, `background.js`, `shared-filters.js`._

- **Dashboard stuck on "No Conversation Active".** If the dashboard was opened
  while not inside a specific channel/DM, `activeChannel` stayed null and the
  URL-change handler — gated on `activeChannel &&` — never adopted a channel the
  user clicked afterward, leaving Scan permanently disabled until a reopen.
  `handleUrlChange` now adopts a conversation as soon as the user navigates into
  one, and re-targets only on an actual new conversation (navigating to a
  non-conversation view keeps the current target). Guidance copy updated: no reopen
  needed — clicking a channel is auto-detected. _`content.js`._

- **Stale target channel after close → switch chat → reopen.** When the dashboard
  was closed (not reloaded) and the user navigated to a different chat, reopening
  still showed the previous chat. Cause: the URL observer skips channel-sync while
  the dashboard is hidden, and the reopen path revealed without re-detecting.
  `initDashboard` now re-detects the current chat on reveal (unless a job is
  running/paused, which is channel-scoped), and switching channels now also clears
  the previous chat's scan results — closing a latent safety gap where a delete
  built from stale results would run against the newly-selected channel.
  _`content.js` (`initDashboard`, `handleUrlChange`, new `switchTargetChannel`/`resetScanResultsUI`)._

## Unreleased — Re-audit remediation (round 2)

Fixes for issues found by the second audit, including regressions from round 1.

- **R1 (High, regression) — reverted `use_dynamic_url: true`.** Round 1 added it to
  reduce fingerprinting (M7), but the content script loads its CSS via
  `<link href=getURL('content.css')>` from the page origin; with dynamic URLs that
  request is blocked, so the dashboard would render **unstyled** and the font would
  fail. Fingerprinting via a fixed extension ID is an accepted Low risk. _`manifest.json`._
- **R2 (Medium) — storage write amplification.** The immutable delete queue is now
  persisted **once** to a companion key (`sc_q_<team>_<channel>`); frequent batched
  saves write only the light progress record (`deleteIndex`/`stats`). Previously the
  whole queue was re-serialized every 10 deletions (~O(n²) for large jobs).
  _`background.js` (`saveJobQueue`, `saveJobState`, `clearJobState`, `recoverAllJobs`)._
- **R3 (Low) — concurrent-recovery race.** Reentrancy is now guarded by a
  module-level `processingKeys` set acquired **before** any recovery, and
  `recoverAllJobs` never clobbers a live in-memory job. Two alarm/timeout paths can
  no longer double-recover or double-process an item. _`background.js`._
- **R4 (Low) — documented** that "trim" (preserve-text) intentionally flattens rich
  block formatting to the plain-text fallback. _`background.js`._
- **R5 (Low) — watchdog arming.** No longer polled via `chrome.alarms.get` on every
  step; armed once at start/resume/recovery. _`background.js` (`scheduleNextStep`)._
- **Recovery gap (found during verification) — fixed.** `GET_JOB_STATUS` now
  re-hydrates `activeJobs` from storage if it was lost to a mid-session
  service-worker idle-death, so a paused job's "resume?" prompt is no longer lost
  until the next browser restart. _`background.js`._

`npm test` → **39/39**. All JS syntax-checked; `manifest.json`/`package.json` valid.

## Unreleased — Audit remediation

Fixes from the production audit, in priority order. Severity tags map to the audit.

### Critical

- **C1 — Slack API authentication.** Added `credentials: "include"` to the background
  `fetch` so the first-party `slack.com` `d` session cookie (required alongside the
  `xoxc-` client token) is attached to cross-origin API calls.
  _`background.js` (`slackAPICall`)._
  ⚠️ Verify against live Slack — this is the single change most likely to determine
  whether the extension functions at all.

- **C2 — Throttling architecture.** Replaced per-message `chrome.alarms` scheduling
  (which Chrome clamps to a ~30s floor, making deletion 30–60× slower than the
  configured delay) with accurate `setTimeout` pacing. Alarms now serve only two
  roles: (a) long rate-limit backoffs that must survive a service-worker teardown,
  and (b) a periodic **watchdog** that resumes a job whose `setTimeout` was lost to a
  service-worker idle-death. Added a `_processing` reentrancy lock. _`background.js`._

- **C3 / M2 / M3 — Attachment-mode data loss.** Deletion is now **decision-based**:
  the worker resolves each item's action once at enqueue time via the shared
  `decideItemAction()` (`"trim"` = delete files but keep message text; `"delete"` =
  full delete) and persists that decision plus the text for `trim` items. The content
  script only forwards raw facts (`text`, `files`, `hasAttachments`). "Only Delete
  Attachments (preserve text)" no longer degrades into a full delete after a
  service-worker restart.
  Also fixed `qualifies` so caption-less file uploads (subtype + no text) are kept
  when cleaning attachments, and carried attachment presence into the decision.
  _`content.js` (`startDeletionProcess`), `background.js` (`executeQueue`,
  `saveJobState`), `shared-filters.js` (`qualifies`)._
  - Incidental fix: `saveJobState` now persists the full queue with an **absolute**
    index; the previous slice-with-absolute-index combination caused recovered jobs
    to short-circuit straight to "complete".

- **Safety gate (new, guards the C2 change).** Auto-resume after a service-worker
  death is gated on a memory-only `chrome.storage.session` flag, so a destructive
  delete resumes after an idle-death but **never** silently after a full browser
  restart (the user still confirms). _`background.js` (`markRunning`,
  `isAutoResumeAllowed`)._

### High

- **H1 — Honest scan truncation.** The scan reports a `moreAvailable` signal and
  warns "older messages were NOT examined" when the page-depth limit truncates
  coverage (previously silent). _`content.js` (`runScan`), `background.js`
  (`runScanInBg`)._
- **H2 — Firefox minimum version.** `strict_min_version` `109.0` → `115.0`, where
  `chrome.storage.session` exists. _`manifest.json`._
- **H3 / H4 — Single source of truth + runnable tests.** Extracted
  `qualifies` / `isSafeRegex` / `decideItemAction` / `isSlackHostname` /
  `stringToColor` into **`shared-filters.js`**, loaded by the worker (`importScripts`
  on Chrome, `background.scripts` on Firefox) and `require`d by the tests. Removed the
  dead duplicate logic from `content.js`, deleted the straw-man `startsWith` origin
  test, and added `package.json` + `playwright.config.js` so the suite runs
  (`npm test` → 39/39 dependency-free).
- **H5 — CSV formula injection.** Export prefixes cells beginning with `= + - @`
  (and control chars) with `'`. _`content.js` (CSV export)._

### Medium / Low

- **M1** — `renderScanResults` no longer throws on messages with no `user`.
- **M4** — moved every injected inline `style=` attribute out of the content-script
  dashboard into `content.css` (ID selectors + `sc-`-prefixed companion classes).
  An external stylesheet is not subject to the host page's CSP `style-src`, so the
  UI can't be silently broken by a strict Slack CSP. _`content.js`, `content.css`._
- **M5** — `Escape` dismisses the topmost open modal (alert/confirm/verify) via the
  real cancel/OK handler.
- **M6** — content-script message listener returns `false` (all responses are
  synchronous); worker listener returns `true` only from async branches.
- **M7** — `web_accessible_resources` now use `use_dynamic_url: true`, so
  `app.slack.com` can't fingerprint the fixed extension ID by probing a static
  resource URL. _`manifest.json`._
- **M8** — privacy policy now discloses that author user IDs (and, only for
  "preserve text" edits, the message text) are persisted in queue state, and
  corrects the "no message content on disk" claim. _`PRIVACY_POLICY.md`._
- **L1** — widened the channel-ID validation regex for longer modern Slack IDs.
- **L2** — user-name cache init cap raised 2 → 5 pages (`MAX_USER_CACHE_PAGES`,
  ~5,000 members) so larger workspaces resolve more names. _`content.js`._
- **L3** — progress-ring math uses the `CIRCLE_CIRCUMFERENCE` constant.
- **L5** — popup replaces its single 150ms post-injection delay with a bounded
  readiness poll (`pollWorkspaceInfo`), fixing flaky connects on slow machines.
  _`popup.js`._

### C4 — partial (transparency)

The extension still reads Slack's private `xoxc-` client token from `localStorage`;
that mechanism is unchanged and remains a **Terms-of-Service / store-policy decision**
(official OAuth vs. shipping as an explicitly unofficial tool). What changed: the
first-run onboarding now clearly states the tool is independent/not affiliated with
Slack, uses your existing login session, and that deletions are permanent.
_`popup.html`._

### Tests

- Added `tests/onboarding.spec.js` (Playwright E2E) covering the first-run
  onboarding show → dismiss → stays-dismissed flow and the C4 disclosure text.
- Added 5 `decideItemAction` unit tests. `npm test` → **39/39** dependency-free.

### Packaging note

Exclude `tests/`, `package.json`, `playwright.config.js`, `CHANGELOG.md`, and
`.agents/` from the store submission zip.
