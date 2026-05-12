/**
 * Conversation Session Pool for stream-json mode
 *
 * Maps `(model, hash(prior conversation prefix))` → live `StreamJsonSubprocess`.
 * On a hit, we just send the new last user message and the in-process claude
 * picks up where it left off — turn 2 reads turn 1's prefix from Anthropic's
 * prompt cache.
 *
 * On a miss, we kill orphan subprocesses for stale keys and either:
 *   - send the entire conversation as a single flattened user message (cold)
 *   - or replay each prior turn (not implemented; would re-bill assistant turns)
 *
 * After a successful turn, we re-key the subprocess under
 * `hash(messages-after-this-turn)` so the next request finds it.
 *
 * Lifecycle:
 *   - Idle subprocesses are evicted after IDLE_TTL_MS (under Anthropic's 5min
 *     prompt-cache TTL — keeping them longer wastes resources without a
 *     cache benefit).
 *   - Max MAX_SESSIONS concurrent live subprocesses; LRU evict.
 *   - On crash/exit, the subprocess is removed from the map automatically.
 */

import { createHash } from "crypto";
import { StreamJsonSubprocess } from "./stream-json-manager.js";
import type { ClaudeEffort } from "../models/registry.js";
import type { ClaudePermissionMode } from "../adapter/openai-to-cli.js";
import { acquirePreInit } from "./init-pool.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import type { OpenAIChatMessage, OpenAIMessageContent } from "../types/openai.js";
import { consumeColdSpawnToken, ColdSpawnRateLimitedError } from "../server/middleware/cold-spawn-limit.js";

// Pool TTL is the longer of CLAUDE_PROXY_POOL_TTL_MS (default 600_000 = 10
// min, per the operator's preference) and our internal floor of 6 min (~1 min
// past Anthropic's 5-min prompt-cache TTL — anything tighter risks evicting
// mid-cache-window from clock skew). The 10-min default stretches over
// natural pause windows in chat without holding dead processes through
// cache-miss-anyway gaps.
const FLOOR_TTL_MS = 6 * 60 * 1000;
const IDLE_TTL_MS = Math.max(
  FLOOR_TTL_MS,
  parseInt(process.env.CLAUDE_PROXY_POOL_TTL_MS || "600000", 10) || 600_000,
);
// Cap concurrent live workers. Operator override via CLAUDE_PROXY_POOL_MAX.
// When the cap is hit, new conversations cold-spawn instead of joining the
// pool — overflow is graceful, not a failure.
const MAX_SESSIONS = (() => {
  const raw = parseInt(process.env.CLAUDE_PROXY_POOL_MAX || "4", 10);
  return raw > 0 ? raw : 4;
})();

interface Slot {
  subprocess: StreamJsonSubprocess;
  key: string;
  lastUsedAt: number;
  // Fingerprint snapshot taken at insertion time. We compare against this
  // when checking out a worker; drift (model rename, env change between
  // request and re-use) routes the request to a cold spawn instead of
  // reusing a worker whose init context no longer matches.
  fingerprint: SlotFingerprint;
}

interface SlotFingerprint {
  model: ClaudeModel;
  disallowedToolsKey: string;
  /** Effort level as a fingerprint key; empty string when no effort was requested. */
  effortKey: string;
  /** Thinking toggle as a fingerprint key; empty string when no thinking override was set. */
  thinkingKey: string;
  /** Permission mode as a fingerprint key; empty string when no override. */
  permissionModeKey: string;
  /** SHA-256 hex prefix of (systemPrompt + 0x1F + appendSystemPrompt); empty when both unset. */
  systemPromptKey: string;
  /** SHA-256 hex prefix of (agent + 0x1F + JSON.stringify(agents)); empty when both unset. */
  agentsKey: string;
  /** Combined key for --bare and --disable-slash-commands; e.g. "b1s0" / "b0s1" / "b1s1" / "" when none. */
  modesKey: string;
}

interface AcquireOptions {
  disallowedTools?: string[];
  /** Per-request effort. Becomes part of the pool fingerprint so warm hits never silently downgrade. */
  effort?: ClaudeEffort;
  /** Per-request thinking toggle. Becomes part of the pool fingerprint. */
  thinking?: boolean;
  /** Verbose-logging category filter; not part of the fingerprint (diagnostic only). */
  debug?: string;
  /** Hard USD cap; not part of the fingerprint (per-call enforcement, no init-state). */
  maxBudgetUsd?: number;
  /** Permission mode; part of the fingerprint (changes claude init-state). */
  permissionMode?: ClaudePermissionMode;
  /** Replacement system prompt; part of the fingerprint (changes init context). */
  systemPrompt?: string;
  /** Appended system prompt; part of the fingerprint. */
  appendSystemPrompt?: string;
  /** Single named subagent; part of the fingerprint. */
  agent?: string;
  /** Ad-hoc subagent definitions; part of the fingerprint. */
  agents?: Record<string, unknown>;
  /** Minimal-mode; part of the fingerprint (changes init dramatically). */
  bare?: boolean;
  /** Disable slash commands; part of the fingerprint (changes subprocess behavior). */
  disableSlashCommands?: boolean;
  /** JSON Schema; not part of the fingerprint (per-call output constraint). */
  jsonSchema?: Record<string, unknown>;
  /** Max turns cap; not part of the fingerprint (per-call enforcement). */
  maxTurns?: number;
  /** Caller key for cold-spawn rate-limit accounting. Optional; warm hits never consume. */
  callerKey?: string;
}

function disallowedToolsKey(disallowedTools: string[] = []): string {
  return [...disallowedTools].sort().join(",");
}

function effortKey(effort?: ClaudeEffort): string {
  return effort ?? "";
}

function thinkingKey(thinking?: boolean): string {
  if (thinking === undefined) return "";
  return thinking ? "on" : "off";
}

function permissionModeKey(mode?: ClaudePermissionMode): string {
  return mode ?? "";
}

function systemPromptKey(systemPrompt?: string, appendSystemPrompt?: string): string {
  if (!systemPrompt && !appendSystemPrompt) return "";
  const h = createHash("sha256");
  h.update(systemPrompt ?? "");
  h.update("\x1f"); // ASCII unit separator — disambiguates ("a", "b") from ("ab", "")
  h.update(appendSystemPrompt ?? "");
  return h.digest("hex").slice(0, 16);
}

/**
 * Deterministic JSON.stringify with object keys sorted at every level.
 * Used so semantically-equal `agents` records (same keys, different insertion
 * order) hash identically. Exported for unit-test visibility.
 */
export function stableStringify(value: unknown): string {
  // JSON.stringify(undefined) returns the string "undefined" (not valid JSON);
  // canonicalize to "null" so undefined values can participate in deterministic
  // fingerprints without producing literal "undefined" tokens in the output.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function agentsKey(agent?: string, agents?: Record<string, unknown>): string {
  if (!agent && !agents) return "";
  const h = createHash("sha256");
  h.update(agent ?? "");
  h.update("\x1f");
  h.update(agents ? stableStringify(agents) : "");
  return h.digest("hex").slice(0, 16);
}

function modesKey(bare?: boolean, disableSlashCommands?: boolean): string {
  if (!bare && !disableSlashCommands) return "";
  return `b${bare ? 1 : 0}s${disableSlashCommands ? 1 : 0}`;
}

// Bounded counters for /metrics. Module-scoped; the metrics endpoint reads
// them. Keep cardinality fixed (no per-request labels here).
export const poolCounters = {
  ttlEvictions: 0,
  lruEvictions: 0,
  fingerprintMismatches: 0,
  warmHits: 0,
  coldSpawns: 0,
};

const slots: Map<string, Slot> = new Map();

export interface AcquireResult {
  subprocess: StreamJsonSubprocess;
  isWarm: boolean; // true => prior history already in subprocess; just send last user msg
  flattenedPrompt: string | null; // for cold path: send this as the single user message
  lastUserText: string; // for warm path: send only this
  postTurnKey: string; // re-key under this after the turn finishes
}

/**
 * Find a live subprocess matching this conversation's prior turns, or create
 * a new one if none. Returns instructions for the caller on what to send.
 */
export async function acquireSession(
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  evictExpired();

  if (messages.length === 0) throw new Error("messages required");
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== "user") {
    // Last message must be user; if not, fall back to flattening everything.
    return cold(model, messages, undefined, options);
  }

  const lastUserText = extractText(lastMsg.content);
  const disallowedKey = disallowedToolsKey(options.disallowedTools);
  const effortStr = effortKey(options.effort);
  const thinkingStr = thinkingKey(options.thinking);
  const permModeStr = permissionModeKey(options.permissionMode);
  const sysPromptStr = systemPromptKey(options.systemPrompt, options.appendSystemPrompt);
  const agentsStr = agentsKey(options.agent, options.agents);
  const modesStr = modesKey(options.bare, options.disableSlashCommands);
  const priorKey = hashConversation(model, messages.slice(0, -1), disallowedKey, effortStr, thinkingStr, permModeStr, sysPromptStr, agentsStr, modesStr);
  const postTurnKey = hashConversation(model, messages, disallowedKey, effortStr, thinkingStr, permModeStr, sysPromptStr, agentsStr, modesStr); // before assistant response — see note below

  const slot = slots.get(priorKey);
  if (slot) {
    // Healthy + fingerprint match → warm hit. Anything else → fall back cold.
    const fingerprintOk = slot.fingerprint.model === model
      && slot.fingerprint.disallowedToolsKey === disallowedKey
      && slot.fingerprint.effortKey === effortStr
      && slot.fingerprint.thinkingKey === thinkingStr
      && slot.fingerprint.permissionModeKey === permModeStr
      && slot.fingerprint.systemPromptKey === sysPromptStr
      && slot.fingerprint.agentsKey === agentsStr
      && slot.fingerprint.modesKey === modesStr
      && slot.subprocess.getModel() === model;
    if (slot.subprocess.isHealthy() && fingerprintOk) {
      console.error(`[SessionPool] WARM HIT model=${model} key=${priorKey.slice(0, 8)}`);
      poolCounters.warmHits++;
      slots.delete(priorKey);
      return {
        subprocess: slot.subprocess,
        isWarm: true,
        flattenedPrompt: null,
        lastUserText,
        postTurnKey,
      };
    }
    if (!fingerprintOk) {
      console.error(`[SessionPool] FINGERPRINT MISMATCH key=${priorKey.slice(0, 8)} stored.model=${slot.fingerprint.model} requested.model=${model} — routing to cold`);
      poolCounters.fingerprintMismatches++;
    } else {
      console.error(`[SessionPool] Stale slot for ${priorKey.slice(0, 8)}, killing`);
    }
    slot.subprocess.kill();
    slots.delete(priorKey);
  }

  if (options.callerKey) {
    const limit = consumeColdSpawnToken(options.callerKey);
    if (!limit.ok) throw new ColdSpawnRateLimitedError(limit.retryAfterSec);
  }
  poolCounters.coldSpawns++;
  return cold(model, messages, postTurnKey, options);
}

async function cold(
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  postTurnKey?: string,
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  console.error(`[SessionPool] COLD model=${model} (will use init-pool)`);
  // Pull from the init-pool when the process can use the default Claude tool
  // policy and no per-request effort override is set. Both disallowedTools and
  // effort must be baked into the spawn args, so those requests get a dedicated
  // process rather than a pre-initialized generic one.
  const needsDedicated = (options.disallowedTools && options.disallowedTools.length > 0)
    || !!options.effort
    || options.thinking !== undefined
    || !!options.debug
    || options.maxBudgetUsd !== undefined
    || !!options.permissionMode
    || !!options.systemPrompt
    || !!options.appendSystemPrompt
    || !!options.agent
    || !!options.agents
    || !!options.bare
    || !!options.disableSlashCommands
    || !!options.jsonSchema
    || options.maxTurns !== undefined;
  const sub = needsDedicated
    ? await createDedicatedProcess(model, options.disallowedTools ?? [], options.effort, options.thinking, options.debug, options.maxBudgetUsd, options.permissionMode, options.systemPrompt, options.appendSystemPrompt, options.agent, options.agents, options.bare, options.disableSlashCommands, options.jsonSchema, options.maxTurns)
    : await acquirePreInit(model);

  return {
    subprocess: sub,
    isWarm: false,
    flattenedPrompt: messagesToFlatPrompt(messages),
    lastUserText: extractText(messages[messages.length - 1].content),
    postTurnKey: postTurnKey ?? hashConversation(model, messages, disallowedToolsKey(options.disallowedTools), effortKey(options.effort), thinkingKey(options.thinking), permissionModeKey(options.permissionMode), systemPromptKey(options.systemPrompt, options.appendSystemPrompt), agentsKey(options.agent, options.agents), modesKey(options.bare, options.disableSlashCommands)),
  };
}

async function createDedicatedProcess(model: ClaudeModel, disallowedTools: string[], effort?: ClaudeEffort, thinking?: boolean, debug?: string, maxBudgetUsd?: number, permissionMode?: ClaudePermissionMode, systemPrompt?: string, appendSystemPrompt?: string, agent?: string, agents?: Record<string, unknown>, bare?: boolean, disableSlashCommands?: boolean, jsonSchema?: Record<string, unknown>, maxTurns?: number): Promise<StreamJsonSubprocess> {
  const sub = new StreamJsonSubprocess();
  await sub.start({ model, disallowedTools, effort, thinking, debug, maxBudgetUsd, permissionMode, systemPrompt, appendSystemPrompt, agent, agents, bare, disableSlashCommands, jsonSchema, maxTurns });
  return sub;
}

/**
 * Re-key the subprocess after a successful turn so the next request can find it.
 * The caller passes the actual assistant content so we can hash the post-turn
 * conversation accurately.
 */
export function returnSession(
  subprocess: StreamJsonSubprocess,
  model: ClaudeModel,
  messages: OpenAIChatMessage[],
  assistantContent: string,
  options: AcquireOptions = {},
): void {
  evictLRU();

  if (!subprocess.isHealthy()) {
    console.error(`[SessionPool] Not returning unhealthy subprocess`);
    subprocess.kill();
    return;
  }

  const fullMessages: OpenAIChatMessage[] = [
    ...messages,
    { role: "assistant", content: assistantContent },
  ];
  const disallowedKey = disallowedToolsKey(options.disallowedTools);
  const effortStr = effortKey(options.effort);
  const thinkingStr = thinkingKey(options.thinking);
  const permModeStr = permissionModeKey(options.permissionMode);
  const sysPromptStr = systemPromptKey(options.systemPrompt, options.appendSystemPrompt);
  const agentsStr = agentsKey(options.agent, options.agents);
  const modesStr = modesKey(options.bare, options.disableSlashCommands);
  const postKey = hashConversation(model, fullMessages, disallowedKey, effortStr, thinkingStr, permModeStr, sysPromptStr, agentsStr, modesStr);
  slots.set(postKey, {
    subprocess,
    key: postKey,
    lastUsedAt: Date.now(),
    fingerprint: { model, disallowedToolsKey: disallowedKey, effortKey: effortStr, thinkingKey: thinkingStr, permissionModeKey: permModeStr, systemPromptKey: sysPromptStr, agentsKey: agentsStr, modesKey: modesStr },
  });
  console.error(`[SessionPool] Returned subprocess under key ${postKey.slice(0, 8)} (size=${slots.size}/${MAX_SESSIONS})`);
}

/** Snapshot the pool state for /metrics and /healthz/deep. */
export function poolStats(): { size: number; max: number; ttlMs: number } {
  return { size: slots.size, max: MAX_SESSIONS, ttlMs: IDLE_TTL_MS };
}

/** Discard a subprocess (e.g., after error) without re-pooling. */
export function discardSession(subprocess: StreamJsonSubprocess): void {
  subprocess.endInput();
  subprocess.kill();
}

function evictExpired(): void {
  const now = Date.now();
  for (const [k, s] of slots) {
    if (now - s.lastUsedAt > IDLE_TTL_MS || !s.subprocess.isHealthy()) {
      console.error(`[SessionPool] TTL evict ${k.slice(0, 8)} (age=${now - s.lastUsedAt}ms, ttl=${IDLE_TTL_MS}ms)`);
      poolCounters.ttlEvictions++;
      s.subprocess.kill();
      slots.delete(k);
    }
  }
}

function evictLRU(): void {
  while (slots.size >= MAX_SESSIONS) {
    let oldest: { key: string; t: number } | null = null;
    for (const [k, s] of slots) {
      if (!oldest || s.lastUsedAt < oldest.t) oldest = { key: k, t: s.lastUsedAt };
    }
    if (!oldest) return;
    console.error(`[SessionPool] LRU evict ${oldest.key.slice(0, 8)} (cap=${MAX_SESSIONS})`);
    poolCounters.lruEvictions++;
    slots.get(oldest.key)?.subprocess.kill();
    slots.delete(oldest.key);
  }
}

function hashConversation(model: ClaudeModel, messages: OpenAIChatMessage[], disallowedKey: string = "", effortLevel: string = "", thinkingLevel: string = "", permissionModeLevel: string = "", systemPromptLevel: string = "", agentsLevel: string = "", modesLevel: string = ""): string {
  // Ignore assistant content: the live subprocess already remembers what *it*
  // said. The incoming OpenAI history may differ in whitespace/punctuation
  // (e.g. trailing period stripped by clients) and we don't want that to bust
  // the cache key. Role presence still matters so we hash that.
  const h = createHash("sha256");
  h.update(model);
  h.update("\0tools\0");
  h.update(disallowedKey);
  h.update("\0effort\0");
  h.update(effortLevel);
  h.update("\0thinking\0");
  h.update(thinkingLevel);
  h.update("\0permmode\0");
  h.update(permissionModeLevel);
  h.update("\0sysprompt\0");
  h.update(systemPromptLevel);
  h.update("\0agents\0");
  h.update(agentsLevel);
  h.update("\0modes\0");
  h.update(modesLevel);
  for (const m of messages) {
    h.update("\0");
    h.update(m.role);
    h.update("\0");
    if (m.role === "assistant") continue;
    h.update(extractText(m.content));
  }
  return h.digest("hex");
}

function extractText(content: OpenAIMessageContent): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .filter((p): p is typeof p & { text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return String(content);
}

/**
 * Render the entire OpenAI messages array as a single user-message string.
 * Used for the cold path where we have no live subprocess to feed turn-by-turn.
 * Mirrors the existing messagesToPrompt approach in adapter/openai-to-cli.ts.
 */
function messagesToFlatPrompt(messages: OpenAIChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = extractText(m.content);
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") {
      parts.push(`<system>\n${text}\n</system>\n`);
    } else if (m.role === "user") {
      parts.push(text);
    } else if (m.role === "assistant") {
      parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
    }
  }
  return parts.join("\n").trim();
}

export function poolSize(): number {
  return slots.size;
}

export function drainPool(): void {
  for (const [k, s] of slots) {
    s.subprocess.kill();
    console.error(`[SessionPool] Drained ${k.slice(0, 8)}`);
  }
  slots.clear();
}

process.on("SIGTERM", drainPool);
process.on("SIGINT", drainPool);
