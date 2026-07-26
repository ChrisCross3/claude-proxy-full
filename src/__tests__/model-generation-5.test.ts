/**
 * Coverage for the current model generation (Fable 5 / Opus 5 / Sonnet 5) and
 * for the two places that used to keep their own idea of which models exist:
 * the pricing book and the metrics canonicalizer.
 *
 * The metrics canonicalizer had drifted to the point of naming a model the
 * request never used (`opus` → 4-6 while the registry resolved `opus` → 4-7).
 * It now asks the registry, so the assertion below is about that relationship
 * rather than about a specific pair of strings.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, resolveModel } from "../models/registry.js";
import { priceForModel, normalizeModel } from "../server/pricing.js";
import { canonicalizeMetricModel } from "../server/metrics.js";
import { phaseProgressEnabled } from "../server/phase-tracker.js";
import { UPSTREAM_SOFT_DEAD_MS, DESCENDANT_GRACE_CAP_MS } from "../server/watchdog.js";

const CURRENT_GENERATION = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"] as const;

// --- registry --------------------------------------------------------------

test("registry: the current generation is present", () => {
  for (const id of CURRENT_GENERATION) {
    const def = resolveModel(id);
    assert.ok(def, `${id} missing from the registry`);
    assert.equal(def.id, id);
  }
});

test("registry: the current generation carries the full effort ladder", () => {
  // Effort is the only depth control on these models — a missing level means
  // the proxy rejects a request the API would have accepted.
  for (const id of CURRENT_GENERATION) {
    const def = resolveModel(id)!;
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      assert.ok(def.effortLevels.includes(level), `${id} is missing effort ${level}`);
    }
  }
});

test("registry: short aliases resolve for the current generation", () => {
  assert.equal(resolveModel("fable-5")?.id, "claude-fable-5");
  assert.equal(resolveModel("opus-5")?.id, "claude-opus-5");
  assert.equal(resolveModel("sonnet-5")?.id, "claude-sonnet-5");
});

test("registry: no two models claim the same alias", () => {
  // A duplicate alias makes resolution order-dependent, i.e. silently wrong.
  const seen = new Map<string, string>();
  for (const m of MODELS) {
    for (const a of [m.id, ...m.aliases]) {
      const prev = seen.get(a);
      assert.equal(prev, undefined, `alias "${a}" claimed by both ${prev} and ${m.id}`);
      seen.set(a, m.id);
    }
  }
});

// --- pricing ---------------------------------------------------------------

test("pricing: every registry model has a price", () => {
  // Without this, cost estimation silently falls back and under-reports.
  for (const m of MODELS) {
    const price = priceForModel(m.id);
    assert.ok(price, `no price for ${m.id}`);
    assert.ok(price.inputPer1M > 0, `${m.id} has no input price`);
    assert.ok(price.outputPer1M > 0, `${m.id} has no output price`);
  }
});

test("pricing: the current generation is priced as published", () => {
  assert.equal(priceForModel("claude-fable-5").inputPer1M, 10);
  assert.equal(priceForModel("claude-fable-5").outputPer1M, 50);
  assert.equal(priceForModel("claude-opus-5").inputPer1M, 5);
  assert.equal(priceForModel("claude-opus-5").outputPer1M, 25);
  // List price, deliberately not the intro price that lapses 2026-08-31 —
  // estimating high is recoverable, estimating low is a surprise on the bill.
  assert.equal(priceForModel("claude-sonnet-5").inputPer1M, 3);
  assert.equal(priceForModel("claude-sonnet-5").outputPer1M, 15);
});

test("pricing: normalizeModel maps prefixed and suffixed ids to the base", () => {
  assert.equal(normalizeModel("anthropic/claude-fable-5"), "claude-fable-5");
  assert.equal(normalizeModel("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(normalizeModel("claude-sonnet-5-20260101"), "claude-sonnet-5");
});

// --- metrics canonicalizer -------------------------------------------------

test("metrics: short aliases agree with the registry", () => {
  // The regression that motivated this: the label said 4-6 while the request
  // ran on whatever the registry resolved. Asserting the *relationship* means
  // moving the alias in the registry can never desynchronise the metric again.
  for (const alias of ["opus", "sonnet", "haiku", "best"]) {
    const expected = resolveModel(alias)?.id;
    if (!expected) continue; // alias not in use
    assert.equal(canonicalizeMetricModel(alias), expected, `metric label for "${alias}" disagrees with the registry`);
  }
});

test("metrics: the current generation gets its own label", () => {
  for (const id of CURRENT_GENERATION) {
    assert.equal(canonicalizeMetricModel(id), id);
  }
});

test("metrics: provider prefixes and [1m] suffixes fold into the base label", () => {
  assert.equal(canonicalizeMetricModel("anthropic/claude-opus-5"), "claude-opus-5");
  assert.equal(canonicalizeMetricModel("claude-proxy/claude-fable-5"), "claude-fable-5");
  assert.equal(canonicalizeMetricModel("claude-opus-4-8[1m]"), "claude-opus-4-8");
});

test("metrics: legacy ids keep their existing label", () => {
  // These are not in the registry; their time series must not break.
  assert.equal(canonicalizeMetricModel("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(canonicalizeMetricModel("claude-opus-4"), "claude-opus-4");
});

test("metrics: unknown and empty stay bounded", () => {
  assert.equal(canonicalizeMetricModel("openai/gpt-5"), "other");
  assert.equal(canonicalizeMetricModel(""), "unknown");
});

// --- phase progress flag ---------------------------------------------------

test("phase progress: off by default", () => {
  // Default matters: these lines ship as assistant deltas, so on-by-default
  // means visible flicker in any client that renders deltas as they arrive.
  const prev = process.env.CLAUDE_PROXY_PHASE_PROGRESS;
  delete process.env.CLAUDE_PROXY_PHASE_PROGRESS;
  try {
    assert.equal(phaseProgressEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PROXY_PHASE_PROGRESS = prev;
  }
});

test("phase progress: opt-in accepts the usual truthy spellings", () => {
  const prev = process.env.CLAUDE_PROXY_PHASE_PROGRESS;
  try {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.CLAUDE_PROXY_PHASE_PROGRESS = v;
      assert.equal(phaseProgressEnabled(), true, `"${v}" should enable`);
    }
    for (const v of ["0", "false", "no", "off", "", "   "]) {
      process.env.CLAUDE_PROXY_PHASE_PROGRESS = v;
      assert.equal(phaseProgressEnabled(), false, `"${v}" should not enable`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROXY_PHASE_PROGRESS;
    else process.env.CLAUDE_PROXY_PHASE_PROGRESS = prev;
  }
});

// --- watchdog thresholds ---------------------------------------------------

test("watchdog: the silence threshold tolerates a long thinking stretch", () => {
  // None of the watchdog's liveness signals see a CLI that is thinking hard
  // and emitting nothing, so the threshold has to cover a realistic worst-case
  // reasoning stretch or it kills work in progress.
  assert.ok(
    UPSTREAM_SOFT_DEAD_MS >= 900_000,
    `soft-dead threshold ${UPSTREAM_SOFT_DEAD_MS}ms is too tight for a long thinking phase`,
  );
});

test("watchdog: the descendant grace cap stays above the silence threshold", () => {
  // If the cap fell to or below the threshold it would pre-empt the
  // descendant-activity suppression entirely, making that logic dead code.
  assert.ok(DESCENDANT_GRACE_CAP_MS > UPSTREAM_SOFT_DEAD_MS);
});
