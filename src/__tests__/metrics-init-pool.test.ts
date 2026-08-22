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

/* ---------------------------------------------------------------------------
 * Folgebefund 2: die Ausgabe kennt ihren eigenen Ausfall nicht.
 *
 * Die Zähler oben sind vollständig — und trotzdem ist eine Wand aus Nullen
 * zweideutig. `warm_hits_total 0`, `size{state="live"} 0` bedeutet entweder
 * "der Vorrat ist abgeschaltet" oder "es kam nur noch kein Verkehr". Genau
 * diese Verwechslung hat den toten Vorrat 3,5 Tage überleben lassen; ein
 * Messwerkzeug, dessen Ausfall wie ein Messergebnis aussieht, ist keines.
 *
 * Es gibt ZWEI Schalter, und sie bedeuten Verschiedenes:
 *   - `CLAUDE_PROXY_INIT_POOL=0`  → der ganze Vorrat ist aus (`ENABLED`),
 *   - `CLAUDE_PROXY_BARE_POOL=0` bzw. `..._SIZE=0` → nur das Vorwärmen der
 *     isolierten (`injectOAuthEnv`-)Konfigurationen ist aus
 *     (`ISOLATED_ENABLED`); der Default-Vorrat arbeitet weiter.
 * Aus /metrics muss beides OHNE Kenntnis der Umgebungsvariablen ablesbar sein.
 *
 * Testbarkeit: `ENABLED` und `ISOLATED_ENABLED` werden in init-pool.ts beim
 * Modul-Laden aus `process.env` festgeschrieben. Es gibt für dieses Problem
 * schon ein Verfahren im Repo — `runtime.test.ts` tauscht `process.env` in
 * einem `worker_threads`-Worker aus und importiert das Modul dort dynamisch.
 * Das wird hier übernommen, damit kein Produktivcode eine Naht bekommt, die
 * niemand gebraucht hat. Der Worker importiert `metrics.js`, weil die Aussage
 * die *gerenderte* Ausgabe ist, nicht der Stats-Schnappschuss.
 * ------------------------------------------------------------------------- */

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname_ip = path.dirname(fileURLToPath(import.meta.url));
// dist/__tests__/.. → dist/server/metrics.js nach dem Build. Muss eine
// file://-URL sein, sonst lehnt der ESM-Loader den Windows-Pfad `C:\...` ab.
const METRICS_MODULE = pathToFileURL(
  path.resolve(__dirname_ip, "..", "server", "metrics.js"),
).href;

/**
 * Rendert /metrics in einem frischen Modul-Register mit dem gegebenen env und
 * gibt nur die Init-Pool-Zeilen zurück.
 */
function renderWithEnv(env: Record<string, string | undefined>): Promise<string[]> {
  const code = [
    `process.env = ${JSON.stringify({ PATH: process.env.PATH, ...env })};`,
    `(async () => {`,
    `  const m = await import(${JSON.stringify(METRICS_MODULE)});`,
    `  const lines = m.renderMetrics().split(${JSON.stringify("\n")})`,
    `    .filter((l) => l.includes("claude_proxy_init_pool"));`,
    `  require("node:worker_threads").parentPort.postMessage({ lines });`,
    `})().catch((err) => {`,
    `  require("node:worker_threads").parentPort.postMessage({ error: String(err) });`,
    `});`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true });
    w.on("message", (msg: { lines?: string[]; error?: string }) => {
      w.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.lines!);
    });
    w.on("error", reject);
  });
}

/** Wert eines Samples ohne Labels, oder undefined wenn die Zeile fehlt. */
function sampleValue(lines: string[], name: string): string | undefined {
  const hit = lines.find((l) => l.startsWith(name + " "));
  return hit ? hit.slice(name.length + 1) : undefined;
}

const ENV_ALL_ON = {};
const ENV_POOL_OFF = { CLAUDE_PROXY_INIT_POOL: "0" };
const ENV_ISOLATED_OFF = { CLAUDE_PROXY_BARE_POOL: "0" };
const ENV_ISOLATED_SIZE_0 = { CLAUDE_PROXY_BARE_POOL_SIZE: "0" };

test("ein abgeschalteter Vorrat sieht in der Ausgabe anders aus als ein leerlaufender", async () => {
  // Das ist der Kern des Befundes: heute sind die beiden Ausgaben
  // zeichengleich, und damit ist der Ausfall des Vorrats unsichtbar.
  const on = await renderWithEnv(ENV_ALL_ON);
  const off = await renderWithEnv(ENV_POOL_OFF);

  assert.notDeepEqual(
    off,
    on,
    "CLAUDE_PROXY_INIT_POOL=0 erzeugt dieselbe Ausgabe wie ein angeschalteter, " +
      "aber unbenutzter Vorrat — der Ausfall ist aus /metrics nicht ablesbar",
  );
});

test("abgeschaltetes Vorwärmen der isolierten Konfigurationen ist in der Ausgabe sichtbar", async () => {
  const on = await renderWithEnv(ENV_ALL_ON);
  const isolatedOff = await renderWithEnv(ENV_ISOLATED_OFF);

  assert.notDeepEqual(
    isolatedOff,
    on,
    "CLAUDE_PROXY_BARE_POOL=0 erzeugt dieselbe Ausgabe wie ein vollständig " +
      "angeschalteter Vorrat — die Teilabschaltung ist unsichtbar",
  );
});

test("die beiden Schalter sind in der Ausgabe voneinander zu unterscheiden", async () => {
  // Der Unterschied ist echt: bei CLAUDE_PROXY_BARE_POOL=0 arbeitet der
  // Default-Vorrat weiter, bei CLAUDE_PROXY_INIT_POOL=0 arbeitet nichts mehr.
  const poolOff = await renderWithEnv(ENV_POOL_OFF);
  const isolatedOff = await renderWithEnv(ENV_ISOLATED_OFF);

  assert.notDeepEqual(
    poolOff,
    isolatedOff,
    "ganzer Vorrat aus und nur die isolierten Konfigurationen aus sehen gleich aus",
  );
});

test("der Zustand beider Schalter steht als 0/1-gauge in der Ausgabe", async () => {
  const on = await renderWithEnv(ENV_ALL_ON);
  assert.equal(sampleValue(on, "claude_proxy_init_pool_enabled"), "1");
  assert.equal(sampleValue(on, "claude_proxy_init_pool_isolated_enabled"), "1");

  const poolOff = await renderWithEnv(ENV_POOL_OFF);
  assert.equal(sampleValue(poolOff, "claude_proxy_init_pool_enabled"), "0");
  // Wirksamer Zustand, nicht der rohe Schalter: wenn der ganze Vorrat aus ist,
  // wärmt auch nichts Isoliertes vor. Eine 1 an dieser Stelle wäre genau die
  // Lüge, die dieser Befund abstellt.
  assert.equal(
    sampleValue(poolOff, "claude_proxy_init_pool_isolated_enabled"),
    "0",
    "bei abgeschaltetem Gesamtvorrat darf das isolierte Vorwärmen nicht als aktiv gemeldet werden",
  );

  const isolatedOff = await renderWithEnv(ENV_ISOLATED_OFF);
  assert.equal(
    sampleValue(isolatedOff, "claude_proxy_init_pool_enabled"),
    "1",
    "CLAUDE_PROXY_BARE_POOL=0 darf den Default-Vorrat nicht als abgeschaltet melden",
  );
  assert.equal(sampleValue(isolatedOff, "claude_proxy_init_pool_isolated_enabled"), "0");
});

test("CLAUDE_PROXY_BARE_POOL_SIZE=0 wirkt in der Ausgabe wie CLAUDE_PROXY_BARE_POOL=0", async () => {
  const size0 = await renderWithEnv(ENV_ISOLATED_SIZE_0);
  assert.equal(sampleValue(size0, "claude_proxy_init_pool_enabled"), "1");
  assert.equal(sampleValue(size0, "claude_proxy_init_pool_isolated_enabled"), "0");
});

test("die Zustands-gauges folgen dem Format der übrigen *_enabled-Metriken der Datei", () => {
  // `claude_proxy_sticky_pool_enabled` und `claude_proxy_trace_store_enabled`
  // sind die vorhandene Redeweise für "arbeitet dieser Teil": ein blanker
  // gauge mit 0 oder 1, ohne Label. Kein neues Format erfinden.
  resetMetrics();
  const lines = renderLines();

  for (const name of ["claude_proxy_init_pool_enabled", "claude_proxy_init_pool_isolated_enabled"]) {
    const samples = lines.filter((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));
    assert.equal(samples.length, 1, `${name}: genau ein Sample erwartet, gefunden ${samples.length}`);
    assert.match(samples[0], new RegExp(`^${name} (0|1)$`), `${name}: kein blanker 0/1-gauge`);
    assert.equal(lines.filter((l) => l.startsWith(`# TYPE ${name} `)).length, 1);
    assert.equal(lines.filter((l) => l.startsWith(`# HELP ${name} `)).length, 1);
    assert.ok(lines.includes(`# TYPE ${name} gauge`), `${name}: muss Typ gauge tragen`);
  }

  // Das Text-Exposition-Format 0.0.4, das dieser Endpunkt im Content-Type
  // ausweist, kennt nur counter/gauge/histogram/summary/untyped. `stateset`
  // und `info` aus OpenMetrics sind dort KEINE gültigen TYPE-Werte.
  for (const l of lines.filter((x) => x.startsWith("# TYPE "))) {
    assert.match(l, /^# TYPE \S+ (counter|gauge|histogram|summary|untyped)$/, `ungültiger TYPE: ${l}`);
  }
});
