import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenRouterRequest } from '../adapter/openrouter-normalize.js';

test('normalize: top-level reasoning.effort lifts to reasoning_effort (OpenRouter wire form)', () => {
  const req: any = {
    model: 'anthropic/claude-opus-4-7',
    reasoning: { enabled: true, effort: 'xhigh' },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.reasoning_effort, 'xhigh');
});

test('normalize: top-level reasoning.enabled=false maps to thinking=false', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    reasoning: { enabled: false },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.thinking, false);
});

test('normalize: top-level reasoning wins over extra_body.reasoning when both set', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    reasoning: { enabled: true, effort: 'high' },
    extra_body: { reasoning: { enabled: true, effort: 'low' } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.reasoning_effort, 'high');
});

test('normalize: extra_body.reasoning still works when top-level absent', () => {
  const req: any = {
    model: 'claude-opus-4-7',
    extra_body: { reasoning: { enabled: true, effort: 'medium' } },
  };
  normalizeOpenRouterRequest(req);
  assert.equal(req.reasoning_effort, 'medium');
});
