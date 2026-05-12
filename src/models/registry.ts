/**
 * Claude model registry — single source of truth for model capabilities.
 *
 * Source: Anthropic documentation (Stand 2026-05-10):
 *   - https://code.claude.com/docs/en/model-config#adjust-effort-level
 *   - https://platform.claude.com/docs/en/about-claude/models/overview
 *
 * Downstream code uses strict validation: a requested capability that is
 * not declared here is rejected with an explicit error, not silently
 * downgraded by the Claude CLI's fallback rules. When Anthropic releases
 * a new model or changes a capability, update this file.
 */

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeModelDefinition {
  /** Canonical model ID — exactly what claude --model expects. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Total context window in tokens (input + output combined). */
  contextWindow: number;
  /** Maximum output tokens per response. */
  maxOutputTokens: number;
  /** Allowed --effort levels. Empty array means effort is not supported on this model. */
  effortLevels: ReadonlyArray<ClaudeEffort>;
  /** Whether extended thinking / adaptive reasoning is supported. */
  thinkingSupported: boolean;
  /** Whether the model has a 1M-token-context variant accessible via [1m] suffix. */
  oneMillionContextVariant: boolean;
  /** Alternate IDs that resolve to this model (short aliases, legacy IDs, provider prefixes). */
  aliases: ReadonlyArray<string>;
}

export const MODELS: ReadonlyArray<ClaudeModelDefinition> = [
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'opus',
      'best',
      'opus-4-7',
      'claude-proxy/claude-opus-4-7',
      'claude-code-cli/claude-opus-4-7',
    ],
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    effortLevels: ['low', 'medium', 'high', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'opus-4-6',
      'claude-proxy/claude-opus-4-6',
      'claude-code-cli/claude-opus-4-6',
    ],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    effortLevels: ['low', 'medium', 'high', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'sonnet',
      'sonnet-4-6',
      'claude-proxy/claude-sonnet-4-6',
      'claude-code-cli/claude-sonnet-4-6',
    ],
  },
  {
    // Canonical ID is the version-major form (no date suffix) — keeps
    // downstream telemetry, /metrics labels, and pricing keys stable when
    // Anthropic rolls a minor refresh under the same major version.
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    effortLevels: [],
    thinkingSupported: false,
    oneMillionContextVariant: false,
    aliases: [
      'haiku',
      'claude-haiku-4-5-20251001',
      'claude-proxy/claude-haiku-4-5',
      'claude-proxy/claude-haiku-4-5-20251001',
      'claude-code-cli/claude-haiku-4-5',
      'claude-code-cli/claude-haiku-4-5-20251001',
    ],
  },
] as const;

/** Union of every effort level accepted across all known models. */
export const ALL_EFFORT_LEVELS: ReadonlyArray<ClaudeEffort> = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

interface ContextSuffix {
  base: string;
  oneMillion: boolean;
}

/** Strip a [1m] context-window suffix for canonical lookups. */
function stripContextSuffix(id: string): ContextSuffix {
  const match = id.match(/^(.*)\[1m\]$/);
  return match ? { base: match[1], oneMillion: true } : { base: id, oneMillion: false };
}

/**
 * Resolve any accepted model identifier (canonical ID, alias, or [1m] variant)
 * to a canonical ClaudeModelDefinition. Returns undefined for unknown identifiers;
 * callers should treat unknown models as a hard error.
 */
export function resolveModel(idOrAlias: string): ClaudeModelDefinition | undefined {
  const { base } = stripContextSuffix(idOrAlias);
  for (const def of MODELS) {
    if (def.id === base) return def;
    if (def.aliases.includes(base)) return def;
  }
  return undefined;
}

/** True if the requested effort level is allowed for the given model. Strict, no fallback. */
export function isEffortAllowedForModel(modelIdOrAlias: string, effort: ClaudeEffort): boolean {
  const def = resolveModel(modelIdOrAlias);
  return def ? def.effortLevels.includes(effort) : false;
}

/** True if extended thinking is supported for the given model. */
export function isThinkingAllowedForModel(modelIdOrAlias: string): boolean {
  return resolveModel(modelIdOrAlias)?.thinkingSupported ?? false;
}
