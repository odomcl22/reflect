/**
 * M6 — import, history search, and the timeline.
 *
 * The fixtures here are hand-built to match the shapes a real ChatGPT export
 * actually contains: branched regenerations, hidden system messages, multimodal
 * parts, and conversations with nothing in them. Every one of those broke a
 * naive importer at some point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-m6-'));
process.env.REFLECT_HOME = tmpHome;

const { paths } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
const Conversations = await import('../src/store/ConversationStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const { importExport, linearize, textOf, idFor, readExport } = await import('../src/import/ChatGPT.js');
const { searchHistory, timeline } = await import('../src/recall/History.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

const ts = (iso) => new Date(iso).getTime() / 1000;

/** A node as ChatGPT writes them. */
const node = (id, role, text, parent, extra = {}) => ({
  id,
  parent,
  children: [],
  message: {
    id,
    author: { role },
    create_time: ts('2024-03-01T10:00:00Z'),
    content: { content_type: 'text', parts: [text] },
    metadata: {},
    ...extra,
  },
});

function exportFixture() {
  return [
    {
      title: 'Motorcycle shopping',
      conversation_id: 'aaaa-1111-bbbb-2222',
      create_time: ts('2024-03-01T10:00:00Z'),
      current_node: 'n4',
      mapping: {
        root: { id: 'root', parent: null, children: ['n0'], message: null },
        n0: {
          ...node('n0', 'system', 'You are ChatGPT.', 'root'),
        },
        n1: node('n1', 'user', 'I am looking at a Vespa GTS300.', 'n0'),
        // A discarded regeneration: same parent as n3, not on the kept branch.
        n2: node('n2', 'assistant', 'DISCARDED first draft.', 'n1'),
        n3: node('n3', 'assistant', 'Good choice — comfortable for distance.', 'n1'),
        n4: node('n4', 'user', 'What about insurance?', 'n3'),
      },
    },
    {
      title: 'Hidden and multimodal',
      conversation_id: 'cccc-3333',
      create_time: ts('2024-05-15T09:00:00Z'),
      current_node: 'm3',
      mapping: {
        m0: node('m0', 'user', 'Custom instruction blob', null, {
          metadata: { is_user_system_message: true },
        }),
        m1: node('m1', 'user', 'Look at this photo', 'm0'),
        m2: {
          ...node('m2', 'assistant', '', 'm1'),
          message: {
            id: 'm2',
            author: { role: 'assistant' },
            create_time: ts('2024-05-15T09:01:00Z'),
            content: {
              content_type: 'multimodal_text',
              parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-x' }, 'That is a red bike.'],
            },
            metadata: {},
          },
        },
        m3: node('m3', 'tool', 'internal tool output', 'm2'),
      },
    },
    {
      title: 'Empty one',
      conversation_id: 'dddd-4444',
      create_time: ts('2024-06-01T09:00:00Z'),
      current_node: 'z0',
      mapping: { z0: node('z0', 'system', 'nothing here', null) },
    },
  ];
}

async function writeFixture(name = 'conversations.json') {
  const file = path.join(tmpHome, name);
  await fsp.writeFile(file, JSON.stringify(exportFixture()), 'utf8');
  return file;
}

// ───────────────────────────────────────────────────────────────── parsing

test('text is pulled from plain and multimodal parts, ignoring attachments', () => {
  assert.equal(textOf({ content: { parts: ['hello', 'world'] } }), 'hello\nworld');
  assert.equal(
    textOf({ content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'x' }, 'caption'] } }),
    'caption'
  );
  assert.equal(textOf({ content: { parts: [] } }), '');
  assert.equal(textOf(null), '');
});

test('linearizing follows the kept branch, not every discarded draft', () => {
  const [conversation] = exportFixture();
  const turns = linearize(conversation);

  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.match(turns[1].content, /Good choice/);
  assert.ok(!turns.some((t) => /DISCARDED/.test(t.content)), 'a regenerated draft was imported');
  assert.ok(!turns.some((t) => /You are ChatGPT/.test(t.content)), 'the system preamble was imported');
});

test('hidden system messages and tool output are dropped', () => {
  const conversation = exportFixture()[1];
  const turns = linearize(conversation);
  assert.ok(!turns.some((t) => /Custom instruction/.test(t.content)), 'a custom-instruction blob leaked in');
  assert.ok(!turns.some((t) => /internal tool output/.test(t.content)), 'tool output leaked in');
  assert.ok(turns.some((t) => /red bike/.test(t.content)), 'the multimodal caption was lost');
});

test('a conversation with no usable turns yields none', () => {
  assert.deepEqual(linearize(exportFixture()[2]), []);
});

test('a malformed export without current_node still imports in time order', () => {
  const broken = { ...exportFixture()[0], current_node: 'does-not-exist' };
  const turns = linearize(broken);
  assert.ok(turns.length >= 3, 'a broken pointer should not mean importing nothing');
});

test('ids are stable, dated, and filesystem-safe', () => {
  const [conversation] = exportFixture();
  const id = idFor(conversation, 0);
  assert.equal(id, idFor(conversation, 0), 'ids must be stable across runs');
  assert.match(id, /^2024-03-01-gpt-[A-Za-z0-9]+$/);
  assert.doesNotMatch(id, /[/\\.]/);
});

// ─────────────────────────────────────────────────────────────── importing

test('an export becomes ordinary conversations', async () => {
  const file = await writeFixture();
  const summary = await importExport(file);

  assert.equal(summary.found, 3);
  assert.equal(summary.imported, 2, 'the empty conversation should be skipped');
  assert.equal(summary.empty, 1);

  // Imported history must be indistinguishable from a conversation had here.
  const list = await Conversations.list();
  const motorcycle = list.find((c) => c.title === 'Motorcycle shopping');
  assert.ok(motorcycle, 'the imported conversation is not listed');
  assert.equal(motorcycle.turnCount, 3);

  const turns = await Conversations.turns(motorcycle.id);
  assert.match(turns[0].content, /Vespa GTS300/);
  assert.equal(turns[0].imported, true, 'imported turns should be marked as such');
  assert.match(turns[0].at, /^2024-03-01/, 'the original timestamp should be preserved');
});

test('importing twice imports nothing the second time', async () => {
  const file = await writeFixture();
  const second = await importExport(file);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 2);
});

test('a dry run reports without writing', async () => {
  await FileStore.removeAll(paths().conversations);
  await FileStore.ensureDir(paths().conversations);

  const file = await writeFixture();
  const dry = await importExport(file, { dryRun: true });
  assert.equal(dry.imported, 2);
  assert.ok(dry.turns > 0);
  assert.deepEqual(await FileStore.listFiles(paths().conversations, '.jsonl'), []);

  await importExport(file);
});

test('a missing or wrong-shaped file fails with something a person can act on', async () => {
  await assert.rejects(() => readExport(path.join(tmpHome, 'nope.json')), /No such file/);

  const notAnExport = path.join(tmpHome, 'notes.txt');
  await fsp.writeFile(notAnExport, 'hello');
  await assert.rejects(() => readExport(notAnExport), /\.zip export or a conversations\.json/);
});

// ───────────────────────────────────────────────────── searching history

test('history search finds a turn and shows why it matched', async () => {
  const { results } = await searchHistory('insurance');
  assert.ok(results.length > 0, 'nothing found for a word that is definitely there');
  assert.match(results[0].snippet, /insurance/i);
  assert.equal(results[0].title, 'Motorcycle shopping');
  assert.ok(results[0].conversationId);
});

test('matching more of the query ranks higher', async () => {
  const { results } = await searchHistory('vespa insurance');
  assert.ok(results.length >= 2);
  assert.ok(results[0].score >= results[1].score);
});

test('history search returns nothing rather than guessing', async () => {
  const { results } = await searchHistory('chromodynamics');
  assert.deepEqual(results, []);
  assert.deepEqual((await searchHistory('')).results, []);
});

test('history search does not reach into memory files', async () => {
  const { readProfile, addFact } = await import('../src/store/MemoryFiles.js');
  await addFact({ section: 'Identity', text: 'Xyzzyplugh is a nonsense marker' });
  assert.match(await readProfile(), /Xyzzyplugh/);

  const { results } = await searchHistory('Xyzzyplugh');
  assert.deepEqual(results, [], 'history search must not surface memory — they are separate stores');
});

test('imported history stays out of ambient recall', async () => {
  // The whole point of keeping history separate: importing years of chat must
  // not flood the prompt with 2023 noise.
  const { collectChunks } = await import('../src/store/MemoryFiles.js');
  const chunks = await collectChunks();
  assert.ok(!chunks.some((c) => /Vespa GTS300|insurance/i.test(c.text) && /conversation/i.test(c.source)));
  assert.ok(chunks.every((c) => /^(USER\.md|projects\/|journal\/)/.test(c.source)), 'a conversation leaked into recall');
});

// ─────────────────────────────────────────────────────────────── timeline

test('the timeline groups conversations by month, newest first', async () => {
  const months = await timeline();
  assert.ok(months.length >= 2, `expected at least two months, got ${months.length}`);
  assert.ok(months[0].month >= months[1].month, 'months should be newest first');

  const march = months.find((m) => m.month === '2024-03');
  assert.ok(march, 'March 2024 missing from the timeline');
  assert.equal(march.conversations[0].title, 'Motorcycle shopping');
  assert.equal(march.conversations[0].imported, true);
  assert.equal(march.conversations[0].turnCount, 3);
});

test('a conversation with no title is labelled by its first message', async () => {
  const id = Conversations.newId();
  await Conversations.append(id, { role: 'user', content: 'Something I said with no title at all' });
  const months = await timeline();
  const found = months.flatMap((m) => m.conversations).find((c) => c.id === id);
  assert.ok(found);
  assert.match(found.title, /Something I said/);
});

// ────────────────────────────────────────────────────────────────── routes
// The app is built against this same temp home and listened on port 0, so the
// routes are exercised for real without owning the port or the user's files.

const { createApp } = await import('../src/app.js');
const { app } = await createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() };
};
const post = async (url, body) => {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test.after(() => new Promise((resolve) => server.close(resolve)));

/**
 * The route tests own their data.
 *
 * They used to lean on conversations imported by an earlier test, which worked
 * only because the reset helper was quietly deleting the wrong directory. Once
 * it started deleting the right one, these went red — correctly. Import is
 * idempotent by id, so seeding twice costs nothing.
 */
async function seedHistory() {
  await FileStore.ensureDir(paths().conversations);
  await importExport(await writeFixture('route-seed.json'));
}

test('GET /api/history/timeline returns the months', async () => {
  await seedHistory();
  const { status, body } = await get('/api/history/timeline');
  assert.equal(status, 200);
  assert.ok(body.timeline.some((m) => m.month === '2024-03'));
});

test('GET /api/history/search answers with snippets, and empties honestly', async () => {
  await seedHistory();
  const hit = await get('/api/history/search?q=insurance');
  assert.equal(hit.status, 200);
  assert.ok(hit.body.results.length > 0);
  assert.match(hit.body.results[0].snippet, /insurance/i);
  assert.ok(hit.body.scanned > 0);

  const miss = await get('/api/history/search?q=chromodynamics');
  assert.deepEqual(miss.body.results, []);
});

test('POST /api/history/import is idempotent, and says what it did', async () => {
  const file = await writeFixture('routed-export.json');

  const first = await post('/api/history/import', { file });
  assert.equal(first.status, 200);
  assert.ok(first.body.imported + first.body.skipped >= 2);

  const again = await post('/api/history/import', { file });
  assert.equal(again.body.imported, 0, 're-importing the same export must add nothing');
  assert.ok(again.body.skipped >= 2);
});

test('a bad import path is the user\'s problem to fix, not a 500', async () => {
  const missing = await post('/api/history/import', { file: path.join(tmpHome, 'not-here.json') });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /No such file/);

  const nothing = await post('/api/history/import', {});
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /Which file/);
});

test('the history routes never return memory', async () => {
  // Same contract as the module test, enforced at the edge the UI actually uses.
  const { body } = await get('/api/history/search?q=Xyzzyplugh');
  assert.deepEqual(body.results, []);
});

// ────────────────────────────────────────────────────── deleting on purpose

test('a conversation can be deleted, with the summary it produced', async () => {
  const Summaries = await import('../src/store/Summaries.js');
  const id = Conversations.newId();
  await Conversations.ensure(id, { mode: 'companion' });
  await Conversations.append(id, { role: 'user', content: 'something forgettable' });
  await Summaries.write(id, { text: '- they said something', covers: 1, throughTurnId: 't1' });

  assert.ok(await Summaries.has(id), 'the summary should exist before the delete');

  const gone = await Conversations.remove(id);
  assert.equal(gone, true);
  assert.equal((await Conversations.turns(id)).length, 0);
  assert.equal(await Summaries.has(id), false, 'a derived summary must not outlive its transcript');
  assert.equal((await Conversations.list()).some((c) => c.id === id), false);
});

test('deleting something that is not there is not an error, it is a false', async () => {
  assert.equal(await Conversations.remove('2020-01-01-nothing'), false);
});

test('DELETE /api/conversations/:id removes it, and 404s the second time', async () => {
  const id = Conversations.newId();
  await Conversations.ensure(id, { mode: 'companion' });
  await Conversations.append(id, { role: 'user', content: 'delete me' });

  const first = await fetch(`${base}/api/conversations/${id}`, { method: 'DELETE' });
  assert.equal(first.status, 200);

  const second = await fetch(`${base}/api/conversations/${id}`, { method: 'DELETE' });
  assert.equal(second.status, 404, 'deleting twice is a mistake worth reporting');
});

test('an unsafe id cannot escape the conversations folder', async () => {
  await assert.rejects(() => Conversations.remove('../../USER'), /Unsafe conversation id/);
});

// ──────────────────────────────────────────────── chats grouped into projects

test('a conversation can be filed under a project, and the newest filing wins', async () => {
  await Conversations.ensure('filed', { mode: 'companion' });
  await Conversations.append('filed', { role: 'user', content: 'about the boat' });

  assert.equal((await Conversations.meta('filed')).project, null, 'chats start unfiled');

  await Conversations.setProject('filed', 'hydrodynamics');
  assert.equal((await Conversations.meta('filed')).project, 'hydrodynamics');

  // Appended rather than rewritten, like the title: the transcript is the one
  // thing never edited in place, so "which project was this in" stays answerable.
  await Conversations.setProject('filed', 'boat-build');
  assert.equal((await Conversations.meta('filed')).project, 'boat-build');

  await Conversations.setProject('filed', null);
  assert.equal((await Conversations.meta('filed')).project, null, 'and it can come back out');
});

test('filing a chat that does not exist yet still gives it a proper header', async () => {
  // This is the ordinary case — it is how someone opens a new chat *inside* a
  // project. Appending straight to a missing file produced a transcript whose
  // first record was not the meta line; ensure() then skipped it because the
  // file existed, and the conversation had no createdAt or mode for the rest of
  // its life.
  await Conversations.setProject('brand-new', 'hydrodynamics');

  const meta = await Conversations.meta('brand-new');
  assert.ok(meta, 'a filed conversation must still have metadata');
  assert.equal(meta.project, 'hydrodynamics');
  assert.ok(meta.createdAt, 'including when it started');
  assert.equal(meta.mode, 'companion');
});

test('the conversation list carries the project, so the sidebar can group', async () => {
  const listed = await Conversations.list();
  const filed = listed.find((c) => c.id === 'brand-new');
  assert.equal(filed.project, 'hydrodynamics');
  assert.ok(listed.some((c) => c.project === null), 'unfiled chats are still listed');
});

// ------------------------------------------------------- projects by hand
//
// Every other project is born sideways: the Reflector notices you talking about
// a book and writes the file. That misses the case where you know exactly what
// you are starting and want somewhere to put it before the first chat exists.

test('a project can be started deliberately, and named twice without forking', async () => {
  const made = await Memory.createProject('Turtle book');
  assert.equal(made.slug, 'turtle-book');
  assert.equal(made.created, true);

  // The same project said differently resolves to the one that exists — the
  // rule the Reflector already follows, applied to the button too.
  const again = await Memory.createProject('turtle  BOOK');
  assert.equal(again.slug, 'turtle-book');
  assert.equal(again.created, false);

  const listed = await Memory.listProjects();
  assert.equal(listed.filter((p) => p.slug === 'turtle-book').length, 1);
});

// serializeFrontmatter takes the data and returns the block. It has no body
// parameter, and passing one is silently ignored — so the obvious spelling of
// rename deleted every note, decision and open question in the file while
// looking entirely correct.
test('renaming a project keeps everything written in it', async () => {
  await Memory.createProject('Turtles book');
  await Memory.upsertProject({ slug: 'turtles-book', section: 'Decisions', text: 'Laminar flow, not turbulence' });

  await Memory.renameProject('turtles-book', 'Turtles: a memoir');

  // readProject returns { slug, meta, body, raw } — the whole file is in `raw`.
  const after = await Memory.readProject('turtles-book');
  assert.match(after.body, /Laminar flow, not turbulence/, 'the notes survived the rename');
  assert.equal(after.meta.name, 'Turtles: a memoir');
  // The old name still resolves, so a sentence using it lands in the same file.
  assert.ok(after.meta.aliases.includes('Turtles book'), 'the previous name is kept as an alias');
});

test('deleting a project keeps the conversations filed under it', async () => {
  await Memory.createProject('Doomed');
  await Conversations.ensure('keeper', { mode: 'companion' });
  await Conversations.setProject('keeper', 'doomed');

  assert.equal(await Memory.removeProject('doomed'), true);
  assert.equal(await Memory.removeProject('doomed'), false, 'and says so if it was not there');

  // The chat still exists and still remembers where it was filed. Nothing that
  // was said disappears with the folder.
  assert.equal((await Conversations.meta('keeper'))?.project, 'doomed');
});
