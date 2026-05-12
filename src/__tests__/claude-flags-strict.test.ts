import test from "node:test";
import assert from "node:assert/strict";
import {
  pushClaudeFlagIfSupported,
  setClaudeCliCapabilitiesForTests,
  resetClaudeCliCapabilitiesForTests,
} from "../subprocess/claude-flags.js";

const STRICT_FLAGS = [
  "--permission-mode",
  "--max-budget-usd",
  "--bare",
  "--disable-slash-commands",
  "--json-schema",
  "--max-turns",
  "--system-prompt",
  "--append-system-prompt",
  "--agent",
  "--agents",
];

for (const flag of STRICT_FLAGS) {
  test(`pushClaudeFlagIfSupported strict throws when ${flag} not in caps`, async () => {
    setClaudeCliCapabilitiesForTests({ flags: [], source: "claude --help", checkedAt: Date.now() });
    try {
      const args: string[] = [];
      await assert.rejects(
        () => pushClaudeFlagIfSupported(args, flag, { value: "v", strict: true, requestedValueLabel: "vlabel" }),
        new RegExp(`does not support ${flag}`),
      );
      assert.deepEqual(args, []);
    } finally {
      resetClaudeCliCapabilitiesForTests();
    }
  });

  test(`pushClaudeFlagIfSupported strict pushes when ${flag} in caps`, async () => {
    setClaudeCliCapabilitiesForTests({ flags: [flag], source: "claude --help", checkedAt: Date.now() });
    try {
      const args: string[] = [];
      const ok = await pushClaudeFlagIfSupported(args, flag, { value: "v", strict: true });
      assert.equal(ok, true);
      assert.deepEqual(args, [flag, "v"]);
    } finally {
      resetClaudeCliCapabilitiesForTests();
    }
  });
}

test("pushClaudeFlagIfSupported --debug remains silent when unsupported", async () => {
  setClaudeCliCapabilitiesForTests({ flags: [], source: "claude --help", checkedAt: Date.now() });
  try {
    const args: string[] = [];
    const ok = await pushClaudeFlagIfSupported(args, "--debug", { value: "api" });
    assert.equal(ok, false);
    assert.deepEqual(args, []);
  } finally {
    resetClaudeCliCapabilitiesForTests();
  }
});

test("pushClaudeFlagIfSupported strict error message uses requestedValueLabel", async () => {
  setClaudeCliCapabilitiesForTests({ flags: [], source: "claude --help", checkedAt: Date.now() });
  try {
    const args: string[] = [];
    await assert.rejects(
      () =>
        pushClaudeFlagIfSupported(args, "--system-prompt", {
          value: "secret-content",
          strict: true,
          requestedValueLabel: "<set>",
        }),
      (err: Error) => {
        assert.match(err.message, /--system-prompt='<set>'/);
        assert.doesNotMatch(err.message, /secret-content/);
        return true;
      },
    );
  } finally {
    resetClaudeCliCapabilitiesForTests();
  }
});
