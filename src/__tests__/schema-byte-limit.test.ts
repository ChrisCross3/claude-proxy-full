import test from "node:test";
import assert from "node:assert/strict";
import { responseFormatToSystemPrompt } from "../adapter/openai-to-cli.js";

/**
 * The forced-JSON prompt cap is named in BYTES. It must therefore be measured
 * in UTF-8 bytes, not in `String.length` — which counts UTF-16 code units and
 * undercounts every non-ASCII character (German umlauts 2x, CJK 3x, most
 * emoji 2x per surrogate pair).
 *
 * Why bytes and not a rename to "chars": every consumer downstream of this
 * value counts bytes. Anthropic's only documented hard size limit is on the
 * whole request and is worded "Request exceeds the maximum allowed number of
 * bytes" (413 `request_too_large`, 32 MB on the Messages API). Tokenizer input
 * is UTF-8 bytes, and the native `--json-schema` route hands the schema to the
 * CLI through argv, where Linux' ARG_MAX is a byte budget as well. Nothing in
 * the chain counts UTF-16 code units.
 */
const CAP = 8192;

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function schemaPartOf(prompt: string): string {
  const marker = "JSON Schema:" + String.fromCharCode(10);
  const idx = prompt.indexOf(marker);
  assert.notEqual(idx, -1, "prompt must contain the 'JSON Schema:' marker");
  return prompt.slice(idx + marker.length);
}

function promptFor(schema: Record<string, unknown>, name: string): string {
  const out = responseFormatToSystemPrompt({
    type: "json_schema",
    json_schema: { name, schema },
  });
  assert.ok(out, "a valid json_schema must produce a prompt");
  return out!;
}

test("byte cap: a schema under the cap in chars but over it in UTF-8 bytes is reduced", () => {
  // One CJK code unit serializes to three UTF-8 bytes, so this description is
  // ~3000 UTF-16 units but ~9000 bytes: invisible to `String.length`, far past
  // the cap on the wire.
  const schema = {
    type: "object",
    properties: {
      zusammenfassung: { type: "string", description: "説".repeat(3000) },
    },
  };
  const serialized = JSON.stringify(schema);
  assert.ok(serialized.length <= CAP, "fixture must stay UNDER the cap when counting characters");
  assert.ok(bytes(serialized) > CAP, "fixture must exceed the cap when counting UTF-8 bytes");

  const prompt = promptFor(schema, "Umlaut");
  const schemaText = schemaPartOf(prompt);

  assert.ok(
    bytes(schemaText) <= CAP,
    `emitted schema must fit the ${CAP}-byte cap, got ${bytes(schemaText)} bytes`,
  );
  assert.match(prompt, /REDUCED/, "the reduction must be announced in the prompt");
});

test("byte cap: the reduction steps themselves respect the byte budget", () => {
  // The greedy fallback must count bytes too, not just the entry check.
  // 150 properties with 20-char CJK names: ~6k UTF-16 units, ~12k UTF-8 bytes.
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 150; i++) {
    properties[`項目名前欄記述識別子番号値定義列参照要素構造体${String(i).padStart(3, "0")}`] = {
      type: "string",
      description: "詳細説明".repeat(20),
    };
  }
  const schema = { type: "object", properties };

  const prompt = promptFor(schema, "Nested");
  const schemaText = schemaPartOf(prompt);

  assert.doesNotThrow(() => JSON.parse(schemaText), "reduced schema must stay valid JSON");
  assert.ok(
    bytes(schemaText) <= CAP,
    `reduced schema must fit the ${CAP}-byte cap, got ${bytes(schemaText)} bytes`,
  );
});

test("byte cap: pure-ASCII behaviour is unchanged (bytes == chars)", () => {
  const small = { type: "object", properties: { a: { type: "string" } } };
  const prompt = promptFor(small, "Small");
  assert.equal(schemaPartOf(prompt), JSON.stringify(small), "a small schema must pass through whole");
  assert.doesNotMatch(prompt, /REDUCED/, "a small schema must not be announced as reduced");
});
