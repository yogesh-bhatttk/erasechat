# Bulk Clean for Slack — Privacy Policy

**Last Updated:** July 22, 2026

## Overview

Bulk Clean for Slack is a browser extension that helps users bulk-delete their own Slack messages. This privacy policy describes what data the extension accesses, how it is used, and how it is stored.

## Data Collection

Bulk Clean for Slack does **NOT** collect, transmit, sell, or share any user data with third parties. All data processing happens entirely within your browser on your local device.

### Data the Extension Accesses

| Data Type | Purpose | Storage Location | Retention |
|---|---|---|---|
| **Slack session token** | Authenticate API calls to delete your messages | Browser memory only (`chrome.storage.session`) | Cleared when browser closes |
| **Workspace name, URL, and user ID** | Display connection info in the dashboard | Browser memory only (runtime variable) | Cleared when tab is closed |
| **Workspace member display names** | Show human-readable names in scan results | Local browser storage (`chrome.storage.local`) | 24-hour cache, auto-expires |
| **Message metadata (timestamps, author user IDs, file IDs, and — only for "preserve text" edits — the message text)** | Track deletion queue progress and enable pause/resume/recovery | Local browser storage (`chrome.storage.local`) | Cleared when deletion completes or is cancelled |
| **Current channel ID and name** | Scope operations to the active conversation | Browser memory only (runtime variable) | Cleared when tab is closed |

### Data the Extension Does NOT Access

- Message content is generally **not stored** to disk. The one exception: when you use "Only Delete Attachments (preserve text)", the text of the messages being edited is persisted to local storage for the duration of that operation so the correct text can be restored if the browser interrupts the job; it is deleted when the operation completes or is cancelled. All other message text is held only in browser memory.
- No browsing history, cookies, bookmarks, or other browser data is accessed.
- No personal information beyond your Slack user ID and workspace membership is processed.

## How Data is Used

All data accessed by Bulk Clean for Slack is used exclusively for its core functionality:

1. **Session token** — Used to authenticate Slack API calls (`conversations.history`, `chat.delete`, `files.delete`, `users.list`, `conversations.info`) on your behalf.
2. **Message metadata** — Used to track which messages have been processed during a bulk deletion operation, enabling pause/resume/recovery.
3. **User cache** — Used to display human-readable usernames instead of Slack user IDs in the scan results.

## Data Storage

- **No data is transmitted to external servers.** All API calls go directly from your browser to Slack's official API endpoints (`https://slack.com/api/`).
- **Session tokens are never written to disk.** They are stored in `chrome.storage.session`, which is a memory-only storage area that is automatically cleared when the browser is closed.
- **Deletion queue state** is temporarily persisted to `chrome.storage.local` to enable pause/resume and recovery after browser restarts. This data is automatically deleted when the operation completes or is cancelled.
- **User name cache** is stored in `chrome.storage.local` with a 24-hour time-to-live (TTL). It is automatically refreshed or cleared after expiration.

## Data Sharing

Bulk Clean for Slack does **not**:
- Transmit any data to third-party servers
- Include any analytics, telemetry, or tracking code
- Use advertising networks or data brokers
- Share data with any entity other than Slack's own API (at your direction)

## Permissions

| Permission | Justification |
|---|---|
| `storage` | Store deletion queue state and user name cache locally |
| `scripting` | Inject the dashboard UI into the Slack web client tab |
| `alarms` | Schedule deletion queue processing in the background |
| `host_permissions: *.slack.com` | Inject the content script and dashboard UI on the Slack web client, whether served from `app.slack.com` or a workspace subdomain (e.g. `acme.slack.com`) |
| `host_permissions: slack.com` | Make API calls to Slack's REST API endpoints |

## User Control

- You can **pause, resume, or cancel** any deletion operation at any time.
- You can **close the dashboard** to stop all operations.
- You can **uninstall the extension** at any time, which clears all stored data.
- Deletion operations require explicit confirmation, including a safety verification step for large batches (>100 messages).

## Security

- Session tokens are stored in memory-only storage and never persisted to disk.
- The extension UI is rendered inside a Shadow DOM to isolate it from the host page.
- All message sender origins are validated before processing.
- User-provided text filters are sanitized against regex denial-of-service (ReDoS) attacks.

## Children's Privacy

Bulk Clean for Slack is not directed at children under 13 and does not knowingly collect personal information from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last Updated" date at the top of this document.

## Contact

If you have questions about this privacy policy, please open an issue on the extension's support page or contact the developer through the browser extension store listing.
