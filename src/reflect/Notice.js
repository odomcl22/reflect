/**
 * Reflect saying something you did not ask about.
 *
 * This is the one thing a local assistant can do that a stateless one cannot,
 * and the one most likely to make it insufferable. An assistant that pipes up
 * on every turn is worse than one that never does — you stop reading it, and
 * then you stop trusting the times it was right.
 *
 * So the design is conservative by construction, in three ways.
 *
 * **It is computed, not generated.** No model call. Every notice here is
 * arithmetic over files Reflect already owns: a date in a note, a timestamp on
 * a project, the last time a task ran. That makes it fast, free, and incapable
 * of inventing something you never said — which is the failure that would end
 * this feature the first time it happened.
 *
 * **It only says what is checkable.** "Your deadline is Friday" is true or
 * false and Reflect knows which. "You said you wanted to stop procrastinating
 * and here you are" is an inference, and a wrong one is unforgivable in a way a
 * wrong fact is not. Nothing in here infers.
 *
 * **One at a time, on a new chat, dismissible for good.** Never mid-thought,
 * never a queue, and never twice about the same thing once you have said no.
 */

import { readText, writeText } from '../store/FileStore.js';
import * as Memory from '../store/MemoryFiles.js';
import * as Tasks from '../tasks/Tasks.js';

const NOTICES = 'notices.json';

/** A project nobody has touched in this long is worth mentioning once. */
export const STALE_DAYS = 14;
/** How far ahead a date has to be before it stops being news. */
export const HORIZON_DAYS = 7;
/** A dismissed notice stays gone this long. Deadlines are the exception. */
export const SNOOZE_DAYS = 30;

const DAY = 86_400_000;
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

/**
 * A date written the way people write dates.
 *
 * Deliberately narrow. Every shape here is unambiguous — the ones left out
 * ("next Friday", "the 3rd") are left out because guessing wrong about a
 * deadline is worse than saying nothing.
 */
export function findDate(text, now = new Date()) {
  const s = String(text).toLowerCase();
  const year = now.getFullYear();

  const named = MONTHS.map((m) => m.slice(0, 3)).join('|');
  const patterns = [
    // 14th of November / 14 Nov
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${named})[a-z]*\\b`),
    // November 14th
    new RegExp(`\\b(${named})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`),
  ];

  for (const [i, re] of patterns.entries()) {
    const m = re.exec(s);
    if (!m) continue;
    const day = Number(i === 0 ? m[1] : m[2]);
    const month = MONTHS.findIndex((name) => name.startsWith(i === 0 ? m[2] : m[1]));
    if (month === -1 || day < 1 || day > 31) continue;
    let when = new Date(year, month, day);
    // A date that has already gone by is next year's, not last year's — nobody
    // writes down a deadline that has passed.
    if (when.getTime() < now.getTime() - 2 * DAY) when = new Date(year + 1, month, day);
    return when;
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  return null;
}

/**
 * Is this line a commitment, or just a line with a date in it?
 *
 * "We met on the 3rd of March" must never become "the 3rd of March is coming
 * up". A date is only news when the sentence around it says it is owed.
 */
const COMMITTED = /\b(deadline|due|by the|submit|hand in|deliver|finish|finished by|send|ship|present|owe|owed)\b/i;

const inDays = (when, now) => Math.round((when.setHours(12, 0, 0, 0) - new Date(now).setHours(12, 0, 0, 0)) / DAY);

const whenWord = (days) =>
  days === 0 ? 'today' : days === 1 ? 'tomorrow' : days < 0 ? `${-days} days ago` : `in ${days} days`;

/** Kept beside the memory it is about, so deleting a home forgets it too. */
const noticeFile = () => NOTICES;

async function readDismissed() {
  try {
    const raw = await readText(noticeFile(), '');
    return raw ? JSON.parse(raw) : {};
  } catch {
    // A corrupt file must not stop Reflect starting. Losing the record means at
    // worst one notice reappears.
    return {};
  }
}

export async function dismiss(key, { at = new Date() } = {}) {
  const seen = await readDismissed();
  seen[key] = at.toISOString();
  await writeText(noticeFile(), JSON.stringify(seen, null, 2));
  return true;
}

const stillDismissed = (seen, key, now) => {
  const at = seen[key];
  if (!at) return false;
  return now.getTime() - new Date(at).getTime() < SNOOZE_DAYS * DAY;
};

/**
 * The one thing worth saying right now, or nothing.
 *
 * Checked in order of how much it costs to miss: something broken first, then
 * something owed, then something drifting.
 *
 * @returns {Promise<{key, kind, text, project?: string, task?: string}|null>}
 */
export async function notice({ now = new Date() } = {}) {
  const seen = await readDismissed();
  const say = (key, kind, text, extra = {}) =>
    stillDismissed(seen, key, now) ? null : { key, kind, text, ...extra };

  // ---- 1. a scheduled task that has been missing ---------------------------
  // The clock only runs while Reflect is open, which is a real limitation and
  // one nobody discovers on their own — they just find the brief never arrives.
  let all = [];
  try {
    all = await Tasks.listTasks();
  } catch {
    all = [];
  }
  for (const task of all) {
    if (!task.valid || !task.enabled || task.schedule.kind === 'manual') continue;
    if (!task.lastRun) continue;
    const missedDays = Math.floor((now - new Date(task.lastRun)) / DAY);
    // Two days' grace on a daily task, a fortnight on anything rarer, so a
    // weekend away is not an event.
    const grace = task.schedule.kind === 'hourly' || task.schedule.kind === 'daily' || task.schedule.kind === 'weekdays' ? 3 : 14;
    if (missedDays < grace) continue;
    const found = say(
      `task:${task.name}:${missedDays}`,
      'task-missed',
      `"${task.name}" last ran ${missedDays} days ago — it runs ${task.schedule.text}, but only while Reflect is open.`,
      { task: task.name },
    );
    if (found) return found;
  }

  // ---- 2. something you said you owed --------------------------------------
  let projects = [];
  try {
    projects = await Memory.listProjects();
  } catch {
    projects = [];
  }

  for (const project of projects) {
    let body = '';
    try {
      // readProject returns { slug, meta, body, raw } — the body is the part
      // with the bullets in it.
      body = (await Memory.readProject(project.slug))?.body || '';
    } catch {
      continue;
    }
    for (const line of body.split('\n')) {
      const text = line.replace(/^[-*]\s*/, '').trim();
      if (!text || !COMMITTED.test(text)) continue;
      const when = findDate(text, now);
      if (!when) continue;
      const days = inDays(new Date(when), now);
      if (days < 0 || days > HORIZON_DAYS) continue;
      // Keyed by the date, not the day it was noticed, so it can be dismissed
      // once and stay gone — but a *different* deadline still gets through.
      const found = say(
        `due:${project.slug}:${when.toISOString().slice(0, 10)}`,
        'due',
        // The note is a sentence someone wrote; the clause after it is ours.
        // Without the trim it reads "…27th of August. — that is in 2 days."
        `${project.name}: ${text.replace(/[.\s]+$/, '')} — that is ${whenWord(days)}.`,
        { project: project.slug },
      );
      if (found) return found;
    }
  }

  // ---- 3. something you were working on and stopped ------------------------
  for (const project of projects) {
    if (project.status !== 'active' || !project.lastTouched) continue;
    const idle = Math.floor((now - new Date(project.lastTouched)) / DAY);
    if (idle < STALE_DAYS) continue;
    const found = say(
      `stale:${project.slug}`,
      'stale',
      `You have not touched ${project.name} in ${idle} days.`,
      { project: project.slug },
    );
    if (found) return found;
  }

  return null;
}
