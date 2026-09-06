/**
 * /v1/models — Größen und Fähigkeiten.
 *
 * ANLASS: bis 2026-09-06 trug die Antwort je Modell nur
 * id/object/owned_by/created. Die Registry kannte Kontextfenster,
 * Ausgabegrenze, Effort-Stufen und Thinking — kein Aufrufer konnte sie
 * erfahren. Er musste raten oder fest verdrahten, und eine fest verdrahtete
 * Größe veraltet still.
 *
 * Die Feldnamen sind die der Models-API von Anthropic, nicht erfunden.
 *
 * Diese Tests prüfen zwei verschiedene Dinge, und die Trennung ist Absicht:
 *   1. die FORM (heißen die Felder richtig, sind die Pflichtfelder noch da)
 *   2. die HERKUNFT (kommen die Werte aus der Registry oder stehen sie hier
 *      als Zahl im Code — Letzteres wäre genau die Drift, gegen die
 *      model-drift.test.ts gebaut ist)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleModels } from "../server/routes.js";
import { MODELS, resolveModel } from "../models/registry.js";

/** Minimales Response-Double: fängt nur das JSON ab. */
function fangeAntwort(): { lies: () => Record<string, unknown> } {
  let gefangen: Record<string, unknown> | undefined;
  const res = {
    json(payload: unknown) {
      gefangen = payload as Record<string, unknown>;
      return res;
    },
  };
  handleModels({} as never, res as never);
  return {
    lies: () => {
      assert.ok(gefangen, "handleModels hat nichts geschrieben");
      return gefangen;
    },
  };
}

function eintraege(): Array<Record<string, unknown>> {
  const body = fangeAntwort().lies();
  assert.equal(body.object, "list");
  return body.data as Array<Record<string, unknown>>;
}

test("models: die OpenAI-Pflichtfelder bleiben unangetastet", () => {
  // Zusätzliche Felder ignoriert ein OpenAI-Client; FEHLENDE brechen ihn.
  for (const e of eintraege()) {
    assert.equal(e.object, "model");
    assert.equal(e.owned_by, "anthropic");
    assert.equal(typeof e.id, "string");
    assert.equal(typeof e.created, "number");
  }
});

test("models: jedes Modell der Registry kommt genau einmal vor", () => {
  const ids = eintraege().map((e) => e.id);
  assert.deepEqual([...ids].sort(), MODELS.map((m) => m.id).sort());
  assert.equal(new Set(ids).size, ids.length, "keine Doppelten");
});

test("models: die Größen stammen aus der Registry, nicht aus dem Handler", () => {
  // Das ist der eigentliche Punkt. Ein Handler, der 200000/8192 fest
  // verdrahtet, wäre formal korrekt und inhaltlich falsch — und würde bei der
  // nächsten Registry-Korrektur still auseinanderlaufen.
  for (const e of eintraege()) {
    const def = resolveModel(e.id as string);
    assert.ok(def, `${e.id} nicht auflösbar`);
    assert.equal(e.max_input_tokens, def.contextWindow, `max_input_tokens für ${e.id}`);
    assert.equal(e.max_tokens, def.maxOutputTokens, `max_tokens für ${e.id}`);
    assert.equal(e.display_name, def.name, `display_name für ${e.id}`);
  }
});

test("models: Effort wird je Stufe gemeldet, nicht pauschal", () => {
  for (const e of eintraege()) {
    const def = resolveModel(e.id as string)!;
    const caps = e.capabilities as Record<string, Record<string, unknown>>;
    assert.equal(caps.effort.supported, def.effortLevels.length > 0, `effort.supported für ${e.id}`);
    for (const stufe of ["low", "medium", "high", "xhigh", "max"] as const) {
      const eintrag = caps.effort[stufe] as { supported: boolean };
      assert.equal(
        eintrag.supported,
        def.effortLevels.includes(stufe),
        `effort.${stufe} für ${e.id}`,
      );
    }
  }
});

test("models: Haiku meldet keinen Effort, aber Thinking", () => {
  // Der konkrete Fall, an dem die Registry am 2026-09-06 falsch stand — hier
  // als Stichprobe mit echten Erwartungswerten aus der Anthropic-Doku, damit
  // ein Rückfall auffliegt.
  const haiku = eintraege().find((e) => e.id === "claude-haiku-4-5")!;
  const caps = haiku.capabilities as Record<string, Record<string, unknown>>;
  assert.equal(caps.effort.supported, false, "Haiku 4.5: Default effort — Not supported");
  assert.equal(caps.thinking.supported, true, "Haiku 4.5: Thinking — Extended");
  assert.equal(haiku.max_tokens, 64_000, "Haiku 4.5: 64K Ausgabe");
  assert.equal(caps.context_1m.supported, false, "[1m] lehnt dieses Abo für Haiku ab");
});

test("models: die 1M-Variante wird gemeldet", () => {
  // Ohne diese Angabe muss ein Aufrufer den [1m]-Suffix ausprobieren und
  // fängt dabei ein HTTP 400.
  for (const e of eintraege()) {
    const def = resolveModel(e.id as string)!;
    const caps = e.capabilities as Record<string, Record<string, unknown>>;
    assert.equal(caps.context_1m.supported, def.oneMillionContextVariant, `context_1m für ${e.id}`);
  }
});
