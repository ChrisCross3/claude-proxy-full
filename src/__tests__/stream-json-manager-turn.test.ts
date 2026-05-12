/**
 * stream-json-manager submitTurn timeout test (Welle 4 Gruppe A — Mi1).
 *
 * Verifies that when the TURN_TIMEOUT_MS deadline expires before a `result`
 * or `close` event arrives, submitTurn not only rejects but also kills the
 * underlying subprocess — preventing the next acquire from re-using a dead
 * worker stuck in turnInFlight.
 *
 * We avoid spawning a real claude CLI by reaching past the private
 * boundaries of StreamJsonSubprocess and stubbing the child + initialized
 * flag. The constant TURN_TIMEOUT_MS is large (900s) so we use node:test
 * MockTimers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { StreamJsonSubprocess } from "../subprocess/stream-json-manager.js";

interface MockStdin {
  destroyed: boolean;
  writableEnded: boolean;
  write: (chunk: string) => boolean;
}

interface MockChild extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid: number;
  killed: boolean;
  killCalls: NodeJS.Signals[];
  stdin: MockStdin;
  stdout: EventEmitter & { readable: boolean; destroyed: boolean };
  stderr: EventEmitter & { readable: boolean; destroyed: boolean };
  kill: (signal?: NodeJS.Signals) => boolean;
}

function makeMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.killed = false;
  child.killCalls = [];
  child.stdin = {
    destroyed: false,
    writableEnded: false,
    write: () => true,
  };
  child.stdout = Object.assign(new EventEmitter(), { readable: true, destroyed: false });
  child.stderr = Object.assign(new EventEmitter(), { readable: true, destroyed: false });
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    child.killCalls.push(signal);
    child.killed = true;
    return true;
  };
  return child;
}

test("submitTurn timeout kills the subprocess and rejects exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const sub = new StreamJsonSubprocess();
  const child = makeMockChild();
  // Inject minimal state so submitTurn can run without a real spawn.
  const internal = sub as unknown as {
    process: MockChild;
    initialized: boolean;
    isKilled: boolean;
    turnInFlight: boolean;
  };
  internal.process = child;
  internal.initialized = true;
  internal.isKilled = false;
  internal.turnInFlight = false;

  let rejectionCount = 0;
  const turn = sub.submitTurn("hello").then(
    () => { throw new Error("expected rejection"); },
    (err: Error) => { rejectionCount++; return err; },
  );

  // TURN_TIMEOUT_MS = 900_000. Advance enough to fire the timer.
  t.mock.timers.tick(900_001);

  const err = await turn;
  assert.match(err.message, /turn timed out after \d+ms/);
  assert.equal(rejectionCount, 1, "must reject exactly once");
  assert.deepEqual(child.killCalls, ["SIGTERM"], "timeout must kill subprocess");
  assert.equal(internal.turnInFlight, false, "turnInFlight must be cleared");
  assert.equal(internal.isKilled, true);

  // A late `result` event after timeout must not double-resolve / double-reject.
  sub.emit("result", { type: "result", subtype: "success" } as never);
  sub.emit("close");
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(rejectionCount, 1, "late events must not trigger a second settle");
});

test("submitTurn timeout kill calls underlying process.kill exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const sub = new StreamJsonSubprocess();
  const child = makeMockChild();
  const internal = sub as unknown as {
    process: MockChild;
    initialized: boolean;
    isKilled: boolean;
    turnInFlight: boolean;
  };
  internal.process = child;
  internal.initialized = true;
  internal.isKilled = false;
  internal.turnInFlight = false;

  const turn = sub.submitTurn("hello").catch((e: Error) => e);
  t.mock.timers.tick(900_001);
  await turn;
  // Calling kill() again externally must be a no-op (idempotent guard via isKilled).
  sub.kill();
  assert.equal(child.killCalls.length, 1, "child.kill must be invoked exactly once");
});
