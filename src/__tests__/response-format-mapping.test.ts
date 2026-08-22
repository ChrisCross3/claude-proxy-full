import test from "node:test";
import assert from "node:assert/strict";
import { responseFormatToSystemPrompt, openaiToCli } from "../adapter/openai-to-cli.js";

test("responseFormatToSystemPrompt: returns string for valid json_schema", () => {
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: {
      name: "Facts",
      schema: {
        type: "object",
        properties: { facts: { type: "array", items: { type: "string" } } },
        required: ["facts"],
      },
      strict: true,
    },
  });
  assert.ok(out, "should return non-empty string");
  assert.match(out!, /MUST respond with ONLY valid JSON/);
  assert.match(out!, /Schema name: Facts/);
  assert.match(out!, /"properties":\{"facts"/);
});

test("responseFormatToSystemPrompt: includes schema serialized as JSON", () => {
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { schema: { type: "object", properties: { x: { type: "number" } } } },
  })!;
  assert.match(out, /"type":"object"/);
});

test("responseFormatToSystemPrompt: returns undefined for missing input", () => {
  assert.equal(responseFormatToSystemPrompt(undefined), undefined);
  assert.equal(responseFormatToSystemPrompt(null), undefined);
  assert.equal(responseFormatToSystemPrompt({}), undefined);
});

test("responseFormatToSystemPrompt: returns undefined for non-json_schema type", () => {
  assert.equal(
    responseFormatToSystemPrompt({ type: "text" }),
    undefined,
  );
  assert.equal(
    responseFormatToSystemPrompt({ type: "json_object" }),
    undefined,
  );
});

test("responseFormatToSystemPrompt: returns undefined when inner schema missing", () => {
  assert.equal(
    responseFormatToSystemPrompt({ type: "json_schema", json_schema: {} }),
    undefined,
  );
  assert.equal(
    responseFormatToSystemPrompt({
      type: "json_schema",
      json_schema: { name: "Test" },
    }),
    undefined,
  );
});

test("responseFormatToSystemPrompt: returns undefined for empty schema object", () => {
  assert.equal(
    responseFormatToSystemPrompt({
      type: "json_schema",
      json_schema: { schema: {} },
    }),
    undefined,
  );
});

test("responseFormatToSystemPrompt: returns undefined when input is array", () => {
  assert.equal(responseFormatToSystemPrompt([]), undefined);
});

test("responseFormatToSystemPrompt: defaults schema-name to 'Response' when missing", () => {
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { schema: { type: "object", properties: { x: {} } } },
  })!;
  assert.match(out, /Schema name: Response/);
});

test("responseFormatToSystemPrompt: truncates oversized schema with warning log", () => {
  const huge = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(50) }]),
    ),
  };
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { name: "Huge", schema: huge },
  })!;
  // Output should still contain the prompt header
  assert.match(out, /MUST respond with ONLY valid JSON/);
  // But schema portion should be capped (we set 8 KB; total output is header + 8 KB).
  assert.ok(out.length < 9_500, `expected truncated output, got ${out.length} bytes`);
});

test("responseFormatToSystemPrompt: handles deeply nested schema without crash", () => {
  let nested: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 100; i++) {
    nested = { type: "object", properties: { nested } };
  }
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { schema: nested },
  });
  assert.ok(out);
});

// Since the native-schema switch, mapResponseFormat routes a loadable schema
// to `--json-schema` instead of the prompt hack. The prompt path is still
// exercised above (unit level) and in response-format-native-schema.test.ts
// (fallback for dialects the CLI validator rejects).
test("openaiToCli with mapResponseFormat=true converts response_format to jsonSchema", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "Result", schema },
      },
    },
    { mapResponseFormat: true },
  );
  assert.deepEqual(cli.jsonSchema, schema, "schema should reach the CLI natively");
  assert.equal(cli.systemPrompt, undefined, "no forced-JSON prompt on the native path");
});

test("openaiToCli WITHOUT mapResponseFormat ignores response_format (legacy behavior)", () => {
  const cli = openaiToCli({
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "test" }],
    response_format: {
      type: "json_schema",
      json_schema: { schema: { type: "object" } },
    },
  });
  assert.equal(cli.systemPrompt, undefined);
});

// The override only applies on the fallback path now: the native path has no
// reason to touch system_prompt. `$schema: 2020-12` is the measured trigger —
// the CLI validator cannot load that dialect and exits 1 on it.
test("openaiToCli with mapResponseFormat=true overrides user-supplied system_prompt on the fallback path", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      system_prompt: "USER OWN SYSTEM PROMPT",
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { a: { type: "string" } },
          },
        },
      },
    },
    { mapResponseFormat: true },
  );
  assert.equal(cli.jsonSchema, undefined);
  assert.ok(cli.systemPrompt);
  assert.doesNotMatch(cli.systemPrompt!, /USER OWN SYSTEM PROMPT/);
  assert.match(cli.systemPrompt!, /MUST respond with ONLY valid JSON/);
});

test("openaiToCli with mapResponseFormat=true preserves system_prompt when no response_format", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      system_prompt: "KEEP THIS",
    },
    { mapResponseFormat: true },
  );
  assert.equal(cli.systemPrompt, "KEEP THIS");
});

test("openaiToCli with mapResponseFormat=true preserves system_prompt when response_format is text-type", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      system_prompt: "KEEP THIS",
      response_format: { type: "text" },
    },
    { mapResponseFormat: true },
  );
  assert.equal(cli.systemPrompt, "KEEP THIS");
});

/**
 * Extract the schema portion of the forced-JSON prompt: everything after the
 * "JSON Schema:" marker line. The schema is always the last block of the
 * prompt, serialized on a single line.
 */
function schemaPartOf(prompt: string): string {
  const marker = "JSON Schema:" + String.fromCharCode(10);
  const idx = prompt.indexOf(marker);
  assert.notEqual(idx, -1, "prompt must contain the 'JSON Schema:' marker");
  return prompt.slice(idx + marker.length);
}

test("responseFormatToSystemPrompt: oversized schema stays parseable JSON", () => {
  // Oversized because of per-field decoration (the realistic Honcho case),
  // not because of an absurd field count.
  const huge = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `field_${i}`,
        { type: "string", description: "x".repeat(200), examples: ["a", "b"] },
      ]),
    ),
    required: ["field_0", "field_1"],
  };
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { name: "Huge", schema: huge },
  })!;

  const schemaText = schemaPartOf(out);
  let parsed: unknown;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(schemaText);
  }, "schema portion of the prompt must be valid JSON even when reduced");

  // The reduction must keep the load-bearing top-level information.
  const obj = parsed as Record<string, unknown>;
  assert.equal(obj.type, "object");
  assert.deepEqual(obj.required, ["field_0", "field_1"]);
  const props = obj.properties as Record<string, { type?: string }>;
  assert.ok(props, "top-level properties must survive the reduction");
  assert.equal(Object.keys(props).length, 100, "all top-level field names must survive");
  assert.equal(props.field_0?.type, "string");
  assert.equal(props.field_99?.type, "string");
});

test("responseFormatToSystemPrompt: schema too big even as a skeleton stays parseable JSON", () => {
  // 1000 fields do not fit even reduced to `{"type":"string"}` each, so the
  // property list itself has to be cut. The output must still be one complete
  // JSON document that says how much was dropped.
  const enormous = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        `field_${i}`,
        { type: "string", description: "x".repeat(50) },
      ]),
    ),
  };
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { name: "Enormous", schema: enormous },
  })!;

  const schemaText = schemaPartOf(out);
  const parsed = JSON.parse(schemaText) as Record<string, unknown>;
  assert.equal(parsed.type, "object");
  const kept = Object.keys(parsed.properties as Record<string, unknown>).length;
  assert.ok(kept > 0, "at least some fields should survive");
  assert.ok(kept < 1000, "the property list must actually have been cut");
  assert.match(String(parsed["x-schema-reduced"]), new RegExp(`showing ${kept} of 1000`));
});

test("responseFormatToSystemPrompt: reduction is announced in the prompt", () => {
  const huge = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        `field_${i}`,
        { type: "string", description: "x".repeat(50) },
      ]),
    ),
  };
  const reduced = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { name: "Huge", schema: huge },
  })!;
  assert.match(reduced, /reduced/i);

  const small = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { name: "Small", schema: { type: "object", properties: { a: { type: "string" } } } },
  })!;
  assert.doesNotMatch(small, /reduced/i);
});
