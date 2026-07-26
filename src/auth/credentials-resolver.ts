// OAuth-Token-Resolver für isolated-Mode Spawns (Welle 5 Phase 5A.5.1).
//
// Anthropic Claude Code CLI legt ihren OAuth-AccessToken im Klartext unter
// ~/.claude/.credentials.json ab. Im --bare-Mode liest die CLI weder OAuth
// noch Keychain — sie braucht ANTHROPIC_API_KEY als env-Variable. Dieses
// Modul liefert das Bridging.
//
// Sicherheit: das Modul liest nur das User-eigene HOME-File, schreibt nichts.
// Token wird im Memory ge-cached mit File-mtime als Invalidation; bei Token-
// Rotation durch die CLI (User macht `claude /login` neu) bekommt der nächste
// resolveAnthropicApiKey()-Aufruf den frischen Token.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CredentialsResolverDeps {
  // Pfad zum credentials-File (überschreibbar für Tests).
  credentialsPath?: string;
  // FS-readFile + stat-Hooks (überschreibbar für Tests).
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
  // Jetzt-Zeit für Tests (Token-Expiry-Check).
  now?: () => number;
  // Zweite Token-Quelle: CLAUDE_CODE_OAUTH_TOKEN aus der Umgebung
  // (überschreibbar für Tests). Siehe readEnvToken() unten.
  envToken?: () => string | undefined;
}

interface CachedToken {
  token: string;
  fileMtimeMs: number;
  expiresAtMs: number | null;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number; // unix-ms
  };
}

export class CredentialsExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsExpiredError";
  }
}

export class CredentialsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsNotFoundError";
  }
}

export class CredentialsMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsMalformedError";
  }
}

const DEFAULT_PATH = join(homedir(), ".claude", ".credentials.json");

// Cache-TTL zusätzlich zur mtime-Invalidation: defensiver Fallback falls
// File-System-mtime auf manchen FS nicht zuverlässig (z.B. tmpfs in CI).
const FALLBACK_TTL_MS = 60_000;

export function createCredentialsResolver(deps: CredentialsResolverDeps = {}) {
  const path = deps.credentialsPath ?? DEFAULT_PATH;
  const fsRead = deps.readFile ?? readFile;
  const fsStat = deps.stat ?? (async (p: string) => stat(p));
  const now = deps.now ?? Date.now;
  const envToken = deps.envToken ?? (() => process.env.CLAUDE_CODE_OAUTH_TOKEN);

  let cache: CachedToken | null = null;
  let lastResolvedAtMs = 0;

  // Zweite Token-Quelle für Deployments ohne interaktives `claude /login`.
  //
  // Das Modul entstand, als der Token ausschliesslich aus einem Browser-Login
  // stammte und deshalb als Datei vorlag. Wird der Host stattdessen per
  // `claude setup-token` aufgesetzt (headless, kein Browser pro Maschine),
  // existiert diese Datei nie -- der isolated-Mode lief dann in ein
  // credentials_not_found und jede Hintergrund-Pipeline stand still, ohne dass
  // dem Aufrufer klar war warum. Die Umgebungsvariable ist in dem Fall die
  // einzige Quelle. Datei hat weiter Vorrang: nur sie kennt expiresAt und
  // rotiert von selbst.
  function readEnvToken(): string | undefined {
    const t = envToken()?.trim();
    return t ? t : undefined;
  }

  async function resolve(): Promise<string> {
    // Schritt 1: mtime prüfen (Token-Rotation-Detection).
    let mtimeMs: number;
    try {
      const s = await fsStat(path);
      mtimeMs = s.mtimeMs;
    } catch (err) {
      const fromEnv = readEnvToken();
      if (fromEnv) return fromEnv;
      throw new CredentialsNotFoundError(
        `Cannot stat credentials file ${path}: ${(err as Error).message}. ` +
          `Run \`claude /login\` on the host to create it, ` +
          `or set CLAUDE_CODE_OAUTH_TOKEN (\`claude setup-token\`).`,
      );
    }

    // Cache-Hit: file unchanged + ttl nicht abgelaufen.
    if (
      cache !== null &&
      cache.fileMtimeMs === mtimeMs &&
      now() - lastResolvedAtMs < FALLBACK_TTL_MS
    ) {
      assertNotExpired(cache, now);
      return cache.token;
    }

    // Schritt 2: File lesen + parsen.
    let raw: string;
    try {
      raw = await fsRead(path, "utf8");
    } catch (err) {
      throw new CredentialsNotFoundError(
        `Cannot read credentials file ${path}: ${(err as Error).message}`,
      );
    }

    let parsed: CredentialsFile;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CredentialsMalformedError(
        `credentials file ${path} is not valid JSON: ${(err as Error).message}`,
      );
    }

    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      throw new CredentialsMalformedError(
        `credentials file ${path} missing claudeAiOauth.accessToken field. ` +
          `Run \`claude /login\` to refresh.`,
      );
    }

    const expiresAtMs = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;

    const fresh: CachedToken = {
      token: oauth.accessToken,
      fileMtimeMs: mtimeMs,
      expiresAtMs,
    };

    assertNotExpired(fresh, now);

    cache = fresh;
    lastResolvedAtMs = now();
    return fresh.token;
  }

  function clearCache(): void {
    cache = null;
    lastResolvedAtMs = 0;
  }

  return {
    resolve,
    clearCache,
    // Für init-pool: prüft, ob seit lastResolvedAt das File geändert wurde,
    // damit gepoolte Subprocesses bei Token-Rotation discarded werden können.
    async hasChangedSince(timestampMs: number): Promise<boolean> {
      try {
        const s = await fsStat(path);
        return s.mtimeMs > timestampMs;
      } catch {
        // Kein File, aber ein Token in der Umgebung: dann gibt es nichts, was
        // rotieren koennte -- "unveraendert" melden, sonst verwirft der Pool
        // bei jeder Abfrage seine warmen Slots.
        if (readEnvToken()) return false;
        // File weg → "hat sich geändert" (zwingt re-resolve, wird dann mit
        // CredentialsNotFoundError korrekt fehlschlagen).
        return true;
      }
    },
    /**
     * Liefert die expiresAtMs des aktuell gecachten Tokens (oder null wenn
     * legacy-format ohne expiresAt). Pool-Code nutzt das um warm-Slot-Max-Age
     * an die Token-Lebenszeit zu binden — Safety-Window ~5 min, damit kein
     * Slot in-flight expired.
     */
    getCachedExpiresAtMs(): number | null {
      return cache?.expiresAtMs ?? null;
    },
  };
}

function assertNotExpired(cached: CachedToken, now: () => number): void {
  if (cached.expiresAtMs === null) return;
  if (cached.expiresAtMs > now()) return;
  throw new CredentialsExpiredError(
    `Anthropic OAuth token expired at ${new Date(cached.expiresAtMs).toISOString()}. ` +
      `Run \`claude /login\` on the host to refresh.`,
  );
}

// Default-Singleton für normale Verwendung.
let defaultResolver: ReturnType<typeof createCredentialsResolver> | null = null;

export function resolveAnthropicApiKey(): Promise<string> {
  if (defaultResolver === null) {
    defaultResolver = createCredentialsResolver();
  }
  return defaultResolver.resolve();
}

export function clearDefaultResolverCache(): void {
  defaultResolver?.clearCache();
}

export function hasCredentialsChangedSince(timestampMs: number): Promise<boolean> {
  if (defaultResolver === null) {
    defaultResolver = createCredentialsResolver();
  }
  return defaultResolver.hasChangedSince(timestampMs);
}

export function getCachedExpiresAtMs(): number | null {
  if (defaultResolver === null) return null;
  return defaultResolver.getCachedExpiresAtMs();
}
