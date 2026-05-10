import test from "node:test";
import assert from "node:assert/strict";
import {
  extractModel,
  extractEffort,
  messagesToPrompt,
  openaiToCli,
  resolveModelStrict,
  validateEffortForModel,
} from "../adapter/openai-to-cli.js";
import type { OpenAIChatRequest } from "../types/openai.js";

// --- extractModel: strict, no silent fallback ---

test("extractModel resolves canonical IDs", () => {
  assert.equal(extractModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(extractModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("extractModel resolves short aliases to canonical IDs", () => {
  assert.equal(extractModel("opus"), "claude-opus-4-7");
  assert.equal(extractModel("sonnet"), "claude-sonnet-4-6");
  assert.equal(extractModel("haiku"), "claude-haiku-4-5-20251001");
});

test("extractModel strips claude-code-cli provider prefix", () => {
  assert.equal(extractModel("claude-code-cli/claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("extractModel accepts claude-proxy provider prefix", () => {
  assert.equal(extractModel("claude-proxy/claude-opus-4-7"), "claude-opus-4-7");
});

test("extractModel strips [1m] context-window suffix", () => {
  assert.equal(extractModel("claude-opus-4-7[1m]"), "claude-opus-4-7");
});

test("extractModel throws on unknown model ids — strict, no silent fallback", () => {
  assert.throws(() => extractModel("not-a-real-model"), /Unknown Claude model/);
  assert.throws(() => extractModel("gpt-4"), /Unknown Claude model/);
});

// --- extractEffort: syntactic whitelist ---

test("extractEffort accepts the documented effort levels", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(extractEffort(level), level);
  }
});

test("extractEffort rejects unknown or malformed strings", () => {
  assert.equal(extractEffort("xxhigh"), undefined);
  assert.equal(extractEffort(""), undefined);
  assert.equal(extractEffort("MEDIUM"), undefined);
});

test("extractEffort rejects non-string inputs", () => {
  assert.equal(extractEffort(undefined), undefined);
  assert.equal(extractEffort(null), undefined);
  assert.equal(extractEffort(3), undefined);
  assert.equal(extractEffort({ value: "high" }), undefined);
});

// --- validateEffortForModel: strict per-model semantic check ---

test("validateEffortForModel accepts levels supported by the model", () => {
  const opus = resolveModelStrict("claude-opus-4-7");
  assert.doesNotThrow(() => validateEffortForModel(opus, "xhigh"));
  assert.doesNotThrow(() => validateEffortForModel(opus, "max"));
  const sonnet = resolveModelStrict("claude-sonnet-4-6");
  assert.doesNotThrow(() => validateEffortForModel(sonnet, "high"));
  assert.doesNotThrow(() => validateEffortForModel(sonnet, "max"));
});

test("validateEffortForModel rejects xhigh on Sonnet 4.6 — no silent downgrade", () => {
  const sonnet = resolveModelStrict("claude-sonnet-4-6");
  assert.throws(() => validateEffortForModel(sonnet, "xhigh"), /does not support effort='xhigh'/);
});

test("validateEffortForModel rejects any effort on Haiku — effort not supported", () => {
  const haiku = resolveModelStrict("claude-haiku-4-5-20251001");
  for (const level of ["low", "medium", "high", "max"] as const) {
    assert.throws(() => validateEffortForModel(haiku, level), /does not support the --effort flag at all/);
  }
});

// --- messagesToPrompt: unchanged from upstream ---

test("messagesToPrompt joins text content parts with newlines", () => {
  const prompt = messagesToPrompt([
    { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
  ]);
  assert.equal(prompt, "first\nsecond");
});

test("messagesToPrompt ignores non-text content parts", () => {
  const prompt = messagesToPrompt([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:" } }, { type: "text", text: "visible" }] },
  ]);
  assert.equal(prompt, "visible");
});

test("messagesToPrompt skips empty system messages", () => {
  const prompt = messagesToPrompt([
    { role: "system", content: null },
    { role: "user", content: "hello" },
  ]);
  assert.equal(prompt, "hello");
});

test("messagesToPrompt wraps developer messages as system context", () => {
  const prompt = messagesToPrompt([
    { role: "developer", content: "Follow policy" },
    { role: "user", content: "hello" },
  ]);
  assert.match(prompt, /<system>\nFollow policy\n<\/system>/);
});

test("messagesToPrompt wraps assistant text as previous response", () => {
  const prompt = messagesToPrompt([
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "continue" },
  ]);
  assert.match(prompt, /<previous_response>\nEarlier answer\n<\/previous_response>/);
});

test("messagesToPrompt skips empty assistant messages", () => {
  const prompt = messagesToPrompt([
    { role: "assistant", content: null },
    { role: "user", content: "next" },
  ]);
  assert.equal(prompt, "next");
});

test("messagesToPrompt skips empty user messages", () => {
  const prompt = messagesToPrompt([
    { role: "user", content: "" },
    { role: "user", content: "next" },
  ]);
  assert.equal(prompt, "next");
});

// --- openaiToCli: end-to-end mapping ---

test("openaiToCli maps OpenAI user field to session id", () => {
  const req: OpenAIChatRequest = {
    model: "claude-sonnet-4-6",
    user: "session-1",
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(openaiToCli(req).sessionId, "session-1");
});

test("openaiToCli omits disallowed tools when bridge is inactive", () => {
  const req: OpenAIChatRequest = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(openaiToCli(req).disallowedTools, undefined);
});

test("openaiToCli maps request model through the strict registry", () => {
  const req: OpenAIChatRequest = {
    model: "haiku",
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(openaiToCli(req).model, "claude-haiku-4-5-20251001");
});

test("openaiToCli passes a valid reasoning_effort through as effort", () => {
  const req: OpenAIChatRequest = {
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "xhigh",
  };
  assert.equal(openaiToCli(req).effort, "xhigh");
});

test("openaiToCli omits effort when reasoning_effort syntax is invalid", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
    reasoning_effort: "xxhigh",
  } as unknown as OpenAIChatRequest;
  assert.equal(openaiToCli(req).effort, undefined);
});

test("openaiToCli throws when reasoning_effort is unsupported by the model — strict", () => {
  const req: OpenAIChatRequest = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "xhigh",
  };
  assert.throws(() => openaiToCli(req), /does not support effort='xhigh'/);
});

test("openaiToCli throws when reasoning_effort is set on a model without effort support — strict", () => {
  const req: OpenAIChatRequest = {
    model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
  };
  assert.throws(() => openaiToCli(req), /does not support the --effort flag at all/);
});
