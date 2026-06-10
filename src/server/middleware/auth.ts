/**
 * Optional Bearer-Token authentication middleware.
 *
 * Opt-in via:
 *   - CLAUDE_PROXY_API_KEY (single key), or
 *   - CLAUDE_PROXY_API_KEYS (comma-separated, for rotation).
 *
 * When neither is set, this middleware is a no-op — preserving the
 * default "no-auth" posture used by local clients/curl against the local proxy.
 *
 * When at least one key is configured, every request must carry a
 * matching `Authorization: Bearer <token>` header. Comparison is
 * length-independent timingSafeEqual to avoid timing oracles.
 *
 * Health / metrics / pricing endpoints are whitelisted so liveness probes
 * and Prometheus scrapes work without needing the secret.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "crypto";

const WHITELIST_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/healthz",
  "/healthz/deep",
  "/metrics",
  "/pricing",
  "/v1/pricing",
]);

export interface AuthCounters {
  /** Total requests rejected because their Bearer token did not match. */
  authDenials: number;
}

export const authCounters: AuthCounters = {
  authDenials: 0,
};

/** Last WARN watermark — we log once every 100 denials. */
let lastWarnedAt = 0;

function readKeys(): Buffer[] {
  const raw = (process.env.CLAUDE_PROXY_API_KEY ? [process.env.CLAUDE_PROXY_API_KEY] : [])
    .concat((process.env.CLAUDE_PROXY_API_KEYS || "").split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (raw.length === 0) return [];
  // Hash to a fixed width so timingSafeEqual is always defined-length.
  return raw.map((k) => createHash("sha256").update(k).digest());
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function matchesAnyKey(token: string, keys: Buffer[]): boolean {
  if (!token) return false;
  const candidate = hashToken(token);
  let matched = false;
  for (const k of keys) {
    // length is fixed (32 bytes, sha256) — timingSafeEqual is safe.
    if (k.length === candidate.length && timingSafeEqual(k, candidate)) {
      matched = true;
    }
  }
  return matched;
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error: {
      message: "unauthorized",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
}

function recordDenial(): void {
  authCounters.authDenials++;
  if (authCounters.authDenials - lastWarnedAt >= 100) {
    lastWarnedAt = authCounters.authDenials;
    console.warn(`[auth] ${authCounters.authDenials} bearer-token denials so far`);
  }
}

/**
 * Build the auth middleware. Reads env at construction time.
 */
export function authMiddleware(): RequestHandler {
  const keys = readKeys();
  const enabled = keys.length > 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) {
      next();
      return;
    }
    // Whitelist exact paths (no query, no trailing slash variants).
    const path = req.path;
    if (WHITELIST_PATHS.has(path)) {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header || typeof header !== "string") {
      recordDenial();
      unauthorized(res);
      return;
    }
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) {
      recordDenial();
      unauthorized(res);
      return;
    }
    const token = m[1].trim();
    if (!matchesAnyKey(token, keys)) {
      recordDenial();
      unauthorized(res);
      return;
    }
    next();
  };
}

/** Test hook: reset counters between cases. */
export function resetAuthCountersForTests(): void {
  authCounters.authDenials = 0;
  lastWarnedAt = 0;
}
