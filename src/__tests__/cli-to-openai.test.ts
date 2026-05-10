import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelName } from "../adapter/cli-to-openai.js";

test("normalizeModelName returns canonical id for known models (no legacy collapse)", () => {
  assert.equal(normalizeModelName("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(normalizeModelName("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(normalizeModelName("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("normalizeModelName resolves short aliases to canonical ids", () => {
  assert.equal(normalizeModelName("opus"), "claude-opus-4-7");
  assert.equal(normalizeModelName("sonnet"), "claude-sonnet-4-6");
  assert.equal(normalizeModelName("haiku"), "claude-haiku-4-5-20251001");
});

test("normalizeModelName strips [1m] suffix when resolving", () => {
  assert.equal(normalizeModelName("claude-opus-4-7[1m]"), "claude-opus-4-7");
});

test("normalizeModelName echoes unknown strings unchanged (no silent rewrite)", () => {
  assert.equal(normalizeModelName("some-future-model-name"), "some-future-model-name");
});

test("normalizeModelName returns 'unknown' when given undefined", () => {
  assert.equal(normalizeModelName(undefined), "unknown");
});
