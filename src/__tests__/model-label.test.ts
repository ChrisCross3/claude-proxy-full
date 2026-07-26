/**
 * Tests for canonicalizeModelLabel (src/server/routes.ts) — the function that
 * bounds /metrics cardinality by reducing arbitrary client model strings to a
 * fixed label set.
 *
 * This file used to carry a hand-copied replica of the implementation and
 * assert against the copy, with a comment claiming that drift would break the
 * test. It would not: a test that exercises its own copy passes no matter what
 * production does, and the copy silently fell behind the real label set. The
 * real function is imported now, so adding a model to the registry is covered
 * here automatically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeModelLabel } from "../server/routes.js";
import { MODELS } from "../models/registry.js";

test("strips claude-proxy/ provider prefix", () => {
  assert.equal(canonicalizeModelLabel("claude-proxy/claude-opus-4-7"), "claude-opus-4-7");
});

test("strips claude-code-cli/ legacy provider prefix", () => {
  assert.equal(canonicalizeModelLabel("claude-code-cli/claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("known bare model id passes through unchanged", () => {
  assert.equal(canonicalizeModelLabel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("every registry model id is a label in its own right", () => {
  // The point of importing the real function: a model added to the registry is
  // covered from that moment on, with no second list to remember.
  for (const m of MODELS) {
    assert.equal(canonicalizeModelLabel(m.id), m.id, `${m.id} must not collapse to "other"`);
    assert.equal(canonicalizeModelLabel(`claude-proxy/${m.id}`), m.id);
  }
});

test("the current generation is labelled, not lumped into 'other'", () => {
  // Explicit rather than derived, so a model quietly dropped from the registry
  // fails here instead of making the loop above vacuous.
  for (const id of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"]) {
    assert.equal(canonicalizeModelLabel(id), id);
  }
});

test("unknown ids collapse to 'other' (cardinality guard)", () => {
  assert.equal(canonicalizeModelLabel("openai/gpt-5"), "other");
  assert.equal(canonicalizeModelLabel("totally-fake-model"), "other");
  assert.equal(canonicalizeModelLabel("claude-opus-99-99"), "other");
});

test("empty/undefined → 'unknown'", () => {
  assert.equal(canonicalizeModelLabel(undefined), "unknown");
  assert.equal(canonicalizeModelLabel(""), "unknown");
});

test("provider prefix on unknown id still collapses to 'other'", () => {
  assert.equal(canonicalizeModelLabel("claude-proxy/something-weird"), "other");
});
