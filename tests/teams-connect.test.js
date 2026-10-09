// Regression tests for the Teams action-popup flow.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { connectTeams } = require(path.resolve(__dirname, "../platforms/teams/connect-teams.js"));

test("connectTeams opens Teams and returns immediately when no token exists", async () => {
  let openedUrl = null;
  global.chrome = {
    storage: {
      session: {
        get: async () => ({})
      },
      local: {
        get: async () => ({})
      }
    },
    tabs: {
      create: ({ url }) => { openedUrl = url; }
    }
  };

  const startedAt = Date.now();
  const result = await connectTeams();

  assert.strictEqual(openedUrl, "https://teams.cloud.microsoft/");
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /reopen|click.*toolbar/i);
  assert.ok(Date.now() - startedAt < 100, "must not poll from a popup that will be closed");
});

test("connectTeams succeeds without opening another tab when a token is already captured", async () => {
  let opened = false;
  global.chrome = {
    storage: {
      session: {
        get: async () => ({ teams_token: "Bearer token" })
      },
      local: {
        get: async () => ({ teams_base_url: "https://teams.microsoft.com" })
      }
    },
    tabs: {
      create: () => { opened = true; }
    }
  };

  assert.deepStrictEqual(await connectTeams(), { ok: true });
  assert.strictEqual(opened, false);
});
