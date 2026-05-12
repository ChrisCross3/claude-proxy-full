/**
 * Tests for the opt-in cold-spawn token bucket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  extractCallerKey,
  consumeColdSpawnToken,
  resetColdSpawnBuckets,
  setColdSpawnClockForTests,
  coldSpawnLimitCounters,
  ColdSpawnRateLimitedError,
  isColdSpawnRateLimitedError,
} from "../server/middleware/cold-spawn-limit.js";

function setLimit(perMin: number, burst?: number): void {
  if (perMin > 0) {
    process.env.CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN = String(perMin);
    if (burst !== undefined) process.env.CLAUDE_PROXY_COLD_SPAWN_BURST = String(burst);
    else delete process.env.CLAUDE_PROXY_COLD_SPAWN_BURST;
  } else {
    delete process.env.CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN;
    delete process.env.CLAUDE_PROXY_COLD_SPAWN_BURST;
  }
  resetColdSpawnBuckets();
}

function mockClock(): { now(): number; advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now() { return t; },
    advance(ms: number) { t += ms; },
  };
}

test("cold-spawn: LIMIT=0 (default) → no-op, all calls allowed", () => {
  setLimit(0);
  for (let i = 0; i < 50; i++) {
    const r = consumeColdSpawnToken("anon");
    assert.equal(r.ok, true);
  }
});

test("cold-spawn: LIMIT=10 → exactly 10 tokens, 11th rejected", () => {
  setLimit(10);
  const clk = mockClock();
  setColdSpawnClockForTests(() => clk.now());
  for (let i = 0; i < 10; i++) {
    const r = consumeColdSpawnToken("caller-A");
    assert.equal(r.ok, true, `call #${i + 1} should be allowed`);
  }
  const reject = consumeColdSpawnToken("caller-A");
  assert.equal(reject.ok, false);
  if (!reject.ok) {
    assert.ok(reject.retryAfterSec >= 1, "retryAfterSec should be positive");
  }
  assert.ok(coldSpawnLimitCounters.rejected >= 1);
});

test("cold-spawn: refill after time-mock — tokens regenerate at limit/60 per second", () => {
  setLimit(60); // 1 token / sec, burst 60
  const clk = mockClock();
  setColdSpawnClockForTests(() => clk.now());
  // Drain the bucket
  for (let i = 0; i < 60; i++) {
    assert.equal(consumeColdSpawnToken("c").ok, true);
  }
  assert.equal(consumeColdSpawnToken("c").ok, false);
  // Advance 5 seconds → 5 tokens refilled
  clk.advance(5000);
  for (let i = 0; i < 5; i++) {
    assert.equal(consumeColdSpawnToken("c").ok, true, `refilled call #${i + 1}`);
  }
  assert.equal(consumeColdSpawnToken("c").ok, false, "6th after 5s should fail");
});

test("cold-spawn: two caller keys are tracked independently", () => {
  setLimit(3);
  const clk = mockClock();
  setColdSpawnClockForTests(() => clk.now());
  for (let i = 0; i < 3; i++) {
    assert.equal(consumeColdSpawnToken("A").ok, true);
    assert.equal(consumeColdSpawnToken("B").ok, true);
  }
  assert.equal(consumeColdSpawnToken("A").ok, false);
  assert.equal(consumeColdSpawnToken("B").ok, false);
});

test("cold-spawn: extractCallerKey prefers Authorization → XFF → req.ip → 'anon'", () => {
  const auth: Request = { headers: { authorization: "Bearer abc" } } as unknown as Request;
  const k1 = extractCallerKey(auth);
  assert.match(k1, /^a:[0-9a-f]{16}$/);

  const xff: Request = { headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.99" } } as unknown as Request;
  const k2 = extractCallerKey(xff);
  assert.equal(k2, "x:10.0.0.1");

  const ip: Request = { headers: {}, ip: "192.168.1.5" } as unknown as Request;
  const k3 = extractCallerKey(ip);
  assert.equal(k3, "i:192.168.1.5");

  const none: Request = { headers: {} } as unknown as Request;
  const k4 = extractCallerKey(none);
  assert.equal(k4, "anon");
});

test("cold-spawn: same authorization header always hashes to same caller key (stable)", () => {
  const r1: Request = { headers: { authorization: "Bearer xyz" } } as unknown as Request;
  const r2: Request = { headers: { authorization: "Bearer xyz" } } as unknown as Request;
  const r3: Request = { headers: { authorization: "Bearer different" } } as unknown as Request;
  assert.equal(extractCallerKey(r1), extractCallerKey(r2));
  assert.notEqual(extractCallerKey(r1), extractCallerKey(r3));
});

test("cold-spawn: burst override permits burst > limit-per-min", () => {
  setLimit(60, 5); // 1/sec rate but burst 5
  const clk = mockClock();
  setColdSpawnClockForTests(() => clk.now());
  for (let i = 0; i < 5; i++) {
    assert.equal(consumeColdSpawnToken("c").ok, true);
  }
  assert.equal(consumeColdSpawnToken("c").ok, false);
  clk.advance(2000);
  for (let i = 0; i < 2; i++) {
    assert.equal(consumeColdSpawnToken("c").ok, true);
  }
});

test("cold-spawn: ColdSpawnRateLimitedError is type-narrowable via isColdSpawnRateLimitedError", () => {
  const e = new ColdSpawnRateLimitedError(7);
  assert.ok(isColdSpawnRateLimitedError(e));
  assert.equal(e.retryAfterSec, 7);
  assert.equal((e as { code: string }).code, "cold_spawn_rate_limited");
  assert.equal(isColdSpawnRateLimitedError(new Error("other")), false);
});

// ---------------------------------------------------------------------------
// trust-proxy interaction (M3 hardening)
// ---------------------------------------------------------------------------

function reqWithTrust(trustProxyValue: unknown, headers: Record<string, string>, opts: { ip?: string; socketAddr?: string } = {}): Request {
  return {
    headers,
    app: { get: (k: string) => (k === "trust proxy" ? trustProxyValue : undefined) },
    ip: opts.ip,
    socket: { remoteAddress: opts.socketAddr },
  } as unknown as Request;
}

test("cold-spawn: trust=false ignores X-Forwarded-For", () => {
  const req = reqWithTrust(false, { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, { socketAddr: "127.0.0.1" });
  const k = extractCallerKey(req);
  assert.equal(k, "i:127.0.0.1", "must fall back to socket addr when trust=false");
});

test("cold-spawn: trust=loopback honors first X-Forwarded-For IP", () => {
  const req = reqWithTrust("loopback", { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, { ip: "1.2.3.4" });
  const k = extractCallerKey(req);
  assert.equal(k, "x:1.2.3.4");
});

test("cold-spawn: per-real-IP limit applies regardless of proxy hop (trust=false)", () => {
  setLimit(3);
  const clk = mockClock();
  setColdSpawnClockForTests(() => clk.now());
  // Same real IP, attacker rotates spoofed XFF — trust=false ignores it.
  const reqs = [
    reqWithTrust(false, { "x-forwarded-for": "9.9.9.9" }, { socketAddr: "127.0.0.1" }),
    reqWithTrust(false, { "x-forwarded-for": "8.8.8.8" }, { socketAddr: "127.0.0.1" }),
    reqWithTrust(false, { "x-forwarded-for": "7.7.7.7" }, { socketAddr: "127.0.0.1" }),
    reqWithTrust(false, { "x-forwarded-for": "6.6.6.6" }, { socketAddr: "127.0.0.1" }),
  ];
  const keys = reqs.map(extractCallerKey);
  assert.deepEqual(keys, ["i:127.0.0.1", "i:127.0.0.1", "i:127.0.0.1", "i:127.0.0.1"]);
  for (let i = 0; i < 3; i++) {
    assert.equal(consumeColdSpawnToken(keys[i]).ok, true);
  }
  assert.equal(consumeColdSpawnToken(keys[3]).ok, false, "4th from same real IP must be rejected");
});

test("cold-spawn: configureTrustProxy throws on invalid value", async () => {
  const { configureTrustProxy } = await import("../server/trust-proxy.js");
  const prev = process.env.CLAUDE_PROXY_TRUST_PROXY;
  process.env.CLAUDE_PROXY_TRUST_PROXY = "definitely-not-valid";
  try {
    const fakeApp = { set: () => {} } as unknown as import("express").Express;
    assert.throws(() => configureTrustProxy(fakeApp), /invalid value/i);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROXY_TRUST_PROXY;
    else process.env.CLAUDE_PROXY_TRUST_PROXY = prev;
  }
});

test("cold-spawn: configureTrustProxy accepts named/numeric/CIDR values", async () => {
  const { configureTrustProxy } = await import("../server/trust-proxy.js");
  const prev = process.env.CLAUDE_PROXY_TRUST_PROXY;
  for (const v of ["loopback", "linklocal", "uniquelocal", "1", "2", "10.0.0.0/8", "10.0.0.1, 192.168.0.1"]) {
    process.env.CLAUDE_PROXY_TRUST_PROXY = v;
    const seen: Record<string, unknown> = {};
    const fakeApp = { set: (k: string, val: unknown) => { seen[k] = val; } } as unknown as import("express").Express;
    configureTrustProxy(fakeApp);
    assert.ok("trust proxy" in seen, `value ${v} should set trust proxy`);
  }
  // unset
  delete process.env.CLAUDE_PROXY_TRUST_PROXY;
  const seen: Record<string, unknown> = {};
  const fakeApp = { set: (k: string, val: unknown) => { seen[k] = val; } } as unknown as import("express").Express;
  configureTrustProxy(fakeApp);
  assert.equal(seen["trust proxy"], false);
  if (prev === undefined) delete process.env.CLAUDE_PROXY_TRUST_PROXY;
  else process.env.CLAUDE_PROXY_TRUST_PROXY = prev;
});

test.after(() => {
  resetColdSpawnBuckets();
  delete process.env.CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN;
  delete process.env.CLAUDE_PROXY_COLD_SPAWN_BURST;
});
