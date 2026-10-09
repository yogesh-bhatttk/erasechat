# AMO "Describe Add-on" — exact field values

Copy-paste values for the Firefox Add-ons submission form, in the order the form asks.
Kept separate from `STORE_LISTING.md` because that file is written against the **Chrome**
Web Store's taxonomy, which does not match AMO's (see Categories below).

> **Updated 2026-09-10 for the 6-platform tool.** Summary, Description, and Screenshots
> now name/show all six platforms (Slack plus optional Reddit, X, Mastodon, Microsoft
> Teams, and Telegram, each connected explicitly from the popup). The
> `data_collection_permissions: ["none"]` claim still holds — nothing is transmitted to
> the developer on any of the six platforms, only stored locally (and, for each
> platform's credential itself, only in memory via `chrome.storage.session`) on the
> user's own device.

---

## Name
```
Erasechat
```

## Add-on URL slug
```
erasechat
```

## Summary
_AMO shows this in listings and search._
```
Bulk-delete your own content on Slack, Reddit, X, Mastodon, Microsoft Teams & Telegram, with advanced filters and safety controls.
```

## Description

> **Do not reuse the summary here.** The form currently has the summary text pasted into
> the description; AMO recommends ~250+ characters and this is the field that sells the
> add-on on its product page. Use the full text below (AMO supports light Markdown).

```
Free · No limits · No account · Nothing leaves your browser

Tired of scrolling back years to clean up your own posts and messages? Erasechat bulk-deletes your own content — with the filters and safety controls to do it right — across six platforms: Slack (built in) plus five optional platforms you connect one at a time: Reddit, X, Mastodon, Microsoft Teams, and Telegram.

Open a conversation (or your own account, for Reddit/X/Mastodon), pick your filters, preview exactly what will be removed, and delete in bulk — all from your browser.

**Slack — the flagship engine**
* Target your own messages in the current conversation
* By date — all time, older than X days, or a custom date range
* By keyword, phrase, or /regex/ pattern
* Include thread replies, or leave threads untouched
* Attachments-only mode — remove files and images while keeping the message text
* Type-to-confirm for large jobs (100+ messages); pause, resume, or cancel any run
* Single-conversation scope, auto-pauses on navigation drift, rate-limit aware pacing, and jobs resume reliably even if the browser restarts mid-cleanup

**Five more platforms, each optional**
Connect Reddit, X, Mastodon, Microsoft Teams, or Telegram independently from the popup — none is required to use Slack, and none is contacted until you click it.
* Reddit — bulk-delete your own comments, posts, or both
* X — bulk-delete your own posts
* Mastodon — works with any instance; you provide a personal access token
* Microsoft Teams — bulk-delete your own chat messages (work/school accounts)
* Telegram — bulk-delete your own messages via a real, in-browser MTProto client

Every platform follows the same scan → preview → confirm safety model: review and individually un-check matches before deleting, type-to-confirm for large batches, and cancel a run already in progress.

**Private by design, on every platform**
* 100% local — all scanning and deleting happen in your browser tab
* No servers, no accounts, no tracking, no content uploaded to us
* Works through your existing login on each platform — every credential stays in memory-only browser storage, never written to disk

**Convenient**
* Open the popup from the toolbar or with Alt+Shift+E (Cmd+Shift+K on macOS)
* Clean, modern interface with three colour themes
* Localized UI (English, Spanish, French, German) across all six platforms

---

**Please note:** Erasechat is an independent tool and is not affiliated with, endorsed by, or sponsored by Slack, Reddit, X Corp., Mastodon gGmbH, Microsoft, or Telegram FZ-LLC. It acts on your behalf using your existing session (or, for Mastodon/Telegram, a credential you provide) on whichever platform(s) you connect. Deletions are permanent and cannot be undone — always preview before you delete. Deleting content you do not have permission to remove may be restricted by your workspace, instance, or tenant administrator.

**Other people's messages:** two opt-in modes can remove other people's messages where the platform itself permits it — Slack's "All Messages" sender option (workspace admins/owners) and Telegram with "Only my messages" turned off. Both are off by default and every match is previewed first. Platforms with retention or compliance policies (common on Microsoft Teams and enterprise Slack) may keep server-side copies this tool cannot remove.
```

## "This add-on is experimental"

**Leave CHECKED for 1.0.0.**

The add-on permanently deletes user data and the live-Slack delete path has not yet been
exercised end to end. The badge sets honest expectations for a first release. It costs
discoverability (an experimental add-on is not eligible to be recommended/featured), and
it can be unchecked at any later version once the tool has real-world mileage — so the
cost is temporary and the honesty is not.

## "Requires payment / non-free services"

**Leave UNCHECKED.** The add-on is free, has no accounts, and no paid tier.

## Categories (up to 3)

> `STORE_LISTING.md` says "Productivity / Workflow & Planning" — that is the **Chrome**
> taxonomy. AMO has no Productivity category. Use these instead:

- [x] **Social & Communication** — primary; Slack is a communication tool
- [x] **Privacy & Security** — removing your own message history is data hygiene

Two is the right number. Nothing else on AMO's list genuinely fits, and padding with a
third weakens the placement rather than widening it.

## Support email
```
yogeshb@prosperix.com
```

## Support website
Provide the repository issues URL **only if the repository is public**; otherwise leave
this blank (the support email above is enough). `.githooks/pre-push` describes the repo as
private, and a private-repo link 404s for users and reviewers.

## License

**MIT** — it must match the `LICENSE` file shipped inside the package.

MIT is not among the first few radio buttons on the form; scroll the license list to find
it. If the visible list is short, choose the option that reveals the full set rather than
picking a near-neighbour: MPL/Apache/GPL are all materially different grants from MIT, and
the listing would then contradict the `LICENSE` file in the package.

## Privacy Policy

AMO accepts **pasted text** here, not only a hosted URL.

Paste the full contents of [`PRIVACY_POLICY.md`](../PRIVACY_POLICY.md).

(Chrome does require a hosted HTTPS URL; the file's GitHub URL satisfies that only while
the repository is public — see [`CWS_SUBMISSION_FIELDS.md`](./CWS_SUBMISSION_FIELDS.md).)

## Notes for Reviewer

> Worth writing carefully. A reviewer cannot test this add-on without a Slack account, and
> the extension reads a session token out of `localStorage` — which looks alarming without
> the context. Explaining it up front avoids an easy rejection.

```
Thanks for reviewing. Some context that should make testing straightforward.

WHAT IT DOES
Erasechat adds a dashboard to the Slack web client that lets a user bulk-delete
their OWN messages in the conversation they currently have open, with filters (sender,
date range, keyword or /regex/, attachments-only, thread replies), a mandatory scan-and-
preview step, and a resumable background delete queue.

HOW TO TEST
1. Sign in to any Slack workspace at https://app.slack.com (a free workspace is enough).
2. Open a channel or DM and post a few throwaway messages.
3. Click the toolbar icon, then "Open Clean Dashboard" (Alt+Shift+E opens the popup).
4. Choose filters and press "Scan Messages" — this is read-only and deletes nothing.
5. Review the previewed list, then press "Start Deleting".
   Jobs over 100 messages require typing DELETE to confirm.

EVERY SLACK API ENDPOINT USED, AND WHY
  conversations.history  read the open conversation to find matching messages
  conversations.replies  read thread replies, when "include threads" is enabled
  conversations.info     resolve the open conversation's name and type for the UI
  users.list             cache member display names so the preview can show "Alice"
                         instead of "U01ABC". Cached in local storage for 24h and used
                         only for rendering; never transmitted anywhere.
  chat.delete            delete one of the user's messages
  chat.update            attachments-only mode: strip files/attachments, keep the text
  files.info             check how many conversations a file is shared into, BEFORE
                         deleting it (see the safety note below)
  files.delete           remove a file the user is deleting along with its message

A deliberate safety detail: Slack's files.delete purges a file from every conversation it
was ever shared into, not just this one. So files.info is called first and the file is
left intact if it is shared anywhere else — cleaning one conversation can never destroy
content in another.

ABOUT THE SLACK TOKEN (please read — this is the part that looks unusual)
The extension reads the user's existing Slack session token from the Slack web app's own
localStorage key "localConfig_v2", in the Slack tab, and uses it to call the endpoints
above as that already-logged-in user.

- The token is never stored on disk. It is held in memory and in chrome.storage.session,
  which is cleared when the browser closes. A packaging test in the repository asserts
  that no token is ever written to storage.local.
- The token is never transmitted anywhere except slack.com. There is no backend, no
  analytics, no telemetry, and no third-party endpoint of any kind.
- This is the only way to act on the user's behalf without asking them to create a Slack
  app and paste an API token, which would be a far worse experience and a far worse
  security posture for a personal cleanup tool.

NO REMOTE CODE
All code is bundled in the package. Nothing is fetched or eval'd at runtime. The
extension-pages CSP is "script-src 'self'; object-src 'none'".

SOURCE
The Slack, Reddit, X, Mastodon and Teams code is unminified and readable exactly as
shipped. The one exception is Telegram: platforms/telegram/telegram-popup.bundle.js and
telegram-dashboard.bundle.js are webpack builds of telegram-popup.src.js /
telegram-dashboard.src.js plus the teleproto MTProto library (third-party license
notices ship alongside in *.bundle.js.LICENSE.txt). Source upload + reproduction:
npm ci && node scripts/build-telegram.js (Node >= 20.19). shared-filters.js holds the
single delete/keep decision function used by the background context.

DATA COLLECTION
None. Declared in the manifest as
browser_specific_settings.gecko.data_collection_permissions.required: ["none"].

OPTIONAL PLATFORMS BEYOND SLACK
The popup also offers five further platforms — Reddit, X, Mastodon, Microsoft Teams,
and Telegram — each connected explicitly, one at a time, from the popup's
platform picker. None is required to use Slack, and none is contacted until the user
clicks it. Each follows the same scan-preview-confirm-delete safety model as Slack, using
that platform's own existing session/login (or, for Mastodon/Telegram, credentials the
user supplies themselves) rather than any credential from the developer. See
PRIVACY_POLICY.md for the full per-platform data table if useful during review.

Happy to answer anything — yogeshb@prosperix.com
```

## Screenshots

Upload from `store-assets/screenshots/` in this order, with these captions:

AMO has no 5-screenshot cap the way Chrome does, so all 6 go here (see
`CWS_SUBMISSION_FIELDS.md` for why Chrome's listing drops one of these).

| # | File | Caption |
|---|---|---|
| 1 | `00-platforms.png` | One extension. Six platforms. |
| 2 | `01-overview.png` | Set your rules, target any conversation. |
| 3 | `02-preview.png` | Scan first. Preview every message before it goes. |
| 4 | `03-safety.png` | Deletes are permanent — so we make you confirm. |
| 5 | `04-progress.png` | Watch it work — live progress and logs. |
| 6 | `05-privacy.png` | 100% local. Nothing leaves your browser. |

## Version Notes (if asked)

```
First public release.

Bulk-deletes your own Slack messages in the conversation you have open, with filters for
sender, date range, keyword or /regex/, attachments-only and thread replies. Every run
starts with a scan-and-preview step, large jobs require typing DELETE, and the delete
queue is resumable if the browser or background worker restarts.

The Slack session token stays in memory-only session storage and is never written to
disk. No data leaves the browser except calls to Slack's own API.
```
