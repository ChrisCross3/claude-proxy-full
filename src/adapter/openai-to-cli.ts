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
  /** Minimal-mode spawn (claude --bare). */
  bare?: boolean;
  /** Disable slash commands. */
  disableSlashCommands?: boolean;
  /** JSON Schema for structured output (print-mode only). */
  jsonSchema?: Record<string, unknown>;
  /** Cap agentic turns (print-mode only). */
  maxTurns?: number;
  /** Inject Anthropic OAuth token as ANTHROPIC_API_KEY (server-side only, set by profile). */
  injectOAuthEnv?: boolean;
  /** Spawn with cwd=os.tmpdir() (server-side only, set by profile). */
  isolateCwd?: boolean;
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

/** Normalize a boolean-ish input. Returns undefined for unset/non-boolean. */
function extractBoolean(raw: unknown): boolean | undefined {
  if (raw === true || raw === false) return raw;
  return undefined;
}

export function extractBare(raw: unknown): boolean | undefined {
  return extractBoolean(raw);
}

export function extractDisableSlashCommands(raw: unknown): boolean | undefined {
  return extractBoolean(raw);
}

/**
 * Validate and extract a JSON Schema object. Same shape rules as extractAgents:
 * must be a plain object, otherwise ModelValidationError -> HTTP 400. Empty
 * object is rejected too — a schema of {} is meaningless and almost certainly
 * a caller bug worth surfacing.
 */
export function extractJsonSchema(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelValidationError(
      `json_schema must be a JSON object, got ${Array.isArray(raw) ? 'array' : typeof raw}.`,
      'json_schema_invalid',
    );
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length === 0) {
    throw new ModelValidationError(
      `json_schema must be a non-empty schema object.`,
      'json_schema_invalid',
    );
  }
  return raw as Record<string, unknown>;
}

/**
 * Extract a positive integer max-turns value. Like extractMaxBudgetUsd,
 * but integer-only (the CLI treats fractional turn counts undefined).
 */
export function extractMaxTurns(raw: unknown): number | undefined {
  if (typeof raw !== 'number') return undefined;
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) return undefined;
  return raw > 0 ? raw : undefined;
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
 * Limit for the inlined-schema portion of the forced-JSON system prompt.
 * Anthropic models tolerate large prompts but attention flattens past a few
 * thousand tokens; the JSON-Schema part is rarely needed beyond top-level
 * field names + types for the deriver-style structured extraction Honcho does.
 */
const FORCED_JSON_SCHEMA_MAX_BYTES = 8192;

/**
 * Marker key injected into a hard-reduced schema so the model - and anyone
 * reading a captured prompt - can see that top-level fields were dropped.
 * `x-` prefixed keys are the conventional JSON-Schema extension point, so this
 * does not collide with real schema vocabulary.
 */
const SCHEMA_REDUCED_KEY = "x-schema-reduced";

/**
 * Top-level schema keys that survive a reduction. Everything else (titles,
 * long descriptions, $defs, examples) is dropped first - it is decoration for
 * the deriver-style extraction Honcho does.
 */
const KEPT_TOP_LEVEL_KEYS = ["type", "required", "additionalProperties"] as const;

/** Reduce one schema node to its type-level skeleton (type, enum, item type). */
function typeSkeleton(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return {};
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (n.type !== undefined) out.type = n.type;
  if (Array.isArray(n.enum)) out.enum = n.enum;
  if (n.items !== undefined) out.items = typeSkeleton(n.items);
  return out;
}

function reducedNote(kept: number, total: number): string {
  return `schema exceeded ${FORCED_JSON_SCHEMA_MAX_BYTES} bytes; showing ${kept} of ${total} top-level properties, nested detail omitted`;
}

/**
 * Fit a serialized JSON Schema into `maxBytes` **without ever emitting a
 * partial JSON value**. Slicing the serialization mid-field (the old
 * behaviour) handed the model syntactically broken JSON, Honcho got unusable
 * output back, and the only trace was a console line nobody reads.
 *
 * Three steps, each of which produces a complete JSON document:
 *   0. the full schema, if it already fits;
 *   1. the top-level shape with every property reduced to its type - that is
 *      what the extraction actually needs (field names + types + required);
 *   2. as many type-only properties as the budget allows, plus a marker key
 *      stating how many were dropped. Always fits: the marker alone is tiny.
 */
function reduceSchemaToFit(
  schema: Record<string, unknown>,
  serialized: string,
  maxBytes: number,
): { text: string; reduced: boolean } {
  if (serialized.length <= maxBytes) return { text: serialized, reduced: false };

  const propsRaw = schema.properties;
  const props =
    propsRaw && typeof propsRaw === "object" && !Array.isArray(propsRaw)
      ? (propsRaw as Record<string, unknown>)
      : undefined;

  // Step 1: full top-level shape, properties collapsed to their types.
  const skeleton: Record<string, unknown> = {};
  for (const key of KEPT_TOP_LEVEL_KEYS) {
    if (schema[key] !== undefined) skeleton[key] = schema[key];
  }
  if (props) {
    const collapsed: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(props)) collapsed[name] = typeSkeleton(node);
    skeleton.properties = collapsed;
  }
  const level1 = JSON.stringify(skeleton);
  if (level1.length <= maxBytes) return { text: level1, reduced: true };

  // Step 2: greedily keep whole properties until the budget (minus room for
  // the marker) is used up. `required` is dropped here - it would reference
  // fields that are no longer listed.
  const total = props ? Object.keys(props).length : 0;
  const reserve = JSON.stringify({ [SCHEMA_REDUCED_KEY]: reducedNote(total, total) }).length + 1;
  const kept: Record<string, unknown> = {};
  const partial: Record<string, unknown> = {};
  if (schema.type !== undefined) partial.type = schema.type;
  partial.properties = kept;
  let keptCount = 0;
  if (props) {
    for (const [name, node] of Object.entries(props)) {
      kept[name] = typeSkeleton(node);
      if (JSON.stringify(partial).length + reserve > maxBytes) {
        delete kept[name];
        break;
      }
      keptCount++;
    }
  }
  partial[SCHEMA_REDUCED_KEY] = reducedNote(keptCount, total);
  const level2 = JSON.stringify(partial);
  if (level2.length <= maxBytes) return { text: level2, reduced: true };

  // Pathological input (e.g. a gigantic `type` value): emit the smallest
  // complete document we can still stand behind.
  return {
    text: JSON.stringify({ type: "object", [SCHEMA_REDUCED_KEY]: reducedNote(0, total) }),
    reduced: true,
  };
}

/**
 * Dialects the CLI's `--json-schema` validator can actually load.
 *
 * Measured on the pinned CLI 2.1.232: the validator is bound to draft-07. A
 * schema that *declares* a newer dialect is not merely ignored, it aborts the
 * spawn before any output is produced:
 *
 *   $ claude -p --output-format stream-json \
 *       --json-schema '{"$schema":"https://json-schema.org/draft/2020-12/schema",...}' hi
 *   Error: --json-schema is not a valid JSON Schema: no schema with key or ref
 *          "https://json-schema.org/draft/2020-12/schema"
 *   $ echo $?
 *   1
 *
 * Same behaviour in `--output-format json`. Since the isolated route spawns
 * through the warm bare-init-pool, that exit-1 surfaces to the caller as a
 * failed acquire, not as a degraded answer. So a schema naming an unloadable
 * dialect must NOT go down the native path — it keeps the prompt fallback.
 *
 * Absence of `$schema` is the common case and is fine: Pydantic v2's
 * `model_json_schema()` deliberately omits the key, and Honcho passes that
 * output through unchanged.
 */
const CLI_SUPPORTED_SCHEMA_DIALECT = /draft-07/;

/**
 * Extract the inner JSON Schema from an OpenAI `response_format` for the
 * native `claude --json-schema` flag.
 *
 * Why this exists (and supersedes `responseFormatToSystemPrompt` for the
 * common case): the CLI *does* have native enforcement. Verified end-to-end on
 * 2.1.232 with the isolated profile's exact spawn shape (`--bare`, all eight
 * workspace tools disallowed, `--output-format stream-json`):
 *
 *   - `--json-schema` installs a synthetic `StructuredOutput` tool. With the
 *     profile's disallow-list applied, the init message reports
 *     `"tools":["StructuredOutput"]` — the schema tool survives `--bare`, and
 *     nothing else does.
 *   - The model answers by CALLING that tool, so the payload is validated
 *     against the schema instead of being coaxed out of free prose. On
 *     mismatch the CLI re-prompts and, if it runs out of retries, ends with
 *     subtype `error_max_structured_output_retries` rather than silently
 *     returning something unparseable.
 *   - The result message carries the validated JSON in BOTH `structured_output`
 *     (parsed) and `result` (serialized). `cliResultToOpenai` already reads
 *     `result.result`, so the JSON lands in the OpenAI `content` field with no
 *     further plumbing.
 *
 * Note the assistant *text* stays prose in this mode (upstream issue #15511) —
 * harmless here because the isolated route is non-streaming by construction
 * and converts from the result message, never from accumulated deltas. A
 * streaming caller could not use this path.
 *
 * Returns `undefined` — meaning "use the prompt fallback" — when:
 *   - response_format is missing or not a json_schema-typed object
 *   - the inner schema is missing or empty
 *   - the schema declares a dialect the CLI validator cannot load
 */
export function responseFormatToJsonSchema(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as { type?: unknown; json_schema?: unknown };
  if (obj.type !== "json_schema") return undefined;
  if (!obj.json_schema || typeof obj.json_schema !== "object") return undefined;

  const wrapper = obj.json_schema as { name?: unknown; schema?: unknown };
  const schemaRaw = wrapper.schema;
  if (!schemaRaw || typeof schemaRaw !== "object" || Array.isArray(schemaRaw)) return undefined;

  const schema = schemaRaw as Record<string, unknown>;
  if (Object.keys(schema).length === 0) return undefined;

  const dialect = schema.$schema;
  if (typeof dialect === "string" && !CLI_SUPPORTED_SCHEMA_DIALECT.test(dialect)) {
    console.error(
      `[openai-to-cli] responseFormatToJsonSchema: schema declares dialect "${dialect}", ` +
        `which the CLI validator would reject (exit 1). Falling back to the forced-JSON prompt` +
        (typeof wrapper.name === "string" ? ` (name=${wrapper.name})` : "") +
        `.`,
    );
    return undefined;
  }

  return schema;
}

/**
 * Convert an OpenAI `response_format` (Structured Outputs) into an aggressive
 * Claude `--system-prompt` string.
 *
 * FALLBACK ONLY as of the native-schema switch. `responseFormatToJsonSchema`
 * handles the common case via `--json-schema`; this prompt hack remains for
 * schemas the CLI validator would refuse to load (see
 * `CLI_SUPPORTED_SCHEMA_DIALECT`). Keeping it is deliberate: the alternative
 * for those schemas is a hard spawn failure, and a weakly-enforced answer
 * beats no answer. It relies on Honcho's `json_repair` fence-stripping.
 *
 * The 8192-byte cap and `reduceSchemaToFit` below serve only this fallback.
 * Honcho's real traffic no longer reaches them — its schemas come from
 * Pydantic v2, which omits `$schema` entirely, so they take the native path
 * whole and unreduced regardless of size.
 *
 * Returns `undefined` when:
 *   - response_format is missing or not a json_schema-typed object
 *   - the inner schema is missing or empty
 *   - schema serialization fails (cycles, BigInt, etc.)
 *
 * Callers that need to combine with an existing system_prompt should choose
 * either replace (default in profile config) or append externally.
 */
export function responseFormatToSystemPrompt(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as { type?: unknown; json_schema?: unknown };
  if (obj.type !== "json_schema") return undefined;
  if (!obj.json_schema || typeof obj.json_schema !== "object") return undefined;

  const wrapper = obj.json_schema as { name?: unknown; schema?: unknown };
  const schemaRaw = wrapper.schema;
  if (!schemaRaw || typeof schemaRaw !== "object") return undefined;

  let serialized: string;
  try {
    serialized = JSON.stringify(schemaRaw);
  } catch {
    return undefined;
  }
  if (serialized.length === 0 || serialized === "{}") return undefined;

  const { text: schemaText, reduced } = reduceSchemaToFit(
    schemaRaw as Record<string, unknown>,
    serialized,
    FORCED_JSON_SCHEMA_MAX_BYTES,
  );
  if (reduced) {
    console.error(
      `[openai-to-cli] responseFormatToSystemPrompt: schema reduced from ${serialized.length} to ${schemaText.length} bytes` +
        (typeof wrapper.name === "string" ? ` (name=${wrapper.name})` : ""),
    );
  }

  const name = typeof wrapper.name === "string" && wrapper.name.length > 0 ? wrapper.name : "Response";
  // The reduction is announced in the prompt itself, not through the return
  // value: the signature is `string | undefined` and has several callers
  // (openaiToCli plus the profile-bound routes), so widening it would be a
  // breaking change for a rare edge case. The prompt is the one channel every
  // caller already gets, it is what lands in captured traces, and the model
  // needs the warning anyway. console.error stays as the operator-facing signal.
  const notice = reduced
    ? [
        `NOTE: the schema below was REDUCED to its top-level structure (field names and types) ` +
          `because the full schema exceeded ${FORCED_JSON_SCHEMA_MAX_BYTES} bytes. ` +
          `Nested detail is omitted; still return valid JSON for the fields shown.`,
      ]
    : [];
  return [
    `You MUST respond with ONLY valid JSON matching the schema below.`,
    `No prose. No explanations. No commentary.`,
    `Markdown code fences are allowed but optional — the caller will strip them.`,
    `Start your response with the opening brace or bracket of the JSON value.`,
    `Schema name: ${name}`,
    ...notice,
    `JSON Schema:`,
    schemaText,
  ].join("\n");
}

export interface OpenaiToCliOptions {
  /**
   * When true, `response_format: {type: "json_schema", ...}` is converted to
   * an aggressive `system_prompt` via `responseFormatToSystemPrompt()` and
   * REPLACES any user-supplied system_prompt. Used by the "isolated" profile
   * for Honcho-style structured-extraction calls. Default false preserves
   * legacy behaviour on the default `/v1/chat/completions` route.
   *
   * As of the native-schema switch this is the SECOND choice: the mapping
   * first tries `responseFormatToJsonSchema()` and emits `jsonSchema`
   * (→ `claude --json-schema`), which leaves any caller system_prompt intact.
   * The prompt hack only runs for schemas the CLI validator would reject.
   */
  mapResponseFormat?: boolean;
  /**
   * Server-side flag overrides applied AFTER request-body parsing. Used by
   * profile-bound routes (e.g. /v1/isolated/...) to force flags the client
   * cannot or should not control (bare, isolateCwd, injectOAuthEnv).
   * Unset fields leave request-body values intact.
   */
  forceFlags?: {
    bare?: boolean;
    disableSlashCommands?: boolean;
    isolateCwd?: boolean;
    injectOAuthEnv?: boolean;
  };
}

/**
 * Convert an OpenAI-wire chat request into Claude CLI input. Performs strict
 * model and effort validation; throws on unknown model or unsupported effort.
 *
 * When `opts.mapResponseFormat` is set, an OpenAI `response_format: json_schema`
 * is mapped to the CLI's native structured output — `jsonSchema` here,
 * `claude --json-schema` at spawn time (see `responseFormatToJsonSchema`).
 * Only a schema the CLI validator would refuse falls back to the forced-JSON
 * system prompt (see `responseFormatToSystemPrompt`), which then overrides any
 * user-supplied `system_prompt`.
 */
export function openaiToCli(request: OpenAIChatRequest, opts: OpenaiToCliOptions = {}): CliInput {
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
  let systemPrompt = extractSystemPrompt(request.system_prompt);
  const appendSystemPrompt = extractAppendSystemPrompt(request.append_system_prompt);
  const agent = extractAgent(request.agent);
  const agents = extractAgents(request.agents);
  let bare = extractBare(request.bare);
  let disableSlashCommands = extractDisableSlashCommands(request.disable_slash_commands);
  let jsonSchema = extractJsonSchema(request.json_schema);
  // Map `response_format: json_schema` for profiles that ask for it. Native
  // `--json-schema` first; only a schema the CLI validator would reject falls
  // back to the forced-JSON system prompt (which then REPLACES any
  // caller-supplied system_prompt, as it always did). An explicit
  // `json_schema` body field wins over both — it is the more deliberate
  // signal, and the two would otherwise be redundant.
  if (opts.mapResponseFormat && !jsonSchema) {
    const native = responseFormatToJsonSchema(request.response_format);
    if (native) {
      jsonSchema = native;
    } else {
      const forced = responseFormatToSystemPrompt(request.response_format);
      if (forced) systemPrompt = forced;
    }
  }
  const maxTurns = extractMaxTurns(request.max_turns);
  let isolateCwd: boolean | undefined;
  let injectOAuthEnv: boolean | undefined;
  if (opts.forceFlags) {
    if (opts.forceFlags.bare !== undefined) bare = opts.forceFlags.bare;
    if (opts.forceFlags.disableSlashCommands !== undefined) {
      disableSlashCommands = opts.forceFlags.disableSlashCommands;
    }
    if (opts.forceFlags.isolateCwd !== undefined) isolateCwd = opts.forceFlags.isolateCwd;
    if (opts.forceFlags.injectOAuthEnv !== undefined) injectOAuthEnv = opts.forceFlags.injectOAuthEnv;
  }
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
    ...(bare !== undefined ? { bare } : {}),
    ...(disableSlashCommands !== undefined ? { disableSlashCommands } : {}),
    ...(jsonSchema ? { jsonSchema } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(isolateCwd !== undefined ? { isolateCwd } : {}),
    ...(injectOAuthEnv !== undefined ? { injectOAuthEnv } : {}),
  };
}
