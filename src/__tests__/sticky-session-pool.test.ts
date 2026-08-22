import test, { mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildStickyInternalKey,
  disallowedToolsKey,
  isIdleExpired,
  isAbsoluteExpired,
  parseStickyTtlMs,
  __hashAgentsForTests,
  acquireStickySession,
  resetStickyPoolForTests,
} from "../subprocess/sticky-session-pool.js";
import { StreamJsonSubprocess, type StreamJsonOptions } from "../subprocess/stream-json-manager.js";
import { initPoolCounters, initPoolStats, __resetInitPoolForTests } from "../subprocess/init-pool.js";

test("disallowedToolsKey sorts tools for stable fingerprinting", () => {
  assert.equal(disallowedToolsKey(["mcp__b", "mcp__a"]), "mcp__a,mcp__b");
  assert.equal(disallowedToolsKey([]), "");
});

test("internal key changes across model and tool policy", () => {
  const base = {
    sessionKeyHash: "abc123",
    model: "claude-sonnet-4-6",
    runtime: "stream-json" as const,
    disallowedToolsKey: "",
    effortKey: "",
    thinkingKey: "",
    permissionModeKey: "",
    systemPromptKey: "",
    agentsKey: "",
    modesKey: "",
    mcpPolicyKey: "mcp:on",
    cwd: "/tmp/proxy",
    dynamicPromptExclusion: true,
  };
  const same = buildStickyInternalKey(base);
  const differentModel = buildStickyInternalKey({ ...base, model: "claude-opus-4-7" });
  const differentTools = buildStickyInternalKey({ ...base, disallowedToolsKey: "mcp__n8n__list" });
  const differentEffort = buildStickyInternalKey({ ...base, effortKey: "high" });
  const differentThinking = buildStickyInternalKey({ ...base, thinkingKey: "on" });
  const differentPermMode = buildStickyInternalKey({ ...base, permissionModeKey: "plan" });
  const differentSysPrompt = buildStickyInternalKey({ ...base, systemPromptKey: "abcdef1234567890" });
  const differentAgents = buildStickyInternalKey({ ...base, agentsKey: "1234567890abcdef" });
  const differentModes = buildStickyInternalKey({ ...base, modesKey: "b1s1" });
  assert.equal(same, buildStickyInternalKey(base));
  assert.notEqual(same, differentModel);
  assert.notEqual(same, differentTools);
  assert.notEqual(same, differentEffort, "effortKey must be part of the sticky fingerprint");
  assert.notEqual(same, differentThinking, "thinkingKey must be part of the sticky fingerprint");
  assert.notEqual(same, differentPermMode, "permissionModeKey must be part of the sticky fingerprint");
  assert.notEqual(same, differentSysPrompt, "systemPromptKey must be part of the sticky fingerprint");
  assert.notEqual(same, differentAgents, "agentsKey must be part of the sticky fingerprint");
  assert.notEqual(same, differentModes, "modesKey must be part of the sticky fingerprint");
  assert.match(same, /^[a-f0-9]{64}$/);
});

test("idle expiration uses lastUsedAt and ttlMs", () => {
  assert.equal(isIdleExpired({ lastUsedAt: 1000, ttlMs: 5000 }, 7001), true);
  assert.equal(isIdleExpired({ lastUsedAt: 1000, ttlMs: 5000 }, 6000), false);
});

test("absolute expiration can be disabled with zero", () => {
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 900000, 0), false);
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 900000, 60_000), true);
  assert.equal(isAbsoluteExpired({ createdAt: 1000 }, 30_000, 60_000), false);
});

test("parseStickyTtlMs converts seconds to milliseconds", () => {
  assert.equal(parseStickyTtlMs(60), 60_000);
  assert.equal(parseStickyTtlMs(86400), 86_400_000);
});

// Welle 4 Gruppe A — M1: align sticky-pool agents-hashing with session-pool.
// Two agents objects with the same keys in different insertion order must
// produce the same sticky fingerprint, mirroring the session-pool behaviour.
test("hashAgents is insertion-order-independent (stableStringify alignment)", () => {
  const agentsA = { researcher: { role: "r" }, planner: { role: "p" } };
  const agentsB = { planner: { role: "p" }, researcher: { role: "r" } };
  assert.equal(
    __hashAgentsForTests("ad-hoc", agentsA),
    __hashAgentsForTests("ad-hoc", agentsB),
    "sticky agents hash must be order-independent (drift with session-pool fixed)",
  );
  // Semantically different agents map → must still differ.
  const agentsC = { planner: { role: "p" }, researcher: { role: "different" } };
  assert.notEqual(
    __hashAgentsForTests("ad-hoc", agentsA),
    __hashAgentsForTests("ad-hoc", agentsC),
  );
});

// ---------------------------------------------------------------------------
// Folgebefund zu M2 (2026-08-22): warum createProcess() NICHT nach der
// Spawn-Konfiguration schlüsselt.
//
// `createProcess` trägt dieselbe schmale Bedingung, die in routes.ts der Kern
// von M2 war. Hier ist sie kein toter Code, aber nahezu wirkungslos: sobald ein
// Aufruf `tools` mitschickt — bei openclaw der Normalfall — füllt
// externalNativeToolDisallowList() die disallowedTools, und der Sticky-Kaltstart
// geht am Vorrat vorbei.
//
// Der Vorrat könnte ihn seit M2 technisch bedienen. Er tut es bewusst nicht,
// aus demselben Grund, den M2 in session-pool.ts `cold()` ausgeschrieben hat:
// die Flags stammen aus dem Client-Body. Gemessen am gebauten Stand ist das
// Budget des Init-Pools bereits voll — drei Prewarm-Modelle plus Honchos sechs
// Schemata ergeben neun Konfigurationen bei MAX_SLOTS=6; die drei Prewarm-Slots
// sind danach restlos verdrängt. Ein dritter, client-gesteuerter Mieter würde
// je Konfiguration einen Honcho-Slot verdrängen und M2 damit still zurücknehmen.
//
// Die Tests pinnen deshalb die Entscheidung fest: der flaggenlose Sticky-Kaltstart
// nutzt den Vorrat, der flaggenbehaftete nicht. Wer das ändert, ändert eine
// Kapazitätspolitik und muss sie in init-pool.ts mitbringen (getrenntes Budget
// oder Aufnahmeregel), nicht hier.
// ---------------------------------------------------------------------------

const spawns: StreamJsonOptions[] = [];

before(() => {
  mock.method(StreamJsonSubprocess.prototype, "start", async function (this: any, opts: StreamJsonOptions) {
    spawns.push(opts);
    this.model = opts.model;
    this.spawnedAt = Date.now();
  });
  mock.method(StreamJsonSubprocess.prototype, "isHealthy", () => true);
  mock.method(StreamJsonSubprocess.prototype, "getAge", () => 0);
  mock.method(StreamJsonSubprocess.prototype, "kill", () => {});
});

after(() => mock.restoreAll());

beforeEach(() => {
  spawns.length = 0;
  resetStickyPoolForTests();
  __resetInitPoolForTests();
});

/** Lässt die im Hintergrund angestoßene Nachfüllung des Vorrats durchlaufen. */
async function drainBackgroundRefill(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

async function acquireSticky(sessionKeyHash: string, disallowedTools?: string[]) {
  const res = await acquireStickySession({
    sessionKeyHash,
    sessionKeyHashShort: sessionKeyHash.slice(0, 8),
    ttlSeconds: 3600,
    reset: false,
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hallo" }],
    bodyForPrompt: {},
    ...(disallowedTools ? { disallowedTools } : {}),
  });
  res.release({ status: "success", assistantText: "ok" });
  return res;
}

test("flaggenloser Sticky-Kaltstart nutzt den Init-Vorrat", async () => {
  await acquireSticky("session-plain");
  assert.equal(
    initPoolCounters.coldSpawns + initPoolCounters.warmHits,
    1,
    "der flaggenlose Pfad muss durch den Init-Pool gehen — sonst ist auch er versehentlich gekappt",
  );
});

test("Sticky-Kaltstart MIT Flags geht bewusst am Init-Vorrat vorbei", async () => {
  // Genau das, was externalNativeToolDisallowList() aus einem `tools`-Body macht.
  await acquireSticky("session-flagged", ["mcp__n8n__list", "n8n__list"]);

  assert.equal(
    initPoolCounters.coldSpawns + initPoolCounters.warmHits,
    0,
    "bewusst: client-gesteuerte Spawn-Konfigurationen dürfen das Honcho-Budget nicht verdrängen",
  );
  assert.equal(spawns.length, 1, "stattdessen genau ein dedizierter Prozess");
  assert.deepEqual(
    [...(spawns[0].disallowedTools ?? [])].sort(),
    ["mcp__n8n__list", "n8n__list"],
    "der dedizierte Prozess trägt die Flags des Aufrufs",
  );

  await drainBackgroundRefill();
  assert.equal(
    initPoolStats().size,
    0,
    "und er parkt keinen 240-MB-Slot für eine Konfiguration, die der Client bestimmt",
  );
});
