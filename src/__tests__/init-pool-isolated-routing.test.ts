/**
 * Pool-Routing für die isolierten (Honcho-)Aufrufe.
 *
 * Befund M2: der Vorrat an vorgewärmten `--bare`-Subprozessen war ein totes
 * Konstrukt. Die Bedingung in acquireStatelessStreamJson verlangte
 * `disallowedTools.length === 0 && !systemPrompt`, während die isolierte Route
 * jedem Aufruf acht forceDisallowedTools und (bei `response_format`) ein
 * abgeleitetes Schema-Spawn-Argument mitgibt. Beide Bedingungen konnten also
 * nie zugleich erfüllt sein — jeder Honcho-Aufruf hat kalt gespawnt.
 *
 * Seit der Umstellung auf das native `--json-schema` ist das unterscheidende
 * Spawn-Argument `jsonSchema` statt des abgeleiteten System-Prompts. Der
 * Schlüssel hängt damit am Schema selbst, nicht mehr an seinem Namen: zwei
 * Aufrufe mit gleichem Schema unter verschiedenen Namen teilen sich jetzt
 * zu Recht einen warmen Slot.
 *
 * Diese Tests fahren den Pfad mit den echten Flags, die routes.ts baut
 * (openaiToCli + ISOLATED_PROFILE + gemergte forceDisallowedTools), und
 * messen am initPoolCounters, ob ein zweiter Aufruf warm bedient wird.
 *
 * Es wird kein echter `claude`-Prozess gestartet: StreamJsonSubprocess.start
 * ist gemockt (dasselbe Vorgehen wie in pool.test.ts).
 */

import test, { mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acquireStatelessStreamJson } from "../server/routes.js";
import { ISOLATED_PROFILE } from "../server/profiles.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { StreamJsonSubprocess, type StreamJsonOptions } from "../subprocess/stream-json-manager.js";
import { initPoolCounters, initPoolStats, __resetInitPoolForTests } from "../subprocess/init-pool.js";

/** Spawn-Optionen jedes (gemockten) start()-Aufrufs, in Reihenfolge. */
const spawns: StreamJsonOptions[] = [];

let savedOauthToken: string | undefined;

before(() => {
  // hasCredentialsChangedSince() liest ~/.claude/.credentials.json. Fehlt die
  // Datei, meldet der Resolver "geändert" und der Pool verwirft jeden warmen
  // Slot — es sei denn, ein Token steht in der Umgebung. Damit der Test auf
  // jedem Host (und in CI) dasselbe misst, setzen wir einen.
  savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-not-used-start-is-mocked";

  mock.method(StreamJsonSubprocess.prototype, "start", async function (this: any, opts: StreamJsonOptions) {
    spawns.push(opts);
    this.model = opts.model;
    this.spawnedAt = Date.now();
  });
  mock.method(StreamJsonSubprocess.prototype, "isHealthy", function () {
    return true;
  });
  mock.method(StreamJsonSubprocess.prototype, "getAge", function () {
    return 0;
  });
  mock.method(StreamJsonSubprocess.prototype, "kill", function () {
    /* kein echter Prozess da */
  });
});

after(() => {
  mock.restoreAll();
  if (savedOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
});

beforeEach(() => {
  spawns.length = 0;
  __resetInitPoolForTests();
});

/** Lässt die im Hintergrund angestoßene Nachfüllung durchlaufen. */
async function drainBackgroundRefill(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Baut exakt die CliInput, die handleIsolatedChatCompletions erzeugt:
 * openaiToCli mit den Profil-forceFlags, danach das serverseitige Mergen der
 * forceDisallowedTools.
 */
function honchoCliInput(schemaName: string) {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Ein Nutzersatz, aus dem Honcho Fakten zieht." }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          // Das Schema selbst muss sich mitunterscheiden: der native Pfad
          // reicht nur `schema` an --json-schema weiter, der Name fällt weg.
          schema: { type: "object", properties: { [schemaName]: { type: "boolean" } } },
        },
      },
    },
    {
      mapResponseFormat: ISOLATED_PROFILE.mapResponseFormat,
      forceFlags: {
        bare: ISOLATED_PROFILE.bare,
        disableSlashCommands: ISOLATED_PROFILE.disableSlashCommands,
        isolateCwd: ISOLATED_PROFILE.isolateCwd,
        injectOAuthEnv: ISOLATED_PROFILE.injectOAuthEnv,
      },
    },
  );
  const merged = new Set([...(cli.disallowedTools ?? []), ...ISOLATED_PROFILE.forceDisallowedTools]);
  cli.disallowedTools = Array.from(merged);
  return cli;
}

function acquireHoncho(cli: ReturnType<typeof honchoCliInput>): Promise<StreamJsonSubprocess> {
  return acquireStatelessStreamJson(
    cli.model,
    cli.disallowedTools,
    cli.effort,
    cli.thinking,
    cli.debug,
    cli.maxBudgetUsd,
    cli.permissionMode,
    cli.systemPrompt,
    cli.appendSystemPrompt,
    cli.agent,
    cli.agents,
    cli.bare,
    cli.disableSlashCommands,
    cli.jsonSchema,
    cli.maxTurns,
    undefined, // callerKey — kein Rate-Limit im Test
    cli.isolateCwd,
    cli.injectOAuthEnv,
  );
}

test("Honcho-Aufruf trägt Flags, gegen die die alte Pool-Bedingung nie greifen konnte", () => {
  const cli = honchoCliInput("DeriverFacts");
  // Punkt (1) des Befunds: forceDisallowedTools sind vor dem Pool-Routing
  // gemergt — die Bedingung `disallowedTools.length === 0` ist unerfüllbar.
  assert.equal(cli.disallowedTools?.length, 8, "acht forceDisallowedTools sind gemergt");
  // Punkt (2): response_format setzt ein Schema-Spawn-Argument. Früher war das
  // ein abgeleiteter System-Prompt, seit der nativen Umstellung `jsonSchema`.
  assert.ok(cli.jsonSchema, "response_format erzeugt ein --json-schema-Argument");
  assert.equal(cli.systemPrompt, undefined, "der native Pfad setzt keinen System-Prompt");
  // Und die isolierte Dreiheit steht, der bare-Pfad wird also überhaupt betreten.
  assert.equal(cli.bare, true);
  assert.equal(cli.isolateCwd, true);
  assert.equal(cli.injectOAuthEnv, true);
});

test("der isolierte Pfad läuft überhaupt über den Vorrat", async () => {
  const cli = honchoCliInput("DeriverFacts");

  await acquireHoncho(cli);

  assert.equal(
    initPoolCounters.coldSpawns + initPoolCounters.warmHits,
    1,
    "der Aufruf muss durch den Init-Pool gegangen sein — 0 heißt: der Pool wird nie betreten",
  );

  await drainBackgroundRefill();
  assert.equal(
    initPoolStats().size,
    1,
    "danach hält der Vorrat einen Slot für genau diese Konfiguration",
  );
});

test("zweiter Honcho-Aufruf desselben Schemas wird warm bedient", async () => {
  const cli = honchoCliInput("DeriverFacts");

  const first = await acquireHoncho(cli);
  await drainBackgroundRefill();

  const second = await acquireHoncho(cli);
  assert.equal(
    initPoolCounters.warmHits,
    1,
    "der zweite Aufruf muss aus dem Vorrat kommen (96 % folgen binnen 60 s)",
  );
  assert.equal(initPoolCounters.coldSpawns, 1, "nur der allererste Aufruf spawnt kalt");
  assert.notEqual(second, first, "der warme Slot ist ein anderer Prozess als der erste");
});

test("warmer Slot trägt dieselben Flags wie der Aufruf, der ihn bekommt", async () => {
  const cli = honchoCliInput("DeriverFacts");

  await acquireHoncho(cli);
  await drainBackgroundRefill();
  await acquireHoncho(cli);
  await drainBackgroundRefill();

  // Zwei Aufrufe = ein Kaltstart + zwei Nachfüllungen. Ohne Vorrat wären es
  // nur die zwei Kaltstarts.
  assert.equal(spawns.length, 3, "ein Kaltstart plus je eine Nachfüllung pro Aufruf");
  // Jeder gespawnte Prozess — auch der nachgefüllte — muss die vollen
  // isolierten Flags tragen. Ein Slot ohne --json-schema oder ohne
  // --disallowedTools dürfte nie an einen Honcho-Aufruf gehen.
  for (const s of spawns) {
    assert.equal(s.bare, true);
    assert.equal(s.isolateCwd, true);
    assert.equal(s.injectOAuthEnv, true);
    assert.equal(s.disableSlashCommands, true);
    assert.deepEqual(s.jsonSchema, cli.jsonSchema, "Slot trägt das Schema des Aufrufs");
    assert.deepEqual(
      [...(s.disallowedTools ?? [])].sort(),
      [...(cli.disallowedTools ?? [])].sort(),
      "Slot trägt die gemergten forceDisallowedTools",
    );
  }
});

test("anderes Schema bekommt den Slot des ersten Schemas nicht", async () => {
  const a = honchoCliInput("DeriverFacts");
  const b = honchoCliInput("DeriverSummary");
  assert.notDeepEqual(a.jsonSchema, b.jsonSchema, "die beiden Aufrufe tragen verschiedene Schemata");

  await acquireHoncho(a);
  await drainBackgroundRefill();

  const warmHitsBefore = initPoolCounters.warmHits;
  await acquireHoncho(b);
  assert.equal(
    initPoolCounters.warmHits,
    warmHitsBefore,
    "ein Slot mit fremdem System-Prompt darf nicht ausgeliefert werden",
  );
});
