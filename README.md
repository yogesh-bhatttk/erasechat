# Bulk Clean for Slack

Bulk-delete and clean your own Slack messages — in channels, private groups, and DMs —
with advanced filters, thread support, and strong safety controls. A Manifest V3
browser extension for **Chrome / Chromium** (Chrome, Brave, Edge) and **Firefox**.

> **Independent tool — not affiliated with, or endorsed by, Slack.** It uses your
> existing, logged-in Slack web session to delete messages *on your behalf*.
> **Deletions are permanent and cannot be undone.** All processing happens locally in
> your browser; no message content is sent to any external server. See
> [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

---

## Features

- **Current-chat scope** — only the conversation you have open is ever touched.
- **Scan & preview before deleting** — nothing is deleted until you review the matched
  list and confirm.
- **Filters** — by sender (only me / everyone), date (all time, older-than-N-days, or a
  custom range), free-text keyword, `/regex/` pattern, and attachments-only.
- **Threads** — optionally scan and delete replies inside threads.
- **Attachment cleaning** — "Only Delete Attachments" strips files/attachments while
  keeping the message text (a message that is *only* a file is deleted).
- **Safety** — a type-**DELETE** confirmation for large batches (>100), channel/workspace
  drift protection that auto-pauses if you navigate away, and pause/resume/cancel at any
  time. Bulk jobs run in the background and survive the service worker being suspended.
- **Rate-limit aware** — honors Slack's `Retry-After` with a synced countdown.
- **Export** — download scanned messages as CSV, and the execution log as text.
- **Local & private** — your Slack token stays in `chrome.storage.session` (memory-only)
  and is never written to disk or sent anywhere but `slack.com`.

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

## Install

### From the stores
_(Links will go here once published.)_

### Load unpacked (development)

**Chrome / Chromium (Chrome, Brave, Edge):**
1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this project folder (uses [`manifest.json`](manifest.json)).

**Firefox:**
1. Copy the Firefox manifest over the default one (Firefox uses an event page, not a
   service worker — see [Cross-browser](#cross-browser-two-manifests)):
   `cp manifest.firefox.json manifest.json`
2. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick any
   file in the folder.

Then open the Slack **web** client (`https://app.slack.com` or your workspace subdomain),
open a channel or DM, click the extension icon, and **Open Clean Dashboard**
(shortcut: `Ctrl+Shift+K` / `Cmd+Shift+K`).

## Cross-browser (two manifests)

Chromium MV3 requires a `background.service_worker`; Firefox stable runs MV3 backgrounds
as an **event page** via `background.scripts`. These are mutually exclusive, so the repo
ships two manifests with identical everything else:

| File | Target | Background |
|---|---|---|
| [`manifest.json`](manifest.json) | Chrome / Chromium | `service_worker: background.js` (loads `shared-filters.js` via `importScripts`) |
| [`manifest.firefox.json`](manifest.firefox.json) | Firefox 140+ | `scripts: ["shared-filters.js", "background.js"]` + `gecko` settings |

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

> Do **not** fork the logic in `shared-filters.js` into the content script — scanning and
> the delete/keep decision are deliberately delegated to the background context so there
> is exactly one implementation, and it is unit-tested.

## Development

```bash
npm install               # dev-only (ESLint + Playwright); the extension itself
                          # has no runtime dependencies
npm run hooks:install     # once per clone: pre-push guard on main (see below)
npm run lint              # correctness lint (must be 0 problems)
npm test                  # unit + packaging tests (node --test, zero-dependency)
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
npm run build             # produces dist/bulk-clean-for-slack-chrome-<version>.zip
                          #      and dist/bulk-clean-for-slack-firefox-<version>.zip
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

## License

[MIT](LICENSE) © 2026 Yogesh Bhatt
