import test from "node:test";
import assert from "node:assert/strict";
import { exceedsStdoutCap, STDOUT_BUFFER_HARD_CAP_BYTES } from "../subprocess/stream-json-manager.js";

test("exceedsStdoutCap: under cap returns false", () => {
  assert.equal(exceedsStdoutCap(0), false);
  assert.equal(exceedsStdoutCap(STDOUT_BUFFER_HARD_CAP_BYTES), false);
});

test("exceedsStdoutCap: over cap returns true", () => {
  assert.equal(exceedsStdoutCap(STDOUT_BUFFER_HARD_CAP_BYTES + 1), true);
});

test("STDOUT_BUFFER_HARD_CAP_BYTES is 50 MB", () => {
  assert.equal(STDOUT_BUFFER_HARD_CAP_BYTES, 50_000_000);
});
