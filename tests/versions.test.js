/**
 * Memory with a timeline.
 *
 * The properties that make a restore button safe to press: a version is a
 * byte-exact copy, nothing is recorded when nothing changed, and restoring is
 * itself undoable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-versions-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { paths } = await import('../src/core/Keys.js');
const { snapshot, versions, readVersion, restore } = await import('../src/reflect/Versions.js');
const { addFact, replaceFact } = await import('../src/store/MemoryFiles.js');

await FileStore.scaffold();

const A = '# User\n\n## Identity\n- Name: Sam\n- Lives in Portland\n';
const B = '# User\n\n## Identity\n- Name: Sam\n- Lives in Bristol\n- Wife: Priya\n';

const at = (n) => new Date(Date.parse('2026-09-06T10:00:00Z') + n * 60_000);

async function reset(content = A) {
  await FileStore.writeText(paths().user, content);
  await FileStore.removeAll('memory-history').catch(() => {});
}

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('a version is a byte-exact copy', async () => {
  await reset();
  const taken = await snapshot({ reason: 'first', now: at(0) });
  assert.equal(taken.taken, true);
  assert.equal(await readVersion(taken.id), A);
});

// The timeline should show the days memory moved, not one entry per time
// something happened to look at it.
test('nothing changed, nothing recorded', async () => {
  await reset();
  await snapshot({ reason: 'first', now: at(0) });
  const again = await snapshot({ reason: 'again', now: at(1) });
  assert.equal(again.taken, false);
  assert.equal((await versions()).length, 1);
});

test('the timeline reads newest first, with what caused each change', async () => {
  await reset();
  await snapshot({ reason: 'first', now: at(0) });
  await FileStore.writeText(paths().user, B);
  await snapshot({ reason: 'sleep tidied it', now: at(5) });

  const all = await versions();
  assert.equal(all.length, 2);
  assert.equal(all[0].reason, 'sleep tidied it');
  assert.equal(all[0].bullets, 3);
  assert.equal(all[1].bullets, 2, 'the count travels, so a shrink is visible on the timeline');
});

test('restoring puts the old file back', async () => {
  await reset();
  const first = await snapshot({ reason: 'first', now: at(0) });
  await FileStore.writeText(paths().user, B);

  const done = await restore(first.id, { now: at(5) });
  assert.equal(done.ok, true);
  assert.equal(await FileStore.readText(paths().user, ''), A);
});

// The one property that makes the button safe: pressing it by mistake is
// itself undoable.
test('restoring is undoable, because it takes a version first', async () => {
  await reset();
  const first = await snapshot({ reason: 'first', now: at(0) });
  await FileStore.writeText(paths().user, B);
  await restore(first.id, { now: at(5) });

  const all = await versions();
  const beforeRestore = all.find((v) => v.reason === 'before restoring');
  assert.ok(beforeRestore, 'the state being replaced was kept');
  assert.equal(await readVersion(beforeRestore.id), B);

  // And restoring appears on the timeline as a change like any other.
  assert.equal(all[0].reason, 'restored an earlier version');
  assert.equal(all[0].restoredFrom, first.id);
});

test('restoring a version that is no longer kept fails without damage', async () => {
  await reset();
  const done = await restore('2020-01-01T00-00-00', { now: at(0) });
  assert.equal(done.ok, false);
  assert.equal(await FileStore.readText(paths().user, ''), A, 'the present is untouched');
});

test('an empty profile has no timeline to speak of', async () => {
  await reset('');
  assert.equal((await snapshot({ now: at(0) })).taken, false);
});

// The timeline's stated purpose is that a bad extraction costs one click. That
// only holds if extraction is on the timeline at all — and for a while it was
// the one writer that wasn't, which is the writer the person did not perform
// and so the one they would most want back.
test('a fact Reflect recorded on its own can be walked back', async () => {
  await reset();
  await addFact({ section: 'Identity', text: 'Rides a Vespa GTS300' });

  const all = await versions();
  assert.equal(all.length, 1);
  assert.match(all[0].reason, /recorded a fact/);
  assert.equal(await readVersion(all[0].id), A, 'the version holds the file as it was before');

  await restore(all[0].id);
  assert.doesNotMatch(await FileStore.readText(paths().user, ''), /GTS300/);
});

// Extraction files several facts inside one second. Second-precision ids gave
// them all the same name: one file on disk, several rows in the index, and a
// version you could see but not get back.
test('facts written in the same second each get their own version', async () => {
  await reset();
  // Facts A does not already hold — a duplicate is correctly a no-op, and a
  // no-op must not leave a version behind.
  await addFact({ section: 'Identity', text: 'Rides a Vespa GTS300' });
  await addFact({ section: 'Identity', text: 'Works on a Mac Studio' });
  await replaceFact('Lives in Portland', 'Lives in Bristol', { section: 'Identity' });

  const all = await versions();
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((v) => v.id)).size, 3, 'ids collided');

  // Each one is genuinely retrievable, not just listed.
  for (const v of all) assert.ok((await readVersion(v.id)).includes('#'), `${v.id} is missing`);
});
