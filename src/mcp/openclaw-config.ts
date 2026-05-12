/**
 * Read MCP-server registrations from openclaw.json (or compatible JSON
 * file) and produce inline `--mcp-config` shape, with secret references
 * resolved via openclaw's own keychain resolver.
 *
 * Path precedence:
 *   1. CLAUDE_PROXY_OPENCLAW_CONFIG env var
 *   2. ~/.openclaw/openclaw.json
 * If the file doesn't exist or is malformed, returns an empty map and
 * logs once. The proxy degrades gracefully — env-var-only paths
 * (e.g. CLAUDE_PROXY_N8N_API_*) still work as a fallback.
 *
 * Secret resolution:
 * openclaw env values can be either plain strings or refs like
 *   { "source": "exec", "provider": "keychain", "id": "n8n/apiKey" }
 * The proxy invokes the resolver `cfg.secrets.providers.keychain.command`
 * with `{ids: [...]}` on stdin (matching openclaw's protocol — see
 * ~/.openclaw/bin/openclaw-secret-keychain-resolver.py) and substitutes
 * the returned values. Unresolved refs are dropped with a logged warning.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { resolve } from "path";

interface SecretRef {
  source: "exec" | "env" | "file";
  provider?: string;
  id?: string;
}

type EnvValue = string | number | boolean | SecretRef;

interface OpenclawMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, EnvValue>;
}

interface OpenclawConfig {
  mcp?: { servers?: Record<string, OpenclawMcpServer> };
  secrets?: { providers?: Record<string, { source?: string; command?: string }> };
}

export interface ResolvedMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SecretResolutionDecision {
  server: string;
  envKey: string;
  action: "secret_resolved" | "secret_unresolved";
  reason?: string;
}

const RESOLVER_TIMEOUT_MS = 5000;

/** Default TTL for the resolved-server cache. */
const RESOLVER_CACHE_TTL_MS = 60_000;

/** Effective TTL, re-read per call so env updates / tests take effect. */
function resolverCacheTtlMs(): number {
  const raw = process.env.CLAUDE_PROXY_OPENCLAW_RESOLVER_TTL_MS;
  if (!raw) return RESOLVER_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : RESOLVER_CACHE_TTL_MS;
}

/** Accumulated secret resolution decisions from last load — for trace/audit. */
let lastSecretDecisions: SecretResolutionDecision[] = [];

/** Return the secret resolution decisions from the most recent config load. */
export function getSecretResolutionDecisions(): SecretResolutionDecision[] {
  return lastSecretDecisions;
}

let cached: { servers: Record<string, ResolvedMcpServer>; loadedAt: number } | null = null;
let inflight: Promise<Record<string, ResolvedMcpServer>> | null = null;

/** Resolver injection for tests; falls back to spawn-based callResolver. */
type ResolverFn = (cmd: string, ids: string[]) => Promise<Record<string, string>>;
let resolverOverride: ResolverFn | null = null;

function isSecretRef(v: unknown): v is SecretRef {
  return v !== null && typeof v === "object" && !Array.isArray(v) && "source" in (v as Record<string, unknown>);
}

function defaultConfigPath(): string {
  return process.env.CLAUDE_PROXY_OPENCLAW_CONFIG
    || resolve(homedir(), ".openclaw", "openclaw.json");
}

type PermsMode = "warn" | "strict" | "off";

function permsMode(): PermsMode {
  const raw = (process.env.CLAUDE_PROXY_OPENCLAW_STRICT_PERMS || "warn").trim().toLowerCase();
  if (raw === "strict" || raw === "off") return raw;
  return "warn";
}

/**
 * Reject world/group-writable openclaw.json — it holds secret refs and
 * resolver commands, so a writable file is a privilege-escalation path.
 * Returns true if the load may continue, false if strict mode rejects it.
 *
 * On Windows (process.getuid undefined) this is a no-op: POSIX mode bits
 * do not map cleanly onto NTFS ACLs and would produce false positives.
 */
function checkConfigPerms(path: string): boolean {
  if (typeof (process as { getuid?: () => number }).getuid !== "function") {
    return true; // Windows / no POSIX uid → skip
  }
  const mode = permsMode();
  if (mode === "off") return true;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return true; // existsSync passed; race or perms error — let readFile fail explicitly
  }
  const insecure = (st.mode & 0o022) !== 0;
  if (!insecure) return true;
  const msg = `[openclaw-config] ${path} is group/world-writable (mode=0${(st.mode & 0o777).toString(8)}). `
    + `This file holds secret references and resolver commands — chmod 600 is recommended.`;
  if (mode === "strict") {
    console.error(`${msg} CLAUDE_PROXY_OPENCLAW_STRICT_PERMS=strict — refusing to load.`);
    return false;
  }
  console.error(`${msg} (set CLAUDE_PROXY_OPENCLAW_STRICT_PERMS=strict to refuse loads, or =off to silence.)`);
  return true;
}

/**
 * Spawn the resolver, write {ids} to stdin, collect stdout, parse JSON.
 * Async with a hard 5s timeout that SIGKILLs a hanging resolver. Failures
 * (timeout, non-zero exit, parse error, spawn error) all degrade to an
 * empty map with a stderr log — the proxy must not block on a flaky
 * keychain.
 */
function callResolver(cmd: string, ids: string[]): Promise<Record<string, string>> {
  if (resolverOverride) {
    return resolverOverride(cmd, ids);
  }
  return new Promise((resolveP) => {
    let settled = false;
    const finish = (values: Record<string, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(values);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, { shell: true });
    } catch (err) {
      console.error("[openclaw-config] resolver spawn failed:", err instanceof Error ? err.message : err);
      resolveP({});
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      console.error(`[openclaw-config] resolver timed out after ${RESOLVER_TIMEOUT_MS}ms, killing`);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({});
    }, RESOLVER_TIMEOUT_MS);

    child.on("error", (err) => {
      console.error("[openclaw-config] resolver invocation failed:", err instanceof Error ? err.message : err);
      finish({});
    });

    child.on("close", (code) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        console.error(`[openclaw-config] resolver exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
        finish({});
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { values?: Record<string, string>; errors?: Record<string, unknown> };
        if (parsed.errors && Object.keys(parsed.errors).length > 0) {
          console.error("[openclaw-config] resolver returned errors:", parsed.errors);
        }
        finish(parsed.values || {});
      } catch (err) {
        console.error("[openclaw-config] resolver returned invalid JSON:", err instanceof Error ? err.message : err);
        finish({});
      }
    });

    // Write {ids} to resolver's stdin.
    try {
      child.stdin?.end(JSON.stringify({ ids }));
    } catch (err) {
      console.error("[openclaw-config] resolver stdin write failed:", err instanceof Error ? err.message : err);
      finish({});
    }
  });
}

/**
 * Read openclaw.json, extract mcp.servers, resolve secret refs, return a
 * normalized map. Cached for RESOLVER_CACHE_TTL_MS (default 60s; override
 * via CLAUDE_PROXY_OPENCLAW_RESOLVER_TTL_MS) so the proxy picks up
 * keychain rotations without restart. Parallel callers share one in-flight
 * Promise to avoid stampedes on the resolver.
 */
export async function loadOpenclawMcpServers(): Promise<Record<string, ResolvedMcpServer>> {
  if (cached && Date.now() - cached.loadedAt < resolverCacheTtlMs()) {
    return cached.servers;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<Record<string, ResolvedMcpServer>> => {
    try {
      return await doLoad();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function doLoad(): Promise<Record<string, ResolvedMcpServer>> {
  const path = defaultConfigPath();
  if (!existsSync(path)) {
    console.error(`[openclaw-config] not found: ${path} — skipping openclaw-config import`);
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  if (!checkConfigPerms(path)) {
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  let cfg: OpenclawConfig;
  try {
    cfg = JSON.parse(readFileSync(path, "utf-8")) as OpenclawConfig;
  } catch (err) {
    console.error(`[openclaw-config] failed to parse ${path}:`, err instanceof Error ? err.message : err);
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  const servers = cfg.mcp?.servers || {};
  if (Object.keys(servers).length === 0) {
    cached = { servers: {}, loadedAt: Date.now() };
    return cached.servers;
  }

  // Collect every secret id we need; batch into one resolver call.
  const idsByProvider: Map<string, Set<string>> = new Map();
  for (const server of Object.values(servers)) {
    for (const value of Object.values(server.env || {})) {
      if (isSecretRef(value) && value.id) {
        const provider = value.provider || "keychain";
        if (!idsByProvider.has(provider)) idsByProvider.set(provider, new Set());
        idsByProvider.get(provider)!.add(value.id);
      }
    }
  }

  const resolved: Map<string, Record<string, string>> = new Map();
  for (const [provider, ids] of idsByProvider) {
    const providerCfg = cfg.secrets?.providers?.[provider];
    if (!providerCfg?.command) {
      console.error(`[openclaw-config] no resolver command for provider "${provider}", skipping ${ids.size} secret(s)`);
      continue;
    }
    resolved.set(provider, await callResolver(providerCfg.command, [...ids]));
  }

  const out: Record<string, ResolvedMcpServer> = {};
  const secretDecisions: SecretResolutionDecision[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env || {})) {
      if (typeof v === "string") {
        env[k] = v;
      } else if (typeof v === "number" || typeof v === "boolean") {
        env[k] = String(v);
      } else if (isSecretRef(v) && v.id) {
        const providerValues = resolved.get(v.provider || "keychain") || {};
        const value = providerValues[v.id];
        if (value !== undefined) {
          env[k] = value;
          secretDecisions.push({ server: name, envKey: k, action: "secret_resolved" });
        } else {
          console.error(`[openclaw-config] unresolved secret ${v.id} for ${name}.${k} — skipping`);
          secretDecisions.push({ server: name, envKey: k, action: "secret_unresolved", reason: `secret ${v.id} not resolved by provider ${v.provider || "keychain"}` });
        }
      }
    }
    out[name] = { command: server.command, args: server.args || [], env };
  }
  lastSecretDecisions = secretDecisions;

  console.error(`[openclaw-config] loaded ${Object.keys(out).length} MCP server(s) from ${path}`);
  cached = { servers: out, loadedAt: Date.now() };
  return out;
}

/** For tests: drop the cache so a subsequent load re-reads the file. */
export function _clearCacheForTesting(): void {
  cached = null;
  inflight = null;
  lastSecretDecisions = [];
}

/**
 * For tests: swap the resolver with a deterministic stub (counter, timeout
 * sim, etc.). Pass null to restore the real spawn-based resolver.
 */
export function _setResolverForTesting(fn: ResolverFn | null): void {
  resolverOverride = fn;
}
