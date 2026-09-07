// Single source of truth for every platform the unified popup can launch into.
//
// Loaded as a classic script (no bundler, no ES modules) before popup.js -- same
// constraint popup.js/background.js already work under -- so it defines a plain
// global, PLATFORMS, plus a Node-visible module.exports for the test suite.
//
// "ready: false" platforms are inert placeholders for this pass: the popup lists
// them and explains they're coming soon, but does not offer a permission-request
// or dashboard-launch flow for them yet. Each becomes "ready: true" as its own
// migration step lands (see the project's merge plan).
const PLATFORMS = [
  {
    id: "slack",
    name: "Slack",
    accent: ["#8B5CF6", "#EC4899"],
    // Slack is not launched through the generic optional-permission + dashboard-tab
    // path below -- it keeps its existing content-script + shadow-DOM overlay flow,
    // matched here only so the popup can highlight it when the active tab is Slack.
    isTabMatch: (hostname) => hostname.endsWith(".slack.com"),
    ready: true
  },
  {
    id: "reddit",
    name: "Reddit",
    accent: ["#FF4500", "#FF871D"],
    isTabMatch: (hostname) => hostname === "reddit.com" || hostname.endsWith(".reddit.com"),
    optionalHostPermissions: ["*://*.reddit.com/*"],
    optionalPermissions: ["cookies"],
    dashboard: "dashboard-reddit.html",
    // Called after permission grant, before opening the dashboard tab. Defined in
    // popup/connect-reddit.js (loaded by popup.html alongside this registry).
    connect: () => connectReddit(),
    ready: true
  },
  {
    id: "x",
    name: "X",
    accent: ["#1d9bf0", "#0f1419"],
    isTabMatch: (hostname) => hostname === "x.com" || hostname.endsWith(".x.com") ||
      hostname === "twitter.com" || hostname.endsWith(".twitter.com"),
    optionalHostPermissions: ["*://*.x.com/*", "*://*.twitter.com/*"],
    optionalPermissions: ["cookies"],
    dashboard: "dashboard-x.html",
    connect: () => connectX(),
    ready: true
  },
  {
    id: "mastodon",
    name: "Mastodon",
    accent: ["#6364FF", "#563ACC"],
    // Federated: no fixed hostname to auto-detect. The user's instance origin is
    // resolved from what they type and requested narrowly at that point, not here.
    isTabMatch: null,
    optionalHostPermissions: ["https://*/*"],
    dashboard: "dashboard-mastodon.html",
    ready: false
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    accent: ["#6264A7", "#464775"],
    isTabMatch: (hostname) => hostname.endsWith(".teams.microsoft.com"),
    optionalHostPermissions: ["*://*.teams.microsoft.com/*", "*://*.msg.teams.microsoft.com/*"],
    optionalPermissions: ["webRequest"],
    dashboard: "dashboard-teams.html",
    ready: false
  },
  {
    id: "bluesky",
    name: "Bluesky",
    accent: ["#0085ff", "#10b981"],
    // Account's PDS host varies per user and is resolved at connect-time, not here.
    isTabMatch: null,
    optionalHostPermissions: ["https://*/*"],
    optionalPermissions: ["identity"],
    dashboard: "dashboard-bluesky.html",
    ready: false
  },
  {
    id: "telegram",
    name: "Telegram",
    accent: ["#2AABEE", "#229ED9"],
    // Native MTProto client, not a web origin -- nothing to auto-detect or match,
    // and no host permission needed (it talks over its own WebSocket transport).
    isTabMatch: null,
    dashboard: "dashboard-telegram.html",
    ready: false
  }
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PLATFORMS };
}
