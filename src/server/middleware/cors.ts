/**
 * CORS middleware with an explicit origin whitelist.
 *
 * Behavior (all opt-in):
 *   - Env CLAUDE_PROXY_ALLOWED_ORIGINS — comma-separated origin list.
 *     - Special token "loopback" matches http://localhost:* and http://127.0.0.1:*.
 *     - Single value "*" is only honored when CLAUDE_PROXY_API_KEY (or _KEYS)
 *       is set; otherwise we emit a startup warning and treat the whitelist
 *       as empty.
 *   - Default (env unset): no CORS headers are added. Server-to-server
 *     clients without an Origin header (Hermes/curl) are unaffected.
 *   - When an Origin header is present and matches the whitelist, we set
 *     Access-Control-Allow-Origin to the exact request origin (no `*`
 *     unless explicitly opted in and authenticated) plus the usual
 *     Methods/Headers values.
 *   - OPTIONS preflight: 204 when the origin matches, 403 otherwise.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

interface CorsConfig {
  /** Empty array = whitelist not configured (no CORS headers). */
  origins: string[];
  loopback: boolean;
  wildcard: boolean;
}

function readConfig(): CorsConfig {
  const raw = process.env.CLAUDE_PROXY_ALLOWED_ORIGINS;
  if (!raw || raw.trim().length === 0) {
    return { origins: [], loopback: false, wildcard: false };
  }
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let loopback = false;
  let wildcard = false;
  const origins: string[] = [];
  for (const e of entries) {
    if (e === "loopback") loopback = true;
    else if (e === "*") wildcard = true;
    else origins.push(e);
  }

  if (wildcard) {
    const authConfigured = !!(process.env.CLAUDE_PROXY_API_KEY || process.env.CLAUDE_PROXY_API_KEYS);
    if (!authConfigured) {
      console.warn("[cors] CLAUDE_PROXY_ALLOWED_ORIGINS='*' ignored — requires CLAUDE_PROXY_API_KEY (or _KEYS) to be set. Whitelist is now empty.");
      return { origins: [], loopback: false, wildcard: false };
    }
    // Wildcard accepted; other explicit entries become irrelevant.
    return { origins: [], loopback: false, wildcard: true };
  }
  return { origins, loopback, wildcard: false };
}

const LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function matchesWhitelist(origin: string, cfg: CorsConfig): boolean {
  if (cfg.wildcard) return true;
  if (cfg.loopback && LOOPBACK_RE.test(origin)) return true;
  return cfg.origins.includes(origin);
}

/**
 * Build the CORS middleware. Reads env at construction time so test code
 * can mutate process.env then re-instantiate.
 */
export function corsMiddleware(): RequestHandler {
  const cfg = readConfig();

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";

    // No Origin header = server-to-server caller; do not emit CORS headers.
    if (!origin) {
      if (req.method === "OPTIONS") {
        // Preflight without origin is unusual; treat as no-CORS pass-through.
        res.sendStatus(204);
        return;
      }
      next();
      return;
    }

    const allowed = matchesWhitelist(origin, cfg);

    if (req.method === "OPTIONS") {
      if (!allowed) {
        res.sendStatus(403);
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", cfg.wildcard ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.sendStatus(204);
      return;
    }

    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", cfg.wildcard ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    next();
  };
}
