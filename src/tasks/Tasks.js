/**
 * Tasks — something you would have typed, saved, with an optional clock.
 *
 * A task is a file: `tasks/<name>.md`, frontmatter over the instruction.
 *
 *     ---
 *     name: weekly-notes
 *     when: every monday at 09:00
 *     ---
 *     Summarise the notes I added to Desk last week, and write the summary to
 *     Desk/summary.md.
 *
 * The whole design rests on one decision: **running a task is an ordinary
 * turn.** The instruction is sent through the same chat pipeline a person types
 * into — same recall, same skills, same grants, same tools, same transcript.
 * There is no task executor, no plan, no step list, no separate place where
 * work happens.
 *
 * That is not laziness, it is the boundary. Reflect's non-goal is being a
 * mission engine: the moment tasks get their own execution model, they grow
 * steps, and steps grow dependencies, and Reflect becomes a worse copy of
 * ReflectForge. A task that cannot be expressed as one thing you could have
 * typed is a task that belongs in Forge.
 *
 * Schedules are deliberately few and written the way a person would say them.
 * Cron is more expressive and nobody remembers it; five shapes cover what a
 * personal assistant is actually asked for, and anything stranger can be run by
 * hand. Times are local to the machine, because that is where the person is.
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readText, writeText, listFiles, exists, remove } from '../store/FileStore.js';
import { parseFrontmatter, serializeFrontmatter } from '../store/MemoryFiles.js';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Capped at the 28th when parsed, so no month is ever missing the date. */
const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};

export const taskKey = (name) => join(paths().tasks, `${name}.md`);

/**
 * Read a schedule written in English.
 *
 * @returns {{kind: 'manual'|'hourly'|'daily'|'weekdays'|'weekly'|'monthly', hour?: number, minute?: number, weekday?: number, day?: number, text: string}}
 */
export function parseWhen(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text || text === 'manual' || text === 'never') return { kind: 'manual', text: 'when you ask' };

  if (/^every hour$|^hourly$/.test(text)) return { kind: 'hourly', text: 'every hour' };

  const time = /at\s+(\d{1,2}):(\d{2})/.exec(text);
  const hour = time ? Math.min(23, Number(time[1])) : 9;
  const minute = time ? Math.min(59, Number(time[2])) : 0;
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // A recurrence has to say it recurs. Without this, "on the third tuesday
  // unless it rains" becomes "every tuesday", which is a schedule nobody asked
  // for that then runs by itself every week.
  // "monday to friday" names its own recurrence without using any of these
  // words, so it is listed too. Kept to phrasings that can only mean a repeat —
  // the guard above is what stops "the third tuesday unless it rains" becoming
  // a weekly task nobody asked for.
  const repeats =
    /\bevery\b|\beach\b|\bdaily\b|\bweekly\b|\bhourly\b|\bmonthly\b|\bweekday/.test(text) ||
    /monday to friday|mon-fri|\bworking days?\b|\bwork days?\b/.test(text);

  // Before the weekday match below, or "every weekday" finds "monday" in
  // nothing and falls through to manual. This is the shape a morning brief
  // actually has, and it was the first thing a model reached for.
  if (repeats && /\bweekdays?\b|\bworking days?\b|\bwork days?\b|monday to friday|mon-fri/i.test(text)) {
    return { kind: 'weekdays', hour, minute, text: `every weekday at ${clock}` };
  }
  const weekday = repeats ? DAYS.findIndex((d) => text.includes(d)) : -1;
  if (weekday !== -1) {
    return { kind: 'weekly', weekday, hour, minute, text: `every ${DAYS[weekday]} at ${clock}` };
  }

  // Monthly is read before daily, because "every month on the 1st" contains no
  // word that daily matches but does contain a date that nothing else wants.
  if (repeats && /\bmonth(ly)?\b/.test(text)) {
    const nth = /\b(?:on the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text.replace(/at\s+\d{1,2}:\d{2}/, ''));
    const day = nth ? Math.min(28, Math.max(1, Number(nth[1]))) : 1;
    return { kind: 'monthly', day, hour, minute, text: `every month on the ${ordinal(day)} at ${clock}` };
  }

  if (repeats && /every day|daily|each day/.test(text)) return { kind: 'daily', hour, minute, text: `every day at ${clock}` };

  // Unrecognised is manual, not an error: a task with a schedule nobody can
  // read should still be a task you can run.
  return { kind: 'manual', text: `when you ask (could not read "${input}")` };
}

/**
 * Is this task due, given when it last ran?
 *
 * Compares against the most recent scheduled moment rather than counting
 * intervals, so a machine that was asleep at nine runs the task when it wakes
 * instead of skipping the day — and a task never runs twice for one slot.
 */
export function isDue(task, now = new Date()) {
  if (!task.enabled) return false;
  const when = parseWhen(task.when);
  if (when.kind === 'manual') return false;

  // Until it has run, the moment it was created is the baseline. Otherwise a
  // task written at 08:59 saying "every day at 09:00" fires instantly, for
  // yesterday's slot, which is never what anyone meant.
  const since = task.lastRun || task.createdAt;
  const last = since ? new Date(since) : null;
  const slot = new Date(now);

  if (when.kind === 'hourly') {
    slot.setMinutes(0, 0, 0);
  } else {
    slot.setHours(when.hour, when.minute, 0, 0);
    if (slot > now) slot.setDate(slot.getDate() - 1);

    if (when.kind === 'weekly') {
      // Walk back to the most recent occurrence of that weekday.
      while (slot.getDay() !== when.weekday) slot.setDate(slot.getDate() - 1);
    }

    if (when.kind === 'weekdays') {
      // Back to the last Monday-to-Friday slot. On a Sunday that is Friday, and
      // the task is due once for it rather than three times.
      while (slot.getDay() === 0 || slot.getDay() === 6) slot.setDate(slot.getDate() - 1);
    }

    if (when.kind === 'monthly') {
      // Back to this month's date, or last month's if it has not come round.
      slot.setDate(when.day);
      slot.setHours(when.hour, when.minute, 0, 0);
      if (slot > now) slot.setMonth(slot.getMonth() - 1, when.day);
    }
  }

  if (slot > now) return false;
  // No baseline at all means the task predates this field; treat the slot as
  // due rather than never firing.
  return !last || last < slot;
}

/**
 * When this task will next run.
 *
 * isDue answers "now?", which is all the scheduler needs. A person looking at
 * the Tasks screen is asking a different question — what is coming up — and
 * answering it by listing schedules makes them do the arithmetic themselves.
 *
 * Deliberately ignores lastRun. This is the next *slot*, not a promise: the
 * clock only runs while Reflect is open, so a task can be overdue and still
 * have a next slot tomorrow. Showing the slot is honest; showing a countdown
 * to something that only fires if the app happens to be running is not.
 *
 * @returns {Date|null} null when nothing is scheduled — manual, off, or broken.
 */
export function nextRun(task, now = new Date()) {
  if (!task?.enabled) return null;
  const when = parseWhen(task.when);
  if (when.kind === 'manual') return null;

  const next = new Date(now);
  if (when.kind === 'hourly') {
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }

  next.setHours(when.hour, when.minute, 0, 0);

  if (when.kind === 'daily') {
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  if (when.kind === 'weekdays') {
    if (next <= now) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next;
  }

  if (when.kind === 'weekly') {
    while (next.getDay() !== when.weekday || next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  if (when.kind === 'monthly') {
    next.setDate(when.day);
    next.setHours(when.hour, when.minute, 0, 0);
    // setMonth on the 31st of a short month rolls into the next one, which is
    // why parseWhen caps the date at 28 — but go through setMonth's day
    // argument anyway so this stays correct if that cap ever moves.
    if (next <= now) next.setMonth(next.getMonth() + 1, when.day);
    return next;
  }

  return null;
}

/**
 * How far a task may reach, worked out from what the person asked for.
 *
 * A task runs while nobody is watching. That is the whole point of it, and it
 * is also the reason it should not hold every tool a live conversation holds:
 * at eight in the morning there is no one at the screen to notice a message
 * going to the wrong person, and a message cannot be taken back.
 *
 * So reaching outward is off unless the instruction asked for it. "Text my wife
 * good morning every day at eight" is a task that may send, because that is
 * what it is for. "Search the news and summarise it" is not, even though the
 * same machine can send.
 *
 * Read from the instruction rather than set by the model, and this is the part
 * that matters: `task_create` is a tool, so a model that could set this field
 * could grant itself the ability to message people — and a web page Reflect
 * read could talk it into doing so. The instruction is the person's own words.
 * Computing from those is the same rule as noticing and promises, for the same
 * reason.
 *
 * It is shown on the Tasks screen and can be changed there, because a guess
 * about someone's intent should always be visible and always correctable.
 */
export const REACH = ['none', 'notify', 'send'];

const SENDS = /\b(text|message|imessage|imessage|email|e-mail|mail|send|write to|reply to)\b/i;
const NOTIFIES = /\b(remind|notify|alert|tell me|let me know|nudge|ping me)\b/i;

export function reachFor(instruction) {
  const text = String(instruction || '');
  // "send" wins over "notify": an instruction asking for both wants the
  // stronger one, and the weaker is included in it.
  if (SENDS.test(text)) return 'send';
  if (NOTIFIES.test(text)) return 'notify';
  return 'none';
}

/**
 * The wider of two reaches.
 *
 * An edit keeps the permission the task already had, and takes the new
 * instruction's only when it asks for more. Without this, granting weekly-notes
 * the right to email you and then fixing a typo in its wording would quietly
 * take that right away again, and the task would stop emailing for a reason
 * nothing on the screen explained.
 *
 * It can only widen by accident, never narrow by accident. Narrowing is the
 * button, which is deliberate and visible — the safe direction is the one that
 * requires someone to mean it.
 */
export function widerReach(a, b) {
  const rank = (r) => REACH.indexOf(REACH.includes(r) ? r : 'none');
  return rank(a) >= rank(b) ? (REACH.includes(a) ? a : 'none') : b;
}

/**
 * Whether a task may run a shortcut: only when its own instruction says so.
 *
 * A shortcut can do anything the person built it to do — send, delete, buy —
 * and a task runs with nobody watching. So the same rule as reaching out:
 * read from the person's words, never set by the model. "Every morning, run my
 * Morning Routine shortcut" may; "summarise the news" may not, even though the
 * shortcut is allowed and the tool exists.
 */
export const mayRunShortcuts = (instruction) => /\bshortcuts?\b/i.test(String(instruction || ''));

/** What a given reach actually permits, for the tool filter. */
export function toolsBlockedBy(reach) {
  if (reach === 'send') return [];
  if (reach === 'notify') return ['message', 'mail_draft'];
  return ['notify', 'message', 'mail_draft'];
}

export function parseTask(markdown, file = '') {
  const { data, body } = parseFrontmatter(markdown);
  const name = String(data.name || file.replace(/\.md$/, '')).trim();
  const when = parseWhen(data.when);
  const problems = [];

  if (!NAME.test(name)) problems.push('name must be lowercase words joined by hyphens');
  if (!body.trim()) problems.push('no instruction — a task is the thing you would have typed');

  return {
    name,
    instruction: body.trim(),
    when: data.when ? String(data.when) : 'manual',
    schedule: when,
    // Off is a real state: a task you are not ready to trust should be
    // keepable without running.
    enabled: String(data.enabled ?? 'true') !== 'false',
    // A task written before this existed has no stored value, and gets the one
    // its own instruction implies rather than everything by default.
    reach: REACH.includes(String(data.reach)) ? String(data.reach) : reachFor(body),
    createdAt: data.createdAt ? String(data.createdAt) : null,
    lastRun: data.lastRun ? String(data.lastRun) : null,
    lastConversation: data.lastConversation ? String(data.lastConversation) : null,
    problems,
    valid: problems.length === 0,
  };
}

export function serializeTask(task) {
  return (
    serializeFrontmatter({
      name: task.name,
      when: task.when || 'manual',
      enabled: task.enabled === false ? 'false' : 'true',
      reach: REACH.includes(task.reach) ? task.reach : reachFor(task.instruction || ''),
      ...(task.createdAt ? { createdAt: task.createdAt } : {}),
      ...(task.lastRun ? { lastRun: task.lastRun } : {}),
      ...(task.lastConversation ? { lastConversation: task.lastConversation } : {}),
    }) + `\n${task.instruction.trim()}\n`
  );
}

export async function listTasks() {
  const files = await listFiles(paths().tasks, '.md');
  const found = [];
  for (const file of files) {
    const task = parseTask(await readText(join(paths().tasks, file), ''), file);
    found.push({ ...task, key: join(paths().tasks, file) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTask(name) {
  const key = taskKey(name);
  if (!(await exists(key))) return null;
  return { ...parseTask(await readText(key, ''), `${name}.md`), key };
}

export async function writeTask(name, fields) {
  if (!NAME.test(name)) throw new Error(`Unsafe task name: ${name}`);
  const current =
    (await readTask(name)) ||
    { name, instruction: '', when: 'manual', enabled: true, createdAt: new Date().toISOString() };
  const next = { ...current, ...fields, name };
  await writeText(taskKey(name), serializeTask(next));
  return readTask(name);
}

export async function removeTask(name) {
  if (!NAME.test(name)) throw new Error(`Unsafe task name: ${name}`);
  if (!(await exists(taskKey(name)))) return false;
  await remove(taskKey(name));
  return true;
}

/** Record that a task ran, and where its conversation went. */
export async function markRun(name, { at = new Date().toISOString(), conversationId = null } = {}) {
  return writeTask(name, { lastRun: at, lastConversation: conversationId });
}

export async function dueTasks(now = new Date()) {
  return (await listTasks()).filter((t) => t.valid && isDue(t, now));
}
