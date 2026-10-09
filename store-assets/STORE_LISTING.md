# Erasechat — Store Listing Copy

> **Updated 2026-09-10 for the 6-platform tool.** Both submission sheets'
> Summary/Description/permission-justification/Notes-for-Reviewer text now describe all
> six platforms (Slack plus optional Reddit, X, Mastodon, Microsoft Teams, Telegram, each
> connected explicitly from the popup). What's below in this shared file is still
> Slack-focused (see the per-file note in each submission sheet) — the Feature claims and
> screenshot captions haven't been expanded to the five newer platforms, and new
> screenshots showing the platform picker are a visual-asset task, not a text edit.
>
> **Per-store field values live in the two submission sheets, not here.** Chrome and AMO
> disagree on nearly every field — category taxonomy, whether the summary comes from the
> package, whether the description renders Markdown, whether a privacy policy may be pasted
> or must be hosted — so one shared copy deck cannot serve both without drifting. It did
> drift, which is why this file was cut back.
>
> - **Chrome Web Store** → [`CWS_SUBMISSION_FIELDS.md`](./CWS_SUBMISSION_FIELDS.md)
> - **Firefox / AMO** → [`AMO_SUBMISSION_FIELDS.md`](./AMO_SUBMISSION_FIELDS.md)
> - **Process and blockers** → [`SUBMISSION_CHECKLIST.md`](./SUBMISSION_CHECKLIST.md)
>
> One trap worth repeating: the Chrome description field renders **plain text**. Pasting
> Markdown puts literal `**asterisks**` on the public listing.

What remains below is the copy that is genuinely shared between stores, plus the claims
every listing has to keep honest. All of it matches the extension's actual behavior
(see `PRIVACY_POLICY.md` and `CHANGELOG.md`).

---

## Name
`Erasechat`

## Tagline
_For promo tiles and headings. Not a store field._
> Bulk-clean your Slack — with surgical control.

---

## Feature claims

The canonical list. Both stores' descriptions are built from this, so correct it here
first if the extension changes.

**Precise filters**
- Target the user's own messages in the current conversation
- By date — all time, older than X days, or a custom date range
- By keyword, phrase, or `/regex/` pattern
- Include thread replies, or leave threads untouched
- Attachments-only mode — remove files and images while keeping the message text

**Scan and preview before anything is deleted**
- A scan lists every matching message first
- Any message can be un-checked and kept
- Export the matched messages as a CSV backup

**Safety**
- Type-to-confirm for jobs over 100 messages
- Pause, resume, or cancel any run
- Single-conversation scope — only the chat that was opened is touched
- Auto-pauses if the user navigates to a different channel or workspace mid-run
- Rate-limit aware pacing that honors Slack's `Retry-After`
- Jobs resume if the browser or service worker restarts mid-cleanup

**Private by design**
- 100% local — scanning and deleting happen in the browser tab
- No servers, no accounts, no tracking, no message content uploaded
- Works through the existing Slack login — no passwords or tokens to enter

**Convenience**
- Toolbar button or Ctrl+Shift+K in Chrome / Alt+Shift+E in Firefox (Cmd+Shift+K on macOS)
- Three color themes (fusion, matrix, neon)

---

## Required disclaimer

Every listing carries this, verbatim. It is not optional — the copy names other
companies' platforms, and the tool destroys data irreversibly.

> Erasechat is an independent tool and is not affiliated with, endorsed by, or
> sponsored by Slack, Reddit, X Corp., Mastodon gGmbH, Microsoft, or Telegram FZ-LLC. It
> acts on your behalf using your existing session (or a credential you provide) on the
> platforms you connect. Deletions are permanent and cannot be undone — always preview
> (and export a backup) before you delete. Two opt-in modes — Slack's "All Messages"
> (admins) and Telegram with "Only my messages" off — can delete other people's messages
> where the platform permits it. Platforms with retention or compliance policies (e.g.
> Microsoft Teams, enterprise Slack) may keep server-side copies this tool cannot remove.

---

## Screenshot captions
_Order matches `store-assets/screenshots/`. Identical on both stores._

| # | File | Caption |
|---|---|---|
| 1 | `00-platforms.png` | One extension. Six platforms. |
| 2 | `01-overview.png` | Set your rules, target any conversation. |
| 3 | `02-preview.png` | Scan first. Preview every message before it goes. |
| 4 | `03-safety.png` | Deletes are permanent — so we make you confirm. |
| 5 | `04-progress.png` | Watch it work — live progress and logs. |
| 6 | `05-privacy.png` | 100% local. Nothing leaves your browser. |

---

## Packaging

`npm run build` produces both store-ready zips in `dist/`:

- `erasechat-chrome-<version>.zip` (uses `manifest.json`)
- `erasechat-firefox-<version>.zip` (uses `manifest.firefox.json`)

The build ships only runtime files (+ `privacy.html`, `LICENSE`) and excludes `tests/`,
`package.json`, `playwright.config.js`, `CHANGELOG.md`, `store-assets/`, `.agents/`, and
the non-target manifest. See `scripts/build.sh`.
