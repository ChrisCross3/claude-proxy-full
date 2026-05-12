/**
 * Tests for openclaw.json file-mode hardening (M4).
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
} from "../mcp/openclaw-config.js";

const isWindows = process.platform === "win32";

function writeConfig(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-proxy-openclaw-"));
  const path = join(dir, "openclaw.json");
  writeFileSync(path, JSON.stringify({ mcp: { servers: { greet: { command: "echo", args: ["hi"] } } } }), { mode });
  chmodSync(path, mode);
  return path;
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function captureStderr(fn: () => void): string {
  const orig = console.error;
  let buf = "";
  console.error = (...args: unknown[]) => { buf += args.map(String).join(" ") + "\n"; };
  try { fn(); } finally { console.error = orig; }
  return buf;
}

test("openclaw-config: strict mode rejects world-writable file", { skip: isWindows }, () => {
  const path = writeConfig(0o666);
  withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "strict" }, () => {
    _clearCacheForTesting();
    const stderr = captureStderr(() => {
      const servers = loadOpenclawMcpServers();
      assert.equal(Object.keys(servers).length, 0, "strict must return empty map");
    });
    assert.match(stderr, /world-writable|group\/world-writable/);
    assert.match(stderr, /refusing to load/);
  });
});

test("openclaw-config: warn mode loads but logs warning for world-writable file", { skip: isWindows }, () => {
  const path = writeConfig(0o666);
  withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "warn" }, () => {
    _clearCacheForTesting();
    const stderr = captureStderr(() => {
      const servers = loadOpenclawMcpServers();
      assert.equal(Object.keys(servers).length, 1, "warn must still load");
      assert.ok(servers.greet, "greet server must be present");
    });
    assert.match(stderr, /world-writable|group\/world-writable/);
  });
});

test("openclaw-config: 0o600 loads silently in both warn and strict modes", { skip: isWindows }, () => {
  for (const mode of ["warn", "strict"] as const) {
    const path = writeConfig(0o600);
    withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: mode }, () => {
      _clearCacheForTesting();
      const stderr = captureStderr(() => {
        const servers = loadOpenclawMcpServers();
        assert.equal(Object.keys(servers).length, 1, `${mode} must load 0o600 file`);
      });
      assert.doesNotMatch(stderr, /world-writable|group\/world-writable/, `${mode}: no warning for 0o600`);
    });
  }
});

test("openclaw-config: off mode skips check entirely", { skip: isWindows }, () => {
  const path = writeConfig(0o666);
  withEnv({ CLAUDE_PROXY_OPENCLAW_CONFIG: path, CLAUDE_PROXY_OPENCLAW_STRICT_PERMS: "off" }, () => {
    _clearCacheForTesting();
    const stderr = captureStderr(() => {
      const servers = loadOpenclawMcpServers();
      assert.equal(Object.keys(servers).length, 1);
    });
    assert.doesNotMatch(stderr, /world-writable/);
  });
});
