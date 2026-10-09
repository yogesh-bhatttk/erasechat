# Chrome Web Store — exact field values

Copy-paste values for the Chrome Web Store Developer Dashboard, tab by tab, in the order
the dashboard asks. The Chrome analogue of [`AMO_SUBMISSION_FIELDS.md`](./AMO_SUBMISSION_FIELDS.md).

Where this file and [`STORE_LISTING.md`](./STORE_LISTING.md) disagree, **this file wins** —
`STORE_LISTING.md` predates the current feature set (it still says "light theming options"
and omits regex filtering).

---

## 0. Before you open the dashboard

- [ ] **Developer account** — one-time **$5** registration fee, and the Google account
      must have **2-Step Verification enabled** (Chrome refuses to publish otherwise).
- [ ] **Verified contact email** — Account tab → *Contact email* → verify. An unverified
      email blocks publishing.
- [ ] **Upload `dist/erasechat-chrome-1.0.0.zip`** — the **chrome** zip.
      Not the firefox one; it carries `browser_specific_settings`, which Chrome flags.
      `scripts/build.sh` strips the repo manifest's `"key"` field from this zip (the key
      only pins the extension id for unpacked dev builds; the store assigns its own).
      Rebuild with `npm run build` if the source changed since 2026-08-02.

Chrome's equivalent of AMO's "Notes for Reviewer" is **Access → Test instructions** in the
left nav — a separate tab from Store listing and Privacy. §2.5 below has the text. The
host-permission justification still carries the endpoint-by-endpoint detail, because that
is what appears next to the permission itself during review.

---

## 1. Store listing tab

### Item name and Summary — **not editable in the dashboard**

Both are read **from the package** and shown greyed out. They come from
`_locales/en/messages.json`:

| Dashboard field | Source key | Current value |
|---|---|---|
| Title | `extensionName` | `Erasechat` (9 / 75) |
| Summary | `extensionDescription` | `Bulk-delete your own content on Slack, Reddit, X, Mastodon, Microsoft Teams & Telegram, with advanced filters and safety controls.` (130 / 132) |

**Title (adopted 2026-10-09):** `Erasechat – Bulk Delete Messages, Posts & Comments` (50 / 75; de/es/fr translated, all ≤ 50 so the same names also fit AMO).
The bare brand name says nothing about what the item does in search results; this form
leads with the brand, names the action, and covers all six platforms without listing any
trademark. Because the title is read from the package, adopting it means changing
`extensionName` in all four `_locales/*/messages.json` (translated per locale), then
rebuilding and re-uploading — and it renames the Firefox add-on too.

The summary is the one-liner in search results. It now names all six platforms so a
reviewer or user isn't surprised by permissions/functionality the old Slack-only summary
didn't disclose (`tests/packaging.test.js` pins it to 132 chars across every locale).
Changing it means editing the locale file, `npm run build`, and re-uploading the zip —
and it changes the Firefox package too, since both manifests share the locale.

### Description
_max 16,000 chars_

> **Chrome renders this as plain text.** Markdown does not work — `**bold**` shows the
> literal asterisks. The text below is already plain-text formatted (•, caps headings).
> Do not paste the Markdown version from `STORE_LISTING.md` here.

```
Free · No limits · No account · Nothing leaves your browser

Tired of scrolling back years to clean up your own posts and messages? Erasechat bulk-deletes your own content — with the filters and safety controls to do it right — across six platforms: Slack (built in) plus five optional platforms you connect one at a time: Reddit, X, Mastodon, Microsoft Teams, and Telegram.

Open a conversation (or your own account, for Reddit/X/Mastodon), pick your filters, preview exactly what will be removed, and delete in bulk — all from your browser.

💬 SLACK — the flagship engine
🎯 Precise filters
• Target your own messages in the current conversation
• By date — all time, older than X days, or a custom date range
• By keyword, phrase, or /regex/ pattern
• Include thread replies, or leave threads untouched
• Attachments-only mode — remove files and images while keeping the message text

🔍 Scan and preview before anything is deleted
• Run a scan to see every matching message first
• Un-check anything you want to keep — you are always in control
• Export the matched messages as a CSV backup in one click

🛟 Safety built in
• Type-to-confirm for large jobs (100+ messages)
• Pause, resume, or cancel any run at any time
• Single-conversation scope — it only touches the chat you opened
• Auto-pauses if you navigate to a different channel or workspace mid-run
• Rate-limit aware pacing that honors Slack's Retry-After
• Jobs resume reliably even if the browser restarts mid-cleanup

🌐 FIVE MORE PLATFORMS, EACH OPTIONAL
Connect Reddit, X, Mastodon, Microsoft Teams, or Telegram independently from the popup — none is required to use Slack, and none is contacted until you click it.
• Reddit — bulk-delete your own comments, posts, or both
• X — bulk-delete your own posts
• Mastodon — works with any instance; you provide a personal access token
• Microsoft Teams — bulk-delete your own chat messages (work/school accounts)
• Telegram — bulk-delete your own messages via a real, in-browser MTProto client
Every one of these follows the same scan → preview → confirm safety model as Slack: review and individually un-check matches before deleting, type-to-confirm for large batches, and cancel a run already in progress.

🔒 PRIVATE BY DESIGN, ON EVERY PLATFORM
• 100% local — all scanning and deleting happen in your browser tab
• No servers, no accounts, no tracking, no content uploaded to us
• Works through your existing login on each platform — no passwords or tokens sent to us, and every platform's credential stays in memory-only browser storage, never written to disk

⌨️ CONVENIENT
• Open the popup from the toolbar or with Ctrl+Shift+K (Cmd+Shift+K on macOS)
• Clean, modern interface with three color themes
• Localized UI (English, Spanish, French, German) across all six platforms

PLEASE NOTE
Erasechat is an independent tool and is not affiliated with, endorsed by, or sponsored by Slack, Reddit, X Corp., Mastodon gGmbH, Microsoft, or Telegram FZ-LLC. It acts on your behalf using your existing session (or, for Mastodon/Telegram, a credential you provide) on whichever platform(s) you connect. Deletions are permanent and cannot be undone — always preview before you delete. Deleting content you do not have permission to remove may be restricted by your workspace, instance, or tenant administrator.
Two opt-in modes can remove OTHER people's messages where the platform itself permits it: Slack's "All Messages" sender option (for workspace admins/owners) and Telegram with "Only my messages" turned off (e.g. both sides of a private chat, or messages in a group you administer). Both are off by default and every match is previewed first.
Deleting removes content through the platform's normal delete action. Platforms with retention, eDiscovery, or compliance-export policies (common on Microsoft Teams and enterprise Slack plans) may keep server-side copies that this tool cannot remove.
```

### Category
_Single-select, and it is marked "For all languages" — there is no secondary category._
```
Workflow & Planning
```

Chrome's taxonomy is not AMO's and not the "Productivity" wording in `STORE_LISTING.md`
(that was the pre-2023 name). `Communication` is the tempting alternative — skip it. It is
dominated by chat clients and meeting tools, and this is a maintenance utility, not a way
to talk to people. `Privacy & Security` is the AMO second choice and has no home here.

### Language
```
English (United States)
```
This is the listing's **primary** language. The package ships four locales —
`_locales/en`, `de`, `es`, `fr` — and the UI follows the browser's language, so the
description's "Localized UI (English, Spanish, French, German)" line is accurate. The
dashboard lets you add translated listing text per language later (Store listing →
*Add language*); until then German/Spanish/French users see the English listing but a
localized extension.

### Store icon
_128×128 · a **separate upload**, not read from the package_
```
icons/icon128.png
```
The same icon the toolbar and `chrome://extensions` show, so the listing matches what a
user sees after installing. Chrome's image guidelines suggest a 96×96 graphic centred in
the 128 canvas; this one is a full-bleed rounded square, which is what every modern store
icon does and what the dashboard accepts.

### Screenshots
_1280×800 (verified) · 24-bit PNG, no alpha (verified) · Chrome accepts up to 5 · order matters_

The form offers **two** slots — *Localized screenshots* (under English – en) and *Global
screenshots*. With only one listing language they are interchangeable. Upload the five to **Global**,
which covers every language including any added later; if the submit check still asks for
localized ones, upload the identical five there as well.

There are now 6 candidate screenshots (`00-platforms.png` added so the listing itself
discloses the 6-platform scope — see the note in §2 above about the old Slack-only
Description/Screenshots being the thing that made this look like undisclosed
functionality). Chrome's 5-slot cap means one of the original five has to go: dropped
`05-privacy.png` for Chrome specifically, since the description's own "PRIVATE BY DESIGN"
section and the required disclaimer already carry that message in text, whereas the
platform disclosure has no other home in the listing's visuals. AMO has no such cap — all
6 go there (see `AMO_SUBMISSION_FIELDS.md`).

| # | File | Caption (if captions are offered) |
|---|---|---|
| 1 | `store-assets/screenshots/00-platforms.png` | One extension. Six platforms. |
| 2 | `store-assets/screenshots/01-overview.png` | Set your rules, target any conversation. |
| 3 | `store-assets/screenshots/02-preview.png` | Scan first. Preview every message before it goes. |
| 4 | `store-assets/screenshots/03-safety.png` | Deletes are permanent — so we make you confirm. |
| 5 | `store-assets/screenshots/04-progress.png` | Watch it work — live progress and logs. |

### Promotional images

- **Small promo tile 440×280** — `store-assets/promo/promo-tile-440x280.png` (24-bit, no
  alpha, verified). Optional, but an item with no tile can never be featured or appear in
  a curated collection. Upload it.
- **Marquee 1400×560** — `store-assets/promo/marquee-1400x560.png` (24-bit, no alpha,
  verified). Built from `marquee.svg`, which reuses the icon mark and the tile's gradients
  so the three brand assets match. The lockup is centred with wide margins because Chrome
  crops the marquee at some placements, and it was checked legible downscaled to 440px,
  which is roughly how the carousel renders it.
- **Promo video** — none. Leave both video fields blank.

Regenerate any promo asset after editing its SVG:
```bash
python3 -c "
import cairosvg
from PIL import Image
cairosvg.svg2png(url='store-assets/promo/marquee.svg', write_to='/tmp/m.png',
                 output_width=1400, output_height=560)
im = Image.open('/tmp/m.png')
flat = Image.new('RGB', im.size, (15, 23, 42))   # flatten: Chrome rejects alpha here
flat.paste(im, (0, 0), im)
flat.save('store-assets/promo/marquee-1400x560.png', optimize=True)
"
```

`store-assets/promo/listing-icon-512.png` is the **AMO** listing icon (512×512). Chrome has
no 512 slot; do not try to force it into one.

### Additional fields

| Field | Value |
|---|---|
| Official URL | **None** — see below |
| Homepage URL | Repository URL — **only if the repository is public** (see below) |
| Support URL | Repository issues URL — **only if the repository is public**; otherwise leave blank and rely on the verified contact email |
| Mature content | **Off** |
| Item support | **On** (visible) |

**Repository visibility decides these two fields.** `.githooks/pre-push` and the README
describe the repo as private (no server-side branch protection on the free plan), and a
reviewer or user following a link to a private repo gets a 404. Provide the GitHub
homepage/support links only if the repository is public at submission time; otherwise
leave them blank. The same rule applies to the source link in §2.5 and the GitHub-hosted
privacy-policy URL in §2.

**Official URL** is a dropdown, not a text field: it only offers domains already verified
as yours in Google Search Console, and `github.com` can never be one of them. Leave it
**None**. It is only worth revisiting if this ever gets its own domain — at which point
setting it earns the listing a verified-owner link. Nothing about it blocks submission.

**Mature content** stays off. The extension deletes messages; nothing in it is sexual,
violent, or drug-related. Toggling this on would restrict the audience for no reason.

**Item support** should be visible — you filled in a support URL, and hiding the support
tab buries the only channel a user has for reporting a bug.

---

## 2. Privacy practices tab

> **Updated 2026-09-10 for the 6-platform tool.** The Summary, Description, single-purpose
> statement, every permission justification below (including `cookies`/`webRequest`
> and the new optional host permissions), and the Screenshots section now describe the
> current reality: Slack plus optional Reddit, X, Mastodon, Microsoft Teams, and Telegram
> support, each connected one at a time from the popup. Re-verify character counts in the
> actual dashboard before pasting; the counts noted here were measured against this
> version of the text.

### Single purpose
```
Erasechat has a single purpose: to help users bulk-delete and clean their own content across the platforms they connect to it. Slack support is built in. Five further platforms — Reddit, X, Mastodon, Microsoft Teams, and Telegram — are optional and connected one at a time, explicitly, from the extension's popup; none of them is required to use Slack. Everything the extension does on every platform — scanning, previewing matches, and deleting content — serves that one purpose: helping a user clean up their own past content.
```

### Permission justifications

> **Every justification box is capped at 1,000 characters**, the dashboard silently
> truncates a longer paste rather than warning you, and it appears to count a line break as
> two characters — a 993-char paste was still rejected. Budget to ~950 at most. Measured
> lengths: single purpose 288, storage 438, scripting 336, alarms 243, remote code 510,
> host permission 909. Re-count before pasting anything you have edited.

**`storage`**
```
Saves the user's filter preferences, first-run onboarding state, and the state of an in-progress deletion job so it can resume safely if the background service worker is suspended or the browser restarts. On every platform (Slack and the five optional ones), the account credential itself is deliberately excluded from persistent storage: it is held only in chrome.storage.session, which is cleared when the browser closes. Automated tests in the repository assert that no platform's credential is ever written to storage.local.
```

**`scripting`**
```
Injects the cleanup dashboard into the active Slack tab when the user clicks the toolbar button. It is a fallback for the case where the declared content script has not loaded — for example on a Slack tab that was already open when the extension was installed or updated. No code is fetched; only the bundled content script is injected.
```

**`alarms`**
```
Schedules two things: rate-limit back-offs that honor the Retry-After value Slack returns, and a watchdog that resumes an interrupted deletion job. Both must survive the MV3 service worker being suspended mid-job, which a setTimeout cannot do.
```

**Host permission — `https://*.slack.com/*`, `https://slack.com/*`**
_909 / 1,000. Two earlier drafts did not fit: 1,300 chars (cut off mid-sentence, silently)
and 993 chars, which the field still rejected — most likely because it counts a line break
as two characters. This version leaves 91 to spare, so it survives either counting rule._
```
Runs only on the Slack web client and calls only Slack's own API. It reads the conversation the user has open, finds their own matching messages, and deletes them on their explicit instruction. No other site is contacted; there is no backend, analytics or telemetry.

Endpoints: conversations.history and conversations.replies (find messages), conversations.info (name the conversation), users.list (show display names in the preview), chat.delete (delete a message), chat.update (attachments-only mode: strip files, keep text), files.info then files.delete (files.info runs first, and the file is kept if it is shared into another conversation, so cleaning one channel cannot destroy content elsewhere).

Calls use the user's existing Slack session, so no API token has to be created or pasted. That token is memory-only (chrome.storage.session), never written to disk, and never sent anywhere but slack.com.
```

Because 1,000 characters cannot hold the full token rationale, **Access → Test instructions
(§2.5) is now the only place it appears in full**. That tab is no longer optional polish.

**`cookies` (optional permission)**
```
Used only for the optional Reddit and X integrations, and only after the user explicitly clicks that platform in the popup. Reddit: checks for the user's own already-logged-in reddit.com session cookie so the extension can act as them without a separate login. X: reads the CSRF token (ct0) that platform's own web client already sets for a logged-in session. No cookie value is ever transmitted anywhere except back to that same platform's own API, and never to the developer; the value itself is kept only in chrome.storage.session (memory-only, cleared on browser close), never written to disk.
```

**`webRequest` (optional permission)**
```
Used only for the optional Microsoft Teams integration, and only after the user explicitly clicks Teams in the popup and grants this permission for the Teams hosts (teams.cloud.microsoft, where Microsoft now serves Teams on the web, and teams.microsoft.com) specifically. It passively observes the Authorization header on the user's own already-authenticated Teams web-client requests to capture a Bearer token, since Teams has no ambient session cookie the way Slack does. No request body or unrelated header is read or stored; only the Authorization value from requests whose path matches the chat API is kept, and only in chrome.storage.session (memory-only, cleared on browser close) — never written to disk.
```

**Optional host permissions — `*.reddit.com`, `*.x.com`, `*.twitter.com`, `*.teams.microsoft.com`, `*.msg.teams.microsoft.com`, `*.teams.cloud.microsoft`, `https://*/*`**
```
Each of the platform-specific patterns is requested only once the user clicks that platform in the popup, and is used only to call that platform's own official web/API endpoints on the user's behalf. The broad https://*/* entry is the declared upper bound Chrome requires so one narrow, runtime-resolved request can be legal: Mastodon (federated — every instance is a different origin) requests permission for only the exact instance URL the user typed. It never requests or receives the broad pattern itself — chrome.permissions.request() is always called with one specific, narrow origin.
```

**Remote code** — select **"No, I am not using remote code"**

The radio button alone is not enough: Chrome requires the justification box to be filled in
even when the answer is No, and leaving it empty is one of the errors the submit check
raises. Paste:
```
No remote code is used. Every line of JavaScript, HTML and CSS the extension executes ships inside the uploaded package. Nothing is fetched or injected at runtime, and there is no eval(), no new Function(), no remotely-hosted script tag and no dynamic import. The extension-pages content security policy is "script-src 'self'; object-src 'none'", which blocks remote execution at the platform level as well. The extension's only network requests are API calls to the platforms the user explicitly connects (slack.com, reddit.com, x.com, the user's own Mastodon instance, Microsoft Teams, and Telegram's MTProto servers), which return data — never code.
```

### Data usage

**Recommended (conservative): check _Authentication information_ and _Personal
communications_.** Also consider _Personally identifiable information_ (see below).

What the code actually does with each:

| Data type | What the extension handles | Leaves the device? |
|---|---|---|
| Authentication information | Reads the user's own session credentials: the Slack `xoxc-` token from the Slack page, Reddit's session cookie/modhash, X's `ct0` CSRF cookie, a captured Teams Bearer token, a Mastodon access token the user pastes, and a Telegram MTProto session created at login. Held in `chrome.storage.session` (memory-only). | Only to the same platform's own API, as that user. Never to the developer or any third party. |
| Personal communications | Reads the user's messages/posts/comments (and, in Slack/Telegram conversations, other participants' messages in the same conversation) to filter and preview them locally; can export a CSV on request. | No — rendered locally only. |
| Personally identifiable information | Display names (Slack `users.list` cache, 24 h), the user's X username and Mastodon account id, stored locally. | No. |

Chrome's User Data policy covers data an extension **handles**, not only data it sends to
its developer, and reviewers compare the checkboxes against what the permissions and code
obviously touch. An extension that reads session tokens and chat messages but declares
neither is the kind of mismatch that draws a rejection or a later takedown. Checking
the boxes is accurate; the trust message ("nothing leaves your browser") belongs in the
description and the privacy policy, which state plainly that this data is processed
locally and never transmitted to the developer.

If a justification/notes field is offered, use:
```
Erasechat handles the user's own session credentials (Slack, Reddit, X, Teams, Mastodon, Telegram) solely to call each platform's own API on the user's behalf, and reads the user's messages/posts solely to filter, preview and delete them at the user's request. All processing is local in the browser; credentials are kept only in memory-only session storage; nothing is transmitted to the developer or any third party. No analytics or telemetry.
```

The Firefox manifest's `data_collection_permissions: ["none"]` is unaffected: Mozilla
defines collection strictly as transmission to the developer or third parties, which does
not happen.

**Certifications — check all three:**
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL
```
https://github.com/yogesh-bhatttk/erasechat/blob/main/PRIVACY_POLICY.md
```
Chrome requires a hosted HTTPS page here and, unlike AMO, will **not** accept pasted
policy text. **This GitHub URL only works while the repository is public** — re-check it
returns HTTP 200 logged out before submitting. If the repo is private, host the policy
elsewhere (any public HTTPS page; `privacy.html` is self-contained).

If you would rather serve it as a real page than a GitHub file view, enable GitHub Pages on
`main` and use `https://yogesh-bhatttk.github.io/erasechat/privacy.html` —
`privacy.html` is fully self-contained (inline CSS, no external requests), so it works as-is.
Either URL satisfies the requirement; the GitHub one needs no new infrastructure.

---

## 2.5. Access tab → Test instructions

Chrome's counterpart to AMO's "Notes for Reviewer". A reviewer cannot exercise this
extension without a Slack account, and the extension reads a session token out of the Slack
page's `localStorage` — which looks alarming with no context. Explaining it here is the
cheapest way to avoid a rejection that is purely a misunderstanding.

There is also a "Does this item require a login?" style question on this tab. Answer that
it needs **a Slack account, but no credentials from us** — there is no account to hand out,
any free Slack workspace works, and the extension has no login of its own.

```
Thanks for reviewing. Context that should make testing straightforward.

WHAT IT DOES
Erasechat adds a dashboard to the Slack web client that bulk-deletes the user's
OWN messages in the conversation they currently have open, with filters (sender, date range,
keyword or /regex/, attachments-only, thread replies), a mandatory scan-and-preview step,
and a resumable background delete queue.

LOGIN
No credentials are needed from us and none exist — the extension has no account system. It
acts through the reviewer's own Slack session. Any free Slack workspace is enough to test.

HOW TO TEST
1. Sign in to any Slack workspace at https://app.slack.com.
2. Open a channel or DM and post a few throwaway messages.
3. Click the toolbar icon, then "Open Clean Dashboard" (Ctrl+Shift+K opens the popup).
4. Choose filters and press "Scan Messages" — this step is read-only and deletes nothing.
5. Review the previewed list, then press "Start Deleting".
   Jobs over 100 messages require typing DELETE to confirm.

EVERY SLACK API ENDPOINT USED, AND WHY
  conversations.history  read the open conversation to find matching messages
  conversations.replies  read thread replies, when "include threads" is enabled
  conversations.info     resolve the open conversation's name and type for the UI
  users.list             cache member display names so the preview shows "Alice" instead
                         of "U01ABC". Cached locally for 24h, used only for rendering.
  chat.delete            delete one of the user's messages
  chat.update            attachments-only mode: strip files/attachments, keep the text
  files.info             check how many conversations a file is shared into, BEFORE
                         deleting it (see the safety note below)
  files.delete           remove a file the user is deleting along with its message

A deliberate safety detail: Slack's files.delete purges a file from every conversation it
was ever shared into, not just this one. So files.info is called first and the file is left
intact if it is shared anywhere else — cleaning one conversation can never destroy content
in another.

ABOUT THE SLACK TOKEN (please read — this is the part that looks unusual)
The extension reads the user's existing Slack session token from the Slack web app's own
localStorage key "localConfig_v2", in the Slack tab, and calls the endpoints above as that
already-logged-in user.

- The token is never stored on disk. It is held in memory and in chrome.storage.session,
  which is cleared when the browser closes. An automated test in the repository asserts
  that no token is ever written to storage.local.
- The token is never transmitted anywhere except slack.com. There is no backend, no
  analytics, no telemetry, and no third-party endpoint of any kind.
- This is the only way to act on the user's behalf without asking them to create a Slack
  app and paste a long-lived API token, which would be a worse experience and a worse
  security posture for a personal cleanup tool.

NO REMOTE CODE
All code is bundled in the package. Nothing is fetched or eval'd at runtime. The
extension-pages CSP is "script-src 'self'; object-src 'none'".

SOURCE
Unminified and readable exactly as shipped, except the two Telegram bundles
(platforms/telegram/*.bundle.js), which are webpack builds of the matching *.src.js files
plus the teleproto MTProto library: npm ci && node scripts/build-telegram.js.
[Source link: add "Source: <repository URL>" here only if the repository is public;
otherwise omit this line and attach the source zip (git archive of the release tag) where
the dashboard allows it.]

DATA COLLECTION
None. Nothing leaves the user's device except the calls to Slack's own API listed above.

SENDER MODES
By default only the user's own messages are matched. The "All Messages" sender option is
for workspace admins/owners and can delete other members' messages where Slack permits it;
it is opt-in, previewed, and saved presets can never silently switch to it. Telegram has an
equivalent opt-in ("Only my messages" off).

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

---

## 3. Distribution / Payments tab

| Field | Value |
|---|---|
| Visibility | **Public** |
| Distribution | All regions |
| Pricing | Free — no in-app purchases, no accounts, no paid tier |

---

## 4. Known review risks

Neither is a reason to delay the submission — both are answered honestly in the fields
above. They are here so a rejection email is not a surprise.

1. **Platform trademarks.** The product is now **Erasechat** (multi-platform), not the
   earlier "… for Slack" name, so no third-party mark is in the title — keep it that way
   (the suggested `Erasechat – Bulk Delete Messages, Posts & Comments` names no platform).
   Platform names appear only descriptively in the summary/description, the icon uses
   none of their logos, and the description carries an explicit non-affiliation
   disclaimer for all six. If Chrome still objects to a platform name in the copy, the
   fix is a wording change, not an appeal.
2. **Reading the session token from `localStorage`.** This is the part that looks unusual
   at a glance, and it is explained in two places on purpose: the host-permission
   justification (§2, shown next to the permission during review) and Test instructions
   (§2.5, the reviewer's testing brief). Do not shorten either — they are read by different
   parts of the process.

## 5. Before you click Submit

Two things that cannot be checked from this repo — both still open on
[`SUBMISSION_CHECKLIST.md`](./SUBMISSION_CHECKLIST.md):

- [ ] **Run a real delete against live Slack** with the unpacked Chrome build. The
      `credentials: "include"` cookie flow is the make-or-break path and there is no way
      to exercise it offline.
- [ ] **Check the "On click" site-access path.** Set the extension's *Site access* to
      *On click*, open the popup on a Slack tab, and confirm the "Site Access Required"
      screen appears with working guidance. This is the state a cautious user installs
      into, and Chrome exposes no API to simulate it in automation.

## 6. After it is published

- Chrome assigns the extension ID at publish time; note it down.
- Unlike AMO, deleting a Chrome item does **not** burn an identifier — the
  never-delete-the-listing rule in `SUBMISSION_CHECKLIST.md` §5 is Firefox-specific.
- Updates: `npm run version:set <version>` → `npm run build` → upload the new chrome zip
  to the same item. Chrome rejects a re-upload of a version number it has already accepted,
  so the bump is required.
