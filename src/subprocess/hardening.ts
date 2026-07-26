/**
 * Subprocess hardening primitives.
 *
 * Three defects this addresses, all of which stay invisible until they aren't:
 *
 *  1. `kill()` sent SIGTERM and hoped. A CLI wedged in a syscall ignores it,
 *     and any tool the CLI spawned is not signalled at all — so a "killed"
 *     turn can leave a live descendant holding a port or a lock, and the pool
 *     hands out a slot whose process never actually died.
 *  2. `chunk.toString()` on a stream decodes each chunk in isolation. A
 *     multi-byte character split across a chunk boundary becomes U+FFFD, and
 *     because the corruption is one character inside otherwise valid JSON, it
 *     usually surfaces far away as a parse error with no obvious cause.
 *  3. `buffer += data` with no ceiling. A CLI that streams without ever
 *     emitting a parseable line grows the buffer until the process dies of
 *     memory exhaustion, taking every other in-flight request with it.
 *
 * Everything here takes its side effects as injectable dependencies so the
 * behaviour can be tested without spawning real processes or waiting on real
 * timers.
 */

import { StringDecoder } from "node:string_decoder";

// --- 1. Kill escalation ----------------------------------------------------

export interface KillableProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface KillTreeOptions {
  /** How long to let the process exit on its own before escalating. */
  graceMs?: number;
  /** Signal sent immediately. */
  initialSignal?: NodeJS.Signals;
  /** Signal sent after the grace period. */
  escalationSignal?: NodeJS.Signals;
  /** Kill one pid (injectable for tests; defaults to process.kill). */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  /** Enumerate descendant pids of a pid (injectable; defaults to a ps/wmic probe). */
  listDescendants?: (pid: number) => number[];
  /** Timer scheduling (injectable for tests). */
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  /** Cancel a scheduled timer. */
  cancel?: (handle: unknown) => void;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH means it is already gone — which is the outcome we wanted.
  }
}

/**
 * Terminate a process, escalating to SIGKILL if it does not exit, and taking
 * its descendants with it on escalation.
 *
 * The grace timer is unref'd: a pending escalation must never be the reason
 * the Node process stays alive at shutdown.
 */
export function killProcessTree(proc: KillableProcess, options: KillTreeOptions = {}): void {
  const {
    graceMs = DEFAULT_KILL_GRACE_MS,
    initialSignal = "SIGTERM",
    escalationSignal = "SIGKILL",
    killPid = defaultKillPid,
    listDescendants = defaultListDescendants,
    schedule = (fn, ms) => setTimeout(fn, ms),
  } = options;

  if (proc.exitCode !== null) return;

  try {
    proc.kill(initialSignal);
  } catch {
    // Already dead, or the handle is gone. Escalation below is still armed;
    // it re-checks exitCode and will no-op.
  }

  const handle = schedule(() => {
    if (proc.exitCode !== null) return; // exited within the grace period

    const pid = proc.pid;
    if (typeof pid === "number" && pid > 0) {
      // Children first: killing the parent first can reparent them to init,
      // where the pid list we just gathered is the only remaining handle.
      for (const child of listDescendants(pid)) {
        killPid(child, escalationSignal);
      }
      killPid(pid, escalationSignal);
    } else {
      try {
        proc.kill(escalationSignal);
      } catch {
        /* nothing left to signal */
      }
    }
  }, graceMs);

  handle?.unref?.();
}

/**
 * Best-effort descendant enumeration. Returns depth-first, deepest first, so
 * callers can kill children before their parents.
 *
 * Never throws: a failed probe yields an empty list, which degrades to
 * "escalate on the parent only" rather than failing the kill outright.
 */
export function defaultListDescendants(pid: number): number[] {
  try {
    // Imported lazily so the module stays cheap for callers that never escalate.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    if (process.platform === "win32") {
      const out = execFileSync(
        "wmic",
        ["process", "where", `ParentProcessId=${pid}`, "get", "ProcessId"],
        { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const kids = parsePidList(out);
      return kids.flatMap((k) => [...defaultListDescendants(k), k]);
    }
    const out = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const kids = parsePidList(out);
    return kids.flatMap((k) => [...defaultListDescendants(k), k]);
  } catch {
    return [];
  }
}

/** Extract pids from whitespace/line separated command output. */
export function parsePidList(raw: string): number[] {
  return String(raw || "")
    .split(/\s+/)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// --- 2. UTF-8 safe chunk decoding ------------------------------------------

export interface ChunkDecoder {
  /** Decode a chunk, holding back any incomplete trailing character. */
  write(chunk: Buffer | string): string;
  /** Flush whatever remains (invalid trailing bytes become U+FFFD here, once). */
  end(): string;
}

/**
 * Decoder that keeps a partial multi-byte character across chunk boundaries.
 * Strings are passed through untouched — they were already decoded upstream.
 */
export function createChunkDecoder(): ChunkDecoder {
  const decoder = new StringDecoder("utf8");
  return {
    write(chunk) {
      return typeof chunk === "string" ? chunk : decoder.write(chunk);
    },
    end() {
      return decoder.end();
    },
  };
}

// --- 3. Bounded buffer -----------------------------------------------------

export const DEFAULT_STDOUT_CAP_BYTES = 32 * 1024 * 1024;

export function stdoutCapBytes(): number {
  const raw = Number.parseInt(process.env.CLAUDE_PROXY_STDOUT_CAP_BYTES || "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_STDOUT_CAP_BYTES;
}

/**
 * Append-only buffer with a hard ceiling.
 *
 * On overflow it keeps the *head* and drops the rest: the beginning of a
 * response carries the structure a parser needs, whereas the tail of a runaway
 * stream is the part that has already gone wrong. `truncated` lets callers
 * report the truncation instead of silently returning a short answer.
 */
export class CappedBuffer {
  private parts = "";
  private droppedBytes = 0;

  constructor(private readonly capBytes: number = stdoutCapBytes()) {}

  append(text: string): void {
    if (!text) return;
    const room = this.capBytes - Buffer.byteLength(this.parts, "utf8");
    if (room <= 0) {
      this.droppedBytes += Buffer.byteLength(text, "utf8");
      return;
    }
    const incoming = Buffer.byteLength(text, "utf8");
    if (incoming <= room) {
      this.parts += text;
      return;
    }
    // Cut on a character boundary, not a byte boundary.
    let cut = text;
    while (Buffer.byteLength(cut, "utf8") > room) cut = cut.slice(0, -1);
    this.parts += cut;
    this.droppedBytes += incoming - Buffer.byteLength(cut, "utf8");
  }

  get value(): string {
    return this.parts;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  get dropped(): number {
    return this.droppedBytes;
  }

  clear(): void {
    this.parts = "";
    this.droppedBytes = 0;
  }
}

// --- 4. EPIPE-safe writes --------------------------------------------------

export interface WritableLike {
  write(chunk: string): boolean;
  end?(): void;
  once?(event: string, cb: (err: Error) => void): void;
  on?(event: string, cb: (err: Error) => void): void;
}

/**
 * Write to a pipe whose reader may already be gone.
 *
 * An EPIPE on a child's stdin arrives as an async 'error' event, not as a
 * throw from write() — without a listener Node treats it as unhandled and
 * takes the whole proxy down. Returns false when the write could not be made.
 */
export function safeWrite(stream: WritableLike | null | undefined, chunk: string): boolean {
  if (!stream) return false;
  try {
    stream.on?.("error", () => {
      /* EPIPE / ECONNRESET: the reader is gone; nothing to do here. */
    });
    return stream.write(chunk);
  } catch {
    return false;
  }
}

/** End a pipe without letting a late EPIPE escape. */
export function safeEnd(stream: WritableLike | null | undefined): void {
  if (!stream) return;
  try {
    stream.on?.("error", () => {
      /* see safeWrite */
    });
    stream.end?.();
  } catch {
    /* already closed */
  }
}
