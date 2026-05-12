/**
 * Configure Express `trust proxy` from CLAUDE_PROXY_TRUST_PROXY.
 *
 * Default (unset/empty): `false` — do not trust X-Forwarded-For.
 *
 * Supported values:
 *   - unset / ""                  → false (no trust)
 *   - "loopback" / "linklocal"
 *   - "uniquelocal"               → pass-through to Express
 *   - numeric string ("1", "2")   → hop-count (Number conversion)
 *   - comma list / CIDR list      → pass-through (Express parses)
 *   - anything else               → throws at boot
 *
 * Rationale: Without trust, downstream client-IP extraction must NOT honor
 * X-Forwarded-For (clients can spoof). With a reverse-proxy explicitly
 * configured, Express knows which hops to peel.
 */
import type { Express } from "express";

const NAMED_VALUES = new Set(["loopback", "linklocal", "uniquelocal"]);

export function configureTrustProxy(app: Express): void {
  const raw = process.env.CLAUDE_PROXY_TRUST_PROXY;
  if (raw === undefined || raw.trim() === "") {
    app.set("trust proxy", false);
    return;
  }
  const value = raw.trim();

  // Numeric hop count.
  if (/^\d+$/.test(value)) {
    app.set("trust proxy", Number(value));
    return;
  }

  // Single named value.
  if (NAMED_VALUES.has(value.toLowerCase())) {
    app.set("trust proxy", value.toLowerCase());
    return;
  }

  // Comma-separated list (named values, IPs, or CIDRs) — Express parses.
  if (value.includes(",") || value.includes("/") || value.includes(".") || value.includes(":")) {
    app.set("trust proxy", value);
    return;
  }

  throw new Error(
    `CLAUDE_PROXY_TRUST_PROXY: invalid value ${JSON.stringify(raw)}. ` +
      `Expected unset, "loopback"/"linklocal"/"uniquelocal", numeric hop count, or comma/CIDR list.`,
  );
}
