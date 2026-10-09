# Erasechat — Full Audit Report (2026-10-09)

Scope: the whole extension — Slack core (`background.js`, `content.js`, `shared-filters.js`),
the five platform modules under `platforms/`, popup, manifests, locales, store docs,
build/CI, security/privacy, UI/accessibility, and a competitive/product review.

Method: six parallel read-only audit passes (Slack core · platforms · popup/manifest/store ·
security & privacy · UI/UX & accessibility · competitor research). Every finding listed as
**Fixed** was re-verified against the source before it was changed; regex/logic issues were
reproduced with `node`. After the fixes: `node --test` → **245/245 pass** (one new test),
`eslint .` → **0 problems**, Telegram bundle rebuilt.

Legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low · ❓ needs live verification (depends on a
third-party API's real behaviour that can't be confirmed offline).

---

## 1. Executive summary

Erasechat's foundation is strong: every platform credential lives in memory-only
`chrome.storage.session`; there's no `externally_connectable`, no remote code, a strict CSP,
no telemetry, all API text is rendered with `textContent`, and the Slack engine is a
resumable background job with rate-limit handling that is better than most competitors.

This pass found **2 critical bugs** — one product-breaking, one safety-breaking — plus a
cluster of high/medium correctness, accessibility and documentation issues. **26 groups of
issues were fixed in this pass** (section 2). Section 3 lists what remains open, and section
5 is the roadmap to make Erasechat the best tool in its category.

| Area | Fixed now | Still open |
|---|---|---|
| Safety / correctness | 18 | 14 |
| Security / privacy | 5 | 5 |
| UI / accessibility | 9 | ~20 (mostly polish + i18n) |
| Store / docs / build | 4 | 7 |

---

## 2. Fixed in this pass

### 🔴 Critical

1. **Telegram could delete *other people's* messages for everyone by default.**
   The previous audit removed the `fromId: InputPeerSelf` scan filter, so a scan of a DM
   returned both sides, every row was pre-selected with no author shown, and delete uses
   `revoke: true`. One "Select All → Delete" erased the other person's side of the chat.
   *Fix:* new **"Only my messages"** toggle (on by default) restores the self-only filter;
   when turned off, every row shows **You / Someone else** and only your own messages start
   selected. — `platforms/telegram/telegram-dashboard.src.js`, `dashboard-telegram.html`,
   `platforms/shared/dashboard-fetch-utils.js` (`resetSelection` gained an optional
   pre-select predicate).

2. **Microsoft Teams could never connect for a first-time user.**
   `popup.js` revoked the just-granted permission whenever `connect()` returned
   `ok:false` — including Teams' normal `{ok:false, pending:true}` "open Teams, then reopen"
   step. The `webRequest` listener lost its permission before it could capture the token,
   so every retry looped. *Fix:* pending results no longer revoke. — `popup.js`

### 🟠 High

3. **A failed Reddit connect silently un-granted X's `cookies` permission** (API
   permissions are global and shared). Revocation now keeps any API permission still needed
   by another platform whose origins are granted. — `popup.js`
4. **Slack: Resume after re-login kept using the revoked token** → instant re-pause loop.
   Resume now re-reads the current token, and `SET_SESSION` updates every job of that
   workspace. — `background.js`
5. **ReDoS guard bypass** — wrapping a dangerous group in another group (`((a|a))+$`,
   `(?:(a|a))+`, `((\w|\d))+!`, `((a+)b)+`) passed every check; `((a|a))+$` on 27 chars took
   ~10 s and could hang the Slack service worker (stalling all running jobs). Added a
   paren-depth structural check (`hasQuantifiedRiskyGroup`). — `shared-filters.js`
6. **X: live GraphQL query-ID extraction could never succeed.** Bundles on `abs.twimg.com`
   were fetched with `credentials:'include'`, which CORS rejects against a wildcard ACAO, so
   X always ran on hardcoded IDs that go stale. Now `credentials:'omit'`; the
   "features cannot be null" 400 is also recognised as a stale-signature error. ❓ confirm
   live. — `platforms/x/dashboard-x.js`
7. **X: typing in the username box re-enabled Delete mid-scan/mid-delete** (could start a
   second concurrent delete loop) and "scan @other → retype own handle" armed Delete on the
   other account's results. Added a `busy` guard and bound results to the scanned handle.
8. **Teams: the bare-host capture stored only the origin**, dropping the
   `/api/chatsvc/<region>` prefix → every call 404'd. Now stores the full prefix before
   `/v1/users/ME`, https-only. ❓ confirm live. — `platforms/teams/teams-webrequest.js`
9. **Teams on Firefox: listener registration threw** on the Chrome-only `extraHeaders`
   option (with `.done` already set, so it never retried). Now falls back to
   `["requestHeaders"]`. ❓ confirm in Firefox.
10. **Third-party license notices were stripped from store zips** (`build.sh` deleted
    `*.bundle.js.LICENSE.txt`, which holds teleproto/polyfill MIT notices). Now shipped.
11. **Store reviewer notes were false** ("no build step", "only network calls are to
    slack.com") — corrected in `store-assets/AMO_SUBMISSION_FIELDS.md` and
    `CWS_SUBMISSION_FIELDS.md`; this could have caused an AMO rejection.

### 🟡 Medium

12. **Slack: every custom-range scan with threads showed "Not all messages were scanned"**
    (`lookbackCutoff > 0` is always true). Now a one-call probe checks whether older history
    actually exists; the narrow "replies under threads older than the 30-day lookback" case
    is a separate, accurately-worded log note. — `background.js`, `content.js`
13. **Slack: rate-limit backoff ignored after a service-worker restart** — `nextRunAt` is
    now persisted and restored, so the watchdog no longer retries before Retry-After.
14. **Slack: pausing while the last item was in flight left the UI stuck on "Resume"** for a
    job that no longer existed. Completion now clears `isPaused`.
15. **Slack: regex preview warning had drifted from the real check** (accepted
    `(foo|bar){1,3}` that the worker rejects → silent zero matches). `shared-filters.js` is now
    loaded into the Slack content script and the preview delegates to the real
    `isSafeRegex`. — both manifests, `content.js`
16. **Security: `BG_API_CALL` proxied *any* Slack endpoint with the user's token.** Now an
    allowlist (`users.list`, `users.info`, `conversations.info`); the unused `GET_SESSION`
    handler that returned the raw token was removed. New test added.
17. **Security: loading a saved preset could silently switch sender to "All Messages"**
    (others' messages). Presets may narrow to "me" but never widen to "all".
18. **Mastodon & Teams ignored the shared 429 circuit breaker's `rateLimited` result** —
    reported "finished with N failures" when most items were never attempted. Added the
    proper branch (matches Reddit/X).
19. **Mastodon & Teams burned hours on guaranteed 403 failures** (read-only token / org
    policy). New shared 403 circuit breaker (3 in a row → stop with a clear message).
20. **Mastodon pacing reset on every run**, so cancel-and-restart blasted 30 more deletes
    into an already-full window. Timestamps now persist for the tab's lifetime.
21. **Teams sent the bearer token to any `nextLink` URL.** Now restricted to the captured
    Teams origin.
22. **Preview rows on all five platform dashboards were unstyled** (`.post-item`,
    `.post-time`, `.badge` were never defined). Added a shared row style.
23. **Platform dashboard modal was double-centred** (flex + `top:50%`/`translateY`), pushing
    the bottom edge off-screen. Removed the extra offset in all five pages.
24. **Slack dashboard badge read "Choose a platform"** (popup's key reused). Now "Slack".
25. **Accessibility batch:** `role="status"`/`aria-live` on status, progress and result
    counts (5 dashboards); accessible names for every result checkbox and the Reddit
    Deep-Scan switch; `aria-expanded` on the activity-log toggle; `role="alert"` on popup
    errors; light-mode muted text `#98a2b3 → #667085` (2.6:1 → 4.8:1) in all three
    stylesheets; popup error text `#ef4444 → #dc2626` in light mode; alerts keep line breaks
    (`pre-wrap`); status colour resets at the start of each scan.
26. **Docs/privacy accuracy:** README now tells developers to build the Telegram bundles
    before "Load unpacked" (fresh clones were broken) and no longer claims "no runtime
    dependencies"; privacy policy (MD + HTML) now discloses the X username, Mastodon account
    ID, saved filter presets, and that paused jobs keep their queue until resumed/cancelled.

New i18n keys (en/de/es/fr): `telegramDashOnlyMine`, `telegramDashOnlyMineHint`,
`telegramDashAuthorYou`, `telegramDashAuthorOther`, `logScanThreadLookbackNote`.

### Needs a manual check before release

Run these in a real browser — they depend on live platform behaviour:
- Teams first-time connect end-to-end (Chrome **and** Firefox), including a tenant on the
  bare `teams.microsoft.com/api/chatsvc/...` host.
- X scan after a fresh install — confirm the status shows live signatures were fetched.
- Telegram: scan a DM with "Only my messages" on/off; confirm author labels and selection.
- Slack: custom-range scan on a new channel shows no false "not all scanned" warning.

---

## 3. Second pass — everything below is now fixed

> **Update (same day, second pass):** every item in this section was fixed by five
> file-scoped fix passes, then integrated and verified: **341/341 unit tests**,
> **21/21 Playwright e2e tests**, `eslint .` clean, Telegram bundles rebuilt, store zips
> built twice with identical SHA-1 (reproducible). 327 new i18n keys were added in
> en/de/es/fr. The tables are kept as the record of what was found.
>
> **Third pass (leftovers):**
> - When the popup opens straight into Slack, focus is moved off the hidden platform row.
> - 25 unused i18n keys removed.
> - Slack keeps up to 5 recent scans per conversation (30-minute window), so a re-scan in
>   another tab no longer forces this tab to re-scan.
> - Keyword store title adopted in all four locales (≤ 50 characters).
> - `addons-linter@10.14.0` confirmed on npm.
> - Switching teleproto → GramJS was evaluated and rejected: GramJS is archived and points
>   to teleproto as its successor.
>
> **Feature round (roadmap):** shipped advanced filters (date range, /regex/, invert, keep
> rules), CSV/JSON export on all five non-Slack dashboards, Reddit overwrite-then-delete,
> Reddit data-export import, X archive import, Telegram server-side date filtering and
> `teams.cloud.microsoft` support (Microsoft's new Teams web host). Scheduled auto-delete was
> deliberately not built (unattended deletion conflicts with preview-first safety).
> `use_dynamic_url` stays off (breaks Slack CSS on Chrome 109–129).
>
> **Regression pass:** five read-only reviewers compared the whole uncommitted diff with
> HEAD. They found no high-severity regressions. All 25 unique findings are resolved:
> 23 fixed, 1 rejected as not a bug, and 1 informational item (the shim shipping in the
> zip) also removed. See the CHANGELOG "Regression pass" entry. Final state: 346/346
> unit, 21/21 e2e, ESLint 0 warnings, webpack 0 warnings, addons-linter 0/0/0.
>
> **Zero-warning pass:** the Firefox validator (`addons-linter`) now reports
> 0 errors, 0 warnings and 0 notices; webpack, ESLint (`--max-warnings 0`), the unit
> tests and the Playwright tests are all warning-free.
>
> **Deliberately not changed:**
> - `use_dynamic_url` — it was tried and **reverted**. The Slack content script loads
>   `content.css` via `runtime.getURL`, and Chrome 109–129 (the supported floor is 109)
>   return the static URL, which would leave the Slack dashboard unstyled. The CHANGELOG
>   records the same regression from an earlier pass. Fingerprinting stays an accepted
>   low risk.
> - `teams.cloud.microsoft` host support — it can't be confirmed offline, and it would
>   add a new host permission (a product/store-review decision).
>
> **Highlights of the second pass:**
> - **Slack:**
>   - A retry joins the scan that's already running.
>   - A finished scan is cached for 10 minutes.
>   - Navigating no longer pauses the job; Close only hides the dashboard.
>   - A delete only accepts messages from the last scan, and in "me" mode only your own.
>   - The shadow root is closed, and destructive clicks must be real user clicks.
>   - Selecting other people's messages triggers an extra confirmation.
>   - Paused jobs expire after 30 days.
>   - Trims that leave files attached are reported as partial.
>   - Scan results are slimmed down.
>   - The dashboard is fully localized and accessible.
> - **Reddit:** multi-sort Deep Scan, honest note about the ~1000-item cap, `limit=100`,
>   mod-removed items included, consistent modhash check.
> - **X:** posts nested in visibility wrappers, self-threads and the pinned post are now
>   found; reposts are removed through `DeleteRetweet`; query IDs are validated;
>   `x-rate-limit-reset` is honoured; Deep Scan up to X's ~3200-post cap.
> - **Mastodon:** entities decoded; scope-403 fails fast; rate-limit headers honoured;
>   `delete_media=true`; ETA shown before long runs.
> - **Teams:** `backwardLink` pagination, paginated chat list, readable chat names,
>   system messages filtered out, friendly errors.
> - **Telegram:**
>   - Login moved to the dashboard tab, so it survives the popup closing.
>   - Log out ends the session on Telegram's servers.
>   - The account name is shown.
>   - Unauthorized sessions are detected.
>   - Chat picker added.
>   - The 2FA password is no longer trimmed.
>   - Deletes are counted honestly by owner.
> - **Shared dashboards:**
>   - One delete confirmation for all platforms: a red "Delete N …" button, disabled
>     until the typed text matches.
>   - Modals queue instead of stacking, and return focus to their trigger.
>   - `Retry-After` is honoured, and Cancel interrupts the wait.
>   - "N of M selected" counter and indeterminate Select All.
>   - Progress shows percent and an ETA.
>   - Persistent warning that deletes can't be undone.
>   - Responsive layout, AA contrast, reduced-motion support, focus rings and RTL-safe CSS.
> - **Popup:**
>   - Per-platform **Disconnect**: clears stored keys and revokes permissions.
>   - Real `<button>` rows, and a Mastodon `<form>` so Enter submits.
>   - `<html lang>` follows the UI language.
>   - Telegram code loads only when its view is opened.
>   - AA contrast and focus management.
> - **Store/build:**
>   - `key` stripped from the Chrome zip, and zips are deterministic.
>   - CI actions pinned to commit SHAs; teleproto and addons-linter pinned exactly.
>   - Firefox shortcut changed to Alt+Shift+E.
>   - Store docs corrected; privacy policy has an appendix of every storage key, enforced
>     by a test.
>
> **Manual checks still worth doing in a real browser:**
> - Teams connect (Chrome and Firefox) and its pagination.
> - X scan and repost delete.
> - Telegram login in the dashboard tab and Log out.
> - Reddit Deep Scan sweep.
> - Mastodon delete of a post with media.

### Original list (as found)

### Correctness / reliability

| Sev | Where | Issue | Suggested fix |
|---|---|---|---|
| 🟠 | `telegram-popup.src.js` | Telegram login runs inside the action popup; switching to Telegram Desktop to read the code closes the popup and kills the login. | Move phone/code/2FA steps into a full tab (dashboard page); popup only launches it. Also removes the 3 MB bundle from every popup open. |
| 🟡 | `content.js` scan timeout / `background.js` `inFlightScans` | Scans > 120 s never deliver results; retries get `scan_in_progress`, then restart a full sweep. | Cache the last finished scan per team+channel with a short TTL, or use a port with progress heartbeats. |
| 🟡 | `shared-filters.js` `decideItemAction` / trim | "Attachments only" trims via `chat.update` but uploaded `msg.files` stay attached while the log says "Cleaned". ❓ | Report as partial, or offer opt-in `files.delete` for the user's own files. |
| 🟡 | `content.js` `handleUrlChange`, close button | Any Slack navigation auto-pauses the job; Close cancels even a paused job. | Let the job keep running while the user navigates; make Close = hide, Cancel = separate. |
| 🟡 | `dashboard-x.js:19-20,403` | X skips `TweetWithVisibilityResults`, self-thread modules and the pinned tweet; retweets may need `DeleteRetweet`. ❓ | Unwrap `result.tweet`, include those modules. |
| 🟡 | `dashboard-teams.js:316,230` | Teams pagination likely needs `_metadata.backwardLink` (stops after 100 msgs); chat list is first-page only. ❓ | Follow backwardLink; paginate chats. |
| 🟡 | `dashboard-reddit.js` | Reddit's ~1000-item listing cap is shown as a complete scan; `limit=25` (could be 100). | Say "Reddit only lists your newest ~1000"; multi-sort sweep; `limit=100`. |
| 🟡 | `telegram-popup.src.js:104` | Each browser restart forgets the session without `auth.LogOut` → orphaned sessions pile up in Telegram's "Active sessions". | Warn + offer revoke, or keep the session encrypted at rest. |
| 🟡 | platforms | No **Disconnect** for Reddit/X/Mastodon/Teams; Mastodon token never revoked; Teams capture keeps running after connect. | Per-platform Disconnect (clear keys, revoke token, remove permission). |
| ⚪ | Slack | Rate-limit countdown keeps running while paused; cross-tab cancel leaves stale "Deleting..." status; legacy `/messages/` URLs pick the first workspace; Tab focus trap includes hidden modal buttons; user-name cache never purged after TTL; scan payload carries full blocks/files. | See Slack-core notes. |
| ⚪ | Telegram | 2FA password is `.trim()`ed; "(Connected)" without account name; `connect()` succeeds with an unauthorized session. | |
| ⚪ | Mastodon | HTML entities (`&#39;`) not decoded in filter/preview. | Decode via `DOMParser`. |
| ⚪ | shared | `fetchWithRetry` ignores `Retry-After` / `x-rate-limit-reset`; post-delete count drops the "more may exist" note. | |
| ⚪ ❓ | content.js | Thread-root warning says Slack deletes ALL replies — Slack actually keeps replies with a "deleted" placeholder. | Verify and reword. |

### Security / privacy (no critical or high issues remain)

| Sev | Issue | Fix |
|---|---|---|
| ⚪ | `START_DELETION` trusts the queue sent by the content script (doesn't check it came from the background's own last scan). | Keep last scan's `ts` set in the worker; accept only those; re-check ownership in "me" mode. |
| ⚪ | Slack shadow root is `mode:"open"` — page scripts could drive the dashboard. | `mode:"closed"` + require `event.isTrusted` on destructive buttons. |
| ⚪ | Slack "All Messages (admin)" mode deletes others' content while the listing says "your own". | Extra confirmation when the queue contains non-self items; or disclose in listing/policy. |
| ⚪ | `teleproto` (holds the auth key) is `^`-ranged; `addons-linter@^10` floats outside the lockfile. | Pin exactly; review bundle diffs on bumps. *(Done. Note: teleproto is GramJS's official maintained successor — the `telegram` package is archived/deprecated — so switching to GramJS was checked and rejected.)* |
| info | `web_accessible_resources` + fixed `key` let Slack pages fingerprint the extension; scraped X query IDs aren't validated before use in URL path. | `use_dynamic_url: true`; validate `^[A-Za-z0-9_-]+$`. |

### UI / accessibility

- **Confirmation dialogs are inconsistent** between Slack and the five dashboards (different
  thresholds, OK always enabled, a typo silently aborts, purple "Confirm" for a destructive
  action, hardcoded English). → One shared pattern: red **"Delete 42 posts"** button disabled
  until the typed text matches, inline validation, localized.
- **~130 hardcoded English strings** bypass i18n (platform dashboards, `content.js`
  aria-labels, Mastodon form labels, `"0 items found"`, manifest command description);
  `<html lang="en">` never follows the UI language.
- **Focus management:** modals don't return focus to their trigger; popup view switches and
  Telegram steps don't move focus; Slack overlay root lacks `role="dialog"`/`aria-modal`;
  Slack console is `aria-live` and floods screen readers during long runs.
- **Contrast still failing:** white text on brand buttons (`#ec4899` 3.5, `#2AABEE` 2.6,
  `#FF871D` 2.4, Slack "Matrix"/"Fusion" themes ≈2.2–2.5); input borders 1.2:1; switch track
  1.4:1; 8 px text in badges/stat labels.
- No selected-count / indeterminate Select All / ETA on the five platform dashboards.
- No responsive breakpoints in `dashboard-base.css`/`content.css` (two-column grids crush at
  zoom/narrow widths); theme bubbles are 15 px (< 24 px target size).
- The "Items deleted will be unrecoverable" warning is overwritten by status text right
  before the user deletes — keep it in a separate persistent element.
- `dashFilterDepthNote` tells Reddit/X users about "Slack's dashboard"; Teams chat picker
  shows raw `19:abc…` IDs; Teams has an orphan `<label>`.
- `prefers-reduced-motion` gaps; popup rows are `<li role="button">`; inline forms aren't
  `<form>` (Enter does nothing); decorative SVGs lack `aria-hidden`; RTL needs logical CSS.

### Store / build / CI

- ❓ `manifest.json` ships a `key` field — strip it in `build.sh` for the CWS zip.
- `CWS_SUBMISSION_FIELDS.md`: language section says only English ships (de/es/fr exist);
  §4.1 discusses the old "for Slack" name; data-usage checkboxes ("Authentication
  information", "Personal communications") deserve a re-read against current CWS policy.
- Public GitHub link in the CWS notes vs. a private repo (reviewers would get a 404).
- `privacy.html` date (Sept 7) ≠ Markdown/TERMS (Sept 10); policy has no contact address.
- `zip -qr` without `-X`/sorted list → non-deterministic zips; CI actions pinned to tags,
  not SHAs.
- Ctrl+Shift+K collides with Firefox's Web Console shortcut.
- **Test gaps:** Teams pending-connect permission retention, shared-permission revoke,
  Telegram login flow, ARIA live-region presence, "every stored key is in the privacy
  policy", build-zip contents (license present, `key` stripped, no `.src.js`), light-mode
  contrast, Teams capture end-to-end.

---

## 4. Competitive position

| | **Erasechat** | Redact.dev | TweetDelete/TweetDeleter | Power Delete Suite | Slack cleaners | Mastodon built-in / ephemetoot |
|---|---|---|---|---|---|---|
| Platforms | **6** | ~28–30 | X | Reddit | Slack | Mastodon |
| Price | **Free, unlimited** | Free tier limited; ~$96–180/yr | ~$4–8/mo or ~$99 lifetime | Free | Paid licence | Free |
| Runs locally / no account | **Yes** | Desktop app | Cloud OAuth | Yes | Yes | Server / CLI |
| Preview + per-item uncheck | **All platforms** | Partial | Partial | No | Partial | Dry run |
| Resume after crash | Slack only | Yes | Cloud | No | No | n/a |
| Date filter | Slack only | Yes | Yes | Yes | Yes | Age threshold |
| Overwrite-before-delete | No | Yes | n/a | **Yes** | n/a | n/a |
| Archive / data-export import | No | Partial | **Yes** | No | n/a | n/a |
| Scheduled auto-delete | No | Premium | **Yes** | No | No | **Yes** |
| Backup before delete | Slack CSV | Yes | Some | CSV log | No | No |

**Where Erasechat already wins:** free and unlimited (competitors' #1 complaint is
paywalls/caps), local-only with no account (#2 complaint is trust/billing disputes), the only
tool covering Teams chats, and a real preview on every platform.

---

## 5. Roadmap to "best in category"

Prioritised by value ÷ effort (S = days, M = 1–2 weeks, L = more).

### Now (S)
1. **Date-range filter on all five non-Slack platforms** — table stakes; Telegram `minDate`,
   X/Mastodon snowflake IDs make it cheap.
2. **Regex, invert and saved presets everywhere** — logic already lives in `shared-filters.js`.
3. **CSV/JSON export before delete on every platform.**
4. **Per-platform Disconnect** + connection chips in the popup ("Connected as @user").
5. **Honest ETAs** (per-item delays are known: Reddit 1.5 s, X 2.5 s, Mastodon 30/30 min).
6. **Unified confirmation + progress UX** (section 3, UI) across all six platforms.

### Next (M)
7. **Reddit overwrite-then-delete** — the #1 feature Reddit privacy users look for.
8. **Reddit multi-sort sweep** (new/hot/top/controversial × time windows) to beat the
   1000-item cap.
9. **Import platform data exports** (X archive `tweet-headers.js`, Reddit GDPR CSV) to delete
   beyond the API caps (X ~3200, Reddit ~1000).
10. **Keep rules** — keep pinned, keep score/likes ≥ N, keep-list by ID, subreddit/chat
    allow-list.
11. **Resumable background jobs for all platforms** (Slack's engine already does this).
12. **Post-run verification pass** — re-scan and report "N still visible", with
    "Retry failed only". Competitors are most criticised for false "done".
13. **X likes / retweets / replies**, Mastodon favourites/bookmarks, `delete_media=true`.
14. **Telegram chat picker** from the dialog list, and "my messages across all groups".

### Later (L)
15. **Scheduled local auto-delete** ("weekly: delete my posts older than 90 days") via
    `chrome.alarms` — the core value of TweetDelete/Redact Premium, done privately.
16. **Slack workspace-wide delete** via `search.messages from:me`; multi-channel job queue.
17. **Teams channel messages** (not just chats) and scan-all-chats.
18. **New platforms:** Bluesky (open AT Protocol, low risk) first; Discord is high-demand
    but carries ToS/self-bot risk.

### Store listing / ASO
- Title has no keywords: use e.g. **"Erasechat – Bulk Delete Messages, Posts & Comments"**
  (keep platform trademarks in the description with the disclaimer).
- First line and screenshot 1: **"Free · No limits · No account · Nothing leaves your
  browser."**
- Localized listings for de/es/fr (the package already ships them).
- Upload the 440×280 promo tile (required for featuring); add a 30-second demo video and one
  screenshot per platform.
- One-time, dismissible "rate us" prompt after a successful large run; reply to reviews and
  keep the update date fresh — recency is the main trust signal in this category.

### Platform risks to keep handling
- **Slack:** May-2025 rate-limit changes target non-Marketplace OAuth apps (Erasechat uses the
  web session, so not directly covered — keep honouring Retry-After).
- **X:** no affordable official API; query IDs rotate (now actually re-fetched); ~3200-tweet
  timeline cap; aggressive loops trigger account locks.
- **Reddit:** ~1000 items per listing; unofficial cookie-session path; keep pacing
  conservative and user-initiated.
- **Mastodon:** 30 deletes / 30 min; v4+ has built-in auto-delete — differentiate on preview
  and selective delete.
- **Teams:** tenant policy and retention/eDiscovery may keep server copies — disclose it.
- **Telegram:** `FLOOD_WAIT` handled; user-supplied `api_id` required by Telegram's terms.

---

## 6. Files changed in this pass

`background.js` · `content.js` · `shared-filters.js` · `popup.js` · `popup.html` · `popup.css` ·
`content.css` · `manifest.json` · `manifest.firefox.json` · `eslint.config.mjs` ·
`platforms/shared/dashboard-fetch-utils.js` · `platforms/shared/dashboard-base.css` ·
`platforms/telegram/telegram-dashboard.src.js` · `platforms/x/dashboard-x.js` ·
`platforms/mastodon/dashboard-mastodon.js` · `platforms/teams/dashboard-teams.js` ·
`platforms/teams/teams-webrequest.js` · `platforms/*/dashboard-*.html` (5) ·
`_locales/{en,de,es,fr}/messages.json` · `scripts/build.sh` · `README.md` · `CONTRIBUTING.md` ·
`PRIVACY_POLICY.md` · `privacy.html` · `store-assets/AMO_SUBMISSION_FIELDS.md` ·
`store-assets/CWS_SUBMISSION_FIELDS.md` · `tests/background.test.js`
