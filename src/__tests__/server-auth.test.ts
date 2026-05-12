/**
 * Tests for the opt-in Bearer-Token auth middleware.
 *
 * The middleware reads CLAUDE_PROXY_API_KEY / CLAUDE_PROXY_API_KEYS once
 * at construction time, so each test mutates env then instantiates a
 * fresh middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { authMiddleware, authCounters, resetAuthCountersForTests } from "../server/middleware/auth.js";

interface MockState {
  statusCode: number;
  body: unknown;
  ended: boolean;
}

function makeRes(): { res: Response; state: MockState } {
  const state: MockState = { statusCode: 200, body: undefined, ended: false };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      state.ended = true;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function makeReq(path: string, authorization?: string): Request {
  return {
    path,
    headers: authorization ? { authorization } : {},
  } as unknown as Request;
}

function runMw(path: string, authorization?: string) {
  const mw = authMiddleware();
  const { res, state } = makeRes();
  const req = makeReq(path, authorization);
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  mw(req, res, next);
  return { state, nextCalled };
}

function clearKeys(): void {
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
  resetAuthCountersForTests();
}

test("auth: env unset → middleware is a no-op (passes through)", () => {
  clearKeys();
  const { state, nextCalled } = runMw("/v1/chat/completions", "Bearer anything");
  assert.ok(nextCalled);
  assert.equal(state.ended, false);
});

test("auth: missing Bearer header returns 401 invalid_api_key", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEY = "secret-A";
  const { state, nextCalled } = runMw("/v1/chat/completions");
  assert.equal(state.statusCode, 401);
  assert.equal(nextCalled, false);
  const body = state.body as { error: { type: string; code: string; message: string } };
  assert.equal(body.error.type, "authentication_error");
  assert.equal(body.error.code, "invalid_api_key");
  assert.equal(body.error.message, "unauthorized");
});

test("auth: wrong Bearer token returns 401 and counts a denial", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEY = "secret-A";
  const denialsBefore = authCounters.authDenials;
  const { state, nextCalled } = runMw("/v1/chat/completions", "Bearer wrong-token");
  assert.equal(state.statusCode, 401);
  assert.equal(nextCalled, false);
  assert.ok(authCounters.authDenials > denialsBefore);
});

test("auth: correct Bearer token passes through", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEY = "secret-A";
  const { state, nextCalled } = runMw("/v1/chat/completions", "Bearer secret-A");
  assert.ok(nextCalled);
  assert.equal(state.ended, false);
});

test("auth: /health and /metrics whitelisted even when key is set", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEY = "secret-A";
  for (const p of ["/health", "/healthz", "/healthz/deep", "/metrics", "/pricing", "/v1/pricing"]) {
    const { state, nextCalled } = runMw(p);
    assert.ok(nextCalled, `path ${p} should be whitelisted`);
    assert.equal(state.ended, false);
  }
});

test("auth: comma-separated CLAUDE_PROXY_API_KEYS enables key rotation (both keys accepted)", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEYS = "key-OLD, key-NEW";
  const a = runMw("/v1/chat/completions", "Bearer key-OLD");
  assert.ok(a.nextCalled);
  const b = runMw("/v1/chat/completions", "Bearer key-NEW");
  assert.ok(b.nextCalled);
  const c = runMw("/v1/chat/completions", "Bearer key-WRONG");
  assert.equal(c.state.statusCode, 401);
});

test("auth: empty Bearer token (`Authorization: Bearer `) returns 401", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEY = "secret-A";
  const { state, nextCalled } = runMw("/v1/chat/completions", "Bearer ");
  assert.equal(state.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("auth: case-insensitive 'bearer' scheme accepted", () => {
  clearKeys();
  process.env.CLAUDE_PROXY_API_KEY = "secret-A";
  const { state, nextCalled } = runMw("/v1/chat/completions", "bearer secret-A");
  assert.ok(nextCalled);
  assert.equal(state.ended, false);
});

test.after(() => {
  delete process.env.CLAUDE_PROXY_API_KEY;
  delete process.env.CLAUDE_PROXY_API_KEYS;
});
