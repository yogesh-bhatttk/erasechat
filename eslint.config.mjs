// ESLint flat config for Erasechat.
//
// Scoped deliberately narrow: this is a correctness gate, not a style enforcer. The
// rules enabled are the ones that catch bugs which are genuinely hard to see by eye in
// extension code — a typo'd global (there is no bundler or type checker to catch one),
// a duplicated object key, an unreachable branch, a redeclared function.
//
// Style is intentionally NOT enforced. The codebase is heavily commented prose-style
// and a formatter would churn it without making it more correct.

const browserGlobals = {
  chrome: "readonly",
  console: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  atob: "readonly"
};

// Provided by shared-filters.js, which loads before background.js in BOTH browsers
// (importScripts on Chrome, background.scripts ordering on Firefox).
const sharedFilterGlobals = {
  qualifies: "readonly",
  decideItemAction: "readonly",
  isSlackHostname: "readonly",
  fileShareCount: "readonly",
  isSafeRegex: "readonly",
  stringToColor: "readonly"
};

const correctnessRules = {
  // The single most valuable rule here: with no build step, a misspelled global is a
  // runtime crash in the user's browser and nowhere else.
  "no-undef": "error",
  // Unused CATCH bindings are an accepted idiom in this codebase (`catch (e) { /* ... */ }`
  // documents a deliberately swallowed failure), so they are exempt.
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
  "no-redeclare": ["error", { builtinGlobals: false }],
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-dupe-else-if": "error",
  "no-duplicate-case": "error",
  "no-unreachable": "error",
  "no-fallthrough": "error",
  "no-cond-assign": "error",
  "no-self-compare": "error",
  "no-self-assign": "error",
  "no-sparse-arrays": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  // Destructive tool: an ignored promise rejection can silently abandon a delete job.
  "no-async-promise-executor": "error",
  "require-atomic-updates": "off"
};

export default [
  {
    // Generated output, not hand-written and not committed (see .gitignore):
    // scripts/build-bluesky.js's bundles at repo root, and scripts/build.sh's
    // full packaged copies under dist/. Linting bundled/packaged third-party
    // code is neither useful nor meaningful.
    ignores: [
      "platforms/bluesky/bluesky-popup.bundle.js", "platforms/bluesky/bluesky-dashboard.bundle.js",
      "platforms/telegram/telegram-popup.bundle.js", "platforms/telegram/telegram-dashboard.bundle.js",
      "dist/**"
    ]
  },
  {
    // Background service worker / event page.
    files: ["background.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...browserGlobals,
        ...sharedFilterGlobals,
        self: "readonly",
        importScripts: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    // Per-platform background listeners, pulled into background.js via
    // importScripts on Chrome or manifest.firefox.json's background.scripts on
    // Firefox (see background.js's own comment on that split).
    files: ["platforms/teams/teams-webrequest.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...browserGlobals, self: "readonly" }
    },
    rules: correctnessRules
  },
  {
    // Bluesky's popup/dashboard source, pre-bundle (see scripts/build-bluesky.js).
    // Unlike every other file here, these use real ES-module import statements --
    // esbuild resolves them at build time, so sourceType must be "module" for
    // ESLint to parse them at all.
    files: ["platforms/bluesky/bluesky-popup.src.js", "platforms/bluesky/bluesky-dashboard.src.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...browserGlobals,
        window: "readonly",
        document: "readonly",
        indexedDB: "readonly",
        alert: "readonly",
        prompt: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    // Telegram's popup/dashboard source, pre-bundle (see
    // webpack.telegram.config.js). Same ES-module situation as Bluesky's above.
    files: ["platforms/telegram/telegram-popup.src.js", "platforms/telegram/telegram-dashboard.src.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...browserGlobals,
        window: "readonly",
        document: "readonly",
        alert: "readonly",
        prompt: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    // Loaded as a plain classic <script> before either Telegram bundle -- see the
    // file's own header comment for why (MV3 extension-page CSP blocks inline
    // scripts, so this can't be inlined into the HTML instead).
    files: ["platforms/telegram/process-shim.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { self: "readonly", Promise: "readonly" }
    },
    rules: correctnessRules
  },
  {
    // Standalone per-platform dashboard pages (opened via chrome.tabs.create,
    // unlike Slack's shadow-DOM overlay in content.js) — full DOM available.
    files: ["platforms/*/dashboard-*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...browserGlobals,
        window: "readonly",
        document: "readonly",
        alert: "readonly",
        prompt: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    // Injected dashboard (content script) and popup — full DOM available.
    // content.js also has a small module.exports (matchesActiveWorkspaceChannel)
    // for its own `node --test` coverage — see tests/content.test.js.
    files: ["content.js", "popup.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...browserGlobals,
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        requestAnimationFrame: "readonly",
        Blob: "readonly",
        module: "writable",
        // Provided by popup/platform-registry.js, loaded before popup.js.
        PLATFORMS: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    // Shared logic: runs as a worker global AND as a CommonJS module under `node --test`.
    files: ["shared-filters.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...browserGlobals, module: "writable" }
    },
    rules: correctnessRules
  },
  {
    // Per-platform "connect" helpers the popup calls after a permission grant --
    // full browser API surface (chrome, fetch), plus module.exports for Node tests.
    files: ["platforms/*/connect-*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...browserGlobals, module: "writable" }
    },
    rules: correctnessRules
  },
  {
    // Platform metadata table: same dual browser-global / CommonJS-module shape as
    // shared-filters.js, loaded before popup.js. Each entry can reference its own
    // platforms/<platform>/connect-<platform>.js function by name -- declared here
    // as each platform's migration step adds one.
    files: ["popup/platform-registry.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        module: "writable",
        URL: "readonly",
        connectReddit: "readonly",
        connectX: "readonly",
        connectMastodon: "readonly",
        connectTeams: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.js", "webpack.telegram.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...browserGlobals,
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
        process: "readonly",
        Buffer: "readonly",
        // Playwright specs routinely pass callbacks to page.evaluate() that are
        // serialized and run INSIDE the extension page, not in this (Node) file's
        // own scope -- so `window`/`document` inside those callbacks refer to the
        // page's globals, not anything Node-side.
        window: "writable",
        document: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    // Specs that reach into the popup's own page scope via page.evaluate(). Those
    // callbacks are serialized and run INSIDE the extension page, so the identifiers
    // below are popup.js's top-level functions, not Node globals — which is why
    // no-undef flags them here without this declaration.
    //
    // Listing them explicitly (rather than relaxing no-undef for the file) keeps the
    // rule meaningful for the rest of the spec, and doubles as the record of which
    // popup functions the e2e suite depends on by name: rename one in popup.js and
    // this list is where the coupling is written down.
    files: ["tests/permissions.spec.js"],
    languageOptions: {
      globals: {
        hasSlackAccess: "readonly",
        showPermissionRequiredState: "readonly",
        showActiveState: "readonly"
      }
    }
  },
  {
    // Same page.evaluate() page-scope situation as tests/permissions.spec.js above,
    // for the identifiers this spec's callbacks reach for: the platform registry
    // itself and the connect-<platform>.js function under test.
    files: ["tests/platform-connect.spec.js"],
    languageOptions: {
      globals: {
        PLATFORMS: "readonly",
        connectTeams: "readonly"
      }
    }
  }
];
