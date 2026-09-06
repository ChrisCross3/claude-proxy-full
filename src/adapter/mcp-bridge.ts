/**
 * Werkzeug-Brücke über MCP statt über Text.
 *
 * WARUM ES DAS GIBT — die Textbrücke war eine Wette, und sie ging in 40 % der
 * Fälle verloren. Der Proxy schrieb Hermes' Werkzeugschemata als ~35 KB JSON in
 * den Prompt und bat das Modell, mit `{"tool_call":{…}}` zu antworten. Gemessen
 * am 2026-09-06 über zehn Läufe: vier Fehlschläge. In jedem schrieb das Modell
 * das Kommando VOLLSTÄNDIG hin — nur in seiner eigenen Syntax
 * (`<invoke name="terminal">`) oder als ```bash-Block. Beides liest der
 * Text-Parser nicht, Hermes führte nichts aus, und das Modell **erfand**
 * anschließend die Ausgabe, die es nie bekommen hatte.
 *
 * Der Grund dafür ist banal: das Modell hält Hermes' Werkzeuge für SEINE und
 * ruft sie so auf, wie es seine eigenen aufruft. Die Lösung ist deshalb nicht,
 * besser zu bitten, sondern die Werkzeuge ECHT zu machen.
 *
 * WIE — die CLI kann Werkzeuge aus dem Elternprozess bedienen: beim
 * `initialize` nennt man Servernamen (`sdkMcpServers`), danach fragt die CLI
 * über `control_request`/`mcp_message` einen kleinen MCP-Server ab, den der
 * Elternprozess stellt. Das Modell sieht damit echte Werkzeuge und liefert
 * strukturierte `tool_use`-Blöcke. **Ausgeführt wird trotzdem nichts hier** —
 * wir lesen den Aufruf und reichen ihn als OpenAI-`tool_calls` an Hermes weiter,
 * das ihn wie bisher selbst ausführt.
 *
 * DIE FORMEN IN DIESER DATEI SIND NICHT ERFUNDEN. Sie stammen aus einem
 * Mitschnitt der echten Leitung: das offizielle SDK gegen unsere CLI 2.1.263,
 * mit einem `tee`-Wrapper dazwischen. Wer sie ändert, misst bitte neu.
 *
 * Gegenprobe zur Sperre: die CLI wurde dabei mit `--tools ""` gestartet — die
 * pauschale Werkzeugsperre und ein MCP-Werkzeug schließen einander NICHT aus.
 * Anthropic sagt das auch: *"tools: [] — All built-ins are removed. Claude can
 * only use your MCP tools."*
 */

import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";

/** Protokollfassung, die unsere CLI im Mitschnitt angeboten hat. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** Servername, unter dem Hermes' Werkzeuge laufen. Er steckt im Werkzeugnamen. */
export const MCP_SERVER_NAME = "hermes";

/** Fassung, die wir als Server melden. Rein informativ für die CLI. */
export const MCP_SERVER_VERSION = "1.0.0";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Aus dem Mitschnitt übernommen: das SDK meldet je Werkzeug
   * `execution: { taskSupport: "forbidden" }`. Wir tun dasselbe — unsere
   * Werkzeuge kann die CLI ohnehin nicht als Hintergrundaufgabe fahren, sie
   * führt sie ja gar nicht aus.
   */
  execution: { taskSupport: "forbidden" };
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}


/**
 * Die Protokollfassung, mit der wir auf ein `initialize` antworten.
 *
 * WARUM NICHT EINFACH UNSERE EIGENE: die MCP-Spezifikation schreibt es vor.
 * Wörtlich (Lifecycle, Abschnitt „Version Negotiation"):
 *
 *   *"If the server supports the requested protocol version, it MUST respond
 *   with the same version. Otherwise, the server MUST respond with another
 *   protocol version it supports. […] If the client does not support the
 *   version in the server's response, it SHOULD disconnect."*
 *
 * Hier stand vorher die feste Fassung aus dem Mitschnitt. Das ging gut, weil
 * die gepinnte CLI 2.1.263 genau diese anfragt — es war aber Zufall, kein
 * Vertrag. Fragt eine neuere CLI eine neuere Fassung an, hätten wir mit einer
 * älteren geantwortet, und die Spec erlaubt dem Client dann ausdrücklich, die
 * Verbindung zu trennen. Das wäre wieder ein **stiller** Ausfall: keine
 * Werkzeuge, keine Fehlermeldung, nur wieder erfundene Werkzeugausgaben.
 *
 * Warum wir jede angefragte Fassung annehmen dürfen: unsere Oberfläche ist
 * `tools/list` und `tools/call`. Beide sind seit der ersten Fassung unverändert
 * — wir benutzen nichts, was zwischen den Revisionen strittig wäre. Ein Server,
 * der nur diesen Kern spricht, „unterstützt" jede dieser Fassungen.
 *
 * Bekannt und bewusst nicht behandelt: ab der Fassung **2026-07-28** trägt
 * JEDE Anfrage ihre Fassung in `_meta` statt nur der Handshake, und ein Server
 * lehnt Unbekanntes mit `UnsupportedProtocolVersionError` ab. Solange die CLI
 * das nicht schickt, wäre das Vorratsbau — es steht hier, damit es beim
 * nächsten Bruch nicht neu recherchiert werden muss.
 */
export function verhandelteFassung(params: unknown): string {
  const p = params as { protocolVersion?: unknown } | undefined;
  const angefragt = p?.protocolVersion;
  return typeof angefragt === "string" && angefragt.length > 0 ? angefragt : MCP_PROTOCOL_VERSION;
}

/** `mcp__<server>__` — das Präfix, das die CLI jedem MCP-Werkzeug voranstellt. */
export function mcpToolPrefix(server: string = MCP_SERVER_NAME): string {
  return `mcp__${server}__`;
}

/**
 * OpenAI-Werkzeugschemata in die MCP-Form bringen.
 *
 * Dedupliziert nach Namen. Der Grund ist nicht Ordnungsliebe: doppelte
 * Werkzeugnamen sind bei Anthropic ein harter Fehler, und Hermes' eigener
 * Adapter macht an derselben Stelle dasselbe (mit Verweis auf ihren Fall
 * #18478). Ein stiller Ausfall wäre hier teurer als ein verworfener Doppelter.
 */
export function openaiToolsToMcp(req: Pick<OpenAIChatRequest, "tools">): McpToolDef[] {
  const out: McpToolDef[] = [];
  const gesehen = new Set<string>();
  for (const tool of req.tools || []) {
    if (tool.type !== "function") continue;
    const name = tool.function?.name;
    if (!name || gesehen.has(name)) continue;
    gesehen.add(name);
    out.push({
      name,
      description: tool.function.description || "",
      inputSchema: (tool.function.parameters as Record<string, unknown>) || { type: "object" },
      execution: { taskSupport: "forbidden" },
    });
  }
  return out;
}

/**
 * Aus `mcp__hermes__terminal` wieder `terminal` machen.
 *
 * Gibt `undefined` zurück, wenn der Name NICHT zu unserem Server gehört. Das
 * ist wichtig: ein Werkzeug aus einer anderen Quelle darf nicht versehentlich
 * als Hermes-Werkzeug durchgereicht werden.
 */
export function stripMcpPrefix(name: string, server: string = MCP_SERVER_NAME): string | undefined {
  const prefix = mcpToolPrefix(server);
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
}

/** Ein `tool_use`-Block der CLI als OpenAI-`tool_call`. */
export function toolUseToOpenAiCall(
  block: unknown,
  server: string = MCP_SERVER_NAME,
): OpenAIToolCall | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
  if (b.type !== "tool_use" || typeof b.name !== "string" || typeof b.id !== "string") return undefined;
  const bare = stripMcpPrefix(b.name, server);
  if (!bare) return undefined;
  return {
    id: b.id,
    type: "function",
    function: {
      name: bare,
      // OpenAI erwartet die Argumente als STRING, die CLI liefert ein Objekt.
      arguments: JSON.stringify(b.input ?? {}),
    },
  };
}

/**
 * Alle Werkzeugaufrufe aus einer Assistenten-Nachricht.
 *
 * Hier liegt der eigentliche Gewinn gegenüber der Textbrücke: die Nachricht
 * trägt die Aufrufe bereits strukturiert, mit `id`, `name` und `input` — also
 * genau den drei Feldern, die OpenAI braucht. **Parallele Aufrufe** stehen als
 * mehrere Blöcke in DERSELBEN Nachricht und kommen deshalb vollständig mit;
 * der Text-Parser hätte sie einzeln aus dem Fließtext klauben müssen.
 */
export function extractToolCallsFromAssistant(
  message: unknown,
  server: string = MCP_SERVER_NAME,
): OpenAIToolCall[] {
  const m = message as { message?: { content?: unknown } } | undefined;
  const content = m?.message?.content;
  if (!Array.isArray(content)) return [];
  const calls: OpenAIToolCall[] = [];
  for (const block of content) {
    const call = toolUseToOpenAiCall(block, server);
    if (call) calls.push(call);
  }
  return calls;
}

/**
 * Der kleine MCP-Server: beantwortet, was die CLI fragt.
 *
 * Vier Methoden, alle im Mitschnitt beobachtet, in dieser Reihenfolge:
 * `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
 *
 * `tools/call` beantworten wir mit einem Fehler, und das ist Absicht: der
 * Aufruf ist zu diesem Zeitpunkt bereits als `tool_calls` an Hermes unterwegs,
 * ausgeführt wird dort. Die Antwort ist nur die Höflichkeit, die verhindert,
 * dass die CLI auf eine Antwort wartet, die nie kommt.
 *
 * UNBEKANNTE METHODEN BEKOMMEN EINEN FEHLER, KEIN SCHWEIGEN. Eine
 * unbeantwortete Anfrage lässt die CLI hängen; ein Fehler lässt sie
 * weiterlaufen oder laut scheitern. Das offizielle SDK macht es an derselben
 * Stelle genauso ("Unsupported control request subtype").
 */
export function handleMcpMessage(
  message: unknown,
  tools: McpToolDef[],
  server: string = MCP_SERVER_NAME,
): JsonRpcResponse {
  const msg = message as { method?: unknown; id?: unknown; params?: unknown } | undefined;
  // Die CLI schickt Benachrichtigungen ohne `id`; der Mitschnitt zeigt, dass
  // das SDK dann mit id 0 antwortet. Nachgebaut statt ausgedacht.
  const id = typeof msg?.id === "number" ? msg.id : 0;
  const method = typeof msg?.method === "string" ? msg.method : "";

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: verhandelteFassung(msg?.params),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: server, version: MCP_SERVER_VERSION },
        },
      };

    case "notifications/initialized":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools } };

    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                "Dispatched by the caller. This process does not execute tools; " +
                "the tool call has been handed back to the calling agent.",
            },
          ],
          isError: true,
        },
      };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method || "(missing)"}` },
      };
  }
}
