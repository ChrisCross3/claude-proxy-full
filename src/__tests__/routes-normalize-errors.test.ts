/**
 * Integration test: verifies that ModelValidationError thrown by
 * normalizeOpenRouterRequest inside an Express route handler is surfaced
 * to the client as HTTP 400 instead of escaping as an unhandled promise
 * rejection.
 *
 * Uses a minimal mock Request/Response (no supertest dependency) to drive
 * the handler directly. The contract verified is the same as what the
 * Express wiring would observe: res.statusCode, res.headersSent, and the
 * JSON envelope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { handleChatCompletions, handleResponses } from '../server/routes.js';

interface MockResponse {
  statusCode: number;
  headersSent: boolean;
  body: unknown;
  ended: boolean;
  headers: Record<string, string>;
}

function makeRes(): { res: Response; state: MockResponse } {
  const state: MockResponse = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    ended: false,
    headers: {},
  };
  const closeHandlers: Array<() => void> = [];
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(v: number) { state.statusCode = v; },
    get headersSent() { return state.headersSent; },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.headersSent = true;
      state.body = payload;
      state.ended = true;
      for (const h of closeHandlers) h();
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return res;
    },
    end() {
      state.ended = true;
      for (const h of closeHandlers) h();
      return res;
    },
    write() { return true; },
  } as unknown as Response;
  return { res, state };
}

function makeReq(body: unknown): Request {
  return {
    body,
    headers: {},
    get(_name: string) { return undefined; },
  } as unknown as Request;
}

test('handleChatCompletions: nested reasoning.effort returns HTTP 400 reasoning_invalid', async () => {
  const { res, state } = makeRes();
  const req = makeReq({
    model: 'anthropic/claude-opus-4-7',
    messages: [{ role: 'user', content: 'Hi' }],
    reasoning: { effort: { level: 'high' } },
  });
  await handleChatCompletions(req, res);
  assert.equal(state.statusCode, 400);
  assert.ok(state.headersSent, 'response should be sent');
  const body = state.body as { error: { code: string; type: string; message: string } };
  assert.equal(body.error.code, 'reasoning_invalid');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /reasoning\.effort must be a string/);
});

test('handleChatCompletions: numeric reasoning.effort returns HTTP 400 reasoning_invalid', async () => {
  const { res, state } = makeRes();
  const req = makeReq({
    model: 'anthropic/claude-opus-4-7',
    messages: [{ role: 'user', content: 'Hi' }],
    reasoning: { effort: 5 },
  });
  await handleChatCompletions(req, res);
  assert.equal(state.statusCode, 400);
  const body = state.body as { error: { code: string } };
  assert.equal(body.error.code, 'reasoning_invalid');
});

test('handleResponses: unknown model id returns HTTP 400 unknown_model (not a process crash)', async () => {
  const { res, state } = makeRes();
  const req = makeReq({ model: 'gpt-4-totally-unknown', input: 'Hi' });
  await handleResponses(req, res);
  assert.equal(state.statusCode, 400);
  assert.ok(state.headersSent);
  const body = state.body as { error: { code: string; type: string } };
  assert.equal(body.error.code, 'unknown_model');
  assert.equal(body.error.type, 'invalid_request_error');
});

test('handleResponses: nested reasoning.effort returns HTTP 400 reasoning_invalid', async () => {
  const { res, state } = makeRes();
  const req = makeReq({
    model: 'anthropic/claude-opus-4-7',
    input: 'Hi',
    reasoning: { effort: { level: 'high' } },
  });
  await handleResponses(req, res);
  assert.equal(state.statusCode, 400);
  assert.ok(state.headersSent);
  const body = state.body as { error: { code: string; type: string } };
  assert.equal(body.error.code, 'reasoning_invalid');
  assert.equal(body.error.type, 'invalid_request_error');
});
