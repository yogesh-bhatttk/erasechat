// Bundles Bluesky's popup/dashboard source (bluesky-{popup,dashboard}.src.js) with
// @atproto/api and @atproto/oauth-client-browser into the plain IIFE bundles
// dashboard-bluesky.html / popup.html's #bluesky-view load directly as
// <script src>. Run by scripts/build.sh before it copies/zips runtime assets --
// see this repo's other platforms for why: an unbundled ES-module <script> throws
// immediately in a browser, and this was caught live once already this session.
const esbuild = require("esbuild");

async function build() {
  await esbuild.build({
    entryPoints: {
      "bluesky-popup.bundle": "bluesky-popup.src.js",
      "bluesky-dashboard.bundle": "bluesky-dashboard.src.js"
    },
    bundle: true,
    outdir: ".",
    minify: false,
    sourcemap: true,
    target: ["chrome109", "firefox109"],
    format: "iife"
  });

  console.log("Bluesky bundle build complete.");
}

build().catch((err) => {
  console.error("Bluesky bundle build failed:", err);
  process.exit(1);
});
