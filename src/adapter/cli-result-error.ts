// Turning a failed CLI turn into a real HTTP error.
//
// The CLI reports failure inside a successful-looking result envelope:
// `{type: "result", subtype: "error", is_error: true, result: "<message>"}`.
// Until now both result handlers ignored those two fields, so a failed turn
// became a 200 with `finish_reason: "stop"` and the error text as the
// assistant's answer. Callers cannot distinguish that from a real answer —
// a client asking "am I authenticated?" gets a cheerful 200 saying
// "Not logged in", and a retry loop keyed on HTTP status never fires.
//
// The status mapping is deliberately conservative: `is_error` decides *that*
// it failed, the message text only decides *which* status fits. Anything we
// cannot place lands on 500 rather than being guessed into a retryable class,
// because a wrongly-retryable error turns one failure into a storm.

import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { ProtocolErrorClass } from "../errors.js";

export interface CliResultError {
  /** HTTP status to send. */
  status: number;
  /** OpenAI-style error type field. */
  type: string;
  /** OpenAI-style error code field, or null when none applies. */
  code: string | null;
  /** Human-readable message, taken from the CLI. */
  message: string;
  /** Bounded class for trace/metrics recording. */
  traceClass: ProtocolErrorClass;
}

/** Substring → classification. First match wins, so order is significant. */
const PATTERNS: ReadonlyArray<{
  needles: readonly string[];
  status: number;
  type: string;
  code: string | null;
  traceClass: ProtocolErrorClass;
}> = [
  {
    // The CLI says this when it has no usable credentials — including the
    // `--bare` + missing-token case that silently broke background pipelines.
    needles: [
      "not logged in",
      "please run /login",
      "invalid api key",
      "credentials_not_found",
      "authentication_error",
      "unauthorized",
      "401",
    ],
    status: 401,
    type: "authentication_error",
    code: "invalid_api_key",
    traceClass: "auth_error",
  },
  {
    needles: ["rate limit", "rate_limit", "429", "usage limit", "quota exceeded"],
    status: 429,
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
    traceClass: "rate_limit",
  },
  {
    needles: ["overloaded", "529", "503", "service unavailable"],
    status: 503,
    type: "overloaded_error",
    code: "overloaded",
    traceClass: "upstream_soft_dead",
  },
  {
    needles: ["forbidden", "403", "permission"],
    status: 403,
    type: "permission_error",
    code: "permission_denied",
    traceClass: "auth_error",
  },
];

/**
 * Classify a CLI result. Returns null when the turn succeeded — callers treat
 * null as "carry on with the normal completion path".
 *
 * A result counts as failed when `is_error` is true OR `subtype` is "error";
 * either alone is enough, because the two have been observed disagreeing.
 */
export function classifyCliResultError(
  result: Pick<ClaudeCliResult, "is_error" | "subtype" | "result">,
): CliResultError | null {
  const failed = result.is_error === true || result.subtype === "error";
  if (!failed) return null;

  const message = (result.result || "").trim() || "Claude CLI reported an error without a message.";
  const haystack = message.toLowerCase();

  for (const p of PATTERNS) {
    if (p.needles.some((n) => haystack.includes(n))) {
      return { status: p.status, type: p.type, code: p.code, message, traceClass: p.traceClass };
    }
  }

  return { status: 500, type: "server_error", code: null, message, traceClass: "other_stream_fault" };
}

/** Render as the OpenAI-compatible error body. */
export function toOpenAiErrorBody(err: CliResultError): {
  error: { message: string; type: string; code: string | null };
} {
  return { error: { message: err.message, type: err.type, code: err.code } };
}
