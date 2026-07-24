# SlackClean Premium — Store Listing Copy

Ready-to-paste copy for the Chrome Web Store and Firefox Add-ons (AMO). Character
limits are noted next to each field. All claims below match the extension's actual
behavior (see `PRIVACY_POLICY.md` and `CHANGELOG.md`).

---

## Name
`SlackClean Premium`

## Category
Productivity / Workflow & Planning

---

## Short description / Summary
_Chrome: max 132 chars · Firefox summary: max 250 chars_

**Short (Chrome, 124 chars):**
> Bulk-delete your own Slack messages by sender, date, keyword, threads & files. Scan, preview, then delete — safely and locally.

**Summary (Firefox, 237 chars):**
> Bulk-delete your own Slack messages in channels, groups and DMs. Filter by sender, date, keyword, threads and attachments; scan and preview first, export a CSV backup, then delete with pause/resume and type-to-confirm safety. 100% local.

---

## Tagline (for promo tiles / headings)
> Bulk-clean your Slack — with surgical control.

---

## Detailed description
_Chrome: max 16,000 chars_

**Tired of scrolling back years to clean up your Slack? SlackClean Premium clears your own messages in bulk — with the filters and safety controls to do it right.**

SlackClean Premium adds a powerful cleanup dashboard to the Slack web app. Open any channel, private group, or direct message, pick your filters, preview exactly what will be removed, and delete in bulk — all from your browser.

**🎯 Precise filters**
- Target **your own messages** in the current conversation
- By **date** — all time, older than X days, or a custom date range
- By **keyword or phrase** — match specific text
- **Include thread replies**, or leave threads untouched
- **Attachments-only mode** — remove files and images while keeping the message text

**🔍 Scan & preview before anything is deleted**
- Run a scan to see every matching message first
- Un-check anything you want to keep — you're always in control
- Export the matched messages as a **CSV backup** in one click

**🛟 Safety built in**
- **Type-to-confirm** for large jobs (100+ messages)
- **Pause, resume, or cancel** any run at any time
- **Single-channel scope by default** — it only touches the conversation you chose
- **Rate-limit aware pacing** so Slack stays happy
- Jobs **resume reliably** even if your browser restarts mid-cleanup

**🔒 Private by design**
- **100% local** — all scanning and deleting happen in your browser tab
- **No servers, no accounts, no tracking**, no message content uploaded
- Works through your **existing Slack login** — no passwords or tokens to enter

**⌨️ Convenient**
- Open the dashboard from the toolbar or with a keyboard shortcut (Ctrl+Shift+K / ⌘+Shift+K)
- Clean, modern interface with light theming options

---

**Please note:** SlackClean Premium is an **independent tool and is not affiliated with, endorsed by, or sponsored by Slack**. It acts on your behalf using your existing Slack session. **Deletions are permanent and cannot be undone** — always preview (and export a backup) before you delete. Deleting messages you don't have permission to remove may be restricted by your workspace.

---

## Screenshot captions
_Order matches `store-assets/screenshots/`._

1. **01-overview.png** — "Set your rules, target any conversation." — the cleanup dashboard with session info, the filter matrix, and Scan/Delete.
2. **02-preview.png** — "Scan first. Preview every message before it goes." — the results checklist with per-message checkboxes, thread replies, attachments, and CSV export.
3. **03-safety.png** — "Deletes are permanent — so we make you confirm." — the type-DELETE verification for large jobs.
4. **04-progress.png** — "Watch it work — live progress & logs." — progress ring, success/failure counts, execution log, and Cancel.
5. **05-privacy.png** — "100% local. Nothing leaves your browser." — the popup and the privacy guarantees.

---

## Single-purpose description
_Required by the Chrome Web Store._

> SlackClean Premium has a single purpose: to help users bulk-delete and clean their own messages in the Slack web client (app.slack.com and workspace subdomains). Everything the extension does — scanning conversations, previewing matches, and deleting messages — serves that one purpose.

---

## Permission justifications
_Required by the Chrome Web Store. Keep concise and factual._

- **`storage`** — Saves your filter preferences, first-run onboarding state, and the state of an in-progress deletion job so it can safely resume if the background service worker sleeps or the browser restarts.
- **`scripting`** — Injects the cleanup dashboard into the active Slack web-app tab when you click the toolbar button (used as a fallback when the content script isn't already loaded).
- **`alarms`** — Schedules rate-limit back-offs and a watchdog that reliably resumes an interrupted deletion job.
- **Host permissions — `https://*.slack.com/*`, `https://slack.com/*`** — The extension runs only on the Slack web client. It reads the currently open conversation and calls Slack's own endpoints, using your existing login session, to delete your messages. No other websites are accessed.
- **Remote code:** None. All code is bundled in the extension package; no remote scripts are loaded or executed.

---

## Support / links
- Privacy policy: `PRIVACY_POLICY.md` (host this at a public URL for the listing)
- Support email: yogeshb@prosperix.com _(update if needed)_

---

## Packaging reminder
Exclude from the store ZIP: `tests/`, `package.json`, `playwright.config.js`,
`CHANGELOG.md`, `store-assets/`, and `.agents/`.
