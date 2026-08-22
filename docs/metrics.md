# Metrics catalogue

Every series `claude-proxy` exposes on `GET /metrics`, what it means, and how to read it.

Source of truth is `src/server/metrics.ts` (`renderMetrics()`); the values it prints are
read at scrape time from the module that produces them (`session-pool.ts`,
`init-pool.ts`, `sticky-session-pool.ts`, `routes.ts`, `trace/store.ts`, `runtime.ts`).
If this file and the code disagree, the code wins — and the disagreement is a bug report.

## Why this file exists

A metric nobody has written down is a metric nobody looks at. The init pool was switched
off by `CLAUDE_PROXY_INIT_POOL=0` for months; nothing in the exposition said so, so a
repair built on top of it (`M2`) could not work and nobody noticed. The counters that
would have shown it were added afterwards — and they only help if someone knows they
exist. Hence the catalogue.

## Reading the endpoint

```bash
curl -s http://127.0.0.1:3456/metrics
```

- Registered at `src/server/index.ts:54`, handler `handleMetrics` (`metrics.ts:384`).
- Content type `text/plain; version=0.0.4` (`metrics.ts:385`) — Prometheus text format,
  hand-rolled, no `prom-client` dependency.
- The path is on the auth whitelist (`src/server/middleware/auth.ts:22-29`), so it answers
  without a Bearer token even when `/v1/*` is protected. Do not expose it publicly.

**Absent is not zero.** Some families are only printed once they have data, because they
are keyed by observed label combinations: `claude_proxy_requests_total`,
`claude_proxy_tokens_total`, `claude_proxy_estimated_cost_usd_total` and the
`claude_proxy_request_duration_seconds` histogram are missing entirely until the first
request completes. Three families print an explicit placeholder sample instead of
vanishing — `claude_proxy_stream_fallback_total{reason="none"} 0` (`metrics.ts:194-195`),
`claude_proxy_subprocess_spawn_failures_total{runtime="none"} 0` (`metrics.ts:325-326`) and
`claude_proxy_error_class_total{class="none"} 0` (`metrics.ts:342-343`). Everything else is
a gauge or a fixed-label counter and is always emitted, including at zero.

**Label discipline.** No series is ever labelled by request id, prompt content, or a raw
client-supplied model string. Model labels go through `canonicalizeMetricModel()`
(`metrics.ts:122-136`), which asks `models/registry.ts` first and falls back to a short
prefix list, then to `other` / `unknown`. Fallback and error reasons come from the closed
`ProtocolErrorClass` union in `src/errors.ts:13-38`.

## Requests, tokens, cost, latency

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_requests_total` | counter | `runtime` (`stream-json`\|`print`), `model`, `status` (`ok`\|`error`) | Completed chat-completion requests. Fed by `recordRequest()` (`metrics.ts:61-73`), printed at `metrics.ts:155-162`. |
| `claude_proxy_tokens_total` | counter | `model`, `estimated` (`true`\|`false`), `direction` | Claude token usage read off completed responses. `direction` takes exactly five values — `input`, `cache_creation_input`, `cached_input`, `output`, `total` (`metrics.ts:95-99`). `total` is the upstream-reported total, so **do not sum the directions**; pick one. `estimated="true"` means the number was derived, not reported. |
| `claude_proxy_estimated_cost_usd_total` | counter | `model`, `estimated` | API-equivalent cost in USD, printed with six decimals (`metrics.ts:174`). Written only when a cost estimate exists (`metrics.ts:100`). It is a *reference* price for a subscription-backed proxy, not a bill. |
| `claude_proxy_request_duration_seconds` | histogram | `runtime`, `model`, `status` | Handler latency, `_bucket` / `_sum` / `_count` (`metrics.ts:180-189`). Bucket bounds are fixed at 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120 s plus `+Inf` (`HIST_BUCKETS_MS`, `metrics.ts:45`). |

Reading it: latency percentiles come from the buckets, e.g.
`histogram_quantile(0.95, sum by (le) (rate(claude_proxy_request_duration_seconds_bucket[5m])))`.
The error share is
`sum(rate(claude_proxy_requests_total{status="error"}[5m])) / sum(rate(claude_proxy_requests_total[5m]))`.

## Stream fallback

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_stream_fallback_total` | counter | `reason` | `stream-json` → `print` fallbacks, one increment per fallback, keyed by the classified error (`routes.ts:465-467`). Printed at `metrics.ts:192-200`. |

`reason` values are `ProtocolErrorClass` members that pass `isStreamLayerFault()`, so
transport faults like `init_handshake_timeout`, `worker_died`, `turn_timeout`,
`spawn_enoent`, `stdin_closed`, `worker_invalid`, `control_protocol`,
`unsupported_cli_flag`. `reason="none"` with value 0 is the placeholder, not a real reason.

Caveat when reading: fallback only fires when `CLAUDE_PROXY_FALLBACK_ON_STREAM_FAILURE=1`
and no SSE bytes have been sent yet (`routes.ts:65`, `routes.ts:459-464`). A permanent 0 therefore means
either "no stream faults" or "fallback is switched off" — check the env var, this family
has no `_enabled` gauge of its own.

## Session pool (`claude_proxy_pool_*`)

The default reuse pool in `src/subprocess/session-pool.ts`.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_pool_size` | gauge | `state` (`live`\|`max`) | Live workers vs. the configured cap. `max` is `CLAUDE_PROXY_POOL_MAX`, default 4 (`session-pool.ts:48-51`); printed at `metrics.ts:205-207`. |
| `claude_proxy_pool_ttl_evictions_total` | counter | — | Workers dropped for idle TTL (`session-pool.ts:358`). TTL is `CLAUDE_PROXY_POOL_TTL_MS`, default 600 000 ms with a hard floor of 360 000 ms (`session-pool.ts:40-44`). |
| `claude_proxy_pool_lru_evictions_total` | counter | — | Workers dropped to honour the cap (`session-pool.ts:373`). |
| `claude_proxy_pool_fingerprint_mismatches_total` | counter | — | Slots discarded because the spawn fingerprint drifted (model rename, env change) between insertion and checkout (`session-pool.ts:233`). |
| `claude_proxy_pool_warm_hits_total` | counter | — | Conversations served from a live slot (`session-pool.ts:221`). |
| `claude_proxy_pool_cold_spawns_total` | counter | — | Conversations that had to spawn (`session-pool.ts:245`). |

Reading it: reuse rate is
`warm_hits_total / (warm_hits_total + cold_spawns_total)`. A rising
`lru_evictions_total` next to `pool_size{state="live"}` pinned at
`pool_size{state="max"}` says the cap is the binding constraint — raise
`CLAUDE_PROXY_POOL_MAX`. A rising `fingerprint_mismatches_total` is not a capacity
problem: something changes the spawn configuration between requests.

## Init pool (`claude_proxy_init_pool_*`)

The pre-warmed subprocess supply in `src/subprocess/init-pool.ts` — the pool whose silent
shutdown this catalogue exists to prevent.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_init_pool_enabled` | gauge | — | 1 when the supply runs at all. Source `initPoolStats().enabled`, i.e. `CLAUDE_PROXY_INIT_POOL !== "0"` — **default on** (`init-pool.ts:78`, `init-pool.ts:171`); printed at `metrics.ts:258-260`. |
| `claude_proxy_init_pool_isolated_enabled` | gauge | — | 1 when *isolated* (`injectOAuthEnv`) configurations are pre-warmed too. Reports the **effective** state: `ENABLED && ISOLATED_ENABLED` (`init-pool.ts:172`), switched off by `CLAUDE_PROXY_BARE_POOL=0` or `CLAUDE_PROXY_BARE_POOL_SIZE=0` (`init-pool.ts:87-94`); printed at `metrics.ts:262-266`. |
| `claude_proxy_init_pool_size` | gauge | `state` (`live`\|`max`) | Parked processes vs. the slot budget. `max` is `CLAUDE_PROXY_INIT_POOL_MAX`, default 6 (`init-pool.ts:98-100`); printed at `metrics.ts:268-271`. |
| `claude_proxy_init_pool_ttl_seconds` | gauge | — | Idle TTL of a parked slot, in seconds. `CLAUDE_PROXY_INIT_POOL_TTL_MS`, default 900 000 ms → 900 (`init-pool.ts:108-110`, `metrics.ts:273-275`). |
| `claude_proxy_init_pool_warm_hits_total` | counter | — | Acquires served from an already-initialised slot (`init-pool.ts:257`). |
| `claude_proxy_init_pool_cold_spawns_total` | counter | — | Acquires that had to spawn — no slot, or the slot was rejected (`init-pool.ts:244`, `init-pool.ts:266`). |
| `claude_proxy_init_pool_discarded_total` | counter | — | Parked slots thrown away as unfit: dead process, OAuth-token rotation, or the token's 5-minute expiry window (`init-pool.ts:262`). |
| `claude_proxy_init_pool_evictions_total` | counter | — | Parked slots evicted for idle TTL or to honour the slot cap (`init-pool.ts:332`, `init-pool.ts:348`). |

### How to read the init pool

**Hit rate.** `warm_hits_total` against `cold_spawns_total` is the whole point of the
pool:

```promql
rate(claude_proxy_init_pool_warm_hits_total[15m])
  / (rate(claude_proxy_init_pool_warm_hits_total[15m])
     + rate(claude_proxy_init_pool_cold_spawns_total[15m]))
```

A hit rate near zero while `init_pool_enabled` is 1 means the supply is running and not
being used — usually because the requested configurations are not poolable, or because
slots are discarded before they can be reused (check `discarded_total`).

**`evictions_total > 0` means the budget is too small for the number of configurations in
use.** Slots are keyed per spawn configuration, so `CLAUDE_PROXY_INIT_POOL_MAX` (default
6) has to cover all of them at once; when it does not, each new configuration evicts
somebody else's warm slot and both lose. Raise `_MAX` to at least the number of distinct
configurations you actually spawn. Idle-TTL eviction lands in the same counter, so read
it against `init_pool_size{state="live"}`: sitting at `max` points at the cap, sitting
well below it points at the TTL.

**A wall of zeros is ambiguous, and that is why the two gauges are there.** All init-pool
counters flat at 0 means one of two very different things:

- `claude_proxy_init_pool_enabled 0` → **switched off.** This is the failure mode that
  survived for months. Remove `CLAUDE_PROXY_INIT_POOL=0` from the service environment and
  restart; the default is on.
- `claude_proxy_init_pool_enabled 1` → **no traffic** (or nothing poolable). The supply is
  alive and simply has not been asked for anything. Nothing to fix here.

The isolated gauge splits the same way: `enabled 1` with `isolated_enabled 0` means only
the pre-warming of isolated configurations is off (`CLAUDE_PROXY_BARE_POOL`), while
`0`/`0` means the whole supply is down. `isolated_enabled` deliberately reports the
effective state, so it can never claim to be working while the pool above it is dead.

The same reading applies to the other two state gauges: `claude_proxy_sticky_pool_enabled 0`
means sticky sessions were never opted into (`CLAUDE_PROXY_STICKY_SESSIONS=1` enables
them), and `claude_proxy_trace_store_enabled 0` means traces are not being kept
(`CLAUDE_PROXY_TRACE_ENABLED=1`, or a configured SQLite store).

## Sticky sessions (`claude_proxy_sticky_*`, `claude_proxy_session_mode_total`)

Opt-in pool in `src/subprocess/sticky-session-pool.ts`, off by default.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_sticky_pool_size` | gauge | `state` (`live`\|`max`) | Live sticky sessions vs. cap. `max` is `CLAUDE_PROXY_STICKY_MAX_SESSIONS`, default 8 (`server/sticky-options.ts:63`); printed at `metrics.ts:295-298`. |
| `claude_proxy_sticky_pool_enabled` | gauge | — | 1 only when `CLAUDE_PROXY_STICKY_SESSIONS=1` (`server/sticky-options.ts:56`, `metrics.ts:299-301`). |
| `claude_proxy_sticky_session_hits_total` | counter | — | Sticky requests served by an existing live CLI session. |
| `claude_proxy_sticky_session_cold_starts_total` | counter | — | Sticky requests that created a new live session. |
| `claude_proxy_sticky_session_evictions_total` | counter | `reason` | Five fixed reasons, all always printed: `idle_ttl`, `absolute_ttl`, `lru`, `unhealthy`, `fingerprint_mismatch` (`metrics.ts:308-314`). |
| `claude_proxy_session_mode_total` | counter | `mode` (`pool`\|`sticky`\|`stateless`), `status` (`accepted`\|`rejected`) | Requests per explicitly requested session mode. All six combinations are always printed (`metrics.ts:315-320`). |

Reading it: `rejected` climbing for `mode="sticky"` while
`sticky_pool_enabled` is 0 is the expected shape of "a client asks for sticky sessions
that the operator never enabled" — the client is misconfigured, not the proxy.

## Runtime, failures, error classes

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_subprocess_spawn_failures_total` | counter | `runtime` | Failed `claude` subprocess spawns, from `recordSpawnFailure()` (`metrics.ts:75-77`), printed at `metrics.ts:323-331`. Placeholder `runtime="none"` until the first failure. |
| `claude_proxy_runtime_default` | gauge | `runtime` (`stream-json`\|`print`) | Exactly one of the two samples is 1 — the resolved default runtime (`metrics.ts:334-337`, `subprocess/runtime.ts:34-44`). Set by `CLAUDE_PROXY_RUNTIME`; the legacy `CLAUDE_PROXY_STREAM_JSON=0` still forces `print`. |
| `claude_proxy_error_class_total` | counter | `class` | Errors by `ProtocolErrorClass` (`metrics.ts:79-81`, printed `metrics.ts:340-348`). The closed set lives in `src/errors.ts:13-38` and covers transport faults, `upstream_soft_dead` / `upstream_hard_dead`, model-layer errors (`rate_limit`, `auth_error`, `content_policy`, `context_length`), client errors (`invalid_request`, `client_disconnect`, `cold_spawn_rate_limited`), `internal_error`, `other_stream_fault`, `unknown`. |
| `claude_proxy_tool_call_parse_total` | counter | `outcome` | Tool-call parse outcomes for the caller-dispatched tool bridge (`metrics.ts:83-86`, printed `metrics.ts:351-357`). |

`claude_proxy_tool_call_parse_total` has one trap worth naming: four of its `outcome`
values — `emitted`, `no_call`, `malformed`, `rejected` — count *parse attempts*, but
`outcome="calls_emitted"` counts *tool calls*, summed across attempts (`metrics.ts:85`).
It is a different unit in the same series, so it must not be added to the other four.

## Trace store

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `claude_proxy_trace_store_size` | gauge | `state` (`current`\|`capacity`) | Trace store occupancy vs. capacity (`metrics.ts:361-364`, `trace/store.ts:87-92`). Capacity is `CLAUDE_PROXY_TRACE_CAPACITY`. `current` is forced to 0 while the store is disabled (`trace/store.ts:90`). |
| `claude_proxy_trace_store_enabled` | gauge (untyped in the exposition) | — | 1 when tracing is on: `CLAUDE_PROXY_TRACE_ENABLED=1` **or** a configured SQLite trace store (`trace/store.ts:27`). Printed at `metrics.ts:365`. |

Note for scraper authors: `claude_proxy_trace_store_enabled` is emitted **without its own
`# HELP` / `# TYPE` lines** (`metrics.ts:365`), unlike every other series here. Prometheus
therefore treats it as untyped. It parses and scrapes fine; it is only inconsistent.

## Example query

Two questions in one scrape — "is the supply on, and is it working":

```bash
curl -s http://127.0.0.1:3456/metrics \
  | grep -E '^claude_proxy_init_pool_(enabled|isolated_enabled|size|warm_hits_total|cold_spawns_total|evictions_total)'
```

```
claude_proxy_init_pool_enabled 1
claude_proxy_init_pool_isolated_enabled 1
claude_proxy_init_pool_size{state="live"} 4
claude_proxy_init_pool_size{state="max"} 6
claude_proxy_init_pool_warm_hits_total 137
claude_proxy_init_pool_cold_spawns_total 12
claude_proxy_init_pool_evictions_total 0
```

Read as: supply on, isolated pre-warming on, 4 of 6 slots parked, hit rate 137/149 ≈ 92 %,
budget sufficient. Had the first line read `0`, the 0s below it would have meant nothing
at all — which is exactly the reading mistake that let a dead init pool survive.
