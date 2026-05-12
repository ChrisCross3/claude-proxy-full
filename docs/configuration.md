# Configuration guide

`claude-proxy` is configured with environment variables. Keep machine-specific values in your shell profile, process manager, LaunchAgent, container runtime, or secret store — not in the repository.

## Minimal configuration

For a foreground local run, no environment variables are required:

```bash
npm start
```

The default server is:

```text
http://127.0.0.1:3456
```

For headless service mode, the practical minimum is usually:

```bash
CLAUDE_PROXY_PORT=3456
CLAUDE_PROXY_RUNTIME=stream-json
CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true
```

Only use `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=true` on a trusted local machine where you accept the Claude Code CLI permission trade-off.

## Runtime

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_PORT` | `3456` | Port for the HTTP server. A CLI arg to `standalone.js` overrides this. |
| `CLAUDE_PROXY_RUNTIME` | `stream-json` | `stream-json` or `print`. `stream-json` is the default persistent runtime. `print` spawns a fresh subprocess per request. |
| `CLAUDE_PROXY_STREAM_JSON` | unset | Legacy compatibility flag. `0` forces print mode if `CLAUDE_PROXY_RUNTIME` is unset. Prefer `CLAUDE_PROXY_RUNTIME`. |
| `CLAUDE_PROXY_ALLOW_RUNTIME_OVERRIDE` | unset | Set `1` to allow per-request `X-Claude-Proxy-Runtime: print` or `stream-json`. Off by default. |
| `CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE` | unset | Set `1` to retry once with `print` when a recognized stream-layer failure happens before response bytes are committed. |
| `CLAUDE_PROXY_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS` | unset | Set `1` to request Claude CLI dynamic-system-prompt exclusion when the installed CLI supports the flag. |
| `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS` | unset | Set `true` to pass Claude CLI's permission-skipping flag. Useful for trusted headless services; risky on untrusted hosts. |

### Choosing a runtime

Use `stream-json` for normal operation:

```bash
CLAUDE_PROXY_RUNTIME=stream-json npm start
```

Use `print` when debugging upstream CLI protocol changes or when you want one subprocess per request:

```bash
CLAUDE_PROXY_RUNTIME=print npm start
```

## Pooling and prewarm

These variables affect the persistent `stream-json` runtime.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_PREWARM_MODELS` | `claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5-20251001` | Comma-separated models to pre-initialize at startup. |
| `CLAUDE_PROXY_INIT_POOL` | enabled | Set `0` to disable the per-model init pool. |
| `CLAUDE_PROXY_POOL_TTL_MS` | `600000` | Idle TTL for session-pool workers. Floored internally to avoid evicting during the prompt-cache window. |
| `CLAUDE_PROXY_POOL_MAX` | `4` | Maximum live workers in the session pool. |
| `CLAUDE_PROXY_UPSTREAM_SOFT_DEAD_MS` | code default | Soft-dead threshold for upstream silence detection. Usually leave unset. |
| `CLAUDE_PROXY_DESCENDANT_GRACE_MS` | code default | Grace window for descendant/tool process handling. Usually leave unset. |

## Opt-in sticky sessions

Sticky sessions keep a specific live Claude Code CLI `stream-json` worker attached to an explicit caller-provided session key. This is useful for agent/conversation warm state, but it is deliberately opt-in: ordinary OpenAI-compatible requests continue through the default pool unchanged.

Enable the feature explicitly:

```bash
CLAUDE_PROXY_STICKY_SESSIONS=1 npm start
```

Sticky sessions require the `stream-json` runtime. They preserve CLI continuity for the configured TTL; they do **not** change Anthropic prompt-cache lifetime guarantees.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_STICKY_SESSIONS` | unset | Set `1` to allow opt-in sticky requests. Requests with a sticky key are rejected while disabled. |
| `CLAUDE_PROXY_STICKY_ALLOW_BODY_OPTIONS` | enabled | Set `0` to ignore `claude_proxy` body extensions and accept only headers. |
| `CLAUDE_PROXY_STICKY_DEFAULT_TTL_SECONDS` | `3600` | Sticky session idle TTL when a request does not provide one. |
| `CLAUDE_PROXY_STICKY_MIN_TTL_SECONDS` | `60` | Lower clamp for request-provided sticky TTLs. |
| `CLAUDE_PROXY_STICKY_MAX_TTL_SECONDS` | `86400` | Upper clamp for request-provided sticky TTLs. |
| `CLAUDE_PROXY_STICKY_ABSOLUTE_TTL_SECONDS` | `86400` | Absolute session lifetime cap. Set `0` to disable the absolute cap. |
| `CLAUDE_PROXY_STICKY_MAX_SESSIONS` | `8` | Maximum live sticky workers. Idle LRU workers are evicted when the cap is reached. |
| `CLAUDE_PROXY_STICKY_QUEUE_TIMEOUT_MS` | `120000` | How long a concurrent request waits for the same sticky key before returning busy. |
| `CLAUDE_PROXY_STICKY_KEY_MAX_LENGTH` | `256` | Maximum raw session key length. Raw keys are hashed in traces/metrics. |

Header form:

```text
X-Claude-Proxy-Session-Key: app:user:conversation
X-Claude-Proxy-Session-Mode: sticky
X-Claude-Proxy-Session-TTL-Seconds: 86400
X-Claude-Proxy-Session-Reset: false
```

Body extension form:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "hello" }],
  "claude_proxy": {
    "session_key": "app:user:conversation",
    "session_mode": "sticky",
    "session_ttl_seconds": 86400,
    "session_reset": false
  }
}
```

Accepted session modes are:

- `pool` — default behavior; no sticky key required.
- `sticky` — opt into the sticky worker keyed by the supplied session key plus model/tool/runtime fingerprint.
- `stateless` — bypasses reusable conversation pooling for this request.

Headers override body extension fields when both are present.

## Models

The proxy exposes current Claude model ids through `/models` and `/v1/models`. Common ids include:

```text
claude-opus-4-7
claude-opus-4-6
claude-sonnet-4-6
claude-haiku-4-5-20251001
```

Provider-prefixed ids such as `claude-proxy/claude-sonnet-4-6` are accepted by the model normalizer for OpenClaw-style clients.

## Tracing

Tracing is optional and intended for local debugging.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TRACE_ENABLED` | unset | Set `1` to enable the bounded in-memory trace store. |
| `CLAUDE_PROXY_TRACE_CAPACITY` | `200` | Maximum in-memory traces. |
| `CLAUDE_PROXY_TRACE_TTL_MS` | `3600000` | In-memory trace TTL in milliseconds. Minimum one minute. |
| `CLAUDE_PROXY_TRACE_SQLITE_PATH` | unset | Enables durable SQLite trace persistence at the given local path. |
| `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS` | unset | Retention window for SQLite traces, in days. |
| `CLAUDE_PROXY_TRACE_SQLITE_RETENTION_MS` | unset | Retention override in milliseconds. Used when days is unset. |
| `CLAUDE_PROXY_TRACE_SQLITE_DEBUG` | unset | Set `1` to log SQLite persistence errors. |

Example:

```bash
CLAUDE_PROXY_TRACE_ENABLED=1 \
CLAUDE_PROXY_TRACE_SQLITE_PATH="$HOME/.claude-proxy/traces.sqlite" \
CLAUDE_PROXY_TRACE_SQLITE_RETENTION_DAYS=7 \
npm start
```

Trace endpoints are localhost-gated:

```bash
curl http://127.0.0.1:3456/traces
curl http://127.0.0.1:3456/traces/<trace-id>
```

See [Trace security](TRACE_SECURITY.md) before enabling durable traces.

## Trace export

The proxy can export redacted trace events to an HTTP collector.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TRACE_EXPORT_URL` | unset | Destination URL. Export is disabled when unset. |
| `CLAUDE_PROXY_TRACE_EXPORT_FORMAT` | `generic` | `generic` or `openinference`. |
| `CLAUDE_PROXY_TRACE_EXPORT_HEADER` | unset | Optional single HTTP header in `Name: value` format. Avoid putting long-lived secrets in shell history. |
| `CLAUDE_PROXY_TRACE_EXPORT_TIMEOUT_MS` | code default | Export request timeout. |
| `CLAUDE_PROXY_TRACE_EXPORT_DEBUG` | unset | Set `1` to log export failures. |

## Pricing snapshot

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_PRICING_FILE` | `$HOME/.claude-proxy/pricing.json` | Local pricing snapshot path used by the pricing updater and cost estimator. |

Update pricing:

```bash
npm run update-pricing
```

## MCP and tool modes

There are two distinct tool paths.

### Caller-dispatched tools — recommended default

The caller sends OpenAI-style tools, the proxy returns OpenAI-style `tool_calls`, and the caller executes tools under its own approval/audit/allowlist system. This is the safest mode for OpenClaw.

No MCP injection env vars are required for this mode.

### Direct MCP injection — advanced local mode

When enabled, the proxy registers selected MCP servers directly with the inner Claude CLI. Claude Code then executes those MCP tools inside the subprocess.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TOOLS_TRANSLATION` | unset | Set `1` to enable direct MCP injection. |
| `CLAUDE_PROXY_OPENCLAW_CONFIG` | `$HOME/.openclaw/openclaw.json` | Optional path to an OpenClaw config file whose `mcp.servers` can be imported. |
| `CLAUDE_PROXY_MCP_ALLOW` | unset | Comma-separated allowlist of MCP server names. If set, only these servers are injected. |
| `CLAUDE_PROXY_MCP_DENY` | unset | Comma-separated denylist of MCP server names. Deny wins over allow. |

Example:

```bash
CLAUDE_PROXY_TOOLS_TRANSLATION=1 \
CLAUDE_PROXY_MCP_ALLOW=n8n,github \
npm start
```

Security trade-off: direct MCP injection bypasses the caller's dispatcher. For OpenClaw, that means OpenClaw may not see those tool calls in its normal approval/audit path.

## n8n and MCP binary paths

`claude-proxy` has two optional n8n-related features:

1. n8n-aware keepalive progress, using the n8n REST API.
2. Direct n8n MCP injection, using the `n8n-mcp` stdio binary.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_N8N_API_URL` | unset | n8n API base URL, for example `https://n8n.example.com/api/v1`. |
| `CLAUDE_PROXY_N8N_API_KEY` | unset | n8n API key. Required with `CLAUDE_PROXY_N8N_API_URL` for n8n progress and legacy n8n MCP registration. |
| `CLAUDE_PROXY_N8N_DETECTION_PATTERN` | `n8n.*\/webhook\/` | Regex used to detect in-flight n8n webhook calls in Claude tool input. |
| `CLAUDE_PROXY_N8N_MCP_BIN` | `n8n-mcp` | Command or absolute path to the `n8n-mcp` stdio binary. |

If `n8n-mcp` is not on the service `PATH`, set `CLAUDE_PROXY_N8N_MCP_BIN` explicitly:

```bash
CLAUDE_PROXY_TOOLS_TRANSLATION=1 \
CLAUDE_PROXY_N8N_API_URL="https://n8n.example.com/api/v1" \
CLAUDE_PROXY_N8N_API_KEY="<n8n-api-key>" \
CLAUDE_PROXY_N8N_MCP_BIN="<path-to-n8n-mcp>" \
npm start
```

This matters for macOS LaunchAgents because they often run with a minimal `PATH`. A binary that works in your interactive shell may not be visible to the service.

Recommended private LaunchAgent pattern:

```xml
<key>CLAUDE_PROXY_N8N_MCP_BIN</key><string><path-to-n8n-mcp></string>
```

Do not commit real n8n API keys or private n8n URLs to the repository.

## Security / Hardening

Three opt-in middleware features harden the proxy against credential misuse, cross-origin abuse, and cold-spawn floods. All three are **off by default** to keep the default loopback developer experience unchanged. Enable them when the proxy is exposed beyond a single trusted user, or when you observe abuse patterns.

### Bearer-token authentication

When enabled, every request must carry `Authorization: Bearer <token>`. A small allowlist of health/metrics/pricing paths is permitted without auth so probes keep working.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_API_KEY` | unset | Single shared bearer token. Mutually compatible with `CLAUDE_PROXY_API_KEYS`. |
| `CLAUDE_PROXY_API_KEYS` | unset | Comma-separated list of accepted bearer tokens. Useful for per-caller key rotation. |

Always-allowed paths (no auth required): `/health`, `/healthz`, `/healthz/deep`, `/metrics`, `/pricing`, `/v1/pricing`.

Example:

```bash
CLAUDE_PROXY_API_KEY="$(openssl rand -hex 32)" npm start
```

Implementation: `src/server/middleware/auth.ts`.

### CORS origin whitelist

When set, only listed origins receive CORS allow-headers. Other origins get a same-origin response with no `Access-Control-Allow-Origin` header.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_ALLOWED_ORIGINS` | unset | Comma-separated list of allowed origins. The special token `loopback` expands to match `http://localhost:*` and `http://127.0.0.1:*`. The wildcard `*` is only honored when `CLAUDE_PROXY_API_KEY`/`_API_KEYS` is also set — otherwise the proxy logs a warning and falls back to an empty whitelist. |

Example:

```bash
CLAUDE_PROXY_ALLOWED_ORIGINS="loopback,https://app.example.com" npm start
```

Implementation: `src/server/middleware/cors.ts`.

### Cold-spawn rate limit

A token bucket throttles **cold-spawn** requests per caller — that is, requests that have to spin up a fresh Claude CLI subprocess. Warm hits against the existing pool are not counted. The caller key is selected in priority order: hashed API key → first `X-Forwarded-For` entry → remote IP → `"anon"`. Rejected requests return `HTTP 429` with a `Retry-After` header.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN` | `0` (disabled) | Sustained cold-spawn rate per caller. Set a positive integer to enable. |
| `CLAUDE_PROXY_COLD_SPAWN_BURST` | code default | Maximum burst size in the token bucket. |

Example:

```bash
CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN=20 \
CLAUDE_PROXY_COLD_SPAWN_BURST=5 \
npm start
```

Implementation: `src/server/middleware/cold-spawn-limit.ts`.

### Reverse-Proxy & Client-IP

When the proxy runs behind a reverse proxy (nginx, Traefik, Caddy) the
real client IP is in `X-Forwarded-For` rather than on the socket. Express
only honors `X-Forwarded-For` when explicitly told to trust it; otherwise
clients could spoof the header to evade per-IP rate limits.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_TRUST_PROXY` | unset (= `false`) | Configures Express `trust proxy`. See values table below. Invalid values throw at boot. |

| Value | Effect |
| --- | --- |
| unset / empty | `false` — ignore `X-Forwarded-For`, use socket address |
| `loopback` | Trust `127.0.0.1` / `::1` only |
| `linklocal` | Trust link-local ranges |
| `uniquelocal` | Trust private + loopback |
| numeric (e.g. `1`, `2`) | Trust this many hop counts |
| IP / CIDR list (e.g. `10.0.0.0/8,192.168.0.1`) | Trust these specific addresses |

Example (proxy behind nginx on the same host):

```bash
CLAUDE_PROXY_TRUST_PROXY=loopback \
CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN=20 \
npm start
```

Implementation: `src/server/trust-proxy.ts`. The cold-spawn limiter's
`extractCallerKey` only consults `X-Forwarded-For` when `trust proxy` is
not `false`, so the default deployment cannot be spoofed.

### Recommended rollout

1. **First**: enable CORS whitelist + Bearer-Auth together (`CLAUDE_PROXY_ALLOWED_ORIGINS` plus `CLAUDE_PROXY_API_KEY`). These two together close the obvious cross-origin and unauthenticated-caller holes.
2. **Then**: measure baseline cold-spawn volume from logs/metrics for a few days.
3. **Finally**: enable `CLAUDE_PROXY_COLD_SPAWN_LIMIT_PER_MIN` with a budget slightly above measured peak. Tune `_BURST` for legitimate burst traffic patterns.

All three remain opt-in to preserve the zero-config local-dev experience.

## Live monitor

`npm run monitor:live` checks `/health` and one tiny chat request.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_PROXY_MONITOR_BASE_URL` | `http://127.0.0.1:3456` | Proxy URL to monitor. |
| `CLAUDE_PROXY_MONITOR_MODEL` | `claude-haiku-4-5-20251001` | Model used for the tiny monitor request. |
| `CLAUDE_PROXY_MONITOR_TIMEOUT_MS` | `60000` | Monitor timeout. |
| `CLAUDE_PROXY_MONITOR_ALERT_COMMAND` | unset | Optional command run on failure. Receives the alert body on stdin and in `CLAUDE_PROXY_MONITOR_MESSAGE`. |

Example:

```bash
CLAUDE_PROXY_MONITOR_ALERT_COMMAND="/path/to/notify-operator.sh" \
npm run monitor:live
```

## Verification script variables

These are used by local scripts, not the server.

| Variable | Script | Description |
| --- | --- | --- |
| `SOAK_BASE_URL` | `npm run soak` | Proxy base URL. |
| `SOAK_CONCURRENCY` | `npm run soak` | Soak concurrency. |
| `SOAK_TIMEOUT_MS` | `npm run soak` | Soak timeout. |
| `SOAK_MODEL` | `npm run soak` | Model used for soak requests. |
| `CLAUDE_PROXY_CANARY_MODELS` | `npm run canary:stream-json` | Comma-separated canary model list. |
| `CLAUDE_PROXY_CANARY_TIMEOUT_MS` | `npm run canary:stream-json` | Canary timeout. |
| `SDK_MATRIX_BASE_URL` | `npm run sdk:matrix` | Proxy base URL. |
| `SDK_MATRIX_MODEL` | `npm run sdk:matrix` | Model used by SDK matrix checks. |
| `SDK_MATRIX_TIMEOUT_MS` | `npm run sdk:matrix` | SDK matrix timeout. |
| `SDK_MATRIX_REQUIRE_OPTIONAL` | `npm run sdk:matrix` | Set `1` to fail if optional SDK clients are missing. |
| `SDK_MATRIX_PYTHON` | `npm run sdk:matrix` | Python executable for Python SDK checks. |
| `FAILURE_SIM_BASE_URL` | `npm run failure:sim` | Proxy base URL. |
| `FAILURE_SIM_MODEL` | `npm run failure:sim` | Model used by failure simulation. |
| `FAILURE_SIM_TIMEOUT_MS` | `npm run failure:sim` | Failure simulation timeout. |

## Keeping local config private

Recommended patterns:

- Keep LaunchAgent plists with real secrets outside the repo.
- Use placeholders in checked-in examples: `<HOME>`, `<path-to-n8n-mcp>`, `<n8n-api-key>`.
- Prefer OS keychains or your automation platform's secret resolver for long-lived API keys.
- Add local config files and trace databases to `.gitignore` before experimenting.
