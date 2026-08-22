/**
 * n8n progress cache tests (Welle 4 Gruppe A — Mi4).
 *
 * Verifies that:
 *   - a positive snapshot stays cached for ~3s (CACHE_TTL_MS),
 *   - a null result (no running execution) is only cached for ~1s
 *     (NEG_CACHE_TTL_MS) so a workflow that just started becomes
 *     visible within one keepalive cycle.
 *
 * Repo convention: node:test + mock.timers (no vitest). Env vars are set
 * before import because `ENABLED` is captured at module-load.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CLAUDE_PROXY_N8N_API_URL = "http://n8n.test";
process.env.CLAUDE_PROXY_N8N_API_KEY = "k";

const { getRunningExecution, __resetN8nProgressCacheForTests } = await import(
  "../n8n/progress.js"
);

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn | undefined = globalThis.fetch;

interface FetchCallLog { count: number }

function installFetch(
  body: { data?: Array<{ id: string; workflowId: string; startedAt?: string; workflowData?: { name?: string } }> },
): FetchCallLog {
  const log: FetchCallLog = { count: 0 };
  globalThis.fetch = (async () => {
    log.count++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchFn;
  return log;
}

function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  else delete (globalThis as { fetch?: FetchFn }).fetch;
}

test("n8n progress: positive snapshot is cached for ~3s", async (t) => {
  __resetN8nProgressCacheForTests();
  t.mock.timers.enable({ apis: ["Date"] });
  const log = installFetch({
    data: [{
      id: "exec-1",
      workflowId: "wf-1",
      startedAt: new Date().toISOString(),
      workflowData: { name: "demo" },
    }],
  });
  t.after(() => { restoreFetch(); __resetN8nProgressCacheForTests(); });

  const first = await getRunningExecution();
  assert.ok(first, "first call must return a snapshot");
  assert.equal(log.count, 1);

  // Halfway through the positive TTL — must hit the cache.
  t.mock.timers.tick(1500);
  const mid = await getRunningExecution();
  assert.ok(mid);
  assert.equal(log.count, 1, "still cached at 1.5s");

  // Just past CACHE_TTL_MS — cache expires, fetch runs again.
  t.mock.timers.tick(1600);
  const after = await getRunningExecution();
  assert.ok(after);
  assert.equal(log.count, 2, "refetched after 3s");
});

test("n8n progress: null result expires after ~1s (NEG_CACHE_TTL_MS)", async (t) => {
  __resetN8nProgressCacheForTests();
  // getRunningExecution compares Date.now() against the cache timestamp, so
  // this test owns the clock rather than sampling it. Same seam and same
  // recipe as openclaw-config.test.ts: apis:["Date"] freezes Date only, the
  // real setTimeout inside the fetch path stays untouched, and the test
  // context restores Date when the test ends (so the sibling test above may
  // enable it again — t.mock, unlike the module-level mock, is not shared,
  // and a second enable() on the same instance would throw ERR_INVALID_STATE).
  // Stepping to an absolute time instead of ticking a delta pins the boundary
  // exactly: ttl-1 still cached, ttl+1 refetched.
  const T0 = 1_000_000;
  const NEG_TTL_MS = 1000;
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  // Empty data array → snapshot is null and gets negative-cached.
  const log = installFetch({ data: [] });
  t.after(() => { restoreFetch(); __resetN8nProgressCacheForTests(); });

  const first = await getRunningExecution();
  assert.equal(first, null);
  assert.equal(log.count, 1);

  // One millisecond short of NEG_CACHE_TTL_MS — still cached, no new fetch.
  t.mock.timers.setTime(T0 + NEG_TTL_MS - 1);
  const mid = await getRunningExecution();
  assert.equal(mid, null);
  assert.equal(log.count, 1, "negative cache still holds at ttl-1");

  // One millisecond past NEG_CACHE_TTL_MS — must refetch even though the
  // positive TTL (3s) is nowhere near elapsed. That gap is the whole point of
  // the negative TTL, and it is what this assertion pins down.
  t.mock.timers.setTime(T0 + NEG_TTL_MS + 1);
  const after = await getRunningExecution();
  assert.equal(after, null);
  assert.equal(log.count, 2, "negative cache must be gone at ttl+1");
});
