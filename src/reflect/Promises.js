/**
 * Remembering forward.
 *
 * Everything else in here remembers backwards: what you said, what you decided,
 * what you were working on. That is the half of memory every assistant has. The
 * other half is the one people actually mean when they say they want an
 * assistant — "I'll call mom tomorrow", said in passing, in the middle of a
 * conversation about something else, and then gone.
 *
 * Nobody else ships this, and the reason is not difficulty. It is that a
 * promise has nowhere to land unless something owns a journal and a morning
 * page. A stateless assistant cannot bring it back tomorrow because there is no
 * tomorrow to bring it back to. Reflect has both already.
 *
 * Two rules keep this from becoming a nag.
 *
 * **Computed, never generated.** Same rule as noticing. No model decides what
 * you promised — a promise is your own sentence, kept verbatim, with a date
 * arithmetic could find in it. Reflect cannot invent an obligation you never
 * took on, which is the failure that would end this feature the first time it
 * happened.
 *
 * **A date or nothing.** "I'll be honest" and "I'll think about it" are turns
 * of phrase, not commitments, and the thing that separates them from "I'll call
 * mom tomorrow" is that one of them is checkable. Requiring a date does almost
 * all the filtering, and it does it without guessing at intent.
 */

import { appendLine, readLines } from '../store/FileStore.js';
import { findDate } from './Notice.js';

const FILE = 'promises.jsonl';
const DAY = 86_400_000;

/** How long after its date a promise keeps showing up before it goes quiet. */
export const GRACE_DAYS = 7;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The first person taking something on.
 *
 * Only the person's own words are ever scanned, so "I'll look that up for you"
 * from the assistant can never become something you owe. The list is
 * deliberately about intent rather than politeness: "I might", "I should
 * probably" and "I want to" are all left out, because a maybe recorded as a
 * promise is worse than a promise missed.
 */
const PROMISE =
  /\b(i'?ll\b|i will\b|i'?m going to\b|i am going to\b|i need to\b|i have to\b|i've got to\b|i gotta\b|i must\b|i promised\b|i said i'?d\b|remind me to\b)/i;

/**
 * Turns of phrase that begin like a commitment and are not one.
 *
 * These only matter when a date happens to sit in the same sentence — "I'll be
 * honest, Tuesday was rough" would otherwise become a promise to be honest on
 * Tuesday.
 */
const HEDGE = /\bi'?ll\s+(be honest|be frank|admit|say this|tell you|bet|warn you|grant you)\b/i;

const stamp = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const atNoon = (d) => {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  return x;
};

export const daysBetween = (when, now) => Math.round((atNoon(when) - atNoon(now)) / DAY);

/**
 * A date the way it gets said out loud, not the way it gets written down.
 *
 * Notice.js reads dates people *write* — "14 Nov", "2026-03-01" — because it
 * reads notes. Promises are spoken mid-sentence, where the common forms are
 * relative, so those come first and the written ones are the fallback.
 *
 * "next Friday" is deliberately absent, as it is in Notice: it means the coming
 * Friday to half of people and the one after to the other half, and a promise
 * surfaced on the wrong day is worse than one surfaced late.
 */
export function whenFrom(text, now = new Date()) {
  const s = String(text).toLowerCase();

  if (/\btonight\b|\blater today\b|\bthis evening\b|\bthis afternoon\b/.test(s)) return atNoon(now);
  if (/\btoday\b/.test(s)) return atNoon(now);
  if (/\btomorrow\b/.test(s)) return atNoon(new Date(now.getTime() + DAY));
  if (/\bday after tomorrow\b/.test(s)) return atNoon(new Date(now.getTime() + 2 * DAY));

  // "this week" and "this weekend" resolve to their own end, because that is
  // when the promise actually comes due — surfacing "sometime this week" on
  // Monday is a nag, and on Sunday it is a reminder.
  if (/\bthis weekend\b/.test(s)) {
    const ahead = (6 - now.getDay() + 7) % 7;
    return atNoon(new Date(now.getTime() + ahead * DAY));
  }
  if (/\bthis week\b|\bby the end of the week\b/.test(s)) {
    const ahead = (5 - now.getDay() + 7) % 7; // Friday
    return atNoon(new Date(now.getTime() + ahead * DAY));
  }

  // A bare weekday means the next one. Said on the day itself it means today,
  // which is what people mean — anyone meaning a week out says "next".
  if (!/\bnext\s+(week|month|year|mon|tue|wed|thu|fri|sat|sun)/i.test(s)) {
    for (const [i, name] of WEEKDAYS.entries()) {
      if (!new RegExp(`\\b${name}\\b`).test(s)) continue;
      const ahead = (i - now.getDay() + 7) % 7;
      return atNoon(new Date(now.getTime() + ahead * DAY));
    }
  }

  const written = findDate(s, now);
  return written ? atNoon(written) : null;
}

/**
 * Is this sentence a promise, and when is it for?
 *
 * Returns null far more often than not, which is the point.
 */
export function findPromise(text, now = new Date()) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Sentence by sentence: one line of chat can hold a promise and three other
  // things, and the promise should not drag the rest in with it.
  for (const piece of raw.split(/(?<=[.!?;\n])\s+/)) {
    const sentence = piece.trim();
    if (!sentence || sentence.length < 6) continue;
    if (!PROMISE.test(sentence) || HEDGE.test(sentence)) continue;

    const when = whenFrom(sentence, now);
    if (!when) continue;

    return { what: tidy(sentence), due: stamp(when), days: daysBetween(when, now) };
  }
  return null;
}

/**
 * Drop the bit of the sentence that turned back to the conversation.
 *
 * "I need to renew the insurance on Friday, anyway how are you?" is a promise
 * with a chat attached, and the whole string on a morning page reads as sloppy
 * as it looks. Deliberately narrow: only clauses that are visibly the speaker
 * changing the subject. A trailing "but only after lunch" is part of the
 * promise and stays, because losing a qualifier is worse than keeping a
 * pleasantry.
 */
const tidy = (s) =>
  String(s)
    .replace(/[,;]\s*(anyway|by the way|btw)\b[^.?!]*[.?!]?\s*$/i, '')
    .replace(/[,;]\s*(how are you|how's it going|what about you|hope you)\b[^.?!]*[.?!]?\s*$/i, '')
    .replace(/[\s.,;]+$/, '');

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Everything ever recorded, newest state per promise.
 *
 * Append-only, like the transcripts and the receipts: keeping a promise writes
 * a new line rather than editing an old one, so the record of having made it
 * survives having finished it.
 */
async function all() {
  const lines = await readLines(FILE).catch(() => []);
  const byId = new Map();
  for (const line of lines) {
    if (!line || !line.id) continue;
    byId.set(line.id, { ...(byId.get(line.id) || {}), ...line });
  }
  return [...byId.values()];
}

/** Write one down. Silently does nothing if the same one is already open. */
export async function record({ text, conversationId = null, now = new Date() }) {
  const found = findPromise(text, now);
  if (!found) return { recorded: false };

  const key = normalize(found.what);
  const already = (await all()).find(
    (p) => p.state === 'open' && p.due === found.due && normalize(p.what) === key,
  );
  if (already) return { recorded: false, reason: 'already noted' };

  const entry = {
    id: `${found.due}-${Math.random().toString(36).slice(2, 8)}`,
    what: found.what,
    due: found.due,
    at: now.toISOString(),
    conversationId,
    state: 'open',
  };
  await appendLine(FILE, entry);
  return { recorded: true, promise: entry };
}

/**
 * What is owed, soonest first.
 *
 * Nothing from the future beyond today: a promise for Friday is not news on
 * Monday, and a page that lists everything you will ever owe is a burden rather
 * than a help. Overdue things stay for a week and then stop asking.
 */
export async function due(now = new Date(), { grace = GRACE_DAYS } = {}) {
  const open = (await all()).filter((p) => p.state === 'open');
  return open
    .map((p) => ({ ...p, days: daysBetween(new Date(`${p.due}T12:00:00`), now) }))
    .filter((p) => p.days <= 0 && p.days >= -grace)
    .sort((a, b) => a.days - b.days);
}

/** Everything still open, whenever it falls. For the memory panel. */
export async function open(now = new Date()) {
  return (await all())
    .filter((p) => p.state === 'open')
    .map((p) => ({ ...p, days: daysBetween(new Date(`${p.due}T12:00:00`), now) }))
    .sort((a, b) => a.days - b.days);
}

/** Done, or never going to be. Both are append-only state changes. */
export async function settle(id, state = 'kept', { now = new Date() } = {}) {
  if (!['kept', 'dropped'].includes(state)) return { ok: false, reason: 'unknown state' };
  const found = (await all()).find((p) => p.id === id);
  if (!found) return { ok: false, reason: 'no such promise' };
  await appendLine(FILE, { id, state, settledAt: now.toISOString() });
  return { ok: true, id, state };
}
