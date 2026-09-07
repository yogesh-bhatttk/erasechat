# AMO "Describe Add-on" — exact field values

Copy-paste values for the Firefox Add-ons submission form, in the order the form asks.
Kept separate from `STORE_LISTING.md` because that file is written against the **Chrome**
Web Store's taxonomy, which does not match AMO's (see Categories below).

> **⚠️ Stale as of 2026-09-07.** This file was written before the extension grew from
> Slack-only into a 7-platform tool (Slack plus optional Reddit, X, Mastodon, Microsoft
> Teams, Bluesky, and Telegram, each connected explicitly from the popup). The
> `data_collection_permissions: ["none"]` claim below still holds — nothing is
> transmitted to the developer on any of the seven platforms, only stored locally on the
> user's own device — but the Description and Notes for Reviewer text still describe
> Slack only. Before a real submission, at minimum add a paragraph to Notes for Reviewer
> along the lines of the "OPTIONAL PLATFORMS BEYOND SLACK" addendum in
> `CWS_SUBMISSION_FIELDS.md`, and update the Description to mention the six optional
> platforms exist. Screenshots further down are also Slack-only and unchanged.

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
_AMO shows this in listings and search. Already correct on the form._
```
Bulk delete and clean your Slack messages in channels and DMs with advanced filters, threads, and safety controls.
```

## Description

> **Do not reuse the summary here.** The form currently has the summary text pasted into
> the description; AMO recommends ~250+ characters and this is the field that sells the
> add-on on its product page. Use the full text below (AMO supports light Markdown).

```
Tired of scrolling back years to clean up your Slack? Erasechat clears your own messages in bulk — with the filters and safety controls to do it right.

Open any channel, private group, or direct message, pick your filters, preview exactly what will be removed, and delete in bulk — all from your browser.

**Precise filters**
* Target your own messages in the current conversation
* By date — all time, older than X days, or a custom date range
* By keyword, phrase, or /regex/ pattern
* Include thread replies, or leave threads untouched
* Attachments-only mode — remove files and images while keeping the message text

**Scan and preview before anything is deleted**
* Run a scan to see every matching message first
* Un-check anything you want to keep — you are always in control
* Export the matched messages as a CSV backup in one click

**Safety built in**
* Type-to-confirm for large jobs (100+ messages)
* Pause, resume, or cancel any run at any time
* Single-conversation scope — it only touches the chat you opened
* Auto-pauses if you navigate to a different channel or workspace mid-run
* Rate-limit aware pacing that honours Slack's Retry-After
* Jobs resume reliably even if the browser restarts mid-cleanup

**Private by design**
* 100% local — all scanning and deleting happen in your browser tab
* No servers, no accounts, no tracking, no message content uploaded
* Works through your existing Slack login — no passwords or tokens to enter

**Convenient**
* Open the dashboard from the toolbar or with Ctrl+Shift+K (Cmd+Shift+K on macOS)
* Clean, modern interface with three colour themes

---

**Please note:** Erasechat is an independent tool and is not affiliated with, endorsed by, or sponsored by Slack. It acts on your behalf using your existing Slack session. Deletions are permanent and cannot be undone — always preview (and export a backup) before you delete. Deleting messages you do not have permission to remove may be restricted by your workspace.
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
```
https://github.com/yogesh-bhatttk/bulk-clean-for-slack/issues
```

> Updated 2026-08-02. This field previously said to leave it blank because the repo was
> private and the link would 404. **The repo is public now**, so the issues page is a real
> support destination — if the AMO listing is already submitted, go back and add it.

## License

**MIT** — it must match the `LICENSE` file shipped inside the package.

MIT is not among the first few radio buttons on the form; scroll the license list to find
it. If the visible list is short, choose the option that reveals the full set rather than
picking a near-neighbour: MPL/Apache/GPL are all materially different grants from MIT, and
the listing would then contradict the `LICENSE` file in the package.

## Privacy Policy

AMO accepts **pasted text** here, not only a hosted URL.

Paste the full contents of [`PRIVACY_POLICY.md`](../PRIVACY_POLICY.md).

(Chrome does require a hosted HTTPS URL. Now that the repo is public, the file's GitHub
URL satisfies that — see [`CWS_SUBMISSION_FIELDS.md`](./CWS_SUBMISSION_FIELDS.md).)

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
3. Click the toolbar icon, then "Open Clean Dashboard" (or Ctrl+Shift+K).
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
The source is unminified and readable exactly as shipped; there is no build step that
transforms it. shared-filters.js holds the single delete/keep decision function used by
the background context.

DATA COLLECTION
None. Declared in the manifest as
browser_specific_settings.gecko.data_collection_permissions.required: ["none"].

OPTIONAL PLATFORMS BEYOND SLACK
The popup also offers six further platforms — Reddit, X, Mastodon, Microsoft Teams,
Bluesky, and Telegram — each connected explicitly, one at a time, from the popup's
platform picker. None is required to use Slack, and none is contacted until the user
clicks it. Each follows the same scan-preview-confirm-delete safety model as Slack, using
that platform's own existing session/login (or, for Mastodon/Telegram, credentials the
user supplies themselves) rather than any credential from the developer. See
PRIVACY_POLICY.md for the full per-platform data table if useful during review.

Happy to answer anything — yogeshb@prosperix.com
```

## Screenshots

Upload from `store-assets/screenshots/` in this order, with these captions:

| # | File | Caption |
|---|---|---|
| 1 | `01-overview.png` | Set your rules, target any conversation. |
| 2 | `02-preview.png` | Scan first. Preview every message before it goes. |
| 3 | `03-safety.png` | Deletes are permanent — so we make you confirm. |
| 4 | `04-progress.png` | Watch it work — live progress and logs. |
| 5 | `05-privacy.png` | 100% local. Nothing leaves your browser. |

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
