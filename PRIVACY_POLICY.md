# Bulk Clean for Slack — Privacy Policy

**Last Updated:** September 7, 2026

## Overview

Bulk Clean for Slack is a browser extension that helps users bulk-delete their own content across seven platforms: **Slack** (built in, always available) and six **optional** platforms the user can connect one at a time from the extension's popup: **Reddit, X, Mastodon, Microsoft Teams, Bluesky, and Telegram**. This privacy policy describes what data the extension accesses for each platform, how it is used, and how it is stored.

## Data Collection

Bulk Clean for Slack does **NOT** collect, transmit, sell, or share any user data with third parties, on any platform. All data processing happens entirely within your browser on your local device. There is no developer-operated backend server anywhere in this extension — every network request goes directly from your browser to the platform you're managing (or, for Bluesky, to the AT Protocol server your account actually lives on).

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
| Reddit "modhash" and username | Required by Reddit's own API to authorize a delete call | `chrome.storage.local` | Until you disconnect/reconnect Reddit |
| Post/comment text, subreddit, and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**X** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your existing x.com/twitter.com session cookie (`ct0` CSRF token) | Authenticate scan/delete calls as you | `chrome.storage.local` (the CSRF token only — never your login password or the underlying session cookie itself) | Until you disconnect/reconnect X |
| Tweet text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

**Mastodon** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| The instance URL you type (e.g. `mastodon.social`) and a personal access token you generate yourself on that instance | Authenticate API calls to your chosen instance | `chrome.storage.local` | Until you disconnect/reconnect Mastodon |
| Toot text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Because Mastodon is federated, host permission is requested narrowly for the **one specific instance you typed** — never a blanket grant across every Mastodon server.

**Microsoft Teams** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| A Bearer token passively observed from your own already-authenticated Teams web-client traffic | Authenticate scan/delete calls to Teams' chat API | `chrome.storage.local` | Until you disconnect/reconnect Teams |
| Chat message text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Teams token capture requires the optional `webRequest` permission and only activates once you grant it for the Teams platform specifically; it is never active for any other site.

**Bluesky** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| OAuth 2.0 + PKCE + DPoP session (access/refresh tokens, DPoP signing key) | Authenticate scan/delete calls to your account's AT Protocol server (PDS) | Managed entirely by the official `@atproto/oauth-client-browser` library in the browser's IndexedDB — not in `chrome.storage` | Until you log out (which now correctly revokes the session server-side) or the token naturally expires |
| Post/repost text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Bluesky login uses `chrome.identity.launchWebAuthFlow` against the real, publicly-hosted OAuth client metadata this project maintains (see `client-metadata.json`) — no separate developer server is involved beyond that static, publicly-auditable metadata file.

**Telegram** (optional, connected on request)

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| Your own Telegram `api_id`/`api_hash` (obtained by you from Telegram's own developer portal) and phone/code/2FA login | Authenticate an MTProto session as you | `chrome.storage.local` | Until you disconnect/reconnect (logout now also revokes the session server-side via `auth.LogOut`) |
| Message text and timestamps | Shown in the scan-results preview before you confirm a delete | Browser memory only, for the current dashboard tab | Cleared when the tab closes or a new scan runs |

Telegram communication happens directly between your browser and Telegram's own MTProto servers over WebSockets — no intermediary server of any kind.

### A note on delete-progress markers

For all six non-Slack platforms, a small marker (just two numbers — how many items were processed and the total) is written to `chrome.storage.local` while a deletion is actively running, so that if the browser tab is closed or crashes mid-delete, the next time you open that platform's dashboard you're told a previous run was interrupted rather than being left with no idea what happened. This marker never contains message content, is cleared automatically when a deletion finishes, and cannot be used to resume a delete without you running a fresh scan first.

### Data the Extension Does NOT Access, On Any Platform

- No browsing history, bookmarks, or unrelated cookies are accessed on any platform — only the specific session/auth cookie or token each platform's own login mechanism requires, as described above.
- No personal information beyond what's needed to authenticate as you and display scan results is processed.
- Message/post/toot/tweet content is **never persisted to disk** for any platform except: (a) Slack's own "preserve text" attachment-only mode, exactly as before, and (b) the small numeric delete-progress marker described above (which contains no content, only counts).

## How Data is Used

All data accessed by Bulk Clean for Slack, on every platform, is used exclusively for that platform's own core scan/delete functionality — authenticating your own requests, showing you what will be deleted before you confirm, and tracking in-progress deletion state. Nothing is aggregated, profiled, or used for any purpose beyond the operation you explicitly started.

## Data Storage

- **No data is transmitted to external servers.** Every network call goes directly from your browser to the platform being managed (Slack, reddit.com, x.com, your chosen Mastodon instance, teams.microsoft.com, your account's Bluesky PDS, or Telegram's own MTProto servers).
- **Slack session tokens are never written to disk** — stored only in `chrome.storage.session`, cleared when the browser closes.
- **The other six platforms' credentials** (Reddit modhash, X CSRF token, Mastodon access token, Teams Bearer token, Telegram session string) are stored in `chrome.storage.local` so you don't have to reconnect every time you open the extension — this is standard, expected behavior for a browser extension and stays entirely on your device (`chrome.storage.local` is never synced to any account or server by this extension). Bluesky is the one exception: its OAuth session lives in IndexedDB, managed by the official AT Protocol client library, not by this extension's own code.
- **Deletion queue state and user-name caches** are temporarily persisted where noted above and are automatically cleared on completion, cancellation, or (for the name cache) after 24 hours.

## Data Sharing

Bulk Clean for Slack does **not**, on any of the seven platforms:
- Transmit any data to third-party servers
- Include any analytics, telemetry, or tracking code
- Use advertising networks or data brokers
- Share data with any entity other than the platform you're directly operating on, at your own explicit direction

## Permissions

| Permission | Justification |
|---|---|
| `storage` | Store deletion queue state, user name cache, and (for the six non-Slack platforms) connection credentials, all locally |
| `scripting` | Inject the dashboard UI into the Slack web client tab |
| `alarms` | Schedule Slack deletion queue processing in the background |
| `host_permissions: *.slack.com`, `slack.com` | Inject the content script and call Slack's REST API |
| `optional_permissions: cookies` | Read the Reddit/X session cookie already present in your browser, only after you choose to connect that specific platform |
| `optional_permissions: webRequest` | Passively observe your own Microsoft Teams web-client traffic to capture an auth token, only after you choose to connect Teams |
| `optional_permissions: identity` | Run Bluesky's OAuth login flow (`chrome.identity.launchWebAuthFlow`), only after you choose to connect Bluesky |
| `optional_host_permissions: *.reddit.com`, `*.x.com`, `*.twitter.com`, `*.teams.microsoft.com`, `*.msg.teams.microsoft.com` | Call each platform's own API, requested only when you connect that specific platform |
| `optional_host_permissions: https://*/*` | The declared upper bound Chrome requires so a **narrow, runtime-resolved** request can be legal: Mastodon requests only the exact instance you typed, and Bluesky requests only what its OAuth library resolves for your account's actual PDS — this permission is never granted broadly, and nothing is requested from it until you connect Mastodon or Bluesky specifically |

Telegram needs no host permission at all — it communicates over its own native MTProto/WebSocket transport, not ordinary web requests.

## User Control

- You can **pause, resume, or cancel** any Slack deletion operation at any time.
- You can **close a dashboard tab** to stop all operations for that platform.
- You can **disconnect any of the six optional platforms** independently — connecting one never affects the others, and none of them are required to use Slack.
- You can **uninstall the extension** at any time, which clears all stored data across every platform.
- Deletion operations require explicit confirmation on every platform, including a stricter "type the exact count" verification step for large batches (more than 100 items) rather than a fixed one-word confirmation.

## Security

- Slack's session token is stored in memory-only storage and never persisted to disk; the other platforms' tokens are stored locally on your device only, never transmitted anywhere but that platform's own API.
- The Slack dashboard UI is rendered inside a Shadow DOM to isolate it from the host page.
- All message sender origins are validated before processing.
- User-provided text filters are sanitized against regex denial-of-service (ReDoS) attacks.
- Scanned content (message/post/toot/tweet text) is always rendered as plain text in every dashboard, never as raw HTML, so content you're reviewing can't execute code in the extension's own pages.

## Children's Privacy

Bulk Clean for Slack is not directed at children under 13 and does not knowingly collect personal information from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last Updated" date at the top of this document.

## Contact

If you have questions about this privacy policy, please open an issue on the extension's support page or contact the developer through the browser extension store listing.
