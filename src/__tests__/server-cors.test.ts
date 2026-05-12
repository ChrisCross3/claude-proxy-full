/**
 * Tests for the opt-in CORS-whitelist middleware.
 *
 * The middleware reads CLAUDE_PROXY_ALLOWED_ORIGINS once at construction
 * time, so each test sets env then instantiates a fresh middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { corsMiddleware, matchesWhitelist } from "../server/middleware/cors.js";

interface MockState {
  statusCode: number;
  headers: Record<string, string>;
  ended: boolean;
}

function makeRes(): { res: Response; state: MockState } {
  const state: MockState = { statusCode: 200, headers: {}, ended: false };
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    sendStatus(code: number) {
      state.statusCode = code;
      state.ended = true;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function makeReq(method: string, origin?: string): Request {
  return {
    method,
    headers: origin ? { origin } : {},
  } as unknown as Request;
}

function runMw(method: string, origin?: string) {
  const mw = corsMiddleware();
  const { res, state } = makeRes();
  const req = makeReq(method, origin);
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  mw(req, res, next);
  return { state, nextCalled };
}

test("CORS: default (env unset) emits no Access-Control headers", () => {
  delete process.env.CLAUDE_PROXY_ALLOWED_ORIGINS;
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("GET", "https://attacker.example");
  assert.ok(nextCalled, "should call next");
  assert.equal(state.headers["access-control-allow-origin"], undefined);
});

test("CORS: explicit origin in whitelist gets exact-origin allow header", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "https://app.example,https://admin.example";
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("GET", "https://app.example");
  assert.ok(nextCalled);
  assert.equal(state.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(state.headers["vary"], "Origin");
});

test("CORS: loopback token matches http://localhost:* and http://127.0.0.1:*", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "loopback";
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const a = runMw("GET", "http://localhost:5173");
  assert.equal(a.state.headers["access-control-allow-origin"], "http://localhost:5173");
  const b = runMw("GET", "http://127.0.0.1:8080");
  assert.equal(b.state.headers["access-control-allow-origin"], "http://127.0.0.1:8080");
  const c = runMw("GET", "https://localhost:5173");
  assert.equal(c.state.headers["access-control-allow-origin"], undefined, "https loopback not matched");
});

test("CORS: OPTIONS preflight returns 403 for non-whitelisted origin", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "https://app.example";
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("OPTIONS", "https://attacker.example");
  assert.equal(state.statusCode, 403);
  assert.equal(nextCalled, false);
});

test("CORS: OPTIONS preflight returns 204 for matching origin", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "https://app.example";
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("OPTIONS", "https://app.example");
  assert.equal(state.statusCode, 204);
  assert.equal(state.headers["access-control-allow-origin"], "https://app.example");
  assert.equal(nextCalled, false);
});

test("CORS: '*' single-value without API key is dropped to empty whitelist", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "*";
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("GET", "https://anything.example");
  assert.ok(nextCalled);
  assert.equal(state.headers["access-control-allow-origin"], undefined);
});

test("CORS: '*' is honored when CLAUDE_PROXY_API_KEY is set", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "*";
  process.env.CLAUDE_PROXY_API_KEY = "secret123";
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("GET", "https://anything.example");
  assert.ok(nextCalled);
  assert.equal(state.headers["access-control-allow-origin"], "*");
  delete process.env.CLAUDE_PROXY_API_KEY;
});

test("CORS: no Origin header → no CORS headers, passthrough to next", () => {
  process.env.CLAUDE_PROXY_ALLOWED_ORIGINS = "https://app.example";
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  const { state, nextCalled } = runMw("POST");
  assert.ok(nextCalled);
  assert.equal(state.headers["access-control-allow-origin"], undefined);
});

test("CORS: matchesWhitelist helper covers wildcard / loopback / list cases", () => {
  assert.ok(matchesWhitelist("https://x.example", { origins: ["https://x.example"], loopback: false, wildcard: false }));
  assert.ok(!matchesWhitelist("https://y.example", { origins: ["https://x.example"], loopback: false, wildcard: false }));
  assert.ok(matchesWhitelist("http://localhost:9090", { origins: [], loopback: true, wildcard: false }));
  assert.ok(matchesWhitelist("https://anything", { origins: [], loopback: false, wildcard: true }));
});
