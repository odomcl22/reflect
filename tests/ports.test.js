/**
 * The claim this file exists to prove: Reflect's memory engine does not need a
 * filesystem.
 *
 * Everything here runs on `MemoryStorage` — a Map — with no REFLECT_HOME, no
 * temp directory, and `node:fs` never touched. If the profile, projects,
 * journal, conversations, recall, and history all work under those conditions,
 * then the storage port is a real boundary and not decoration, and a build for a
 * platform with no filesystem has somewhere to plug in.
 *
 * If someone reaches around the port and calls `node:fs` directly, a test here
 * starts failing rather than the mobile build failing in six months.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Note what is *not* here: no mkdtemp, no REFLECT_HOME, no fs import.
const { useStorage, resetStorage, join, dirname, basename } = await import('../src/core/Storage.js');
const { MemoryStorage } = await import('../src/adapters/storage/MemoryStorage.js');

const store = new MemoryStorage();
useStorage(store);

const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const Conversations = await import('../src/store/ConversationStore.js');
const { searchHistory, timeline } = await import('../src/recall/History.js');
const { search } = await import('../src/recall/Keyword.js');

await FileStore.scaffold();

test.after(() => resetStorage());

// ──────────────────────────────────────────────────────────────── key helpers

test('keys are POSIX-ish strings, whatever the host platform', () => {
  assert.equal(join('projects', 'turtles.md'), 'projects/turtles.md');
  assert.equal(join('conversations/', '/a.jsonl'), 'conversations/a.jsonl');
  assert.equal(join('', 'USER.md'), 'USER.md');
  assert.equal(dirname('projects/turtles.md'), 'projects');
  assert.equal(dirname('USER.md'), '');
  assert.equal(basename('journal/2026-08-13.md'), '2026-08-13.md');
});

// ─────────────────────────────────────────────────────── the engine, no disk

test('first run scaffolds into a Map', async () => {
  assert.ok(await FileStore.exists('USER.md'), 'the profile should exist after scaffold');
  assert.ok(await FileStore.exists('config.json'));
  assert.equal((await FileStore.scaffold()).kind, 'memory');
});

test('memory is written, read back, and superseded with no filesystem', async () => {
  await Memory.addFact({ section: 'Identity', text: 'Wife: Priya' });
  assert.match(await Memory.readProfile(), /Wife: Priya/);

  // Idempotence is a product rule, not a filesystem one.
  const again = await Memory.addFact({ section: 'Identity', text: 'Wife: Priya' });
  assert.equal(again.written, false, 'the same fact must not be stored twice');
});

test('projects and the journal work as keys, not directories', async () => {
  await Memory.upsertProject({
    name: 'Turtles Book',
    aliases: ['the book'],
    section: 'Decisions',
    text: 'Darker and more adult',
  });
  await Memory.appendJournal('Talked about the book again');

  const projects = await Memory.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].slug, 'turtles-book');
  assert.ok(await FileStore.exists('projects/turtles-book.md'));
  assert.ok((await Memory.readJournal(7)).some((d) => /book/.test(d.body)));
});

test('recall ranks over a Map exactly as it does over files', async () => {
  const hits = search('I want to work on that book idea again', await Memory.collectChunks());
  assert.ok(hits.length, 'oblique project reference found nothing');
  assert.equal(hits[0].source, 'projects/turtles-book.md');
});

test('conversations append, persist, and read back', async () => {
  const id = Conversations.newId();
  await Conversations.ensure(id, { mode: 'companion' });
  await Conversations.append(id, { role: 'user', content: 'Is the Vespa GTS300 comfortable?' });
  await Conversations.append(id, { role: 'assistant', content: 'For distance, yes.' });

  const turns = await Conversations.turns(id);
  assert.equal(turns.length, 2);
  assert.match(turns[0].content, /Vespa/);
  assert.ok((await Conversations.list()).some((c) => c.id === id));
});

test('history search and the timeline work with no directory to read', async () => {
  const { results } = await searchHistory('vespa');
  assert.ok(results.length, 'history search found nothing in the Map');
  assert.match(results[0].snippet, /Vespa/i);

  const months = await timeline();
  assert.ok(months.length >= 1);
  assert.ok(months[0].conversations.length >= 1);
});

// ──────────────────────────────────────────────────────── the boundary itself

test('nothing above the port went to disk', () => {
  // The real assertion of this file: every byte Reflect wrote is in the Map.
  assert.ok(store.files.size > 0, 'the engine wrote nothing at all, which means this proves nothing');
  assert.ok(store.files.has('USER.md'));
  assert.ok(store.files.has('projects/turtles-book.md'));
  assert.ok([...store.files.keys()].some((k) => k.startsWith('conversations/')));

  // And every key is relative: an absolute path here would mean some module
  // still believes it is writing to a filesystem.
  for (const key of store.files.keys()) {
    assert.doesNotMatch(key, /^([A-Za-z]:)?[/\\]/, `"${key}" is a path, not a key`);
  }
});

test('the port refuses to be escaped', async () => {
  const { NodeStorage } = await import('../src/adapters/storage/NodeStorage.js');
  const node = new NodeStorage({ root: '/tmp/reflect-nonexistent-root' });
  await assert.rejects(() => node.read('../../etc/passwd'), /outside the memory folder/);
  await assert.rejects(() => node.write('../escape.md', 'no'), /outside the memory folder/);
});

test('list() returns folders as well as files, like readdir', async () => {
  // The bug this exists for: skills live at skills/<name>/SKILL.md, and an
  // adapter that lists only leaves reports an empty skills folder while the
  // filesystem adapter reports two. Two adapters, one contract, or the Map is
  // a comforting lie rather than a proof.
  await store.write('things/alpha/SKILL.md', 'a');
  await store.write('things/beta/SKILL.md', 'b');
  await store.write('things/loose.md', 'c');

  assert.deepEqual(await store.list('things'), ['alpha', 'beta', 'loose.md']);
  assert.deepEqual(await store.list('things', '.md'), ['loose.md'], 'an ext filter excludes folders');
});
