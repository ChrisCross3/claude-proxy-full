/**
 * OpenRouter-Wire Normalisierung.
 *
 * Der Proxy wird einem OpenRouter-Client gegenueber als OpenRouter-kompatibler Endpoint
 * registriert (base_url enthaelt "openrouter"). Dessen OpenRouter-Profil
 * sendet daraufhin Modelle mit "anthropic/"-Prefix und packt den
 * reasoning_config-Dict in extra_body.reasoning.
 *
 * Diese Funktion bringt das zurueck in die OpenAI-Standardform, mit der
 * der Rest des Proxys arbeitet:
 *   - Modellname: "anthropic/claude-opus-4-7" -> "claude-opus-4-7"
 *   - extra_body.reasoning.effort -> top-level reasoning_effort
 *   - extra_body.reasoning.enabled === false oder effort === "none"
 *     -> top-level thinking = false
 *
 * Existierende Top-Level-Felder werden NICHT ueberschrieben (Direkt-Aufrufe
 * mit reasoning_effort haben Vorrang). Die Funktion mutiert das Request-Objekt
 * in-place und ist idempotent.
 */

import { ModelValidationError } from './openai-to-cli.js';

type AnyRecord = Record<string, unknown>;

const OPENROUTER_MODEL_PREFIXES: readonly string[] = [
  'anthropic/',
];

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strip recognised OpenRouter provider prefixes from a model id.
 * Returns the input unchanged if no prefix matches.
 */
export function stripOpenRouterPrefix(model: string): string {
  for (const prefix of OPENROUTER_MODEL_PREFIXES) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

/**
 * Normalise an OpenRouter-shaped request into the OpenAI-standard shape the
 * rest of the proxy expects. Mutates `req` in place and is safe to call on
 * requests that are already normal (no-op).
 */
export function normalizeOpenRouterRequest(req: AnyRecord): void {
  if (typeof req.model === 'string') {
    req.model = stripOpenRouterPrefix(req.model);
  }

  // Such clients send reasoning as a top-level field (OpenAI-Responses-style);
  // OpenRouter docs also accept extra_body.reasoning. Support both, prefer top-level.
  const extra = req.extra_body;
  const reasoning =
    isPlainObject(req.reasoning)
      ? (req.reasoning as AnyRecord)
      : isPlainObject(extra) && isPlainObject((extra as AnyRecord).reasoning)
        ? ((extra as AnyRecord).reasoning as AnyRecord)
        : null;
  if (!reasoning) return;

  const effortRaw = reasoning.effort;
  const enabled = reasoning.enabled;

  // Strict-throw on nested/typed shapes: OpenAI-Responses-style
  // `{ effort: { level: "high" } }` would be silently dropped by the
  // string-check below, leaving the caller's high-effort intent
  // un-honored. Refuse it explicitly. null is treated as "absent".
  if (effortRaw !== undefined && effortRaw !== null && typeof effortRaw !== 'string') {
    throw new ModelValidationError(
      `reasoning.effort must be a string; got ${typeof effortRaw} ` +
      `(nested OpenAI-Responses shapes like { level: "high" } are not supported — ` +
      `pass reasoning.effort as a top-level string).`,
      'reasoning_invalid',
    );
  }

  // enabled=false or effort='none' -> thinking off (unless caller set thinking)
  const disabled =
    enabled === false ||
    (typeof effortRaw === 'string' && effortRaw.toLowerCase() === 'none');

  if (disabled && req.thinking === undefined) {
    req.thinking = false;
  }

  // Lift effort to top-level reasoning_effort (unless caller set it).
  if (
    !disabled &&
    typeof effortRaw === 'string' &&
    req.reasoning_effort === undefined
  ) {
    req.reasoning_effort = effortRaw;
  }
}
