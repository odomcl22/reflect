/**
 * The mirror: today's page.
 *
 * Everything on it is computed from files, never generated — the same rule
 * Notice.js follows and for the same reason. Most of these tests are about
 * when a section stays *off* the page, because a dashboard of vacancies is
 * worse than the plain empty state it replaced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-today-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const Tasks = await import('../src/tasks/Tasks.js');
const Conversations = await import('../src/store/ConversationStore.js');
const { todayPage, anniversary, owedThisWeek, pickUp } = await import('../src/reflect/Today.js');

await FileStore.scaffold();

const NOW = new Date('2026-08-30T09:00:00');
const DAY = 86_400_000;

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

async function clean() {
  for (const dir of ['projects', 'tasks', 'journal', 'conversations']) {
    await FileStore.removeAll(dir).catch(() => {});
  }
  await FileStore.writeText('notices.json', '{}');
}

test('a fresh install has an empty page, and says so', async () => {
  await clean();
  const page = await todayPage({ now: NOW });
  assert.equal(page.empty, true, 'the client falls back to the plain empty state');
});

// The cheapest feature in the product and the one nobody else can build,
// because nobody else keeps the files.
test('a year ago today comes back from the journal', async () => {
  await clean();
  await Memory.appendJournal('Stuck on chapter two all day', { date: new Date('2025-08-30T21:00:00') });

  const ann = await anniversary(NOW);
  assert.equal(ann.label, 'A year ago today');
  assert.match(ann.lines[0], /chapter two/);
  assert.ok(!/\d{1,2}:\d{2}/.test(ann.lines[0]), 'the timestamp is noise a year later');
});

test('a year beats a month when both exist', async () => {
  await clean();
  await Memory.appendJournal('the old thing', { date: new Date('2025-08-30T12:00:00') });
  await Memory.appendJournal('the recent thing', { date: new Date('2026-07-30T12:00:00') });
  assert.equal((await anniversary(NOW)).label, 'A year ago today');
});

test('no journal that day, no anniversary — never a near miss', async () => {
  await clean();
  await Memory.appendJournal('close but wrong day', { date: new Date('2025-08-29T12:00:00') });
  assert.equal(await anniversary(NOW), null);
});

// Notice stays one-at-a-time because it interrupts. A page is read at the
// reader's pace, so it carries the week — but with the same date discipline.
test('the page lists what is owed this week, nearest first', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Draft due by the 3rd of September' });
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 1st of September for the cover' });
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'We met on the 2nd of September last year' });

  const owed = await owedThisWeek(NOW);
  assert.equal(owed.length, 2, 'the reminiscence with a date in it is not owed');
  assert.ok(owed[0].days <= owed[1].days, 'nearest first');
  assert.match(owed[0].text, /cover/);
});

test('a thread from this week is offered to pick up; an hour ago is not', async () => {
  await clean();
  await Conversations.ensure('fresh', { title: 'Just now' });
  await Conversations.append('fresh', { role: 'user', content: 'hi', at: new Date(NOW - 3_600_000).toISOString() });
  assert.equal(await pickUp(NOW), null, 'between messages is not mid-thought');

  await clean();
  await Conversations.ensure('left', { title: 'The goldfish scene' });
  await Conversations.append('left', { role: 'user', content: 'How should Bartleby react?', at: new Date(NOW - 3 * DAY).toISOString() });
  const thread = await pickUp(NOW);
  assert.equal(thread.id, 'left');
  assert.equal(thread.daysAgo, 3);
});

test('a month-old thread is finished, not mid-thought', async () => {
  await clean();
  await Conversations.ensure('old', { title: 'Long done' });
  await Conversations.append('old', { role: 'user', content: 'x', at: new Date(NOW - 30 * DAY).toISOString() });
  assert.equal(await pickUp(NOW), null, 'resurfacing it forever would make the page nag');
});

test('the page carries the interrupt-grade notice when there is one', async () => {
  await clean();
  await Tasks.writeTask('morning-brief', { instruction: 'x', when: 'every day at 09:00', enabled: true });
  await Tasks.markRun('morning-brief', { at: new Date(NOW - 9 * DAY).toISOString() });

  const page = await todayPage({ now: NOW });
  assert.equal(page.notice?.kind, 'task-missed');
  assert.equal(page.empty, false);
});

// The same deadline must not appear twice — once in the owed section and once
// as a dismissible bar under it.
test('a due notice stands down when the owed section already has it', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 1st of September' });

  const page = await todayPage({ now: NOW });
  assert.equal(page.owed.length, 1);
  assert.equal(page.notice, null, 'owed already says it');
});
