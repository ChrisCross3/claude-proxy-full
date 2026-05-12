/**
 * Print-mode subprocess acquisition.
 *
 * One cold spawn per request — `claude --print` reads its prompt from stdin
 * and exits, so there's nothing to keep warm here. Streaming/sticky callers
 * use `init-pool.ts` + `session-pool.ts` instead.
 *
 * The optional cold-spawn rate-limit (per caller key) is enforced before the
 * spawn; see `server/middleware/cold-spawn-limit.ts`.
 */

import { ClaudeSubprocess } from "./manager.js";
import type { SubprocessOptions } from "./manager.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { consumeColdSpawnToken, ColdSpawnRateLimitedError } from "../server/middleware/cold-spawn-limit.js";

export type AcquireOptions = Omit<SubprocessOptions, "model" | "sessionId" | "cwd" | "timeout"> & {
  /** Caller key for cold-spawn rate-limit accounting. */
  callerKey?: string;
};

export async function acquireSubprocess(
  model: ClaudeModel,
  options: AcquireOptions = {},
): Promise<ClaudeSubprocess> {
  if (options.callerKey) {
    const limit = consumeColdSpawnToken(options.callerKey);
    if (!limit.ok) throw new ColdSpawnRateLimitedError(limit.retryAfterSec);
  }
  const sub = new ClaudeSubprocess();
  await sub.prepare({ model, ...options });
  return sub;
}
