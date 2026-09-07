/**
 * Tasks.
 *
 * A task is one saved instruction plus an optional clock, and running one is an
 * ordinary turn through the same endpoint a person types into. Almost all the
 * risk is in the clock, so that is where the tests are:
 *
 *   - a slot fires once, not once per tick;
 *   - a missed slot still fires when the machine wakes, rather than being
 *     skipped until next week;
 *   - a schedule nobody can parse degrades to manual instead of throwing, or
 *     firing constantly.
 *
 * The other thing under test is the boundary: a task holds an instruction, not
 * a plan. There is no step list here and there should never be one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { useStorage, resetStorage } = await import('../src/core/Storage.js');
const { MemoryStorage } = await import('../src/adapters/storage/MemoryStorage.js');
useStorage(new MemoryStorage());

const FileStore = await import('../src/store/FileStore.js');
const Tasks = await import('../src/tasks/Tasks.js');

await FileStore.scaffold();
test.after(() => resetStorage());

/** A Monday at 10:00 local time, so weekday maths is readable. */
const monday = (h = 10, m = 0) => new Date(2026, 7, 17, h, m, 0, 0);

// ────────────────────────────────────────────────────── reading a schedule

test('schedules are written the way a person would say them', () => {
  assert.equal(Tasks.parseWhen('every hour').kind, 'hourly');
  assert.equal(Tasks.parseWhen('every day at 09:00').kind, 'daily');
  assert.equal(Tasks.parseWhen('every day at 09:00').hour, 9);
  assert.equal(Tasks.parseWhen('every monday at 07:30').kind, 'weekly');
  assert.equal(Tasks.parseWhen('every monday at 07:30').weekday, 1);
  assert.equal(Tasks.parseWhen('every monday at 07:30').minute, 30);
});

test('a schedule says itself back in plain words', () => {
  assert.equal(Tasks.parseWhen('every friday at 17:00').text, 'every friday at 17:00');
  assert.equal(Tasks.parseWhen('daily').text, 'every day at 09:00');
  assert.equal(Tasks.parseWhen('').text, 'when you ask');
});

test('an unreadable schedule becomes manual and says so', () => {
  // Never throw and never guess: a task with a schedule nobody can read is
  // still a task you can run by hand, and the text admits the problem.
  const odd = Tasks.parseWhen('on the third tuesday unless it rains');
  assert.equal(odd.kind, 'manual');
  assert.match(odd.text, /could not read/);
});

// ────────────────────────────────────────────────────────── when it is due

const daily = (extra = {}) => ({
  name: 'x',
  when: 'every day at 09:00',
  enabled: true,
  // Created a week before the scenarios below, so "never run" does not mean
  // "never existed" — a new task waits for its first real slot instead.
  createdAt: new Date(2026, 7, 10, 12, 0).toISOString(),
  ...extra,
});

test('a daily task fires after its time, once', () => {
  // Ran yesterday, so today's slot is the only one outstanding. (A task that
  // has never run is a different case — yesterday's slot passed unrun, so it
  // is genuinely due; that is the missed-slot rule, tested below.)
  const ranYesterday = daily({ lastRun: new Date(2026, 7, 16, 9, 2).toISOString() });
  assert.equal(Tasks.isDue(ranYesterday, monday(8, 59)), false, 'not before nine');
  assert.equal(Tasks.isDue(ranYesterday, monday(9, 1)), true, 'due just after nine');

  const justRan = daily({ lastRun: monday(9, 1).toISOString() });
  assert.equal(Tasks.isDue(justRan, monday(9, 2)), false, 'a slot fires once, not every minute');
  assert.equal(Tasks.isDue(justRan, monday(23, 59)), false, 'still the same slot');
});

test('tomorrow is a new slot', () => {
  const ranYesterday = daily({ lastRun: new Date(2026, 7, 16, 9, 5).toISOString() });
  assert.equal(Tasks.isDue(ranYesterday, monday(9, 5)), true);
});

test('a task created after today\'s slot waits for tomorrow', () => {
  // Written at 08:59 for "every day at 09:00": it must not fire immediately
  // for a slot that passed before it existed.
  const fresh = { name: 'x', when: 'every day at 09:00', enabled: true, createdAt: monday(8, 59).toISOString() };
  assert.equal(Tasks.isDue(fresh, monday(8, 59)), false);
  assert.equal(Tasks.isDue(fresh, monday(9, 1)), true, 'and then it fires at nine');
});

test('a slot missed while the machine slept still runs', () => {
  // The alternative — counting intervals from the last run — silently skips a
  // day whenever the laptop is closed at nine, which is most days.
  const ranFriday = daily({ lastRun: new Date(2026, 7, 14, 9, 0).toISOString() });
  assert.equal(Tasks.isDue(ranFriday, monday(14, 0)), true, 'the nine oclock slot has passed and was not run');
});

test('a weekly task waits for its day', () => {
  const weekly = { name: 'w', when: 'every monday at 09:00', enabled: true };
  assert.equal(Tasks.isDue(weekly, monday(9, 30)), true);
  assert.equal(Tasks.isDue(weekly, new Date(2026, 7, 19, 9, 30)), true, 'wednesday: monday was missed');

  const ranMonday = { ...weekly, lastRun: monday(9, 5).toISOString() };
  assert.equal(Tasks.isDue(ranMonday, new Date(2026, 7, 19, 9, 30)), false, 'already ran this week');
  assert.equal(Tasks.isDue(ranMonday, new Date(2026, 7, 24, 9, 30)), true, 'next monday is a new slot');
});

test('an hourly task fires once per hour', () => {
  const hourly = { name: 'h', when: 'every hour', enabled: true };
  assert.equal(Tasks.isDue(hourly, monday(10, 0)), true);
  const ran = { ...hourly, lastRun: monday(10, 1).toISOString() };
  assert.equal(Tasks.isDue(ran, monday(10, 59)), false);
  assert.equal(Tasks.isDue(ran, monday(11, 0)), true);
});

test('manual and disabled tasks never fire on their own', () => {
  assert.equal(Tasks.isDue({ name: 'm', when: 'manual', enabled: true }, monday(9, 30)), false);
  assert.equal(Tasks.isDue(daily({ enabled: false }), monday(9, 30)), false, 'off is a real state');
});

// ──────────────────────────────────────────────────────────────── the file

test('a task is a file with the instruction as its body', async () => {
  await Tasks.writeTask('weekly-notes', {
    instruction: 'Summarise the notes I added to Desk last week.',
    when: 'every monday at 09:00',
  });

  const raw = await FileStore.readText('tasks/weekly-notes.md', '');
  assert.match(raw, /^---/, 'frontmatter for the settings');
  assert.match(raw, /when: every monday at 09:00/);
  assert.match(raw, /Summarise the notes/, 'and the instruction as prose, not a field');

  const task = await Tasks.readTask('weekly-notes');
  assert.equal(task.valid, true);
  assert.equal(task.schedule.kind, 'weekly');
  assert.equal(task.enabled, true);
});

test('a task with no instruction is not a task', async () => {
  await Tasks.writeTask('empty-one', { instruction: '', when: 'manual' });
  const task = await Tasks.readTask('empty-one');
  assert.equal(task.valid, false);
  assert.match(task.problems.join(' '), /no instruction/);
  await Tasks.removeTask('empty-one');
});

test('running is recorded on the task itself', async () => {
  await Tasks.markRun('weekly-notes', { conversationId: '2026-08-17-abc123' });
  const task = await Tasks.readTask('weekly-notes');
  assert.ok(task.lastRun, 'so the next slot can be compared against it');
  assert.equal(task.lastConversation, '2026-08-17-abc123', 'and the output is findable');

  // A run must not disturb the instruction or the schedule.
  assert.match(task.instruction, /Summarise the notes/);
  assert.equal(task.when, 'every monday at 09:00');
});

test('dueTasks only returns what is actually due', async () => {
  await Tasks.writeTask('hourly-one', { instruction: 'Check the thing.', when: 'every hour' });
  await Tasks.writeTask('manual-one', { instruction: 'Only when asked.', when: 'manual' });

  const due = (await Tasks.dueTasks()).map((t) => t.name);
  assert.ok(!due.includes('manual-one'), 'manual tasks are never due');
  assert.ok(!due.includes('weekly-notes'), 'it ran a moment ago');

  await Tasks.removeTask('hourly-one');
  await Tasks.removeTask('manual-one');
});

test('unsafe names cannot be written or removed', async () => {
  await assert.rejects(() => Tasks.writeTask('../escape', { instruction: 'x' }), /Unsafe task name/);
  await assert.rejects(() => Tasks.removeTask('../escape'), /Unsafe task name/);
});

// ───────────────────────────────────────────────────────────── the boundary

test('a task is an instruction, not a plan', async () => {
  const raw = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/tasks/Tasks.js', import.meta.url), 'utf8')
  );
  // Read the code, not the prose: the comment above explains why steps and
  // dependencies are forbidden, and naming them there must not fail the test
  // that forbids them.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  // If any of these appear, Reflect has started growing an execution model and
  // the line against ReflectForge has moved without anyone deciding to move it.
  for (const word of ['steps', 'dependsOn', 'subtask', 'workGraph', 'retries']) {
    assert.doesNotMatch(source, new RegExp(`\\b${word}\\b`), `a task gained "${word}" — that belongs in Forge`);
  }
});

test('running a task goes through the ordinary chat endpoint', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/tasks/Scheduler.js', import.meta.url), 'utf8')
  );
  assert.match(source, /\/api\/chat/, 'a second execution path is how the two drift apart');
  assert.doesNotMatch(source, /createChatHandler|runTool\(/, 'the scheduler must not reimplement a turn');
});

// ------------------------------------------------------------------ monthly
//
// "See all the daily, weekly, and monthly tasks in one place" needs monthly to
// exist. It is read before daily because "every month on the 1st" contains no
// word daily matches, but does contain a date nothing else wants.

test('a monthly schedule reads back in English', () => {
  assert.equal(Tasks.parseWhen('monthly').kind, 'monthly');
  assert.equal(Tasks.parseWhen('every month on the 15th').text, 'every month on the 15th at 09:00');
  assert.equal(Tasks.parseWhen('every month on the 1st at 08:00').text, 'every month on the 1st at 08:00');
});

// Capped rather than refused, and the text says which date it settled on, so a
// task set for the 31st does not silently skip February.
test('a date no month always has is pulled back to one that exists', () => {
  const when = Tasks.parseWhen('on the 31st of every month');
  assert.equal(when.day, 28);
  assert.match(when.text, /28th/);
});

test('a sentence that merely mentions a month is not a monthly schedule', () => {
  assert.equal(Tasks.parseWhen('sometime next month if I remember').kind, 'manual');
});

test('a monthly task runs once for its slot, not once per check', () => {
  const task = (lastRun, createdAt) => ({ enabled: true, when: 'every month on the 1st at 09:00', lastRun, createdAt });
  const now = new Date('2026-08-05T10:00:00');
  assert.equal(Tasks.isDue(task(null, '2026-07-20T00:00:00'), now), true, 'slot passed, never run');
  assert.equal(Tasks.isDue(task('2026-08-01T09:30:00', '2026-07-01T00:00:00'), now), false, 'already ran this month');
  assert.equal(Tasks.isDue(task('2026-07-01T09:30:00', '2026-06-01T00:00:00'), now), true, 'ran last month');
});

// Same rule the other cadences follow: a task written today for a slot earlier
// today belongs to next month, not to a slot that passed before it existed.
test('a monthly task created after this month\u2019s slot waits', () => {
  const now = new Date('2026-08-05T10:00:00');
  const task = { enabled: true, when: 'every month on the 1st at 09:00', lastRun: null, createdAt: '2026-08-03T00:00:00' };
  assert.equal(Tasks.isDue(task, now), false);
});

// ------------------------------------------------------------------ nextRun
//
// isDue answers "now?", which is all the scheduler needs. The Tasks screen asks
// what is coming up, and listing schedules makes the reader do the arithmetic.

test('the next slot is reported for every cadence', () => {
  const now = new Date('2026-08-22T14:30:00'); // a Saturday
  const at = (when) => Tasks.nextRun({ enabled: true, when }, now);
  assert.equal(at('every hour').getHours(), 15);
  assert.equal(at('every day at 18:00').getDate(), 22, 'later today');
  assert.equal(at('every day at 09:00').getDate(), 23, 'already passed, so tomorrow');
  assert.equal(at('every tuesday at 10:00').getDay(), 2);
  assert.equal(at('every month on the 28th at 08:00').getDate(), 28);
  assert.equal(at('every month on the 1st at 08:00').getMonth(), 8, 'the 1st has passed, so September');
});

test('nothing is scheduled for a manual or paused task', () => {
  const now = new Date('2026-08-22T14:30:00');
  assert.equal(Tasks.nextRun({ enabled: true, when: 'manual' }, now), null);
  assert.equal(Tasks.nextRun({ enabled: false, when: 'every hour' }, now), null);
});

// The clock only runs while Reflect is open, so a task can be overdue and still
// have a next slot tomorrow. Reporting the slot is honest; a countdown to
// something that only fires if the app happens to be running is not.
test('the next slot ignores whether the last one was missed', () => {
  const now = new Date('2026-08-22T14:30:00');
  const missed = { enabled: true, when: 'every day at 09:00', lastRun: '2026-08-01T09:00:00' };
  assert.equal(Tasks.nextRun(missed, now).getDate(), 23);
  assert.equal(Tasks.isDue(missed, now), true, 'overdue and next-slotted at the same time');
});

// ------------------------------------------------------------------ weekdays
//
// Found by asking for one out loud. A model handed "every weekday at 08:00" to
// a parser that had no weekday cadence, so the task saved as manual — and then
// told the user it would run every weekday at 8. Someone waits for a morning
// brief that never comes, and nothing anywhere says why.

test('a weekday schedule is read, in the several ways people write it', () => {
  for (const said of ['every weekday at 08:00', 'every weekday morning at 8:00',
                      'monday to friday at 08:00', 'mon-fri at 08:00', 'every working day at 08:00']) {
    const when = Tasks.parseWhen(said);
    assert.equal(when.kind, 'weekdays', `${said} should be a weekday schedule`);
    assert.equal(when.hour, 8);
  }
});

// "monday to friday" names its own recurrence without using the word every, so
// it is matched specially rather than by loosening the guard that keeps this
// from becoming a weekly task.
test('a sentence that merely mentions a weekday is still not a schedule', () => {
  assert.equal(Tasks.parseWhen('on the third tuesday unless it rains').kind, 'manual');
  assert.equal(Tasks.parseWhen('next tuesday').kind, 'manual');
});

test('a weekday task skips the weekend at both ends', () => {
  const sat = new Date('2026-08-22T14:00:00'); // Saturday
  const sun = new Date('2026-08-23T14:00:00');
  const task = { enabled: true, when: 'every weekday at 08:00' };
  assert.equal(Tasks.nextRun(task, sat).getDay(), 1, 'Saturday looks forward to Monday');
  assert.equal(Tasks.nextRun(task, sun).getDay(), 1, 'so does Sunday');

  // And it is due once for Friday's slot over the weekend, not once per day.
  const ranFriday = { ...task, lastRun: '2026-08-21T08:05:00', createdAt: '2026-08-01T00:00:00' };
  assert.equal(Tasks.isDue(ranFriday, sat), false, 'Friday already ran');
  assert.equal(Tasks.isDue(ranFriday, sun), false, 'and does not run again on Sunday');
});
