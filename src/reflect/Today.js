/**
 * The mirror: today's page, composed from what Reflect already holds.
 *
 * The app is called Reflect and, until this file, it never reflected anything
 * back — you opened it to a text box and a chat list, which is what every AI
 * app looks like. The one thing this product has that they do not is the
 * files: a journal with dates on it, projects with deadlines in them, tasks
 * with clocks, conversations with loose ends. This composes those into the
 * first thing you see.
 *
 * Everything here is computed, nothing is generated. Same rule as Notice.js
 * and for the same reason: the page must be on screen in the time it takes to
 * read four files, and it must never say something you cannot trace to a file
 * you wrote. The model gets its turn at night — see Sleep — not here.
 *
 * Every section earns its place by having something to say. An empty section
 * is omitted, and a wholly empty page tells the client to show the plain
 * empty state rather than a dashboard of vacancies.
 */

import * as Memory from '../store/MemoryFiles.js';
import * as Conversations from '../store/ConversationStore.js';
import * as Tasks from '../tasks/Tasks.js';
import { due as promisesDue } from './Promises.js';
import { notice, findDate } from './Notice.js';

const DAY = 86_400_000;

/** The committed-date filter, shared with Notice for the same reason it exists. */
const COMMITTED = /\b(deadline|due|by the|submit|hand in|deliver|finish|finished by|send|ship|present|owe|owed)\b/i;

const daysBetween = (a, b) =>
  Math.round((new Date(a).setHours(12, 0, 0, 0) - new Date(b).setHours(12, 0, 0, 0)) / DAY);

/**
 * "A year ago today." The cheapest feature in the product and the one nobody
 * else can build, because nobody else keeps the files. Checked at a year, six
 * months, and a month — first hit wins, longest span first, because "a year
 * ago" beats "a month ago" every time both are true.
 */
export async function anniversary(now = new Date()) {
  const spans = [
    { label: 'A year ago today', months: 12 },
    { label: 'Six months ago today', months: 6 },
    { label: 'A month ago today', months: 1 },
  ];
  for (const span of spans) {
    const then = new Date(now);
    then.setMonth(then.getMonth() - span.months);
    const entry = await Memory.readJournalOn(then);
    if (!entry) continue;
    // The log lines carry timestamps ("09:14 — stuck on chapter two"); the
    // times are noise a year later, the words are the point.
    const lines = entry.body
      .split('\n')
      .map((l) => l.replace(/^[-*]?\s*\d{1,2}:\d{2}\s*—\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter((l) => l && !/^#/.test(l));
    if (!lines.length) continue;
    return { label: span.label, date: entry.date, lines: lines.slice(0, 3) };
  }
  return null;
}

/**
 * Everything owed inside the horizon, not just the single most urgent thing.
 *
 * Notice stays one-at-a-time because it interrupts; a page is read at the
 * reader's own pace, so it can afford the whole week.
 */
export async function owedThisWeek(now = new Date(), horizon = 7) {
  const out = [];
  let projects = [];
  try {
    projects = await Memory.listProjects();
  } catch {
    return out;
  }
  for (const project of projects) {
    let body = '';
    try {
      body = (await Memory.readProject(project.slug))?.body || '';
    } catch {
      continue;
    }
    for (const line of body.split('\n')) {
      const text = line.replace(/^[-*]\s*/, '').trim();
      if (!text || !COMMITTED.test(text)) continue;
      const when = findDate(text, now);
      if (!when) continue;
      const days = daysBetween(when, now);
      if (days < 0 || days > horizon) continue;
      out.push({ project: project.name, slug: project.slug, text: text.replace(/[.\s]+$/, ''), days });
    }
  }
  return out.sort((a, b) => a.days - b.days).slice(0, 4);
}

/** Tasks whose next slot lands today. What the day already has planned. */
export async function scheduledToday(now = new Date()) {
  let all = [];
  try {
    all = await Tasks.listTasks();
  } catch {
    return [];
  }
  const out = [];
  for (const task of all) {
    if (!task.valid || !task.enabled) continue;
    const next = Tasks.nextRun(task, now);
    if (!next) continue;
    if (daysBetween(next, now) !== 0) continue;
    out.push({ name: task.name, at: next.toTimeString().slice(0, 5) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 4);
}

/**
 * The thread left mid-thought. The founding wound is losing where you were;
 * the mirror's answer is to hold your place without being asked.
 */
export async function pickUp(now = new Date()) {
  let all = [];
  try {
    all = await Conversations.list();
  } catch {
    return null;
  }
  const recent = all.find((c) => c.turnCount > 0 && c.updatedAt);
  if (!recent) return null;
  const age = daysBetween(now, recent.updatedAt);
  // A thread from an hour ago is not "left" — you are simply between messages.
  // One from a month ago is not mid-thought either; it is finished, and
  // resurfacing it forever would make the page nag.
  if (age < 1 || age > 14) return null;
  return {
    id: recent.id,
    title: recent.title,
    daysAgo: age,
    preview: recent.preview,
    project: recent.project || null,
  };
}

/** What the journal took down yesterday — the day, played back. */
export async function yesterday(now = new Date()) {
  const then = new Date(now.getTime() - DAY);
  const entry = await Memory.readJournalOn(then);
  if (!entry) return null;
  const lines = entry.body
    .split('\n')
    .map((l) => l.replace(/^[-*]?\s*\d{1,2}:\d{2}\s*—\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && !/^#/.test(l));
  return lines.length ? { date: entry.date, lines: lines.slice(0, 4) } : null;
}

/**
 * The whole page. Sections are null when they have nothing, and `empty` says
 * whether the page as a whole is worth drawing.
 */
export async function todayPage({ now = new Date() } = {}) {
  const [ann, owed, tasks, thread, past, said, promised] = await Promise.all([
    anniversary(now),
    owedThisWeek(now),
    scheduledToday(now),
    pickUp(now),
    yesterday(now),
    notice({ now }),
    promisesDue(now).catch(() => []),
  ]);

  // Nothing said yet, and nothing known. Worth telling apart from a quiet
  // Tuesday: one wants a page about your week, the other wants a way in.
  // Asking "where should we pick up" on the first run is a question about a
  // history the person does not have, which reads as the app mistaking them
  // for somebody else.
  let firstRun = false;
  try {
    const [said, known] = await Promise.all([Conversations.list(), Memory.readProfile()]);
    firstRun = !said.length && !known.trim();
  } catch {
    firstRun = false; // Never guess this one wrong in the direction of nagging.
  }

  const page = {
    date: now.toISOString().slice(0, 10),
    firstRun,
    anniversary: ann,
    // Things you said you would do, in your own words. First on the page
    // because it is the only section that is about today rather than about
    // the past — everything else here is Reflect remembering backwards.
    promised,
    owed,
    tasksToday: tasks,
    pickUp: thread,
    yesterday: past,
    // The interrupt-grade notice keeps its own machinery (dismissal, one at a
    // time); the page simply gives it a better room to appear in. Except a
    // 'due' notice when the owed section is already on the page — that is the
    // same deadline said twice, once politely and once with a Dismiss button.
    notice: said?.kind === 'due' && owed.length ? null : said,
  };
  page.empty =
    !ann && !promised.length && !owed.length && !tasks.length && !thread && !past && !page.notice;
  return page;
}
