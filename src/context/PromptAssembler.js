/**
 * Turns everything Reflect knows into a messages[] array.
 *
 * Two properties this must hold, both of which 1.0 violated:
 *
 *   1. The system message is a FROZEN PREFIX. It is identity + profile only, and
 *      it is byte-identical for every turn of a session, so the model's KV cache
 *      survives. Anything that changes per turn goes further down. 1.0 rebuilt
 *      the system string every turn with re-ranked memories inside it and paid
 *      full prompt cost on each request.
 *
 *   2. Real roles. 1.0 flattened identity, history, memories, and the question
 *      into one giant system string, discarding the structure every
 *      instruct-tuned model was trained on.
 *
 * Recalled memories arrive fenced in <memory-context> in the user turn (M3).
 * They are reference data, not something the user said, and the fence is what
 * lets the streamer strip any echo of it out of the reply.
 */

import { estimateTokens, fitTurns } from './ContextBudget.js';

export const FENCE_OPEN = '<memory-context>';
export const FENCE_CLOSE = '</memory-context>';

/**
 * @param {object} opts
 * @param {object} opts.soul        from loadSoul()
 * @param {string} opts.profile     USER.md body, or ''
 * @param {Array}  opts.turns       prior turns, oldest first (excludes the new message)
 * @param {string} opts.message     what the user just typed
 * @param {object} opts.budget      from ContextBudget.plan()
 * @param {Array}  [opts.journal]   recent daily logs: [{date, body}]
 * @param {string} [opts.summary]   rolling conversation summary (M5)
 * @param {boolean} [opts.carried]  the summary is of the conversation this one
 *                                  continues, not of this one's own turns
 * @param {Array}  [opts.memories]  recalled candidates
 * @param {string} [opts.notice]    a system aside for this turn, e.g. "you just saved X"
 */
export function build({
  soul,
  profile = '',
  turns = [],
  message,
  budget,
  journal = [],
  summary = '',
  carried = false,
  memories = [],
  notice = '',
  abilities = '',
  skills = '',
  skillInstructions = '',
  grants = '',
}) {
  const messages = [];

  // ---- 1. Frozen prefix -----------------------------------------------------
  // Identity, profile, and recent daily notes. All of it is stable for the whole
  // session: nothing here may depend on the current message, or the KV cache is
  // lost on every turn.
  const journalBlock = journal.length
    ? journal.map((d) => `### ${d.date}\n${d.body}`).join('\n\n')
    : '';

  const system = [
    soul.block(budget.mode),
    // Constant for the session, so it belongs in the frozen prefix rather than
    // above the turn: anything that changes per message costs the KV cache.
    abilities,
    // The catalogue is names and descriptions only — a line each. The
    // instructions are not here; they arrive below, and only when asked for.
    skills,
    // Stable for the session too: what it may touch outside its own folder.
    grants,
    profile && `## What you know about this user\n\n${profile}`,
    journalBlock && `## Recent days\n\n${journalBlock}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  messages.push({ role: 'system', content: system });

  // ---- 2. Conversation ------------------------------------------------------
  if (summary) {
    messages.push({
      role: 'system',
      content: carried
        ? // Said plainly, because it changes what the model may claim. Told
          // "earlier in this conversation" about turns that happened somewhere
          // else, it offers to scroll back to them.
          `## Carried over from the conversation this continues\n\n${summary}\n\n` +
          'Treat this as established. It happened, and you were there — but those turns are not in this transcript, so do not offer to look back at them.'
        : `## Earlier in this conversation\n\n${summary}`,
    });
  }

  if (skillInstructions) {
    messages.push({
      role: 'system',
      content: `The user asked for these skills on this turn. Follow them.\n\n${skillInstructions}`,
    });
  }

  const fitted = fitTurns(turns, {
    maxTokens: budget.tokens.turns,
    maxTurns: budget.limits.turns,
  });

  for (const t of fitted.turns) {
    messages.push({ role: t.role, content: t.content });
  }

  // ---- 3. Current turn ------------------------------------------------------
  const recalled = memories.slice(0, budget.limits.memories);
  const fenceLines = [];

  if (recalled.length) {
    fenceLines.push('Things this user told you before. Reference only — they did not just say these.');
    fenceLines.push(...recalled.map((m) => `- ${m.text} (${m.source})`));
  }
  if (notice) {
    fenceLines.push(notice);
  }

  const fence = fenceLines.length ? [FENCE_OPEN, ...fenceLines, FENCE_CLOSE, ''].join('\n') : '';

  messages.push({ role: 'user', content: fence + message });

  const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);

  return {
    messages,
    trace: {
      mode: budget.mode,
      depth: budget.depth.name,
      window: budget.window,
      systemTokens: estimateTokens(system),
      turnsIncluded: fitted.turns.length,
      turnsDropped: fitted.dropped,
      turnTokens: fitted.tokens,
      memoriesIncluded: recalled.length,
      memories: recalled.map((m) => ({
        source: m.source,
        section: m.section || null,
        text: m.text,
        score: m.score ?? null,
        via: m.via ?? null,
      })),
      profileIncluded: Boolean(profile),
      journalDays: journal.length,
      promptTokens,
    },
  };
}

/**
 * Strips the fence out of streamed output across chunk boundaries.
 *
 * A one-shot regex cannot do this: a tag opened in one delta and closed three
 * deltas later leaks its payload to the screen. This holds back any trailing
 * fragment that might be the start of a tag and discards everything inside a
 * span. 1.0's equivalent pattern-matched the finished output for "## USER
 * MEMORIES" after the fact.
 */
export class FenceScrubber {
  #inSpan = false;
  #buffer = '';

  reset() {
    this.#inSpan = false;
    this.#buffer = '';
  }

  /** @returns {string} the safe-to-display portion of `text`. */
  feed(text) {
    if (!text) return '';
    let buf = this.#buffer + text;
    this.#buffer = '';
    let out = '';

    for (;;) {
      if (this.#inSpan) {
        const close = buf.indexOf(FENCE_CLOSE);
        if (close === -1) {
          this.#buffer = tail(buf, FENCE_CLOSE);
          return out;
        }
        buf = buf.slice(close + FENCE_CLOSE.length);
        this.#inSpan = false;
        continue;
      }

      const open = buf.indexOf(FENCE_OPEN);
      if (open === -1) {
        const held = tail(buf, FENCE_OPEN);
        out += held ? buf.slice(0, buf.length - held.length) : buf;
        this.#buffer = held;
        return out;
      }

      out += buf.slice(0, open);
      buf = buf.slice(open + FENCE_OPEN.length);
      this.#inSpan = true;
    }
  }

  /** Emit whatever is safely left at end of stream. */
  flush() {
    const rest = this.#inSpan ? '' : this.#buffer;
    this.reset();
    return rest;
  }
}

/** The longest suffix of `s` that could be the start of `tag`. */
function tail(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return s.slice(s.length - n);
  }
  return '';
}
