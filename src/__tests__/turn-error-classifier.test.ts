import test from "node:test";
import assert from "node:assert/strict";
import { classifyTurnError } from "../server/turn-error-classifier.js";

test("classifyTurnError: watchdog wins", () => {
  assert.equal(classifyTurnError({ watchdogFired: true, clientClosed: false }), "skip");
  assert.equal(classifyTurnError({ watchdogFired: true, clientClosed: true }), "skip");
});

test("classifyTurnError: client_disconnect beats turn_error", () => {
  assert.equal(classifyTurnError({ watchdogFired: false, clientClosed: true }), "client_disconnect");
});

test("classifyTurnError: default turn_error", () => {
  assert.equal(classifyTurnError({ watchdogFired: false, clientClosed: false }), "turn_error");
});
