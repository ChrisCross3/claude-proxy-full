# claude-proxy-full

`claude-proxy-full` stellt die offizielle Claude-Code-CLI als lokalen, OpenAI-kompatiblen HTTP-Server bereit. Jeder Client, der die OpenAI-API spricht, kann darauf zeigen — beantwortet werden die Requests von einer lokalen `claude`-Session, authentifiziert über dein bestehendes **Claude-Abo (OAuth)**, ganz ohne Anthropic-API-Key.

Dies ist ein gehärteter Fork von [`mehdic/openclaw-claude-proxy`](https://github.com/mehdic/openclaw-claude-proxy) (seinerseits auf `mnemon-dev/claude-max-api-proxy` aufbauend). Zusätzlich zum OpenAI-kompatiblen Server des Upstreams bringt dieser Fork eine kuratierte **Model-Registry** (inkl. 1M-Context-Opus), einen **isolierten Single-Shot-Endpoint** für Memory-/Agent-Backends wie [Honcho](https://github.com/plastic-labs/honcho) sowie einen **OpenRouter-Wire-Kompatibilitäts-Layer**, damit auch Clients, die nur den OpenRouter-Dialekt sprechen, unverändert funktionieren.

> **OAuth-Sicherheit:** Dieser Proxy **extrahiert, kopiert, exportiert** den Claude-Code-Login **nicht** und bildet ihn auch nicht nach. Er startet die offizielle `claude`-CLI und überlässt ihr die Authentifizierung auf die normale Weise. Das einzige gelesene Credential ist die nutzereigene `~/.claude/.credentials.json` — und auch nur, um einen Access-Token in `--bare`-Isolated-Spawns zu überbrücken (siehe [Isolated-Mode](#isolated-mode)). Geschrieben wird nichts.

## Gegenüber dem Upstream

Der Upstream `openclaw-claude-proxy` ist auf das OpenClaw-Ökosystem zugeschnitten. Dieser Fork ergänzt drei Dinge, die ihn für Drittanbieter-Clients und Memory-Backends einsetzbar machen:

- **`/v1/isolated`-Endpoint.** Der Upstream kennt nur den normalen, kontextbehafteten Chat-Pfad. Memory-Backends wie Honcho setzen aber sehr viele kleine, voneinander unabhängige Extraktions-Calls ab und brauchen striktes JSON zurück. Der Isolated-Endpoint liefert das: `--bare`-Spawn ohne Workspace-/Memory-/`CLAUDE.md`-Discovery, OAuth-Token-Bridging für den `--bare`-Mode und `json_schema`-Handling. Ohne ihn lief Honcho gegen den Upstream nicht zuverlässig.
- **OpenRouter-Wire-Kompatibilität.** Manche Clients sprechen nur den OpenRouter-Dialekt — `anthropic/`-Prefix an der Model-ID, Reasoning unter `extra_body.reasoning`. Der Upstream akzeptiert nur die OpenAI-Form. Der Normalisierungs-Layer übersetzt das transparent, sodass solche Clients ohne Patch funktionieren.
- **Gepflegte Model-Registry.** Kanonische Model-IDs mit Context-Windows und Kosten-Metadaten an einer Stelle, inkl. `claude-opus-4-7` mit nativem 1M-Context-Window und stabilen Aliassen für datierte/präfixierte Varianten.

Die Runtime-Basis (Pools, Streaming, Tracing, Tooling, Sticky-Sessions) stammt unverändert aus dem Upstream — dort liegt die eigentliche Schwerarbeit, und sie wird hier nur erweitert, nicht ersetzt.

## Auf einen Blick

- OpenAI-kompatible **Chat Completions** und eine praxistaugliche **Responses**-API, jeweils mit und ohne `/v1`-Prefix.
- Authentifizierung über dein **Claude-Abo** — der Proxy braucht keinen eigenen API-Key.
- Persistente `stream-json`-Runtime mit Init-/Session-Pools für niedrige Latenz und Prompt-Cache-Reuse; `print`-Fallback-Mode zur Isolation.
- SSE-Streaming mit Keepalives für lange Claude-Code-Turns.
- **Model-Registry** mit kanonischen IDs, Aliassen, Context-Windows und Kosten-Metadaten (`claude-opus-4-7` meldet ein **1.000.000-Token**-Context-Window).
- **`/v1/isolated/chat/completions`** — zustandslose `--bare`-Single-Shot-Calls mit Strict-JSON-Freundlichkeit, gebaut für externe Memory-Backends (Honcho-artige Deriver).
- **OpenRouter-Kompatibilität** — akzeptiert `anthropic/<model>`-IDs und `extra_body.reasoning`, normalisiert sie in die OpenAI-Form.
- Usage-/Cache-Metadaten und geschätzte Kosten-Annotationen.
- Caller-dispatched OpenAI-Tool-Call-Bridge, optional mit direkter MCP-Injection.
- Optionale In-Memory-/SQLite-/HTTP-exportierte Traces mit Redaction-Grenzen.
- Optionale Sticky-Claude-CLI-Sessions für Caller, die deterministische Session-Metadaten mitschicken.

## Schnellstart

Zuerst Claude Code installieren und einloggen:

```bash
npm install -g @anthropic-ai/claude-code
claude /login        # mit deinem Claude-Abo anmelden
```

Dann den Proxy aus dem Source bauen und starten:

```bash
git clone https://github.com/ChrisCross3/claude-proxy-full.git
cd claude-proxy-full
npm install
npm run build
npm start            # lauscht auf 127.0.0.1:3456
```

Smoke-Test in einem zweiten Terminal:

```bash
curl http://127.0.0.1:3456/health

curl http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "stream": false
  }'
```

Standardmäßig ist kein Proxy-API-Key nötig — die Authentifizierung ist das, was die lokale `claude`-CLI bereits etabliert hat. Lass den Server an Loopback gebunden, solange du nicht eigene Auth (`CLAUDE_PROXY_API_KEY`/`CLAUDE_PROXY_API_KEYS`) und Netzwerk-Kontrollen ergänzt.

## API-Oberfläche

Routen sind mit und ohne `/v1` gemountet, damit sowohl OpenAI-SDKs als auch einfachere Clients funktionieren.

| Endpoint | Methode | Zweck |
| --- | --- | --- |
| `/health` | GET | Günstiger Liveness- + Runtime-Capability-Überblick. |
| `/healthz/deep` | GET | Tiefe Probe, die Claude um eine Mini-Antwort bittet. |
| `/models`, `/v1/models` | GET | OpenAI-Style-Model-Liste aus der Registry. |
| `/chat/completions`, `/v1/chat/completions` | POST | Chat Completions, streaming und non-streaming. |
| `/isolated/chat/completions`, `/v1/isolated/chat/completions` | POST | Zustandslose `--bare`-Single-Shot-Completions (non-streaming). |
| `/responses`, `/v1/responses` | POST | Praxistaugliche Responses-API-Kompatibilität. |
| `/pricing`, `/v1/pricing` | GET | Pricing-Snapshot für Kostenschätzungen. |
| `/metrics` | GET | Prometheus-Style-Metriken. |
| `/traces`, `/traces/:id` | GET | Localhost-only Trace-Endpoints, wenn Tracing aktiv ist. |

## Modelle

Die Registry stellt kanonische Model-IDs plus Komfort-Aliasse bereit (`anthropic/…`, `claude-proxy/…`, `claude-code-cli/…` sowie datierte Varianten).

| Model-ID | Context-Window | Anmerkung |
| --- | --- | --- |
| `claude-opus-4-7` | 1.000.000 | Natives 1M-Context. |
| `claude-opus-4-6` | 200.000 | |
| `claude-sonnet-4-6` | 200.000 | |
| `claude-haiku-4-5` | 200.000 | Kanonische ID; `claude-haiku-4-5-20251001` bleibt als Alias. |

`GET /v1/models` liefert die Live-Liste. Pricing-/Kosten-Metadaten werden in der Registry gepflegt und über die Pricing-Skripte aktualisiert.

## Isolated-Mode

`POST /v1/isolated/chat/completions` ist ein **zustandsloser Single-Shot**-Pfad für Memory- und Agent-Backends, die viele kleine, unabhängige Extraktions-Calls absetzen — etwa die Deriver-/Summary-/Dialectic-Module von [Honcho](https://github.com/plastic-labs/honcho).

Im Vergleich zum normalen Chat-Endpoint:

- spawnt er die Claude-CLI mit `--bare` (kein Workspace, keine Auto-Memory, kein `CLAUDE.md`-Walk-up-Discovery; `cwd` ist ein Temp-Verzeichnis),
- überbrückt er den Abo-OAuth-Token aus `~/.claude/.credentials.json` in `ANTHROPIC_API_KEY` für diesen `--bare`-Spawn (weil `--bare` weder OAuth noch OS-Keychain liest),
- setzt er `response_format: json_schema`-Requests auf die **native Schema-Durchsetzung der CLI** um (`claude --json-schema`): die CLI validiert die Antwort gegen das Schema und fragt bei Abweichung nach, statt striktes JSON nur per Prompt zu erbitten. Ein caller-eigener `system_prompt` bleibt dabei unangetastet. **Rückfall** ist der alte Weg — Schema in einen aggressiven System-Prompt eingebettet — und zwar nur für Schemata, die einen fremden Dialekt *deklarieren*: der Validator der CLI ist auf draft-07 festgenagelt, und ein fremder `$schema`-Wert bricht den Spawn mit Exit 1 ab. Schemata ohne `$schema` (u. a. alles aus Pydantic v2, also Honchos Fall) gehen nativ,
- ist er **non-streaming** — für SSE den Endpoint `/v1/chat/completions` nutzen.

Relevante Env-Vars: `CLAUDE_PROXY_BARE_POOL`, `CLAUDE_PROXY_BARE_POOL_SIZE`, `CLAUDE_PROXY_ISOLATED_CWD`.

> **Zu den beiden `BARE_POOL`-Namen:** Einen eigenen „Bare-Pool" gibt es seit dem Init-Pool-Umbau nicht mehr — es gibt einen Pool, geschlüsselt nach Modell plus Fingerabdruck der vollständigen Spawn-Konfiguration; der isolierte Pfad ist darin bloß eine weitere Konfiguration. Die **Wirkung beider Schalter ist unverändert**: `CLAUDE_PROXY_BARE_POOL=0` schaltet das Vorwärmen der isolierten Konfigurationen ab und lässt den übrigen Vorrat in Ruhe, und `CLAUDE_PROXY_BARE_POOL_SIZE` wirkt ausschließlich als zweiter Aus-Schalter bei `0`. Keine Regression, nur ein ehrlicherer Name: **`SIZE` war auch vorher schon keine Größe** — der Wert wurde zwar geparst, aber nur gegen `=== 0` geprüft, und der alte Vorrat hielt ohnehin genau einen Slot je Modell. `SIZE=3` hat nie drei Prozesse warm gehalten. Die tatsächlichen Mengen-Regler heißen `CLAUDE_PROXY_INIT_POOL_MAX` und `CLAUDE_PROXY_INIT_POOL_TTL_MS` (siehe [docs/configuration.md](docs/configuration.md)).

### Embeddings sind außerhalb des Scopes

Claude hat **keine Embedding-API**, dieser Proxy kann also kein `/v1/embeddings` bedienen. Memory-Backends, die einen Vector-Store brauchen (Honcho et al.), müssen ihren Embedding-Transport auf einen separaten, OpenAI-kompatiblen Provider zeigen lassen — eine lokale [Ollama](https://ollama.com)-Instanz mit `nomic-embed-text` (768-dim) funktioniert gut. Wichtig: Den Vector-Store auf die Dimensionalität des Embedders konfigurieren, nicht auf OpenAIs Default von 1536.

## OpenRouter-Kompatibilität

Manche Clients (z. B. ein OpenRouter-Provider-Profil) emittieren ausschließlich den OpenRouter-Wire-Dialekt: Model-IDs tragen einen `anthropic/`-Prefix, Reasoning-Optionen liegen unter `extra_body.reasoning`. Registriert man den Proxy als OpenRouter-artigen Provider (eine `base_url`, die `openrouter` enthält, etwa via Hosts-Alias), konvertiert der Normalisierungs-Layer die Requests transparent in die OpenAI-Form, die der Rest des Proxys erwartet:

- `anthropic/claude-opus-4-7` → `claude-opus-4-7`
- `extra_body.reasoning.effort` → top-level `reasoning_effort`
- `extra_body.reasoning.enabled === false` / `effort === "none"` → top-level `thinking = false`

Bestehende Top-Level-Felder werden nie überschrieben (direkte OpenAI-Style-Calls haben Vorrang), und die Transformation ist idempotent. Ein Dummy-Key wie `sk-or-dummy` befriedigt Clients, die auf einem Key bestehen.

## Runtime-Modell

Zwei Claude-Subprozess-Strategien:

- `stream-json` *(Default)* — Claude Codes stream-json-Transport mit Init-/Session-Pools für Latenz und Prompt-Cache-Reuse.
- `print` — Incident-Response-Fallback: ein frischer `claude --print`-Subprozess pro Request. Langsamer, einfacher, isoliert.

Auswahl über `CLAUDE_PROXY_RUNTIME` / `CLAUDE_PROXY_STREAM_JSON`. Die vollständige Env-Var-Referenz (Pools, Tracing, MCP, Monitoring, Secret-Handling) steht in [docs/configuration.md](docs/configuration.md).

## Sticky-Sessions

Opt-in-Erweiterung für Caller, die einen warmen, kontinuierlichen Live-Claude-CLI-Worker wollen. Ein Request ohne Sticky-Metadaten behält das Default-Pool-Verhalten; ein Caller pinnt eine Session über deterministische Header:

```text
X-Claude-Proxy-Session-Key: <vom Caller gewählte, stabile ID>
X-Claude-Proxy-Session-Mode: sticky
X-Claude-Proxy-Session-TTL-Seconds: 86400
```

Serverseitig aktivieren mit `CLAUDE_PROXY_STICKY_SESSIONS=1` (plus `CLAUDE_PROXY_STICKY_MAX_SESSIONS`, `CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS`). Der rohe Key wird für Logs/Metriken gehasht — niemals Secrets hineinlegen.

## Tool-Ausführungs-Modell

Der sichere Default sind **Caller-dispatched Tools**: Der Proxy gibt OpenAI-Style-`tool_calls` zurück, und der Caller besitzt Ausführung, Approval und Audit. Optionale MCP-Injection (`CLAUDE_PROXY_TOOLS_TRANSLATION=1`, eingegrenzt über `CLAUDE_PROXY_MCP_ALLOW`/`CLAUDE_PROXY_MCP_DENY`) registriert MCP-Server direkt an der inneren Claude-CLI — bequem für lokale Automation, verschiebt aber die Sicherheitsgrenze in den Proxy hinein. Diesen Trade-off verstehen, bevor man es aktiviert.

## Sicherheitshinweise

- Die Authentifizierung bleibt bei der offiziellen `claude`-CLI; der Proxy persistiert keine Tokens.
- Server auf Loopback halten, solange keine eigene Auth + Netzwerk-Kontrollen ergänzt sind.
- Keine API-Keys, OAuth-Tokens, lokalen Pfade oder Trace-Datenbanken committen (`.env`, Logs und `dist/` sind git-ignored).
- Traces als sensible Diagnose-Daten behandeln, auch wenn secret-artige Felder redacted werden.
- `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true` nur für vertrauenswürdige Headless-/Local-Deployments.

## Entwicklung

```bash
npm install
npm run build
npm test
```

Live-Checks gegen einen laufenden Proxy:

```bash
npm run soak:quick
npm run canary:stream-json
npm run sdk:matrix
npm run failure:sim
npm run monitor:live
```

## Fork-Herkunft

`ChrisCross3/claude-proxy-full` → [`mehdic/openclaw-claude-proxy`](https://github.com/mehdic/openclaw-claude-proxy) → `mnemon-dev/claude-max-api-proxy`. Dieser Fork ergänzt die Model-Registry (inkl. 1M-Context-Opus), den `/v1/isolated`-Endpoint und den OpenRouter-Kompatibilitäts-Layer — neben der persistenten Runtime, dem Tracing, Monitoring und Tooling des Upstreams.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
