// Runs webpack.telegram.config.js. Telegram's dependency (teleproto, a real MTProto
// client) needs webpack's Node-polyfill plugin.
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
