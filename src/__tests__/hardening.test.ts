import test from "node:test";
import assert from "node:assert/strict";
import {
  CappedBuffer,
  createChunkDecoder,
  killProcessTree,
  parsePidList,
  safeEnd,
  safeWrite,
  type KillableProcess,
} from "../subprocess/hardening.js";

// --- kill escalation -------------------------------------------------------

interface FakeProc extends KillableProcess {
  signals: NodeJS.Signals[];
  exitCode: number | null;
}

function makeProc(pid = 4242): FakeProc {
  const signals: NodeJS.Signals[] = [];
  return {
    pid,
    exitCode: null,
    signals,
    kill(sig?: NodeJS.Signals) {
      signals.push(sig ?? "SIGTERM");
      return true;
    },
  };
}

/** Captures the escalation callback so the test controls when it "fires". */
function manualSchedule() {
  let pending: (() => void) | null = null;
  let unrefCalled = false;
  return {
    schedule: (fn: () => void) => {
      pending = fn;
      return { unref: () => { unrefCalled = true; } };
    },
    fire: () => { const f = pending; pending = null; f?.(); },
    get unrefCalled() { return unrefCalled; },
  };
}

test("killProcessTree: sends the polite signal immediately", () => {
  const proc = makeProc();
  const sched = manualSchedule();
  killProcessTree(proc, { schedule: sched.schedule, killPid: () => {}, listDescendants: () => [] });
  assert.deepEqual(proc.signals, ["SIGTERM"]);
});

test("killProcessTree: does not escalate when the process exited in the grace window", () => {
  const proc = makeProc();
  const sched = manualSchedule();
  const killed: Array<[number, string]> = [];
  killProcessTree(proc, {
    schedule: sched.schedule,
    killPid: (pid, sig) => killed.push([pid, sig]),
    listDescendants: () => [],
  });
  proc.exitCode = 0; // exited politely
  sched.fire();
  assert.deepEqual(killed, [], "a process that already exited must not be signalled again");
});

test("killProcessTree: escalates to SIGKILL when the process ignores SIGTERM", () => {
  const proc = makeProc(4242);
  const sched = manualSchedule();
  const killed: Array<[number, string]> = [];
  killProcessTree(proc, {
    schedule: sched.schedule,
    killPid: (pid, sig) => killed.push([pid, sig]),
    listDescendants: () => [],
  });
  sched.fire();
  assert.deepEqual(killed, [[4242, "SIGKILL"]]);
});

test("killProcessTree: kills descendants before the parent", () => {
  // Order matters: killing the parent first can reparent the children, after
  // which the pid list we already gathered is the only handle left on them.
  const proc = makeProc(100);
  const sched = manualSchedule();
  const order: number[] = [];
  killProcessTree(proc, {
    schedule: sched.schedule,
    killPid: (pid) => order.push(pid),
    listDescendants: () => [301, 201],
  });
  sched.fire();
  assert.deepEqual(order, [301, 201, 100]);
});

test("killProcessTree: unrefs the grace timer", () => {
  // A pending escalation must never be the reason the process stays alive.
  const proc = makeProc();
  const sched = manualSchedule();
  killProcessTree(proc, { schedule: sched.schedule, killPid: () => {}, listDescendants: () => [] });
  assert.equal(sched.unrefCalled, true);
});

test("killProcessTree: an already-exited process is left alone entirely", () => {
  const proc = makeProc();
  proc.exitCode = 1;
  killProcessTree(proc, { schedule: () => ({}), killPid: () => {}, listDescendants: () => [] });
  assert.deepEqual(proc.signals, []);
});

test("killProcessTree: a throwing kill() does not prevent escalation", () => {
  const sched = manualSchedule();
  const killed: number[] = [];
  const proc: KillableProcess = {
    pid: 7,
    exitCode: null,
    kill() { throw new Error("ESRCH"); },
  };
  killProcessTree(proc, {
    schedule: sched.schedule,
    killPid: (pid) => killed.push(pid),
    listDescendants: () => [],
  });
  sched.fire();
  assert.deepEqual(killed, [7]);
});

test("parsePidList: extracts pids and ignores headers and blanks", () => {
  assert.deepEqual(parsePidList("ProcessId\n\n  1234 \n 5678\n"), [1234, 5678]);
  assert.deepEqual(parsePidList(""), []);
  assert.deepEqual(parsePidList("no numbers here"), []);
});

// --- UTF-8 chunk decoding --------------------------------------------------

test("chunk decoder: keeps a multi-byte character split across chunks intact", () => {
  // The bug this prevents: each chunk decoded on its own turns the split
  // character into U+FFFD on both sides, corrupting a JSON frame that then
  // fails to parse far away from the actual cause.
  const full = Buffer.from('{"text":"grüß"}', "utf8");
  const cut = 11; // lands inside the two-byte "ü"
  const dec = createChunkDecoder();
  const out = dec.write(full.subarray(0, cut)) + dec.write(full.subarray(cut)) + dec.end();
  assert.equal(out, '{"text":"grüß"}');
  assert.ok(!out.includes("�"), "no replacement characters may appear");
});

test("chunk decoder: naive toString would have corrupted the same input", () => {
  // Demonstrates the failure being fixed, so the test documents the reason.
  const full = Buffer.from("grüß", "utf8");
  const cut = 3;
  const naive = full.subarray(0, cut).toString() + full.subarray(cut).toString();
  assert.ok(naive.includes("�"));
});

test("chunk decoder: passes strings through untouched", () => {
  const dec = createChunkDecoder();
  assert.equal(dec.write("already decoded"), "already decoded");
});

test("chunk decoder: handles a character split across three chunks", () => {
  const emoji = Buffer.from("🙂", "utf8"); // 4 bytes
  const dec = createChunkDecoder();
  const out =
    dec.write(emoji.subarray(0, 1)) +
    dec.write(emoji.subarray(1, 3)) +
    dec.write(emoji.subarray(3)) +
    dec.end();
  assert.equal(out, "🙂");
});

// --- capped buffer ---------------------------------------------------------

test("CappedBuffer: keeps content below the cap and reports no truncation", () => {
  const buf = new CappedBuffer(100);
  buf.append("hello ");
  buf.append("world");
  assert.equal(buf.value, "hello world");
  assert.equal(buf.truncated, false);
  assert.equal(buf.dropped, 0);
});

test("CappedBuffer: truncates at the cap and reports it", () => {
  const buf = new CappedBuffer(5);
  buf.append("abcdefgh");
  assert.equal(buf.value, "abcde");
  assert.equal(buf.truncated, true);
  assert.equal(buf.dropped, 3);
});

test("CappedBuffer: drops everything once full", () => {
  const buf = new CappedBuffer(4);
  buf.append("abcd");
  buf.append("efgh");
  assert.equal(buf.value, "abcd");
  assert.equal(buf.dropped, 4);
});

test("CappedBuffer: cuts on a character boundary, not a byte boundary", () => {
  // "ü" is two bytes. A byte-wise cut at 1 would emit half a character.
  const buf = new CappedBuffer(1);
  buf.append("ü");
  assert.equal(buf.value, "");
  assert.ok(!buf.value.includes("�"));
  assert.equal(buf.truncated, true);
});

test("CappedBuffer: clear resets content and the drop counter", () => {
  const buf = new CappedBuffer(2);
  buf.append("abcd");
  buf.clear();
  assert.equal(buf.value, "");
  assert.equal(buf.truncated, false);
});

// --- EPIPE-safe writes -----------------------------------------------------

test("safeWrite: registers an error listener before writing", () => {
  // Without a listener an EPIPE on a child's stdin is an unhandled 'error'
  // event, which takes the whole proxy down over one dead subprocess.
  const events: string[] = [];
  const ok = safeWrite(
    {
      write: () => true,
      on: (evt: string) => { events.push(evt); },
    },
    "payload",
  );
  assert.equal(ok, true);
  assert.ok(events.includes("error"));
});

test("safeWrite: a throwing write returns false instead of propagating", () => {
  const ok = safeWrite({ write() { throw new Error("EPIPE"); }, on: () => {} }, "x");
  assert.equal(ok, false);
});

test("safeWrite: a missing stream is a no-op", () => {
  assert.equal(safeWrite(null, "x"), false);
  assert.equal(safeWrite(undefined, "x"), false);
});

test("safeEnd: swallows a throwing end()", () => {
  let ended = false;
  safeEnd({ write: () => true, on: () => {}, end() { ended = true; } });
  assert.equal(ended, true);
  safeEnd({ write: () => true, on: () => {}, end() { throw new Error("already closed"); } });
  safeEnd(null);
});
