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

- [ ] `npm test` → 52/52 green
- [ ] `npm run build` → produces `dist/bulk-clean-for-slack-chrome-<v>.zip` and
      `dist/bulk-clean-for-slack-firefox-<v>.zip`
- [ ] Manifests validate:
      - Chrome: `google-chrome --pack-extension=<dir>` succeeds (valid `.crx`)
      - Firefox: `npx addons-linter dist/bulk-clean-for-slack-firefox-<v>.zip` → 0 errors

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
- [ ] Data collection: "none" (manifest already declares it)
- [ ] Add privacy policy, screenshots, description
- [ ] Submit for review

## 6. Post-rename housekeeping (in this repo)

- [x] Name changed to "Bulk Clean for Slack" everywhere user-facing
- [x] `manifest.json` (Chrome) / `manifest.firefox.json` (Firefox) both validate
- [x] `LICENSE` (MIT), `README.md`, `SECURITY.md`, `TERMS.md`, `CONTRIBUTING.md`
- [ ] Bump `version` in both manifests + `package.json` for each release
- [ ] Tag the release and update `CHANGELOG.md` heading from "Unreleased" to the version
