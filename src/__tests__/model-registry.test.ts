/**
 * Registry-Tests — jeder Fall hier ist ein FEHLER, der am 2026-09-06
 * tatsaechlich drinstand, nicht eine ausgedachte Moeglichkeit:
 *
 *   - Haiku 4.5 war mit maxOutputTokens 8192 und thinkingSupported=false
 *     eingetragen. Anthropic nennt 64K und "Thinking: Extended".
 *   - Opus 4.6 und Sonnet 4.6 standen auf 200K Kontext; beide haben ein
 *     natives 1M-Fenster.
 *   - Opus 4.7/4.8 standen auf 8192 statt 128K Ausgabe.
 *   - Fable 5.1 (seit 2026-09-01 das aktuelle Fable) fehlte ganz, ebenso
 *     Opus 4.5 und Sonnet 4.5.
 *   - `[1m]` wurde ueberall durchgelassen, obwohl das Abo es fuer Haiku 4.5
 *     und Opus 4.5 mit 400 ablehnt.
 *
 * Die Zahlen stammen aus den Modellseiten von Anthropic (Stand 2026-09-06),
 * die Aussagen ueber [1m] aus einer Messung gegen die CLI im Tenant.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, resolveModel, resolveModelRequest } from "../models/registry.js";
import { resolveModelStrict, ModelValidationError, validateEffortForModel } from "../adapter/openai-to-cli.js";

// --- Eckdaten je Modell ------------------------------------------------
// context, maxOutput, hatEffort, thinking, hat1m
const SPEC: Array<[string, number, number, boolean, boolean, boolean]> = [
  ["claude-fable-5-1",  1_000_000, 128_000, true,  true, true],
  ["claude-opus-5",     1_000_000, 128_000, true,  true, true],
  ["claude-sonnet-5",   1_000_000, 128_000, true,  true, true],
  ["claude-haiku-4-5",    200_000,  64_000, false, true, false],
  ["claude-fable-5",    1_000_000, 128_000, true,  true, true],
  ["claude-opus-4-8",   1_000_000, 128_000, true,  true, true],
  ["claude-opus-4-7",   1_000_000, 128_000, true,  true, true],
  ["claude-opus-4-6",   1_000_000, 128_000, true,  true, true],
  ["claude-sonnet-4-6", 1_000_000, 128_000, true,  true, true],
  ["claude-opus-4-5",     200_000,  64_000, true,  true, false],
  ["claude-sonnet-4-5",   200_000,  64_000, false, true, true],
];

for (const [id, ctx, out, hasEffort, thinking, oneM] of SPEC) {
  test(`registry: ${id} traegt die dokumentierten Eckdaten`, () => {
    const def = resolveModel(id);
    assert.ok(def, `${id} fehlt in der Registry`);
    assert.equal(def.id, id, "kanonische ID muss auf sich selbst aufloesen");
    assert.equal(def.contextWindow, ctx, "contextWindow");
    assert.equal(def.maxOutputTokens, out, "maxOutputTokens");
    assert.equal(def.effortLevels.length > 0, hasEffort, "Effort-Unterstuetzung");
    assert.equal(def.thinkingSupported, thinking, "thinkingSupported");
    assert.equal(def.oneMillionContextVariant, oneM, "oneMillionContextVariant");
  });
}

test("registry: die aktuelle Reihe ist vollstaendig", () => {
  const ids = MODELS.map((m) => m.id);
  for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
    assert.ok(ids.includes(id), `aktuelles Modell ${id} fehlt`);
  }
});

test("registry: Mythos ist bewusst NICHT eingetragen", () => {
  // Trusted-Access-Programm; die CLI antwortet mit "may not exist or you may
  // not have access to it". Ein Eintrag wuerde eine Faehigkeit behaupten,
  // die dieses Konto nicht hat.
  assert.equal(resolveModel("claude-mythos-5-1"), undefined);
  assert.equal(resolveModel("claude-mythos-5"), undefined);
});

// --- Effort-Stufen, wie die Effort-Doku sie je Modell auflistet ---------

test("effort: Haiku 4.5 und Sonnet 4.5 kennen gar keinen Effort", () => {
  for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5"]) {
    const def = resolveModelStrict(id);
    assert.equal(def.effortLevels.length, 0);
    assert.throws(
      () => validateEffortForModel(def, "high"),
      (e: unknown) => e instanceof ModelValidationError && e.code === "effort_unsupported",
      `${id} muss Effort ablehnen`,
    );
  }
});

test("effort: die 4.6er koennen max, aber NICHT xhigh", () => {
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
    const def = resolveModelStrict(id);
    validateEffortForModel(def, "max"); // wirft nicht
    assert.throws(
      () => validateEffortForModel(def, "xhigh"),
      (e: unknown) => e instanceof ModelValidationError && e.code === "effort_unsupported",
      `${id} darf xhigh nicht annehmen`,
    );
  }
});

test("effort: Opus 4.5 kennt nur low/medium/high", () => {
  const def = resolveModelStrict("claude-opus-4-5");
  validateEffortForModel(def, "high");
  for (const stufe of ["xhigh", "max"] as const) {
    assert.throws(
      () => validateEffortForModel(def, stufe),
      (e: unknown) => e instanceof ModelValidationError && e.code === "effort_unsupported",
    );
  }
});

test("effort: die aktuelle Spitze kennt alle fuenf Stufen", () => {
  for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) {
    const def = resolveModelStrict(id);
    for (const stufe of ["low", "medium", "high", "xhigh", "max"] as const) {
      validateEffortForModel(def, stufe);
    }
  }
});

// --- [1m]-Suffix -------------------------------------------------------

test("[1m]: wird auf freigeschalteten Modellen angenommen", () => {
  for (const id of ["claude-opus-5", "claude-sonnet-4-5", "claude-opus-4-6"]) {
    const def = resolveModelStrict(`${id}[1m]`);
    assert.equal(def.id, id);
  }
});

test("[1m]: wird abgelehnt, wo das Abo es nicht hat", () => {
  for (const id of ["claude-haiku-4-5", "claude-opus-4-5"]) {
    assert.throws(
      () => resolveModelStrict(`${id}[1m]`),
      (e: unknown) => e instanceof ModelValidationError && e.code === "one_million_context_unsupported",
      `${id}[1m] muss frueh scheitern statt an der API`,
    );
  }
});

test("[1m]: der Rueckweg bleibt nachsichtig", () => {
  // resolveModel laeuft auch in cli-to-openai; eine Antwort darf nicht daran
  // scheitern, dass eine Variante nicht freigeschaltet ist.
  assert.equal(resolveModel("claude-haiku-4-5[1m]")?.id, "claude-haiku-4-5");
  assert.equal(resolveModelRequest("claude-haiku-4-5[1m]")?.oneMillionRequested, true);
  assert.equal(resolveModelRequest("claude-haiku-4-5")?.oneMillionRequested, false);
});

// --- Aliase ------------------------------------------------------------

test("aliase: die kurzen Namen zeigen auf die AKTUELLE Generation", () => {
  // Die CLI-Hilfe definiert einen blossen Alias als "an alias for the latest
  // model". Bis 2026-09-06 zeigte 'opus' hier auf 4.7 und 'sonnet' auf 4.6.
  assert.equal(resolveModel("opus")?.id, "claude-opus-5");
  assert.equal(resolveModel("best")?.id, "claude-opus-5");
  assert.equal(resolveModel("sonnet")?.id, "claude-sonnet-5");
  assert.equal(resolveModel("fable")?.id, "claude-fable-5-1");
  assert.equal(resolveModel("haiku")?.id, "claude-haiku-4-5");
});

test("aliase: die datierten Schnappschuss-IDs loesen auf", () => {
  assert.equal(resolveModel("claude-haiku-4-5-20251001")?.id, "claude-haiku-4-5");
  assert.equal(resolveModel("claude-opus-4-5-20251101")?.id, "claude-opus-4-5");
  assert.equal(resolveModel("claude-sonnet-4-5-20250929")?.id, "claude-sonnet-4-5");
});

test("aliase: keine ID und kein Alias kommt doppelt vor", () => {
  // Ein doppelter Alias waere still: resolveModel nimmt den ersten Treffer,
  // und welcher das ist, haengt an der Reihenfolge im Array.
  const gesehen = new Map<string, string>();
  for (const def of MODELS) {
    for (const name of [def.id, ...def.aliases]) {
      const vorher = gesehen.get(name);
      assert.equal(vorher, undefined, `'${name}' steht bei ${vorher} UND bei ${def.id}`);
      gesehen.set(name, def.id);
    }
  }
});
