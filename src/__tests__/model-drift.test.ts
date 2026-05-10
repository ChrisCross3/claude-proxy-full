/**
 * Model registry drift hygiene.
 *
 * After the Welle-3 Phase-2 migration, src/models/registry.ts is the single
 * source of truth. All other model lists (handleModels, AVAILABLE_MODELS,
 * KNOWN_MODEL_LABELS) are derived from MODELS at runtime, so they cannot drift
 * structurally. This test enforces the resolution paths:
 *
 *   1. Every registry ID resolves through extractModel.
 *   2. Every registry alias resolves through extractModel.
 *   3. Provider-prefixed and [1m]-suffixed forms resolve to canonical IDs.
 *   4. Strict behaviour: unknown models throw.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractModel } from "../adapter/openai-to-cli.js";
import { MODELS } from "../models/registry.js";

test("every registry model id is routable via extractModel", () => {
  for (const def of MODELS) {
    assert.equal(extractModel(def.id), def.id, `extractModel('${def.id}') did not return its canonical id`);
  }
});

test("every registry alias resolves to its canonical id", () => {
  for (const def of MODELS) {
    for (const alias of def.aliases) {
      assert.equal(extractModel(alias), def.id, `alias '${alias}' did not resolve to '${def.id}'`);
    }
  }
});

test("provider-prefixed forms resolve identically to bare ids", () => {
  const prefixes = ["claude-proxy/", "claude-code-cli/"];
  for (const def of MODELS) {
    for (const prefix of prefixes) {
      const prefixed = `${prefix}${def.id}`;
      // Only test prefixes that are listed as aliases, since prefix variants
      // are explicit alias entries in the registry.
      if (def.aliases.includes(prefixed)) {
        assert.equal(extractModel(prefixed), def.id, `'${prefixed}' did not resolve to '${def.id}'`);
      }
    }
  }
});

test("[1m] context-window suffix is stripped during resolution", () => {
  for (const def of MODELS) {
    if (def.oneMillionContextVariant) {
      const variant = `${def.id}[1m]`;
      assert.equal(extractModel(variant), def.id, `'${variant}' did not strip to '${def.id}'`);
    }
  }
});

test("extractModel throws on unknown models — strict, no fallback", () => {
  assert.throws(() => extractModel("definitely-not-a-claude-model"), /Unknown Claude model/);
  assert.throws(() => extractModel("gpt-4o"), /Unknown Claude model/);
});
