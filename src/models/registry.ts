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
    // Fable 5 — Anthropics faehigstes breit verfuegbares Modell, oberhalb der
    // Opus-Preisklasse ($10 in / $50 out pro Mtok). Besonderheit gegenueber der
    // Opus-Linie: Thinking ist IMMER an und laesst sich nicht abschalten — ein
    // explizites `thinking: disabled` quittiert die API mit 400. Effort deckt
    // die volle Leiter ab und ist hier der einzige Tiefen-Regler.
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: false,
    aliases: [
      'fable-5',
      'claude-proxy/claude-fable-5',
      'claude-code-cli/claude-fable-5',
    ],
  },
  {
    // Opus 5 — Nachfolger von Opus 4.8 in der Opus-Linie, zum selben Preis
    // ($5 / $25). Zwei Verhaltensaenderungen, die hier nur dokumentiert und
    // nicht erzwungen werden koennen, weil der Proxy den thinking-Zustand nicht
    // setzt: Thinking ist per Default an (Opus 4.8 war ohne), und Abschalten
    // ist nur bis Effort `high` erlaubt — mit `xhigh`/`max` antwortet die API
    // mit 400. Wer hier spaeter ein thinking-Flag ergaenzt, muss das pruefen.
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: false,
    aliases: [
      'opus-5',
      'claude-proxy/claude-opus-5',
      'claude-code-cli/claude-opus-5',
    ],
  },
  {
    // Sonnet 5 — Sonnet-Klasse auf nahezu Opus-Niveau bei Coding/Agentic,
    // $3 / $15 (Intro $2 / $10 bis 2026-08-31). Erster Sonnet mit `xhigh`.
    // Achtung beim Tokenzaehlen: neuer Tokenizer, rund 30 % mehr Tokens fuer
    // denselben Text als Sonnet 4.6 — Kostenvergleiche gegen 4.6 sind ohne
    // Neumessung wertlos.
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: false,
    aliases: [
      'sonnet-5',
      'claude-proxy/claude-sonnet-5',
      'claude-code-cli/claude-sonnet-5',
    ],
  },
  {
    // Opus 4.8 — flagship Opus, gleicher 1M-Context + Opus-4.8-Pricing wie 4.7
    // (input $5 / output $25 / cache-write $6.25 / cache-read $0.5 pro Mtok).
    // Hinzugefuegt Welle 6 (v0.19-Migration) aus mehdic-Base-Commit 9721fb5,
    // adaptiert an die registry.ts dieses Forks. Die Default-Aliase 'opus'/'best'
    // bleiben auf 4-7, bis die Hermes-Config bewusst umschaltet (siehe
    // hermes-v019-upgrade-plan.md) — Phase 1 ist rein additiv.
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: false,
    aliases: [
      'opus-4-8',
      'claude-proxy/claude-opus-4-8',
      'claude-code-cli/claude-opus-4-8',
    ],
  },
  {
    // Opus 4.7 has a native 1M context window — no beta header required
    // (Anthropic flipped this from gated Q1 2026 to standard). Variants
    // pathway preserved for 4.6 models that still need context-1m-2025-08-07.
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: false,
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
