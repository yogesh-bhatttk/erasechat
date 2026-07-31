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
        Blob: "readonly"
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
        Buffer: "readonly"
      }
    },
    rules: correctnessRules
  }
];
