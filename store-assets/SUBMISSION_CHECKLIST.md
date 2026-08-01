# Submission Checklist — Bulk Clean for Slack

A single place to track everything needed to publish. Items marked **(blocker)** must be
resolved before submitting; **(you)** require your action outside this repo.

## 0. Before you submit — hard blockers

- [ ] **(blocker, you)** **Verify it works on live Slack.** Load the unpacked build, sign
      into a throwaway Slack workspace, and run a real scan + a small delete. Confirm
      messages actually delete (the `credentials: "include"` cookie flow is the make-or-break
      path and can't be tested offline). Test on both Chrome and Firefox.
- [ ] **(you)** **Check the restricted-site-access path once.** In Chrome, set the
      extension's *Site access* to **On click**, open the popup on a Slack tab, and confirm
      you get the "Site Access Required" screen with working guidance — not a spinner or
      "reload the page". This is the state a cautious user installs into, and it is the one
      failure mode that cannot be reproduced from automation (Chrome exposes no API to
      revoke a required host permission), which is why it is a manual check.
- [ ] **(blocker, you)** **Trademark / policy review.** Name is now "Bulk Clean for Slack"
      (compliant "X for Slack" form, not leading with "Slack"). Confirm you're comfortable
      with Slack's brand guidelines and API/ToS, given the extension uses the private
      `xoxc-` session token. Consider whether an official Slack OAuth app is warranted.
- [ ] **(you)** Decide on hosting for the privacy policy (see step 2).

## 1. Assets (in this repo)

- [x] Icons 16/32/48/128 — `icons/`
- [x] Screenshots 1280×800 ×5 — `store-assets/screenshots/` (rebranded to
      "Bulk Clean for Slack"). Regenerate anytime with
      `node store-assets/screenshots/src/gen.js` + the render loop documented in that file.
- [x] Promo tile 440×280 — `store-assets/promo/promo-tile-440x280.png` (Chrome small tile; optional)
- [x] Listing copy — `store-assets/STORE_LISTING.md` (name, descriptions, captions,
      single-purpose, permission justifications, data-use answers)

## 2. Privacy policy hosting **(you)**

- [ ] Host `PRIVACY_POLICY.md` (or the rendered `privacy.html`) at a public HTTPS URL.
- [ ] Paste that URL into both store dashboards (required by Chrome when data is handled).
- [ ] (Optional) The in-extension popup already links to the bundled `privacy.html`.

## 3. Build

- [ ] `npm run verify` → runs the whole gate in order: `lint` → `test` → `test:e2e` →
      `build` → `validate:firefox`. Green means every check below already passed.

Or run them individually:

- [ ] `npm run lint` → 0 problems
- [ ] `npm test` → 84/84 green (unit + packaging gates)
- [ ] `npm run test:e2e` → 12/12 green (needs `npx playwright install chromium`; extensions
      require headful Chromium, so use `xvfb-run` on a headless machine)
- [ ] `npm run build` → produces `dist/bulk-clean-for-slack-chrome-<v>.zip` and
      `dist/bulk-clean-for-slack-firefox-<v>.zip`
- [ ] Manifests validate:
      - Chrome: `google-chrome --pack-extension=<dir>` succeeds (valid `.crx`)
      - Firefox: `npm run validate:firefox` → 0 errors

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR and uploads both
zips as build artifacts, so a green CI run is equivalent to this section.

## 4. Chrome Web Store **(you)**

- [ ] Developer account (one-time $5 fee)
- [ ] Upload the Chrome zip
- [ ] Fill "Privacy practices": single purpose, permission justifications, data-use
      certifications, remote-code = No (all prepared in `STORE_LISTING.md`)
- [ ] Add privacy policy URL, category (Productivity), screenshots, description
- [ ] Submit for review

## 5. Firefox Add-ons (AMO) **(you)**

> ### ⚠️ Never delete an add-on on AMO to "start clean"
>
> Deleting an add-on **permanently blocks its add-on ID** — Mozilla blocklists the GUID to
> prevent hostile takeover of a published identifier. The ID can never be submitted again
> by anyone, including you. Re-uploading the same package then fails forever with
> **"Duplicate add-on ID found."**
>
> Recovering a burned ID means emailing `amo-admins@mozilla.org` from the owning account
> and waiting on a human. Generating a fresh UUID is faster, but each round trip burns
> another one.
>
> **The rule:** once an upload validates, an add-on record exists. To change the package
> after that, bump the version (`npm run version:set 1.0.1`) and upload a **new version**
> to the existing listing — via *My Add-ons → the listing → Upload New Version*. Never
> delete and re-submit. AMO also rejects re-uploading a version number it has already
> seen, which is why the bump is required.
>
> Corollary: **get the package fully validated before the first upload.**
> `npm run verify` must be clean (it now reports 0 errors / 0 warnings / 0 notices) so
> the first upload is also the last one.
>
> IDs already burned on this account, for the record — do not reuse:
> - `{a1b2c3d4-e5f6-7890-abcd-ef1234567890}` (the original template placeholder)
> - `{2f1a47b2-e534-4428-8b9d-02c65f01bcad}` (uploaded, then deleted)

- [ ] Developer account (free)
- [ ] Upload the Firefox zip
- [ ] Data collection: **"none"** — already declared in the manifest via
      `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`,
      and pinned there by `npm test`. Confirm the dashboard answers match.
- [ ] Expect **0 errors, 0 warnings, 0 notices** from `npm run validate:firefox`.
      A clean report is the current baseline — anything at all appearing here is a
      regression worth reading, not noise to scroll past.
      - **Do not lower `strict_min_version` below `142.0`.** `data_collection_permissions`
        landed on desktop in 140 but on Firefox for Android in **142**, and because
        `gecko_android` is absent the validator derives the Android floor from this same
        value. 142 is what produces a clean report (verified by linting 140/141/142
        builds — only 142 is clean). Pinned by `npm test`.
      - **Known cost of that choice:** 142 excludes Firefox 140–141, and **140 is the
        current ESR** (115 ESR died in March 2026). Users pinned to ESR 140 — typically
        enterprise deployments — cannot install this build. This was accepted deliberately
        to reach a clean validator report. If you would rather have those users back,
        set `140.0` and accept one `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`
        warning; warnings never block a submission.
      - **Do not reach 0 warnings by declaring `gecko_android` instead.** That key is
        exactly how AMO decides an add-on is Android-compatible — without it, AMO does
        not list the add-on on Android at all. Declaring it would put a fixed 880×760
        multi-panel modal with no viewport breakpoints in front of phone users. Pinned
        by `npm test`.
      - Do not remove the `data_collection_permissions` disclosure — AMO expects it for
        new listings, and removing it just swaps the warning for
        `MISSING_DATA_COLLECTION_PERMISSIONS` (verified).
      - **Validate with `addons-linter@^10`** (what `npm run validate:firefox` pins).
        Older v7 wrongly reports this key as a hard error, so an unpinned validator can
        give the opposite verdict on the same zip.
- [ ] Add privacy policy, screenshots, description
- [ ] Submit for review

## 6. Post-rename housekeeping (in this repo)

- [x] Name changed to "Bulk Clean for Slack" everywhere user-facing
- [x] `manifest.json` (Chrome) / `manifest.firefox.json` (Firefox) both validate
- [x] `LICENSE` (MIT), `README.md`, `SECURITY.md`, `TERMS.md`, `CONTRIBUTING.md`
- [ ] Bump the version with `npm run version:set <version>` — it rewrites both manifests,
      `package.json` and the lockfile together, and validates the number against Chrome's
      rules first. (`npm test` fails if the three ever drift.)
- [ ] Update `CHANGELOG.md`: move the "Unreleased" heading to the version and date it
- [ ] Tag and push: `git tag v<version> && git push --follow-tags`. CI re-runs the full
      gate, refuses a tag that disagrees with the packaged version, and attaches both
      store zips to the GitHub Release — so the files you upload to the stores are the
      exact ones that passed. Uploading to the stores stays manual (steps 4 and 5).
