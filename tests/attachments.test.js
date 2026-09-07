/**
 * Attachments.
 *
 * Two promises meet here and pull in opposite directions.
 *
 * The first is that your memory is a folder of files you own — so an attached
 * photo has to be a photo on disk, openable in Preview, not base64 hidden in a
 * text file. That is why the storage port grew bytes.
 *
 * The second is that a prompt has a budget. A 400 KB log is a fine thing to
 * attach and a terrible thing to paste whole into a context window, so text is
 * excerpted — and the excerpt has to *say* it is one, because a model told it
 * has the whole file will answer as though it does.
 *
 * The rest is refusal: names that are paths, files too large to be a message,
 * and bytes that are not text being read as text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { useStorage, resetStorage } = await import('../src/core/Storage.js');
const { MemoryStorage } = await import('../src/adapters/storage/MemoryStorage.js');
useStorage(new MemoryStorage());

const FileStore = await import('../src/store/FileStore.js');
const A = await import('../src/attachments/Attachments.js');

await FileStore.scaffold();
test.after(() => resetStorage());

const bytes = (s) => new TextEncoder().encode(s);
const CONV = '2026-08-18-abc123';

// ─────────────────────────────────────────────────────────────── the file

test('a file goes in and comes back as the same bytes', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
  await A.saveAttachment(CONV, 'shot.png', png);

  const back = await A.readAttachment(CONV, 'shot.png');
  assert.deepEqual([...back], [...png], 'a photo must survive the round trip as a photo');
  // Including the NUL and the high byte, which is what a text round trip loses.
  assert.equal(back[8], 0);
  assert.equal(back[11], 255);
});

test('attachments are listed per conversation, not in one pool', async () => {
  await A.saveAttachment(CONV, 'notes.md', bytes('# Notes'));
  await A.saveAttachment('2026-08-18-other1', 'elsewhere.md', bytes('not mine'));

  const mine = (await A.listAttachments(CONV)).map((a) => a.name);
  assert.deepEqual(mine, ['notes.md', 'shot.png']);
  assert.ok(!mine.includes('elsewhere.md'), 'another conversation is another conversation');
});

test('what kind of thing it is, is decided by the name', async () => {
  assert.equal(A.describeAttachment('a.png', 1).kind, 'image');
  assert.equal(A.describeAttachment('a.md', 1).kind, 'text');
  assert.equal(A.describeAttachment('a.sqlite', 1).kind, 'file');
});

test('deleting a conversation takes its files', async () => {
  await A.removeAllFor('2026-08-18-other1');
  assert.deepEqual(await A.listAttachments('2026-08-18-other1'), [], 'orphans nobody can place');
});

// ───────────────────────────────────────────────────────────────── refusal

test('a name that is a path is not a name', async () => {
  for (const bad of ['../escape.md', 'a/b.md', '..', '/etc/hosts']) {
    await assert.rejects(() => A.saveAttachment(CONV, bad, bytes('x')), /Unsafe attachment name/, bad);
  }
  await assert.rejects(() => A.saveAttachment('../..', 'ok.md', bytes('x')), /Unsafe conversation id/);
});

test('a file too large to be a message is refused with its size', async () => {
  const huge = new Uint8Array(A.MAX_BYTES + 1);
  await assert.rejects(() => A.saveAttachment(CONV, 'huge.bin', huge), /the limit is/);
});

// ─────────────────────────────────────────────── what actually reaches the model

test('text arrives labelled with the file it came from', async () => {
  await A.saveAttachment(CONV, 'recipe.md', bytes('Dose: 18g\nMilk: 60ml'));
  const out = await A.materialise(CONV, ['recipe.md']);

  assert.match(out.text, /--- recipe\.md ---/, 'the model has to know which file it is reading');
  assert.match(out.text, /Dose: 18g/);
  assert.equal(out.images.length, 0);
  assert.equal(out.used[0].truncated, false);
});

test('a long file is excerpted, and says so', async () => {
  // Silently truncating is how a model ends up confidently answering about the
  // half of a file it was shown.
  await A.saveAttachment(CONV, 'big.log', bytes('x'.repeat(A.EXCERPT_CHARS + 5000)));
  const out = await A.materialise(CONV, ['big.log']);

  assert.ok(out.text.length < A.EXCERPT_CHARS + 500, 'the whole file reached the prompt');
  assert.match(out.text, /truncated: showing \d+ of \d+ characters of big\.log/);
  assert.equal(out.used[0].truncated, true);
});

test('several files share one budget rather than each getting the whole one', async () => {
  await A.saveAttachment(CONV, 'one.md', bytes('a'.repeat(A.EXCERPT_CHARS)));
  await A.saveAttachment(CONV, 'two.md', bytes('b'.repeat(A.EXCERPT_CHARS)));
  const out = await A.materialise(CONV, ['one.md', 'two.md']);
  assert.ok(
    out.text.length < A.EXCERPT_CHARS * 2,
    'attaching two files must not double the context they are supposed to fit in'
  );
});

test('an image becomes base64 for the adapter to place, not text', async () => {
  const out = await A.materialise(CONV, ['shot.png']);
  assert.equal(out.images.length, 1);
  assert.match(out.images[0], /^[A-Za-z0-9+/=]+$/);
  assert.ok(!out.text.includes('shot.png'), 'an image is not an excerpt');
});

test('a binary that is not an image is named, not decoded', async () => {
  // Reading a sqlite file as UTF-8 produces pages of replacement characters and
  // teaches the model nothing.
  await A.saveAttachment(CONV, 'db.sqlite', Uint8Array.from([1, 0, 2, 0, 3, 0, 4]));
  const out = await A.materialise(CONV, ['db.sqlite']);
  assert.match(out.text, /\[db\.sqlite — .*not a text file\]/);
  assert.equal(out.used.at(-1).kind, 'file');
});

test('a name that never existed is skipped, not fatal', async () => {
  const out = await A.materialise(CONV, ['ghost.md', '../escape.md', 'recipe.md']);
  assert.match(out.text, /recipe\.md/, 'the real one still arrives');
  assert.equal(out.used.length, 1);
});

// ─────────────────────────────────────────────────────────── the storage port

test('bytes survive the port as bytes, on both adapters', async () => {
  // MemoryStorage is the proof that the core runs with no filesystem, so it has
  // to hold the same contract NodeStorage does — including the NUL byte that a
  // string round trip would mangle.
  const raw = Uint8Array.from([0, 1, 250, 255, 0]);
  const { storage } = await import('../src/core/Storage.js');
  const store = await storage();
  await store.writeBytes('attachments/x/raw.bin', raw);
  assert.deepEqual([...(await store.readBytes('attachments/x/raw.bin'))], [...raw]);
  assert.equal(await store.readBytes('attachments/x/absent.bin'), null, 'missing is null, not a throw');
});
