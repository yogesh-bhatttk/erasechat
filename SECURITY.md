# Security Policy

Erasechat **permanently deletes user data**, so security and correctness are
treated as the top priority.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — **do not** open a public issue for
security problems.

- **Email:** yogeshb@prosperix.com
- Include: a description, affected file(s)/version, reproduction steps, and impact.
- Please allow a reasonable time for a fix before any public disclosure.

We aim to acknowledge reports promptly and to ship fixes for confirmed, high-impact
issues as quickly as is safely possible.

## Scope

In scope — issues that could cause the extension to:

- delete, trim, or skip messages **other than** those the user's filters selected
  (over-deletion / under-deletion / wrong-channel or wrong-workspace deletion);
- expose, log, persist, or transmit the Slack session token anywhere other than
  `chrome.storage.session` and requests to `slack.com`;
- allow a non-`*.slack.com` origin to drive scans/deletions, or inject untrusted Slack
  message content into the dashboard as markup (XSS);
- hang or crash the background context in a way that strands a bulk-delete job.

Out of scope — Slack's own API/behavior, issues requiring a compromised browser or
malicious extensions already installed, and social-engineering of the user.

## Security model (how it is designed to be safe)

- **Token handling** — the Slack `xoxc-` client token is read from the page's
  `localStorage` (Slack's own store) and kept only in `chrome.storage.session`
  (memory-only, cleared on browser close). It is never written to `chrome.storage.local`
  and never sent anywhere but `slack.com`.
- **Origin validation** — every inbound message is checked with `isSlackHostname()`,
  which accepts only HTTPS `*.slack.com` subdomains (rejecting look-alikes such as
  `app.slack.com.attacker.com` or `evilslack.com`) plus the extension's own pages.
- **Scope** — operations run only against the conversation the user has open; the job is
  pinned to the channel/workspace it was started in and auto-pauses on navigation drift.
- **Destructive-input safety** — the delete/keep decision lives in one unit-tested module
  (`shared-filters.js`); regex filters are ReDoS-guarded and empty-matching patterns are
  refused; large batches require a typed **DELETE** confirmation.
- **File deletion** — a file shared in more than one conversation is never hard-deleted
  (verified via `files.info` before `files.delete`), so cleaning one chat can't destroy
  content in another.
- **No remote code** — CSP is `script-src 'self'`; there is no `eval`, no remote scripts,
  and no external network calls beyond the Slack API.

## Supported versions

The latest released version receives security fixes. See [CHANGELOG.md](CHANGELOG.md).
