/**
 * Stream-JSON Persistent Subprocess
 *
 * Uses claude `--input-format stream-json --output-format stream-json` so the
 * subprocess stays alive across multiple turns. This unlocks Anthropic prompt
 * caching of conversation history — turn N reads turn N-1's prefix from cache
 * (verified empirically: 70K tokens cache_read on turn 2 within same process).
 *
 * Protocol (reverse-engineered from @anthropic-ai/claude-agent-sdk-python):
 *   1. Send NDJSON `control_request` { subtype: "initialize", excludeDynamicSections: true }
 *   2. Wait for matching `control_response` { request_id, subtype: "success" }
 *   3. Send NDJSON user messages: { type: "user", message: { role, content }, parent_tool_use_id: null, session_id: "" }
 *   4. Listen for `result` events for each turn
 *   5. Multi-turn: keep stdin open and send more user messages
 *   6. End: close stdin
 *
 * The protocol is officially undocumented (Anthropic issue #24594 closed as
 * not-planned). Reverse-engineered from the public Python SDK; format may
 * shift between claude CLI releases — this is gated behind CLAUDE_PROXY_STREAM_JSON=1.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { resolveCwd, resolveEnv } from "./manager.js";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import type { SubprocessSnapshot } from "../server/watchdog.js";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { getSecretResolutionDecisions, loadOpenclawMcpServers, type ResolvedMcpServer } from "../mcp/openclaw-config.js";
import { applyMcpPolicy, secretDecisionsToTrace } from "../mcp/governance.js";
import type { TraceMcpDecision } from "../trace/types.js";
import { parseStreamJsonLine } from "./stream-json-parser.js";
import { createChunkDecoder, killProcessTree, type ChunkDecoder } from "./hardening.js";
import { pushClaudeFlagIfSupported } from "./claude-flags.js";
import type { ClaudeEffort } from "../models/registry.js";
import type { ClaudePermissionMode } from "../adapter/openai-to-cli.js";

const INIT_TIMEOUT_MS = 30000;
const TURN_TIMEOUT_MS = 900000;

/** Hard cap on unflushed stdout buffer; prevents OOM on a pathological line. */
export const STDOUT_BUFFER_HARD_CAP_BYTES = 50_000_000;

/**
 * Pure helper. Returns true if a buffer of `bufferLen` bytes exceeds the
 * hard cap. Extracted so the cap policy is unit-testable without spawning
 * a real subprocess.
 */
export function exceedsStdoutCap(bufferLen: number, capBytes = STDOUT_BUFFER_HARD_CAP_BYTES): boolean {
  return bufferLen > capBytes;
}

/** MCP governance decisions from the last buildOptionAMcpServers() call. */
let lastMcpDecisions: TraceMcpDecision[] = [];

/** Retrieve the MCP governance decisions from the most recent spawn. */
export function getLastMcpDecisions(): TraceMcpDecision[] {
  return lastMcpDecisions;
}

/**
 * Option A MCP-server registry for `--mcp-config` injection.
 *
 * When CLAUDE_PROXY_TOOLS_TRANSLATION=1 the inner claude CLI is spawned
 * with these MCP servers registered, so the model sees them as
 * `mcp__<server>__<tool>` and can invoke them natively.
 *
 * Sources, in priority order (later overrides earlier on name conflict):
 *   1. openclaw.json's `mcp.servers` section, with secret refs resolved
 *      via openclaw's own keychain resolver.
 *   2. Direct env vars (legacy, kept for the n8n case).
 *
 * The server set is filtered through MCP governance policy
 * (CLAUDE_PROXY_MCP_ALLOW / CLAUDE_PROXY_MCP_DENY) before injection.
 */
async function buildOptionAMcpServers(): Promise<Record<string, ResolvedMcpServer>> {
  const raw: Record<string, ResolvedMcpServer> = { ...(await loadOpenclawMcpServers()) };

  // Legacy/fallback: env-var-driven n8n, only if not already set from openclaw.json.
  if (!raw.n8n && process.env.CLAUDE_PROXY_N8N_API_URL && process.env.CLAUDE_PROXY_N8N_API_KEY) {
    raw.n8n = {
      command: process.env.CLAUDE_PROXY_N8N_MCP_BIN
        || "n8n-mcp",
      args: [],
      env: {
        N8N_API_URL: process.env.CLAUDE_PROXY_N8N_API_URL,
        N8N_API_KEY: process.env.CLAUDE_PROXY_N8N_API_KEY,
        MCP_MODE: "stdio",
      },
    };
  }

  // Apply allow/deny governance policy
  const { allowed, decisions } = applyMcpPolicy(raw);
  const secretDecisions = secretDecisionsToTrace(getSecretResolutionDecisions());
  lastMcpDecisions = [...secretDecisions, ...decisions];

  if (lastMcpDecisions.some((d) => d.action !== "loaded" && d.action !== "secret_resolved")) {
    console.error(`[MCP governance] ${lastMcpDecisions.filter((d) => d.action !== "loaded" && d.action !== "secret_resolved").map((d) => `${d.server}:${d.action}`).join(", ")}`);
  }

  return allowed;
}

export interface StreamJsonOptions {
  model: ClaudeModel;
  cwd?: string;
  /** Per-process native Claude tool deny-list. Used for MCP overlap safety. */
  disallowedTools?: string[];
  /**
   * Effort level for the spawned Claude session.
   * Maps to claude --effort. Must already be validated against the model's
   * registry entry; this layer enforces only the CLI-capability presence.
   */
  effort?: ClaudeEffort;
  /**
   * Thinking toggle for the spawned Claude session.
   * Injected via --settings inline JSON as alwaysThinkingEnabled.
   * Must already be validated against the model's registry entry.
   */
  thinking?: boolean;
  /** Verbose-logging category filter for this spawn, mapped to claude --debug. */
  debug?: string;
  /** Hard USD cap; print-mode only. */
  maxBudgetUsd?: number;
  /** Permission mode for tool calls. Whitelist-validated at adapter layer. */
  permissionMode?: ClaudePermissionMode;
  /** Replacement system prompt; mapped to claude --system-prompt. */
  systemPrompt?: string;
  /** Appended system prompt; mapped to claude --append-system-prompt. */
  appendSystemPrompt?: string;
  /** Single named subagent; mapped to claude --agent. */
  agent?: string;
  /** Ad-hoc subagent definitions; mapped to claude --agents <JSON>. */
  agents?: Record<string, unknown>;
  /** Minimal-mode spawn (claude --bare). Part of fingerprint (changes init). */
  bare?: boolean;
  /** Disable slash commands in subprocess. Part of fingerprint. */
  disableSlashCommands?: boolean;
  /**
   * JSON Schema for structured output; mapped to `claude --json-schema` at
   * spawn time (see the note at the push site for why this manager's
   * stream-json transport is no obstacle).
   *
   * Pool handling differs between the two pools, so always name the pool when
   * reasoning about it:
   *   - SessionPool: NOT part of the slot fingerprint, and it never reuses a
   *     warm slot for such a request anyway — `needsDedicated` in
   *     session-pool.ts routes every request carrying a jsonSchema to a
   *     dedicated process.
   *   - InitPool: part of the slot key. `configKey` in init-pool.ts hashes
   *     jsonSchema together with the rest of the spawn configuration, so two
   *     different schemas can each hold their own pre-warmed slot.
   */
  jsonSchema?: Record<string, unknown>;
  /** Cap agentic turns (print-mode only). Not in fingerprint. */
  maxTurns?: number;
  /** Inject Anthropic OAuth token as ANTHROPIC_API_KEY env var (for --bare spawns). */
  injectOAuthEnv?: boolean;
  /** Spawn with cwd=os.tmpdir() to prevent CLAUDE.md walk-up discovery. */
  isolateCwd?: boolean;
}

export class StreamJsonSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private readonly stdoutDecoder: ChunkDecoder = createChunkDecoder();
  private readonly stderrDecoder: ChunkDecoder = createChunkDecoder();
  private isKilled: boolean = false;
  private initialized: boolean = false;
  private pendingControl: Map<string, (response: unknown) => void> = new Map();
  private spawnedAt: number = 0;
  private model: ClaudeModel | null = null;
  private turnInFlight: boolean = false;
  private lastProcessActivityAt: number = 0;
  private processActivityCount: number = 0;
  private mcpDecisions: TraceMcpDecision[] = [];

  /** Spawn the subprocess and complete the initialize handshake. */
  async start(options: StreamJsonOptions): Promise<void> {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", options.model,
      "--no-session-persistence",
    ];
    // This Claude CLI flag has existed in some builds and disappeared in
    // others. Capability-detect it before use so a CLI update cannot break the
    // whole persistent runtime at spawn time.
    await pushClaudeFlagIfSupported(args, "--exclude-dynamic-system-prompt-sections", {
      requested: process.env.CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS === "1",
    });
    // Effort: strict capability check. If the request asks for an effort level
    // but the Claude CLI does not advertise --effort in claude --help, throw
    // rather than silently spawn without it. Never let intent disappear into
    // a degraded run.
    if (options.effort) {
      await pushClaudeFlagIfSupported(args, "--effort", {
        value: options.effort,
        strict: true,
        requestedValueLabel: options.effort,
      });
    }
    // Thinking: --settings inline JSON. claude --help has had --settings for
    // a long time; we still capability-check before pushing, never silently drop.
    if (options.thinking !== undefined) {
      await pushClaudeFlagIfSupported(args, "--settings", {
        value: JSON.stringify({ alwaysThinkingEnabled: options.thinking }),
        strict: true,
        requestedValueLabel: String(options.thinking),
      });
    }
    // Optional verbose logging filter — passthrough of claude --debug (silent skip).
    if (options.debug) {
      await pushClaudeFlagIfSupported(args, "--debug", { value: options.debug });
    }

    // Optional per-request USD spending cap.
    if (options.maxBudgetUsd !== undefined) {
      await pushClaudeFlagIfSupported(args, "--max-budget-usd", {
        value: String(options.maxBudgetUsd),
        strict: true,
        requestedValueLabel: String(options.maxBudgetUsd),
      });
    }

    // Permission mode (e.g. plan, bypassPermissions). Already whitelist-
    // validated at the adapter; the spawner only checks CLI capability.
    if (options.permissionMode) {
      await pushClaudeFlagIfSupported(args, "--permission-mode", {
        value: options.permissionMode,
        strict: true,
        requestedValueLabel: options.permissionMode,
      });
    }

    // System prompt replacement / append. Both flags coexist (append takes
    // effect on top of the replacement); --system-prompt-file is intentionally
    // not exposed here — we accept the prompt as inline text.
    if (options.systemPrompt) {
      await pushClaudeFlagIfSupported(args, "--system-prompt", {
        value: options.systemPrompt,
        strict: true,
        requestedValueLabel: "<set>",
      });
    }
    if (options.appendSystemPrompt) {
      await pushClaudeFlagIfSupported(args, "--append-system-prompt", {
        value: options.appendSystemPrompt,
        strict: true,
        requestedValueLabel: "<set>",
      });
    }

    // Subagent selection: --agent NAME or --agents <inline JSON>. Both can
    // coexist per Anthropic's docs (named selection + ad-hoc definitions).
    if (options.agent) {
      await pushClaudeFlagIfSupported(args, "--agent", {
        value: options.agent,
        strict: true,
        requestedValueLabel: options.agent,
      });
    }
    if (options.agents) {
      await pushClaudeFlagIfSupported(args, "--agents", {
        value: JSON.stringify(options.agents),
        strict: true,
        requestedValueLabel: "<inline JSON>",
      });
    }

    // Minimal-mode spawn: skip hooks/skills/plugins/MCP/auto-memory/CLAUDE.md
    // discovery. Sets CLAUDE_CODE_SIMPLE env in claude-CLI internally.
    if (options.bare) {
      await pushClaudeFlagIfSupported(args, "--bare", {
        strict: true,
        requestedValueLabel: "true",
      });
    }
    // Disable slash commands in subprocess.
    if (options.disableSlashCommands) {
      await pushClaudeFlagIfSupported(args, "--disable-slash-commands", {
        strict: true,
        requestedValueLabel: "true",
      });
    }
    // Structured output through the CLI's own schema validator.
    //
    // Upstream calls --json-schema "print mode only", which reads like a
    // conflict with the --output-format stream-json this manager fixes above.
    // It is not: the restriction concerns the headless run, not the output
    // format. The docs only ever show the flag next to --output-format json,
    // so going by the docs alone the pairing used here looks inadmissible.
    // Measured on the pinned CLI 2.1.232 with this exact spawn shape it is
    // not — the CLI installs its synthetic StructuredOutput tool and the
    // validated JSON arrives in the result message. The evidence sits next to
    // responseFormatToJsonSchema in openai-to-cli.ts.
    //
    // Enforcement is only real from v2.1.205; earlier CLIs silently ignored an
    // invalid schema and returned unstructured text. Our pin is above that, so
    // `strict` below is the correct setting — a CLI that cannot offer the flag
    // is a broken pin, not a case for a quiet downgrade.
    if (options.jsonSchema) {
      await pushClaudeFlagIfSupported(args, "--json-schema", {
        value: JSON.stringify(options.jsonSchema),
        strict: true,
        requestedValueLabel: "<inline JSON>",
      });
    }
    // Cap on agentic turns (print-mode only upstream).
    if (options.maxTurns !== undefined) {
      await pushClaudeFlagIfSupported(args, "--max-turns", {
        value: String(options.maxTurns),
        strict: true,
        requestedValueLabel: String(options.maxTurns),
      });
    }
    if (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "true") {
      args.push("--dangerously-skip-permissions");
    }

    // Option A: register openclaw-known MCP servers with the inner claude
    // CLI via --mcp-config inline JSON. Gated on
    // CLAUDE_PROXY_TOOLS_TRANSLATION=1. Currently only the n8n MCP server
    // is supported; new servers can be added here when their env vars are
    // present. The CLI executes these tools internally — openclaw's audit
    // and approval do NOT see these calls. Documented trade-off; see
    // README "Tools translation modes".
    if (process.env.CLAUDE_PROXY_TOOLS_TRANSLATION === "1") {
      console.error("[MCP] WARNING: CLAUDE_PROXY_TOOLS_TRANSLATION=1 — inner Claude CLI will execute MCP tools directly. OpenClaw audit/approval is bypassed for injected tools.");
      const mcpServers = await buildOptionAMcpServers();
      this.mcpDecisions = [...lastMcpDecisions];
      if (Object.keys(mcpServers).length > 0) {
        args.push("--mcp-config", JSON.stringify({ mcpServers }));
      }
    } else {
      this.mcpDecisions = [];
    }

    if (options.disallowedTools && options.disallowedTools.length > 0) {
      args.push("--disallowedTools", options.disallowedTools.join(","));
    }

    this.model = options.model;

    const spawnCwd = resolveCwd(options);
    const spawnEnv = await resolveEnv(options);

    return new Promise((resolve, reject) => {
      this.process = spawn("claude", args, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.spawnedAt = Date.now();

      this.process.on("error", (err) => {
        if (err.message.includes("ENOENT")) {
          reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
        } else {
          reject(err);
        }
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        this.markProcessActivity();
        // StringDecoder, not chunk.toString(): NDJSON frames routinely straddle
        // chunk boundaries, and a multi-byte character split across two chunks
        // would decode to U+FFFD on both sides — corrupting a frame that then
        // fails to parse for reasons invisible at the failure site.
        this.buffer += this.stdoutDecoder.write(chunk);
        if (exceedsStdoutCap(this.buffer.length)) {
          console.error(
            `[StreamJson] stdout buffer exceeded hard cap ` +
            `(${this.buffer.length} > ${STDOUT_BUFFER_HARD_CAP_BYTES}); ` +
            `killing subprocess pid=${this.process?.pid}`,
          );
          this.buffer = "";
          if (this.listenerCount("error") > 0) {
            this.emit("error", new Error("ndjson_line_too_large"));
          }
          this.kill();
          return;
        }
        this.processBuffer();
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        this.markProcessActivity();
        const text = this.stderrDecoder.write(chunk).trim();
        if (text) console.error("[StreamJson stderr]:", text.slice(0, 200));
      });

      this.process.on("close", (code) => {
        if (this.buffer.trim()) this.processBuffer();
        this.emit("close", code);
        // Reject pending control requests for this worker.
        for (const cb of this.pendingControl.values()) {
          cb(new Error(`subprocess closed with code ${code}`));
        }
        this.pendingControl.clear();
      });

      this.process.once("spawn", () => {
        this.markProcessActivity();
        console.error(`[StreamJson] Spawned PID ${this.process?.pid} for ${options.model}`);
        // Send initialize handshake.
        this.sendInit().then(resolve).catch(reject);
      });
    });
  }

  private async sendInit(): Promise<void> {
    const requestId = `req_init_${randomUUID().slice(0, 8)}`;
    const initRequest = {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "initialize",
        hooks: null,
        excludeDynamicSections: true,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`init handshake timed out after ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);

      this.pendingControl.set(requestId, (response) => {
        clearTimeout(timer);
        if (response instanceof Error) reject(response);
        else {
          this.initialized = true;
          resolve();
        }
      });

      this.writeLine(initRequest);
    });
  }

  /**
   * Send a user message and wait for the matching `result` event. Caller
   * receives `assistant`, `content_delta`, `result` events on this emitter.
   * Returns when the result arrives.
   */
  async submitTurn(userText: string): Promise<ClaudeCliResult> {
    if (!this.initialized) throw new Error("subprocess not initialized");
    if (this.turnInFlight) throw new Error("turn already in flight");
    if (this.isKilled || this.process?.exitCode !== null) {
      throw new Error("subprocess is dead");
    }

    this.turnInFlight = true;

    const userMsg = {
      type: "user",
      session_id: "",
      message: { role: "user", content: userText },
      parent_tool_use_id: null,
    };

    return new Promise<ClaudeCliResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("result", onResult);
        this.off("close", onClose);
        this.turnInFlight = false;
        // A turn that timed out has left an unresponsive subprocess behind:
        // result/close listeners are now detached, so any late events would
        // be lost — and the next acquire would re-use a dead worker. Kill
        // it eagerly. `kill()` is idempotent (no-op when isKilled is set).
        try { this.kill(); } catch { /* swallow — process may already be dead */ }
        reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`));
      }, TURN_TIMEOUT_MS);

      const onResult = (result: ClaudeCliResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.turnInFlight = false;
        this.off("result", onResult);
        this.off("close", onClose);
        resolve(result);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.turnInFlight = false;
        this.off("result", onResult);
        this.off("close", onClose);
        reject(new Error("subprocess closed before result"));
      };

      this.on("result", onResult);
      this.on("close", onClose);

      try {
        this.writeLine(userMsg);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.turnInFlight = false;
        this.off("result", onResult);
        this.off("close", onClose);
        reject(err);
      }
    });
  }

  private writeLine(obj: unknown): void {
    if (!this.process?.stdin || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
      throw new Error("stdin not writable");
    }
    // The guard above closes the window we can see; it cannot close the race
    // where the CLI dies between the check and the write. That EPIPE arrives
    // as an async 'error' event on the stream — unhandled, it terminates the
    // whole proxy over one dead subprocess. Callers still get the throw above
    // for the synchronous case; this only keeps the async one survivable.
    // Optional call: the handle is a full Writable in production, but not every
    // caller (or test double) supplies one, and a missing `.on` must not turn a
    // guard against crashes into the crash itself.
    this.process.stdin.on?.("error", () => {
      /* EPIPE / ECONNRESET: reader is gone. The turn fails via close/timeout. */
    });
    this.process.stdin.write(JSON.stringify(obj) + "\n");
    this.markProcessActivity();
  }

  private markProcessActivity(): void {
    this.lastProcessActivityAt = Date.now();
    this.processActivityCount++;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseStreamJsonLine(trimmed);
      if (parsed.kind === "empty") continue;
      if (parsed.kind === "malformed") {
        this.emit("raw", parsed.raw);
        continue;
      }

      if (parsed.kind === "control_response") {
        const cr = parsed.value;
        const reqId = cr.response?.request_id;
        const cb = this.pendingControl.get(reqId);
        if (cb) {
          this.pendingControl.delete(reqId);
          if (cr.response.subtype === "error") cb(new Error(cr.response.error || "control error"));
          else cb(cr.response);
        }
        continue;
      }

      this.emit("message", parsed.value as ClaudeCliMessage);
      const m = parsed.value as ClaudeCliMessage;
      if (isContentDelta(m)) this.emit("content_delta", m as ClaudeCliStreamEvent);
      else if (isAssistantMessage(m)) this.emit("assistant", m as ClaudeCliAssistant);
      else if (isResultMessage(m)) this.emit("result", m as ClaudeCliResult);
    }
  }

  /** Politely close stdin so claude exits after current turn. */
  endInput(): void {
    if (this.process?.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.end();
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.process && !this.isKilled) {
      this.isKilled = true;
      // Escalates to SIGKILL and reaps descendants if the CLI ignores the
      // polite signal. A pool slot whose process outlived its kill gets handed
      // out again and fails the next request for reasons that look unrelated.
      killProcessTree(this.process, { initialSignal: signal });
    }
  }

  isHealthy(): boolean {
    return (
      this.process !== null &&
      !this.isKilled &&
      this.process.exitCode === null &&
      this.initialized &&
      !this.turnInFlight
    );
  }

  getModel(): ClaudeModel | null {
    return this.model;
  }

  getMcpDecisions(): TraceMcpDecision[] {
    return [...this.mcpDecisions];
  }

  getAge(): number {
    return this.spawnedAt ? Date.now() - this.spawnedAt : 0;
  }

  /**
   * Return a safe, serializable snapshot of subprocess health for watchdog
   * diagnostics. No secrets, no circular refs.
   */
  snapshot(): SubprocessSnapshot {
    const now = Date.now();
    return {
      pid: this.process?.pid,
      exitCode: this.process?.exitCode ?? null,
      signalCode: this.process?.signalCode ?? null,
      killed: this.isKilled,
      stdinDestroyed: this.process?.stdin?.destroyed ?? true,
      stdinWritableEnded: this.process?.stdin?.writableEnded ?? true,
      stdoutReadable: this.process?.stdout?.readable ?? false,
      stdoutDestroyed: this.process?.stdout?.destroyed ?? true,
      stderrReadable: this.process?.stderr?.readable ?? false,
      stderrDestroyed: this.process?.stderr?.destroyed ?? true,
      initialized: this.initialized,
      turnInFlight: this.turnInFlight,
      ageMs: this.getAge(),
      lastProcessActivityAgeMs: this.lastProcessActivityAt ? now - this.lastProcessActivityAt : null,
      processActivityCount: this.processActivityCount,
    };
  }
}
