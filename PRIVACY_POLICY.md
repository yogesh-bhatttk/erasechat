# Erasechat — Privacy Policy

**Last Updated:** September 10, 2026

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
| Workspace name, URL, and user ID | Display connection info in the dashboard | Browser memory only (runtime variable) | Cleared when tab is closed |
| Workspace member display names | Show human-readable names in scan results | Local browser storage (`chrome.storage.local`) | 24-hour cache, auto-expires |
| Message metadata (timestamps, author user IDs, file IDs, and — only for "preserve text" edits — the message text) | Track deletion queue progress and enable pause/resume/recovery | Local browser storage (`chrome.storage.local`) | Cleared when deletion completes or is cancelled |
| Current channel ID and name | Scope operations to the active conversation | Browser memory only (runtime variable) | Cleared when tab is closed |

**Reddit** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your existing reddit.com session cookie | Detect that you're logged in, and authenticate scan/delete calls | Read via the browser's own cookie jar (`cookies` permission); never copied into extension storage | N/A — read live from the browser each time |
| Reddit "modhash" | Required by Reddit's own API to authorize a delete call | Browser memory only (`chrome.storage.session`) | Cleared when browser closes |
| Your Reddit username | Display connection info and label items in the dashboard | `chrome.storage.local` | Until you disconnect/reconnect Reddit |
| Post/comment text, subreddit, and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**X** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your existing x.com/twitter.com session cookie (`ct0` CSRF token) | Authenticate scan/delete calls as you | Browser memory only (`chrome.storage.session`) — never your login password or the underlying session cookie itself | Cleared when browser closes |
| Tweet text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**Mastodon** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| A personal access token you generate yourself on your chosen instance | Authenticate API calls to your chosen instance | Browser memory only (`chrome.storage.session`) | Cleared when browser closes |
| The instance URL you type (e.g. `mastodon.social`) and your account username | Display connection info and reconnect to the right instance | `chrome.storage.local` | Until you disconnect/reconnect Mastodon |
| Toot text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Because Mastodon is federated, host permission is requested narrowly for the **one specific instance you typed** — never a blanket grant across every Mastodon server.

**Microsoft Teams** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| A Bearer token passively observed from your own already-authenticated Teams web-client traffic | Authenticate scan/delete calls to Teams' chat API | Browser memory only (`chrome.storage.session`) | Cleared when browser closes |
| The Teams API base URL your tenant uses | Route API calls correctly on reconnect | `chrome.storage.local` | Until you disconnect/reconnect Teams |
| Chat message text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Teams token capture requires the optional `webRequest` permission and only activates once you grant it for the Teams platform specifically; it is never active for any other site.

**Telegram** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your MTProto session string (created after you complete phone/code/2FA login) | Authenticate as you without repeating login on every visit | Browser memory only (`chrome.storage.session`) | Cleared when browser closes |
| Your own Telegram `api_id`/`api_hash` (obtained by you from Telegram's own developer portal — identifies the app, not your account) | Required to reconnect an MTProto client | `chrome.storage.local` | Until you disconnect/reconnect |
| Message text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Logging out also revokes the session server-side via `auth.LogOut`, not just locally. Telegram communication happens directly between your browser and Telegram's own MTProto servers over WebSockets — no intermediary server of any kind.

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

### Data the Extension Does NOT Access, On Any Platform

- No browsing history, bookmarks, or unrelated cookies are accessed on any platform — only the specific session/auth cookie or token each platform's own login mechanism requires, as described above.
- No personal information beyond what's needed to authenticate as you and display scan results is processed.
- Message/post/toot/tweet content is **never persisted to disk** for any platform except: (a) Slack's own "preserve text" attachment-only mode, exactly as before, and (b) the small numeric delete-progress marker described above (which contains no content, only counts).

## How Data is Used

All data accessed by Erasechat, on every platform, is used exclusively for that platform's own core scan/delete functionality — authenticating your own requests, showing you what will be deleted before you confirm, and tracking in-progress deletion state. Nothing is aggregated, profiled, or used for any purpose beyond the operation you explicitly started.

## Data Storage

- **No data is transmitted to external servers.** Every network call goes directly from your browser to the platform being managed (Slack, reddit.com, x.com, your chosen Mastodon instance, teams.microsoft.com, or Telegram's own MTProto servers).
- **No platform's credential is ever written to disk.** Slack's session token, Reddit's modhash, X's CSRF token, Mastodon's access token, the Teams Bearer token, and Telegram's session string are all stored only in `chrome.storage.session` — memory-only, cleared the moment the browser closes. None of them is ever synced to any account or server by this extension, and none survives a browser restart; reconnecting a platform after restarting the browser is a deliberate trade-off in favor of not leaving a standing credential on disk.
- **Non-sensitive labels persist to disk for convenience** — your Reddit/Mastodon username, the Mastodon instance URL, the Teams API base URL, and Telegram's `api_id`/`api_hash` (which identify the app, not your account) are kept in `chrome.storage.local` so the popup can show you're connected and route requests correctly without re-deriving them from scratch. None of these can authenticate a request on their own.
- **Deletion queue state and user-name caches** are temporarily persisted where noted above and are automatically cleared on completion, cancellation, or (for the name cache) after 24 hours.

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
| `optional_host_permissions: *.reddit.com`, `*.x.com`, `*.twitter.com`, `*.teams.microsoft.com`, `*.msg.teams.microsoft.com` | Call each platform's own API, requested only when you connect that specific platform |
| `optional_host_permissions: https://*/*` | The declared upper bound Chrome requires so a **narrow, runtime-resolved** request can be legal: Mastodon requests only the exact instance you typed — this permission is never granted broadly, and nothing is requested from it until you connect Mastodon specifically |

Telegram needs no host permission at all — it communicates over its own native MTProto/WebSocket transport, not ordinary web requests.

## User Control

- You can **pause, resume, or cancel** any Slack deletion operation at any time; the five
  other platforms support cancelling a deletion already in progress.
- Every platform's scan results can be **reviewed and individually deselected** before you
  confirm a delete — a scan is a starting point, not an all-or-nothing commitment.
- You can **close a dashboard tab** to stop all operations for that platform.
- You can **disconnect any of the five optional platforms** independently — connecting one never affects the others, and none of them are required to use Slack.
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

If you have questions about this privacy policy, please open an issue on the extension's support page or contact the developer through the browser extension store listing.
