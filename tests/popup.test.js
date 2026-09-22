// Erasechat - popup.js unit tests (Node, zero-dependency, node --test)
//
// popup.js is a browser popup script (top-level DOMContentLoaded wiring guarded by
// `typeof document !== "undefined"` so it can load here with no real DOM). This
// suite only exercises isSlackClientTab -- see its own comment in popup.js for why
// it's a deliberate fork of shared-filters.js's isSlackHostname() rather than a
// shared import, and why that fork needs its own copy of the spoof-battery test.

const test = require("node:test");
const assert = require("node:assert");
const { isSlackClientTab } = require("../popup.js");
const { isSlackHostname } = require("../shared-filters.js");
const { PLATFORMS } = require("../popup/platform-registry.js");

test("isSlackClientTab: accepts any genuine slack.com subdomain over HTTPS", () => {
  assert.equal(isSlackClientTab("https://app.slack.com/client/T1234/C5678"), true);
  assert.equal(isSlackClientTab("https://app.slack.com/"), true);
  assert.equal(isSlackClientTab("https://sackmate.slack.com/"), true); // workspace subdomain
});

test("isSlackClientTab: rejects spoofed, wrong-scheme, and unrelated origins", () => {
  assert.equal(isSlackClientTab("https://app.slack.com.attacker.com/"), false); // suffix spoof
  assert.equal(isSlackClientTab("https://slack.com.evil.com/"), false);
  assert.equal(isSlackClientTab("https://evilslack.com/"), false);             // no dot before slack.com
  assert.equal(isSlackClientTab("https://evil.com/app.slack.com"), false);
  assert.equal(isSlackClientTab("http://app.slack.com/"), false);              // not HTTPS
  assert.equal(isSlackClientTab("https://slack.com/"), false);                 // bare domain
  assert.equal(isSlackClientTab("not a url"), false);
  assert.equal(isSlackClientTab(""), false);
  assert.equal(isSlackClientTab(undefined), false);
});

// The drift guard the popup.js comment promises: run the SAME spoof battery
// through both implementations and require identical verdicts, so a future fix to
// one (e.g. a new spoof vector discovered against isSlackHostname) can't silently
// leave the other one vulnerable.
test("isSlackClientTab stays in sync with shared-filters.js's isSlackHostname", () => {
  const urls = [
    "https://app.slack.com/client/T1234/C5678",
    "https://app.slack.com/",
    "https://sackmate.slack.com/",
    "https://fake-app.slack.com/",
    "https://app.slack.com.attacker.com/",
    "https://slack.com.evil.com/",
    "https://evilslack.com/",
    "https://evil.com/app.slack.com",
    "http://app.slack.com/",
    "https://slack.com/",
    "not a url",
    "",
  ];
  for (const url of urls) {
    assert.equal(
      isSlackClientTab(url),
      isSlackHostname(url),
      `isSlackClientTab and isSlackHostname disagree on ${JSON.stringify(url)}`
    );
  }
});

// Mastodon's resolveOrigin() is the sole gate standing between the user's typed
// instance URL and the "https://*/*" optional-host-permission ceiling declared
// in the manifest -- it decides which single origin actually gets requested.
// Any way it can be tricked into resolving something other than the exact
// hostname the user meant (a wider match pattern, a different attacker-chosen
// host) would turn that broad manifest ceiling into an actual over-broad grant.
const mastodon = PLATFORMS.find((p) => p.id === "mastodon");
const { resolveOrigin } = mastodon;

test("resolveOrigin: accepts a plain hostname", () => {
  assert.equal(resolveOrigin({ "instance-url": "mastodon.social" }), "https://mastodon.social/*");
});

test("resolveOrigin: strips a leading https:// and a trailing slash", () => {
  assert.equal(resolveOrigin({ "instance-url": "https://mastodon.social/" }), "https://mastodon.social/*");
});

test("resolveOrigin: strips a leading http:// too", () => {
  assert.equal(resolveOrigin({ "instance-url": "http://mastodon.social" }), "https://mastodon.social/*");
});

test("resolveOrigin: rejects a literal '*' instead of widening the match pattern", () => {
  assert.equal(resolveOrigin({ "instance-url": "*" }), null);
});

test("resolveOrigin: rejects userinfo/@ tricks rather than silently targeting the host after '@'", () => {
  // If this were fed straight into `new URL()` unguarded, "real.social@attacker.com"
  // resolves to host attacker.com with userinfo "real.social" -- exactly the kind
  // of silent retargeting this function must not allow for a plain-ASCII input.
  assert.equal(resolveOrigin({ "instance-url": "real.social@attacker.com" }), null);
  assert.equal(resolveOrigin({ "instance-url": "https://real.social@attacker.com/" }), null);
});

test("resolveOrigin: rejects input carrying a path beyond a bare hostname", () => {
  assert.equal(resolveOrigin({ "instance-url": "mastodon.social/path" }), null);
  assert.equal(resolveOrigin({ "instance-url": "mastodon.social/@user" }), null);
});

test("resolveOrigin: rejects input carrying a port", () => {
  assert.equal(resolveOrigin({ "instance-url": "mastodon.social:8080" }), null);
});

test("resolveOrigin: rejects empty, missing, and blank input", () => {
  assert.equal(resolveOrigin({}), null);
  assert.equal(resolveOrigin({ "instance-url": "" }), null);
  assert.equal(resolveOrigin({ "instance-url": "   " }), null);
});

test("resolveOrigin: punycode-normalizes a non-ASCII/IDN hostname and accepts it", () => {
  // "münchen.social" is a legitimate hostname a real user might type; it fails
  // the ASCII-only regex verbatim, so this only passes if the IDN branch
  // normalizes it via URL (the same way a real browser would) before validating.
  assert.equal(resolveOrigin({ "instance-url": "münchen.social" }), "https://xn--mnchen-3ya.social/*");
});

test("resolveOrigin: rejects an IDN hostname carrying a path or port after normalization", () => {
  assert.equal(resolveOrigin({ "instance-url": "münchen.social/@user" }), null);
  assert.equal(resolveOrigin({ "instance-url": "münchen.social:8080" }), null);
});
