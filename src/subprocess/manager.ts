/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { pushClaudeFlagIfSupported } from "./claude-flags.js";
import type { ClaudeEffort } from "../models/registry.js";
import type { ClaudePermissionMode } from "../adapter/openai-to-cli.js";
import { resolveAnthropicApiKey } from "../auth/credentials-resolver.js";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
  disallowedTools?: string[];
  /**
   * Effort level for the spawned Claude session.
   * Maps to claude --effort. Capability-checked at spawn time; throws if the
   * installed Claude CLI does not advertise --effort.
   */
  effort?: ClaudeEffort;
  /**
   * Thinking toggle for the spawned Claude session.
   * Injected via --settings inline JSON as alwaysThinkingEnabled.
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
  /** JSON Schema for structured output (print-mode only). Not in fingerprint. */
  jsonSchema?: Record<string, unknown>;
  /** Cap agentic turns (print-mode only). Not in fingerprint. */
  maxTurns?: number;
  /**
   * Inject Anthropic OAuth access token (read from ~/.claude/.credentials.json)
   * as ANTHROPIC_API_KEY env var. Required when bare=true so the CLI has a
   * non-keychain auth source. Part of fingerprint (different env = different
   * spawn that must not share a pool slot).
   */
  injectOAuthEnv?: boolean;
  /**
   * Spawn the subprocess with cwd=os.tmpdir() (or CLAUDE_PROXY_ISOLATED_CWD
   * if set) instead of the proxy's own cwd. Prevents CLAUDE.md walk-up
   * discovery from picking up the caller's workspace files. Part of
   * fingerprint.
   */
  isolateCwd?: boolean;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes (agentic tasks can be long)

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;

  private spawnedAt: number = 0;
  private spawnedModel: ClaudeModel | null = null;

  /**
   * Spawn the subprocess without writing stdin yet. Used by the warm pool to
   * pay the ~1.5s claude bootstrap cost ahead of a request.
   */
  async prepare(options: SubprocessOptions): Promise<void> {
    const args = await this.buildArgs(options);
    const cwd = resolveCwd(options);
    const env = await resolveEnv(options);

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn("claude", args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.spawnedAt = Date.now();
        this.spawnedModel = options.model;

        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Set up output listeners eagerly so a warm process pre-buffers
        // startup-banner output rather than blocking on the pipe.
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          this.buffer += data;
          this.processBuffer();
        });

        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            console.error("[Subprocess stderr]:", errorText.slice(0, 200));
          }
        });

        this.process.on("close", (code) => {
          this.clearTimeout();
          if (this.buffer.trim()) this.processBuffer();
          this.emit("close", code);
        });

        // Resolve as soon as the process has been spawned (PID assigned).
        this.process.once("spawn", () => {
          console.error(`[Subprocess] Prepared PID ${this.process?.pid} for model ${options.model}`);
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Write the prompt to a prepared subprocess and close stdin so claude starts
   * processing. Starts the per-request timeout here (not at spawn time) so the
   * idle period in the pool doesn't count.
   */
  submit(prompt: string, timeoutMs: number = DEFAULT_TIMEOUT): void {
    if (!this.process) throw new Error("Subprocess not prepared");

    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        this.isKilled = true;
        this.process?.kill("SIGTERM");
        this.emit("error", new Error(`Request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    this.process.stdin?.write(prompt);
    this.process.stdin?.end();
  }

  /**
   * Spawn + submit in one shot. Kept for backward compatibility / cold-path.
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    await this.prepare(options);
    this.submit(prompt, options.timeout || DEFAULT_TIMEOUT);
  }

  /** Model this subprocess was spawned with. */
  getModel(): ClaudeModel | null {
    return this.spawnedModel;
  }

  /** How long this subprocess has been alive in ms. */
  getAge(): number {
    return this.spawnedAt ? Date.now() - this.spawnedAt : 0;
  }

  /** Is the spawned process still alive and not yet submitted-to? */
  isHealthy(): boolean {
    return (
      this.process !== null &&
      !this.isKilled &&
      this.process.exitCode === null &&
      this.timeoutId === null // not yet submitted
    );
  }

  /** Detailed health for debugging stale-slot diagnostics. */
  healthDetails(): { hasProc: boolean; isKilled: boolean; exitCode: number | null; submitted: boolean } {
    return {
      hasProc: this.process !== null,
      isKilled: this.isKilled,
      exitCode: this.process?.exitCode ?? null,
      submitted: this.timeoutId !== null,
    };
  }

  /**
   * Build CLI arguments array
   * Note: prompt is passed via stdin to avoid E2BIG errors with large prompts
   */
  private async buildArgs(options: SubprocessOptions): Promise<string[]> {
    const args = [
      "--print", // Non-interactive mode
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--no-session-persistence", // Don't save sessions
      // Move per-machine sections (cwd, env info, git status, memory paths)
      // out of the cached system prompt into the first user message.
      // Lets multiple cwds/users hit the same Anthropic prompt cache prefix.
      "--exclude-dynamic-system-prompt-sections",
    ];

    // Support headless operation without permission prompts
    if (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "true") {
      args.push("--dangerously-skip-permissions");
    }

    if (options.disallowedTools && options.disallowedTools.length > 0) {
      args.push("--disallowedTools", options.disallowedTools.join(","));
    }

    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    // Effort: strict capability check, throw on mismatch — never spawn a
    // degraded process when the caller asked for a specific level.
    if (options.effort) {
      await pushClaudeFlagIfSupported(args, "--effort", {
        value: options.effort,
        strict: true,
        requestedValueLabel: options.effort,
      });
    }

    // Thinking: --settings inline JSON injection, capability-checked.
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

    // Optional per-request USD spending cap (print-mode only per Anthropic).
    if (options.maxBudgetUsd !== undefined) {
      await pushClaudeFlagIfSupported(args, "--max-budget-usd", {
        value: String(options.maxBudgetUsd),
        strict: true,
        requestedValueLabel: String(options.maxBudgetUsd),
      });
    }

    // Permission mode for tool calls. Whitelist-validated at adapter layer.
    if (options.permissionMode) {
      await pushClaudeFlagIfSupported(args, "--permission-mode", {
        value: options.permissionMode,
        strict: true,
        requestedValueLabel: options.permissionMode,
      });
    }

    // System prompt replacement / append (both can coexist; append wins last).
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

    // Subagent selection: --agent NAME and/or --agents <inline JSON>.
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

    // Minimal-mode spawn.
    if (options.bare) {
      await pushClaudeFlagIfSupported(args, "--bare", {
        strict: true,
        requestedValueLabel: "true",
      });
    }
    // Disable slash commands.
    if (options.disableSlashCommands) {
      await pushClaudeFlagIfSupported(args, "--disable-slash-commands", {
        strict: true,
        requestedValueLabel: "true",
      });
    }
    // JSON Schema for structured output.
    if (options.jsonSchema) {
      await pushClaudeFlagIfSupported(args, "--json-schema", {
        value: JSON.stringify(options.jsonSchema),
        strict: true,
        requestedValueLabel: "<inline JSON>",
      });
    }
    // Cap on agentic turns.
    if (options.maxTurns !== undefined) {
      await pushClaudeFlagIfSupported(args, "--max-turns", {
        value: String(options.maxTurns),
        strict: true,
        requestedValueLabel: String(options.maxTurns),
      });
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isContentDelta(message)) {
          // Emit content delta for streaming
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Resolve the working directory for a spawned subprocess. When isolateCwd is
 * set, the proxy's own cwd would still let claude walk up to find CLAUDE.md.
 * Use os.tmpdir() (or CLAUDE_PROXY_ISOLATED_CWD env override) so the walk-up
 * lands in a directory with no CLAUDE.md files.
 *
 * Shared between manager.ts and stream-json-manager.ts so both spawn paths
 * behave identically.
 */
export function resolveCwd(options: { cwd?: string; isolateCwd?: boolean }): string {
  if (options.isolateCwd) {
    return process.env.CLAUDE_PROXY_ISOLATED_CWD || os.tmpdir();
  }
  return options.cwd || process.cwd();
}

/**
 * Resolve the environment block for a spawned subprocess. When injectOAuthEnv
 * is set, the Anthropic OAuth access token is read from
 * ~/.claude/.credentials.json and exposed as ANTHROPIC_API_KEY. Required when
 * spawning with --bare, because --bare disables CLI OAuth/keychain reads.
 *
 * Shared between manager.ts and stream-json-manager.ts.
 */
export async function resolveEnv(
  options: { injectOAuthEnv?: boolean },
): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_PROXY: "1" };
  if (options.injectOAuthEnv) {
    const token = await resolveAnthropicApiKey();
    base.ANTHROPIC_API_KEY = token;
  }
  return base;
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
