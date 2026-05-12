import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStickyInternalKey,
  disallowedToolsKey,
  isIdleExpired,
  isAbsoluteExpired,
  parseStickyTtlMs,
  __hashAgentsForTests,
} from "../subprocess/sticky-session-pool.js";

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
