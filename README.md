# Erasechat

Bulk-delete and clean your own content — in channels, private groups, and DMs, or posts
and comments — across **six platforms**: **Slack** (built in) plus five **optional**
platforms you connect one at a time from the popup: **Reddit, X, Mastodon, Microsoft
Teams, and Telegram**. A Manifest V3 browser extension for **Chrome / Chromium** (Chrome,
Brave, Edge) and **Firefox**.

> **Independent tool — not affiliated with, or endorsed by, Slack, Reddit, X Corp.,
> Mastodon gGmbH, Microsoft, or Telegram FZ-LLC.** It uses your existing, logged-in
> session on each platform (or, for Mastodon and Telegram, a credential you provide) to
> act *on your behalf*. **Deletions are permanent and cannot be undone.** All processing
> happens locally in your browser; no content is sent anywhere but the platform you're
> managing. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

---

## Platforms

| Platform | Status | Auth | Notes |
|---|---|---|---|
| **Slack** | Built in, always available | Rides your existing browser session | The most mature engine — ~10 audit passes, resumable background job queue, per-message filters |
| **Reddit** | Optional | Rides your existing browser session | Comments, posts, or both |
| **X** | Optional | Rides your existing browser session | Reads live query IDs from x.com, since X has no stable public API |
| **Mastodon** | Optional | Personal access token you generate on your instance | Works with any federated instance; permission is requested for the exact instance you type |
| **Microsoft Teams** | Optional | Passively captured from your own Teams web-client traffic | Requires a work/school account whose messaging policy permits deletion |
| **Telegram** | Optional | `api_id`/`api_hash` (from my.telegram.org) + phone/code login | Real MTProto client running in the extension; deletes "for everyone" |

Every platform's scan can be reviewed and individually deselected before you confirm a
delete, and every platform's dashboard lets you cancel a deletion already in progress.
Connecting a platform is always an explicit, one-click action from the popup — nothing
beyond Slack is ever contacted automatically.

## Features

- **Current-conversation scope** — only what you have open (or, for Reddit/X/Mastodon,
  your own account) is ever touched.
- **Scan & preview before deleting** — nothing is deleted until you review the matched
  list; every platform's results can be individually checked/unchecked before you
  confirm, not just previewed as an all-or-nothing batch.
- **Filters** — Slack supports sender (only me / everyone), date (all time,
  older-than-N-days, or a custom range), free-text keyword, `/regex/` pattern, and
  attachments-only, with an **Invert** checkbox that flips the text/regex filter to "keep
  matches, delete everything else." The other five platforms filter by free-text keyword
  (Reddit adds a comments/posts/both target type and a Deep Scan option).
- **Threads** — Slack can optionally scan and delete replies inside threads.
- **Attachment cleaning** — Slack's "Only Delete Attachments" strips files/attachments
  while keeping the message text (a message that is *only* a file is deleted).
- **Skip Pinned Messages** (Slack) — on by default: a message currently pinned in the
  conversation is never selected for deletion, regardless of what else matches.
- **Saved filter presets** (Slack) — name and save a full filter combination for reuse
  (e.g. "older than 90 days, no attachments"), stored locally per browser profile.
- **Safety** — a type-**DELETE** confirmation on every platform (typing the exact count
  above 100 items), and a cancel control mid-delete on every platform. Slack additionally
  has channel/workspace drift protection that auto-pauses if you navigate away, and a
  bulk job that runs in the background and survives the service worker being suspended.
- **Rate-limit aware** — Slack honors its `Retry-After` header with a synced countdown;
  Mastodon paces against its real 30-per-30-minute delete limit; Telegram backs off on
  `FLOOD_WAIT`.
- **Export** — Slack can download scanned messages as CSV, and its execution log as text.
- **Localized UI** — labels, buttons, and dialogs are translated into English, Spanish,
  French, and German across all six platforms. Slack's live execution log (the running
  diagnostic narration of a scan/delete) is English-only for now.
- **Local & private** — every platform's credential lives only in
  `chrome.storage.session` (memory-only) and is never written to disk or sent anywhere
  but that platform's own API.

## The text filter, and the `/regex/` convention

The **Text Match** field does a case-insensitive substring match by default. If your
value **starts and ends with a slash** (e.g. `/ERR_\d+/`), it is treated as a regular
expression instead. Notes:

- A pattern that could match the empty string (e.g. `/a?/`, `/.*/`, `/^/`) is rejected as
  a no-op and selects **nothing**, so a mistyped filter can never select the whole
  channel by accident.
- Unsafe / catastrophic-backtracking patterns are blocked and fall back to a literal
  match; they never hang the scan.
- To match a literal string that happens to begin and end with `/` (like the path
  `/etc/`), it will be interpreted as the regex `etc` — use it deliberately.
- The **Invert** checkbox next to the field flips the meaning to "keep whatever matches,
  delete everything else." A pattern that would otherwise select nothing (see above)
  still selects nothing when inverted — it never flips into "delete everything."

## Install

### From the stores
_(Links will go here once published.)_

### Load unpacked (development)

**Chrome / Chromium (Chrome, Brave, Edge):**
1. Go to `chrome://extensions`, enable **Developer mode**.
2. Build the Telegram bundles once (they're gitignored): `npm ci && node scripts/build-telegram.js`.
   Without this, the Telegram popup and dashboard fail to load.
3. **Load unpacked** → select this project folder (uses [`manifest.json`](manifest.json)).

**Firefox:**
1. Copy the Firefox manifest over the default one (Firefox uses an event page, not a
   service worker — see [Cross-browser](#cross-browser-two-manifests)):
   `cp manifest.firefox.json manifest.json`
2. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick any
   file in the folder.

Then open the Slack **web** client (`https://app.slack.com` or your workspace subdomain),
open a channel or DM, click the extension icon, and **Open Clean Dashboard**
(the popup also opens with `Ctrl+Shift+K` / `Cmd+Shift+K` in Chrome, `Alt+Shift+E` /
`Cmd+Shift+K` in Firefox — where `Ctrl+Shift+K` is the Web Console; rebind it at
`chrome://extensions/shortcuts` or `about:addons` → ⚙ → Manage Extension Shortcuts).

To use one of the other five platforms, click the extension icon and pick it from the
popup's platform list — each one requests its own (optional) permission and connects
independently, whether or not you also use Slack.

## Cross-browser (two manifests)

Chromium MV3 requires a `background.service_worker`; Firefox stable runs MV3 backgrounds
as an **event page** via `background.scripts`. These are mutually exclusive, so the repo
ships two manifests with identical everything else:

| File | Target | Background |
|---|---|---|
| [`manifest.json`](manifest.json) | Chrome / Chromium | `service_worker: background.js` (loads `shared-filters.js` and `platforms/teams/teams-webrequest.js` via `importScripts`) |
| [`manifest.firefox.json`](manifest.firefox.json) | Firefox 142+ | `scripts: ["shared-filters.js", "platforms/teams/teams-webrequest.js", "background.js"]` + `gecko` settings |

## Project layout

| File | Role |
|---|---|
| `manifest.json` / `manifest.firefox.json` | MV3 manifests (Chrome / Firefox) |
| `background.js` | Service worker / event page: Slack API proxy, per-channel delete **job queue** with alarms + watchdog, rate-limit/retry, resumable persistence |
| `content.js` | The in-page dashboard injected into Slack (scan UI, filters, progress, drift protection, resume flow) |
| `shared-filters.js` | **Single source of truth** for the delete/keep decision — `qualifies()`, `decideItemAction()`, `isSafeRegex()`, `fileShareCount()`, `isSlackHostname()`. Loaded by the background context and `require`d by the tests. |
| `popup.html/js/css` | Toolbar popup: detects a Slack tab, injects/launches the dashboard, first-run onboarding |
| `content.css` | Dashboard styles (Shadow-DOM isolated) |
| `_locales/en/messages.json` | i18n strings (`__MSG_*__` / `chrome.i18n`) |
| `icons/`, `fonts/` | Assets |
| `tests/unit.test.js` | Filter/decision logic (`node --test`, zero-dependency) |
| `tests/background.test.js` | Background worker loaded into a `vm` with a mocked `chrome` API: cross-browser load safety + the real scan engine against a stubbed Slack API |
| `tests/packaging.test.js` | Release gate: manifest/version/permission/CSP/locale/build-asset invariants |
| `tests/*.spec.js` | Playwright e2e (loads the unpacked extension) |
| `eslint.config.mjs` | Correctness-only lint rules (`no-undef` first — no bundler catches a typo'd global here) |
| `platforms/shared/dashboard-fetch-utils.js` | Shared by the five non-Slack dashboards: fetch/retry helpers, i18n (`t()`/`localizeI18n()`), the custom alert/confirm/prompt modal system, per-item selection (checkboxes + Select All), and cancel support |
| `platforms/shared/dashboard-base.css` | Shared dashboard styling for the five non-Slack platforms |
| `platforms/<platform>/connect-<platform>.js` | Per-platform "connect" step the popup calls after a permission grant/form submit |
| `platforms/<platform>/dashboard-<platform>.html` / `.js` | Each platform's standalone scan/delete dashboard (opened as its own tab) |
| `platforms/teams/teams-webrequest.js` | Passive Bearer-token capture from the user's own Teams traffic (background listener) |
| `platforms/telegram/telegram-{popup,dashboard}.src.js` | Telegram's real MTProto client (via `teleproto`), bundled by webpack into `.bundle.js` — see `webpack.telegram.config.js` and `scripts/build-telegram.js` |
| `popup/platform-registry.js` | Platform metadata table the popup renders its picker from |

> Do **not** fork the logic in `shared-filters.js` into the content script — scanning and
> the delete/keep decision are deliberately delegated to the background context so there
> is exactly one implementation, and it is unit-tested.

## Development

```bash
npm install               # ESLint, Playwright, webpack + the one runtime dependency
                          # (teleproto, bundled into the Telegram pages)
npm run hooks:install     # once per clone: pre-push guard on main (see below)
npm run lint              # correctness lint (must be 0 problems)
npm test                  # builds the Telegram bundles, then unit + packaging tests
npm run test:e2e          # Playwright e2e (needs: npx playwright install chromium)
npm run verify            # the full release gate, in order:
                          # lint -> test -> test:e2e -> build -> validate:firefox
```

Browser extensions cannot be loaded by a headless browser, so the e2e specs launch a
headful Chromium. On a machine with no display, run them under a virtual one:

```bash
xvfb-run --auto-servernum npm run test:e2e
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same gate on every
push and pull request and uploads both store packages as artifacts.

### Branch protection

`main` has **no server-side protection**: GitHub gates both classic branch protection and
rulesets behind a paid plan for private repositories. [`.githooks/pre-push`](.githooks/)
stands in locally — it refuses a force-push or deletion of `main` and runs lint + tests
before any push to it. Enable it per clone with `npm run hooks:install`.

It is advisory, not enforcement: `git push --no-verify` bypasses it and it cannot police
another machine. Making the repo public, or upgrading the plan, is what would give `main`
rules the server actually enforces.

## Build / package for the stores

```bash
npm run build             # produces dist/erasechat-chrome-<version>.zip
                          #      and dist/erasechat-firefox-<version>.zip
npm run validate:firefox  # addons-linter on the Firefox zip (must be 0 errors)
```

The build script assembles a clean package per target: the correct manifest, all runtime
files, `_locales/`, `icons/`, `fonts/`, `PRIVACY_POLICY.md`, and `LICENSE` — and excludes
tests, tooling, and docs. See [`scripts/build.sh`](scripts/build.sh).

## Cutting a release

```bash
npm run version:set 1.0.1   # rewrites both manifests + package.json + lockfile
                            # (validates against Chrome's version rules first)
# move the CHANGELOG "Unreleased" heading to 1.0.1 and date it
npm run verify              # the full gate must be green before tagging
git commit -am "Release v1.0.1"
git tag v1.0.1 && git push --follow-tags
```

Pushing a `v*` tag runs the gate again and then publishes both store zips to the GitHub
Release for that tag. The release job depends on the gate passing and refuses a tag that
disagrees with the packaged version, so a release can never carry untested or mislabelled
packages. Both stores reject a re-upload of an already-used version number, which is why
those two checks exist rather than a convention.

Uploading to the stores is still manual — see
[`store-assets/SUBMISSION_CHECKLIST.md`](store-assets/SUBMISSION_CHECKLIST.md).

## Privacy & security

- Privacy policy: [PRIVACY_POLICY.md](PRIVACY_POLICY.md)
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## Further reading

- [`docs/MULTI_PLATFORM_EXPANSION_PLAN.md`](docs/MULTI_PLATFORM_EXPANSION_PLAN.md) — the
  research behind which platforms beyond Slack were worth adding, and why.
- [`docs/AUDIT_PROMPT.md`](docs/AUDIT_PROMPT.md) — the prompt this project's audit passes
  are run from.

## License

[MIT](LICENSE) © 2026 Yogesh Bhatt
