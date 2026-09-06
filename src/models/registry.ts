/**
 * Claude model registry — single source of truth for model capabilities.
 *
 * ZWEI QUELLEN, und beide werden gebraucht:
 *
 *   1. Anthropic-Doku (Stand 2026-09-06), je Modell die eigene Seite:
 *      https://platform.claude.com/docs/en/models/<modell>/overview
 *      plus https://platform.claude.com/docs/en/build-with-claude/effort
 *      (die Effort-Seite nennt die unterstuetzten Modelle NAMENTLICH und
 *      sagt getrennt, welche `xhigh` und welche `max` koennen).
 *
 *   2. MESSUNG gegen die CLI im Tenant, am 2026-09-06 mit CLI 2.1.261:
 *      jede ID und jede [1m]-Variante einmal aufgerufen. Das ist kein
 *      Luxus — die Doku beschreibt die API, wir fahren die Claude-Code-CLI
 *      unter einem ABONNEMENT. Genau dort gehen die beiden auseinander:
 *      `claude-opus-4-5[1m]` und `claude-haiku-4-5[1m]` quittiert die API
 *      mit "The long context beta is not yet available for this
 *      subscription", waehrend `claude-sonnet-4-5[1m]` durchgeht.
 *
 * Downstream code uses strict validation: a requested capability that is
 * not declared here is rejected with an explicit error, not silently
 * downgraded by the Claude CLI's fallback rules. When Anthropic releases
 * a new model or changes a capability, update this file.
 *
 * NICHT ENTHALTEN und warum:
 *   - `claude-mythos-5-1` / `claude-mythos-5`: dasselbe Modell wie Fable,
 *     nur mit anderen Schutzmechanismen, und ausschliesslich ueber ein
 *     Trusted-Access-Programm zu haben. Gemessen: die CLI antwortet
 *     "It may not exist or you may not have access to it." Ein Eintrag
 *     hier wuerde eine Faehigkeit behaupten, die dieses Konto nicht hat.
 */

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeModelDefinition {
  /** Canonical model ID — exactly what claude --model expects. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Total context window in tokens (input + output combined). */
  contextWindow: number;
  /**
   * Maximum output tokens per response (synchronous Messages API limit).
   * Nur Metadaten: der Proxy reicht den Wert in /v1/models durch (index.ts),
   * er begrenzt nichts.
   */
  maxOutputTokens: number;
  /**
   * Allowed --effort levels. Empty array means effort is not supported on
   * this model — was fuer Haiku 4.5 und Sonnet 4.5 ausdruecklich gilt
   * ("Default effort: Not supported"). Dass die CLI `--effort` auch dort
   * ANNIMMT, beweist nichts: sie validiert den Wert nur syntaktisch.
   */
  effortLevels: ReadonlyArray<ClaudeEffort>;
  /**
   * Whether the model thinks at all. ACHTUNG, zwei verschiedene Mechanismen
   * hinter einem Flag:
   *   - ADAPTIV (Fable, Opus 5, Sonnet 5, Opus 4.6-4.8, Sonnet 4.6): das
   *     Modell entscheidet selbst, gesteuert ueber `effort`. Der manuelle
   *     Budget-Modus ist auf 4.6 abgekuendigt und auf spaeteren Modellen
   *     gar nicht mehr erlaubt.
   *   - ERWEITERT (Haiku 4.5, Opus 4.5, Sonnet 4.5): der manuelle
   *     `thinking.type: "enabled"` + budget_tokens-Modus.
   * Der Proxy setzt keinen API-Parameter, sondern die Claude-Code-Einstellung
   * `alwaysThinkingEnabled` (stream-json-manager.ts) — dieses Flag ist also
   * ein Tor, keine Uebersetzung.
   */
  thinkingSupported: boolean;
  /**
   * Whether `<id>[1m]` is accepted on THIS subscription. Gemessen, nicht
   * aus der Doku abgeleitet: bei Modellen mit nativem 1M-Fenster schaltet
   * das Suffix in Claude Code das volle Fenster frei (der Gegenschalter ist
   * CLAUDE_CODE_DISABLE_1M_CONTEXT=1), bei aelteren Modellen zieht es die
   * Long-Context-Beta — und die ist nicht ueberall freigeschaltet.
   */
  oneMillionContextVariant: boolean;
  /** Alternate IDs that resolve to this model (short aliases, legacy IDs, provider prefixes). */
  aliases: ReadonlyArray<string>;
}

export const MODELS: ReadonlyArray<ClaudeModelDefinition> = [
  // ===================================================================
  // AKTUELLE REIHE (Anthropic: "current lineup", Stand 2026-09-06)
  // ===================================================================
  {
    // Fable 5.1 — seit 2026-09-01 das aktuelle Fable, oberhalb der
    // Opus-Preisklasse ($10 in / $50 out pro Mtok). Besonderheit gegenueber
    // der Opus-Linie: Thinking ist IMMER an und laesst sich nicht
    // abschalten. Effort deckt die volle Leiter ab und ist der einzige
    // Tiefen-Regler. Kann als einziges neben Opus 5 und Mythos 5.1 den
    // Effort MITTEN im Gespraech wechseln, ohne den Prompt-Cache zu werfen.
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'fable',
      'fable-5-1',
      'claude-proxy/claude-fable-5-1',
      'claude-code-cli/claude-fable-5-1',
    ],
  },
  {
    // Opus 5 — Anthropics Empfehlung als Startpunkt fuer die meisten
    // Aufgaben ($5 / $25). Thinking ist per Default an; abschalten geht nur
    // bis Effort `high` — mit `xhigh`/`max` antwortet die API mit 400.
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'opus',
      'best',
      'opus-5',
      'claude-proxy/claude-opus-5',
      'claude-code-cli/claude-opus-5',
    ],
  },
  {
    // Sonnet 5 — Sonnet-Klasse auf nahezu Opus-Niveau bei Coding/Agentic,
    // $2 / $10. Erster Sonnet mit `xhigh`. Achtung beim Tokenzaehlen: neuer
    // Tokenizer (seit Opus 4.7), rund 30 % mehr Tokens fuer denselben Text
    // als Sonnet 4.6 — Kostenvergleiche gegen 4.6 sind ohne Neumessung
    // wertlos.
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'sonnet',
      'sonnet-5',
      'claude-proxy/claude-sonnet-5',
      'claude-code-cli/claude-sonnet-5',
    ],
  },
  {
    // Haiku 4.5 — schnellstes Modell, und das einzige der aktuellen Reihe
    // OHNE Effort. Es denkt trotzdem, aber im manuellen Modus (Extended,
    // kein interleaved Thinking zwischen Werkzeugaufrufen).
    // Canonical ID is the version-major form (no date suffix) — keeps
    // downstream telemetry, /metrics labels, and pricing keys stable when
    // Anthropic rolls a minor refresh under the same major version.
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    effortLevels: [],
    thinkingSupported: true,
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

  // ===================================================================
  // ALTBESTAND — von Anthropic als "Legacy" gefuehrt, aber weiterhin
  // verfuegbar und im Tenant einzeln nachgemessen. Sie stehen hier, damit
  // ein festgepinnter Aufruf nicht am Proxy scheitert; fuer neue Arbeit
  // gilt die aktuelle Reihe oben.
  // ===================================================================
  {
    // Fable 5 — Vorgaenger von 5.1, sonst baugleiche Eckdaten. Kann den
    // Effort NICHT mitten im Gespraech wechseln (400 auf das Beta-Feld).
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'fable-5',
      'claude-proxy/claude-fable-5',
      'claude-code-cli/claude-fable-5',
    ],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'opus-4-8',
      'claude-proxy/claude-opus-4-8',
      'claude-code-cli/claude-opus-4-8',
    ],
  },
  {
    // Opus 4.7 hat ein natives 1M-Fenster — kein Beta-Header noetig.
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'opus-4-7',
      'claude-proxy/claude-opus-4-7',
      'claude-code-cli/claude-opus-4-7',
    ],
  },
  {
    // 4.6er Generation: `max` ja, `xhigh` NEIN — die Effort-Doku nennt
    // xhigh nur fuer Fable/Mythos, Opus 5, Opus 4.7/4.8 und Sonnet 5.
    // Thinking ist adaptiv, der manuelle Budget-Modus ist hier abgekuendigt.
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
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
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'max'],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'sonnet-4-6',
      'claude-proxy/claude-sonnet-4-6',
      'claude-code-cli/claude-sonnet-4-6',
    ],
  },
  {
    // Opus 4.5 — das EINZIGE Modell mit manuellem Thinking, das trotzdem
    // Effort kennt (Anthropic: "the only extended-thinking-only model that
    // supports effort"). Aber nur drei Stufen: weder `xhigh` noch `max`
    // nennen es in ihren Listen. Die Effort-Doku fuehrt es ausserdem unter
    // der DATIERTEN ID — der Alias ist hier keine Formalie.
    // Gemessen: [1m] wird von diesem Abo abgelehnt.
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    effortLevels: ['low', 'medium', 'high'],
    thinkingSupported: true,
    oneMillionContextVariant: false,
    aliases: [
      'opus-4-5',
      'claude-opus-4-5-20251101',
      'claude-proxy/claude-opus-4-5',
      'claude-code-cli/claude-opus-4-5',
    ],
  },
  {
    // Sonnet 4.5 — kein Effort ("Default effort: Not supported"), aber
    // manuelles Thinking. Einziges 200K-Modell hier, dessen [1m]-Variante
    // dieses Abo tatsaechlich annimmt (die alte Long-Context-Beta).
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    effortLevels: [],
    thinkingSupported: true,
    oneMillionContextVariant: true,
    aliases: [
      'sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-proxy/claude-sonnet-4-5',
      'claude-code-cli/claude-sonnet-4-5',
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
 *
 * Bewusst NACHSICHTIG gegenueber [1m]: diese Funktion laeuft auch auf dem
 * Rueckweg (cli-to-openai), wo eine Antwort nicht daran scheitern darf, dass
 * eine Variante nicht freigeschaltet ist. Die Pruefung sitzt im Hinweg —
 * siehe resolveModelRequest.
 */
export function resolveModel(idOrAlias: string): ClaudeModelDefinition | undefined {
  const { base } = stripContextSuffix(idOrAlias);
  for (const def of MODELS) {
    if (def.id === base) return def;
    if (def.aliases.includes(base)) return def;
  }
  return undefined;
}

export interface ResolvedModelRequest {
  def: ClaudeModelDefinition;
  /** True wenn der Aufrufer ausdruecklich `[1m]` angehaengt hat. */
  oneMillionRequested: boolean;
}

/**
 * Wie resolveModel, aber behaelt die Information, OB `[1m]` verlangt wurde.
 *
 * Warum das getrennt steht: `oneMillionContextVariant` war bis 2026-09-06
 * ein totes Feld — resolveModel hat das Suffix abgestreift und die Eigenschaft
 * nie angesehen. Ein Aufruf von `claude-haiku-4-5[1m]` lief also durch den
 * Proxy und starb erst an der API mit 400. Frueh und mit klarer Meldung zu
 * scheitern ist die bessere Fehlermeldung; die Pruefung selbst macht
 * resolveModelStrict (openai-to-cli.ts).
 */
export function resolveModelRequest(idOrAlias: string): ResolvedModelRequest | undefined {
  const { base, oneMillion } = stripContextSuffix(idOrAlias);
  const def = resolveModel(base);
  return def ? { def, oneMillionRequested: oneMillion } : undefined;
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
