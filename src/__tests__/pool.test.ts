/**
 * Tests for src/subprocess/pool.ts — print-mode subprocess acquisition.
 *
 * Verifies the cold-spawn path forwards all CLI flag fields onto
 * ClaudeSubprocess.prepare(), so requests in --print mode don't silently
 * drop effort/thinking/permissionMode/etc.
 *
 * Mocks prepare() to avoid spawning real `claude` processes.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { acquireSubprocess } from "../subprocess/pool.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";

test("acquireSubprocess forwards all CLI flag fields to prepare()", async () => {
  const spy = mock.method(
    ClaudeSubprocess.prototype,
    "prepare",
    async function (this: any, _opts: any) {
      /* no-op — don't spawn real claude */
    },
  );
  try {
    await acquireSubprocess("claude-opus-4-7", {
      effort: "high",
      thinking: true,
      maxBudgetUsd: 5,
      debug: "api",
      permissionMode: "acceptEdits",
      systemPrompt: "S",
      appendSystemPrompt: "A",
      agent: "researcher",
      agents: { x: {} },
      bare: true,
      disableSlashCommands: true,
      jsonSchema: { type: "object" },
      maxTurns: 7,
      disallowedTools: ["Bash"],
    });
    const opts = spy.mock.calls[0].arguments[0] as Record<string, unknown>;
    for (const k of [
      "effort",
      "thinking",
      "maxBudgetUsd",
      "debug",
      "permissionMode",
      "systemPrompt",
      "appendSystemPrompt",
      "agent",
      "agents",
      "bare",
      "disableSlashCommands",
      "jsonSchema",
      "maxTurns",
      "disallowedTools",
    ]) {
      assert.ok(k in opts, `expected prepare() opts to include: ${k}`);
    }
    assert.equal(opts.model, "claude-opus-4-7");
  } finally {
    spy.mock.restore();
  }
});

test("acquireSubprocess with no options still spawns and passes model", async () => {
  const spy = mock.method(
    ClaudeSubprocess.prototype,
    "prepare",
    async function (this: any, _opts: any) {
      /* no-op */
    },
  );
  try {
    await acquireSubprocess("claude-opus-4-7");
    assert.equal(spy.mock.calls.length, 1);
    const opts = spy.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(opts.model, "claude-opus-4-7");
  } finally {
    spy.mock.restore();
  }
});
