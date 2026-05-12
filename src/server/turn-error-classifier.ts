/**
 * Triage helper for the stream-json turn catch-block. Cleanly distinguishes
 * the three release reasons so the trace gets the right error class.
 */
export function classifyTurnError(opts: {
  watchdogFired: boolean;
  clientClosed: boolean;
}): "skip" | "client_disconnect" | "turn_error" {
  if (opts.watchdogFired) return "skip";
  if (opts.clientClosed) return "client_disconnect";
  return "turn_error";
}
