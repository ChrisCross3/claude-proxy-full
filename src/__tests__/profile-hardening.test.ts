/**
 * Härtung der Profile — die Zusage, dass sich hinter dem Proxy nichts wie ein
 * Agent verhält.
 *
 * ANLASS: hermes-agent beschreibt sein Backend als "a plain model endpoint ...
 * stateless inference services, not autonomous agents themselves". Ein
 * Backend, das CLAUDE.md liest, ein eigenes Gedächtnis führt, Werkzeuge
 * ausführen kann und Prozesse über Anfragen hinweg wiederverwendet, ist genau
 * das nicht.
 *
 * WARUM DIESE DATEI NÖTIG WAR: die Umstellung des Lead-Pfads auf
 * `--bare --restricted --strict-mcp-config --tools ""` plus erzwungenem
 * stateless ließ die bestehende Suite (615 Fälle) **vollständig grün**. Keine
 * einzige Prüfung sah die Spawn-Argumente des Standardpfads. Eine Absicherung,
 * deren Wegfall keinen Test rot macht, ist eine Absichtserklärung.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getProfile,
  listProfiles,
  LEAD_PROFILE,
  ISOLATED_PROFILE,
  type Profile,
} from "../server/profiles.js";
import {
  cliInputForProfile,
  enforceProfileSessionMode,
  assertHaertungNichtVerloren,
} from "../server/routes.js";
import { buildSpawnArgs } from "../subprocess/stream-json-manager.js";
import {
  setClaudeCliCapabilitiesForTests,
  resetClaudeCliCapabilitiesForTests,
} from "../subprocess/claude-flags.js";

const KOERPER = {
  model: "claude-haiku-4-5",
  messages: [{ role: "user" as const, content: "hallo" }],
};

// --- A) Die Regel gilt für JEDES Profil, nicht für ein benanntes ----------

for (const name of listProfiles()) {
  test(`profil '${name}' ist vollständig gehärtet`, () => {
    const p = getProfile(name) as Profile;
    assert.equal(p.bare, true, "--bare: kein CLAUDE.md, kein Auto-Gedächtnis, keine Skills");
    assert.equal(p.restricted, true, "--restricted: keine ausführenden Werkzeuge");
    assert.equal(p.strictMcpConfig, true, "--strict-mcp-config: keine gefundenen MCP-Server");
    assert.deepEqual(p.tools, [], '--tools "": pauschal alle Werkzeuge aus');
    assert.equal(p.sessionMode, "stateless", "kein Prozess über Anfragen hinweg");
    assert.equal(p.isolateCwd, true, "cwd außerhalb jedes Arbeitsbereichs");
    assert.equal(p.injectOAuthEnv, true, "--bare nimmt der CLI sonst die Anmeldung");
    assert.equal(p.disableSlashCommands, true, "Nutzertext mit / ist kein Befehl");
    assert.ok(p.forceDisallowedTools.length > 0, "Sperrliste als zweite Lage");
  });
}

test("die beiden Profile unterscheiden sich in GENAU einem Feld", () => {
  // Chris hat zwei Profile gewollt, obwohl sie sich heute nur in
  // mapResponseFormat unterscheiden — mit der Auflage, bei jeder Änderung an
  // beide zu denken. Dieser Test macht aus der Auflage eine Mechanik: sobald
  // eine zweite Abweichung entsteht, muss sie hier bewusst eingetragen werden.
  const schluessel = new Set([...Object.keys(LEAD_PROFILE), ...Object.keys(ISOLATED_PROFILE)]);
  const abweichend: string[] = [];
  for (const k of schluessel) {
    const a = JSON.stringify((LEAD_PROFILE as unknown as Record<string, unknown>)[k]);
    const b = JSON.stringify((ISOLATED_PROFILE as unknown as Record<string, unknown>)[k]);
    if (a !== b) abweichend.push(k);
  }
  assert.deepEqual(abweichend.sort(), ["mapResponseFormat"]);
});

// --- B) Der Trichter trägt die Flags wirklich weiter ----------------------

test("cliInputForProfile trägt die Härtung in den CliInput", () => {
  const ci = cliInputForProfile(KOERPER as never, LEAD_PROFILE);
  assert.equal(ci.restricted, true);
  assert.equal(ci.strictMcpConfig, true);
  assert.deepEqual(ci.tools, []);
  assert.equal(ci.bare, true);
  assert.equal(ci.isolateCwd, true);
  assert.equal(ci.injectOAuthEnv, true);
});

test("cliInputForProfile VEREINIGT die Sperrliste, ersetzt sie nicht", () => {
  // Ein Aufrufer darf hinzufügen, niemals wegnehmen.
  const mitEigenen = {
    ...KOERPER,
    tools: [{ type: "function", function: { name: "Bash", description: "x", parameters: {} } }],
  };
  const ci = cliInputForProfile(mitEigenen as never, LEAD_PROFILE);
  for (const t of LEAD_PROFILE.forceDisallowedTools) {
    assert.ok(ci.disallowedTools?.includes(t), `${t} fehlt in der Sperrliste`);
  }
});

test("cliInputForProfile fasst das Profil nicht an", () => {
  // Die tools-Liste wird kopiert. Ohne die Kopie könnte ein späterer Schritt
  // am CliInput das PROFIL verändern — und die Härtung wäre ab dann für ALLE
  // Anfragen dieses Prozesses eine andere.
  const ci = cliInputForProfile(KOERPER as never, LEAD_PROFILE);
  ci.tools?.push("Bash");
  assert.deepEqual(LEAD_PROFILE.tools, [], "das Profil muss unberührt bleiben");
});

// --- C) Sitzungsmodus ----------------------------------------------------

test("enforceProfileSessionMode überschreibt auch einen ausdrücklichen Wunsch", () => {
  const gewuenscht = { mode: "sticky", sticky: { keyHash: "x", keyHashShort: "x", policy: "y" } };
  const wirksam = enforceProfileSessionMode(gewuenscht as never, LEAD_PROFILE);
  assert.equal(wirksam.mode, "stateless");
  assert.equal((wirksam as { sticky?: unknown }).sticky, undefined, "der sticky-Anhang muss weg sein");
});

test("enforceProfileSessionMode lässt in Ruhe, was schon stateless ist", () => {
  const vorher = { mode: "stateless" };
  assert.equal(enforceProfileSessionMode(vorher as never, LEAD_PROFILE), vorher, "keine neue Instanz nötig");
});

test("enforceProfileSessionMode tut nichts ohne Profil-Vorgabe", () => {
  const ohne: Profile = { ...LEAD_PROFILE, sessionMode: undefined };
  const vorher = { mode: "pool" };
  assert.equal(enforceProfileSessionMode(vorher as never, ohne), vorher);
});

// --- D) Der Stolperdraht -------------------------------------------------

test("assertHaertungNichtVerloren schlägt bei pool und sticky an", () => {
  const gehaertet = { restricted: true, strictMcpConfig: true, tools: [] };
  for (const modus of ["pool", "sticky"]) {
    assert.throws(
      () => assertHaertungNichtVerloren(gehaertet, modus),
      /Gehaertete Anfrage im Sitzungsmodus/,
      `Modus ${modus} muss auffliegen`,
    );
  }
});

test("assertHaertungNichtVerloren lässt stateless und ungehärtet durch", () => {
  assertHaertungNichtVerloren({ restricted: true, tools: [] }, "stateless");
  assertHaertungNichtVerloren({}, "pool");
});

test("assertHaertungNichtVerloren sieht auch eine LEERE Werkzeugliste", () => {
  // `tools: []` ist falsy-frei, aber bedeutungsvoll: es ist die pauschale
  // Sperre. Eine Prüfung auf Wahrheitswert würde sie übersehen.
  assert.throws(() => assertHaertungNichtVerloren({ tools: [] }, "pool"));
});

// --- E) Die Spawn-Argumente, also das, was wirklich passiert --------------

const ALLE_FLAGS = [
  "--bare",
  "--restricted",
  "--strict-mcp-config",
  "--tools",
  "--disable-slash-commands",
  "--json-schema",
  "--max-turns",
  "--settings",
  "--permission-mode",
  "--effort",
  "--debug",
  "--max-budget-usd",
  "--system-prompt",
  "--append-system-prompt",
  "--agent",
  "--agents",
  "--disallowed-tools",
  "--allowedTools",
];

function mitFlags(): void {
  setClaudeCliCapabilitiesForTests({ flags: ALLE_FLAGS, source: "claude --help", checkedAt: Date.now() });
}

test("buildSpawnArgs setzt die drei Härtungsflags", async () => {
  mitFlags();
  try {
    const args = await buildSpawnArgs({
      model: "claude-haiku-4-5",
      bare: LEAD_PROFILE.bare,
      restricted: LEAD_PROFILE.restricted,
      strictMcpConfig: LEAD_PROFILE.strictMcpConfig,
      tools: LEAD_PROFILE.tools,
    });
    assert.ok(args.includes("--bare"));
    assert.ok(args.includes("--restricted"));
    assert.ok(args.includes("--strict-mcp-config"));
    // --tools muss mit dem LEEREN String folgen, nicht ohne Wert.
    const i = args.indexOf("--tools");
    assert.notEqual(i, -1, "--tools fehlt");
    assert.equal(args[i + 1], "", '--tools muss "" als Wert bekommen');
    // Und die Sitzung darf nichts auf Platte schreiben.
    assert.ok(args.includes("--no-session-persistence"));
  } finally {
    resetClaudeCliCapabilitiesForTests();
  }
});

test("buildSpawnArgs gibt MCP-Werkzeuge frei — SONST haengt der Aufruf", async () => {
  // Ohne diese Freigabe laeuft jeder Werkzeugaufruf in den Genehmigungsfluss,
  // und headless sitzt niemand da, der zustimmt. Der Platzhalter ist erlaubt,
  // weil der Servername davorsteht.
  mitFlags();
  try {
    const args = await buildSpawnArgs({
      model: "claude-haiku-4-5",
      tools: [],
      mcpTools: [{ name: "terminal", description: "x", inputSchema: { type: "object" }, execution: { taskSupport: "forbidden" } }],
      mcpServerName: "hermes",
    });
    const i = args.indexOf("--allowedTools");
    assert.notEqual(i, -1, "--allowedTools fehlt");
    assert.equal(args[i + 1], "mcp__hermes__*");
    // UND die pauschale Sperre steht daneben. Im Mitschnitt der echten
    // Leitung standen beide zusammen — sie schliessen einander nicht aus.
    const t = args.indexOf("--tools");
    assert.notEqual(t, -1);
    assert.equal(args[t + 1], "");
  } finally {
    resetClaudeCliCapabilitiesForTests();
  }
});

test("buildSpawnArgs gibt nichts frei, wenn es keine MCP-Werkzeuge gibt", async () => {
  mitFlags();
  try {
    const args = await buildSpawnArgs({ model: "claude-haiku-4-5", tools: [] });
    assert.equal(args.includes("--allowedTools"), false, "ohne Werkzeuge keine Freigabe");
  } finally {
    resetClaudeCliCapabilitiesForTests();
  }
});

test("beide Profile fahren die MCP-Bruecke", () => {
  for (const name of listProfiles()) {
    assert.equal((getProfile(name) as Profile).toolBridge, "mcp", `${name} muss ueber MCP gehen`);
  }
});

test("buildSpawnArgs lässt den Bypass weg, wenn restricted gesetzt ist", async () => {
  // Gemessen im Tenant: `--restricted --dangerously-skip-permissions` bricht
  // mit "bypassPermissions not supported in restricted mode" ab. Ohne diesen
  // Riegel würde eine gesetzte Umgebungsvariable jeden gehärteten Spawn töten.
  mitFlags();
  const vorher = process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS;
  process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS = "true";
  try {
    const args = await buildSpawnArgs({ model: "claude-haiku-4-5", restricted: true });
    assert.ok(!args.includes("--dangerously-skip-permissions"), "der Bypass darf nicht mitkommen");
  } finally {
    if (vorher === undefined) delete process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS;
    else process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS = vorher;
    resetClaudeCliCapabilitiesForTests();
  }
});

test("buildSpawnArgs setzt den Bypass weiterhin, wenn NICHT gehärtet wird", async () => {
  // Gegenprobe. Ohne sie würde ein Riegel, der den Bypass immer wegwirft,
  // genauso grün aussehen wie der richtige.
  mitFlags();
  const vorher = process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS;
  process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS = "true";
  try {
    const args = await buildSpawnArgs({ model: "claude-haiku-4-5" });
    assert.ok(args.includes("--dangerously-skip-permissions"));
  } finally {
    if (vorher === undefined) delete process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS;
    else process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS = vorher;
    resetClaudeCliCapabilitiesForTests();
  }
});

test("buildSpawnArgs bricht ab, wenn die CLI ein Härtungsflag nicht kennt", async () => {
  // `strict` ist hier die richtige Einstellung: eine CLI ohne --restricted
  // kann die zugesagte Sperre nicht herstellen. Still weiterlaufen hieße,
  // eine Absicherung zu behaupten, die es nicht gibt.
  setClaudeCliCapabilitiesForTests({ flags: ["--bare"], source: "claude --help", checkedAt: Date.now() });
  try {
    await assert.rejects(
      () => buildSpawnArgs({ model: "claude-haiku-4-5", restricted: true }),
      /does not support --restricted/,
    );
  } finally {
    resetClaudeCliCapabilitiesForTests();
  }
});
