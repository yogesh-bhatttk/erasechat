# Multi-Platform "Bulk Clean" Expansion — Research & Plan

**Status:** research complete, no build started. This document is a decision aid, not a
commitment — read it, then tell me which platform(s) to actually scope into an
implementation plan.

**Date of research:** 2026-09-06. API terms, pricing, and ToS enforcement postures
(especially X's pricing and Reddit's developer access) are moving targets — re-verify
before building if more than a few months pass.

**Project constraint (decided): free only.** Every extension in this family must be
free to use and free to operate — no platform whose only sanctioned path requires paying
the platform itself is in scope. This is why **X.com is excluded from the active
roadmap** (see §3.4 and §5) even though it's otherwise technically viable: as of Feb
2026 its official API has no free tier, and the only free alternative is unsanctioned
web-client scripting, which was not selected either. Its research is kept below for
reference in case this decision is revisited, but it is out of scope for now.

---

## 1. Why this document exists

`Bulk Clean for Slack` works because of one specific, fragile-sounding but real fact:
Slack's web client exposes an internal API that a user's own logged-in browser session
can call directly (`credentials: "include"` fetch, no OAuth app registration, no backend
server), and doing so to manage *your own* messages is not a Slack ToS violation. That
combination — **(a) an API that can delete your own content, (b) reachable without a
backend server, (c) not prohibited by the platform's terms** — is the actual product,
more than "a bulk-delete UI." This document tests six other platforms against that same
bar, instead of assuming any of them qualify just because a tool with a similar name
exists for them.

Every verdict below was checked in three parts:
1. **Does a real delete-your-own-content API exist**, and is it batchable or strictly
   one-at-a-time?
2. **What does auth require** — can a pure browser extension (no backend, no client
   secret held server-side) call it, or does the platform force a registration/consent
   step that breaks the "install and go" experience?
3. **Is it actually wanted** — does real competitor/demand evidence exist, or was that
   an assumption?

---

## 2. Headline ranking

| Platform | Delete API | Auth fits "no backend"? | Cost | Real demand evidence | Verdict |
|---|---|---|---|---|---|
| **Slack** (shipped) | ✅ one-at-a-time | ✅ cookie session | Free | N/A — already built | **Done — real, shipped** |
| **Bluesky** (prototype) | design correct (`applyWrites`), code present but unreachable | designed correctly, but misconfigured | Free | ✅ several paid competitors | **Broken — does not run** (§7) |
| **Telegram** (prototype) | design correct (`Vector<int>`), code present but unreachable | real login code written, but wiring is broken | Free | ⚠️ CLI tools only, no extension yet | **Broken — does not run** (§7) |
| **Mastodon** (prototype) | implemented, logic looks sound | PAT logic real but unreachable via UI | Free | ⚠️ small/shrinking audience, no shipped extension | **Broken — unusable end-to-end** (§7) |
| **X.com** (prototype) | implemented (dynamic queryId extraction works) | headers wired, but session cookie never attaches | Free | ✅ strong (multiple competitors) | **Broken — auth likely fails on every request** (§7) |
| **Reddit** (prototype) | implemented, pagination/backoff both present | cookie plumbing incomplete, popup non-functional | Free | ✅ strong, long-running category | **Broken — auth likely fails on every request** (§7) |
| **Microsoft Teams** (prototype) | plain DELETE on internal API, not Graph `softDelete` | token-capture listener likely never fires | Free | ⚠️ one niche paid tool exists | **Broken — token interception likely non-functional** (§7) |

**Correction (2026-09-07):** the six non-Slack rows above were previously marked
"shipped"/"Done." An independent code audit (§7) found that all six are non-functional
as currently written — every one has at least one defect that prevents the core
scan-or-delete flow from ever completing, and several can't even load without throwing.
"Done" described the *design intent* being coded up, not a working extension. See §7 for
full findings before doing anything else with this family of extensions.

The pattern across all six: **none of them give you Slack's easy combination for free**,
and on top of that, none of the six prototypes actually works yet. Every one trades away
at least one of the three legs, *and* every one currently has implementation bugs on top
of that trade-off. The question for each is *which* leg it gives up, whether that's a
cost you're willing to pay, and — first — whether it's worth the additional engineering
to make the existing prototype actually run.

---

## 3. Per-platform detail

### 3.1 Bluesky — recommended next

- **Delete API**: `com.atproto.repo.deleteRecord` per-post, but also
  `com.atproto.repo.applyWrites` — a genuine transactional batch call that can delete
  many posts in one HTTP request (bounded to roughly ~200 ops/call in practice). This is
  strictly better than Slack's one-call-per-message model.
- **Auth**: no cookie session to reuse — Bluesky issues short-lived Bearer JWTs
  (`accessJwt`/`refreshJwt`) held in the client's own storage, not an ambient browser
  cookie. Two paths:
  - **App passwords** — simplest, closest to Slack's UX (user pastes/enters a
    Bluesky-generated app password into the extension once), but Bluesky has flagged
    this path as being phased out in favor of OAuth.
  - **OAuth 2.0 + PKCE + DPoP** — the "correct," durable path, explicitly designed to
    support backend-less public clients (Bluesky ships
    `@atproto/oauth-client-browser` for exactly this). The catch: even a "no backend"
    OAuth client still needs a `client_id` that resolves to a **hosted, public HTTPS
    JSON metadata file** plus a real HTTPS redirect URI — so "no backend" here means
    "no server-side application logic," not "zero hosting of any kind." A static file
    host (e.g. GitHub Pages) covers this.
- **Rate limits**: deletes are the *cheapest* write op (1 point each) against a budget of
  5,000 pts/hour, 35,000/day — comfortably faster than Slack's throttled delete pace.
- **Cost**: free, no tiers, no paywall — core to the protocol's design.
- **ToS**: Bluesky's Developer Guidelines explicitly welcome automation of a user's own
  account; nothing found restricts self-deletion tooling.
- **Demand**: Redact, Skeet Deleter, and at least two Chrome-extension competitors
  (BskyDelete, "Bluesky Deleter Pro") already exist and are paid/gated — proving people
  want this, and that no free/pure-extension version currently fills that gap.
- **User base**: registered accounts ~40–46M (grew fast on X-controversy migration
  waves), but monthly actives are contested and reportedly shrinking through mid-2026
  (estimates 10.7M–27.5M MAU depending on source; DAU ~4.5M as of Jan 2026). Read this as
  "real but not enormous, and engagement is still shaking out" rather than "guaranteed
  growth."
- **Extra engineering vs. Slack**: implement either app-password login (quick, but a
  deprecating path) or full OAuth+PKCE+DPoP (the right long-term choice, meaningfully
  more code — DPoP requires signing every request and juggling server-issued nonces),
  plus resolving each account's actual PDS (AT Protocol accounts aren't all on one host
  the way Slack workspaces sit behind one domain).

### 3.2 Telegram — viable, different architecture

- **Delete API**: `messages.deleteMessages` / `channels.deleteMessages`, both taking a
  **vector of message IDs** — natively batchable, better than Slack's model.
- **Auth**: the real complication. Telegram's client protocol is MTProto, not a cookie-
  backed REST API — there's no session cookie an extension can silently ride the way it
  rides Slack's. MTProto genuinely *can* run client-side in the browser (Telegram's own
  official web clients do exactly this, and community libraries like GramJS prove it),
  but the extension would need to bundle a full MTProto client and have the user
  complete a **real Telegram login inside the extension** (phone number + SMS/app code,
  optional 2FA) — a materially different and heavier first-run experience than "you're
  already logged into Slack, so it just works."
- **Shared-identity risk**: every developer needs an `api_id`/`api_hash`. It's not a
  secret that can be exploited, so it *can* ship embedded in a public extension — but
  every install then shares one identity, and if Telegram ever flags that ID for abuse,
  every user's access breaks simultaneously. The alternative (each user self-registers
  their own `api_id`) removes that blast radius but adds a manual setup step no
  competitor currently requires users to do.
- **Rate limits / cost**: dynamic `FLOOD_WAIT` backoff, no fixed published number, but
  batched deletes reduce call volume sharply. Free — Telegram states the API has no
  charge.
- **ToS**: explicitly automation-friendly for actions a user takes on their own account;
  no clause found banning self-service bulk deletion.
- **Demand**: real, but currently served only by developer-facing CLI scripts
  (Telethon/GramJS-based) — no polished browser extension exists yet, which is itself a
  signal that the MTProto-in-extension lift has kept casual builders away.

### 3.3 Mastodon — viable, weaker case right now

- **Delete API**: clean, documented, stable `DELETE /api/v1/statuses/:id` — actually
  easier to work with than Slack's undocumented internal endpoints.
- **Auth — the real obstacle**: Mastodon is federated. Every instance
  (mastodon.social, and thousands of independently-run others) is its own OAuth host.
  Dynamic app registration against an arbitrary instance is technically fine (every
  instance implements it), but Mastodon **only supports confidential clients today** —
  every registered app gets a `client_secret`, even though a browser extension has
  nowhere safe to keep one. True secret-less public-client support is only "on the
  roadmap" (tracked in a March 2025 GitHub issue), not shipped. Practically, this pushes
  toward either treating the secret as non-sensitive (since there's no backend it's
  protecting anyway) or asking users to hand-generate a personal access token from their
  own instance's settings page — extra manual friction Slack's users never see.
- **Store-trust cost**: because instances are arbitrary, the extension needs broad or
  runtime-requested host permissions across many domains — a much less reassuring
  install prompt than Slack's single fixed origin.
- **Rate limits**: deletes capped at 30 per 30 minutes per account (shared with
  un-reblog) — noticeably tighter than Bluesky's.
- **Demand**: no shipped browser-extension competitor with delete capability exists
  today (Cyd/Semiphemeral lists Mastodon support as unshipped/"on the roadmap"); existing
  tools are all CLI/GitHub-Action scripts.
- **User base**: MAU roughly 750K–1M as of early 2026, down from a 2.6M peak right after
  the 2022 Twitter exodus — small and still shrinking, against ~10.5M registered
  accounts. This is the weakest demand signal of the three "viable" platforms.

### 3.4 X.com — excluded (kept for reference)

> **Excluded from the active roadmap per the free-only project constraint (§0).** Retained
> below because the research is still useful if this decision is ever revisited, but
> this is not something to build under the current constraint.

Technically the most portable of the six (OAuth+PKCE fits a pure extension cleanly, and
Cyd already proves the Slack-style web-scripting approach works on X), but every free
path leads either to paying X per API call or to the same ToS-gray scraping approach
Cyd already occupies. Neither is compatible with "everything is free."

- **Delete API**: `DELETE /2/tweets/:id`, one at a time, 50 requests/15min per user — a
  pacing model directly analogous to Slack's throttled delete queue.
- **Auth**: OAuth 2.0 Authorization Code + PKCE is explicitly documented for public
  clients with no backend — architecturally this is the *easiest* auth story of the six
  non-Slack platforms.
- **The actual blocker — pricing**: as of Feb 6, 2026, X eliminated free access
  entirely and moved every account (including force-migrating legacy Basic/Pro
  subscribers by June/Sept 2026) to metered pay-per-use: roughly **$0.015 per post
  created, $0.005 per post read, ~$0.01 per delete**. Clearing a few thousand old posts
  for one user could run **$15–35 in raw API cost**, as a one-time burst rather than
  recurring usage — a poor fit for flat monthly subscription pricing, and a cost this
  tool would either have to pass to the user per-job or absorb.
- **The alternative — don't use the official API at all**: **Cyd** (formerly
  Semiphemeral, open-source, free) does exactly this — it has the user log in normally,
  then scripts X's own internal web-client endpoints the same way this Slack tool
  scripts Slack's, and simply waits out X's own rate limits instead of paying for API
  access. This proves the Slack-style approach is *technically* viable on X. The
  tradeoff: X's general Terms prohibit "scraping... using automated means... without
  prior written consent" with steep stated liquidated damages for violations, and 2026
  enforcement has visibly hardened (a March 2026 suspension wave). Enforcement so far
  appears aimed at engagement manipulation (mass follow/unfollow, fake engagement), not
  self-only deletion specifically — but that's an observation about current enforcement
  focus, not a guarantee.
- **Demand**: strong and proven — TweetDelete, Redact, and Cyd are all real, used
  products.
- **Bottom line**: this is a *business-model* decision, not an engineering one. Pick one:
  charge users enough to cover metered API costs, or accept Cyd's ToS-gray web-scripting
  approach and its enforcement-climate risk.

### 3.5 Reddit — flipped from "easy" to "blocked" since our last discussion

- **Delete API**: `POST /api/del`, one item at a time (post or comment) — same shape as
  Slack's `chat.delete`.
- **The blocker**: on **November 11, 2025, Reddit closed self-service API key
  creation entirely.** New developers can no longer just register an app and get
  credentials — it now requires a manual "Responsible Builder Policy" application with
  reported high rejection rates, especially for personal/non-commercial tools. This is a
  hard, recent change that reverses what was true when this category of tool first
  became popular.
- **What existing tools do about it**: PowerDeleteSuite still works today because it
  never used the sanctioned API at all — it runs client-side off the user's existing
  logged-in session cookie against Reddit's legacy web endpoint, which is exactly the
  Slack-style trick, but is explicitly framed in community commentary as a **Terms-of-
  Service risk carrying account-ban exposure** if detected, since it's not the sanctioned
  path. Other tools (Redact.dev) worked around the API gap by having users import
  Reddit's own official data-export archive instead of relying on live API reads. Nuke
  Reddit History was delisted from extension stores in September 2025.
- **Rate limits / cost**: not the issue — 100 QPM authenticated, non-commercial use is
  nominally free — the issue is that *getting credentials at all* is now gated and
  uncertain.
- **Demand**: still clearly real and long-running (persistent r/redditdev threads, an
  angry public reaction to the Nov 2025 change) — this is not a demand problem, it's an
  access problem.
- **Bottom line**: revisit if Reddit's manual approval process turns out to be
  navigable, or if you're willing to accept the same ToS risk PowerDeleteSuite already
  carries. Not a clean build today.

### 3.6 Microsoft Teams — dead end for a consumer product

- **Delete API**: genuinely exists and is GA — `softDelete` for chat and channel
  messages, `undoSoftDelete` to reverse it, plus whole-chat deletion.
- **The blocker**: every relevant permission (`Chat.ReadWrite`,
  `ChannelMessage.ReadWrite`) requires **tenant admin consent** and is **explicitly
  listed as unsupported for personal Microsoft accounts** — work/school accounts only.
  Even on a work/school account, the org's Teams messaging policy must separately allow
  message deletion, or the call fails regardless of consent. There is no "install the
  extension, log in, it just works" path here for the overwhelming majority of Teams
  users, who sit inside IT-managed tenants where third-party OAuth consent is
  increasingly restricted by default.
- **Evidence this friction is real, not theoretical**: the one existing competitor
  ("Bulk MS Teams Message Removal," a paid Chrome extension) explicitly works
  **channels only** — it cannot touch chats/DMs at all, and still requires an admin to
  flip a messaging-policy setting before it functions.
- **Bottom line**: not a cost or engineering problem — it's a trust-model mismatch. Only
  pursue this if you're deliberately targeting IT admins as the buyer/installer instead
  of individual end users, which is a fundamentally different product than this one.

---

## 4. Cross-cutting architecture question: one extension, or several?

**Recommendation: separate extension per platform**, not one extension with broad host
permissions across all of them, for the same reason `manifest.json` here is scoped to
`*.slack.com` and nothing else:

- Every platform above needs a *different* auth model (cookie session, app password,
  OAuth+PKCE, OAuth+PKCE+DPoP, or a bundled MTProto client) — there's no shared "auth
  module" to write once.
- Store reviewers (and users deciding whether to trust an installer) read broad,
  multi-domain host permissions as a red flag. A "Bulk Clean for Bluesky" extension that
  asks for exactly one domain's worth of access is a much easier trust story than one
  extension asking for Slack *and* Bluesky *and* Mastodon *and* X access simultaneously.
- What genuinely *does* carry over from this codebase, and is worth deliberately
  reusing as a template/shared pattern across a product family:
  - The **scan → preview → filter → confirm (type-DELETE for big batches) → paced,
    resumable delete queue → CSV/log export** UX flow and its safety posture.
  - Most of the dashboard's shadow-DOM UI shell and CSS (content.css), swapping only the
    parts of the filter form that are platform-specific.
  - The architectural discipline in `shared-filters.js`: one shared, unit-tested
    decision function for "does this item qualify," never forked between a scan path and
    a delete path.
  - The release-gate tooling (packaging tests, manifest invariants, versioned
    dual-manifest build) — the shape of that gate transfers even though the specific
    checks won't.

So: think of this as a **product family with a shared design language and a shared
safety philosophy**, implemented as separate, narrowly-scoped extensions — not a
monolith.

---

## 5. Suggested phasing

> **Correction (2026-09-07):** every "[DONE]" below was written when the prototype's
> *code existed*, not when it was verified to actually run. A file-by-file audit (§7)
> found each one is currently non-functional — see the linked finding for what's really
> true and what's still needed before any of these ship.

1. **Bluesky** — **[BROKEN, not done]** A separate extension exists with real OAuth+PKCE+DPoP
   library code (`@atproto/oauth-client-browser`) and a correctly-implemented
   `applyWrites` batch delete. But `dashboard.html`/`popup.html` load the raw,
   un-bundled source (bare `import` statements in a plain `<script>` tag), which throws
   immediately instead of running the bundled `dist/` output that `scripts/build.js`
   produces — so none of that code currently executes. The OAuth `client_id` is also
   misconfigured (`http://127.0.0.1/client-metadata.json`, which isn't a valid loopback
   client id and isn't reachable by a real PDS), and the checked-in
   `client-metadata.json` still has a placeholder extension ID. See §7.1.
2. **Telegram** — **[BROKEN, not done]** A standalone extension exists using a real MTProto
   client (`teleproto`, a genuine npm package) with real phone/code/2FA login logic
   written against it. But the same load-bug as Bluesky is present (raw source loaded
   instead of the Webpack bundle), and independently, `popup.html`/`popup.js` and
   `dashboard.html`/`dashboard.js` reference completely mismatched DOM element IDs, so
   the UI would throw immediately even past the load-bug. Even if both were fixed, the
   library defaults to a raw-TCP-socket transport that cannot run inside a browser
   extension, and the project's own Webpack config stubs out the `net` module — so the
   connection itself would still fail. See §7.2.
3. **Mastodon** — **[BROKEN, not done]** A lightweight Vanilla JS extension exists with real
   PAT-based auth logic and real sequential delete + exponential-backoff retry code.
   But `popup.html`/`popup.js` reference mismatched element IDs, so the login screen
   never renders any working control — **the extension cannot currently be logged into
   at all**. Delete pacing (750ms/item) is also too aggressive against Mastodon's real
   30-deletes-per-30-minutes cap. See §7.3.
4. **Reddit** — **[BROKEN, not done]** Correctly designed around bypassing the now-gated
   Developer API using session cookies against Reddit's legacy web endpoints, with real
   pagination, a Deep-Scan toggle, and retry/backoff already written. But none of the
   fetch calls set `credentials: "include"`, so the session cookie will not actually be
   attached to any cross-origin request from the extension — auth is very likely broken
   on every call as shipped. `popup.html`/`popup.js` also have mismatched element IDs,
   breaking both the login-success UI and the "Open Dashboard" button's click handler.
   See §7.4.
5. **Microsoft Teams** — **[BROKEN, not done]** The intended workaround (a background
   service worker intercepting `Authorization: Bearer` tokens from `teams.microsoft.com`
   traffic) is coded up, but the `webRequest` listener omits `"extraHeaders"` from its
   `extraInfoSpec`, and Chrome specifically hides the `Authorization` header from
   listeners that don't request `extraHeaders` — so the token is likely never actually
   captured. Deletion also doesn't use Graph's `softDelete` as claimed; it calls a plain
   `DELETE` against an internal, undocumented Teams API instead. See §7.5.
6. **X.com** — **[BROKEN, not done]** Correctly bypasses the paid Developer API by hitting
   internal GraphQL endpoints, with a real dynamic query-ID extractor (scrapes and
   parses `main.*.js` for current `queryId` values — this already solves the gap this
   plan used to flag as missing). But like Reddit, no fetch call sets
   `credentials: "include"`, so the actual session cookie won't attach cross-origin —
   the bearer token and CSRF header are wired correctly, but that alone is very likely
   not enough to authenticate. See §7.6.

---

## 6. Open decisions for you

These aren't things I can resolve — they're calls only you can make:

1. **Which platform to scope into an actual implementation plan first** — my
   recommendation is Bluesky, but Telegram is a close, valid alternative if you want the
   batching win and don't mind the heavier login UX.
2. **Whether "ToS gray area, no evidence of enforcement against this specific use case"
   is a risk you're willing to accept anywhere** (Reddit's cookie-based fallback is the
   remaining case, now that X is excluded) — this document flags where that tradeoff
   exists but doesn't make it for you.
3. **Branding/positioning**: one shared brand across a "Bulk Clean" family of
   extensions (consistent trust signal, but each still needs its own store listing and
   review), or fully independent product names per platform.

Once you've read this and picked a direction, say the word and I'll turn the chosen
platform's section above into a real implementation plan (manifest/permissions, auth
flow in detail, file-by-file architecture) the way this repository already documents
Slack's.

---

## 7. Known Gaps & Bugs Review — verified by code audit, 2026-09-07

**This section replaces the earlier draft of itself.** The version previously here was
written before anyone actually re-read the code against its own claims. A file-by-file
audit of all six sibling extensions
(`bulk-clean-for-{bluesky,telegram,mastodon,reddit,teams,x}/`) turned up a different and
more serious picture: **every one of the six is currently non-functional end-to-end**,
several of the specific gaps listed below turned out to already be fixed (stale), and
several much more severe bugs existed that weren't listed at all — including ones that
mean the popup can't even be clicked, or the page throws before any of this logic runs.

None of these are ready to publish. Treat every "[DONE]" elsewhere in this document
(§2, §5) as describing *code that was written*, not *a working extension* — the two are
not the same thing here, and the gap below the fold each time is not a Chrome Web Store
polish issue, it's "does this feature work at all."

### 7.1 Bluesky (`bulk-clean-for-bluesky/`)

- **Critical — page doesn't load.** `dashboard.html` and `popup.html` load raw,
  un-bundled `dashboard.js`/`popup.js` directly via a plain `<script>` tag. Those files
  open with bare ES-module `import` statements (`@atproto/api`,
  `@atproto/oauth-client-browser`), which a non-module `<script>` cannot execute at all.
  `scripts/build.js` esbuild-bundles working IIFEs into `dist/popup.js` /
  `dist/dashboard.js`, but neither HTML file references `dist/` — the bundle is built
  and then never used. **Fix**: point both HTML files at the `dist/` output (or add
  `type="module"` plus a proper import map, though the existing bundler output is the
  simpler fix).
- **Critical — OAuth `client_id` is misconfigured.** Both `popup.js` and
  `bluesky-api.js` hardcode `client_id: "http://127.0.0.1/client-metadata.json"`. The
  AT Protocol OAuth spec only recognizes `http://localhost` as a special loopback client
  id — `127.0.0.1` is not covered by that exemption, and it isn't a real hosted HTTPS
  metadata URL either (a PDS validating this client would try to fetch it and fail,
  since 127.0.0.1 points at the user's own machine, not a public host). The checked-in
  `client-metadata.json` still contains the literal placeholder
  `YOUR_EXTENSION_ID_HERE` and isn't even wired to the same `client_id` string the JS
  uses. **Fix**: host the real `client-metadata.json` at a stable public HTTPS URL (e.g.
  GitHub Pages, as §3.1 already suggested) and point `client_id` at that URL in both
  files.
- **Host permissions too narrow for the plan's own multi-PDS claim.** `manifest.json`
  scopes `host_permissions` to `https://bsky.social/*` only, even though §3.1 correctly
  notes AT Protocol accounts live on many different PDS hosts. Any account not literally
  on bsky.social will fail on CORS grounds independent of the auth bugs above.
- **What's actually good**: `applyWrites` batch delete (200/call) is implemented
  correctly in `dashboard.js` and matches the plan's design. Per-account PDS-aware
  request routing is real at the library level (`oauth-session.js` builds URLs from the
  token's own `aud`, not a hardcoded host). `chrome.identity.launchWebAuthFlow` redirect
  handling is done correctly.
- **Gap #4 from the earlier draft ("missing DPoP nonce retry") is stale — remove it.**
  `@atproto/oauth-client`'s `fetch-dpop.js` already detects `use_dpop_nonce` errors,
  re-signs a fresh proof JWT, and retries transparently, and it's wired into every
  request via the session's `fetchHandler`. There is no missing nonce-retry logic; the
  original gap note looked at the wrong layer.

### 7.2 Telegram (`bulk-clean-for-telegram/`)

- **Critical — page doesn't load**, same root cause as Bluesky: `popup.html` and
  `dashboard.html` load raw source with bare `import { TelegramClient } from 'teleproto'`
  in a non-module `<script>` tag — throws a `SyntaxError` before anything else runs. The
  Webpack-bundled `dist/popup.js` / `dist/dashboard.js` (confirmed built, ~5.4MB each)
  are never referenced by either HTML file.
- **Critical — popup and dashboard DOM don't match their own JS.** `popup.js` expects
  elements like `step-credentials`, `api-id`, `api-hash`, `phone`, `auth-code`,
  `2fa-password`, `btn-request-code` — none of which exist in `popup.html` (which only
  has an `active-state` div and a `btn-launch` button). `dashboard.js` similarly
  references `connected-as` and `target-chat`, absent from `dashboard.html`. Even past
  the load-bug, every login/scan interaction would throw immediately on a `null`
  element.
- **Critical — even fixed, the transport layer can't run in a browser.**
  `teleproto`'s `TelegramClient` defaults to `PromisedNetSockets` (raw TCP via Node's
  `net` module) unless the caller explicitly passes `networkSocket:
  PromisedWebSockets` — neither `popup.js` nor `dashboard.js` does this. Compounding it,
  `webpack.config.js` stubs `net` to `false`, so the client would throw immediately on
  `connect()`/`start()` even in the bundled build. **Fix**: pass
  `networkSocket: PromisedWebSockets` explicitly when constructing `TelegramClient`.
- **What's actually good**: `teleproto` is a real, legitimate MTProto client package
  (confirmed via npm, not a hallucinated dependency). The login sequence
  (phone → code → 2FA → `client.session.save()`) is a genuine flow written against the
  real API, not a stub. Delete is correctly batched via
  `Api.messages.DeleteMessages({ id: chunk, revoke: true })` in 100-item chunks. No
  shared/hardcoded `api_id`/`api_hash` is baked in — the user supplies their own (though
  moot until the UI actually renders).
- **Not previously listed**: no `FLOOD_WAIT` backoff handling anywhere, despite §3.2's
  own discussion of this being a known concern for MTProto clients.

### 7.3 Mastodon (`bulk-clean-for-mastodon/`)

- **Critical — extension cannot be logged into.** `popup.js` looks for
  `login-section`, `status-section`, `error-msg`, `btn-connect`, `btn-dashboard`,
  `btn-logout`, `instance-url`, `access-token` — none of these IDs exist in
  `popup.html`, which only has `active-state` and `btn-launch`. Every code path off
  `DOMContentLoaded` throws on a `null` element before any click listener is attached,
  including the listener for the one button that does exist. There is no login form in
  the HTML at all. **Fix**: rebuild `popup.html` to match what `popup.js` actually
  expects (host/token entry fields, connect button), or rewrite `popup.js` against the
  current `popup.html`.
- **Rate-limit pacing doesn't match Mastodon's real limit.** Deletes are paced at
  750ms apart with a 3-attempt backoff — but Mastodon's actual delete-specific cap is 30
  per 30 minutes (per §3.3). At 750ms/item, any batch over ~30 items blows through the
  real limit in under 25 seconds, and a 3-attempt backoff (~1+2+4s) cannot survive a
  30-minute lockout window.
- **Dead code**: `content.css` is a byte-identical duplicate of `dashboard.css` and is
  referenced by nothing — there's no `content_scripts` entry in `manifest.json` and
  `dashboard.html` links `dashboard.css` directly. Leftover from the port; safe to
  delete.
- **§4's claimed reuse doesn't hold up for this platform**: no CSV/log export exists
  anywhere in the code, and the delete queue is a plain in-memory array with no
  resumability — closing the tab mid-run loses all progress and forces a full rescan.
- **What's actually good**: once past login, PAT auth is wired correctly
  (`verify_credentials` check, `Authorization: Bearer` on every call), host permissions
  are correctly broad (`<all_urls>`, not hardcoded to one instance) to support arbitrary
  federated instances, and delete + exponential backoff retry logic is real.
- **Gap #6 from the earlier draft ("missing network retry across all extensions") is
  stale for Mastodon specifically** — `dashboard.js` already wraps every fetch in a
  3-attempt exponential-backoff retry. (It may still be accurate for other platforms;
  verify per-platform rather than assuming it's a blanket gap.)

### 7.4 Reddit (`bulk-clean-for-reddit/`)

- **Critical — cookie session almost certainly never attaches.** No fetch call in
  `popup.js` or `dashboard.js` sets `credentials: "include"`. Fetch's default
  credentials mode is `same-origin`; since these calls run from a
  `chrome-extension://` origin against `https://www.reddit.com`, the browser will not
  attach the `reddit_session` cookie without that explicit flag. This is the single
  claim the plan leans on most ("bypassing the gated API using session cookies") and,
  as shipped, the one line that makes that trick work is missing. **Fix**: add
  `credentials: "include"` to every fetch against reddit.com.
- **Critical — popup is non-functional.** `popup.js` references
  `check-section`, `status-section`, `error-msg`, `status-msg`, `btn-dashboard`,
  `connected-user` — none exist in `popup.html` (the real button is `btn-launch`).
  Both the success path and the `showError()` failure path throw on a `null` element,
  and the "Open Dashboard" button never gets a click handler attached at all — a user
  has no UI path into the dashboard short of typing the extension URL manually.
- **What's actually good**: `MAX_PAGES = 10` (§7 draft's old claim) is real, but a
  "Deep Scan" toggle already exists in `dashboard.html`/`dashboard.js` that raises the
  cap to 1000 — **the fix this section used to ask for is already built**; the earlier
  gap note was stale. Exponential backoff (3 retries, `2^n * 1000ms`) is also already
  implemented. Modhash/CSRF token handling is present and correctly wired as the `uh`
  form field on delete calls.
- **Not previously listed**: no filtering of already-deleted/removed items —
  `dashboard.js` pushes every listing entry into results without checking
  `author === '[deleted]'` or `removed_by_category`. Also, none of Slack's shared
  architecture (`shared-filters.js`, shadow-DOM shell) is reused here, contrary to §4's
  framing — this is a flat, independent popup+dashboard pair.

### 7.5 Microsoft Teams (`bulk-clean-for-teams/`)

- **Critical — token interception is likely non-functional.** `background.js`'s
  `chrome.webRequest.onSendHeaders` listener passes only `["requestHeaders"]` as
  `extraInfoSpec`. Chrome's webRequest API specifically withholds the `Authorization`
  header from listeners that don't also request `"extraHeaders"` — so
  `details.requestHeaders` almost certainly never contains a real token, and nothing
  ever gets written to `chrome.storage.local`. **Fix**: change `extraInfoSpec` to
  `["requestHeaders", "extraHeaders"]`.
- **Delete API claim is false.** The plan claims `softDelete` (Microsoft Graph) is
  used; the code never touches `graph.microsoft.com` at all (zero references) and
  instead issues a plain `DELETE` against Teams' internal, undocumented `chatsvc` API
  (`/v1/users/ME/conversations/{chatId}/messages/{id}`). This may still work as a
  delete mechanism, but it is not the API described, and it carries the higher
  break-without-notice risk of any undocumented internal endpoint.
- **Gap "(a) missing nextLink pagination" from the earlier draft is stale/inaccurate** —
  `dashboard.js` does contain a loop that follows `res.nextLink`. (Caveat: the internal
  chatsvc API may return continuation state under a different field name than
  `nextLink`, which would produce the same practical 100-item ceiling through a
  different root cause — worth confirming against a live account before assuming this
  is fully fixed.)
- **Gap "(b) no token refresh" is roughly accurate but oversimplified.** There's no
  explicit refresh trigger and no 401-retry (a 401 just aborts the whole delete loop),
  but the code does re-read storage on every request, so a token silently refreshed by
  Teams' own open tab would be picked up passively — assuming the interception bug
  above is fixed at all.
- **Not previously listed**: no detection of personal Microsoft accounts or
  tenant-policy blocks — both surface as a generic `"API Error 403"` alert with no
  explanation, despite §3.6 identifying this exact failure mode as the platform's core
  risk.

### 7.6 X.com (`bulk-clean-for-x/`)

- **Critical — cookie session almost certainly never attaches**, same root cause as
  Reddit: no fetch call sets `credentials: "include"`, and `dashboard.js` runs as a
  normal extension page (opened via `chrome.tabs.create`), not injected into an x.com
  tab — so it's a cross-origin request from a `chrome-extension://` origin, and the
  actual session cookie (`auth_token`, etc.) will not ride along by default. The
  correctly-wired `Authorization: Bearer <public token>` and `x-csrf-token` headers are
  necessary but not sufficient without this.
- **Gap #1 from the earlier draft ("hardcoded queryId, no dynamic extraction") is
  stale — the fix already exists.** `extractQueryIds()` in `dashboard.js` fetches
  `twitter.com/`, regex-scans the loaded `main.*.js` bundle, and re-parses live
  `queryId`/`operationName` pairs before every scan; hardcoded values are only a silent
  fallback if extraction fails. The remaining gap is narrower than originally described:
  there's no user-facing detection/messaging when the fallback path's queryId goes
  stale — it just surfaces as a generic "Scan failed" alert.
- **Gap #3's number is wrong.** The earlier draft said `MAX_PAGES = 10`
  (~250 items); the actual constant is `MAX_PAGES = 5` (~100 items).
- **Not previously listed**: the entire delete loop sits inside one try/catch with no
  per-item error isolation — a single failed delete aborts the rest of the batch rather
  than skipping and continuing. Delete pacing (2.5s/tweet) is also an unverified guess;
  the plan's only concrete rate number (50/15min) applies to the paid v2 API, not the
  internal GraphQL mutation actually in use here.

### 7.7 Cross-cutting takeaways

- **The popup.html/popup.js DOM mismatch bug recurs in three separate extensions**
  (Mastodon, Reddit, Telegram — plus Telegram's dashboard too) — a strong signal that
  each file was written independently without ever loading the extension in a browser
  to check that the two sides actually agree with each other. Before trusting any
  future "[DONE]" mark on this kind of work, load the extension and click through the
  actual flow.
- **The credentials: "include" omission recurs in two separate extensions** (Reddit,
  X) that both depend entirely on the "reuse the user's existing browser session"
  trick this whole document is built around — without that one flag, the core thesis
  of both extensions doesn't hold, regardless of how correct everything else is.
- **The unbundled-script-tag bug recurs in the two build-tooled extensions** (Bluesky,
  Telegram) — both have a working bundler and correctly-built `dist/` output that
  simply isn't wired into the HTML that ships.
- Several previously-listed gaps turned out to already be fixed in code (Bluesky's DPoP
  nonce retry, Reddit's pagination cap and backoff, Teams' nextLink loop, X's dynamic
  queryId extraction) — don't assume this list is exhaustive or that re-reading it
  later will still be accurate; re-audit against the code, not against this document,
  before doing further work.
