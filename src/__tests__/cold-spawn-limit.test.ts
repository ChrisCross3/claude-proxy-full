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

test.after(() => {
  resetColdSpawnBuckets();
  delete process.env.CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN;
  delete process.env.CLAUDE_PROXY_COLD_SPAWN_BURST;
});
