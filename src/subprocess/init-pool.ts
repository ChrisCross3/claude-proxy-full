/**
 * Pre-initialized stream-json subprocess pool ("Vorrat").
 *
 * Cold start of a stream-json subprocess takes ~5s: spawn (1s) + claude
 * session-init hooks (2-3s) + initialize control_request handshake (1s).
 * Clients (openclaw) often disconnect before that gap closes when the
 * conversation is "cold" — no warm session-pool entry to reuse.
 *
 * The pool keeps one already-initialized subprocess waiting per *spawn
 * configuration*. acquirePreInit() pops the warm one, kicks off a background
 * refill, and returns a subprocess ready to receive submitTurn() immediately —
 * shaving ~5s off every conversation-cold turn.
 *
 * ---------------------------------------------------------------------------
 * Warum ein Pool und nicht zwei (Befund M2, repariert 2026-08-21)
 * ---------------------------------------------------------------------------
 * Vorher gab es hier zwei getrennte Vorräte: `slots` (nur nach Modell
 * geschlüsselt, für Default-Aufrufe) und `bareSlots` (für die isolierten
 * Honcho-Aufrufe). Der zweite war unerreichbar. Die Route durfte ihn nur
 * betreten, wenn der Aufruf *gar keine* Flags trug — aber jeder isolierte
 * Aufruf trägt acht erzwungene `--disallowedTools` und (bei `response_format`)
 * einen abgeleiteten `--system-prompt`. Beides sind Spawn-Argumente: ein warm
 * gehaltener Prozess kann sie nicht nachträglich bekommen. Die Bedingung war
 * damit strukturell unerfüllbar, und der ganze Zweig war toter Code.
 *
 * Die Reparatur nimmt dem Vorrat die Annahme "warm = flaggenlos". Der Schlüssel
 * ist jetzt (Modell + Fingerabdruck der vollständigen Spawn-Konfiguration).
 * Ein Slot wird nur an einen Aufruf ausgeliefert, der exakt dieselben Spawn-
 * Argumente verlangt — die Flags müssen also nicht mehr leer sein, sie müssen
 * nur passen. Damit fällt der zweite Vorrat weg: der isolierte Pfad ist bloß
 * eine weitere Konfiguration im selben Pool.
 *
 * Warum nicht über den SessionPool (session-pool.ts)?
 * Der führt zwar bereits einen `systemPromptKey` in seinem Fingerabdruck und
 * könnte verschiedene System-Prompts unterscheiden — aber er ist ein
 * *Konversations*-Pool: sein Schlüssel ist der Hash der bisherigen Turns, und
 * seine Slots tragen Gesprächszustand. Isolierte Aufrufe sind einmalig und
 * zustandslos, haben also nie einen Vorgänger-Turn; sie landen bei ihm
 * konstruktionsbedingt immer im `cold()`-Zweig. Übernommen ist deshalb nicht
 * sein Pool, sondern seine Idee: ein SHA-256-Fingerabdruck über die
 * Optionen, inklusive System-Prompt. `stableStringify` wird aus fingerprint.ts
 * geteilt, damit die beiden Schlüsselberechnungen nicht auseinanderlaufen.
 *
 * ---------------------------------------------------------------------------
 * Größe des Vorrats
 * ---------------------------------------------------------------------------
 * Ein CLI-Prozess kostet ~240 MB, die VM hat 12 GB. Der Schlüsselraum ist
 * durch die Konfiguration jetzt offen (Honcho benutzt sechs `json_schema`-
 * Stellen, also sechs verschiedene System-Prompts), deshalb:
 *   - genau EIN Slot je Konfiguration, nie mehrere,
 *   - global gedeckelt (MAX_SLOTS, Default 6 ≈ 1,4 GB) mit LRU-Verdrängung,
 *   - Leerlauf-TTL, damit ein einmalig benutztes Schema nicht dauerhaft
 *     240 MB parkt. Vorher brauchte es keine TTL, weil der Schlüsselraum auf
 *     die Handvoll Modelle beschränkt war.
 *
 * Auth note: --bare disables OAuth/keychain, so such a spawn must carry
 * ANTHROPIC_API_KEY env. We read the OAuth access token from
 * ~/.claude/.credentials.json at spawn time (via credentials-resolver). If the
 * token rotates while a slot is warm, we discard the slot and refill on next
 * acquire (via hasCredentialsChangedSince). Das gilt nur für Slots mit
 * `injectOAuthEnv` — alle anderen holen ihren Token selbst.
 */

import { createHash } from "crypto";
import { StreamJsonSubprocess, type StreamJsonOptions } from "./stream-json-manager.js";
import { stableStringify } from "./fingerprint.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { hasCredentialsChangedSince, getCachedExpiresAtMs, clearDefaultResolverCache } from "../auth/credentials-resolver.js";

/**
 * Safety window in ms: a slot whose OAuth-token expires within this window is
 * discarded and respawned. 5 min is conservative — typical Honcho call
 * duration is ~15s, so this leaves ample headroom for a long-running call to
 * complete with a still-valid token.
 */
const TOKEN_SAFETY_WINDOW_MS = 5 * 60 * 1000;

const ENABLED = process.env.CLAUDE_PROXY_INIT_POOL !== "0"; // default on

/**
 * Legacy-Schalter aus der Zeit der zwei Pools. Er schaltet weiterhin genau
 * das ab, was er immer abgeschaltet hat: das Vorwärmen der isolierten
 * (`injectOAuthEnv`-)Konfigurationen. Der Default-Vorrat bleibt davon
 * unberührt.
 */
const ISOLATED_ENABLED = (() => {
  if (process.env.CLAUDE_PROXY_BARE_POOL === "0") return false;
  const raw = process.env.CLAUDE_PROXY_BARE_POOL_SIZE;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n === 0) return false;
  }
  return true;
})();

/** Höchstzahl gleichzeitig geparkter Prozesse über alle Konfigurationen. */
const MAX_SLOTS = (() => {
  const n = Number.parseInt(process.env.CLAUDE_PROXY_INIT_POOL_MAX || "6", 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
})();

/**
 * Leerlauf-TTL eines Slots. 98 % der isolierten Aufrufe folgen binnen 600 s auf
 * den vorherigen; 15 min lassen Luft und geben den Speicher trotzdem zurück,
 * wenn ein Schema verstummt.
 */
const SLOT_TTL_MS = (() => {
  const n = Number.parseInt(process.env.CLAUDE_PROXY_INIT_POOL_TTL_MS || "900000", 10);
  return Number.isFinite(n) && n > 0 ? n : 900_000;
})();

/** Alles, was `StreamJsonSubprocess.start()` als Spawn-Argument verarbeitet. */
export type PoolSpawnConfig = Omit<StreamJsonOptions, "model" | "cwd">;

interface Slot {
  sub: StreamJsonSubprocess;
  /** Zeitpunkt des Spawns — Bezug für die Token-Rotations-Prüfung. */
  spawnedAt: number;
  /** Zeitpunkt der Einlagerung — Bezug für TTL und LRU. */
  parkedAt: number;
  /** Slot hängt am OAuth-Token und muss bei Rotation verworfen werden. */
  oauthBound: boolean;
}

const slots: Map<string, Slot> = new Map();
const refilling: Set<string> = new Set();

/**
 * Observation counters for the init-pool. Mirrors the poolCounters pattern in
 * session-pool.ts: the counter lives where it is produced. Bounded cardinality
 * (no per-request labels) so a /metrics exporter can read it directly.
 */
export const initPoolCounters = {
  /** Acquire served from an already-initialized slot. */
  warmHits: 0,
  /** Acquire that had to spawn (no slot, or slot rejected). */
  coldSpawns: 0,
  /** Slots verworfen wegen Token-Rotation / Ablauffenster / Unfitness. */
  discarded: 0,
  /** Slots verdrängt, weil MAX_SLOTS erreicht war oder die TTL ablief. */
  evictions: 0,
};

/**
 * Snapshot für /metrics und Diagnose.
 *
 * `enabled` und `isolatedEnabled` gehören mit hinaus, weil die Zähler allein
 * ihren eigenen Ausfall nicht kennen: `warmHits 0` bei `size 0` heißt entweder
 * „abgeschaltet" oder „noch kein Verkehr", und diese Zweideutigkeit hat den
 * toten Vorrat 3,5 Tage überleben lassen.
 *
 * Beide Felder melden den **wirksamen** Zustand, nicht den rohen Schalter:
 * `isolatedEnabled` ist nur dann true, wenn auch der Gesamtvorrat läuft — denn
 * `poolable()` weist bei `!ENABLED` jede Konfiguration ab, die isolierte
 * eingeschlossen. Ein rohes `ISOLATED_ENABLED` würde hier „das isolierte
 * Vorwärmen arbeitet" behaupten, während nichts arbeitet; die zwei Fälle
 * bleiben trotzdem unterscheidbar, weil `enabled` daneben steht
 * (Gesamtabschaltung = 0/0, nur isoliert aus = 1/0).
 */
export function initPoolStats(): {
  size: number;
  max: number;
  ttlMs: number;
  enabled: boolean;
  isolatedEnabled: boolean;
} {
  return {
    size: slots.size,
    max: MAX_SLOTS,
    ttlMs: SLOT_TTL_MS,
    enabled: ENABLED,
    isolatedEnabled: ENABLED && ISOLATED_ENABLED,
  };
}

/** Test hook: drop all slots and zero the counters. Never called in production. */
export function __resetInitPoolForTests(): void {
  drainInitPool();
  refilling.clear();
  initPoolCounters.warmHits = 0;
  initPoolCounters.coldSpawns = 0;
  initPoolCounters.discarded = 0;
  initPoolCounters.evictions = 0;
}

/**
 * Fingerabdruck einer Spawn-Konfiguration. Alle Felder gehen ein, weil jedes
 * von ihnen ein CLI-Argument wird (siehe StreamJsonSubprocess.start) und ein
 * laufender Prozess keines davon nachträglich annehmen kann.
 *
 * `disallowedTools` wird sortiert, damit die Reihenfolge des Merges in
 * routes.ts den Schlüssel nicht verändert. Objekte gehen über stableStringify,
 * damit die Schlüsselreihenfolge egal ist.
 */
function configKey(model: ClaudeModel, cfg: PoolSpawnConfig): string {
  const canonical = {
    disallowedTools: [...(cfg.disallowedTools ?? [])].sort(),
    effort: cfg.effort ?? null,
    thinking: cfg.thinking ?? null,
    debug: cfg.debug ?? null,
    maxBudgetUsd: cfg.maxBudgetUsd ?? null,
    permissionMode: cfg.permissionMode ?? null,
    systemPrompt: cfg.systemPrompt ?? null,
    appendSystemPrompt: cfg.appendSystemPrompt ?? null,
    agent: cfg.agent ?? null,
    agents: cfg.agents ?? null,
    bare: cfg.bare === true,
    disableSlashCommands: cfg.disableSlashCommands === true,
    jsonSchema: cfg.jsonSchema ?? null,
    maxTurns: cfg.maxTurns ?? null,
    injectOAuthEnv: cfg.injectOAuthEnv === true,
    isolateCwd: cfg.isolateCwd === true,
  };
  const h = createHash("sha256");
  h.update(model);
  h.update("\0cfg\0");
  h.update(stableStringify(canonical));
  return `${model}|${h.digest("hex").slice(0, 16)}`;
}

/** Darf diese Konfiguration überhaupt gepoolt werden? */
function poolable(cfg: PoolSpawnConfig): boolean {
  if (!ENABLED) return false;
  if (cfg.injectOAuthEnv === true && !ISOLATED_ENABLED) return false;
  return true;
}

function spawn(model: ClaudeModel, cfg: PoolSpawnConfig): Promise<StreamJsonSubprocess> {
  const sub = new StreamJsonSubprocess();
  return sub.start({ ...cfg, model }).then(() => sub);
}

/**
 * Acquire an already-initialized subprocess for (model, config), or spawn one.
 *
 * `config` weggelassen = Default-Konfiguration ohne Zusatzflags; so rufen der
 * SessionPool und der StickySessionPool auf.
 */
export async function acquirePreInit(
  model: ClaudeModel,
  config: PoolSpawnConfig = {},
): Promise<StreamJsonSubprocess> {
  if (!poolable(config)) {
    initPoolCounters.coldSpawns++;
    return spawn(model, config);
  }

  evictExpired();

  const key = configKey(model, config);
  const cached = slots.get(key);
  slots.delete(key);

  let result: StreamJsonSubprocess;
  if (cached && (await isSlotFit(cached))) {
    console.error(`[InitPool] Pre-init hit for ${key} (age ${cached.sub.getAge()}ms)`);
    initPoolCounters.warmHits++;
    result = cached.sub;
  } else {
    if (cached) {
      console.error(`[InitPool] Discarding unfit pre-init for ${key}, killing`);
      initPoolCounters.discarded++;
      cached.sub.kill();
    }
    console.error(`[InitPool] No pre-init for ${key}, spawning fresh`);
    initPoolCounters.coldSpawns++;
    result = await spawn(model, config);
  }

  // Refill in background — don't await, the request shouldn't wait for it.
  refillSlot(model, config, key).catch((err) => {
    console.error(`[InitPool] Refill failed for ${key}:`, err.message);
  });

  return result;
}

/**
 * Ist der geparkte Prozess noch brauchbar? Neben "lebt er" prüfen wir bei
 * OAuth-gebundenen Slots, ob der Token seit dem Spawn rotiert ist oder
 * demnächst abläuft — ein Slot mit totem Token wäre ein garantierter Fehlschlag
 * mitten im Aufruf.
 */
async function isSlotFit(slot: Slot): Promise<boolean> {
  if (!slot.sub.isHealthy()) return false;
  if (!slot.oauthBound) return true;

  const expiresAt = getCachedExpiresAtMs();
  if (expiresAt !== null && expiresAt - Date.now() < TOKEN_SAFETY_WINDOW_MS) {
    // Ablauffenster: der Cache hält noch den (gültigen) Token, also NICHT
    // clearDefaultResolverCache — nur den Slot wegwerfen.
    return false;
  }
  if (await hasCredentialsChangedSince(slot.spawnedAt)) {
    // Rotation: den Resolver-Cache leeren, damit der nächste Spawn den frischen
    // Token liest.
    clearDefaultResolverCache();
    return false;
  }
  return true;
}

async function refillSlot(model: ClaudeModel, config: PoolSpawnConfig, key: string): Promise<void> {
  if (!poolable(config)) return;
  if (refilling.has(key) || slots.has(key)) return;
  refilling.add(key);
  try {
    const spawnedAt = Date.now();
    const sub = await spawn(model, config);
    if (slots.has(key)) {
      sub.kill(); // raced
      return;
    }
    evictToFit();
    slots.set(key, {
      sub,
      spawnedAt,
      parkedAt: Date.now(),
      oauthBound: config.injectOAuthEnv === true,
    });
    console.error(`[InitPool] Refilled pre-init for ${key} (size=${slots.size}/${MAX_SLOTS})`);
  } finally {
    refilling.delete(key);
  }
}

function evictExpired(): void {
  const now = Date.now();
  for (const [k, s] of slots) {
    if (now - s.parkedAt > SLOT_TTL_MS || !s.sub.isHealthy()) {
      console.error(`[InitPool] TTL evict ${k} (idle=${now - s.parkedAt}ms, ttl=${SLOT_TTL_MS}ms)`);
      initPoolCounters.evictions++;
      s.sub.kill();
      slots.delete(k);
    }
  }
}

/** LRU-Verdrängung, damit der Vorrat MAX_SLOTS nie überschreitet. */
function evictToFit(): void {
  while (slots.size >= MAX_SLOTS) {
    let oldest: { key: string; t: number } | null = null;
    for (const [k, s] of slots) {
      if (!oldest || s.parkedAt < oldest.t) oldest = { key: k, t: s.parkedAt };
    }
    if (!oldest) return;
    console.error(`[InitPool] LRU evict ${oldest.key} (cap=${MAX_SLOTS})`);
    initPoolCounters.evictions++;
    slots.get(oldest.key)?.sub.kill();
    slots.delete(oldest.key);
  }
}

/**
 * Eagerly fill the pool for the given models on startup so the very first
 * request of each model doesn't pay the cold cost.
 *
 * Nur die Default-Konfiguration. Die isolierten Konfigurationen lassen sich
 * beim Start nicht vorwärmen: ihr Schlüssel enthält den System-Prompt, und der
 * entsteht erst aus dem `response_format` des jeweiligen Honcho-Aufrufs — beim
 * Serverstart ist er unbekannt. Ein flaggenloser Vorrats-Prozess wäre für sie
 * wertlos (genau das war der alte Fehler). Ihr Vorwärmen passiert deshalb
 * bewusst beim ersten Aufruf: der erste Aufruf je Schema startet kalt und füllt
 * im Hintergrund nach, alle folgenden treffen warm. Da 96 % der isolierten
 * Aufrufe binnen 60 s auf den vorherigen folgen, kostet das einen Kaltstart je
 * Schema und Vorratslücke, nicht je Aufruf.
 */
export function preWarm(models: ClaudeModel[]): void {
  if (!ENABLED) return;
  for (const m of models) {
    refillSlot(m, {}, configKey(m, {})).catch((err) => {
      console.error(`[InitPool] Pre-warm failed for ${m}:`, err.message);
    });
  }
}

export function drainInitPool(): void {
  for (const [k, s] of slots) {
    s.sub.kill();
    console.error(`[InitPool] Drained ${k}`);
  }
  slots.clear();
}

process.on("SIGTERM", drainInitPool);
process.on("SIGINT", drainInitPool);
