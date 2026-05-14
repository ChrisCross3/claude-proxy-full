/**
 * Server-side profiles for predefined call patterns (Welle 5 Phase 5A.5.1).
 *
 * A profile bundles a set of defaults that get applied to a request BEFORE
 * adapter conversion (openaiToCli) and BEFORE pool routing (acquire*). The
 * "isolated" profile, used by the `/v1/isolated/chat/completions` route, sets
 * up Honcho-style isolated LLM calls: claude `--bare` to skip workspace
 * discovery + auto-memory + CLAUDE.md, OAuth-token injection via env so
 * `--bare` doesn't break Anthropic auth, and OpenAI `response_format:
 * json_schema` mapping to a forced-JSON system prompt.
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
   * Convert OpenAI `response_format: json_schema` to a forced-JSON system
   * prompt via responseFormatToSystemPrompt(). Overrides user-supplied
   * `system_prompt`.
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
   * Pool routing strategy.
   *   "bare":    use the bare-init-pool (warmed `claude --bare` subprocesses)
   *   "default": use the default pre-init-pool
   *   "none":    cold-spawn every request (debugging only)
   */
  pool: "bare" | "default" | "none";
  /**
   * Override runtime mode. The isolated profile prefers "print" because
   * `--json-schema` is print-mode-only per Anthropic docs. Even though we
   * map response_format to a system prompt (not --json-schema), print mode
   * is the conservative choice for one-shot extraction calls.
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
  // runtime intentionally undefined: stream-json (the default) is verified to
  // work with --bare (tested 2026-05-14 on claude CLI 2.1.132). Stream-json
  // is pool-friendly (persistent subprocess across calls) — print-mode would
  // force one-shot spawn and defeat the bare-init-pool.
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
