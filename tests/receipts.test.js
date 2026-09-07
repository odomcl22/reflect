/**
 * Receipts: where each memory came from.
 *
 * The log is append-only and matching is best-effort by design. The tests are
 * about the two properties that make a citation trustworthy: the newest
 * sighting wins, and an edited fact stops citing rather than mis-citing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-receipts-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { record, sources, normalize } = await import('../src/reflect/Receipts.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('a write is witnessed with its conversation', async () => {
  await FileStore.writeText('memory-sources.jsonl', '');
  await record({ text: 'Wife: Priya', target: 'USER.md', conversationId: 'conv-1', at: '2026-09-01T10:00:00Z' });

  const all = await sources();
  assert.equal(all.length, 1);
  assert.equal(all[0].conversationId, 'conv-1');
});

// The same fact said again in a later conversation moves the receipt: the
// newest sighting is the conversation worth opening.
test('the newest sighting of a fact wins', async () => {
  await FileStore.writeText('memory-sources.jsonl', '');
  await record({ text: 'Rides a Vespa GTS300', target: 'USER.md', conversationId: 'old' });
  await record({ text: 'Rides a Vespa GTS300.', target: 'USER.md', conversationId: 'new' });

  const all = await sources();
  assert.equal(all.length, 1, 'punctuation is not identity');
  assert.equal(all[0].conversationId, 'new');
});

test('a receipt without a conversation is not a receipt', async () => {
  await FileStore.writeText('memory-sources.jsonl', '');
  assert.equal(await record({ text: 'orphan fact', target: 'USER.md', conversationId: '' }), false);
  assert.equal((await sources()).length, 0);
});

test('one corrupt line does not cost the log', async () => {
  await FileStore.writeText('memory-sources.jsonl', '{not json\n');
  await record({ text: 'survives', target: 'USER.md', conversationId: 'c' });
  const all = await sources();
  assert.equal(all.length, 1);
  assert.equal(all[0].text, 'survives');
});

test('normalize treats case, spacing and full stops as noise', () => {
  assert.equal(normalize('  Wife:  Priya. '), normalize('wife: priya'));
  assert.notEqual(normalize('Wife: Priya'), normalize('Wife: Priyo'), 'but not letters');
});
