/**
 * Werkzeug-Brücke über MCP.
 *
 * DIE ERWARTUNGSWERTE SIND NICHT AUSGEDACHT. Jede Form unten stammt aus einem
 * Mitschnitt der echten Leitung: das offizielle Agent-SDK gegen unsere CLI
 * 2.1.263, mit einem `tee`-Wrapper dazwischen. Wer eine Zahl oder ein Feld
 * hier ändert, ändert eine Messung — dann bitte neu messen, nicht raten.
 *
 * Was die Brücke ersetzt: einen Textparser, der in 4 von 10 Läufen nichts fand,
 * weil das Modell seine eigene Syntax benutzte. Der Test unten prüft deshalb
 * nicht nur „es kommt etwas heraus", sondern dass **fremde** Werkzeugnamen
 * abgelehnt und **parallele** Aufrufe vollständig übernommen werden.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  openaiToolsToMcp,
  stripMcpPrefix,
  toolUseToOpenAiCall,
  extractToolCallsFromAssistant,
  handleMcpMessage,
  mcpToolPrefix,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
} from "../adapter/mcp-bridge.js";

const WERKZEUGE = {
  tools: [
    {
      type: "function" as const,
      function: {
        name: "terminal",
        description: "Fuehrt ein Shell-Kommando aus.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
    {
      type: "function" as const,
      function: { name: "read_file", description: "Liest eine Datei.", parameters: { type: "object" } },
    },
  ],
};

// --- Schemata hin ---------------------------------------------------------

test("openaiToolsToMcp bringt die Schemata in MCP-Form", () => {
  const t = openaiToolsToMcp(WERKZEUGE as never);
  assert.equal(t.length, 2);
  assert.equal(t[0].name, "terminal");
  assert.equal(t[0].description, "Fuehrt ein Shell-Kommando aus.");
  assert.deepEqual(t[0].inputSchema, WERKZEUGE.tools[0].function.parameters);
  // Aus dem Mitschnitt: das SDK meldet dieses Feld je Werkzeug mit.
  assert.deepEqual(t[0].execution, { taskSupport: "forbidden" });
});

test("openaiToolsToMcp wirft Doppelte weg", () => {
  // Anthropic lehnt doppelte Werkzeugnamen hart ab. Ein verworfener Doppelter
  // ist billiger als eine abgelehnte Anfrage — Hermes' eigener Adapter macht
  // an derselben Stelle dasselbe.
  const doppelt = { tools: [...WERKZEUGE.tools, WERKZEUGE.tools[0]] };
  const t = openaiToolsToMcp(doppelt as never);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.name), ["terminal", "read_file"]);
});

test("openaiToolsToMcp fällt auf ein leeres Objekt-Schema zurück", () => {
  const ohne = { tools: [{ type: "function" as const, function: { name: "x", description: "" } }] };
  assert.deepEqual(openaiToolsToMcp(ohne as never)[0].inputSchema, { type: "object" });
});

// --- Namen ----------------------------------------------------------------

test("das Präfix ist mcp__<server>__", () => {
  assert.equal(mcpToolPrefix("hermes"), "mcp__hermes__");
  assert.equal(mcpToolPrefix(), `mcp__${MCP_SERVER_NAME}__`);
});

test("stripMcpPrefix nimmt nur unsere eigenen Werkzeuge an", () => {
  assert.equal(stripMcpPrefix("mcp__hermes__terminal", "hermes"), "terminal");
  // FREMDE Server müssen abgelehnt werden — sonst würde ein Werkzeug aus
  // einer anderen Quelle als Hermes-Werkzeug durchgereicht.
  assert.equal(stripMcpPrefix("mcp__github__create_issue", "hermes"), undefined);
  assert.equal(stripMcpPrefix("terminal", "hermes"), undefined);
  assert.equal(stripMcpPrefix("mcp_hermes_terminal", "hermes"), undefined);
});

// --- Aufrufe zurück -------------------------------------------------------

const BLOCK = {
  type: "tool_use",
  id: "toolu_01CEuVZMu7mt3eA7kF7hg5ES",
  name: "mcp__hermes__terminal",
  input: { command: "cp /tmp/a.txt /tmp/b.txt && cat /tmp/b.txt" },
  caller: { type: "direct" },
};

test("toolUseToOpenAiCall bildet den Block auf einen OpenAI-Aufruf ab", () => {
  const call = toolUseToOpenAiCall(BLOCK, "hermes");
  assert.ok(call);
  assert.equal(call.id, BLOCK.id);
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "terminal");
  // OpenAI erwartet einen STRING, die CLI liefert ein Objekt.
  assert.equal(typeof call.function.arguments, "string");
  assert.deepEqual(JSON.parse(call.function.arguments), BLOCK.input);
});

test("toolUseToOpenAiCall lehnt ab, was kein eigener Werkzeugaufruf ist", () => {
  assert.equal(toolUseToOpenAiCall({ type: "text", text: "hallo" }, "hermes"), undefined);
  assert.equal(toolUseToOpenAiCall({ ...BLOCK, name: "mcp__fremd__x" }, "hermes"), undefined);
  assert.equal(toolUseToOpenAiCall({ ...BLOCK, id: 42 }, "hermes"), undefined);
  assert.equal(toolUseToOpenAiCall(null, "hermes"), undefined);
});

test("extractToolCallsFromAssistant nimmt PARALLELE Aufrufe vollständig mit", () => {
  // Das ist der Gewinn gegenüber dem Textparser: mehrere Aufrufe stehen als
  // mehrere Blöcke in DERSELBEN Nachricht und kommen zusammen an.
  const msg = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Ich mache beides." },
        BLOCK,
        { ...BLOCK, id: "toolu_zwei", name: "mcp__hermes__read_file", input: { path: "/tmp/x" } },
      ],
    },
  };
  const calls = extractToolCallsFromAssistant(msg, "hermes");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.function.name), ["terminal", "read_file"]);
});

test("extractToolCallsFromAssistant bleibt bei Textantworten leer", () => {
  const msg = { type: "assistant", message: { content: [{ type: "text", text: "nur Text" }] } };
  assert.deepEqual(extractToolCallsFromAssistant(msg, "hermes"), []);
  assert.deepEqual(extractToolCallsFromAssistant({}, "hermes"), []);
});

// --- Der kleine MCP-Server ------------------------------------------------
// Die vier Antwortformen unten sind 1:1 aus dem Mitschnitt.

test("initialize antwortet mit Protokollfassung und Fähigkeiten", () => {
  const a = handleMcpMessage({ method: "initialize", id: 0 }, [], "hermes");
  assert.deepEqual(a, {
    jsonrpc: "2.0",
    id: 0,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "hermes", version: "1.0.0" },
    },
  });
});

test("notifications/initialized bekommt eine leere Antwort mit id 0", () => {
  // Die Benachrichtigung trägt KEINE id; der Mitschnitt zeigt, dass das SDK
  // dann mit id 0 antwortet. Nachgebaut, nicht ausgedacht.
  const a = handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, [], "hermes");
  assert.deepEqual(a, { jsonrpc: "2.0", id: 0, result: {} });
});

test("tools/list liefert genau die angemeldeten Werkzeuge", () => {
  const tools = openaiToolsToMcp(WERKZEUGE as never);
  const a = handleMcpMessage({ method: "tools/list", jsonrpc: "2.0", id: 1 }, tools, "hermes");
  assert.equal(a.id, 1);
  assert.deepEqual((a.result as { tools: unknown[] }).tools, tools);
});

test("tools/call wird nicht ausgeführt, sondern zurückgewiesen", () => {
  // Der Aufruf ist zu diesem Zeitpunkt bereits als tool_calls an Hermes
  // unterwegs. Die Antwort verhindert nur, dass die CLI auf etwas wartet,
  // das nie kommt.
  const a = handleMcpMessage(
    { method: "tools/call", id: 2, params: { name: "terminal", arguments: { command: "ls" } } },
    [],
    "hermes",
  );
  const r = a.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Dispatched by the caller/);
});

test("eine unbekannte Methode bekommt einen FEHLER, kein Schweigen", () => {
  // Der wichtigste Fall der Datei. Eine unbeantwortete Anfrage lässt die CLI
  // warten — ein Hänger ist teurer als ein Fehler, und er sieht im Betrieb
  // aus wie „das Modell denkt noch".
  const a = handleMcpMessage({ method: "resources/list", id: 7 }, [], "hermes");
  assert.equal(a.id, 7);
  assert.equal(a.result, undefined);
  assert.equal(a.error?.code, -32601);
  assert.match(a.error!.message, /resources\/list/);
});

test("auch eine Nachricht ganz ohne Methode bekommt eine Antwort", () => {
  const a = handleMcpMessage({}, [], "hermes");
  assert.equal(a.error?.code, -32601);
});
