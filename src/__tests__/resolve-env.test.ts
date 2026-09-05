import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnv, resolveEnvDefaults } from "../subprocess/manager.js";
import { resolveAnthropicApiKey } from "../auth/credentials-resolver.js";

// Which environment variable carries the token decides whether a --bare spawn
// can authenticate at all. ANTHROPIC_API_KEY travels as `x-api-key`, which only
// accepts `sk-ant-api…` keys; an OAuth token (`sk-ant-oat…`) is rejected there
// with "Invalid API key" by CLI 2.1.220. ANTHROPIC_AUTH_TOKEN travels as
// `Authorization: Bearer` and works. Measured against a live tenant on
// 2026-07-26 — a regression that stays silent until a background pipeline
// quietly stops producing anything, so it is pinned here.
//
// WARUM DIESE TESTS DEN HOST NICHT MEHR FRAGEN (2026-09-05):
// Bis hierher rief der erste Test die echte Tokenquelle und fing ihren Fehler
// mit `t.skip("no resolvable token on this host")` ab. Auf einer Maschine mit
// abgelaufenem `~/.claude/.credentials.json` meldete der Lauf damit
// `ok 1 … # SKIP`, `# fail 0`, Exit 0 — nachgestellt mit sabotiertem HOME.
// Der Test sah gruen aus, obwohl er nichts geprueft hatte, und ausgerechnet
// die Entwicklermaschine ist der Ort, an dem so ein File abgelaufen sein kann.
//
// Der Gegenstand dieser Tests sind die fuenf Zeilen von `resolveEnv`, nicht die
// Frage, ob dieser Rechner gerade angemeldet ist. Die Tokenquelle wird deshalb
// eingesetzt (`deps.resolveToken`), und dass die VORGABE die echte Quelle ist,
// steht als eigene Behauptung darunter. Kein Uebersprung mehr — auf keinem Host.

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

test("resolveEnv: injectOAuthEnv exposes the token as ANTHROPIC_AUTH_TOKEN", async () => {
  await withEnv(
    {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ENVTEST",
      ANTHROPIC_API_KEY: "sk-ant-api03-STRAY",
    },
    async () => {
      const env = await resolveEnv(
        { injectOAuthEnv: true },
        { resolveToken: async () => "sk-ant-oat01-INJECTED" },
      );
      assert.equal(
        env.ANTHROPIC_AUTH_TOKEN,
        "sk-ant-oat01-INJECTED",
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

test("resolveEnv: without injectOAuthEnv the token source is never consulted", async () => {
  // Sonst zoege ein Aufruf ohne OAuth-Bedarf trotzdem am Credentials-File —
  // teuer und ein Fehlschlag, wo gar keiner noetig waere.
  let calls = 0;
  await resolveEnv(
    {},
    {
      resolveToken: async () => {
        calls++;
        return "unused";
      },
    },
  );
  assert.equal(calls, 0, "kein injectOAuthEnv = kein Griff zur Tokenquelle");
});

test("resolveEnv: ein Fehler der Tokenquelle wird durchgereicht, nicht geschluckt", async () => {
  // Die Regressionsklasse, gegen die diese Datei ueberhaupt steht: still
  // degradieren. Ein --bare-Spawn ohne Token authentifiziert sich nicht, und
  // eine Hintergrund-Pipeline stellt dann wortlos die Arbeit ein.
  await assert.rejects(
    () =>
      resolveEnv(
        { injectOAuthEnv: true },
        {
          resolveToken: async () => {
            throw new Error("credentials_not_found");
          },
        },
      ),
    /credentials_not_found/,
  );
});

test("resolveEnv: die Vorgabe-Tokenquelle IST der echte Resolver", async () => {
  // Haelt den Testsitz ehrlich: die Tests oben setzen die Quelle ein, dieser
  // belegt, dass im Betrieb die echte danebensteht. Ohne ihn koennte die
  // Verdrahtung brechen, waehrend alles gruen bleibt.
  assert.equal(
    resolveEnvDefaults.resolveToken,
    resolveAnthropicApiKey,
    "resolveEnv muss im Betrieb gegen resolveAnthropicApiKey aufloesen",
  );
});
