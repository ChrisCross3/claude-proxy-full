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
  /** Permission mode for tool calls. Whitelist-validated. */
  permissionMode?: ClaudePermissionMode;
  /** Replacement system prompt; mapped to claude --system-prompt. */
  systemPrompt?: string;
  /** Appended system prompt; mapped to claude --append-system-prompt. */
  appendSystemPrompt?: string;
  /** Single named subagent; mapped to claude --agent. */
  agent?: string;
  /** Ad-hoc subagent definitions; mapped to claude --agents <inline JSON>. */
  agents?: Record<string, unknown>;
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
 * Extract a non-empty string for system prompt fields. Trims whitespace;
 * returns undefined for unset, empty, or non-string inputs. Used for both
 * system_prompt (replace) and append_system_prompt (append).
 */
function extractNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractSystemPrompt(raw: unknown): string | undefined {
  return extractNonEmptyString(raw);
}

export function extractAppendSystemPrompt(raw: unknown): string | undefined {
  return extractNonEmptyString(raw);
}

/**
 * Extract a single-named agent identifier. Free-form (subagent names can be
 * user-defined), but must be a non-empty string. Returns undefined for unset.
 */
export function extractAgent(raw: unknown): string | undefined {
  return extractNonEmptyString(raw);
}

/**
 * Validate and extract an inline agents map. Must be a plain object
 * (Record<string, unknown>); other shapes throw ModelValidationError so the
 * client gets HTTP 400 with a clear code. We do not validate the contents of
 * each agent entry — Anthropic's CLI is the source of truth for that schema.
 */
export function extractAgents(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelValidationError(
      `agents must be a JSON object mapping agent names to definitions, got ${Array.isArray(raw) ? 'array' : typeof raw}.`,
      'agents_invalid',
    );
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length === 0) return undefined;
  return raw as Record<string, unknown>;
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

export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

const VALID_PERMISSION_MODES: ReadonlyArray<ClaudePermissionMode> = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

/**
 * Extract and validate permission_mode. Returns undefined for unset values,
 * throws ModelValidationError for any non-empty string that is not in the
 * whitelist — strict: a typo or new mode that we have not declared support
 * for must surface to the client, not silently fall back to the default.
 */
export function extractPermissionMode(raw: unknown): ClaudePermissionMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ModelValidationError(
      `permission_mode must be a string, got ${typeof raw}.`,
      'permission_mode_invalid',
    );
  }
  if (raw === '') return undefined;
  if (!(VALID_PERMISSION_MODES as ReadonlyArray<string>).includes(raw)) {
    throw new ModelValidationError(
      `Unknown permission_mode '${raw}'. ` +
      `Allowed: ${VALID_PERMISSION_MODES.join(', ')}.`,
      'permission_mode_invalid',
    );
  }
  return raw as ClaudePermissionMode;
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
  const permissionMode = extractPermissionMode(request.permission_mode);
  const systemPrompt = extractSystemPrompt(request.system_prompt);
  const appendSystemPrompt = extractAppendSystemPrompt(request.append_system_prompt);
  const agent = extractAgent(request.agent);
  const agents = extractAgents(request.agents);
  return {
    prompt: messagesToPrompt(request.messages, request),
    model: def.id,
    sessionId: request.user,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(effort ? { effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(debug ? { debug } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(agent ? { agent } : {}),
    ...(agents ? { agents } : {}),
  };
}
