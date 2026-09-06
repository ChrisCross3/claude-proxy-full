/**
 * Server-side profiles for predefined call patterns (Welle 5 Phase 5A.5.1).
 *
 * A profile bundles a set of defaults that get applied to a request BEFORE
 * adapter conversion (openaiToCli) and BEFORE pool routing (acquire*). The
 * "isolated" profile, used by the `/v1/isolated/chat/completions` route, sets
 * up Honcho-style isolated LLM calls: claude `--bare` to skip workspace
 * discovery + auto-memory + CLAUDE.md, OAuth-token injection via env so
 * `--bare` doesn't break Anthropic auth, and OpenAI `response_format:
 * json_schema` mapping onto the CLI's native `--json-schema` enforcement
 * (forced-JSON system prompt kept as the fallback, see `mapResponseFormat`).
 *
 * Profile defaults are server-side — Honcho doesn't have to send any custom
 * body fields. The profile attaches via the route path.
 */

import type { RuntimeMode } from "../subprocess/runtime.js";

export interface Profile {
  /** Pass `bare: true` into spawn options regardless of request body. */
  bare: boolean;
  /**
   * Pass `disableSlashCommands: true` into spawn options regardless of request
   * body. Prevents Honcho user text starting with `/` from being misinterpreted.
   */
  disableSlashCommands: boolean;
  /**
   * Map an OpenAI `response_format: json_schema` onto the CLI's structured
   * output. Two paths, in this order (see openaiToCli in openai-to-cli.ts):
   *
   *   1. NATIVE (the normal case): responseFormatToJsonSchema() hands the
   *      inner schema to `claude --json-schema`. The CLI installs a synthetic
   *      `StructuredOutput` tool, validates the answer against the schema and
   *      re-prompts on mismatch. Any caller-supplied `system_prompt` stays
   *      untouched.
   *   2. FALLBACK: responseFormatToSystemPrompt() embeds the schema in a
   *      forced-JSON system prompt and overrides `system_prompt`.
   *
   * The fallback is NOT dead weight — do not remove it. The CLI's schema
   * validator is bound to draft-07, and a schema that *declares* a foreign
   * dialect does not get ignored: the spawn aborts with exit 1, which on the
   * pooled isolated route surfaces as a failed acquire rather than a weak
   * answer. Such schemas therefore keep the prompt path on purpose. Honcho's
   * own schemas come from Pydantic v2 and carry no `$schema`, so they take
   * the native path. Details and the measured evidence sit next to
   * `CLI_SUPPORTED_SCHEMA_DIALECT` in openai-to-cli.ts.
   */
  mapResponseFormat: boolean;
  /**
   * Spawn the subprocess with cwd=os.tmpdir() so even non-bare CLAUDE.md
   * walk-up discovery (cwd→root) finds nothing relevant.
   */
  isolateCwd: boolean;
  /**
   * Inject the Anthropic OAuth token as the ANTHROPIC_AUTH_TOKEN env var.
   * Required when bare=true, because --bare disables the CLI's OAuth/keychain
   * reads.
   *
   * (Der Kommentar nannte bis 2026-09-06 ANTHROPIC_API_KEY. Falsch, und nicht
   * beliebig: die beiden reisen in VERSCHIEDENEN Kopfzeilen — x-api-key gegen
   * Authorization. Siehe resolveSpawnEnv in manager.ts.)
   */
  injectOAuthEnv: boolean;
  /**
   * `claude --restricted`. Nimmt der CLI die ausfuehrenden Werkzeuge, ignoriert
   * gefundene Einstellungsdateien und lehnt bypassPermissions ab. Siehe die
   * woertliche Hilfe an StreamJsonOptions.restricted.
   */
  restricted: boolean;
  /** `claude --strict-mcp-config`. Gehoert zu restricted dazu. */
  strictMcpConfig: boolean;
  /**
   * Erlaubnisliste der eingebauten Werkzeuge. `[]` heisst `--tools ""` und
   * damit "keine". `undefined` heisst "Flag nicht setzen".
   */
  tools?: string[];
  /**
   * Welche Werkzeug-Bruecke gilt.
   *
   *   "mcp"  — Hermes' Werkzeuge werden als ECHTE MCP-Werkzeuge angemeldet.
   *            Das Modell liefert strukturierte `tool_use`-Bloecke; nichts
   *            wird geparst. Gemessen 10/10 gegen 6/10 der Textbruecke.
   *   "text" — der alte Weg: Schemata als ~35 KB JSON in den Prompt und
   *            Hoffnung auf `{"tool_call":…}`. Bleibt als Rueckfall, bis der
   *            neue Weg im Betrieb belegt ist.
   *
   * ZWEI MECHANISMEN NEBENEINANDER SIND SCHULD, keine Absicherung: sobald
   * "mcp" gemessen ist, gehoert "text" entfernt. Bis dahin ist der Schalter
   * die Moeglichkeit, ohne Deployment zurueckzufallen.
   */
  toolBridge: "mcp" | "text";
  /**
   * Erzwungener Sitzungsmodus. "stateless" heisst: eigener Unterprozess je
   * Anfrage, danach getoetet. Kein Wiederverwenden, kein Pool ueber Anfragen
   * hinweg, keine Moeglichkeit, dass zwei Aufrufer denselben Verlauf sehen.
   *
   * Warum das ein PROFIL-Feld ist und keine Client-Option: der Aufrufer darf
   * ueber Kontexttrennung nicht entscheiden koennen. Ein vergessener Header
   * waere sonst eine Vermischung.
   */
  sessionMode?: "stateless";
  /**
   * CLI tools to forcibly disallow (claude --disallowed-tools).
   * --bare leaves Bash, Edit, Read enabled by default; for untrusted-input
   * profiles (e.g. Honcho's response_format extraction) those must be off to
   * neutralize prompt-injection attempts. Set via Profile-server-side, NOT
   * overridable by client body.
   */
  forceDisallowedTools: string[];
  /**
   * Pool routing strategy.
   *   "bare":    historical value — there is no separate bare pool any more
   *   "default": use the pre-init-pool
   *   "none":    cold-spawn every request (debugging only)
   *
   * Stale by two counts, kept only because removing the field is a logic
   * change: (a) since the init-pool rework there is ONE pool, keyed by model
   * plus a fingerprint of the whole spawn configuration, so the isolated path
   * is merely another configuration in it (see init-pool.ts, configKey); and
   * (b) nothing reads this field — routes.ts consumes bare,
   * disableSlashCommands, mapResponseFormat, isolateCwd, injectOAuthEnv and
   * forceDisallowedTools, never `pool`. Do not derive behaviour from it.
   */
  pool: "bare" | "default" | "none";
  /**
   * Override the runtime mode for this profile. Left undefined by the
   * isolated profile — see the note on ISOLATED_PROFILE below for why the
   * `--json-schema` flag is no reason to force "print".
   */
  runtime?: RuntimeMode;
}

export const ISOLATED_PROFILE: Profile = {
  bare: true,
  disableSlashCommands: true,
  mapResponseFormat: true,
  isolateCwd: true,
  injectOAuthEnv: true,
  restricted: true,
  strictMcpConfig: true,
  tools: [],
  toolBridge: "mcp",
  sessionMode: "stateless",
  pool: "bare",
  // Security: --bare leaves Bash/Edit/Read enabled. Untrusted-input callers
  // (Honcho's response_format extraction processes raw user messages) could
  // prompt-inject the CLI into running shell commands or reading files.
  // Disallow all toolchain except the no-op default minimum.
  forceDisallowedTools: ["Bash", "Edit", "Read", "Write", "Grep", "Glob", "WebFetch", "WebSearch"],
  // runtime intentionally undefined: stream-json (the default) is verified to
  // work with --bare (tested 2026-05-14 on claude CLI 2.1.132). Stream-json
  // is pool-friendly (persistent subprocess across calls) — print-mode would
  // force one-shot spawn and defeat the init-pool.
  //
  // The upstream CLI reference does call --json-schema "print mode only", and
  // that used to be read here as a reason to prefer print. It is not: the
  // restriction is about the headless run, not about --output-format. Measured
  // on the pinned CLI 2.1.232 with this profile's exact spawn shape, the flag
  // works under the proxy's stream-json transport and the validated JSON
  // arrives in the result message, which is what cliResultToOpenai reads.
};

/**
 * Das Profil fuer den Hermes-Pfad (/v1/chat/completions).
 *
 * WARUM ES DAS GIBT, und warum es fast gleich aussieht: der Hersteller von
 * hermes-agent beschreibt sein Backend als "a plain model endpoint ...
 * stateless inference services, not autonomous agents themselves". Ein
 * Backend, das nebenbei CLAUDE.md liest, ein eigenes Gedaechtnis fuehrt,
 * Werkzeuge ausfuehren kann und Prozesse ueber Anfragen hinweg
 * wiederverwendet, ist genau das nicht. Deshalb faehrt der Lead-Pfad
 * dieselbe Haertung wie der isolierte.
 *
 * DER EINZIGE UNTERSCHIED ist `mapResponseFormat`. Nachgesehen am 2026-09-06:
 * hermes-agent sendet in eigenem Code nirgends ein `response_format` (alle
 * Treffer lagen im venv, also im OpenAI-SDK). Das Feld steht hier also auf
 * false, weil es nicht gebraucht wird — nicht, weil es schaden wuerde: ohne
 * `response_format` im Koerper ist die Abbildung wirkungslos
 * (responseFormatToJsonSchema gibt undefined zurueck).
 *
 * ZWEI PROFILE STATT EINEM war Chris' Entscheidung, ausdruecklich in Kenntnis
 * dessen, dass sie sich heute nur in diesem einen Feld unterscheiden. Der
 * Preis ist eine Pflicht: wer hier etwas aendert, muss jedes Mal pruefen, ob
 * es BEIDE betrifft. Der Test `profile-hardening` haelt genau das fest — er
 * verlangt die Haertung von jedem Profil, nicht von einem benannten.
 */
export const LEAD_PROFILE: Profile = {
  bare: true,
  disableSlashCommands: true,
  mapResponseFormat: false,
  isolateCwd: true,
  injectOAuthEnv: true,
  restricted: true,
  strictMcpConfig: true,
  tools: [],
  toolBridge: "mcp",
  sessionMode: "stateless",
  pool: "bare",
  // Redundant zu `tools: []`, und das mit Absicht. Zwei Gruende: die
  // Hilfe zu --restricted sagt "unless --tools names them", die Sperrliste
  // deckt also denselben Bereich von der anderen Seite ab; und sie bleibt
  // wirksam, falls ein Aufrufer eigene Werkzeugnamen mitschickt, die mit
  // eingebauten kollidieren (externalNativeToolDisallowList).
  forceDisallowedTools: ["Bash", "Edit", "Read", "Write", "Grep", "Glob", "WebFetch", "WebSearch"],
};

const PROFILES: Record<string, Profile> = {
  isolated: ISOLATED_PROFILE,
  lead: LEAD_PROFILE,
};

export function getProfile(name: string): Profile | undefined {
  return PROFILES[name];
}

export function listProfiles(): string[] {
  return Object.keys(PROFILES);
}
