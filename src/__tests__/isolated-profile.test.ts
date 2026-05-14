import test from "node:test";
import assert from "node:assert/strict";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { getProfile, ISOLATED_PROFILE, listProfiles } from "../server/profiles.js";

test("ISOLATED_PROFILE forces bare + isolateCwd + injectOAuthEnv + mapResponseFormat", () => {
  assert.equal(ISOLATED_PROFILE.bare, true);
  assert.equal(ISOLATED_PROFILE.disableSlashCommands, true);
  assert.equal(ISOLATED_PROFILE.mapResponseFormat, true);
  assert.equal(ISOLATED_PROFILE.isolateCwd, true);
  assert.equal(ISOLATED_PROFILE.injectOAuthEnv, true);
  assert.equal(ISOLATED_PROFILE.pool, "bare");
});

test("getProfile returns ISOLATED_PROFILE for 'isolated'", () => {
  const p = getProfile("isolated");
  assert.ok(p);
  assert.equal(p, ISOLATED_PROFILE);
});

test("getProfile returns undefined for unknown name", () => {
  assert.equal(getProfile("nonexistent"), undefined);
});

test("listProfiles includes 'isolated'", () => {
  const list = listProfiles();
  assert.ok(list.includes("isolated"));
});

test("openaiToCli with isolated forceFlags sets all profile defaults in CliInput", () => {
  const profile = ISOLATED_PROFILE;
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "Result",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    },
    {
      mapResponseFormat: profile.mapResponseFormat,
      forceFlags: {
        bare: profile.bare,
        disableSlashCommands: profile.disableSlashCommands,
        isolateCwd: profile.isolateCwd,
        injectOAuthEnv: profile.injectOAuthEnv,
      },
    },
  );
  assert.equal(cli.bare, true);
  assert.equal(cli.disableSlashCommands, true);
  assert.equal(cli.isolateCwd, true);
  assert.equal(cli.injectOAuthEnv, true);
  assert.ok(cli.systemPrompt, "systemPrompt should be set from response_format mapping");
  assert.match(cli.systemPrompt!, /MUST respond with ONLY valid JSON/);
});

test("openaiToCli forceFlags override request body bare/disable_slash_commands", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      bare: false, // client wants non-bare
      disable_slash_commands: false,
    },
    {
      forceFlags: {
        bare: true, // server forces bare
        disableSlashCommands: true,
        isolateCwd: true,
        injectOAuthEnv: true,
      },
    },
  );
  assert.equal(cli.bare, true);
  assert.equal(cli.disableSlashCommands, true);
  assert.equal(cli.isolateCwd, true);
  assert.equal(cli.injectOAuthEnv, true);
});

test("openaiToCli without forceFlags leaves isolateCwd/injectOAuthEnv unset", () => {
  const cli = openaiToCli({
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "test" }],
  });
  assert.equal(cli.isolateCwd, undefined);
  assert.equal(cli.injectOAuthEnv, undefined);
});

test("openaiToCli mapResponseFormat works without forceFlags", () => {
  const cli = openaiToCli(
    {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "X", schema: { type: "object" } },
      },
    },
    { mapResponseFormat: true },
  );
  assert.ok(cli.systemPrompt);
  assert.equal(cli.bare, undefined);
});
