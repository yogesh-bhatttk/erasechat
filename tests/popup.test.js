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
