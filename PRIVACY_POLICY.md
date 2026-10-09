# Erasechat — Privacy Policy

**Last Updated:** October 9, 2026

## Overview

Erasechat is a browser extension that helps users bulk-delete their own content across six platforms: **Slack** (built in, always available) and five **optional** platforms the user can connect one at a time from the extension's popup: **Reddit, X, Mastodon, Microsoft Teams, and Telegram**. This privacy policy describes what data the extension accesses for each platform, how it is used, and how it is stored.

## Data Collection

Erasechat does **NOT** collect, transmit, sell, or share any user data with third parties, on any platform. All data processing happens entirely within your browser on your local device. There is no developer-operated backend server anywhere in this extension — every network request goes directly from your browser to the platform you're managing.

Connecting a platform beyond Slack is always something you do explicitly, one click at a time, from the popup's platform picker — nothing beyond Slack is ever contacted automatically.

### Data the Extension Accesses, Per Platform

**Slack** (built in)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Slack session token | Authenticate API calls to delete your messages | Browser memory only (`chrome.storage.session`) | Cleared when browser closes |
| "Job is running" flag (one per active job, no content) | Tell a service-worker restart apart from a browser restart, so a destructive job never auto-resumes after the browser was closed | Browser memory only (`chrome.storage.session`) | Cleared when the job stops or the browser closes |
| Workspace name, URL, and user ID | Display connection info in the dashboard | Browser memory only (runtime variable) | Cleared when tab is closed |
| Workspace member display names | Show human-readable names in scan results | Local browser storage (`chrome.storage.local`) | 24-hour cache, auto-expires |
| Message metadata (timestamps, author user IDs, file IDs, and — only for "preserve text" edits — the message text) | Track deletion queue progress and enable pause/resume/recovery | Local browser storage (`chrome.storage.local`) | Cleared when deletion completes or is cancelled; a paused job keeps it until you resume or cancel, and is automatically discarded after 30 days |
| The most recent scan result for a conversation (the matched messages' IDs, timestamps, authors and text) | Deliver a long-running scan's result to the dashboard without re-scanning | Browser memory only (background service worker variable) — never written to disk | Discarded after 10 minutes, or sooner when the service worker stops |
| The last scan's message timestamps and their author user IDs (no message text) | Accept a delete request only for messages this extension's own scan returned, and re-check authorship in "my messages" mode | Browser memory only (`chrome.storage.session`) | Replaced by the next scan of that conversation; cleared when the browser closes |
| Saved filter presets you create (keywords, /regex/ patterns, date and option settings) | Re-apply a filter in one click | Local browser storage (`chrome.storage.local`) | Until you delete the preset |
| Current channel ID and name | Scope operations to the active conversation | Browser memory only (runtime variable) | Cleared when tab is closed |

**Reddit** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your existing reddit.com session cookie | Detect that you're logged in, and authenticate scan/delete calls | Read via the browser's own cookie jar (`cookies` permission); never copied into extension storage | N/A — read live from the browser each time |
| Reddit "modhash" | Required by Reddit's own API to authorize a delete call | Browser memory only (`chrome.storage.session`) | Cleared when browser closes or you disconnect Reddit |
| Your Reddit username | Display connection info and label items in the dashboard | `chrome.storage.local` | Until you disconnect Reddit in the popup (or reconnect) |
| Post/comment text, subreddit, and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**X** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your existing x.com/twitter.com session cookie (`ct0` CSRF token) | Authenticate scan/delete calls as you | Browser memory only (`chrome.storage.session`) — never your login password or the underlying session cookie itself | Cleared when browser closes or you disconnect X |
| Your X username | Show which account is connected and block deleting from a different account than the one scanned | `chrome.storage.local` | Until you disconnect X in the popup (or reconnect) |
| Tweet text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**Mastodon** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| A personal access token you generate yourself on your chosen instance | Authenticate API calls to your chosen instance | Browser memory only (`chrome.storage.session`) | Cleared when browser closes or you disconnect Mastodon (the token itself stays valid on your instance until you revoke it there under Preferences → Development) |
| The instance URL you type (e.g. `mastodon.social`), your account username and numeric account ID | Display connection info and reconnect to the right instance | `chrome.storage.local` | Until you disconnect Mastodon in the popup (or reconnect) |
| Toot text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Because Mastodon is federated, host permission is requested narrowly for the **one specific instance you typed** — never a blanket grant across every Mastodon server.

**Microsoft Teams** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| A Bearer token passively observed from your own already-authenticated Teams web-client traffic | Authenticate scan/delete calls to Teams' chat API | Browser memory only (`chrome.storage.session`) | Cleared when browser closes or you disconnect Teams |
| A "connection pending" hint while you open Teams to finish connecting | Show the right next step in the popup | Browser memory only (`chrome.storage.session`) | Cleared when browser closes or you disconnect Teams |
| The Teams API base URL your tenant uses | Route API calls correctly on reconnect | `chrome.storage.local` | Until you disconnect Teams in the popup (or reconnect) |
| Chat message text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Teams token capture requires the optional `webRequest` permission and only activates once you grant it for the Teams platform specifically; it is never active for any other site.

**Telegram** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your MTProto session string (created after you complete phone/code/2FA login) | Authenticate as you without repeating login on every visit | Browser memory only (`chrome.storage.session`) | Cleared when browser closes, when you click **Log out** in the Telegram dashboard (which also ends the session on Telegram's servers), or when you disconnect Telegram |
| Your own Telegram `api_id`/`api_hash` (obtained by you from Telegram's own developer portal — identifies the app, not your account) | Required to reconnect an MTProto client | `chrome.storage.local` | Until you disconnect Telegram in the popup (or reconnect) |
| The phone number you type in the popup | Handed to the Telegram dashboard tab to continue login | Browser memory only (`chrome.storage.session`) | Deleted as soon as the dashboard reads it |
| Message text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**Log out** in the Telegram dashboard revokes the session server-side via `auth.LogOut`, not just locally, so it disappears from Telegram's *Active sessions* list. Simply closing the browser clears the local copy but does not end the session on Telegram's side — use Log out (or Telegram's own *Settings → Devices*) for that. Telegram communication happens directly between your browser and Telegram's own MTProto servers over WebSockets — no intermediary server of any kind.

### Why this changed from earlier drafts

An earlier version of this policy, and of the extension itself, stored every one of the
five non-Slack platforms' credentials in `chrome.storage.local` (disk-persisted, survives
a browser restart). On review, the credentials that grant standing access to an entire
account — Telegram's session string and Mastodon's access token especially, and to a
lesser extent Teams' Bearer token — did not belong there: anyone with access to the
browser profile's files could read them with no browser even open, a materially
different risk than Slack's own `chrome.storage.session`-only token was designed to
avoid from the start. All five now follow the same rule as Slack: the credential itself
is memory-only and disappears when the browser closes; only non-sensitive labels
(username, instance URL, API base URL, app identity) persist to disk, purely for
convenience on reconnect. The trade-off is the same one Slack's users already accept —
reconnecting once per browser session — in exchange for nothing capable of account
takeover sitting on disk.

### A note on delete-progress markers

For all five non-Slack platforms, a small marker (just two numbers — how many items were processed and the total) is written to `chrome.storage.local` while a deletion is actively running, so that if the browser tab is closed or crashes mid-delete, the next time you open that platform's dashboard you're told a previous run was interrupted rather than being left with no idea what happened. This marker never contains message content, is cleared automatically when a deletion finishes, and cannot be used to resume a delete without you running a fresh scan first.

### Whose content can be deleted

By default every platform targets **only your own** messages, posts, or comments. Two
opt-in modes go further, and only where the platform itself allows it:

- **Slack — "All Messages" sender mode** (intended for workspace admins/owners): can delete
  other members' messages in the open conversation if your Slack role permits it. Saved
  presets can never switch to this mode on their own.
- **Telegram — "Only my messages" turned off**: shows every message in the chat, labelled
  *You* / *Someone else*; selected messages are deleted for everyone where Telegram permits
  it (for example both sides of a private chat, or a group you administer). Only your own
  messages are pre-selected.

In both cases the other people's message text is processed exactly like your own: shown
locally in the preview, never transmitted anywhere but the platform's own API.

### What deletion can and cannot remove

Erasechat deletes through each platform's normal delete action. It cannot override a
platform's or organization's **retention, legal-hold, eDiscovery, or compliance-export**
settings: Microsoft Teams tenants and enterprise Slack plans in particular may keep
server-side copies of deleted messages that are invisible to you and that this tool cannot
remove. Copies already seen by others (notifications, emails, screenshots, other clients'
caches, federated Mastodon servers) are also outside its reach.

### Data the Extension Does NOT Access, On Any Platform

- No browsing history, bookmarks, or unrelated cookies are accessed on any platform — only the specific session/auth cookie or token each platform's own login mechanism requires, as described above.
- No personal information beyond what's needed to authenticate as you and display scan results is processed.
- Message/post/toot/tweet content is **never persisted to disk** for any platform except: (a) Slack's own "preserve text" attachment-only mode, exactly as before, and (b) the small numeric delete-progress marker described above (which contains no content, only counts).

## How Data is Used

All data accessed by Erasechat, on every platform, is used exclusively for that platform's own core scan/delete functionality — authenticating your own requests, showing you what will be deleted before you confirm, and tracking in-progress deletion state. Nothing is aggregated, profiled, or used for any purpose beyond the operation you explicitly started.

## Data Storage

- **No data is transmitted to external servers.** Every network call goes directly from your browser to the platform being managed (Slack, reddit.com, x.com, your chosen Mastodon instance, teams.cloud.microsoft / teams.microsoft.com, or Telegram's own MTProto servers).
- **Export and import stay on your device.** "Export CSV/JSON" builds the file in your browser and saves it through your browser's normal download. Importing a Reddit data export or an X archive reads the files you pick locally; nothing is uploaded, and the imported items are kept only in that dashboard tab's memory.
- **No platform's credential is ever written to disk.** Slack's session token, Reddit's modhash, X's CSRF token, Mastodon's access token, the Teams Bearer token, and Telegram's session string are all stored only in `chrome.storage.session` — memory-only, cleared the moment the browser closes. None of them is ever synced to any account or server by this extension, and none survives a browser restart; reconnecting a platform after restarting the browser is a deliberate trade-off in favor of not leaving a standing credential on disk.
- **Non-sensitive labels persist to disk for convenience** — your Reddit/X/Mastodon username, the Mastodon instance URL, the Teams API base URL, and Telegram's `api_id`/`api_hash` (which identify the app, not your account) are kept in `chrome.storage.local` so the popup can show you're connected and route requests correctly without re-deriving them from scratch. None of these can authenticate a request on their own.
- **Deletion queue state and user-name caches** are temporarily persisted where noted above and are automatically cleared on completion, cancellation, or (for the name cache) after 24 hours. A paused Slack job that is never resumed or cancelled is discarded automatically after 30 days.
- **The last Slack scan result** is held only in the background service worker's memory, for at most 10 minutes, and is never written to disk.

## Data Sharing

Erasechat does **not**, on any of the six platforms:
- Transmit any data to third-party servers
- Include any analytics, telemetry, or tracking code
- Use advertising networks or data brokers
- Share data with any entity other than the platform you're directly operating on, at your own explicit direction

## Permissions

| Permission | Justification |
|---|---|
| `storage` | Store deletion queue state and user name cache locally; hold every platform's connection credential in memory-only session storage, and non-sensitive connection labels (username, instance URL, base URL) locally |
| `scripting` | Inject the dashboard UI into the Slack web client tab |
| `alarms` | Schedule Slack deletion queue processing in the background |
| `host_permissions: *.slack.com`, `slack.com` | Inject the content script and call Slack's REST API |
| `optional_permissions: cookies` | Read the Reddit/X session cookie already present in your browser, only after you choose to connect that specific platform |
| `optional_permissions: webRequest` | Passively observe your own Microsoft Teams web-client traffic to capture an auth token, only after you choose to connect Teams |
| `optional_host_permissions: *.reddit.com`, `*.x.com`, `*.twitter.com`, `*.teams.microsoft.com`, `*.msg.teams.microsoft.com`, `*.teams.cloud.microsoft` | Call each platform's own API, requested only when you connect that specific platform |
| `optional_host_permissions: https://*/*` | The declared upper bound Chrome requires so a **narrow, runtime-resolved** request can be legal: Mastodon requests only the exact instance you typed — this permission is never granted broadly, and nothing is requested from it until you connect Mastodon specifically |

Telegram needs no host permission at all — it communicates over its own native MTProto/WebSocket transport, not ordinary web requests.

## User Control

- You can **pause, resume, or cancel** any Slack deletion operation at any time; the five
  other platforms support cancelling a deletion already in progress.
- Every platform's scan results can be **reviewed and individually deselected** before you
  confirm a delete — a scan is a starting point, not an all-or-nothing commitment.
- You can **close a dashboard tab** to stop all operations for that platform.
- You can **disconnect any of the five optional platforms** independently from the popup. Disconnecting clears that platform's stored credential and labels from extension storage and removes the browser permissions it was granted; connecting or disconnecting one never affects the others, and none of them are required to use Slack.
- On Telegram, **Log out** in the dashboard also ends the session on Telegram's servers.
- You can **uninstall the extension** at any time, which clears all stored data across every platform.
- Deletion operations require explicit confirmation on every platform, including a stricter "type the exact count" verification step for large batches (more than 100 items) rather than a fixed one-word confirmation.

## Security

- Every platform's credential — Slack included — is stored in memory-only storage
  (`chrome.storage.session`) and never persisted to disk; none is transmitted anywhere
  but that platform's own API.
- The Slack dashboard UI is rendered inside a Shadow DOM to isolate it from the host page.
- All message sender origins are validated before processing.
- User-provided text filters are sanitized against regex denial-of-service (ReDoS) attacks.
- Scanned content (message/post/toot/tweet text) is always rendered as plain text in every dashboard, never as raw HTML, so content you're reviewing can't execute code in the extension's own pages.
- Every scan result can be reviewed and individually deselected before deleting (not just
  previewed as an all-or-nothing batch), and every platform's dashboard lets you cancel a
  deletion that's already in progress.

## Children's Privacy

Erasechat is not directed at children under 13 and does not knowingly collect personal information from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last Updated" date at the top of this document.

## Contact

Questions about this privacy policy, or a request concerning your data: email
**yogeshb@prosperix.com**, or contact the developer through the browser extension store
listing. (The extension holds no data about you on any server, so there is nothing for the
developer to export or delete — everything listed above lives in your own browser and is
removed by disconnecting a platform or uninstalling the extension.)

## Appendix: every storage key the extension writes

For reviewers and the curious — the complete list of `chrome.storage` keys, matching the
tables above. `<team>`/`<channel>` are Slack IDs. An automated test
(`tests/packaging.test.js`) fails if the code starts writing a key that is not listed here.

| Key | Area | What it holds |
|---|---|---|
| `sc_token_<team>` | session | Slack session token |
| `sc_run_<job>` | session | "job is running" flag (no content) |
| `sc_scan_<team>_<channel>` | session | Last scan's message timestamps → author user IDs (no text) |
| `slack_state_<team>_<channel>` | local | Slack deletion job state (progress counters, pause/run flags, settings) |
| `slack_q_<team>_<channel>` | local | Slack deletion queue (message metadata; text only for "preserve text" edits) |
| `sc_user_cache_<team>` | local | Workspace member display names (24 h cache) |
| `erasechatFilterPresets` | local | Your saved Slack filter presets |
| `erasechat_onboarding_complete` | local | Whether the first-run introduction was dismissed |
| `reddit_modhash` | session | Reddit modhash |
| `reddit_username` | local | Your Reddit username |
| `x_csrf` | session | X `ct0` CSRF token |
| `x_username` | local | Your X username |
| `mstdn_token` | session | Mastodon access token |
| `mstdn_host`, `mstdn_username`, `mstdn_user_id` | local | Mastodon instance, username, numeric account ID |
| `teams_token` | session | Teams Bearer token |
| `teams_connect_pending` | session | Teams "finish connecting" hint |
| `teams_base_url` | local | Teams API base URL |
| `tg_session` | session | Telegram MTProto session string |
| `tg_login_handoff` | session | Phone number typed in the popup, handed to the Telegram dashboard tab; deleted as soon as the dashboard reads it |
| `tg_api_id`, `tg_api_hash` | local | Your Telegram app identity |
| `reddit_delete_progress`, `x_delete_progress`, `mastodon_delete_progress`, `teams_delete_progress`, `telegram_delete_progress` | local | Delete-progress marker (two numbers) |

Keys from older versions (`slackclean_state_*`, `sc_q_*`) are migrated to the names above
on update and then removed.
