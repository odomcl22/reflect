/**
 * Reflect saying something you did not ask about.
 *
 * The one thing a local assistant can do that a stateless one cannot, and the
 * one most likely to make it insufferable. Most of this file is about the
 * times it must stay quiet, because that is the part that decides whether
 * anyone keeps reading the times it speaks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-notice-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const Tasks = await import('../src/tasks/Tasks.js');
const { notice, dismiss, findDate, STALE_DAYS, HORIZON_DAYS } = await import('../src/reflect/Notice.js');

await FileStore.scaffold();

const NOW = new Date('2026-08-24T10:00:00');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

async function clean() {
  for (const dir of ['projects', 'tasks']) {
    await FileStore.removeAll(dir).catch(() => {});
  }
  await FileStore.writeText('notices.json', '{}');
}

// ------------------------------------------------------------------- quiet

test('a fresh install has nothing to say', async () => {
  await clean();
  assert.equal(await notice({ now: NOW }), null);
});

// The line has a date in it and is not a commitment. Turning "we met on the 3rd
// of March" into "the 3rd of March is coming up" is the kind of wrong that
// makes someone switch the whole feature off.
test('a date that is not owed is not a deadline', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'We met on the 3rd of September at the pier' });
  assert.equal(await notice({ now: NOW }), null);
});

test('a deadline too far out is not news yet', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 14th of November' });
  assert.equal(await notice({ now: NOW }), null, `${HORIZON_DAYS} days is the horizon`);
});

test('a project touched recently is not stale', async () => {
  await clean();
  await Memory.createProject('Fresh');
  assert.equal(await notice({ now: NOW }), null);
});

// ------------------------------------------------------------------- speaks

test('a deadline inside the horizon is worth saying once', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 27th of August' });

  const said = await notice({ now: NOW });
  assert.equal(said?.kind, 'due');
  assert.match(said.text, /Turtle book/);
  assert.match(said.text, /in 3 days/);
});

test('a project left alone for a fortnight is mentioned', async () => {
  await clean();
  await Memory.createProject('Hydrodynamics');
  const { raw } = await Memory.readProject('hydrodynamics');
  await Memory.writeProject('hydrodynamics', raw.replace(/last_touched: .*/, `last_touched: ${daysAgo(30).toISOString().slice(0, 10)}`));

  const said = await notice({ now: NOW });
  assert.equal(said?.kind, 'stale');
  assert.match(said.text, /30 days/);
});

// The clock only runs while Reflect is open, which is a real limitation nobody
// discovers on their own — they just find the brief never arrived.
test('a scheduled task that stopped running says so', async () => {
  await clean();
  await Tasks.writeTask('morning-brief', { instruction: 'Summarise yesterday', when: 'every day at 09:00', enabled: true });
  await Tasks.markRun('morning-brief', { at: daysAgo(9).toISOString() });

  const said = await notice({ now: NOW });
  assert.equal(said?.kind, 'task-missed');
  assert.match(said.text, /morning-brief/);
  assert.match(said.text, /only while Reflect is open/);
});

test('a weekend away is not an event', async () => {
  await clean();
  await Tasks.writeTask('morning-brief', { instruction: 'Summarise yesterday', when: 'every day at 09:00', enabled: true });
  await Tasks.markRun('morning-brief', { at: daysAgo(2).toISOString() });
  assert.equal(await notice({ now: NOW }), null);
});

// ------------------------------------------------------------- one at a time

test('something broken is said before something drifting', async () => {
  await clean();
  await Tasks.writeTask('morning-brief', { instruction: 'x', when: 'every day at 09:00', enabled: true });
  await Tasks.markRun('morning-brief', { at: daysAgo(9).toISOString() });
  await Memory.createProject('Old thing');
  const { raw } = await Memory.readProject('old-thing');
  await Memory.writeProject('old-thing', raw.replace(/last_touched: .*/, `last_touched: ${daysAgo(40).toISOString().slice(0, 10)}`));

  const said = await notice({ now: NOW });
  assert.equal(said.kind, 'task-missed', 'a task that stopped running comes first');
});

test('saying no makes it go away, and stay away', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 27th of August' });

  const said = await notice({ now: NOW });
  assert.ok(said);

  await dismiss(said.key, { at: NOW });
  assert.equal(await notice({ now: NOW }), null);

  // A week later it is still gone. Dismissing means dismissed, not snoozed
  // until tomorrow.
  const later = new Date(NOW.getTime() + 7 * 86_400_000);
  assert.equal(await notice({ now: later }), null);
});

// Dismissing one deadline must not silence the next one.
test('a different thing still gets through', async () => {
  await clean();
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 27th of August' });

  const first = await notice({ now: NOW });
  await dismiss(first.key, { at: NOW });

  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Chapter two due by the 29th of August' });
  const second = await notice({ now: NOW });
  assert.ok(second, 'the next deadline is a different notice');
  assert.notEqual(second.key, first.key);
});

// A corrupt record must not stop Reflect starting. Losing it costs one repeated
// notice, which is nothing.
test('an unreadable dismissal file is survivable', async () => {
  await clean();
  await FileStore.writeText('notices.json', '{ this is not json');
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Deadline is the 27th of August' });
  assert.equal((await notice({ now: NOW }))?.kind, 'due');
});

test('dates people actually write are read, and guesses are not', () => {
  assert.equal(findDate('deadline the 14th of November', NOW)?.getMonth(), 10);
  assert.equal(findDate('due November 14th', NOW)?.getDate(), 14);
  assert.equal(findDate('submit by 2026-09-01', NOW)?.getMonth(), 8);
  assert.equal(findDate('due next Friday', NOW), null, 'ambiguous is not parsed');
  assert.equal(findDate('chapter 12 needs work', NOW), null);
});
