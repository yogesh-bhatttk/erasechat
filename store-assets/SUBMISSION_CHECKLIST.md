# Submission Checklist — Bulk Clean for Slack

A single place to track everything needed to publish. Items marked **(blocker)** must be
resolved before submitting; **(you)** require your action outside this repo.

## 0. Before you submit — hard blockers

- [ ] **(blocker, you)** **Verify it works on live Slack.** Load the unpacked build, sign
      into a throwaway Slack workspace, and run a real scan + a small delete. Confirm
      messages actually delete (the `credentials: "include"` cookie flow is the make-or-break
      path and can't be tested offline). Test on both Chrome and Firefox.
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
- [ ] `npm test` → 73/73 green (unit + packaging gates)
- [ ] `npm run test:e2e` → 7/7 green (needs `npx playwright install chromium`; extensions
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

- [ ] Developer account (free)
- [ ] Upload the Firefox zip
- [ ] Data collection: **"none"** — already declared in the manifest via
      `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`,
      and pinned there by `npm test`. Confirm the dashboard answers match.
- [ ] Expect **2 warnings, 0 errors** from `npm run validate:firefox`:
      `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` and
      `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`. These are expected and safe —
      they note only that `data_collection_permissions` is inert before Firefox 140 /
      Firefox-for-Android 142, and older Firefox ignores unknown manifest keys. Warnings
      do not block a submission.
      - Keeping `strict_min_version: "115.0"` is a deliberate trade: raising it to `140.0`
        silences one warning but drops Firefox 115–139 users. Do not "fix" the warning by
        removing the disclosure — AMO expects it for new listings.
      - **Validate with `addons-linter@^10`** (what `npm run validate:firefox` pins).
        Older v7 wrongly reports this key as a hard error, so an unpinned validator can
        give the opposite verdict on the same zip.
- [ ] Add privacy policy, screenshots, description
- [ ] Submit for review

## 6. Post-rename housekeeping (in this repo)

- [x] Name changed to "Bulk Clean for Slack" everywhere user-facing
- [x] `manifest.json` (Chrome) / `manifest.firefox.json` (Firefox) both validate
- [x] `LICENSE` (MIT), `README.md`, `SECURITY.md`, `TERMS.md`, `CONTRIBUTING.md`
- [ ] Bump `version` in both manifests + `package.json` for each release
- [ ] Tag the release and update `CHANGELOG.md` heading from "Unreleased" to the version
