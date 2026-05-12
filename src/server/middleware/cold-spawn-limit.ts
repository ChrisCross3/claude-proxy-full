/**
 * Per-caller cold-spawn rate limit (token bucket).
 *
 * Opt-in via:
 *   - CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN (default 0 = disabled)
 *   - CLAUDE_PROXY_COLD_SPAWN_BURST (default = LIMIT)
 *
 * Caller-key derivation order:
 *   1. sha256(authHeader).slice(0, 16) when Authorization is present
 *   2. first IP from X-Forwarded-For
 *   3. req.ip
 *   4. "anon"
 *
 * Buckets live in an in-memory Map with LRU cap (1000 entries). Refill is
 * lazy: each `consume()` first adds tokens proportional to elapsed time.
 *
 * The limit is consulted ONLY at cold-spawn paths in session pools. Warm
 * hits do not consume tokens.
 */

import type { Request } from "express";
import { createHash } from "crypto";

const LRU_CAP = 1000;

interface Bucket {
  tokens: number;
  lastRefill: number; // ms epoch
  lastTouched: number; // for LRU
}

interface Config {
  enabled: boolean;
  limitPerMin: number;
  burst: number;
}

function readConfig(): Config {
  const limit = parseInt(process.env.CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN || "0", 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { enabled: false, limitPerMin: 0, burst: 0 };
  }
  const burstRaw = parseInt(process.env.CLAUDE_PROXY_COLD_SPAWN_BURST || "", 10);
  const burst = Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : limit;
  return { enabled: true, limitPerMin: limit, burst };
}

let cachedConfig: Config | null = null;
function getConfig(): Config {
  if (!cachedConfig) cachedConfig = readConfig();
  return cachedConfig;
}

const buckets = new Map<string, Bucket>();

export const coldSpawnLimitCounters = {
  allowed: 0,
  rejected: 0,
};

// Injectable clock so tests can fake time without sleeping.
let clock: () => number = () => Date.now();
export function setColdSpawnClockForTests(fn: () => number): void {
  clock = fn;
}

/** Test hook: clear all state (buckets, counters, cached config). */
export function resetColdSpawnBuckets(): void {
  buckets.clear();
  coldSpawnLimitCounters.allowed = 0;
  coldSpawnLimitCounters.rejected = 0;
  cachedConfig = null;
  clock = () => Date.now();
}

/**
 * Extract a stable caller key from the request.
 *
 * Header precedence: Authorization (hashed prefix) > X-Forwarded-For (first IP)
 * > req.ip > "anon". The result is bounded (≤16 hex chars or IP-length).
 */
export function extractCallerKey(req: Request): string {
  const auth = req.headers?.authorization;
  if (typeof auth === "string" && auth.length > 0) {
    return "a:" + createHash("sha256").update(auth).digest("hex").slice(0, 16);
  }
  const xff = req.headers?.["x-forwarded-for"];
  let xffFirst: string | undefined;
  if (typeof xff === "string") xffFirst = xff.split(",")[0]?.trim();
  else if (Array.isArray(xff) && xff.length > 0) xffFirst = xff[0]?.split(",")[0]?.trim();
  if (xffFirst) return "x:" + xffFirst;

  const ip = (req as { ip?: string }).ip;
  if (ip) return "i:" + ip;
  return "anon";
}

function enforceLruCap(): void {
  if (buckets.size <= LRU_CAP) return;
  // Drop oldest entries until back at cap. Map iteration is insertion order;
  // we track lastTouched separately and scan when over cap (rare path).
  const sorted = [...buckets.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched);
  const toDrop = sorted.length - LRU_CAP;
  for (let i = 0; i < toDrop; i++) {
    buckets.delete(sorted[i][0]);
  }
}

export type ConsumeResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Consume one cold-spawn token for `callerKey`. When the limit is disabled,
 * always returns ok. Otherwise returns ok if a token was available, else
 * a rejection with the seconds the caller should wait before the next refill.
 */
export function consumeColdSpawnToken(callerKey: string): ConsumeResult {
  const cfg = getConfig();
  if (!cfg.enabled) {
    coldSpawnLimitCounters.allowed++;
    return { ok: true };
  }
  const now = clock();
  let bucket = buckets.get(callerKey);
  if (!bucket) {
    bucket = { tokens: cfg.burst, lastRefill: now, lastTouched: now };
    buckets.set(callerKey, bucket);
    enforceLruCap();
  }
  // Lazy refill: limitPerMin tokens spread evenly over 60s.
  const elapsedMs = Math.max(0, now - bucket.lastRefill);
  if (elapsedMs > 0) {
    const refill = (elapsedMs / 60000) * cfg.limitPerMin;
    if (refill > 0) {
      bucket.tokens = Math.min(cfg.burst, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
  }
  bucket.lastTouched = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    coldSpawnLimitCounters.allowed++;
    return { ok: true };
  }

  // No token: compute wait until next refill = (1 - tokens) / (limitPerMin/60) seconds.
  const ratePerSec = cfg.limitPerMin / 60;
  const needed = 1 - bucket.tokens;
  const retryAfterSec = Math.max(1, Math.ceil(needed / Math.max(ratePerSec, 1e-9)));
  coldSpawnLimitCounters.rejected++;
  return { ok: false, retryAfterSec };
}

/**
 * Typed error raised when a cold-spawn would exceed the per-caller rate
 * limit. Routes catch this and respond with HTTP 429 + Retry-After.
 */
export class ColdSpawnRateLimitedError extends Error {
  readonly code = "cold_spawn_rate_limited";
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("cold_spawn_rate_limited");
    this.retryAfterSec = retryAfterSec;
    this.name = "ColdSpawnRateLimitedError";
  }
}

export function isColdSpawnRateLimitedError(err: unknown): err is ColdSpawnRateLimitedError {
  return err instanceof ColdSpawnRateLimitedError
    || (err instanceof Error && (err as { code?: string }).code === "cold_spawn_rate_limited");
}
