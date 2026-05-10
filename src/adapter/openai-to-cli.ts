/**
 * Converts an OpenAI-wire chat request into Claude CLI input.
 *
 * Model resolution and capability validation are strict: unknown models
 * and unsupported effort levels throw instead of silently falling back.
 * The source of truth for model capabilities is src/models/registry.ts.
 */

import type { OpenAIChatRequest, OpenAIMessageContent } from "../types/openai.js";
import { toolDefsToPrompt, toolResultToPrompt, assistantToolCallsToPrompt, shouldBridgeExternalTools, externalNativeToolDisallowList } from "./tools.js";
import { resolveModel, ALL_EFFORT_LEVELS, type ClaudeEffort, type ClaudeModelDefinition } from "../models/registry.js";

/** Kept for downstream files; canonical IDs come from the registry now. */
export type ClaudeModel = string;

/**
 * Error class for strict validation failures (unknown model, unsupported
 * effort or thinking on a given model). The HTTP layer translates these into
 * HTTP 400 invalid_request_error instead of HTTP 500 server_error.
 */
export class ModelValidationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ModelValidationError';
  }
}

export interface CliInput {
  prompt: string;
  /** Canonical Claude model ID, resolved through the registry. */
  model: string;
  sessionId?: string;
  disallowedTools?: string[];
  /** Effort level. Validated against the model's effortLevels before use. */
  effort?: ClaudeEffort;
  /** Thinking toggle. Validated against the model's thinkingSupported flag. */
  thinking?: boolean;
  /** Verbose logging category filter; mapped to claude --debug. */
  debug?: string;
  /** Hard USD cap per request (print-mode only per Anthropic). */
  maxBudgetUsd?: number;
}

/**
 * Resolve any accepted model identifier (canonical ID, alias, [1m] variant)
 * to its canonical ID. Throws if the model is not declared in the registry.
 */
export function extractModel(model: string): string {
  const def = resolveModel(model);
  if (!def) {
    throw new ModelValidationError(
      `Unknown Claude model id or alias: '${model}'. ` +
      `Add it to src/models/registry.ts if Anthropic has released it.`,
      'unknown_model',
    );
  }
  return def.id;
}

/** Like extractModel, but returns the full definition for callers that need it. */
export function resolveModelStrict(model: string): ClaudeModelDefinition {
  const def = resolveModel(model);
  if (!def) {
    throw new ModelValidationError(
      `Unknown Claude model id or alias: '${model}'. ` +
      `Add it to src/models/registry.ts if Anthropic has released it.`,
      'unknown_model',
    );
  }
  return def;
}

/**
 * Syntactic validation of a reasoning_effort hint. Returns undefined for unset
 * or out-of-whitelist values so callers can treat "not requested" and
 * "requested but invalid syntax" the same way (no per-request override).
 */
export function extractEffort(raw: unknown): ClaudeEffort | undefined {
  if (typeof raw !== 'string') return undefined;
  return (ALL_EFFORT_LEVELS as ReadonlyArray<string>).includes(raw)
    ? (raw as ClaudeEffort)
    : undefined;
}

/**
 * Strict semantic check: does this model support this effort level? Throws on
 * mismatch. We deliberately bypass Claude's silent-fallback rule so requests
 * never produce an unintended lower effort.
 */
export function validateEffortForModel(def: ClaudeModelDefinition, effort: ClaudeEffort): void {
  if (def.effortLevels.length === 0) {
    throw new ModelValidationError(
      `Model '${def.id}' does not support the --effort flag at all. ` +
      `Omit reasoning_effort or switch to a model that supports it ` +
      `(see src/models/registry.ts).`,
      'effort_unsupported',
    );
  }
  if (!def.effortLevels.includes(effort)) {
    throw new ModelValidationError(
      `Model '${def.id}' does not support effort='${effort}'. ` +
      `Allowed levels for this model: ${def.effortLevels.join(', ')}.`,
      'effort_unsupported',
    );
  }
}

/**
 * Normalize a thinking hint (boolean or Anthropic-native object) to a strict
 * boolean. Returns undefined if the input is unset or unparseable so callers
 * can leave the setting at its default.
 */
export function extractThinking(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    const t = (raw as { type?: unknown }).type;
    if (t === 'enabled') return true;
    if (t === 'disabled') return false;
  }
  return undefined;
}

/**
 * Extract a --debug category filter from the request. Returns undefined for
 * unset, empty, or non-string values so the spawner can skip the flag.
 */
export function extractDebug(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extract a positive max-budget-usd value. Returns undefined for unset,
 * non-number, NaN, infinity, or values <= 0. Caller can pass it through
 * to claude --max-budget-usd which enforces the cap server-side.
 */
export function extractMaxBudgetUsd(raw: unknown): number | undefined {
  if (typeof raw !== 'number') return undefined;
  if (!Number.isFinite(raw)) return undefined;
  return raw > 0 ? raw : undefined;
}

/**
 * Strict semantic check: does this model support extended thinking at all?
 * Throws when thinking is requested for a model whose registry entry says no
 * (Haiku 4.5, for example). Refuses silent downgrade.
 */
export function validateThinkingForModel(def: ClaudeModelDefinition, thinking: boolean): void {
  if (thinking && !def.thinkingSupported) {
    throw new ModelValidationError(
      `Model '${def.id}' does not support extended thinking. ` +
      `Remove thinking from the request or switch to a model that supports it ` +
      `(see src/models/registry.ts).`,
      'thinking_unsupported',
    );
  }
}

/** Extract plain text from an OpenAI message-content union (string, array, or null). */
function extractContentText(content: OpenAIMessageContent): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .filter((part): part is typeof part & { text: string } =>
        part.type === "text" && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("\n");
  }
  return String(content);
}

/**
 * Flatten an OpenAI messages array into a single Claude prompt string.
 * Claude --print expects one prompt, not a conversation; we annotate roles
 * with lightweight wrappers so role boundaries survive.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"],
  req?: Pick<OpenAIChatRequest, "tools" | "tool_choice">,
): string {
  const parts: string[] = [];

  if (req && shouldBridgeExternalTools(req)) {
    parts.push(`<system>\n${toolDefsToPrompt(req)}\n</system>\n`);
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer": {
        const text = extractContentText(msg.content);
        if (!text) continue;
        parts.push(`<system>\n${text}\n</system>\n`);
        break;
      }

      case "user": {
        const text = extractContentText(msg.content);
        if (!text) continue;
        parts.push(text);
        break;
      }

      case "assistant": {
        const tcBlock = assistantToolCallsToPrompt(msg);
        const text = extractContentText(msg.content);
        const combined = [text, tcBlock].filter(Boolean).join("\n");
        if (!combined) continue;
        parts.push(`<previous_response>\n${combined}\n</previous_response>\n`);
        break;
      }

      case "tool": {
        parts.push(toolResultToPrompt(msg));
        break;
      }
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert an OpenAI-wire chat request into Claude CLI input. Performs strict
 * model and effort validation; throws on unknown model or unsupported effort.
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const def = resolveModelStrict(request.model);
  const disallowedTools = externalNativeToolDisallowList(request);
  const effort = extractEffort(request.reasoning_effort);
  if (effort) {
    validateEffortForModel(def, effort);
  }
  const thinking = extractThinking(request.thinking);
  if (thinking !== undefined) {
    validateThinkingForModel(def, thinking);
  }
  const debug = extractDebug(request.debug);
  const maxBudgetUsd = extractMaxBudgetUsd(request.max_budget_usd);
  return {
    prompt: messagesToPrompt(request.messages, request),
    model: def.id,
    sessionId: request.user,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(effort ? { effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(debug ? { debug } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
}
