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
   * Inject Anthropic OAuth token as ANTHROPIC_API_KEY env var. Required when
   * bare=true, because --bare disables CLI's OAuth/keychain reads.
   */
  injectOAuthEnv: boolean;
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

const PROFILES: Record<string, Profile> = {
  isolated: ISOLATED_PROFILE,
};

export function getProfile(name: string): Profile | undefined {
  return PROFILES[name];
}

export function listProfiles(): string[] {
  return Object.keys(PROFILES);
}
