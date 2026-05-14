/**
 * Pre-initialized stream-json subprocess pool.
 *
 * Cold start of a stream-json subprocess takes ~5s: spawn (1s) + claude
 * session-init hooks (2-3s) + initialize control_request handshake (1s).
 * Clients (openclaw) often disconnect before that gap closes when the
 * conversation is "cold" — no warm session-pool entry to reuse.
 *
 * This pool keeps one already-initialized subprocess waiting per model.
 * acquirePreInit() pops the warm one, kicks off a background refill, and
 * returns a subprocess that's ready to receive submitTurn() immediately —
 * shaving ~5s off every conversation-cold turn.
 */

import { StreamJsonSubprocess } from "./stream-json-manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { hasCredentialsChangedSince, clearDefaultResolverCache } from "../auth/credentials-resolver.js";

const ENABLED = process.env.CLAUDE_PROXY_INIT_POOL !== "0"; // default on
const slots: Map<ClaudeModel, StreamJsonSubprocess> = new Map();
const refilling: Set<ClaudeModel> = new Set();

/**
 * Bare-mode pre-init pool (Welle 5 Phase 5A.5.1).
 *
 * Mirrors the default pool but pre-spawns subprocesses with the full isolated-
 * profile flags (--bare + isolateCwd + injectOAuthEnv) so Honcho-style calls
 * skip the ~5s cold-start. Separate Map prevents fingerprint crosstalk: a
 * bare-warmed slot must never get returned to a default-config caller.
 *
 * Auth note: --bare disables OAuth/keychain, so the spawn must carry
 * ANTHROPIC_API_KEY env. We read the OAuth access token from
 * ~/.claude/.credentials.json at spawn time (via credentials-resolver). If
 * the token rotates while a slot is warm, we discard the slot and refill on
 * next acquire (via hasCredentialsChangedSince).
 */
const BARE_ENABLED = process.env.CLAUDE_PROXY_BARE_POOL !== "0"; // default on
const BARE_SIZE = (() => {
  const raw = process.env.CLAUDE_PROXY_BARE_POOL_SIZE;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();
const bareSlots: Map<ClaudeModel, { sub: StreamJsonSubprocess; spawnedAt: number }> = new Map();
const bareRefilling: Set<ClaudeModel> = new Set();

export async function acquirePreInit(model: ClaudeModel): Promise<StreamJsonSubprocess> {
  if (!ENABLED) {
    const sub = new StreamJsonSubprocess();
    await sub.start({ model });
    return sub;
  }

  const cached = slots.get(model);
  slots.delete(model);

  let result: StreamJsonSubprocess;
  if (cached && cached.isHealthy()) {
    console.error(`[InitPool] Pre-init hit for ${model} (age ${cached.getAge()}ms)`);
    result = cached;
  } else {
    if (cached) {
      console.error(`[InitPool] Stale pre-init for ${model}, killing`);
      cached.kill();
    }
    console.error(`[InitPool] No pre-init for ${model}, spawning fresh`);
    result = new StreamJsonSubprocess();
    await result.start({ model });
  }

  // Refill in background — don't await, the request shouldn't wait for it.
  refillSlot(model).catch((err) => {
    console.error(`[InitPool] Refill failed for ${model}:`, err.message);
  });

  return result;
}

async function refillSlot(model: ClaudeModel): Promise<void> {
  if (refilling.has(model) || slots.has(model)) return;
  refilling.add(model);
  try {
    const sub = new StreamJsonSubprocess();
    await sub.start({ model });
    if (slots.has(model)) {
      sub.kill(); // raced
      return;
    }
    slots.set(model, sub);
    console.error(`[InitPool] Refilled pre-init for ${model}`);
  } finally {
    refilling.delete(model);
  }
}

/**
 * Eagerly fill the pool for the given models on startup so the very first
 * request of each model doesn't pay the cold cost.
 */
export function preWarm(models: ClaudeModel[]): void {
  if (!ENABLED) return;
  for (const m of models) {
    refillSlot(m).catch((err) => {
      console.error(`[InitPool] Pre-warm failed for ${m}:`, err.message);
    });
  }
}

export function drainInitPool(): void {
  for (const [m, s] of slots) {
    s.kill();
    console.error(`[InitPool] Drained ${m}`);
  }
  slots.clear();
  for (const [m, entry] of bareSlots) {
    entry.sub.kill();
    console.error(`[InitPool] Drained bare slot for ${m}`);
  }
  bareSlots.clear();
}

/**
 * Acquire a warm subprocess pre-spawned with the isolated-profile flags
 * (--bare + isolateCwd + injectOAuthEnv). Mirrors acquirePreInit() but uses
 * the separate bareSlots map so default-config and isolated-config callers
 * never share a slot.
 *
 * If the credentials file has rotated since the slot was spawned, the slot is
 * discarded and a fresh one is spawned. Background refill triggered after
 * every acquire.
 */
export async function acquireBareSlot(model: ClaudeModel): Promise<StreamJsonSubprocess> {
  if (!BARE_ENABLED || BARE_SIZE === 0) {
    const sub = new StreamJsonSubprocess();
    await sub.start({
      model,
      bare: true,
      disableSlashCommands: true,
      isolateCwd: true,
      injectOAuthEnv: true,
    });
    return sub;
  }

  const cached = bareSlots.get(model);
  bareSlots.delete(model);

  let result: StreamJsonSubprocess;
  if (cached && cached.sub.isHealthy() && !(await hasCredentialsChangedSince(cached.spawnedAt))) {
    console.error(`[InitPool] Bare-pre-init hit for ${model} (age ${cached.sub.getAge()}ms)`);
    result = cached.sub;
  } else {
    if (cached) {
      console.error(`[InitPool] Stale bare-pre-init for ${model}, killing`);
      cached.sub.kill();
      // If the credentials rotated, clear the resolver cache so the new spawn
      // picks up the fresh token on the first read.
      clearDefaultResolverCache();
    }
    console.error(`[InitPool] No bare-pre-init for ${model}, spawning fresh`);
    result = new StreamJsonSubprocess();
    await result.start({
      model,
      bare: true,
      disableSlashCommands: true,
      isolateCwd: true,
      injectOAuthEnv: true,
    });
  }

  refillBareSlot(model).catch((err) => {
    console.error(`[InitPool] Bare-refill failed for ${model}:`, err.message);
  });

  return result;
}

async function refillBareSlot(model: ClaudeModel): Promise<void> {
  if (!BARE_ENABLED || BARE_SIZE === 0) return;
  if (bareRefilling.has(model) || bareSlots.has(model)) return;
  bareRefilling.add(model);
  try {
    const sub = new StreamJsonSubprocess();
    await sub.start({
      model,
      bare: true,
      disableSlashCommands: true,
      isolateCwd: true,
      injectOAuthEnv: true,
    });
    if (bareSlots.has(model)) {
      sub.kill(); // raced
      return;
    }
    bareSlots.set(model, { sub, spawnedAt: Date.now() });
    console.error(`[InitPool] Refilled bare-pre-init for ${model}`);
  } finally {
    bareRefilling.delete(model);
  }
}

/**
 * Eagerly fill the bare pool on startup. Use this when the proxy is set up to
 * serve isolated-profile requests and you want zero-cold-start for the first
 * Honcho call.
 */
export function preWarmBare(models: ClaudeModel[]): void {
  if (!BARE_ENABLED || BARE_SIZE === 0) return;
  for (const m of models) {
    refillBareSlot(m).catch((err) => {
      console.error(`[InitPool] Bare-pre-warm failed for ${m}:`, err.message);
    });
  }
}

process.on("SIGTERM", drainInitPool);
process.on("SIGINT", drainInitPool);
