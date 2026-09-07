// ESLint flat config for Bulk Clean for Slack.
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
  AbortController: "readonly"
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
    files: ["background/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...browserGlobals, self: "readonly" }
    },
    rules: correctnessRules
  },
  {
    // Standalone per-platform dashboard pages (opened via chrome.tabs.create,
    // unlike Slack's shadow-DOM overlay in content.js) — full DOM available.
    files: ["dashboard-*.js"],
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
    files: ["popup/connect-*.js"],
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
    // popup/connect-<platform>.js function by name -- declared here as each
    // platform's migration step adds one.
    files: ["popup/platform-registry.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        module: "writable",
        connectReddit: "readonly",
        connectX: "readonly",
        connectMastodon: "readonly",
        connectTeams: "readonly"
      }
    },
    rules: correctnessRules
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.js"],
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
