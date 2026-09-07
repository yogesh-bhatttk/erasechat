# Contributing to Erasechat

Thanks for your interest in improving Erasechat. Because this tool
**permanently deletes user data**, correctness and safety take priority over everything
else — please keep that lens on any change.

## Ground rules

- **The delete/keep decision lives in one place.** All filtering and the delete/keep/skip
  decision are in [`shared-filters.js`](shared-filters.js) (`qualifies()`,
  `decideItemAction()`, `isSafeRegex()`, `fileShareCount()`, `isSlackHostname()`). It is
  the single source of truth, loaded by the background context and `require`d by the unit
  tests. **Do not fork this logic into the content script.**
- **Add a test for any behavior change to the decision logic.** Over-deletion,
  under-deletion, ReDoS, and wrong-channel/workspace scenarios must stay covered.
- **Never weaken a safety guard** (confirm modals, drift protection, share-count file
  check, ReDoS/empty-regex checks) without a clear, tested justification.

## Development setup

```bash
npm install            # dev-only (Playwright for e2e)
npm run hooks:install  # enable the pre-push guard on main (see below)
npm test               # unit tests (node --test, zero-dependency) — must stay green
npm run test:e2e       # Playwright end-to-end (requires browsers)
npm run build          # produce dist/ store zips for Chrome and Firefox
```

### The pre-push guard

`npm run hooks:install` points `core.hooksPath` at [`.githooks/`](.githooks/), enabling a
`pre-push` hook that stands in for server-side branch protection — GitHub gates that
behind a paid plan for private repos, so `main` has none. It refuses a force-push or
deletion of `main`, and runs lint + tests before any push to it.

Run it once per clone; git deliberately does not transfer hooks when cloning. It is
advisory only — `git push --no-verify` bypasses it, and it cannot police pushes from
another machine. Use `SC_PREPUSH_FULL=1 git push` to run the entire gate (e2e, builds,
addons-linter) instead of the fast half.

Load unpacked for manual testing — see the [README](README.md#install). Chrome uses
`manifest.json`; Firefox uses `manifest.firefox.json` (copy it to `manifest.json`).

## Making a change

1. Branch off `main`.
2. Keep changes focused; match the surrounding code style (comment density, naming, idiom).
3. Run `npm test` (must be green) and syntax-check any changed JS
   (`node --check <file>`).
4. If you touched a manifest, re-validate: `google-chrome --pack-extension` (Chrome) and
   `npx addons-linter dist/bulk-clean-for-slack-firefox-*.zip` (Firefox) must report no
   errors.
5. Update [CHANGELOG.md](CHANGELOG.md) with a short entry.
6. Open a PR describing the change and, for anything touching deletion, the concrete
   scenario it affects.

## Reporting bugs & security issues

- Functional bugs: open an issue with reproduction steps.
- **Security vulnerabilities:** do **not** open a public issue — see
  [SECURITY.md](SECURITY.md) for private disclosure.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
