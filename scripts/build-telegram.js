// Runs webpack.telegram.config.js. Separate from scripts/build-bluesky.js (esbuild)
// because Telegram's dependency (teleproto, a real MTProto client) needs webpack's
// Node-polyfill plugin -- esbuild has no equivalent. See webpack.telegram.config.js
// for why the two bundlers run side by side rather than being unified.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const webpackCli = path.join(__dirname, "..", "node_modules", ".bin", "webpack");

try {
  execFileSync(webpackCli, ["--config", "webpack.telegram.config.js"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit"
  });
} catch (err) {
  console.error("Telegram bundle build failed:", err.message);
  process.exit(1);
}
