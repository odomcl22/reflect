/**
 * Your year, as a book.
 *
 * The journal, the projects and the profile composed into one document. The
 * tests are mostly about what a year looks like when it is thin, because a
 * bound copy of almost nothing should say so rather than pretend.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-yearbook-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const { yearbook, yearsAvailable } = await import('../src/documents/Yearbook.js');
const { markdownToPdf } = await import('../src/documents/Pdf.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

async function clean() {
  for (const dir of ['journal', 'projects']) await FileStore.removeAll(dir).catch(() => {});
  await FileStore.writeText('USER.md', '# User\n');
}

test('a year with nothing in it says so, rather than printing a cover', async () => {
  await clean();
  const book = await yearbook('2026');
  assert.equal(book.empty, true);
  assert.match(book.markdown, /Nothing was written down/);
});

test('the year is composed from the journal, month by month', async () => {
  await clean();
  await Memory.appendJournal('Stuck on chapter two', { date: new Date('2026-03-14T21:00:00') });
  await Memory.appendJournal('Finished it', { date: new Date('2026-07-02T09:30:00') });

  const book = await yearbook('2026');
  assert.equal(book.days, 2);
  assert.match(book.markdown, /## The year, month by month/);
  assert.match(book.markdown, /### March/);
  assert.match(book.markdown, /### July/);
  // The clock times are scaffolding a year later; the words are the point.
  assert.match(book.markdown, /- Stuck on chapter two/);
  assert.ok(!/21:00/.test(book.markdown));
});

test('months come out in order, not in the order they were written', async () => {
  await clean();
  await Memory.appendJournal('later', { date: new Date('2026-11-02T10:00:00') });
  await Memory.appendJournal('earlier', { date: new Date('2026-02-02T10:00:00') });
  const md = (await yearbook('2026')).markdown;
  assert.ok(md.indexOf('### February') < md.indexOf('### November'));
});

test('projects bring the decisions reached in them', async () => {
  await clean();
  await Memory.appendJournal('a day', { date: new Date('2026-05-05T10:00:00') });
  await Memory.createProject('Turtle book');
  await Memory.upsertProject({ slug: 'turtle-book', section: 'Decisions', text: 'Chapter 3 is the goldfish' });

  const md = (await yearbook('2026')).markdown;
  assert.match(md, /## What you were working on/);
  assert.match(md, /### Turtle book/);
  assert.match(md, /- Chapter 3 is the goldfish/);
});

// A project last touched in a different year is not this year's story.
test('a project from another year stays out of it', async () => {
  await clean();
  await Memory.appendJournal('a day', { date: new Date('2026-05-05T10:00:00') });
  await Memory.createProject('Old thing');
  const { raw } = await Memory.readProject('old-thing');
  await Memory.writeProject('old-thing', raw.replace(/last_touched: .*/, 'last_touched: 2024-01-01'));

  assert.ok(!(await yearbook('2026')).markdown.includes('Old thing'));
});

test('only years with something in them are offered', async () => {
  await clean();
  await Memory.appendJournal('a day', { date: new Date('2026-05-05T10:00:00') });
  await Memory.appendJournal('another', { date: new Date('2025-05-05T10:00:00') });
  assert.deepEqual(await yearsAvailable(), ['2026', '2025'], 'newest first');
});

test('the composed year renders to a real PDF', async () => {
  await clean();
  for (const d of ['2026-01-04', '2026-06-11', '2026-06-12', '2026-12-20']) {
    await Memory.appendJournal(`Something on ${d}`, { date: new Date(`${d}T10:00:00`) });
  }
  const bytes = markdownToPdf((await yearbook('2026')).markdown);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(bytes.toString('latin1'), /%%EOF\s*$/);
});
