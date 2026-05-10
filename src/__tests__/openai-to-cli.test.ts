import test from "node:test";
import assert from "node:assert/strict";
import {
  extractModel,
  extractEffort,
  extractThinking,
  extractDebug,
  extractMaxBudgetUsd,
  extractPermissionMode,
  messagesToPrompt,
  openaiToCli,
  resolveModelStrict,
  validateEffortForModel,
  validateThinkingForModel,
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


// --- extractThinking: boolean OR Anthropic-native object ---

test("extractThinking accepts boolean true/false", () => {
  assert.equal(extractThinking(true), true);
  assert.equal(extractThinking(false), false);
});

test("extractThinking accepts Anthropic-native object form", () => {
  assert.equal(extractThinking({ type: "enabled" }), true);
  assert.equal(extractThinking({ type: "disabled" }), false);
  assert.equal(extractThinking({ type: "enabled", budget_tokens: 4096 }), true);
});

test("extractThinking returns undefined for unset/garbage", () => {
  assert.equal(extractThinking(undefined), undefined);
  assert.equal(extractThinking(null), undefined);
  assert.equal(extractThinking("on"), undefined);
  assert.equal(extractThinking({ type: "bogus" }), undefined);
  assert.equal(extractThinking({}), undefined);
});

// --- validateThinkingForModel: strict per-model check ---

test("validateThinkingForModel accepts when model supports thinking", () => {
  const opus = resolveModelStrict("claude-opus-4-7");
  assert.doesNotThrow(() => validateThinkingForModel(opus, true));
  assert.doesNotThrow(() => validateThinkingForModel(opus, false));
  const sonnet = resolveModelStrict("claude-sonnet-4-6");
  assert.doesNotThrow(() => validateThinkingForModel(sonnet, true));
});

test("validateThinkingForModel rejects thinking=true on Haiku — strict, no silent downgrade", () => {
  const haiku = resolveModelStrict("claude-haiku-4-5-20251001");
  assert.throws(() => validateThinkingForModel(haiku, true), /does not support extended thinking/);
});

test("validateThinkingForModel accepts thinking=false on Haiku (explicit off is fine)", () => {
  const haiku = resolveModelStrict("claude-haiku-4-5-20251001");
  assert.doesNotThrow(() => validateThinkingForModel(haiku, false));
});

// --- openaiToCli end-to-end with thinking ---

test("openaiToCli passes thinking through when supported by the model", () => {
  const req = {
    model: "claude-opus-4-7",
    messages: [{ role: "user" as const, content: "hi" }],
    thinking: true,
  };
  assert.equal(openaiToCli(req as any).thinking, true);
});

test("openaiToCli accepts Anthropic-native thinking object", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
    thinking: { type: "enabled" as const },
  };
  assert.equal(openaiToCli(req as any).thinking, true);
});

test("openaiToCli throws when thinking is requested on a model that doesn't support it", () => {
  const req = {
    model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user" as const, content: "hi" }],
    thinking: true,
  };
  assert.throws(() => openaiToCli(req as any), /does not support extended thinking/);
});

test("openaiToCli omits thinking when the request doesn't set it", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
  };
  assert.equal(openaiToCli(req as any).thinking, undefined);
});


// --- extractDebug: optional category filter string ---

test("extractDebug returns trimmed string when non-empty", () => {
  assert.equal(extractDebug("api"), "api");
  assert.equal(extractDebug("api,hooks"), "api,hooks");
  assert.equal(extractDebug("  spaced  "), "spaced");
});

test("extractDebug returns undefined for unset, empty, or non-string", () => {
  assert.equal(extractDebug(undefined), undefined);
  assert.equal(extractDebug(null), undefined);
  assert.equal(extractDebug(""), undefined);
  assert.equal(extractDebug("   "), undefined);
  assert.equal(extractDebug(true), undefined);
  assert.equal(extractDebug(123), undefined);
});

test("openaiToCli passes debug through when set", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "x" }],
    debug: "api",
  };
  assert.equal(openaiToCli(req as any).debug, "api");
});

test("openaiToCli omits debug when unset", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "x" }],
  };
  assert.equal(openaiToCli(req as any).debug, undefined);
});


// --- extractMaxBudgetUsd: optional positive number ---

test("extractMaxBudgetUsd accepts positive finite numbers", () => {
  assert.equal(extractMaxBudgetUsd(0.01), 0.01);
  assert.equal(extractMaxBudgetUsd(5), 5);
  assert.equal(extractMaxBudgetUsd(123.45), 123.45);
});

test("extractMaxBudgetUsd rejects zero, negative, NaN, infinity, and non-numbers", () => {
  assert.equal(extractMaxBudgetUsd(0), undefined);
  assert.equal(extractMaxBudgetUsd(-1), undefined);
  assert.equal(extractMaxBudgetUsd(NaN), undefined);
  assert.equal(extractMaxBudgetUsd(Infinity), undefined);
  assert.equal(extractMaxBudgetUsd(-Infinity), undefined);
  assert.equal(extractMaxBudgetUsd("5"), undefined);
  assert.equal(extractMaxBudgetUsd(null), undefined);
  assert.equal(extractMaxBudgetUsd(undefined), undefined);
});

test("openaiToCli passes max_budget_usd through as maxBudgetUsd", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "x" }],
    max_budget_usd: 1.5,
  };
  assert.equal(openaiToCli(req as any).maxBudgetUsd, 1.5);
});

test("openaiToCli drops invalid max_budget_usd silently", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "x" }],
    max_budget_usd: -1,
  };
  assert.equal(openaiToCli(req as any).maxBudgetUsd, undefined);
});


// --- extractPermissionMode: strict whitelist ---

test("extractPermissionMode accepts all six documented modes", () => {
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const) {
    assert.equal(extractPermissionMode(mode), mode);
  }
});

test("extractPermissionMode returns undefined for unset / empty", () => {
  assert.equal(extractPermissionMode(undefined), undefined);
  assert.equal(extractPermissionMode(null), undefined);
  assert.equal(extractPermissionMode(""), undefined);
});

test("extractPermissionMode throws on unknown strings (strict whitelist)", () => {
  assert.throws(() => extractPermissionMode("yolo"), /Unknown permission_mode/);
  assert.throws(() => extractPermissionMode("DEFAULT"), /Unknown permission_mode/); // case-sensitive
});

test("extractPermissionMode throws on non-string non-empty input", () => {
  assert.throws(() => extractPermissionMode(123), /permission_mode must be a string/);
  assert.throws(() => extractPermissionMode(true), /permission_mode must be a string/);
});

test("openaiToCli passes permission_mode through as permissionMode", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "x" }],
    permission_mode: "plan" as const,
  };
  assert.equal(openaiToCli(req as any).permissionMode, "plan");
});

test("openaiToCli throws on unknown permission_mode (HTTP 400 path)", () => {
  const req = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "x" }],
    permission_mode: "yolo",
  };
  assert.throws(() => openaiToCli(req as any), /Unknown permission_mode/);
});
