# Changelog

## Unreleased

### Sixth pass: UI consistency audit — dashboard theming was silently broken

Found and fixed the root cause behind why the five non-Slack dashboards
(Reddit, X, Mastodon, Teams, Telegram) never looked quite right: their shared
`platforms/shared/dashboard-base.css` defined every design token (surface and
text colors, borders, radii, the brand gradient) under a `:host { ... }`
selector, copied from Slack's `content.css`, where it correctly scopes tokens
to a shadow root. These five pages are plain top-level documents with no
shadow root, so `:host` matched nothing and every `var(--surface)`,
`var(--text-primary)`, etc. silently resolved to nothing — leaving buttons
with no fill, no border, and no radius (icon + black text only), and panel
cards with no visible background at all. Verified via computed-style
inspection (`getComputedStyle` reported `--surface` as `""` before, `"#ffffff"`
after) rather than trusting pixel screenshots, since this sandbox's headless
Chromium renders `backdrop-filter` unreliably. Fixed by changing `:host` to
`:root` (the two occurrences, base + dark-mode block) — the same token values
now apply correctly, matching Slack's already-working implementation exactly.

Smaller consistency fixes found alongside it:
- Primary buttons that set their own brand-colored background inline
  (Telegram's four auth-step buttons, Mastodon's connect button) silently lost
  their hover feedback, since an inline `background` always wins over a
  stylesheet's `:hover` rule for the same property. `.btn-primary:hover` now
  brightens via `filter` instead of swapping `background`, which works
  regardless of how the base color was set.
- Telegram's four auth buttons hardcoded the same gradient via a duplicated
  inline `style=""` attribute; extracted into a `.btn-telegram` class.
- Telegram's dashboard "connected as" indicator used a different tag,
  font-size, color, and layout position than the same element on the other
  four platforms; aligned to match.
- X's username-mismatch warning hardcoded `#ef4444`, duplicating the
  `--color-red` token by coincidence; now references the token directly.

Reverified throughout: lint clean, 244/244 unit tests pass, 21/21 Playwright
e2e pass (three of which needed a `chrome.permissions.contains` stub added
alongside their existing `chrome.permissions.request` stub, since production
code now re-checks the former immediately before opening a dashboard tab).

### Fifth audit pass: cross-platform correctness and safety fixes

A fresh audit split across all six platforms plus the permission/manifest layer
found no Critical issues (no path to deleting another user's content or
leaking a credential), but turned up several real correctness bugs, most
notably on the newer non-Slack platforms. Reverified throughout: lint clean,
244/244 unit tests pass (34 new, covering every fix below).

- **Reddit & X: delete "success" was judged by HTTP status alone**, never the
  response body — a 200 with a body-level error (common for GraphQL
  mutations) was counted as a successful delete while the content stayed
  live. Both platforms now parse and validate the response body before
  counting an item as deleted.
- **Slack: "Discard Progress" could leave the dashboard stuck believing a job
  was still running.** It fired `CANCEL_DELETION` with no callback, unlike
  every other job-control call; a lost message or no-matching-job response
  left `isRunning`/`isPaused` stuck true until a page reload. Now routed
  through the same `sendJobControl()` path as every other control action, and
  always resets local state regardless of the outcome.
- **Telegram: a transient `getEntity()` failure on a channel/supergroup could
  make delete silently no-op while still reporting success.** Now retries
  with backoff before giving up, and treats persistent failure as a hard
  per-item failure instead of guessing the wrong delete method. The
  post-delete summary wording was also softened to not overstate verification
  Telegram's API genuinely can't provide. Separately, a wrong SMS
  code/2FA-password error was being cleared before the browser ever painted
  it, making a rejected login look like a silent hang; the error now survives
  until a real step transition.
- **Teams: the "is this my message" identity was computed once at page load**
  and never rechecked, so a mid-session token refresh from a different signed-
  in Teams identity could leave the filter running against stale identity
  data. The run now aborts with a clear message if the identity changes
  mid-session.
- **X: the username field was free text**, editable after connect with no
  check against the authenticated account, allowing another account's tweets
  to be scanned/displayed. Delete is now blocked with a warning when the
  field doesn't match the authenticated account.
- **Reddit & X: no circuit breaker for sustained rate-limiting** — a
  persistent 429 just kept retrying per item across an entire batch. Both now
  abort early with a clear message after repeated consecutive rate-limit
  failures, matching the existing expired-auth abort pattern.
- Smaller hardening: Mastodon's instance-URL validation is now duplicated
  inside `connect-mastodon.js` itself (defense-in-depth, not just relying on
  the popup layer); popup.js now revokes a just-granted permission when
  `connect()` fails and re-checks it immediately before opening a dashboard
  tab; background.js now server-side clamps `throttleDelay` and defaults a
  corrupted queue entry's action to the safer `trim` instead of `delete`;
  `shared-filters.js`'s regex-safety counter no longer over-counts literal
  quantifier characters inside `[...]` character classes, and `stringToColor()`
  no longer throws on non-string input.

### Fourth follow-up pass: the two remaining maintainability-only refactors

The audit's last two open findings were pure maintainability refactors (no bug,
no UX change) against the two largest, most safety-critical functions in the
codebase — content.js's `setupUIListeners` and background.js's `executeQueue`/
`runScanInBg`. Confirmed via diff review that each is a purely mechanical
extraction (identical logic, only regrouped), and reverified throughout: lint
clean, 207/207 unit tests pass (2 new, directly exercising the riskiest
extraction), 21/21 Playwright e2e pass, Firefox validation 0 errors, both store
packages build.

- **content.js's 358-line `setupUIListeners`** split into nine per-concern
  functions (`setupHeaderControls`, `setupFilterControls`,
  `setupScanDeleteControls`, `setupSelectAllControl`, `setupPresetControls`,
  `setupConsoleControls`, `setupVerifyModalControls`, `setupThemeControls`,
  `setupKeyboardNav`), called in the same order from a now-9-line
  `setupUIListeners`. No behavior change.
- **background.js's `runScanInBg`** had its thread-reply pagination loop
  (conversations.replies, its own nested pagination + per-reply qualifies()
  loop — the single most deeply-nested piece of the scan) extracted into
  `expandThreadReplies()`, mutating the same `results`/`seenTs` references and
  returning `{ capped, threadsTruncated }` for the caller to act on exactly as
  it did inline.
- **background.js's `executeQueue`** had its two remaining un-extracted pieces
  (the rest of its error-branch dispatch was already split out into
  `handleRateLimitBackoff`/`pauseJobForFatalError` by a prior pass) pulled out
  to match: `executeQueueItem(job, msg, action)` performs the actual
  chat.update/chat.delete/skip call, and `handleTransientError(job, key, msg,
  response)` mirrors the existing handler pattern — returning `true` when a
  retry was scheduled (caller must return without advancing) or `false` once
  retries are exhausted. Two new tests in `tests/background.test.js` drive this
  end-to-end (a transient failure that retries then succeeds, and one that
  exhausts `MAX_TRANSIENT_RETRIES` and is counted as a genuine failure) — this
  exact path had only ever been covered for streak *persistence* across a
  simulated restart, never for the retry-then-give-up behavior itself.

### Third follow-up pass: remaining Medium/Low findings, X identity resolution, and a real [hidden] bug found along the way

Closed out the rest of the two prior passes' findings (X/Teams identity, the plain-text-filter labeling gap, empty-state/copy polish, `runScanInBg`'s partial-result discard, `queueKeyFor`'s parsing fragility, and a lightweight activity log for the five non-Slack dashboards) rather than leaving them as "nice to have." Reverified throughout: lint clean, 205/205 unit tests pass (~50 new, across 4 new test files), 21/21 Playwright e2e pass, Firefox validation 0 errors, both store packages build.

- **A real, previously-undiscovered bug, found via manually verifying the new activity log:** `.dashboard-btn`'s own `display: flex` has the same CSS specificity as the browser's default `[hidden] { display: none }` rule and loads later in the cascade, so it silently won — `armCancelButton`/`resetCancelButton` set `cancelBtn.hidden` via the boolean DOM attribute, so the Cancel button stayed visibly rendered (though non-functional) on all five non-Slack dashboards at every point it was supposed to be hidden, including on first page load before any delete had ever run. Fixed with an explicit `[hidden] { display: none !important; }` rule in `dashboard-base.css`, with a packaging-test regression guard.
- **X now resolves and displays its own username** instead of asking the user to recall and retype it every session — `connectX()` calls the stable legacy `account/verify_credentials.json` endpoint (best-effort; failure never blocks connecting) and stores it non-sensitively for the dashboard to pre-fill, mirroring Reddit. Teams gets an equivalent "Connected as" label decoded from AAD claims already present in its captured JWT (`preferred_username`/`upn`/`unique_name`/`name`), with `getOwnUserId`/`getOwnDisplayIdentity` hoisted to module scope and unit-tested for the first time.
- **The five non-Slack dashboards' "Text Filter" field no longer shares Slack's regex-capable label** — it was identical wording on a field that's always plain-substring, so a user who'd learned Slack's `/regex/` convention would reasonably try it elsewhere and get silently wrong results. New `dashTextMatchPlain` label spells out "plain text, no /regex/" instead.
- **A lightweight, collapsed-by-default Activity Log** added to the shared non-Slack dashboard base (`initActivityLog`/`logActivity` in `dashboard-fetch-utils.js`), logging scan/delete start, completion, cancellation, and failure across all five platforms — troubleshooting no longer relies solely on transient `alert()` popups, closer to (though intentionally simpler than) Slack's own live execution console.
- **`runScanInBg` no longer discards every already-gathered page when a rate limit is too long to safely wait on mid-scan** — it now returns the partial results with `moreAvailable: true` (reusing the existing "not all messages were scanned" UI path) instead of throwing and forcing an expensive full re-scan.
- **`queueKeyFor`'s key parsing hardened**: a new `parseJobKey()` validates that a `slack_state_<teamId>_<channelId>` key's parts actually look like real Slack IDs (alphanumeric) before trusting positional `split("_")` indices, rather than only checking the part count.
- **Content.js's `/regex/` convention is now documented in the UI itself**, not just the README, via a caption under Slack's Text Match field. The filter-depth gap between Slack's rich filters and the other five platforms' single keyword field is now disclosed in-app too, and Slack's own copy ("Deletion Filter Matrix" → "Filters", "Critical Action Verification" → "Confirm Deletion") was simplified to match the plainer tone the other five dashboards already used.
- **Empty-state messages on all five non-Slack dashboards now suggest a next step** ("try widening your filters"/"enable Deep Scan"/"pick a different chat"), matching Slack's own pattern instead of just restating "nothing found." The bulk-delete confirmation dialogs now visually emphasize the item count (a real DOM `<strong>`, not just prose) the way Slack's own dedicated count element already did, and a `dashCancelNoResumeHint` tooltip on the shared Cancel button clarifies it's a full stop, not a pause (unlike Slack's Start/Pause/Resume cycle). X's stale-query-ID error wording was simplified for a non-technical reader and no longer implies the user did something wrong.
- **New test coverage**: `tests/reddit-dashboard.test.js` (Reddit's per-page item-extraction/filtering logic, previously the only non-Slack platform with zero dedicated tests), `tests/teams-dashboard.test.js` (JWT claim decoding), `tests/telegram-utils.test.js` (the flood-wait cancellation fix from the prior pass, split into its own dependency-free module so it's unit-tested instead of only reachable through a live MTProto client), and a `parseJobKey` case added to `tests/background.test.js`.

### Second follow-up audit pass: correctness bugs, accessibility, and cross-platform UX consistency

A fresh three-pass audit (correctness/data-safety re-verification, a first dedicated
usability pass, and code quality/test coverage) found three genuine bugs plus a set of
accessibility and UX consistency gaps the prior, safety-focused audit rounds hadn't
covered. All findings below were fixed and reverified: lint clean, 148/148 unit tests
pass (4 new), 20/20 Playwright e2e pass, Firefox validation 0 errors, both store
packages build.

#### Bugs

- **Resuming a rate-limited Slack job could instantly re-pause with a false message.**
  `job._rateLimitRetries`/`_transientRetries` were only ever reset when an item fully
  resolved, never on a manual `RESUME_DELETION` — a job that auto-paused at
  `MAX_RATELIMIT_RETRIES` could hit the same ceiling after a single additional retry
  post-resume and re-pause, logging a stale "paused after 20 retries" message that no
  longer reflected what had actually happened since Resume. `background.js`.
- **Telegram's Cancel button didn't interrupt a mid-flood-wait retry** — the same bug
  class already fixed for Mastodon, missed on Telegram. `invokeWithFloodWait()` now
  accepts a `cancelController` and ticks its sleep in ≤1s steps (mirroring Mastodon's
  `runCancelableWait`), throwing a distinguishable `FloodWaitCancelledError` the delete
  loop treats as a clean cancellation rather than a failed chunk.
  `platforms/telegram/telegram-dashboard.src.js`.
- **The delete-confirmation box told users to type the wrong thing.** On Reddit, X,
  Mastodon, Teams, and Telegram, deleting more than `LARGE_DELETE_THRESHOLD` items asks
  for the exact count, but the input's own placeholder unconditionally read "Type
  DELETE to confirm" — a user who typed the most-visible instruction in the dialog got
  an unconditional "Deletion cancelled." `confirmBulkDelete()` now computes the
  placeholder from `isLarge` the same way the prompt body already does; new
  `dashVerifyInputPlaceholderCount` locale key across all four languages.
  `platforms/shared/dashboard-fetch-utils.js`.

#### Accessibility

- **The platform picker was entirely mouse-only** — a keyboard/screen-reader user
  could not reach or activate Slack/Reddit/X/Mastodon/Teams/Telegram at all, on every
  visit. Rows now carry `role="button"`, `tabindex`, an `aria-label`, and Enter/Space
  activation; disabled ("coming soon") rows are focusable-excluded like a native
  disabled control. `popup.js`, `popup.css`.
- **First-run onboarding plus the full platform list could overflow the popup with no
  scrollbar** (`body { overflow: hidden }`, no `max-height`), risking an undismissable
  onboarding card. `body` now caps at `max-height: 580px` with `overflow-y: auto`.
  `popup.css`.
- **No focus trap or consistent Escape handling in the five non-Slack dashboards'
  custom modals** — a keyboard user could Tab out of an open alert/confirm/prompt into
  the still-interactive page behind it, and Escape only worked on `showPrompt`, not
  `showAlert`/`showConfirm`. `ensureModalHost()` now installs the same trap/Escape
  keydown handling content.js's Slack dashboard already has for its shadow-root modals.
  `platforms/shared/dashboard-fetch-utils.js`.
- **Form labels weren't linked to their inputs on any of the five non-Slack
  dashboards** — zero `for`/`id` pairs existed, so a screen reader announced nothing
  meaningful on focus. Added matching `for`/`id` attributes across all five.

#### UX consistency

- **Mastodon's connect form gave zero guidance on generating a Personal Access
  Token** — likely the highest-friction onboarding step of the five optional
  platforms. Added an inline hint (new `popupMastodonTokenHint` locale key) describing
  the instance's own Settings → Development → New application flow.
  `popup/platform-registry.js`, `popup.js`.
- **Telegram's `my.telegram.org` reference was plain text**, not a link, with no
  explanation of the app-creation step that follows. Now a real link plus a short
  parenthetical (new `telegramPopupHintApp` key). `popup.html`.
- **Teams' "sign in, then reopen the popup" instruction was styled as an error** (red
  `.error-text`) even though it's a normal step 2 of 2, not a failure.
  `connectTeams()` now returns a `pending: true` flag; `showPlatformConnectError()`
  takes an `isHint` option rendering it as a neutral `.notice-text` note instead.
  `platforms/teams/connect-teams.js`, `popup.js`, `popup.css`.
- **No warning that closing a non-Slack tab mid-delete is unrecoverable**, unlike
  Slack's resumable job. `armCancelButton`/`resetCancelButton` (already called at
  exactly the right two moments by all five dashboards) now arm/disarm a
  `beforeunload` warning in lockstep with the Cancel button.
  `platforms/shared/dashboard-fetch-utils.js`.

#### Correctness/quality

- **The 300-char `MAX_REGEX_INPUT` ReDoS backstop could silently under-match ordinary
  long messages with no indication anything was skipped.** `qualifies()` now accepts an
  optional `options.truncationStats` counter (backward compatible — no-op for every
  other caller); `background.js`'s scan loop populates it and reports
  `regexTruncatedCount` back to the dashboard, which now logs a warning when it's
  nonzero. `shared-filters.js`, `background.js`, `content.js`.
- Removed a stale `fileShareCount` ESLint global (the export it referenced no longer
  exists) and a redundant `tests/unit.spec.js` (a Playwright-runner duplicate of
  `tests/unit.test.js`'s more thorough coverage of the same `qualifies()` behavior).
- `popup.js`'s `isSlackClientTab` — a hostname-spoof check forked from
  `shared-filters.js`'s `isSlackHostname()` because `popup.html` can't load that file —
  previously had no sync comment and was never run against the existing spoof-battery
  tests. Now exported for Node, with a new `tests/popup.test.js` asserting it agrees
  with `isSlackHostname()` across the full spoof battery. `content.js`'s equivalent
  `stringToColor()` fork (cosmetic, avatar color) got the same "keep in sync" comment
  already used for its neighboring `isSafeRegexPreview()` fork.

### Same pass, continued: the two remaining High-severity code-quality findings

The prior pass above deliberately left its two largest, highest-risk findings for a
dedicated follow-up rather than bundling risky restructuring into the same set of
surgical fixes. Both are now done: content.js gained real unit coverage for its pure
logic, and the ~400-line bulk-delete loop duplicated (and already drifting) across
Reddit/Mastodon/Teams/X is now one shared, independently-tested implementation.
Reverified afterward: lint clean, 176/176 unit tests pass (28 new, across 2 new test
files), 20/20 Playwright e2e pass, Firefox validation 0 errors, both store packages
build. The delete-loop refactor was additionally verified with real-browser
integration runs (mocked `fetch`) driving Reddit, Mastodon, and Teams' actual dashboard
pages through clean/partial-failure/expired-auth/cancel scenarios, not just the
extracted function's own unit tests.

- **content.js test coverage.** Three pure, previously-untested pieces of the Slack
  dashboard's scan/delete flow were hoisted to module scope (mirroring the existing
  `matchesActiveWorkspaceChannel`/`isSafeRegexPreview` pattern) and are now covered by
  17 new tests in `tests/content.test.js`: `computeScanTimeRange` (the actual "how much
  history gets swept" arithmetic behind the date-range filter, previously inline in
  `runScan` with zero coverage), `csvSafe`/`buildMessagesCsv` (the CSV export's
  formula-injection defense, previously a closure inside a click handler), and
  `buildDeleteQueueFromIndices` (the SC-BUG-03 stale-index guard protecting against a
  scan-results swap between scan and delete). No behavior changed — each call site now
  calls the hoisted function instead of its old inline equivalent.
- **Shared `runDeleteLoop()`.** Extracted the bulk-delete loop skeleton (cancel-check,
  progress-marker persistence, live progress text, per-item try/catch with
  `expiredAuth` fail-fast, inter-item pacing) into `platforms/shared/dashboard-fetch-
  utils.js`, used by Reddit/Mastodon/Teams/X. Deliberately NOT shared: what happens
  after the loop (status-text wording, auth-invalid messaging, X's extra
  query-id-staleness reporting) — those differ enough per platform that forcing them
  through one template would cost more clarity than the line-count win is worth.
  Two behavior-preservation details worth calling out since they'd otherwise look like
  bugs on a fresh read: the per-item pacing delay fires after every completed item
  *including the last one* (matching all four originals — none special-cased "is this
  the last item"), and a fatal (non-per-item) exception mid-run — e.g. the extension
  context invalidated by a reload — still reports accurate partial progress via a
  `deleteLoopProgress` property attached to the rethrown error, rather than silently
  losing how far the run got. Covered by 11 new tests in
  `tests/dashboard-fetch-utils.test.js` against a minimal in-memory
  `chrome.storage.local` mock. Telegram was NOT moved onto this shared loop — its
  MTProto batch/channel-entity-resolution shape genuinely doesn't fit it.
  `tests/packaging.test.js`'s existing "live failure counts" check now also asserts
  each of the four callers actually calls `runDeleteLoop`.

### Follow-up audit pass: ReDoS backstop, Slack engine parity, cross-platform consistency

A fresh audit (four parallel passes: Slack's `background.js` engine, `content.js`/
`shared-filters.js`, the five non-Slack dashboards, and popup/manifest/i18n/docs)
independently re-verified the prior pass's fixes rather than trusting the changelog, and
found the two highest-stakes gaps below plus a set of smaller correctness/parity issues.
All findings were fixed and reverified: lint clean (0 warnings), 144/144 unit tests pass
(35 new), both store packages build.

#### Critical — ReDoS guard was bypassable with an ordinary ~4000-char message, not just adversarial input

`isSafeRegex()`'s pattern-shape heuristic (this is its ~4th patch) still classified
`/a*[ab]{4}a*b/` as safe, but running it against one Slack-message-limit-length string
took over 10 seconds on the single-threaded background worker — no crafted input
required. Rather than patch the heuristic again, `shared-filters.js`'s `MAX_REGEX_INPUT`
backstop (previously 20000, sized for an assumed-quadratic worst case) is now a
measured, deterministic 300 characters: the same repro now completes in ~6ms. Static
pattern-shape detection can't cover every ReDoS shape, so this length cap is the actual
safety boundary now, not the heuristic.

#### Critical — `privacy.html` contradicted the code and the other privacy docs

It stated Reddit/X/Mastodon/Teams/Telegram credentials are stored in
`chrome.storage.local`; the code (and `PRIVACY_POLICY.md`/`SECURITY.md`, which already
had this fix) puts all five in `chrome.storage.session` (memory-only). This is the
document that ships to store reviewers, so the stale claim was corrected to match.

#### High — Slack's own delete/scan engine hadn't received two fixes already applied to the other five platforms

The rate-limit retry counter (`_rateLimitRetries`) lived only in memory, so a service-
worker restart during a long `Retry-After` wait silently reset it — a persistently-
throttled item could retry forever without ever pausing. It's now persisted across
`saveJobState`/`recoverAllJobs`. Separately, structural Slack errors
(`not_allowed_token_type`, `missing_scope`, `channel_not_found`, etc.) were treated as
ordinary per-item failures instead of stopping the queue immediately, unlike the
fail-fast fix already shipped for Mastodon/Reddit/Teams — now Slack's queue fails fast
on these too, and a distinct locale-keyed message reports fatal permission/access errors
separately from an invalid-session message. The scan path's own uncapped rate-limit wait
(no `chrome.alarms` fallback, unlike the delete queue) now fails fast past the same
threshold instead of risking a silently dropped `RUN_SCAN` response.

#### High — per-platform parity gaps

Mastodon's cancel button didn't actually interrupt a mid-rate-limit-wait, contrary to
its own changelog entry. X and Telegram never got the "fail fast on an expired/revoked
credential" fix Mastodon/Reddit/Teams already had — both now stop immediately with
reconnect guidance instead of retrying every remaining item. Teams' first-connect tab
opened active, blurring/closing the popup before its "sign in, then click the icon
again" instruction could be seen; it now opens inactive with a `chrome.storage.session`
fallback that redisplays the hint on popup reopen. Telegram's popup login flow
(phone/code/2FA) had zero i18n despite everything else being localized — 33 new keys
added across `en`/`de`/`es`/`fr`, verified identical key sets across all four.

#### Medium/Low — smaller correctness and consistency fixes

Silent regex-rejection fallback now warns the user instead of quietly matching nothing;
text filters now also search attachment preview/fallback/title text, not just files;
`START_DELETION` now refuses to silently overwrite an existing *paused* job (surfaced a
related pre-existing bug in the same area: some pause paths never cleared `isRunning`,
fixed alongside it); `SET_SESSION` now awaits its storage write and reports failure
instead of always claiming success; Telegram's live progress now shows failure counts
and uses the shared safety module (`reportInterruptedDelete`/`renderEmptyState`/
`maybeSaveDeleteProgress`) instead of duplicating it; X's pagination now dedups by
tweet id and stops instead of re-fetching a stale cursor; the previously dead
`showConfirm()` helper is now wired into a real "Stop this deletion?" confirmation
shared by all five non-Slack dashboards; Reddit/X/Mastodon connect-time error strings
and the platform-list `aria-label` are now localized; `README.md`'s manifest-loading
table no longer omits `teams-webrequest.js`; the saved-filter-preset cap is now enforced
post-hoc (trims oldest-first) rather than only pre-checked.

### Cross-platform audit remediation

A four-pass audit (Slack core re-audit, the five non-Slack platforms, security/privacy,
and UX/store readiness) found the Slack engine in good shape after ~10 prior passes, but
the six-platform expansion itself carrying most of the real risk. Fixes below, grouped by
theme; all four passes' findings are addressed.

#### Critical — credentials for Telegram, Mastodon, Teams, Reddit, and X moved to session-only storage

Every one of the five non-Slack platforms' credentials was being written to
`chrome.storage.local` (disk-persisted, survives a browser restart) — most acutely
Telegram's full MTProto session string (a standing, unrevoked login with no password/2FA
gate of its own) and Mastodon's personal access token, but also Teams' Bearer JWT and the
lower-severity Reddit modhash / X CSRF token. This directly contradicted the product's
own headline security claim for Slack ("the token lives only in `chrome.storage.session`
and is never written to disk"). All five now follow the same rule: the credential itself
is memory-only (cleared on browser close); only non-sensitive labels (username, instance
URL, API base URL, Telegram's app-identifying `api_id`/`api_hash`) persist to disk for
reconnect convenience. `platforms/{telegram,mastodon,teams,reddit,x}/{connect-*.js,
dashboard-*.js}`, `platforms/teams/teams-webrequest.js`. New packaging test
(`tests/packaging.test.js`) asserts none of the five ever touches `storage.local` for its
credential, mirroring the existing Slack-token test.

#### Critical — no per-item selection on any of the five non-Slack dashboards

A scan's results were previously all-or-nothing: every matched item got deleted with no
way to review and uncheck specific ones, unlike Slack's own dashboard. Added a shared
"Select All" control + per-row checkboxes to `platforms/shared/dashboard-fetch-utils.js`
(`resetSelection`/`renderSelectAllControl`/`addRowCheckbox`/`wireSelectAll`/
`getSelectedItems`), wired into all five dashboards. Anything scanned but left unchecked,
or selected but not yet reached because a cancel interrupted the run, stays visible with
fresh checkboxes rather than being silently discarded.

#### High — no pause/cancel on any of the five non-Slack dashboards

Once a delete started, the only way to stop it was closing the tab. Added a shared cancel
controller (`createCancelController`/`armCancelButton`/`resetCancelButton`) and a Cancel
button to every non-Slack dashboard; each delete loop checks it between items (or, for
Mastodon, also mid-rate-limit-wait) and reports "Cancelled: N of M processed" rather than
either running to completion or leaving no trace of what happened.

#### High — native `alert`/`confirm`/`prompt` replaced with the existing custom modal system

Every dashboard but Slack's fell back to bare browser dialogs — a visual break from the
themed UI, and a real dead end: both Chrome and Firefox offer "Prevent this page from
creating additional dialogs" after a couple of native prompts in a row, which would
silently disable the type-to-confirm delete safety gate with no fallback. Reused
content.js's existing modal markup/CSS/i18n-key pattern (`sc-alert-modal`,
`sc-confirm-modal`, `sc-prompt-modal`) via new `showAlert`/`showConfirm`/`showPrompt`
helpers in `dashboard-fetch-utils.js`, built lazily so no platform's HTML has to
hand-author it. `confirmBulkDelete()` is now async and uses these instead of native
`prompt`/`alert`.

#### High — i18n: the five non-Slack dashboards translated; Slack core engine reentrancy guard; Telegram bugs

- All five non-Slack dashboards' static labels/buttons/placeholders now carry
  `data-i18n`/`data-i18n-ph` attributes, reusing Slack-dashboard locale keys wherever text
  matches (e.g. `dashScan`, `dashCancel`, `dashSelectAll`, the alert/confirm/prompt modal
  keys) and adding ~28 new keys, translated into Spanish/French/German, for the rest.
  `dashboard-fetch-utils.js` carries its own `t()`/`localizeI18n()` (same pattern as
  popup.js/content.js). New packaging tests assert every `data-i18n`/`t()` key used across
  the five platforms resolves, and that all four locale files share exactly the same key
  set (previously unchecked). Scope decision, stated plainly rather than left implicit:
  Slack's live execution-log narration remains English-only, as it already was.
- **Telegram's text filter meant something different from every other platform.**
  `messages.Search`'s `q` parameter is Telegram's own word-based server-side search, not
  the case-insensitive substring match every other dashboard does locally — same UI
  label, silently different semantics. Now always searches with an empty query and
  filters locally, matching everyone else. `platforms/telegram/telegram-dashboard.src.js`.
- **Telegram bypassed the shared safety/utility module entirely**, duplicating the
  type-DELETE confirmation threshold and progress-reporting logic inline instead of using
  `dashboard-fetch-utils.js` — a drift risk if the shared threshold/copy ever changes.
  `dashboard-telegram.html` now loads it, and the duplicated logic is gone.
- **A reachable `eval()` sat inside the Telegram webpack bundle**, via a transitive
  `vm-browserify` polyfill pulled in by a crypto dependency's `asn1.js`. CSP already
  blocked it (caught by the library's own try/catch, falling back to a safe path) — but
  that safety rested on an incidental catch rather than this codebase's own no-eval
  design. `webpack.telegram.config.js` now explicitly disables the `vm` polyfill
  (`resolve.fallback.vm: false`), so the dependency's non-eval fallback is deterministic
  and the `eval` call is no longer bundled at all. Verified: `runInThisContext` no longer
  appears as a callable in the built bundle. Running the real AMO validator
  (`npm run validate:firefox`) surfaced two more eval-adjacent constructs the static
  audit hadn't scoped in, both webpack/polyfill artifacts rather than teleproto itself:
  webpack's own `new Function('return this')()` global-object detection (disabled via
  `output.environment.globalThis: true`, since a Manifest V3 page can assume `globalThis`
  exists) and the `function-bind` package's dead ES5 polyfill branch, built the same way
  (aliased to a shim exporting only the native `Function.prototype.bind` — see
  `platforms/telegram/function-bind-shim.js`). One inert reference remains and is
  considered acceptable: `get-intrinsic` (a load-bearing transitive dependency of the
  crypto stack) holds `eval` as a *value* in an introspection lookup table, never calling
  it — the validator's warning count dropped from 7 to 2 (0 errors throughout), with the
  same warning duplicated across both Telegram bundles.
  Also fixed the one other warning the same validator run caught: an `UNSAFE_VAR_ASSIGNMENT`
  in `dashboard-teams.js` from building an `<option>` via a template-literal `innerHTML`
  assignment — replaced with `createElement`/`textContent`.
- **A second tab open on the same Slack channel could silently orphan a running delete
  job.** `START_DELETION` had no reentrancy guard (unlike scans' `inFlightScans`), so a
  second tab's click replaced `activeJobs[key]` out from under the first job — which
  stopped cleanly (the identity check already caught this) but left its remaining items
  abandoned with the UI still showing "Deleting…" and no error. `background.js` now
  refuses a second `START_DELETION` for an already-running key; `content.js` surfaces a
  clear "Already Running" message instead of a generic error.

#### Medium — expired/invalid credentials failed slowly instead of failing fast

Mastodon, Reddit, and Teams treated an expired/revoked credential as an ordinary per-item
failure, retrying every remaining item at the platform's full pacing delay only to fail
the same way each time, with no reconnect guidance (Teams' own 403 handling already did
this correctly — its 401 path didn't). All three now detect an auth failure specifically,
stop the run immediately, and tell the user to reconnect. `platforms/{mastodon,reddit,
teams}/dashboard-*.js`.

#### Medium — progress-reporting inconsistency across platforms

X and Telegram showed live failure counts during a delete run; Teams, Reddit, and
Mastodon only revealed them in the final summary — a symptom of the delete-loop tail
being duplicated rather than shared. Unified to the richer format everywhere.

#### Documentation — six-platform scope extended to every doc that lagged behind

`PRIVACY_POLICY.md`, `privacy.html`, `SECURITY.md`, `README.md`, `TERMS.md`,
`package.json`, `CWS_SUBMISSION_FIELDS.md`, `AMO_SUBMISSION_FIELDS.md`, and
`STORE_LISTING.md` all had Slack-only language, permission justifications, or trademark
disclaimers left over from before the multi-platform expansion — despite the manifest
requesting `cookies`/`webRequest` and five more host-permission patterns for platforms
none of these documents disclosed. All updated to describe the current reality,
including the credential-storage change above. `extensionDescription` (the Chrome/AMO
listing summary) now names all six platforms and stays within Chrome's 132-character
manifest limit in every locale (new packaging test). Small wording fixes: Mastodon's
"log in" → "connect" (matches its actual token-paste flow), the onboarding-seen storage
key renamed from `slack_onboarding_complete` to `erasechat_onboarding_complete` (with a
migration for existing installs), and `privacy.html`'s trademark footer now names all six
platforms' owners instead of only Slack's.

#### Removed Bluesky platform support

Bluesky was the only platform requiring a separate, externally-hosted OAuth
`client_id` metadata document (AT Protocol's discoverable-client spec requires the
`client_id` URL's path to be exactly `/oauth-client-metadata.json` at the origin
root — GitHub Pages project sites can't serve that without a second repo or a custom
domain). Rather than maintain a second repo just for this one platform, Bluesky support
is dropped entirely: `platforms/bluesky/` (popup/dashboard source, bundles, and the
`client-metadata.json` reference copy), its `scripts/build-bluesky.js` esbuild step, its
`popup/platform-registry.js` entry and `popup.js`/`popup.html`/`popup.css` view wiring,
its `identity` optional permission (unused by every other platform), its
`@atproto/api`/`@atproto/oauth-client-browser` dependencies, its three
`tests/platform-connect.spec.js` e2e tests, and every mention across the locales,
`PRIVACY_POLICY.md`, `privacy.html`, and the store submission docs. The extension is now
a six-platform tool: Slack plus optional Reddit, X, Mastodon, Microsoft Teams, and
Telegram. The external `bulk-clean-oauth` GitHub Pages repo this depended on is no longer
referenced by the extension.

Four filter/UX additions on top of the 1.0.0 safety model, none of which touch the
delete path itself: two are new scan-time qualification options in the single shared
decision function, one is a client-side convenience, one is translation.

#### Skip Pinned Messages, on by default (`shared-filters.js`, `background.js`, `content.js`)

`qualifies()` dropped Slack's pin *notification* subtypes (`pinned_item`/`unpinned_item`)
but had no opinion on a message that is itself currently pinned — a filter matching on
date or keyword could delete something the user deliberately kept. `qualifies()` now
takes an `options` object (`{ invertText, excludePinned }`) and, when `excludePinned` is
set, drops any message with a non-empty `pinned_to`. Wired through as a toggle in the
Deletion Filter Matrix, **checked by default** (opt-out, not opt-in) — the one new control
here that defaults to the more cautious behavior rather than the previous one.

#### Invert Text Match: "delete everything EXCEPT matches" (`shared-filters.js`, `content.js`)

The Text Match / `/regex/` filter only ever meant "delete if it matches." An inline
"Invert" checkbox under the field flips that to "keep if it matches, delete the rest,"
without hand-rolling a negative-lookahead regex. The existing empty-string-match guard
(a degenerate pattern like `/.*/` selects NOTHING rather than the whole channel) had to
be generalized rather than just reused: naively inverting "matches nothing" would have
meant "delete everything," reintroducing the exact mass-over-delete failure that guard
exists to prevent. The qualification logic now computes match + degenerate as two
separate signals, and a degenerate pattern short-circuits to "select nothing" in EITHER
mode before the invert flag is even consulted.

#### Saved Filter Presets (`content.js`)

The full filter form (sender, date mode, text/invert, threads, attachments, skip-pinned,
delay) can be named and saved to `chrome.storage.local`, then reloaded from a dropdown —
useful for a recurring cleanup ("older than 90 days, no attachments") that previously
needed re-entering every time. Capped at 20 saved presets so the habit can't grow storage
without bound. Naming a preset uses a new lightweight custom prompt modal
(`sc-prompt-modal`), added to match the existing non-blocking alert/confirm modal pattern
(and wired into the same Escape/Tab focus-trap handling) rather than reaching for a
blocking native `window.prompt()`.

#### Additional locales: Spanish, French, German (`_locales/{es,fr,de}/messages.json`)

Translations of every `data-i18n` / `__MSG_` string used in the popup and dashboard.
`manifest.json`'s `default_locale: "en"` and Chrome's automatic `_locales/<dir>` discovery
mean no manifest change was needed — dropping in the new directories is sufficient, and
`scripts/build.sh` already ships the whole `_locales` tree.

#### Renamed to "Erasechat" (was "Bulk Clean for Slack")

With six optional platforms now alongside Slack, a "for Slack" name no longer fit.
Applied across both manifests, `_locales` (including the German/Spanish/French
translations — the name itself is left untranslated, as is normal for a product name),
the dashboard/popup UI (title, onboarding text, permission-grant hint), README,
PRIVACY_POLICY, SECURITY, TERMS, CONTRIBUTING, AUDIT_PROMPT, store listing docs,
`package.json` (including `package-lock.json`), the build script and its output zip
names (`dist/erasechat-{chrome,firefox}-<version>.zip`), export filenames
(`erasechat_log_…` / `erasechat_messages_…`), the saved-filter-presets storage key
(`erasechatFilterPresets` — safe to change pre-launch since no build has shipped to a
real user yet), and test file headers. Left unchanged, deliberately: the Bluesky OAuth
`CLIENT_ID` / `client_uri` URLs (`bulk-clean-oauth` on GitHub Pages — a live registered
OAuth client; renaming it would break Bluesky login until re-registered) and the
historical `bulk-clean-for-<platform>` comments crediting the standalone repos each
platform module was ported from (those repos are real and keep their own names).

## 1.0.0 — 2026-07-31

First public release, targeting the Chrome Web Store and Firefox AMO.

Bulk-deletes and cleans your own Slack messages in the conversation you have open, with
filters (sender, date range, text/`/regex/`, attachments-only, thread replies), a
scan-and-preview step before anything is destroyed, and a resumable background delete
queue that survives service-worker termination.

Because the tool permanently deletes user data, the safety posture is the headline:
scan/delete run off one shared decision function (`shared-filters.js`), the queue is
pinned to the channel it was built against, navigating away auto-pauses, deletes over 100
messages require typing `DELETE`, and a ReDoS guard keeps a user-supplied regex from
freezing the worker. The Slack token lives only in `chrome.storage.session` and is never
written to disk. No data leaves the browser.

Validated at release: lint clean · 84/84 unit + packaging tests · 12/12 Playwright e2e ·
both store packages build · `addons-linter@10` fully clean on the Firefox zip (0 errors,
0 warnings, 0 notices) · Chrome packs a valid `.crx`.

> Not yet verified at release: the live-Slack `credentials: "include"` cookie flow cannot
> be exercised offline. Confirm a real scan + small delete on a throwaway workspace in both
> browsers before publishing — see `store-assets/SUBMISSION_CHECKLIST.md`.

The sections below are the development passes that produced 1.0.0, newest first. All of
them ship in this release.

### Production-readiness pass: restricted site access, scan pile-up, release plumbing

Three findings from reviewing the shipping build as a product rather than as code: one
state where the extension appeared installed but could do nothing and said the wrong
thing about it, one way a user could unknowingly double their own rate-limit pressure,
and the irreversible step (publishing) having no guard rails.

#### The extension could be installed, inert, and give wrong advice (`popup.js`, `popup.html`)

Declaring a host permission is not the same as having it. Chrome lets a user set an
extension's *Site access* to "On click" or "On specific sites" — a setting a
delete-my-messages tool invites — and Firefox MV3 can leave host permissions awaiting
opt-in. In that state the content script never auto-injects, and the
`chrome.scripting.executeScript` fallback is refused too.

The popup handled that failure by showing **"Setup Required — Please reload the Slack
page"**, which never fixes it: reloading cannot grant a permission. The user is told to
do the one thing guaranteed not to work, with no mention of the actual cause.

- The popup now checks `chrome.permissions.contains()` before it promises anything, and
  a refused injection re-checks rather than assuming a stale content script.
- Not-granted routes to a third state that names the cause and offers
  `chrome.permissions.request()` from the click (a real user gesture). If the browser
  declines to prompt — Chrome reserves that for its own UI on *required* host
  permissions — the manual "allow site access" steps appear instead of a dead end.
- `permissions.request` does not exist at all on Firefox for Android, so it is
  feature-detected: where it is missing the button is hidden and the manual steps show
  immediately, rather than offering a control that cannot work. (This briefly produced
  two `ANDROID_INCOMPATIBLE_API` validator warnings; raising `strict_min_version` to
  `142.0` — see below — cleared both, and the detection stays because it is correct
  behavior regardless of what the linter can see.)
- Detection deliberately fails **open**. It is a diagnostic, not a security boundary —
  the browser's permission model is the actual enforcement — so a browser that cannot
  answer the question must never be shown a wall it has no way to dismiss.

#### A retried scan doubled the API load that made it slow (`background.js`, `content.js`)

A scan is read-only but by far the most API-expensive operation here: up to 20 history
pages plus a paginated `conversations.replies` sweep per thread, all drawing on one
workspace rate limit. The dashboard gives up after 2 minutes and told the user to *"run
the scan again"* — while the worker kept paginating. On a heavily throttled channel (the
only case slow enough to hit that timeout) the retry started a second full sweep
concurrently, competing with the first for the very rate limit that caused the timeout.

- `RUN_SCAN` now refuses a duplicate sweep of a conversation already being scanned,
  answering `scan_in_progress` without issuing a single API call. The guard is
  per-conversation, so unrelated channels still scan concurrently.
- It is released **before** the response is sent, and on the failure path as well as the
  success path — a leaked guard would be worse than no guard, making that conversation
  permanently unscannable until the worker was torn down.
- The timeout copy no longer claims the scan stopped, because the timeout does not know
  that. It says what is actually true (suspended, or still working) and that re-scanning
  is safe: a scan still running now reports itself instead of piling on.
- Scan failures other than truncation used to log to a console panel the user may not
  have open; they now surface as an alert, and include `error` when there is no `message`
  (previously such failures logged "Unknown error").

#### Publishing had no guard rails (`.github/workflows/ci.yml`, `scripts/set-version.sh`)

Both stores refuse a version number that has already been uploaded, so a bad release
costs a whole version to undo — yet releasing was entirely manual, with the version
living in three files that had to be edited in lockstep.

- A `v*` tag now publishes both store zips to a GitHub Release, reusing the artifact the
  gate already verified rather than rebuilding, so what ships is bit-for-bit what passed.
- The release job `needs: verify` and refuses a tag that disagrees with the packaged
  version: a release cannot carry untested or mislabelled packages by construction.
- Write access is scoped to that job alone. The job that executes third-party code (npm
  dependencies, browser downloads) stays read-only.
- `npm run version:set <version>` rewrites both manifests, `package.json` and the
  lockfile together, validating against Chrome's version rules (segment ≤ 65535, no
  leading zeros) before touching anything.
- Dependabot now watches the dev toolchain and the workflow actions. Nothing here ships
  to users — the extension has no runtime dependencies — so these only affect the gate.

#### `main` had no protection, and no way to buy it (`.githooks/pre-push`)

GitHub gates *both* classic branch protection and rulesets behind a paid plan for private
repositories, so the "your main branch isn't protected" prompt in the UI points at a
feature this repo cannot enable — there is no setting to change. `main` was therefore one
mistyped `--force` away from losing history, on the branch the release workflow builds
from.

A `pre-push` hook now stands in locally, recreating the three rules that matter: no
force-push to `main` (detected as a non-fast-forward via `merge-base --is-ancestor`, not
by parsing flags), no deletion of `main`, and no push to `main` unless lint and the test
suite pass. Where the remote's tip is an object the clone has never seen it blocks and
asks for a `git fetch` rather than guessing — that is precisely the state in which a push
silently discards someone else's commits.

Enable per clone with `npm run hooks:install` (`core.hooksPath`, so the hook is
version-controlled rather than hidden in `.git/hooks`). `SC_PREPUSH_FULL=1 git push` runs
the entire gate instead of the fast half.

This is **advisory, not enforcement**, and the docs say so plainly: `--no-verify` bypasses
it, a fresh clone has no hooks until installed, and it cannot police another machine.
Making the repo public or upgrading the plan remains the only way to get rules the server
enforces. A packaging test asserts the hook still exists, is still executable (git ignores
a non-executable hook silently) and still covers all three rules — otherwise it would
fail open with nothing to indicate `main` had become unguarded.

#### AMO validator warnings: 4 → 1, and a stale support promise (`manifest.firefox.json`)

`strict_min_version` was `115.0`, below the floor for two things the build actually uses.
That produced four validator warnings, but the warnings were the symptom — the real
problem was a support claim the package could not honor.

Raised to `142.0`, which clears **all four** and leaves the validator completely clean:
0 errors, 0 warnings, 0 notices.

Getting there took measuring rather than reasoning. Six manifest variants were built and
linted: `115` (4 warnings), `115 + gecko_android` (3), `140` (1), `141` (1), `142` (0),
and `140` with the disclosure removed (1 — it merely swaps in
`MISSING_DATA_COLLECTION_PERMISSIONS`, so that is a dead end). The deciding detail is that
`data_collection_permissions` landed on desktop in 140 but on Firefox for **Android** in
142, and with `gecko_android` absent the validator derives the Android floor from the same
`strict_min_version` — so 142 is the first clean value.

This reverses the earlier note that keeping `115.0` was the better trade. That reasoning
was written when 140 was new; it has since gone stale. **Firefox 115 ESR reached
end-of-life in March 2026 and 140 is now the current ESR**, so `115.0` was advertising
support on a browser that no longer receives security patches — a poor promise for a tool
that handles a live Slack session token. Raising the floor now costs almost nothing and
matches the live ESR baseline.

**This has a real cost, recorded here so it is a decision and not an accident:** 142
excludes Firefox 140–141, and 140 is the current ESR. Users pinned to ESR 140 — typically
enterprise deployments, plausibly a chunk of the audience for a workplace tool — cannot
install this build. Reverting to `140.0` buys them back at the price of one warning, and
warnings never block a submission.

The other route to zero — declaring `gecko_android` — was **rejected**. Mozilla's docs are
explicit that this key is how AMO decides Android compatibility: *"If you don't, AMO
assumes that the extension is not compatible with Android and does not list it as
available on Android."* Declaring it would put the dashboard in front of phone users, and
the dashboard is a fixed 880×760 multi-panel modal whose only `@media` rules are
`prefers-color-scheme` and `prefers-reduced-motion` — no viewport breakpoints at all. The
version bump costs some users an install; `gecko_android` would have shipped a
knowingly-broken UI. Between the two ways to silence a validator, the one that never
hands anyone something broken wins.

A test pins all three properties — the version floor, the absence of `gecko_android`, and
the `permissions.request` feature detection — with the trade-off written into the test's
own comment so the next person to "optimise" the minimum version sees what it costs. Each
was mutation-tested.

#### The release gate was flaky under load (`playwright.config.js`)

Three e2e specs failed during a verify run, then all twelve passed unchanged moments
later. The cause was contention, not code: every extension spec launches a *headful*
Chromium via `launchPersistentContext`, and Playwright's default worker count (cores/2)
is tuned for headless pages, so under load the browsers starved each other.

A gate that fails for reasons unrelated to the code is worse than a slow one — it trains
you to re-run until green, which is how a real failure eventually gets waved through on a
tool that permanently deletes data. Pinned to `workers: 2` (suite still runs in ~7s),
with one retry on CI only so an infrastructure hiccup does not block a release while a
local flake still has to be looked at. `forbidOnly` on CI stops a stray `test.only` from
silently shrinking the gate to one test while still reporting green.

#### Test-gate fixes

- **The background harness could not exercise the message router at all.** Its `vm`
  sandbox omitted the `URL` global, so `isSlackHostname()` threw internally, its
  `try/catch` swallowed it, and *every* message was rejected as `unauthorized_origin` —
  a false negative that would have silently passed off any router test as failing. Fixed
  by providing the global the worker actually has.
- Added coverage for the scan guard (concurrent refusal, per-channel independence,
  release after both success and failure) and the permission gate (fail-open,
  state exclusivity, the Android no-`request` path, and injection-failure routing).
- New gates on the parts that used to fail only in a store queue: every `data-i18n*`
  attribute and `t()` key across the popup, dashboard and privacy page must resolve to a
  real locale key (runtime localization no manifest check can see), and the release job
  must keep its `needs: verify`, tag-match and least-privilege properties.
- Each new gate was mutation-tested — the guard removed, the assertion confirmed to fail
  — so none of them is decorative.

### Production-readiness pass: cross-browser load safety, store gates, CI

Closed the two defects that would each have blocked or broken a release, bounded the
last unbounded loop in the scan engine, and put every release gate behind `npm` scripts
plus CI so the same class of problem fails locally instead of in a review queue.

#### Critical — Firefox build was inert (`background.js`)

- **`chrome.runtime.onSuspend` is Chrome-only and was called unguarded.** Firefox has
  never implemented it, so `chrome.runtime.onSuspend.addListener(...)` threw a
  `TypeError` at load — aborting `background.js` *before* the `chrome.runtime.onMessage`
  router was registered. Every scan, delete, pause and resume goes through that router,
  so the Firefox extension installed cleanly and then did nothing at all: the popup
  could only ever report "Setup Required". Now feature-detected. Nothing is lost on
  Firefox — every state transition already persists eagerly through `saveJobState()`,
  so the listener was only ever a best-effort extra flush.

#### Store validation — pinned the AMO validator, and why the manifest is unchanged

- **`npm run validate:firefox` now pins `addons-linter@^10`** (the version AMO runs).
  This matters more than it looks: older `addons-linter@7` treats
  `browser_specific_settings.gecko.data_collection_permissions` as a **hard error**
  (`DATA_COLLECTION_PERMISSIONS_PROP_RESERVED`), while v10 requires that exact key and
  warns when it is **missing** (`MISSING_DATA_COLLECTION_PERMISSIONS`). An unpinned
  validator therefore gives opposite verdicts on the same zip, and following the wrong one
  removes a disclosure AMO now expects from new listings. Verified against the real
  packages: with the key present, v10 reports **0 errors**.
- **`strict_min_version` stays at `115.0`** and the disclosure stays in the manifest. That
  combination emits two `KEY_FIREFOX_*_UNSUPPORTED_BY_MIN_VERSION` warnings, which say
  only that the key is inert before Firefox 140 / Firefox-for-Android 142 — older Firefox
  ignores unknown manifest keys. The alternative (raising the floor to 140) would drop
  Firefox 115–139 users to silence a cosmetic warning, and omitting the key entirely is
  the riskier warning for a new submission. Both trade-offs are now documented in
  `store-assets/SUBMISSION_CHECKLIST.md` rather than left to be rediscovered.
- `tests/packaging.test.js` pins the disclosure to `{"required": ["none"]}`, so the
  manifest can no longer drift away from the "collects nothing" promise in
  `PRIVACY_POLICY.md`, `privacy.html` and both store listings.

#### Medium — unbounded thread pagination in the scan engine (`background.js`)

- **`conversations.replies` paged with no cap.** The history sweep was bounded by
  `MAX_SCAN_PAGES`, but the per-thread reply loop followed `next_cursor` indefinitely.
  One pathological thread could spin API calls without limit — burning the workspace's
  rate limit and continuing long after the content script's own 120 s scan timeout had
  already told the user the scan failed. Added `MAX_THREAD_PAGES = 10` ×
  `THREAD_PAGE_LIMIT = 200` (2,000 replies per thread, far above any real thread), and
  hitting the cap now sets the existing `moreAvailable` flag, so the UI reports the
  partial coverage honestly instead of implying the thread was fully examined.

#### Low — code hygiene (`content.js`)

- Four named constants were declared and then ignored in favor of duplicated inline
  literals (`CONSOLE_LOG_MAX_LINES`, `RENDER_CHUNK_SIZE`, `USER_CACHE_TTL_MS`,
  `URL_POLL_INTERVAL_MS`) — the pattern where tuning the constant silently changes
  nothing. Now actually used.
- Normalized one `chrome.runtime.lastError` read to the `void` idiom used elsewhere.

#### Tests — 52 → 73, and they were verified to fail without the fixes

- **`tests/background.test.js` (new).** Loads `shared-filters.js` + `background.js` into
  a `vm` context with a mocked `chrome` API, which makes two previously-untestable things
  testable: (a) **load safety under a Firefox-shaped API surface** — the regression above
  is now caught by a test rather than by a user, and (b) the **real scan engine**
  (`runScanInBg`) driven against a stubbed Slack API. Covers the thread-page cap, the
  history-page cap, truncation reporting, out-of-window thread replies never being
  queued, `thread_broadcast` deduplication, unset-param omission, and 429/`Retry-After`
  handling.
- **`tests/packaging.test.js` (new).** The checks that otherwise only fail in a store
  review queue: the AMO data-collection disclosure present and set to "none", version
  parity across both manifests and `package.json`, correct per-browser background wiring
  and `shared-filters.js` load path, every manifest-referenced file present on disk *and*
  shipped by `build.sh`, all `__MSG_` placeholders resolvable, minimal permissions,
  Slack-only host/content-script/resource matches, remote-code-free CSP, and no token
  written to `storage.local`.
- Both new suites were validated by reverting each fix and confirming the corresponding
  test fails, so they are regression guards rather than decoration.
- `npm test` now runs **all** `tests/*.test.js` (it previously ran only `unit.test.js`,
  so new suites would have been silently skipped).

#### Tooling

- **Lint gate:** `eslint.config.mjs` + `npm run lint`, scoped to correctness rules only
  (`no-undef` above all — there is no bundler or type checker to catch a typo'd global in
  extension code). Style is deliberately not enforced. Currently **clean, zero warnings**.
- **`npm run verify`** runs the whole release gate: lint → unit/packaging → e2e → build →
  `addons-linter`. **`npm run validate:firefox`** runs the AMO validator alone.
- **CI** (`.github/workflows/ci.yml`) runs every gate on push/PR (e2e under `xvfb` since
  extensions cannot load headless) and uploads both store zips as artifacts.
- Added `engines.node >= 20.19.0` (the floor ESLint 10 and the test runner's glob support
  actually require); dev dependencies report **0 vulnerabilities**. The shipped extension
  still has **no runtime dependencies**.

#### Validation

- `npm run lint` clean · **73/73** unit + packaging tests green · **7/7** Playwright e2e
  green (including loading the unpacked extension) · both packages build ·
  `addons-linter@10` reports **0 errors** on the Firefox zip (2 expected
  `KEY_FIREFOX_*_UNSUPPORTED_BY_MIN_VERSION` warnings, explained above).
- ⚠️ Still outstanding and **unchanged** by this pass: the `credentials: "include"`
  cookie flow cannot be exercised offline, so a real scan + small delete on a live
  throwaway Slack workspace remains a hard pre-submission blocker in both browsers. See
  `store-assets/SUBMISSION_CHECKLIST.md`.

### Release prep: rename + store packaging

Prepared the extension for Chrome Web Store and Firefox AMO submission.

- **Renamed to "Bulk Clean for Slack"** (was "SlackClean Premium"). Leading with "Slack"
  and using "Premium" (for a free MIT tool) were rejection/trademark risks; the new name
  follows Slack's sanctioned "X for Slack" form. Applied across both manifests, `_locales`,
  the dashboard/popup UI (header, badge → "for Slack", onboarding, titles, export
  filenames), README, PRIVACY_POLICY, SECURITY, STORE_LISTING, `package.json`, the build
  script, and tests. Internal identifiers (storage keys, DOM ids) were left unchanged.
- **Project docs added:** `LICENSE` (MIT © 2026 Yogesh Bhatt), `README.md`, `SECURITY.md`,
  `TERMS.md`, `CONTRIBUTING.md`.
- **In-extension privacy page** `privacy.html` (styled, CSP-safe) — the popup links to it
  instead of the raw `.md`; it ships in the package.
- **Build pipeline:** `scripts/build.sh` (`npm run build`) produces store-ready
  `dist/bulk-clean-for-slack-{chrome,firefox}-<version>.zip` with the correct manifest
  per target and only runtime files. `dist/` is gitignored.
- **Store submission aids:** `store-assets/SUBMISSION_CHECKLIST.md`, Chrome data-use
  disclosure answers + Firefox notes in `STORE_LISTING.md`, and a 440×280 promo tile
  (`store-assets/promo/`).
- **Validated:** Chrome packs a valid `.crx`; `addons-linter` reports **0 errors** on the
  Firefox zip. **52/52** unit tests green.
- ⚠️ **Follow-ups (outside code):** re-capture store screenshots (current ones show the old
  branding), host the privacy policy at a public URL, and verify a real delete on live
  Slack before submitting. See `store-assets/SUBMISSION_CHECKLIST.md`.

### Fifth functional pass (ReDoS, over-select, drift, Firefox, lifecycle)

Fifth audit pass (four parallel deep-traces + runnable repros). Fixes below.

#### High — filter safety (`shared-filters.js`)

- **ReDoS guard defeated — a user regex could freeze the whole scan.** The last-line
  quantifier-COUNT cap (`MAX_QUANTIFIERS = 10`) let sequential unbounded quantifiers
  through: `a*a*a*…b` has no groups and no adjacent quantifiers, so it slipped every
  structural rule, yet backtracks polynomially (degree = number of stars). Measured:
  6 stars = 739 ms and 7 stars = 4.2 s on a 40-char run; 10 stars = a multi-minute
  hang. Added `MAX_UNBOUNDED_QUANTIFIERS = 2` (counts `*`, `+`, open `{n,}`), which
  rejects the chain while still accepting legitimate `\d+\.\d+`-style filters; plus a
  `MAX_REGEX_INPUT` cap on the text a safe regex actually runs against as a backstop.
- **A regex that matches the empty string silently selected the ENTIRE channel.**
  `/a?/`, `/x*/`, `/^/`, `/.*/`, `/(secret)?/` all made `qualifies()` return true for
  every message → mass over-selection from a mistyped filter. A degenerate
  empty-matching pattern now selects **nothing** (the user sees 0 results and fixes it)
  instead of everything.
- **System messages that carry text were not dropped.** `channel_join` / `channel_leave`
  / `channel_topic` etc. all have `text` ("<@U> has joined"), so the `!msg.text` drop
  proxy leaked them into a "delete all my messages" run (inflating the fail tally, and
  over-deleting any subtype Slack lets you delete). Now dropped by an explicit
  `SYSTEM_MESSAGE_SUBTYPES` allowlist regardless of text; content-bearing subtypes
  (`me_message`, `thread_broadcast`, `file_share`, …) are preserved.
- **"me" mode failed OPEN when the user id was missing.** `undefined !== undefined`
  let a user-less bot/integration message qualify as "mine"; now fails closed.

#### High — channel drift (`content.js`)

- **A channel switch DURING a scan defeated the drift guard.** `activeChannel` is
  reassigned only after an await, so a scan started in channel A that finished as the
  user switched to B passed the "channel changed" check (it still saw A) and showed
  A's results armed against B — dispatching a delete for B with A's timestamps, which
  reported false "success" while A was left uncleaned. Results are now tagged with the
  channel they were scanned in (`scanResultsChannelId`) and the guard also checks a
  synchronously-updated `intendedChannelId`; `startDeletionProcess` refuses to dispatch
  unless both still match the active channel.

#### Medium — lifecycle & robustness (`background.js`, `content.js`)

- **Extension update stranded a running job + span the watchdog forever.** `onInstalled`
  now force-pauses running jobs like `onStartup` (session storage — and the resume
  gate — is cleared on update), so the job doesn't show "running" while never advancing.
- **Attachment mode failed an item permanently on one file-op blip.** A transient
  `files.info`/`files.delete` error now retries like any other transient error instead
  of counting as an immediate permanent failure.
- **A dropped scan response hung the UI on "Scanning…" forever.** Added a client-side
  scan timeout that restores the UI and prompts a retry (an abandoned scan is read-only).
- **Token-loss / session-invalidation discarded all progress.** Both fatal auth paths
  now **pause** (preserving queue + progress) instead of deleting the job, matching the
  "re-open to reconnect, then resume" guidance.
- **Cancel/Close were fire-and-forget.** Both now check `chrome.runtime.lastError` and
  tell the user to retry (rather than claiming the job stopped) if the message didn't
  reach the worker.
- **A stale/replaced job could destroy or resurrect a new one.** `executeQueue`'s
  cancellation guard now compares job object identity (not mere key presence); the file
  sub-loop re-checks before each destructive call; `handleRateLimitBackoff` no longer
  re-persists a cancelled job.
- **A black-holed request could pin the queue lock.** Added a `fetch` AbortController
  timeout (surfaces as a retryable `network_error`).
- **Wrong-workspace resolution.** `getActiveTeamInfo` now returns null (rather than
  silently using the first workspace) when the URL names a team we have no token for.
- **Non-numeric date bounds** are normalized to the open bound (was NaN → inconsistent
  partial selection). `CIRCLE_CIRCUMFERENCE` uses the exact `2πr`. `popup.js` uses the
  existing i18n key for its fallback workspace label.

#### Cross-browser — Firefox (`manifest.json`, new `manifest.firefox.json`)

- **The extension was entirely non-functional on Firefox.** `manifest.json` advertised
  Firefox (gecko, min 115) but declared a `service_worker` background — unsupported on
  Firefox stable — with no `background.scripts`, so `shared-filters.js` never loaded and
  every message handler threw. Split into two manifests: **`manifest.json` (Chromium,
  `service_worker` + `importScripts`)** and **`manifest.firefox.json` (Firefox, event
  page with `background.scripts: ["shared-filters.js", "background.js"]` + gecko)**. The
  misleading in-code comments are corrected. The Firefox manifest also declares
  `browser_specific_settings.gecko.data_collection_permissions: { required: ["none"] }`
  (no data collected — required by AMO for new submissions).
  **Packaging:** Chrome build → use `manifest.json`, exclude `manifest.firefox.json`.
  Firefox (AMO) build → copy `manifest.firefox.json` to `manifest.json`, exclude the
  Chrome `manifest.json`.

`npm test` → **52/52** (5 new regression tests). Manifests validated: Chrome packs a
valid `.crx` with no manifest error (`google-chrome --pack-extension`); `addons-linter`
(Firefox/AMO) reports **0 errors** on the Firefox build (only benign notices that the
data-collection key activates on Firefox 140+ while we still support 115+ ESR).

### Data-loss scope, workspace switching & scan completeness

Fourth functional pass. Focused audit of the delete/keep decision, scan↔delete
consistency, and job lifecycle, plus the fixes below.

#### High — data-loss scope (`shared-filters.js`, `background.js`)

- **A clean could delete files that were shared in OTHER conversations, breaking
  the "current chat scope" promise.** `files.delete` purges a file from Slack
  *entirely* — every channel/DM it was ever shared into — so cleaning one channel
  silently removed files that also lived elsewhere. The engine now looks up each
  file's live share count (`files.info`) before deleting and **hard-deletes only
  files that exist in exactly one place**; a file shared elsewhere is left intact
  and logged (a full delete still removes the message, a trim keeps the text). An
  unverifiable share count is treated conservatively — never hard-deleted. New pure
  `fileShareCount()` in `shared-filters.js`, covered by unit tests.

#### Medium — correctness (`background.js`, `content.js`)

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

#### Low — UI / copy (`content.js`, `_locales/en/messages.json`)

- **"Only Delete Attachments" copy oversold text preservation.** A caption-less
  attachment/blocks-only message is fully deleted (nothing to preserve); the toggle
  subtitle now says so.
- **Delete button stayed enabled during a scan** — now disabled at scan start until
  fresh results finish rendering (was guarded by an empty-queue check, but sloppy).
- **"Select All" toggled mid-render** left later cards checked regardless; new cards
  now follow the live Select-All state.

`npm test` → **47/47** (5 new `fileShareCount` tests). All four JS files
syntax-checked; `messages.json` valid.

### Deletion completeness & internationalization

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

### Deep audit fixes (engine safety, resumption & UI state)

Third functional pass. Two independent code reviews of the delete engine and the
content-script UI, cross-checked against the code and unit tests.

#### Critical / High — deletion engine (`background.js`)

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

#### High — ReDoS (`shared-filters.js`)

- **`isSafeRegex` admitted catastrophic quantifier chains** (`a?a?…a?aaaa`,
  `a*a*…b`) that have no groups/adjacent quantifiers and slipped past every
  structural rule — hanging the single-threaded service worker. Added a
  quantifier-count cap (escaped metacharacters excluded). New unit tests cover it.

#### Medium — content-script UI/state (`content.js`)

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

### Functional audit fixes

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

### Bug fixes

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

### Re-audit remediation (round 2)

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

### Audit remediation

Fixes from the production audit, in priority order. Severity tags map to the audit.

#### Critical

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

#### High

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

#### Medium / Low

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

#### C4 — partial (transparency)

The extension still reads Slack's private `xoxc-` client token from `localStorage`;
that mechanism is unchanged and remains a **Terms-of-Service / store-policy decision**
(official OAuth vs. shipping as an explicitly unofficial tool). What changed: the
first-run onboarding now clearly states the tool is independent/not affiliated with
Slack, uses your existing login session, and that deletions are permanent.
_`popup.html`._

#### Tests

- Added `tests/onboarding.spec.js` (Playwright E2E) covering the first-run
  onboarding show → dismiss → stays-dismissed flow and the C4 disclosure text.
- Added 5 `decideItemAction` unit tests. `npm test` → **39/39** dependency-free.

#### Packaging note

Exclude `tests/`, `package.json`, `playwright.config.js`, `CHANGELOG.md`, and
`.agents/` from the store submission zip.
