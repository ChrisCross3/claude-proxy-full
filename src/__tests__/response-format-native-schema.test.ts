/**
 * Native `--json-schema` mapping for the isolated (Honcho) route.
 *
 * Background: the isolated profile used to translate an OpenAI
 * `response_format: json_schema` into a strict system-prompt text, because the
 * CLI was believed to have no native enforcement. It does — measured on the
 * pinned CLI 2.1.232, `--json-schema` installs a synthetic `StructuredOutput`
 * tool and puts the validated JSON into the result's `result` field, which is
 * exactly what `cliResultToOpenai` already reads.
 *
 * The one measured rejection cause is a `$schema` key naming a dialect the
 * CLI's validator does not load (it loads draft-07):
 *   Error: --json-schema is not a valid JSON Schema: no schema with key or ref
 *   "https://json-schema.org/draft/2020-12/schema"
 * That kills the spawn with exit 1, so such schemas keep the old prompt path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { responseFormatToJsonSchema, openaiToCli } from "../adapter/openai-to-cli.js";

/** Shape Honcho actually sends: Pydantic v2 `model_json_schema()`, no `$schema`. */
const HONCHO_SCHEMA = {
  type: "object",
  $defs: {
    ExplicitObservationBase: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  properties: {
    explicit: { type: "array", items: { $ref: "#/$defs/ExplicitObservationBase" } },
  },
  required: ["explicit"],
  additionalProperties: false,
};

function wrap(schema: unknown, name = "PromptRepresentation"): unknown {
  return { type: "json_schema", json_schema: { name, schema, strict: true } };
}

test("responseFormatToJsonSchema: returns the inner schema verbatim", () => {
  const out = responseFormatToJsonSchema(wrap(HONCHO_SCHEMA));
  assert.deepEqual(out, HONCHO_SCHEMA);
});

test("responseFormatToJsonSchema: keeps $defs/$ref/additionalProperties intact", () => {
  // Measured working on CLI 2.1.232; must not be stripped the way the
  // prompt-path reduction strips them.
  const out = responseFormatToJsonSchema(wrap(HONCHO_SCHEMA))!;
  assert.ok(out.$defs, "$defs must survive");
  assert.equal((out.properties as Record<string, { items: { $ref: string } }>).explicit.items.$ref, "#/$defs/ExplicitObservationBase");
  assert.equal(out.additionalProperties, false);
});

test("responseFormatToJsonSchema: accepts an explicit draft-07 dialect", () => {
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
  assert.deepEqual(responseFormatToJsonSchema(wrap(schema)), schema);
});

test("responseFormatToJsonSchema: declines a dialect the CLI validator rejects", () => {
  // Measured: CLI exits 1 before producing any output. Declining here routes
  // the request to the system-prompt fallback instead of killing the spawn.
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };
  assert.equal(responseFormatToJsonSchema(wrap(schema)), undefined);
});

test("responseFormatToJsonSchema: undefined for non-json_schema / empty input", () => {
  assert.equal(responseFormatToJsonSchema(undefined), undefined);
  assert.equal(responseFormatToJsonSchema(null), undefined);
  assert.equal(responseFormatToJsonSchema({ type: "text" }), undefined);
  assert.equal(responseFormatToJsonSchema({ type: "json_object" }), undefined);
  assert.equal(responseFormatToJsonSchema({ type: "json_schema", json_schema: {} }), undefined);
  assert.equal(responseFormatToJsonSchema(wrap({})), undefined);
});

test("openaiToCli+mapResponseFormat: emits jsonSchema, not a forced system prompt", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "extract" }],
      response_format: wrap(HONCHO_SCHEMA),
    } as never,
    { mapResponseFormat: true },
  );
  assert.deepEqual(cli.jsonSchema, HONCHO_SCHEMA);
  assert.equal(cli.systemPrompt, undefined, "native path must not install the prompt hack");
});

test("openaiToCli+mapResponseFormat: leaves a caller system_prompt alone on the native path", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "extract" }],
      system_prompt: "You are terse.",
      response_format: wrap(HONCHO_SCHEMA),
    } as never,
    { mapResponseFormat: true },
  );
  assert.deepEqual(cli.jsonSchema, HONCHO_SCHEMA);
  assert.equal(cli.systemPrompt, "You are terse.");
});

test("openaiToCli+mapResponseFormat: falls back to the prompt for a rejected dialect", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { a: { type: "string" } },
  };
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "extract" }],
      response_format: wrap(schema, "Legacy"),
    } as never,
    { mapResponseFormat: true },
  );
  assert.equal(cli.jsonSchema, undefined, "must not hand the CLI a schema it exits 1 on");
  assert.match(cli.systemPrompt!, /MUST respond with ONLY valid JSON/);
  assert.match(cli.systemPrompt!, /Schema name: Legacy/);
});

test("openaiToCli+mapResponseFormat: an explicit json_schema field wins", () => {
  const explicit = { type: "object", properties: { b: { type: "number" } } };
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "extract" }],
      json_schema: explicit,
      response_format: wrap(HONCHO_SCHEMA),
    } as never,
    { mapResponseFormat: true },
  );
  assert.deepEqual(cli.jsonSchema, explicit);
  assert.equal(cli.systemPrompt, undefined);
});

test("openaiToCli without mapResponseFormat: response_format is ignored entirely", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "extract" }],
      response_format: wrap(HONCHO_SCHEMA),
    } as never,
    {},
  );
  assert.equal(cli.jsonSchema, undefined);
  assert.equal(cli.systemPrompt, undefined);
});

test("native path is unaffected by the 8192-byte prompt cap", () => {
  // A schema well past FORCED_JSON_SCHEMA_MAX_BYTES must reach the CLI whole.
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) {
    properties[`field_${i}`] = { type: "string", description: "x".repeat(40) };
  }
  const big = { type: "object", properties };
  assert.ok(JSON.stringify(big).length > 8192, "fixture must exceed the cap");

  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "extract" }],
      response_format: wrap(big, "Big"),
    } as never,
    { mapResponseFormat: true },
  );
  assert.deepEqual(cli.jsonSchema, big, "schema must arrive unreduced");
  assert.equal(cli.systemPrompt, undefined);
});
