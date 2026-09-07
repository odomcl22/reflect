/**
 * Supersession: replacing one fact with another, without losing either.
 *
 * This exists because the first implementation was forget-then-add, which is
 * not a replacement. Deletion happened unconditionally; the add that followed
 * was allowed to decline; and when it declined the fact was gone. Worse, the
 * call returned `removed: 1`, so the loss was shaped exactly like a success.
 *
 * These are the three ways it lost a memory, and the two ways it must still
 * work. The end-to-end sweep could not catch this: whether the extractor emits
 * a colliding replacement depends on the model, so the bug appeared as an
 * occasional unexplained failure somewhere else entirely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-supersede-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { paths } = await import('../src/core/Keys.js');
const { replaceFact } = await import('../src/store/MemoryFiles.js');
const { applyExtraction, applyExplicit } = await import('../src/reflect/Reflector.js');

await FileStore.scaffold();

const profile = () => FileStore.readText(paths().user, '');
const bullets = async () => ((await profile()).match(/^\s*-\s+.+$/gm) || []);
const set = (content) => FileStore.writeText(paths().user, content);

const TWO = '# User\n\n## Identity\n- Wife: Priya\n- Rides a Vespa GTS300\n';

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('an empty replacement removes nothing', async () => {
  await set(TWO);
  const r = await replaceFact('Priya', '   ', { section: 'Identity' });
  assert.equal(r.written, false);
  assert.equal(r.removed, 0);
  assert.match(await profile(), /Priya/);
  assert.equal((await bullets()).length, 2);
});

// The case that actually bit: the extractor superseded "Wife: Priya" with text
// that was already on file, so the insert declined and Priya was deleted.
test('a replacement already on file leaves the original alone', async () => {
  await set(TWO);
  const r = await replaceFact('Priya', 'Rides a Vespa GTS300', { section: 'Identity' });
  assert.equal(r.written, false);
  assert.equal(r.reason, 'already known');
  assert.match(await profile(), /Wife: Priya/);
  assert.equal((await bullets()).length, 2);
});

test('a needle matching two facts is refused, not guessed at', async () => {
  await set('# User\n\n## Identity\n- Wife: Priya\n- Priya is allergic to shellfish\n');
  const r = await replaceFact('Priya', 'Wife: Priya Shah', { section: 'Identity' });
  assert.equal(r.written, false);
  assert.match(r.reason, /matched 2 facts/);
  const kept = await bullets();
  assert.equal(kept.length, 2);
  assert.ok(kept.some((b) => /shellfish/.test(b)), 'the unrelated fact survived');
});

test('a genuine supersession replaces exactly one fact', async () => {
  await set('# User\n\n## Preferences\n- Prefers long, detailed replies\n- Wife: Priya\n');
  const r = await replaceFact('Prefers long, detailed replies', 'Prefers short, direct replies', {
    section: 'Preferences',
  });
  assert.equal(r.written, true);
  assert.equal(r.removed, 1);
  const doc = await profile();
  assert.match(doc, /Prefers short, direct replies/);
  assert.doesNotMatch(doc, /long, detailed/);
  assert.match(doc, /Wife: Priya/, 'the bystander fact is untouched');
});

test('superseding something not on file simply records it', async () => {
  await set(TWO);
  const r = await replaceFact('Drives a Volvo', 'Drives a Land Rover');
  assert.equal(r.written, true);
  assert.equal(r.removed, 0);
  assert.equal((await bullets()).length, 3);
});

// What the person is told about a write is part of the write. A refusal that
// reports itself as "recorded as new" is the same failure as the one above,
// moved one layer out: an outcome wearing the clothes of a better one.
test('a refused supersession is not reported as recorded', async () => {
  await set(TWO);
  const [write] = await applyExtraction({
    corrections: [{ replaces: 'Priya', text: 'Rides a Vespa GTS300', section: 'Identity' }],
    facts: [],
    projects: [],
    journal: [],
  });

  assert.equal(write.written, false);
  assert.equal(write.reason, 'already known');
  assert.doesNotMatch(write.reason, /recorded as new/);
  assert.match(await profile(), /Wife: Priya/);
});

test('a supersession that matched nothing still says so', async () => {
  await set(TWO);
  const [write] = await applyExtraction({
    corrections: [{ replaces: 'Drives a Volvo', text: 'Drives a Land Rover', section: 'Notes' }],
    facts: [],
    projects: [],
    journal: [],
  });

  assert.equal(write.written, true);
  assert.match(write.reason, /nothing matched/);
});

// "Forget Priya" can take the wife, the allergy and the birthday. Being told
// only that something went leaves the other two to be discovered by absence.
test('forgetting reports how many facts went', async () => {
  await set('# User\n\n## Identity\n- Wife: Priya\n- Priya is allergic to shellfish\n- Rides a Vespa GTS300\n');
  const write = await applyExplicit('forget Priya');
  assert.equal(write.action, 'forget');
  assert.equal(write.written, true);
  assert.equal(write.removed, 2);
  assert.equal((await bullets()).length, 1);
});
