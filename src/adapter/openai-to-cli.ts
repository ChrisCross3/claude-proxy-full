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

export interface CliInput {
  prompt: string;
  /** Canonical Claude model ID, resolved through the registry. */
  model: string;
  sessionId?: string;
  disallowedTools?: string[];
  /** Effort level. Validated against the model's effortLevels before use. */
  effort?: ClaudeEffort;
}

/**
 * Resolve any accepted model identifier (canonical ID, alias, [1m] variant)
 * to its canonical ID. Throws if the model is not declared in the registry.
 */
export function extractModel(model: string): string {
  const def = resolveModel(model);
  if (!def) {
    throw new Error(
      `Unknown Claude model id or alias: '${model}'. ` +
      `Add it to src/models/registry.ts if Anthropic has released it.`,
    );
  }
  return def.id;
}

/** Like extractModel, but returns the full definition for callers that need it. */
export function resolveModelStrict(model: string): ClaudeModelDefinition {
  const def = resolveModel(model);
  if (!def) {
    throw new Error(
      `Unknown Claude model id or alias: '${model}'. ` +
      `Add it to src/models/registry.ts if Anthropic has released it.`,
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
    throw new Error(
      `Model '${def.id}' does not support the --effort flag at all. ` +
      `Omit reasoning_effort or switch to a model that supports it ` +
      `(see src/models/registry.ts).`,
    );
  }
  if (!def.effortLevels.includes(effort)) {
    throw new Error(
      `Model '${def.id}' does not support effort='${effort}'. ` +
      `Allowed levels for this model: ${def.effortLevels.join(', ')}.`,
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
  return {
    prompt: messagesToPrompt(request.messages, request),
    model: def.id,
    sessionId: request.user,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(effort ? { effort } : {}),
  };
}
