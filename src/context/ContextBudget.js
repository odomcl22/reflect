/**
 * How much context to spend, derived from the model actually loaded.
 *
 * Reflect 1.0 used fixed constants — 8 recent turns, 5 memories, 1000 memory
 * tokens — regardless of whether the model had a 4k or a 262k window. This is
 * the replacement: every allocation is a share of the real window, so an 8B
 * model with 32k and a 4B model with 8k both get a full, proportional context.
 */

export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/**
 * The five stops behind the depth dial. `share` reallocates the budget; the
 * counts are ceilings, not targets — recall returns what it returns.
 */
export const DEPTHS = [
  null,
  { key: 1, name: 'Glance', memories: 0, turns: 4, projectFiles: false, journalDays: 0 },
  { key: 2, name: 'Light', memories: 3, turns: 6, projectFiles: false, journalDays: 1 },
  { key: 3, name: 'Balanced', memories: 6, turns: 10, projectFiles: false, journalDays: 1 },
  { key: 4, name: 'Deep', memories: 12, turns: 16, projectFiles: true, journalDays: 3 },
  { key: 5, name: 'Total', memories: 24, turns: Infinity, projectFiles: true, journalDays: 14 },
];

export const depthFor = (value) => DEPTHS[Math.min(5, Math.max(1, Number(value) || 3))];

/** Shares of the usable window. They sum to 1. */
const SHARES = {
  companion: { system: 0.15, summary: 0.15, memories: 0.2, turns: 0.5 },
  builder: { system: 0.15, summary: 0.12, memories: 0.33, turns: 0.4 },
};

/** The largest window Reflect will ever plan for, whatever the model claims. */
export const HARD_CAP = 32768;
export const FLOOR = 2048;

/**
 * The window Reflect will actually use — and, critically, the number it asks
 * Ollama to serve.
 *
 * These were two different numbers until now, which was a latent bug. Ollama
 * runs `llama-server -c 4096` unless told otherwise, so Reflect would read
 * `context_length: 32768` from the model metadata, plan a prompt against it,
 * and hand a 20k-token prompt to a 4k runtime. Ollama then context-shifts
 * silently — dropping tokens from the front, which is exactly where the frozen
 * system prefix lives. The prompt design rests on that prefix being present.
 *
 * `maxContext` is the user's ceiling, and it is a memory decision rather than a
 * quality one: KV cache is resident RAM, and on a 16GB machine a 32k window
 * behind a 13GB model is how you get swapping instead of speed.
 */
export function windowFor(contextLength, maxContext) {
  const claimed = Math.max(Number(contextLength) || 8192, FLOOR);
  // A negative or unparseable ceiling is not a request for the smallest possible
  // window — it is no request at all.
  const asked = Number(maxContext);
  const ceiling = asked > 0 ? Math.max(asked, FLOOR) : HARD_CAP;
  return Math.min(claimed, ceiling, HARD_CAP);
}

/**
 * @param {object} opts
 * @param {number} opts.contextLength  the model's real window, from Ollama
 * @param {number} [opts.depth]        1..5
 * @param {string} [opts.mode]         companion | builder
 * @param {number} [opts.maxOutput]    tokens to hold back for the reply
 * @param {number} [opts.maxContext]   the user's ceiling on window size
 */
export function plan({ contextLength, depth = 3, mode = 'companion', maxOutput, maxContext }) {
  const window = windowFor(contextLength, maxContext);
  const reserve = Math.min(maxOutput ?? 2048, Math.floor(window * 0.25));
  const usable = window - reserve;
  const shares = SHARES[mode] || SHARES.companion;
  const d = depthFor(depth);

  return {
    window,
    reserve,
    usable,
    depth: d,
    mode,
    tokens: {
      system: Math.floor(usable * shares.system),
      summary: Math.floor(usable * shares.summary),
      memories: Math.floor(usable * shares.memories),
      turns: Math.floor(usable * shares.turns),
    },
    limits: {
      memories: d.memories,
      turns: d.turns,
      projectFiles: d.projectFiles,
      journalDays: d.journalDays,
    },
  };
}

/**
 * Take turns from the end until the token budget runs out, then restore
 * chronological order. Always keeps at least the last exchange.
 */
export function fitTurns(turns, { maxTokens, maxTurns }) {
  const limit = Number.isFinite(maxTurns) ? maxTurns : turns.length;
  const candidates = turns.slice(-limit);
  const kept = [];
  let used = 0;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const t = candidates[i];
    const cost = estimateTokens(t.content) + 4;
    if (used + cost > maxTokens && kept.length >= 2) break;
    kept.unshift(t);
    used += cost;
  }

  return { turns: kept, tokens: used, dropped: turns.length - kept.length };
}
