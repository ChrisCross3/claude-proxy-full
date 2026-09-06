/**
 * Der Zähler, der die stille Protokolldrift sichtbar macht.
 *
 * ANLASS: das Kontrollprotokoll der CLI ist kein öffentlicher Vertrag — SDK
 * und CLI erscheinen im Gleichschritt und können es gemeinsam ändern. Bricht
 * es, fällt der Proxy auf die Textbrücke zurück. Und die *funktioniert* ja,
 * nur schlechter: gemessen 6 von 10 Aufrufen. Es gäbe also keine
 * Fehlermeldung, sondern nur wieder verlorene Werkzeugaufrufe — die teuerste
 * Sorte Ausfall, weil sie wie Betrieb aussieht.
 *
 * Deshalb zählt der Proxy den WEG, nicht nur das Ergebnis. `text > 0` bei
 * einem Aufrufer, der MCP-Werkzeuge angemeldet hat, ist ein Befund.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordToolCallSource,
  getToolCallSourceCounters,
  resetToolCallSourceForTests,
  renderMetrics,
} from "../server/metrics.js";

test("der Zähler unterscheidet die beiden Wege", () => {
  resetToolCallSourceForTests();
  assert.deepEqual(getToolCallSourceCounters(), { mcp: 0, text: 0 });
  recordToolCallSource("mcp");
  recordToolCallSource("mcp");
  recordToolCallSource("text");
  assert.deepEqual(getToolCallSourceCounters(), { mcp: 2, text: 1 });
  resetToolCallSourceForTests();
});

test("beide Wege stehen in /metrics — auch mit dem Wert 0", () => {
  // Eine fehlende Zeile und eine Zeile mit 0 sehen im Betrieb verschieden aus:
  // die eine heisst "kenne ich nicht", die andere "ist nicht passiert". Nur
  // die zweite taugt als Wache.
  resetToolCallSourceForTests();
  const text = renderMetrics();
  assert.match(text, /claude_proxy_tool_call_source_total\{source="mcp"\} 0/);
  assert.match(text, /claude_proxy_tool_call_source_total\{source="text"\} 0/);
  assert.match(text, /# TYPE claude_proxy_tool_call_source_total counter/);
});

test("der gezählte Weg erscheint auch im Ausdruck", () => {
  resetToolCallSourceForTests();
  recordToolCallSource("mcp");
  recordToolCallSource("text");
  recordToolCallSource("text");
  const text = renderMetrics();
  assert.match(text, /claude_proxy_tool_call_source_total\{source="mcp"\} 1/);
  assert.match(text, /claude_proxy_tool_call_source_total\{source="text"\} 2/);
  resetToolCallSourceForTests();
});
