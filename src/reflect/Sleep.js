/**
 * Sleep: the second pass over memory, taken while nobody is waiting.
 *
 * Daytime extraction has to be right in real time, on whatever model is
 * loaded, in the seconds after a reply — and it shows. Facts accumulate in
 * near-duplicate wordings, a superseded preference survives beside its
 * replacement, and none of it gets fixed because fixing it would cost latency
 * somebody is sitting there feeling.
 *
 * Sleep is the fix. Once a day, when the machine is on and the person is not
 * typing, Reflect re-reads USER.md whole and consolidates it: merges bullets
 * that say the same thing, keeps the newer of two that contradict, tightens
 * nothing else. Two-pass memory — rough notes while awake, consolidation while
 * asleep — which is the arrangement human memory actually uses, and the one
 * thing a local assistant can afford that a metered cloud one cannot: the
 * model is already paid for and the night is free.
 *
 * The whole design is the safety rails, because a model editing the memory
 * file is the most dangerous write in the product:
 *
 *   - Only USER.md. The journal and transcripts are the record of what
 *     happened and are never rewritten by anyone, including this.
 *   - A version is taken first, every time, onto the shared timeline —
 *     so a night's tidying is walked back from the Memory panel, not by
 *     hunting for a file.
 *   - The result is validated before it replaces anything, and validation
 *     failing means nothing changes. Consolidation can only ever merge —
 *     a version that lost names, numbers, or too many lines is refused.
 */

import { readText, writeText } from '../store/FileStore.js';
import { paths } from '../core/Keys.js';
import * as Memory from '../store/MemoryFiles.js';
import { snapshot } from './Versions.js';

const STATE = 'sleep.json';
/** No typing for this long counts as "away". */
export const IDLE_MS = 10 * 60_000;

const SYSTEM = `You are tidying the memory file of a personal assistant. It is a Markdown file of facts about one person, gathered over many days, and it has grown untidy.

Do exactly two things:
1. Merge bullets that record the same fact in different words into one bullet, keeping the most complete wording.
2. Where two bullets contradict, keep the one lower in its section (it is newer) and drop the older.

Do nothing else. Do not rephrase bullets that are fine. Do not add facts. Do not remove a fact unless it is a duplicate or superseded. Keep every section heading exactly as it is, and keep every bullet in its section.

Return the entire file, from the first line to the last, and nothing else.

Worked example — this input:
  ## Preferences
  - Enjoys strong coffee
  - Likes his coffee strong
  - Wants tea instead of coffee now
becomes:
  ## Preferences
  - Wants tea instead of coffee now
The first two say one thing, and the third — being lower, so newer — replaces them both.`;

// The example above is not decoration. Measured on qwen3.5:9b against a file
// with two duplicate pairs: the bare rules merged nothing at all — four
// bullets in, four out — and the same rules with the example merged both
// pairs. A rule tells a model what counts; an example shows it, and on this
// task only the showing worked.

const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function readState() {
  try {
    return JSON.parse(await readText(STATE, '')) || {};
  } catch {
    return {};
  }
}

/**
 * Is it time? A new local day since the last pass, and the person is away.
 *
 * Deliberately not gated on the clock saying 3am: the machine may simply not
 * be on at 3am, and a pass at 2pm while they are at lunch consolidates just as
 * well. "Sleep" is about whose time it costs, not what the clock says.
 */
export async function shouldSleep({ now = new Date(), lastChatAt = 0 } = {}) {
  const state = await readState();
  if (state.lastRun === stamp(now)) return { should: false, reason: 'already ran today' };
  if (now.getTime() - lastChatAt < IDLE_MS) return { should: false, reason: 'the person is here' };
  return { should: true };
}

/** Every noun and number worth its name. The grounding check leans on these. */
export function anchors(text) {
  const found = new Set();
  // The second alternative allows letters after the digits, or "GTS300" slips
  // both branches: it starts with a digit, and \d[\d]* cannot cross into the S.
  for (const m of String(text).matchAll(/\b[A-Z][a-zA-Z0-9']{2,}\b|\b\d[\w.,:-]*\b/g)) {
    found.add(m[0]);
  }
  // Words that start sentences are capitalised without being names; a heading
  // word is structure, not content. Neither should fail a merge.
  for (const noise of ['The', 'They', 'Their', 'Prefers', 'Likes', 'Uses', 'Has', 'Wants', 'Works']) {
    found.delete(noise);
  }
  return found;
}

/**
 * Would this consolidation lose anything? Refuse if so.
 *
 * Three checks, each catching a different way a model ruins a file: dropped
 * sections (structure), a shrunken bullet count beyond what merging explains
 * (deletion), and missing anchors (the actual substance — names and numbers
 * that appear in the old file must appear in the new one).
 */
export function acceptable(before, after) {
  const sections = (t) => (t.match(/^##\s+.+$/gm) || []).map((s) => s.trim());
  const bullets = (t) => (t.match(/^\s*-\s+.+$/gm) || []).length;

  const oldSections = sections(before);
  const newSections = new Set(sections(after));
  for (const s of oldSections) {
    if (!newSections.has(s)) return { ok: false, reason: `the section "${s}" went missing` };
  }

  const oldCount = bullets(before);
  const newCount = bullets(after);
  if (newCount > oldCount) return { ok: false, reason: 'consolidation cannot add facts' };
  if (oldCount >= 4 && newCount < Math.ceil(oldCount * 0.5)) {
    return { ok: false, reason: `${oldCount} facts became ${newCount} — that is deletion, not merging` };
  }

  const missing = [...anchors(before)].filter((a) => !after.includes(a));
  if (missing.length) {
    return { ok: false, reason: `lost: ${missing.slice(0, 5).join(', ')}` };
  }
  return { ok: true };
}

/**
 * The pass itself.
 *
 * @returns {Promise<{ran: boolean, changed?: boolean, reason?: string, version?: string}>}
 * Never throws: sleep failing must never wake anyone.
 */
export async function sleep({ runtime, model, now = new Date(), signal } = {}) {
  const before = await Memory.readProfileRaw();
  const finish = async (result) => {
    await writeText(STATE, JSON.stringify({ lastRun: stamp(now), at: now.toISOString(), ...result }, null, 2));
    return result;
  };

  // A profile with almost nothing in it has nothing to consolidate, and asking
  // a model to tidy three lines invites it to invent a fourth.
  if ((before.match(/^\s*-\s+/gm) || []).length < 4) {
    return finish({ ran: false, reason: 'not enough on file to be untidy' });
  }

  let after = '';
  try {
    const { content } = await runtime.complete({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: before },
      ],
      options: { temperature: 0, num_predict: 2048 },
      timeoutMs: 300_000,
      signal,
    });
    after = String(content || '').trim();
  } catch (err) {
    return finish({ ran: false, reason: err.message });
  }

  // Models fence things out of habit; unwrap rather than fail on it.
  after = after.replace(/^```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  // Empty and identical are different verdicts. Identical means the file was
  // already tidy; empty means the model gave nothing back — seen live when the
  // runner crashed mid-generation — and calling that "nothing needed tidying"
  // would mark the day done on the strength of a failure.
  if (!after) {
    return finish({ ran: false, reason: 'the model returned nothing' });
  }
  if (after === before.trim()) {
    return finish({ ran: true, changed: false, reason: 'nothing needed tidying' });
  }

  const verdict = acceptable(before, after);
  if (!verdict.ok) {
    // Refusal is a success of the rails, not a failure of the night.
    return finish({ ran: true, changed: false, reason: `refused: ${verdict.reason}` });
  }

  // The version goes first and its write completing is what licenses the real
  // one. This used to be a dated copy sleep kept for itself; it is the shared
  // timeline now, so a night's tidying can be walked back from the Memory
  // panel like any other change rather than by finding a file.
  const kept = await snapshot({ reason: 'tidied overnight', now });

  await writeText(paths().user, after.endsWith('\n') ? after : `${after}\n`);
  await Memory.appendJournal('Tidied the memory file overnight — merged duplicates, kept everything else.', { date: now }).catch(() => {});

  return finish({ ran: true, changed: true, version: kept.id || null });
}
