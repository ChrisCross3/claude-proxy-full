/**
 * Shared fingerprint primitives for subprocess pools.
 *
 * The session-pool and sticky-session-pool both need to hash request-shaping
 * options (agents, system prompts, modes) into stable keys that survive
 * insertion-order differences between semantically equal objects. Keeping a
 * single canonical stringifier here prevents the two pools from drifting
 * apart (which previously caused warm-vs-sticky hit-rate inconsistencies).
 *
 * Not re-exported from src/index.ts — purely internal to the subprocess
 * module group.
 */

/**
 * Deterministic JSON.stringify with object keys sorted at every level.
 * Used so semantically-equal records (same keys, different insertion order)
 * hash identically. Mirrors JSON.stringify semantics for primitives /
 * arrays; canonicalizes `undefined` to "null" so a missing value cannot
 * masquerade as a different fingerprint than an explicit null.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
