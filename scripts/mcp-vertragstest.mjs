#!/usr/bin/env node
/**
 * VERTRAGSTEST: spricht der gepinnte claude-CLI das Kontrollprotokoll noch so,
 * wie unsere Werkzeugbrücke es voraussetzt?
 *
 * WARUM ES DAS BRAUCHT. Die Brücke hängt an `sdkMcpServers` im `initialize` und
 * am Untertyp `mcp_message` der `control_request`. Beides ist in Anthropics
 * Dokumentation **nirgends** beschrieben — es sind SDK-Interna, die wir aus
 * einem Mitschnitt der echten Leitung haben. Recherche vom 2026-09-06: dazu
 * stehen mehrere Fälle offen (claude-code #7279 — die Python-Fassung des SDK
 * schickt das Feld gar nicht; claude-agent-sdk-python #597 — Server unsichtbar
 * bei String-Prompts; claude-code #59956 — HTTP-MCP zwischen 2.1.140 und
 * 2.1.142 gebrochen). Ein CLI-Update kann das also still ändern.
 *
 * „Still" ist das teure Wort. Bricht das Protokoll, kommt keine Fehlermeldung —
 * es kommen nur wieder verlorene Werkzeugaufrufe, und das Modell erfindet
 * danach die Ausgabe. Gemessen waren das 4 von 10 Zügen.
 *
 * WAS DIESER TEST ANDERS MACHT ALS A8/A10: die messen das ERGEBNIS (kamen
 * strukturierte Aufrufe an?) und melden im Bruchfall „0/3" — richtig, aber
 * stumm darüber, WO es brach. Dieser Test geht die Stufen einzeln durch und
 * nennt die erste, die fehlt.
 *
 * ER BAUT NICHTS NACH. `buildSpawnArgs` und `handleMcpMessage` sind dieselben
 * Funktionen, die im Betrieb laufen — ein Vertragstest gegen eine Nachbildung
 * würde die Nachbildung prüfen.
 *
 * Aufruf:  node scripts/mcp-vertragstest.mjs [--model claude-haiku-4-5]
 * Exit 0 = Vertrag hält. Exit 1 = gebrochen, mit Angabe der Stufe.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildSpawnArgs } from "../dist/subprocess/stream-json-manager.js";
import { handleMcpMessage, openaiToolsToMcp, MCP_SERVER_NAME } from "../dist/adapter/mcp-bridge.js";
import { resolveEnv } from "../dist/subprocess/manager.js";

const MODELL = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "claude-haiku-4-5";
const FRIST_MS = 120_000;

/** Ein Werkzeug genügt: geprüft wird das Protokoll, nicht der Umfang. */
const WERKZEUGE = openaiToolsToMcp({
  tools: [{
    type: "function",
    function: {
      name: "vertrag_probe",
      description: "Nur zur Vertragspruefung. Wird nie ausgefuehrt.",
      parameters: { type: "object", properties: { x: { type: "string" } } },
    },
  }],
});

const stufen = {
  spawn: false,
  init_beantwortet: false,
  mcp_message_kam: false,
  mcp_initialize: false,
  tools_list: false,
  werkzeug_sichtbar: false,
};

function raus(code, text) {
  const liste = Object.entries(stufen).map(([k, v]) => `${v ? "OK  " : "FEHLT"} ${k}`).join("\n  ");
  console.log(`\nSTUFEN:\n  ${liste}`);
  console.log(`\nVERTRAGSTEST: ${text}`);
  process.exit(code);
}

const env = await resolveEnv({ injectOAuthEnv: true });
const args = await buildSpawnArgs({
  model: MODELL,
  // Dieselbe Härtung wie das isolierte Profil: die pauschale Werkzeugsperre und
  // ein MCP-Werkzeug müssen NEBENEINANDER bestehen. Genau das ist der Teil des
  // Vertrags, der am ehesten kippt.
  bare: true,
  restricted: true,
  strictMcpConfig: true,
  tools: [],
  mcpTools: WERKZEUGE,
  mcpServerName: MCP_SERVER_NAME,
  disallowedTools: ["Bash", "Edit", "Read", "Write"],
});

const kind = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
const schreib = (o) => kind.stdin.write(JSON.stringify(o) + "\n");

const frist = setTimeout(() => {
  kind.kill("SIGKILL");
  raus(1, `GEBROCHEN — nach ${FRIST_MS / 1000}s keine vollstaendige Abfolge. Erste fehlende Stufe oben.`);
}, FRIST_MS);

kind.on("spawn", () => {
  stufen.spawn = true;
  schreib({
    type: "control_request",
    request_id: `req_init_${randomUUID().slice(0, 8)}`,
    request: {
      subtype: "initialize",
      hooks: null,
      excludeDynamicSections: true,
      sdkMcpServers: [MCP_SERVER_NAME],
    },
  });
});

let rest = "";
kind.stdout.on("data", (buf) => {
  rest += buf.toString();
  const zeilen = rest.split("\n");
  rest = zeilen.pop() ?? "";
  for (const z of zeilen) {
    if (!z.trim()) continue;
    let m;
    try { m = JSON.parse(z); } catch { continue; }

    if (m.type === "control_response" && m.response?.subtype === "success") {
      stufen.init_beantwortet = true;
      continue;
    }

    if (m.type === "control_request" && m.request?.subtype === "mcp_message") {
      stufen.mcp_message_kam = true;
      const methode = m.request.message?.method;
      if (methode === "initialize") stufen.mcp_initialize = true;
      if (methode === "tools/list") {
        stufen.tools_list = true;
        // Erst hier ist bewiesen, dass die CLI unsere Werkzeuge WILL.
      }
      const antwort = handleMcpMessage(m.request.message, WERKZEUGE, MCP_SERVER_NAME);
      schreib({
        type: "control_response",
        response: { subtype: "success", request_id: m.request_id, response: { mcp_response: antwort } },
      });
      continue;
    }

    // Die CLI meldet ihre sichtbaren Werkzeuge im system/init. Steht unser
    // Werkzeug dort, hat die pauschale Sperre es NICHT mitgenommen — das ist
    // die Aussage, die `--tools ""` neben `--allowedTools mcp__hermes__*`
    // rechtfertigt.
    if (m.type === "system" && Array.isArray(m.tools)) {
      if (m.tools.some((t) => typeof t === "string" && t.startsWith(`mcp__${MCP_SERVER_NAME}__`))) {
        stufen.werkzeug_sichtbar = true;
      }
    }

    if (stufen.tools_list && stufen.werkzeug_sichtbar) {
      clearTimeout(frist);
      kind.kill("SIGTERM");
      raus(0, "HAELT — sdkMcpServers akzeptiert, mcp_message beantwortet, tools/list abgefragt, Werkzeug trotz Sperre sichtbar.");
    }
  }
});

kind.on("close", (code) => {
  clearTimeout(frist);
  if (stufen.tools_list && stufen.werkzeug_sichtbar) raus(0, "HAELT.");
  raus(1, `GEBROCHEN — CLI endete mit Code ${code}, bevor die Abfolge vollstaendig war.`);
});
