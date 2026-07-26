import test from "node:test";
import assert from "node:assert/strict";
import { classifyCliResultError, toOpenAiErrorBody } from "../adapter/cli-result-error.js";

// The defect these pin down: the CLI reports failure inside a
// successful-looking result envelope, and both result handlers used to ignore
// `is_error` / `subtype` entirely. A failed turn then left the proxy as a 200
// with the error text as the assistant's answer — indistinguishable from a
// real reply, and invisible to any retry keyed on HTTP status.

const ok = { is_error: false, subtype: "success" as const, result: "Here you go." };

test("cli-result-error: a successful result classifies as null", () => {
  assert.equal(classifyCliResultError(ok), null);
});

test("cli-result-error: is_error alone marks failure", () => {
  const err = classifyCliResultError({ is_error: true, subtype: "success", result: "boom" });
  assert.ok(err);
  assert.equal(err.status, 500);
});

test("cli-result-error: subtype alone marks failure", () => {
  const err = classifyCliResultError({ is_error: false, subtype: "error", result: "boom" });
  assert.ok(err);
  assert.equal(err.status, 500);
});

test("cli-result-error: the login message maps to 401", () => {
  // This exact string is what a --bare spawn without credentials returns, and
  // it was being served as a 200 answer.
  const err = classifyCliResultError({
    is_error: true,
    subtype: "error",
    result: "Not logged in · Please run /login",
  });
  assert.equal(err?.status, 401);
  assert.equal(err?.type, "authentication_error");
});

test("cli-result-error: an invalid key maps to 401", () => {
  const err = classifyCliResultError({
    is_error: true,
    subtype: "error",
    result: "Invalid API key · Fix external API key",
  });
  assert.equal(err?.status, 401);
});

test("cli-result-error: credentials_not_found maps to 401", () => {
  const err = classifyCliResultError({
    is_error: true,
    subtype: "error",
    result: 'Cannot stat credentials file: {"code":"credentials_not_found"}',
  });
  assert.equal(err?.status, 401);
});

test("cli-result-error: rate limiting maps to 429", () => {
  const err = classifyCliResultError({
    is_error: true,
    subtype: "error",
    result: "You have hit the rate limit; try again later",
  });
  assert.equal(err?.status, 429);
  assert.equal(err?.type, "rate_limit_error");
});

test("cli-result-error: overload maps to 503", () => {
  const err = classifyCliResultError({
    is_error: true,
    subtype: "error",
    result: "Upstream overloaded, please retry",
  });
  assert.equal(err?.status, 503);
});

test("cli-result-error: an unrecognised failure stays 500, never a retryable class", () => {
  // Guessing a retryable status for an unknown error turns one failure into a
  // retry storm, so anything unplaceable must land on 500.
  const err = classifyCliResultError({
    is_error: true,
    subtype: "error",
    result: "some entirely novel failure mode",
  });
  assert.equal(err?.status, 500);
  assert.equal(err?.type, "server_error");
  assert.equal(err?.code, null);
});

test("cli-result-error: classification is case-insensitive", () => {
  const err = classifyCliResultError({ is_error: true, subtype: "error", result: "NOT LOGGED IN" });
  assert.equal(err?.status, 401);
});

test("cli-result-error: an empty message still yields a usable error", () => {
  const err = classifyCliResultError({ is_error: true, subtype: "error", result: "" });
  assert.equal(err?.status, 500);
  assert.ok(err.message.length > 0, "message must never be empty — it is what the caller sees");
});

test("cli-result-error: the body matches the OpenAI error shape", () => {
  const err = classifyCliResultError({ is_error: true, subtype: "error", result: "Not logged in" })!;
  const body = toOpenAiErrorBody(err);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "type"]);
  assert.equal(body.error.type, "authentication_error");
});
