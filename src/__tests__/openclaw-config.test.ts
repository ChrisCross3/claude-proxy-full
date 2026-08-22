/**
 * Tests for openclaw.json file-mode hardening (M4) + async resolver (M2).
 *
 * POSIX-only: mode-bit checks are skipped on Windows where process.getuid
 * is undefined and NTFS ACLs don't map cleanly to chmod bits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOpenclawMcpServers,
  _clearCacheForTesting,
  _setResolverForTesting,
} from "../mcp/openclaw-config.js";

const isWindows = process.platform === "win32";

function writeConfig(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-"));
  const path = join(dir, "openclaw.json");
  writeFileSync(path, JSON.stringify({ mcp: { servers: { greet: { command: "echo", args: ["hi"] } } } }), { mode });
  chmodSync(path, mode);
  return path;
}

function writeConfigAt(dir: string, payload: unknown, mode = 0o600): string {
  const path = join(dir, "openclaw.json");
  writeFileSync(path, JSON.stringify(payload), { mode });
  if (!isWindows) chmodSync(path, mode);
  return path;
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const orig = console.error;
  let buf = "";
  console.error = (...args: unknown[]) => { buf += args.map(String).join(" ") + "\n"; };
  try { await fn(); } finally { console.error = orig; }
  return buf;
}

test("openclaw-config: strict mode rejects world-writable file", { skip: isWindows }, async () => {
  const path = writeConfig(0o666);
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "strict" }, async () => {
    _clearCacheForTesting();
    const stderr = await captureStderr(async () => {
      const servers = await loadOpenclawMcpServers();
      assert.equal(Object.keys(servers).length, 0, "strict must return empty map");
    });
    assert.match(stderr, /world-writable|group\/world-writable/);
    assert.match(stderr, /refusing to load/);
  });
});

test("openclaw-config: warn mode loads but logs warning for world-writable file", { skip: isWindows }, async () => {
  const path = writeConfig(0o666);
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "warn" }, async () => {
    _clearCacheForTesting();
    const stderr = await captureStderr(async () => {
      const servers = await loadOpenclawMcpServers();
      assert.equal(Object.keys(servers).length, 1, "warn must still load");
      assert.ok(servers.greet, "greet server must be present");
    });
    assert.match(stderr, /world-writable|group\/world-writable/);
  });
});

test("openclaw-config: 0o600 loads silently in both warn and strict modes", { skip: isWindows }, async () => {
  for (const mode of ["warn", "strict"] as const) {
    const path = writeConfig(0o600);
    await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: mode }, async () => {
      _clearCacheForTesting();
      const stderr = await captureStderr(async () => {
        const servers = await loadOpenclawMcpServers();
        assert.equal(Object.keys(servers).length, 1, `${mode} must load 0o600 file`);
      });
      assert.doesNotMatch(stderr, /world-writable|group\/world-writable/, `${mode}: no warning for 0o600`);
    });
  }
});

test("openclaw-config: off mode skips check entirely", { skip: isWindows }, async () => {
  const path = writeConfig(0o666);
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off" }, async () => {
    _clearCacheForTesting();
    const stderr = await captureStderr(async () => {
      const servers = await loadOpenclawMcpServers();
      assert.equal(Object.keys(servers).length, 1);
    });
    assert.doesNotMatch(stderr, /world-writable/);
  });
});

// ---------------------------------------------------------------------------
// M2: async resolver, cache TTL, in-flight dedup, timeout
// ---------------------------------------------------------------------------

test("openclaw-config: async smoke — mock resolver substitutes secret value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-async-"));
  const path = writeConfigAt(dir, {
    mcp: {
      servers: {
        n8n: {
          command: "n8n-mcp",
          env: {
            N8N_API_URL: "https://n8n.example/api",
            N8N_API_KEY: { source: "exec", provider: "keychain", id: "n8n/apiKey" },
          },
        },
      },
    },
    secrets: { providers: { keychain: { command: "irrelevant-stubbed-out" } } },
  });
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off" }, async () => {
    _clearCacheForTesting();
    _setResolverForTesting(async (_cmd, ids) => {
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = `resolved:${id}`;
      return out;
    });
    try {
      const servers = await loadOpenclawMcpServers();
      assert.equal(servers.n8n?.env.N8N_API_KEY, "resolved:n8n/apiKey");
      assert.equal(servers.n8n?.env.N8N_API_URL, "https://n8n.example/api");
    } finally {
      _setResolverForTesting(null);
    }
  });
});

test("openclaw-config: in-flight dedup — parallel loads share one resolver call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-dedup-"));
  const path = writeConfigAt(dir, {
    mcp: {
      servers: {
        n8n: {
          command: "n8n-mcp",
          env: { K: { source: "exec", provider: "keychain", id: "x" } },
        },
      },
    },
    secrets: { providers: { keychain: { command: "stub" } } },
  });
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off" }, async () => {
    _clearCacheForTesting();
    let calls = 0;
    _setResolverForTesting(async (_cmd, ids) => {
      calls++;
      // Yield to next microtask so other in-flight callers can observe.
      await new Promise((r) => setTimeout(r, 20));
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = "v";
      return out;
    });
    try {
      const [a, b, c] = await Promise.all([
        loadOpenclawMcpServers(),
        loadOpenclawMcpServers(),
        loadOpenclawMcpServers(),
      ]);
      assert.equal(calls, 1, "resolver must be invoked exactly once for concurrent loads");
      assert.equal(a, b, "same cached object reference");
      assert.equal(b, c, "same cached object reference");
    } finally {
      _setResolverForTesting(null);
    }
  });
});

test("openclaw-config: TTL expiration causes re-read; within TTL stays cached", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-ttl-"));
  const path = writeConfigAt(dir, { mcp: { servers: { a: { command: "echo" } } } });
  // The cache compares Date.now() against its load timestamp, so this test
  // owns the clock instead of racing it: node:test MockTimers with
  // apis:["Date"] freezes Date only — setTimeout stays real, nothing else in
  // this file is touched, and the test context restores Date when the test
  // ends. The previous version budgeted 50 ms of wall clock for the
  // "within TTL" window and 120 ms of sleep for the expiry, which blew up
  // under full-suite load ("within TTL the old cached map is returned").
  // A bigger budget would only move that failure to a slower machine;
  // stepping the clock removes the timing dependency altogether and lets us
  // pin the TTL boundary exactly (ttl-1 cached, ttl+1 re-read).
  const T0 = 1_000_000;
  const TTL_MS = 50;
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  await withEnv({
    CLAUDE_PROXY_OPENCLAW_CONFIG: path,
    CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off",
    CLAUDE_PROXY_OPENCLAW_RESOLVER_TTL_MS: String(TTL_MS),
  }, async () => {
    _clearCacheForTesting();
    const first = await loadOpenclawMcpServers();
    assert.ok(first.a, "first load returns server a");

    // Swap the file. A second load inside the TTL must still see 'a'.
    writeFileSync(path, JSON.stringify({ mcp: { servers: { b: { command: "echo" } } } }));
    t.mock.timers.setTime(T0 + TTL_MS - 1);
    const cachedHit = await loadOpenclawMcpServers();
    assert.ok(cachedHit.a, "within TTL the old cached map is returned");
    assert.ok(!cachedHit.b, "within TTL the new file is not yet seen");

    // Step past the TTL, load again — must now reflect the new file.
    t.mock.timers.setTime(T0 + TTL_MS + 1);
    const fresh = await loadOpenclawMcpServers();
    assert.ok(fresh.b, "after TTL expiry the new file is read");
    assert.ok(!fresh.a, "old server gone after re-read");
  });
});

test("openclaw-config: resolver timeout — real spawn path SIGKILLs hanging resolver within 5s", { skip: isWindows }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-timeout-"));
  const path = writeConfigAt(dir, {
    mcp: {
      servers: {
        n8n: {
          command: "n8n-mcp",
          env: { K: { source: "exec", provider: "keychain", id: "x" } },
        },
      },
    },
    // sleep 10 hangs longer than the 5s RESOLVER_TIMEOUT_MS — the spawn-
    // path timer must SIGKILL it and resolve to {} so the load completes.
    secrets: { providers: { keychain: { command: "sleep 10" } } },
  });
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off" }, async () => {
    _clearCacheForTesting();
    // Suppress noisy timeout log line.
    const orig = console.error;
    console.error = () => {};
    try {
      const t0 = Date.now();
      const servers = await loadOpenclawMcpServers();
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 6000, `timeout must trigger inside ~5s (took ${elapsed}ms)`);
      assert.ok(elapsed >= 4500, `should actually have waited for the timeout, not bailed early (took ${elapsed}ms)`);
      assert.equal(servers.n8n?.env.K, undefined, "unresolved secret must be dropped after timeout");
    } finally {
      console.error = orig;
    }
  });
});

test("openclaw-config: resolver timeout — hanging promise via test override also yields empty map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-timeout-stub-"));
  const path = writeConfigAt(dir, {
    mcp: {
      servers: {
        n8n: {
          command: "n8n-mcp",
          env: { K: { source: "exec", provider: "keychain", id: "x" } },
        },
      },
    },
    secrets: { providers: { keychain: { command: "stub" } } },
  });
  await withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off" }, async () => {
    _clearCacheForTesting();
    // Stub resolver that takes "too long"; we race it with a watchdog.
    _setResolverForTesting(() => new Promise(() => { /* never resolves */ }));
    try {
      const load = loadOpenclawMcpServers();
      const watchdog = new Promise<"watchdog">((r) => setTimeout(() => r("watchdog"), 500));
      const winner = await Promise.race([load.then(() => "load" as const), watchdog]);
      assert.equal(winner, "watchdog", "override hangs by design; watchdog must win — this proves the dedup-promise is the same one we await");
    } finally {
      _setResolverForTesting(null);
      _clearCacheForTesting();
    }
  });
});
