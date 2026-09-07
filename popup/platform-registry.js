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
    dashboard: "platforms/reddit/dashboard-reddit.html",
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
    dashboard: "platforms/x/dashboard-x.html",
    connect: () => connectX(),
    ready: true
  },
  {
    id: "mastodon",
    name: "Mastodon",
    accent: ["#6364FF", "#563ACC"],
    // Federated: no fixed hostname to auto-detect. The user's instance origin is
    // resolved from what they type (see resolveOrigin) and requested narrowly at
    // that point -- optionalHostPermissions below is only the upper bound Chrome
    // requires be declared in the manifest for that narrow request to be legal.
    isTabMatch: null,
    optionalHostPermissions: ["https://*/*"],
    dashboard: "platforms/mastodon/dashboard-mastodon.html",
    // Shown inline when the row is clicked, before any permission is requested --
    // there's nothing to request access to until the user names an instance.
    form: [
      { id: "instance-url", label: "Instance URL", type: "text", placeholder: "mastodon.social" },
      { id: "access-token", label: "Access Token", type: "password", placeholder: "Personal access token" }
    ],
    resolveOrigin: (values) => {
      let host = (values["instance-url"] || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
      // A raw Unicode/IDN hostname (e.g. "münchen.social", typed or pasted
      // verbatim) fails the ASCII-only regex below even though it's a
      // perfectly legitimate hostname -- punycode-normalize it first via URL,
      // same as a real browser would. Only invoked for non-ASCII input, so
      // plain ASCII hostnames (the common case) take an unchanged code path.
      if (/[^\x00-\x7F]/.test(host)) {
        try {
          const url = new URL(`https://${host}`);
          // Reject rather than silently accept if the input carried a path or
          // port beyond a bare hostname -- this branch exists only to fix IDN
          // encoding, not to become more permissive than the plain-ASCII path.
          if ((url.pathname !== "/" && url.pathname !== "") || url.port) {
            return null;
          }
          host = url.hostname;
        } catch {
          return null;
        }
      }
      // Reject anything that isn't a plain hostname before it becomes part of a
      // Chrome match pattern -- e.g. a literal "*" would silently widen the
      // requested host permission from "this one instance" to "every matching
      // subdomain" instead of failing validation.
      if (!host || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)) {
        return null;
      }
      return `https://${host}/*`;
    },
    connect: (values) => connectMastodon(values),
    ready: true
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    accent: ["#6264A7", "#464775"],
    isTabMatch: (hostname) => hostname === "teams.microsoft.com" || hostname.endsWith(".teams.microsoft.com"),
    optionalHostPermissions: ["*://*.teams.microsoft.com/*", "*://*.msg.teams.microsoft.com/*"],
    optionalPermissions: ["webRequest"],
    dashboard: "platforms/teams/dashboard-teams.html",
    // No form, no cookie to check -- background/teams-webrequest.js passively
    // captures a token once permission is granted; this just waits for that.
    connect: () => connectTeams(),
    ready: true
  },
  {
    id: "telegram",
    name: "Telegram",
    accent: ["#2AABEE", "#229ED9"],
    // Native MTProto client, not a web origin -- nothing to auto-detect or match,
    // and no host permission needed (it talks over its own WebSocket transport).
    // popup.js's generic connectAndLaunchPlatform() is not used for this platform
    // at all (see onPlatformRowClick's special case, same as Slack) --
    // telegram-popup.bundle.js manages its own multi-step login entirely.
    isTabMatch: null,
    dashboard: "platforms/telegram/dashboard-telegram.html",
    ready: true
  }
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PLATFORMS };
}
