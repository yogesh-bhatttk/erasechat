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
| [`manifest.firefox.json`](manifest.firefox.json) | Firefox 115+ | `scripts: ["shared-filters.js", "background.js"]` + `gecko` settings |

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
| `tests/` | `node --test` unit tests + Playwright e2e |

> Do **not** fork the logic in `shared-filters.js` into the content script — scanning and
> the delete/keep decision are deliberately delegated to the background context so there
> is exactly one implementation, and it is unit-tested.

## Development

```bash
npm install          # dev-only (Playwright for e2e)
npm test             # unit tests (node --test, zero-dependency)
npm run test:e2e     # Playwright end-to-end (requires browsers)
```

## Build / package for the stores

```bash
npm run build        # produces dist/bulk-clean-for-slack-chrome-<version>.zip
                     #      and dist/bulk-clean-for-slack-firefox-<version>.zip
```

The build script assembles a clean package per target: the correct manifest, all runtime
files, `_locales/`, `icons/`, `fonts/`, `PRIVACY_POLICY.md`, and `LICENSE` — and excludes
tests, tooling, and docs. See [`scripts/build.sh`](scripts/build.sh).

## Privacy & security

- Privacy policy: [PRIVACY_POLICY.md](PRIVACY_POLICY.md)
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) © 2026 Yogesh Bhatt
