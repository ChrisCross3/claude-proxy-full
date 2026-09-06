import type { ClaudeCliMessage } from "../types/claude-cli.js";

export interface ClaudeControlResponse {
  type: "control_response";
  response: { request_id: string; subtype: string; error?: string };
}

/**
 * Eine Kontrollanfrage der CLI AN UNS. Bis 2026-09-06 gab es die hier nicht,
 * weil der Proxy nur die Hinrichtung sprach (initialize hinaus, Antwort
 * herein). Fuer die Werkzeug-Bruecke ueber MCP fragt die CLI zurueck — und
 * eine unbeantwortete Anfrage laesst sie WARTEN. Deshalb muss sie erkannt
 * werden; beantwortet wird jede, notfalls mit einem Fehler.
 */
export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: string;
    /** Bei subtype "mcp_message": der Servername aus unserem initialize. */
    server_name?: string;
    /** Bei subtype "mcp_message": die JSONRPC-Nachricht. */
    message?: unknown;
    [k: string]: unknown;
  };
}

export type StreamJsonParsedLine =
  | { kind: "empty" }
  | { kind: "control_response"; value: ClaudeControlResponse }
  | { kind: "control_request"; value: ClaudeControlRequest }
  | { kind: "message"; value: ClaudeCliMessage }
  | { kind: "malformed"; raw: string; error: string };

/**
 * Parse one complete NDJSON line from Claude CLI's stream-json output.
 * This deliberately does not throw: callers can keep the worker alive for
 * unexpected/malformed side-channel lines while tests exercise protocol drift
 * fixtures without spawning a real Claude process.
 */
export function parseStreamJsonLine(line: string): StreamJsonParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "empty" };

  try {
    const parsed = JSON.parse(trimmed) as ClaudeCliMessage | ClaudeControlResponse;
    if ((parsed as { type?: string }).type === "control_response") {
      return { kind: "control_response", value: parsed as ClaudeControlResponse };
    }
    if ((parsed as { type?: string }).type === "control_request") {
      return { kind: "control_request", value: parsed as unknown as ClaudeControlRequest };
    }
    return { kind: "message", value: parsed as ClaudeCliMessage };
  } catch (err) {
    return {
      kind: "malformed",
      raw: trimmed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
