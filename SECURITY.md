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

Erasechat covers six platforms: Slack (built in) plus five optional platforms (Reddit, X,
Mastodon, Microsoft Teams, Telegram) connected one at a time from the popup. The scope
below applies to all six, not just Slack.

In scope — issues that could cause the extension to:

- delete, trim, or skip content **other than** what the user's filters/selection
  actually asked for (over-deletion / under-deletion / wrong-conversation deletion), on
  any of the six platforms;
- expose, log, persist, or transmit any platform's account credential anywhere other than
  `chrome.storage.session` and requests to that platform's own API — this covers the
  Slack session token, the Reddit modhash, the X CSRF token, the Mastodon access token,
  the Teams Bearer token, and the Telegram MTProto session string alike;
- allow an untrusted origin to drive a scan/deletion on any platform, or inject untrusted
  message/post/toot/tweet content into any dashboard as markup (XSS);
- hang or crash the background context (Slack) or a dashboard tab (any platform) in a way
  that strands a bulk-delete job with no way to tell what happened.

Out of scope — each platform's own API/behavior, issues requiring a compromised browser or
malicious extensions already installed, and social-engineering of the user.

## Security model (how it is designed to be safe)

- **Token handling** — every platform's account credential lives only in
  `chrome.storage.session` (memory-only, cleared on browser close): Slack's `xoxc-` token
  (read from the page's own `localStorage`), Reddit's modhash, X's `ct0` CSRF token,
  Mastodon's personal access token, the Teams Bearer token passively observed from the
  user's own traffic, and Telegram's MTProto session string. None of these is ever
  written to `chrome.storage.local`, and each is sent only to the platform it
  authenticates against. Non-sensitive labels (username, instance URL, API base URL,
  Telegram's app-identifying `api_id`/`api_hash`) persist in `chrome.storage.local` for
  reconnect convenience, but none of those can authenticate a request on its own.
- **Origin validation** — every inbound message to the Slack background worker is checked
  with `isSlackHostname()`, which accepts only HTTPS `*.slack.com` subdomains (rejecting
  look-alikes such as `app.slack.com.attacker.com` or `evilslack.com`) plus the
  extension's own pages. The five other platforms don't inject a content script or accept
  cross-origin messages at all — each runs as its own extension page, communicating
  directly with its platform via `fetch`/MTProto.
- **Scope** — Slack operations run only against the conversation the user has open; the
  job is pinned to the channel/workspace it was started in and auto-pauses on navigation
  drift. Every platform's scan results can be individually reviewed and deselected before
  a delete is confirmed.
- **Destructive-input safety** — Slack's delete/keep decision lives in one unit-tested
  module (`shared-filters.js`); regex filters are ReDoS-guarded and empty-matching
  patterns are refused; every platform requires a typed **DELETE** (or, above 100 items,
  the exact count) confirmation, and every platform's deletion can be cancelled mid-run.
- **File deletion** — a Slack file shared in more than one conversation is never
  hard-deleted (verified via `files.info` before `files.delete`), so cleaning one chat
  can't destroy content in another.
- **No remote code** — CSP is `script-src 'self'` on every extension page; there is no
  reachable `eval` call, no remote scripts, and no external network calls beyond each
  platform's own API. Telegram's bundled crypto dependency chain previously pulled in
  three eval-adjacent constructs (a Node `vm` polyfill whose `runInThisContext` is a
  literal `eval(this.code)`; webpack's own `new Function('return this')()` global-object
  fallback; an ES5 `Function.prototype.bind` polyfill built the same way) — all three are
  now excluded from the build at the source (`webpack.telegram.config.js`) rather than
  relying on CSP to block them after the fact. One inert reference remains: a
  well-known, widely-used crypto-support dependency (`get-intrinsic`) holds `eval` as a
  *value* in an internal lookup table for introspection — never calls it — which
  `addons-linter` still flags as a non-blocking warning; eliminating it would mean
  patching or replacing a load-bearing transitive dependency of Telegram's crypto stack
  for a construct that was never reachable as code execution.

## Supported versions

The latest released version receives security fixes. See [CHANGELOG.md](CHANGELOG.md).
