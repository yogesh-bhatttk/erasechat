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
- [ ] **Upload `dist/bulk-clean-for-slack-chrome-1.0.0.zip`** — the **chrome** zip.
      Not the firefox one; it carries `browser_specific_settings`, which Chrome flags.
      Rebuild with `npm run build` if the source changed since 2026-08-02.

There is **no reviewer-notes field** on the Chrome dashboard — nothing equivalent to AMO's
"Notes for Reviewer". Everything a reviewer needs to not be alarmed by the session-token
read has to live in the **permission justifications** below, which is why the host-permission
one is long.

---

## 1. Store listing tab

### Item name
_max 75 chars · currently 20_
```
Bulk Clean for Slack
```

### Summary
_max 132 chars · currently 124. This is the one-liner in search results._
```
Bulk-delete your own Slack messages by sender, date, keyword, threads & files. Scan, preview, then delete — safely, locally.
```

### Description
_max 16,000 chars · currently 1,981_

> **Chrome renders this as plain text.** Markdown does not work — `**bold**` shows the
> literal asterisks. The text below is already plain-text formatted (•, caps headings).
> Do not paste the Markdown version from `STORE_LISTING.md` here.

```
Tired of scrolling back years to clean up your Slack? Bulk Clean for Slack clears your own messages in bulk — with the filters and safety controls to do it right.

Open any channel, private group, or direct message, pick your filters, preview exactly what will be removed, and delete in bulk — all from your browser.

🎯 PRECISE FILTERS
• Target your own messages in the current conversation
• By date — all time, older than X days, or a custom date range
• By keyword, phrase, or /regex/ pattern
• Include thread replies, or leave threads untouched
• Attachments-only mode — remove files and images while keeping the message text

🔍 SCAN AND PREVIEW BEFORE ANYTHING IS DELETED
• Run a scan to see every matching message first
• Un-check anything you want to keep — you are always in control
• Export the matched messages as a CSV backup in one click

🛟 SAFETY BUILT IN
• Type-to-confirm for large jobs (100+ messages)
• Pause, resume, or cancel any run at any time
• Single-conversation scope — it only touches the chat you opened
• Auto-pauses if you navigate to a different channel or workspace mid-run
• Rate-limit aware pacing that honors Slack's Retry-After
• Jobs resume reliably even if the browser restarts mid-cleanup

🔒 PRIVATE BY DESIGN
• 100% local — all scanning and deleting happen in your browser tab
• No servers, no accounts, no tracking, no message content uploaded
• Works through your existing Slack login — no passwords or tokens to enter

⌨️ CONVENIENT
• Open the dashboard from the toolbar or with Ctrl+Shift+K (Cmd+Shift+K on macOS)
• Clean, modern interface with three color themes

PLEASE NOTE
Bulk Clean for Slack is an independent tool and is not affiliated with, endorsed by, or sponsored by Slack. It acts on your behalf using your existing Slack session. Deletions are permanent and cannot be undone — always preview (and export a backup) before you delete. Deleting messages you do not have permission to remove may be restricted by your workspace.
```

### Category

Chrome's taxonomy is not AMO's and not the "Productivity" wording in `STORE_LISTING.md`
(that was the pre-2023 name). Pick:

- **Primary: `Workflow & Planning`**
- If a second category is offered: **`Privacy & Security`**

`Communication` is the tempting alternative — skip it. It is dominated by chat clients and
meeting tools, and this is a maintenance utility, not a way to talk to people.

### Language
```
English (United States)
```
The package ships only `_locales/en`, so any other choice would promise localizations that
do not exist.

### Screenshots
_1280×800 (verified) · Chrome accepts up to 5 · order matters_

| # | File | Caption (if captions are offered) |
|---|---|---|
| 1 | `store-assets/screenshots/01-overview.png` | Set your rules, target any conversation. |
| 2 | `store-assets/screenshots/02-preview.png` | Scan first. Preview every message before it goes. |
| 3 | `store-assets/screenshots/03-safety.png` | Deletes are permanent — so we make you confirm. |
| 4 | `store-assets/screenshots/04-progress.png` | Watch it work — live progress and logs. |
| 5 | `store-assets/screenshots/05-privacy.png` | 100% local. Nothing leaves your browser. |

### Promotional images

- **Small promo tile 440×280** — `store-assets/promo/promo-tile-440x280.png`. Optional,
  but an item with no tile can never be featured or appear in a curated collection. Upload it.
- **Marquee 1400×560** — not produced. Leave blank; it is only used for large editorial
  placements a 1.0.0 release will not get.

### URLs

| Field | Value |
|---|---|
| Homepage URL | `https://github.com/yogesh-bhatttk/bulk-clean-for-slack` |
| Support URL | `https://github.com/yogesh-bhatttk/bulk-clean-for-slack/issues` |

> Both are live — the repo is **public**. (Note: `AMO_SUBMISSION_FIELDS.md` says to leave
> AMO's support website blank because the repo was private. That is now stale — if the AMO
> listing is already up, go back and add the issues URL there too.)

---

## 2. Privacy practices tab

### Single purpose
```
Bulk Clean for Slack has a single purpose: to help users bulk-delete and clean their own messages in the Slack web client (app.slack.com and workspace subdomains). Everything the extension does — scanning conversations, previewing matches, and deleting messages — serves that one purpose.
```

### Permission justifications

**`storage`**
```
Saves the user's filter preferences, first-run onboarding state, and the state of an in-progress deletion job so it can resume safely if the background service worker is suspended or the browser restarts. The Slack session token is deliberately excluded from this: it is held only in chrome.storage.session, which is cleared when the browser closes. An automated test in the repository asserts the token is never written to storage.local.
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
```
The extension runs only on the Slack web client and calls only Slack's own API. It reads the conversation the user currently has open, finds the user's own matching messages, and deletes them at the user's explicit instruction. No other site is accessed and there is no backend of any kind.

Endpoints used: conversations.history and conversations.replies (find matching messages), conversations.info (name the open conversation in the UI), users.list (cache display names so the preview shows "Alice" rather than "U01ABC"), chat.delete (delete a message), chat.update (attachments-only mode: strip files but keep the text), files.info and files.delete (remove an attached file — files.info is called first, and the file is left intact if it is shared into any other conversation, so cleaning one channel can never destroy content in another).

Authentication: the extension uses the user's existing Slack web session, reading the session token from the Slack app's own localStorage in the Slack tab. This avoids asking users to create a Slack app and paste a long-lived API token, which would be both a worse experience and a worse security posture. The token stays in chrome.storage.session (memory-only, cleared on browser close), is never written to disk, and is never sent anywhere except slack.com.
```

**Remote code**
```
No, I am not using remote code.
```
All code is bundled in the package. Nothing is fetched or `eval`'d at runtime; the
extension-pages CSP is `script-src 'self'; object-src 'none'`.

### Data usage

**Leave every data-type checkbox UNCHECKED.**

Chrome defines collection as obtaining data and **transmitting it off the user's device**.
This extension transmits nothing to the developer or to any third party — there is no
backend, no analytics, no telemetry. The only network traffic is the user's own browser
talking to Slack's API over the user's own session, which is the service they are already
logged into and the action they explicitly asked for.

Do not "play it safe" by checking *Authentication information* or *Personal communications*.
Those checkboxes render as a public "this developer collects…" panel on the listing page,
which would tell every visitor something untrue about a tool whose entire pitch is that it
is local-only.

**Certifications — check all three:**
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL
```
https://github.com/yogesh-bhatttk/bulk-clean-for-slack/blob/main/PRIVACY_POLICY.md
```
Verified reachable (HTTP 200). Chrome requires a hosted HTTPS page here and, unlike AMO,
will **not** accept pasted policy text.

If you would rather serve it as a real page than a GitHub file view, enable GitHub Pages on
`main` and use `https://yogesh-bhatttk.github.io/bulk-clean-for-slack/privacy.html` —
`privacy.html` is fully self-contained (inline CSS, no external requests), so it works as-is.
Either URL satisfies the requirement; the GitHub one needs no new infrastructure.

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

1. **The trademark "for Slack".** The name follows the compliant `<name> for Slack` form
   rather than leading with the mark, the icon does not use Slack's, and the description
   carries an explicit non-affiliation disclaimer. Chrome can still ask for a rename; if it
   does, the fix is a name change, not an appeal.
2. **Reading the session token from `localStorage`.** This is the part that looks unusual
   at a glance and it is why the host-permission justification explains it in full. Chrome
   reviewers have no separate notes field to read, so that justification is the only place
   the explanation can land — do not shorten it.

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
