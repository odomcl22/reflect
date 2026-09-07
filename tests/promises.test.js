/**
 * Remembering forward.
 *
 * The feature is only as good as its restraint. A promise detector that fires
 * on "I'll be honest" turns the morning page into noise, and a page people stop
 * reading is worse than no page — so the negative cases here matter more than
 * the positive ones, and there are deliberately more of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-promises-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { findPromise, whenFrom, record, due, open, settle } = await import('../src/reflect/Promises.js');

await FileStore.scaffold();

// A Sunday, so every weekday resolves forward and none of them is ambiguous.
const SUNDAY = new Date('2026-09-06T10:00:00');

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('a promise with a date is caught, in the words it was said in', () => {
  const found = findPromise("I'll call mom tomorrow", SUNDAY);
  assert.equal(found.what, "I'll call mom tomorrow");
  assert.equal(found.due, '2026-09-07');
});

test('the ways people say when', () => {
  const cases = [
    ['tonight', '2026-09-06'],
    ['tomorrow', '2026-09-07'],
    ['on Friday', '2026-09-11'],
    ['this week', '2026-09-11'],
    ['this weekend', '2026-09-12'],
    ['on the 14th of November', '2026-11-14'],
  ];
  for (const [phrase, expected] of cases) {
    const found = findPromise(`I need to ring the bank ${phrase}`, SUNDAY);
    assert.ok(found, `${phrase} was not understood`);
    assert.equal(found.due, expected, `${phrase} resolved wrong`);
  }
});

// Every one of these begins like a commitment. None of them is one.
test('turns of phrase are not promises', () => {
  const notPromises = [
    "I'll be honest, Tuesday was rough",
    "I'll think about it",
    "I'll take a look",
    "I might call her tomorrow",
    "I should probably do that tomorrow",
    'We met on the 3rd of March',
    'The essay is due Friday',
    "I'll never do that again",
    'I want to get back to that book idea',
  ];
  for (const line of notPromises) {
    assert.equal(findPromise(line, SUNDAY), null, `wrongly caught: ${line}`);
  }
});

// A promise without a date is a wish. Requiring one does most of the filtering
// without ever guessing at what somebody meant.
test('a commitment with no date is not recorded', () => {
  assert.equal(findPromise("I'll sort out the garage", SUNDAY), null);
});

test('"next Friday" is left alone, because it means two different days', () => {
  assert.equal(whenFrom('next Friday', SUNDAY), null);
});

test('one sentence in a paragraph is enough, and only that sentence is kept', () => {
  const found = findPromise(
    "The meeting went fine. I need to send Ali the figures tomorrow. Anyway, how are you?",
    SUNDAY,
  );
  assert.equal(found.what, 'I need to send Ali the figures tomorrow');
});

test('a promise is written down once, however often it is said', async () => {
  const first = await record({ text: "I'll book the MOT tomorrow", now: SUNDAY });
  const again = await record({ text: "I'll book the MOT tomorrow", now: SUNDAY });
  assert.equal(first.recorded, true);
  assert.equal(again.recorded, false);
  assert.equal((await open(SUNDAY)).length, 1);
});

test('nothing is owed before the day it is owed', async () => {
  await record({ text: "I'll email the landlord on Friday", now: SUNDAY });
  const today = await due(SUNDAY);
  assert.ok(!today.some((p) => /landlord/.test(p.what)), 'a Friday promise showed up on Sunday');

  const friday = new Date('2026-09-11T09:00:00');
  assert.ok((await due(friday)).some((p) => /landlord/.test(p.what)), 'it never arrived');
});

test('kept and dropped both close it, and the record of it survives', async () => {
  const made = await record({ text: "I'll ring the dentist tomorrow", now: SUNDAY });
  const monday = new Date('2026-09-07T09:00:00');
  assert.ok((await due(monday)).some((p) => p.id === made.promise.id));

  await settle(made.promise.id, 'kept');
  assert.ok(!(await due(monday)).some((p) => p.id === made.promise.id), 'still being asked about');

  // Append-only: keeping a promise must not erase having made it.
  const lines = await FileStore.readLines('promises.jsonl');
  assert.ok(lines.some((l) => l.id === made.promise.id && l.what), 'the promise itself was lost');
  assert.ok(lines.some((l) => l.id === made.promise.id && l.state === 'kept'), 'no record of keeping it');
});

test('an overdue promise stops asking after a week', async () => {
  const made = await record({ text: "I'll fix the gate tomorrow", now: SUNDAY });
  const soon = new Date('2026-09-10T09:00:00');
  assert.ok((await due(soon)).some((p) => p.id === made.promise.id), 'gone too early');

  const later = new Date('2026-09-30T09:00:00');
  assert.ok(!(await due(later)).some((p) => p.id === made.promise.id), 'still nagging weeks later');
});

test('settling something that does not exist fails quietly', async () => {
  const out = await settle('nope', 'kept');
  assert.equal(out.ok, false);
});

// Found by using it: a real chat turn is a promise with a conversation wrapped
// around it, and the comma before "anyway" is not a sentence boundary.
test('the chat around a promise is not part of the promise', () => {
  const found = findPromise(
    'Busy week. I need to renew the car insurance on Friday, anyway how are you?',
    SUNDAY,
  );
  assert.equal(found.what, 'I need to renew the car insurance on Friday');
});

test('a qualifier is part of the promise and stays', () => {
  const cases = [
    ['I need to call the bank tomorrow, but only after lunch', 'I need to call the bank tomorrow, but only after lunch'],
    ['I have to collect the kids tomorrow, and then take them to swimming', 'I have to collect the kids tomorrow, and then take them to swimming'],
  ];
  for (const [said, kept] of cases) {
    assert.equal(findPromise(said, SUNDAY).what, kept);
  }
});
