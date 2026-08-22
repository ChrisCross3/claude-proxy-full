/**
 * Sichtbarkeit des Init-Pools in /metrics.
 *
 * Folgebefund 1: `initPoolCounters` und `initPoolStats()` existierten und
 * zählten korrekt mit — aber `renderMetrics()` hat sie nie ausgegeben. Nur der
 * SessionPool und der StickySessionPool tauchten in der Exposition auf. Genau
 * diese Lücke hat einen toten `--bare`-Vorrat 3,5 Tage überleben lassen: er
 * wurde nie getroffen, `coldSpawns` lief hoch, `warmHits` blieb auf null — und
 * niemand konnte es von außen sehen.
 *
 * Diese Tests halten die Ausgabe fest. Sie starten keinen Prozess und rufen
 * den Pool nicht an; sie setzen die Zähler direkt (das exportierte Objekt ist
 * veränderlich, so wie es die Route auch tut) und prüfen die gerenderten
 * Zeilen.
 *
 * Formatanforderungen aus dem Prometheus-Text-Format 0.0.4 (siehe
 * prometheus.io/docs/instrumenting/exposition_formats und /writing_exporters),
 * die hier mitgeprüft werden:
 *   - je Metrikname höchstens EINE `# TYPE`-Zeile, und sie steht vor dem
 *     ersten Sample,
 *   - monoton steigende Zähler tragen den Suffix `_total` und den Typ
 *     `counter`, Momentanwerte den Typ `gauge`,
 *   - Basiseinheiten statt abgeleiteter: die TTL wird in Sekunden exponiert,
 *     nicht in Millisekunden (das Histogramm in metrics.ts rechnet aus
 *     demselben Grund bereits ms → s um).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderMetrics, resetMetrics } from "../server/metrics.js";
import { initPoolCounters, initPoolStats } from "../subprocess/init-pool.js";

/** Zähler auf bekannte, paarweise verschiedene Werte setzen. */
function seedCounters(): void {
  initPoolCounters.warmHits = 7;
  initPoolCounters.coldSpawns = 3;
  initPoolCounters.discarded = 2;
  initPoolCounters.evictions = 5;
}

function zeroCounters(): void {
  initPoolCounters.warmHits = 0;
  initPoolCounters.coldSpawns = 0;
  initPoolCounters.discarded = 0;
  initPoolCounters.evictions = 0;
}

/** Alle Zeilen der Ausgabe als Menge — Reihenfolge ist hier nicht die Aussage. */
function renderLines(): string[] {
  return renderMetrics().split("\n");
}

test("Init-Pool-Zähler erscheinen als counter in der Metrik-Ausgabe", () => {
  resetMetrics();
  seedCounters();
  const lines = renderLines();

  assert.ok(
    lines.includes("claude_proxy_init_pool_warm_hits_total 7"),
    "warmHits fehlt in der Ausgabe",
  );
  assert.ok(
    lines.includes("claude_proxy_init_pool_cold_spawns_total 3"),
    "coldSpawns fehlt in der Ausgabe",
  );
  assert.ok(
    lines.includes("claude_proxy_init_pool_discarded_total 2"),
    "discarded fehlt in der Ausgabe",
  );
  assert.ok(
    lines.includes("claude_proxy_init_pool_evictions_total 5"),
    "evictions fehlt in der Ausgabe",
  );

  zeroCounters();
});

test("Init-Pool-Zähler werden auch bei null ausgegeben", () => {
  // Ein Zähler, der erst bei der ersten Zählung auftaucht, ist genau die
  // Blindstelle, die hier repariert wird: „noch nie getroffen" und „Metrik
  // nicht vorhanden" dürfen nicht gleich aussehen.
  resetMetrics();
  zeroCounters();
  const lines = renderLines();

  assert.ok(lines.includes("claude_proxy_init_pool_warm_hits_total 0"));
  assert.ok(lines.includes("claude_proxy_init_pool_cold_spawns_total 0"));
  assert.ok(lines.includes("claude_proxy_init_pool_discarded_total 0"));
  assert.ok(lines.includes("claude_proxy_init_pool_evictions_total 0"));
});

test("Init-Pool-Belegung erscheint als gauge im state-Schema der übrigen Pools", () => {
  resetMetrics();
  const stats = initPoolStats();
  const lines = renderLines();

  assert.ok(
    lines.includes(`claude_proxy_init_pool_size{state="live"} ${stats.size}`),
    "size fehlt oder folgt nicht dem state-Schema von claude_proxy_pool_size",
  );
  assert.ok(
    lines.includes(`claude_proxy_init_pool_size{state="max"} ${stats.max}`),
    "max fehlt oder folgt nicht dem state-Schema von claude_proxy_pool_size",
  );
});

test("Leerlauf-TTL wird in Sekunden exponiert, nicht in Millisekunden", () => {
  resetMetrics();
  const stats = initPoolStats();
  const lines = renderLines();

  assert.ok(
    lines.includes(`claude_proxy_init_pool_ttl_seconds ${(stats.ttlMs / 1000).toFixed(3)}`),
    "ttl fehlt oder ist nicht in Sekunden mit drei Nachkommastellen exponiert",
  );
});

test("jede Init-Pool-Metrik trägt genau eine HELP- und eine TYPE-Zeile mit passendem Typ", () => {
  resetMetrics();
  const lines = renderLines();

  const expected: Array<[string, "counter" | "gauge"]> = [
    ["claude_proxy_init_pool_size", "gauge"],
    ["claude_proxy_init_pool_ttl_seconds", "gauge"],
    ["claude_proxy_init_pool_warm_hits_total", "counter"],
    ["claude_proxy_init_pool_cold_spawns_total", "counter"],
    ["claude_proxy_init_pool_discarded_total", "counter"],
    ["claude_proxy_init_pool_evictions_total", "counter"],
  ];

  for (const [name, type] of expected) {
    const help = lines.filter((l) => l.startsWith(`# HELP ${name} `));
    const typeLines = lines.filter((l) => l.startsWith(`# TYPE ${name} `));
    assert.equal(help.length, 1, `${name}: genau eine HELP-Zeile erwartet, gefunden ${help.length}`);
    assert.equal(typeLines.length, 1, `${name}: genau eine TYPE-Zeile erwartet, gefunden ${typeLines.length}`);
    assert.equal(typeLines[0], `# TYPE ${name} ${type}`, `${name}: falscher Metriktyp`);

    // TYPE muss vor dem ersten Sample desselben Namens stehen.
    const typeIdx = lines.indexOf(typeLines[0]);
    const firstSample = lines.findIndex((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));
    assert.ok(firstSample > typeIdx, `${name}: TYPE-Zeile steht nicht vor dem ersten Sample`);
  }
});

test("die Init-Pool-Zeilen kollidieren nicht mit den SessionPool-Zeilen", () => {
  // `claude_proxy_pool_warm_hits_total` und `claude_proxy_init_pool_warm_hits_total`
  // sind verschiedene Metriken. Ein Präfix-Vergleich darf sie nicht verwechseln.
  resetMetrics();
  const lines = renderLines();

  const sessionPoolWarm = lines.filter((l) => l.startsWith("claude_proxy_pool_warm_hits_total"));
  const initPoolWarm = lines.filter((l) => l.startsWith("claude_proxy_init_pool_warm_hits_total"));
  assert.equal(sessionPoolWarm.length, 1);
  assert.equal(initPoolWarm.length, 1);
  assert.notEqual(sessionPoolWarm[0], initPoolWarm[0]);
});
