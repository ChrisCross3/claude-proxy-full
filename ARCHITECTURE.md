# Architecture

HTTP-Proxy übersetzt OpenAI-/Anthropic-API-Calls auf einen `claude` CLI subprocess. Clients sprechen ein OpenAI- oder Anthropic-kompatibles Protokoll; der Proxy fährt darunter ein `claude` CLI hoch (one-shot oder persistent stream-json) und mappt Request/Response.

## Layer-Stack (top-down)

```
HTTP request
   ↓
src/server/standalone.ts        Express-Bootstrap, ruft preWarm() beim Start
   ↓
src/server/routes.ts            Endpoints:
                                  POST /v1/chat/completions
                                  POST /v1/messages
                                  POST /v1/responses
                                  GET  /models   (+ /v1/models)
                                  GET  /metrics
   ↓
src/adapter/openai-to-cli.ts    Request → CLI-flags + prompt-payload
src/adapter/cli-to-openai.ts    CLI-output → OpenAI/Anthropic response
                                  (extractModel() resolved bare/prefixed ids)
   ↓
Acquisition-Layer (siehe unten)
   ↓
src/subprocess/manager.ts            ClaudeSubprocess.prepare()  (--print one-shot)
src/subprocess/stream-json-manager.ts StreamJsonSubprocess.submitTurn() (persistent NDJSON)
   ↓
`claude` CLI subprocess
```

## Acquisition-Layer

Zwei Pfade, je nachdem ob der Request streaming/sticky ist oder ein klassischer one-shot:

```
Print-mode (one-shot, --print):
  routes.ts
    → src/subprocess/pool.ts::acquireSubprocess
    → new ClaudeSubprocess()  →  prepare({ model, ...flags })

Streaming / sticky:
  routes.ts
    → src/subprocess/sticky-session-pool.ts   (wenn sticky-session-key vorhanden)
    → src/subprocess/session-pool.ts          (normaler streaming-Pool)
    → src/subprocess/init-pool.ts::acquirePreInit
    → StreamJsonSubprocess.submitTurn(...)
```

`init-pool.ts` hält pro Modell einen pre-initialisierten `stream-json`-Worker bereit (gesteuert über `CLAUDE_PROXY_PREWARM_MODELS`); `session-pool.ts` schichtet TTL/Max-Worker darüber (`CLAUDE_PROXY_POOL_TTL_MS`, `CLAUDE_PROXY_POOL_MAX`). Print-Mode-Subprozesse leben pro Request — kein Warm-Slot.

## Module-Index

| Pfad | Zweck |
|---|---|
| `src/models/registry.ts` | Canonical `MODELS` (single source of truth — siehe `MODEL_DRIFT.md`) |
| `src/server/standalone.ts` | Express-App, Port-Bind, `preWarm()` |
| `src/server/routes.ts` | Route-Handler für `/v1/*`, `/models`, `/metrics` |
| `src/server/metrics.ts` | Prometheus-Counter/Histogram, `KNOWN_MODEL_LABELS` |
| `src/server/middleware/auth.ts` | Bearer-Token-Check (optional, `CLAUDE_PROXY_API_KEY`) |
| `src/server/middleware/cors.ts` | CORS-Header |
| `src/server/middleware/cold-spawn-limit.ts` | Pro-Caller-Rate-Limit für print-mode-Spawns |
| `src/adapter/openai-to-cli.ts` | OpenAI/Anthropic → `claude` CLI flags + prompt |
| `src/adapter/cli-to-openai.ts` | `claude` CLI output → response; `extractModel()` |
| `src/adapter/openrouter-normalize.ts` | OpenRouter-Quirks (top-level + nested) |
| `src/adapter/responses.ts` | `/v1/responses`-API-Form |
| `src/adapter/tools.ts` | Tool-Call-Bridge |
| `src/subprocess/manager.ts` | `ClaudeSubprocess` (print-mode) |
| `src/subprocess/stream-json-manager.ts` | `StreamJsonSubprocess` (persistent NDJSON) |
| `src/subprocess/pool.ts` | `acquireSubprocess` (cold print-mode) |
| `src/subprocess/init-pool.ts` | Pre-init pool für stream-json-Worker |
| `src/subprocess/session-pool.ts` | TTL/Max-Worker-Pool über init-pool |
| `src/subprocess/sticky-session-pool.ts` | Sticky-Session-Key → Worker-Pinning |
| `src/subprocess/claude-flags.ts` | Flag-Set-Builder + Strict-Validation |
| `src/subprocess/stream-json-parser.ts` | NDJSON-Parser mit Buffer-Cap |
| `src/trace/*` | OTLP-Builder, SQLite-Store, Redaktor, Exporter. `src/trace/sqlite.ts` pipet SQL über `sqlite3 -batch`-stdin statt argv — vermeidet `ARG_MAX` bei großen `record_json`-Blobs (mehrere MB). |
| `src/mcp/*` | MCP-Governance + openclaw-Config |
| `src/n8n/*` | n8n-Detector + Progress-Reporting |
| `src/errors.ts` | Domain-Errors (`ColdSpawnRateLimitedError`, etc.) |

## Tests

33 Test-Files unter `src/__tests__/` (Node-`node:test`). Test-Bilanz auf der OpenRouter-client-VM (`npm test`): **429 Tests / 427 pass / 2 skip / 0 fail**.

## Weiterführend

- [`docs/configuration.md`](docs/configuration.md) — Env-Vars (Auth, Pooling, Tracing)
- [`PROTOCOL.md`](PROTOCOL.md) — Wire-Format-Details (OpenAI/Anthropic-Mapping)
- [`README.md`](README.md) — Quickstart + Run-Modes
- [`MODEL_DRIFT.md`](MODEL_DRIFT.md) — Modell-Registry-Workflow
- [`DESIGN.md`](DESIGN.md) — Historische 2025-09-Skizze (nicht aktuell)
