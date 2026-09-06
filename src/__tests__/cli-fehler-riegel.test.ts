/**
 * Der Riegel, der einen gescheiterten CLI-Zug daran hindert, als Antwort
 * durchzugehen — auf dem stream-json-Weg.
 *
 * WARUM ES DIESE DATEI GIBT (gemessen 2026-09-06 im Tenant, nicht vermutet):
 * bei erschöpftem Kontingent lieferte der Proxy **HTTP 200** mit
 *
 *   "API Error: Request rejected (429) · This request would exceed your
 *    account's rate limit. Please try again later."
 *
 * als Inhalt der Assistenten-Nachricht und `finish_reason: "stop"` — auf dem
 * Lead-Pfad wie auf dem isolierten. Honchos Deriver hätte diesen Satz als
 * **abgeleiteten Fakt** ins Langzeitgedächtnis geschrieben.
 *
 * Der Klassifizierer war längst da; er hing nur an den Print-Mode-Pfaden. Die
 * drei stream-json-Antwortbauer hatten ihn nicht — und stream-json ist die
 * Laufzeit, die heute alles benutzt.
 *
 * An der Primärquelle nachgemessen: die CLI meldet dabei `subtype: "success"`
 * UND `is_error: true`. Deshalb prüfen die Fälle unten **beides**.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendeCliFehlerFallsGescheitert } from "../server/routes.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { TraceBuilder } from "../trace/builder.js";

/** Die Projektwurzel: von dieser Datei aufwaerts, bis eine package.json liegt. */
function projektwurzel(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, "package.json"))) return d;
    d = dirname(d);
  }
  throw new Error("Projektwurzel nicht gefunden - der Stolperdraht kann nichts pruefen.");
}
/** Antwort-Attrappe, die mitschreibt statt zu senden. */
function attrappeRes(opts: { headersSent?: boolean; writableEnded?: boolean } = {}) {
  const geschrieben: string[] = [];
  let statusCode = 200;
  let koerper: unknown;
  let beendet = false;
  return {
    get headersSent() { return opts.headersSent ?? false; },
    get writableEnded() { return opts.writableEnded ?? false; },
    status(c: number) { statusCode = c; return this; },
    json(b: unknown) { koerper = b; return this; },
    write(s: string) { geschrieben.push(s); return true; },
    end() { beendet = true; },
    // Auslesbar für die Zusicherungen:
    _statusCode: () => statusCode,
    _koerper: () => koerper,
    _geschrieben: () => geschrieben,
    _beendet: () => beendet,
  };
}

/** Ablaufspur-Attrappe: merkt sich nur, was gemeldet wurde. */
function attrappeTb() {
  const fehler: Array<{ cls: string; message?: string }> = [];
  let commits = 0;
  const tb = {
    traceId: "trc_test",
    setRuntime() {}, setMessageCount() {}, setBridgeTools() {}, addToolCall() {},
    addToolResult() {}, addMcpDecision() {}, setFinishReason() {}, setUsage() {},
    setError(cls: string, message?: string) { fehler.push({ cls, message }); },
    setFallback() {}, setSessionMode() {}, setSessionWarmHit() {}, setStickySession() {},
    setStickyEviction() {}, setToolCallParseSource() {},
    commit() { commits += 1; },
  };
  return { tb: tb as unknown as TraceBuilder, fehler, commits: () => commits };
}

const ERGEBNIS = (over: Partial<ClaudeCliResult>) =>
  ({ type: "result", subtype: "success", is_error: false, result: "OK", ...over }) as ClaudeCliResult;

test("ein gelungener Zug geht unveraendert weiter", () => {
  const res = attrappeRes();
  const { tb, commits } = attrappeTb();
  assert.equal(sendeCliFehlerFallsGescheitert(ERGEBNIS({}), res as never, tb), false);
  assert.equal(res._koerper(), undefined);
  assert.equal(commits(), 0, "ein gelungener Zug darf die Spur nicht vorzeitig schliessen");
});

test("DER FALL AUS DEM TENANT: 429 wird zu HTTP 429, nicht zu einer Antwort", () => {
  // subtype 'success' UND is_error true — genau so meldet es die CLI.
  const res = attrappeRes();
  const { tb, fehler } = attrappeTb();
  const text =
    "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
  assert.equal(
    sendeCliFehlerFallsGescheitert(ERGEBNIS({ subtype: "success", is_error: true, result: text }), res as never, tb),
    true,
  );
  assert.equal(res._statusCode(), 429);
  const k = res._koerper() as { error: { type: string; code: string; message: string } };
  assert.equal(k.error.type, "rate_limit_error");
  assert.equal(k.error.code, "rate_limit_exceeded");
  assert.match(k.error.message, /rate limit/i);
  assert.deepEqual(fehler.map((f) => f.cls), ["rate_limit"]);
});

test("fehlende Anmeldung wird zu HTTP 401", () => {
  const res = attrappeRes();
  const { tb } = attrappeTb();
  assert.equal(
    sendeCliFehlerFallsGescheitert(
      ERGEBNIS({ is_error: true, result: "Not logged in · Please run /login" }),
      res as never,
      tb,
    ),
    true,
  );
  assert.equal(res._statusCode(), 401);
});

test("bei offenem SSE-Strom geht der Fehler IN den Strom, nicht als Status", () => {
  // Der Status ist dann schon vergeben. Ein Fehler, der als fertige Nachricht
  // getarnt in den Strom liefe, waere wieder der stille Ausfall.
  const res = attrappeRes({ headersSent: true });
  const { tb } = attrappeTb();
  assert.equal(
    sendeCliFehlerFallsGescheitert(ERGEBNIS({ is_error: true, result: "overloaded" }), res as never, tb),
    true,
  );
  assert.equal(res._statusCode(), 200, "der Status darf nachtraeglich nicht mehr angefasst werden");
  const g = res._geschrieben();
  assert.equal(g.length, 2);
  assert.match(g[0], /"type":"overloaded_error"/);
  assert.equal(g[1], "data: [DONE]\n\n");
  assert.equal(res._beendet(), true);
});

test("ein bereits geschlossener Strom bekommt nichts mehr geschrieben", () => {
  const res = attrappeRes({ headersSent: true, writableEnded: true });
  const { tb } = attrappeTb();
  assert.equal(
    sendeCliFehlerFallsGescheitert(ERGEBNIS({ is_error: true, result: "boom" }), res as never, tb),
    true,
  );
  assert.equal(res._geschrieben().length, 0);
});

test("STOLPERDRAHT: alle drei stream-json-Antwortbauer sind verriegelt", () => {
  // Diese Zusicherung ist grob, und das mit Absicht. Der eigentliche Fehler war
  // nicht, dass der Riegel falsch gebaut war — er war RICHTIG gebaut und hing
  // am falschen Tor. Wer einen VIERTEN Antwortbauer ergaenzt, soll hier
  // stolpern und sich entscheiden muessen, statt es stillschweigend zu
  // vergessen.
  // Der Quelltext wird ueber die PROJEKTWURZEL gesucht, nicht ueber
  // import.meta.url und nicht ueber das Arbeitsverzeichnis. Grund: dieselbe
  // Datei laeuft in zwei Gestalten — aus `src/` (tsx) und aus `dist/` (npm
  // test, das dorthin wechselt). Beide Kurzwege zeigen in je einem der Faelle
  // ins Leere, und ein Test, der an seinem eigenen Pfad scheitert, prueft
  // nichts.
  const quelle = readFileSync(resolve(projektwurzel(), "src/server/routes.ts"), "utf8");
  const einbauten = quelle.match(/sendeCliFehlerFallsGescheitert\(result, res, tb\)/g) || [];
  assert.equal(
    einbauten.length,
    3,
    "Lead, /v1/responses und der isolierte Pfad — wer einen weiteren Weg baut, verriegelt ihn und zaehlt hier hoch.",
  );
});
