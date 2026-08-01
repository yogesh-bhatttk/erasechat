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

- [ ] Developer account (free)
- [ ] Upload the Firefox zip
- [ ] Data collection: **"none"** — already declared in the manifest via
      `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`,
      and pinned there by `npm test`. Confirm the dashboard answers match.
- [ ] Expect **1 warning, 0 errors** from `npm run validate:firefox`:
      `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`. Expected and safe; warnings do
      not block a submission.
      - It notes only that `data_collection_permissions` is inert on Firefox for Android
        before 142. The add-on does not ship to Android at all (see below), so the key
        being inert there has no effect. Older Firefox ignores unknown manifest keys.
      - **Do not silence it by declaring `gecko_android`.** That would reach 0 warnings
        by claiming Android support the UI cannot honor: the dashboard is a fixed
        880×760 multi-panel modal with no viewport breakpoints, so it is unusable on a
        phone. Shipping a knowingly-broken experience to buy a green checkmark is a bad
        trade. Pinned by `npm test`.
      - **Do not lower `strict_min_version` below `140.0`.** 140 is the floor for
        `data_collection_permissions`, and it is also the current ESR — Firefox 115 ESR
        reached end-of-life in March 2026, so claiming 115 advertised support on a
        browser that no longer gets security patches, for a tool that handles a live
        Slack session token. Also pinned by `npm test`.
      - Do not remove the `data_collection_permissions` disclosure — AMO expects it for
        new listings.
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
