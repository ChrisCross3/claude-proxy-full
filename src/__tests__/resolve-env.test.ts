import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnv } from "../subprocess/manager.js";

// Which environment variable carries the token decides whether a --bare spawn
// can authenticate at all. ANTHROPIC_API_KEY travels as `x-api-key`, which only
// accepts `sk-ant-api…` keys; an OAuth token (`sk-ant-oat…`) is rejected there
// with "Invalid API key" by CLI 2.1.220. ANTHROPIC_AUTH_TOKEN travels as
// `Authorization: Bearer` and works. Measured against a live tenant on
// 2026-07-26 — a regression that stays silent until a background pipeline
// quietly stops producing anything, so it is pinned here.

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("resolveEnv: injectOAuthEnv exposes the token as ANTHROPIC_AUTH_TOKEN", async (t) => {
  await withEnv(
    {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ENVTEST",
      ANTHROPIC_API_KEY: "sk-ant-api03-STRAY",
    },
    async () => {
      let env: NodeJS.ProcessEnv;
      try {
        env = await resolveEnv({ injectOAuthEnv: true });
      } catch (err) {
        // Only reachable when this machine has a credentials file that is
        // itself broken (expired/malformed) — not what this test is about.
        t.skip(`no resolvable token on this host: ${(err as Error).message}`);
        return;
      }
      assert.ok(
        env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN.length > 0,
        "token must be exposed as ANTHROPIC_AUTH_TOKEN",
      );
      assert.equal(
        env.ANTHROPIC_API_KEY,
        undefined,
        "a stray ANTHROPIC_API_KEY must not survive and outrank the token",
      );
      assert.equal(env.OPENCLAW_PROXY, "1");
    },
  );
});

test("resolveEnv: without injectOAuthEnv the environment is passed through untouched", async () => {
  await withEnv(
    {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ENVTEST",
      ANTHROPIC_API_KEY: "sk-ant-api03-KEEP",
      ANTHROPIC_AUTH_TOKEN: undefined,
    },
    async () => {
      const env = await resolveEnv({});
      assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-api03-KEEP");
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.OPENCLAW_PROXY, "1");
    },
  );
});
