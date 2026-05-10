import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenRouterRequest,
  stripOpenRouterPrefix,
} from '../adapter/openrouter-normalize.js';

test('stripOpenRouterPrefix: strips anthropic/ prefix', () => {
  assert.equal(stripOpenRouterPrefix('anthropic/claude-opus-4-7'), 'claude-opus-4-7');
});

test('stripOpenRouterPrefix: leaves unprefixed ids alone', () => {
  assert.equal(stripOpenRouterPrefix('claude-opus-4-7'), 'claude-opus-4-7');
});

test('stripOpenRouterPrefix: does not strip unknown prefixes', () => {
  assert.equal(stripOpenRouterPrefix('openai/gpt-5'), 'openai/gpt-5');
});

test('normalize: strips model prefix in place', () => {
  const req: any = { model: 'anthropic/claude-opus-4-7' };
  normalizeOpenRouterRequest(req);
  assert.equal(req.model, 'claude-opus-4-7');
});

test('normalize: lifts extra_body.reasoning.effort to reasoning_effort', () => {
  const req: any = {
    model: 'anthropic/claude-opus-4-7',
    extra_body: { reasoning: { enabled: true, effort: 'high' } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.reasoning_effort, 'high');
});

test('normalize: enabled=false maps to thinking=false', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    extra_body: { reasoning: { enabled: false, effort: 'high' } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.thinking, false);
  assert.equal(req.reasoning_effort, undefined);
});

test('normalize: effort=none maps to thinking=false', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    extra_body: { reasoning: { effort: 'none' } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.thinking, false);
  assert.equal(req.reasoning_effort, undefined);
});

test('normalize: does not overwrite explicit top-level reasoning_effort', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    reasoning_effort: 'max',
    extra_body: { reasoning: { effort: 'low' } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.reasoning_effort, 'max');
});

test('normalize: does not overwrite explicit top-level thinking', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    thinking: true,
    extra_body: { reasoning: { enabled: false } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.thinking, true);
});

test('normalize: no-op without extra_body', () => {
  const req: any = { model: 'claude-opus-4-7' };
  normalizeOpenRouterRequest(req);
  assert.deepEqual(req, { model: 'claude-opus-4-7' });
});

test('normalize: idempotent', () => {
  const req: any = {
    model: 'anthropic/claude-sonnet-4-6',
    extra_body: { reasoning: { effort: 'medium' } },
  };
  normalizeOpenRouterRequest(req);
  normalizeOpenRouterRequest(req);
  assert.equal(req.model, 'claude-sonnet-4-6');
  assert.equal(req.reasoning_effort, 'medium');
});

test('normalize: malformed extra_body is ignored', () => {
  const req: any = { model: 'claude-opus-4-7', extra_body: 'nope' };
  normalizeOpenRouterRequest(req);
  assert.equal(req.model, 'claude-opus-4-7');
});

test('normalize: non-string model passes through', () => {
  const req: any = { model: 42 };
  normalizeOpenRouterRequest(req);
  assert.equal(req.model, 42);
});
