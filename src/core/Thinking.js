/**
 * How much the model should reason before it answers.
 *
 * Measured on this machine: the same question to `gemma4:e4b-mlx` takes 13.8s
 * with thinking off and 49.9s through Reflect with it on — at an identical
 * 10.5 tok/s. None of that difference is generation speed; it is 3.4x the
 * tokens. Reflect used to force thinking on for every model that advertised
 * the capability, which made "what time is my meeting" cost as much as "design
 * my schema". Now it is the user's dial.
 *
 * Ollama takes two shapes for the same idea:
 *   - `think: true | false`                    every thinking-capable model
 *   - `think: "low" | "medium" | "high"`       models with a reasoning-effort knob
 *
 * The trap is that Ollama *accepts* a level string for models that have no such
 * knob and quietly ignores it. Measured on `gemma4:e4b-mlx`, one prompt at each
 * setting: off 0 chars of reasoning, then low 1038, medium 979, high 784 — the
 * level is accepted and makes no difference. `gpt-oss:20b` at low produced 116.
 *
 * So there is nothing to catch: no error, no capability flag. A model either
 * has the knob or it doesn't, and the only honest way to know today is to have
 * measured it. Hence the small list below, and a UI that says "one level" for
 * everything else rather than pretending the dial has four working stops.
 * OllamaAdapter still falls back to plain `true` if a build rejects the string.
 */

/**
 * Model families measured to honour reasoning levels. Deliberately short and
 * deliberately a regex on the name: when a new family ships, measure it at low
 * and high, and add it here only if the numbers actually differ.
 */
const HONOURS_LEVELS = /gpt-oss/i;

export const honoursLevels = (model) => HONOURS_LEVELS.test(String(model || ''));

/** The dial, in order. `off` is a real setting, not the absence of one. */
export const LEVELS = ['off', 'low', 'medium', 'high'];

export const DEFAULT_LEVEL = 'off';

/** Names for the UI. Short, because they sit in the composer. */
export const LEVEL_NAMES = { off: 'Off', low: 'Low', medium: 'Med', high: 'High' };

/** Anything unrecognised means the default rather than an error. */
export function normalizeLevel(value) {
  const level = String(value ?? '').toLowerCase();
  return LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

/**
 * The `think` value to send to Ollama.
 *
 * @param {string} level     one of LEVELS
 * @param {boolean} capable  does the model advertise `thinking`?
 * @returns {undefined|boolean|string}
 *   `undefined` for a model with no thinking at all — sending `think: false` to
 *   one is a request it never needed to see.
 */
export function thinkParam(level, capable) {
  const normalized = normalizeLevel(level);

  // Off is sent whether or not we believe the model reasons.
  //
  // This used to return undefined for anything not marked thinking-capable,
  // which meant the dial did nothing on the models people actually complained
  // about: qwen3 and deepseek-r1 reason by default, and Ollama's capability
  // list does not always say `thinking`. Turning something off should not
  // require first believing it is on — and if a runtime rejects the field, the
  // adapter drops it and carries on.
  if (normalized === 'off') return false;

  // Asking a model to reason *harder* does require believing it can.
  if (!capable) return undefined;
  return normalized;
}

/**
 * What the user asked for versus what the model could actually do, so the UI can
 * say so instead of quietly lying about the dial having four stops.
 *
 * `degraded` means the reasoning happened but the *amount* was not honoured —
 * either Ollama rejected the level and we stepped down to `true`, or the model
 * has no reasoning-effort knob and silently ignored it.
 */
export function describeThinking(level, capable, applied, model) {
  const asked = normalizeLevel(level);
  const on = asked !== 'off';
  return {
    asked,
    applied: applied === undefined ? 'unsupported' : applied === false ? 'off' : String(applied),
    degraded: Boolean(capable) && on && (applied === true || !honoursLevels(model)),
    supported: Boolean(capable),
  };
}
