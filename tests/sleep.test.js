/**
 * Sleep: the second pass over memory.
 *
 * A model editing USER.md is the most dangerous write in the product, so most
 * of this file tests the refusals. The rails are the feature; the tidying is
 * almost incidental.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-sleep-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { paths } = await import('../src/core/Keys.js');
const { sleep, shouldSleep, acceptable, anchors, IDLE_MS } = await import('../src/reflect/Sleep.js');

await FileStore.scaffold();

const NOW = new Date('2026-09-06T14:00:00');

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

const MESSY = `# User

## Identity
- Name: Sam
- Lives in Portland

## Preferences
- Prefers short answers
- Likes answers kept short and to the point
- Prefers deeper reasoning from now on

## Working style
- Rides a Vespa GTS300
`;

const TIDY = `# User

## Identity
- Name: Sam
- Lives in Portland

## Preferences
- Likes answers kept short and to the point
- Prefers deeper reasoning from now on

## Working style
- Rides a Vespa GTS300
`;

async function reset(profile = MESSY) {
  await FileStore.writeText(paths().user, profile);
  await FileStore.writeText('sleep.json', '{}');
  await FileStore.removeAll('memory-history').catch(() => {});
}

const modelSaying = (text) => ({
  async complete() {
    return { content: text };
  },
});

// ------------------------------------------------------------------ timing

test('sleep waits until the person is away', async () => {
  await reset();
  const typing = await shouldSleep({ now: NOW, lastChatAt: NOW.getTime() - 60_000 });
  assert.equal(typing.should, false);

  const away = await shouldSleep({ now: NOW, lastChatAt: NOW.getTime() - IDLE_MS - 1 });
  assert.equal(away.should, true, 'ten quiet minutes is away, whatever the clock says');
});

test('sleep runs once per day, however long the night', async () => {
  await reset();
  await sleep({ runtime: modelSaying(TIDY), model: 'm', now: NOW });
  const again = await shouldSleep({ now: NOW, lastChatAt: 0 });
  assert.equal(again.should, false);

  const tomorrow = new Date('2026-09-07T09:00:00');
  assert.equal((await shouldSleep({ now: tomorrow, lastChatAt: 0 })).should, true);
});

// ------------------------------------------------------------------ tidying

test('a duplicate merges and the backup holds the original', async () => {
  await reset();
  const result = await sleep({ runtime: modelSaying(TIDY), model: 'm', now: NOW });
  assert.equal(result.changed, true);

  const after = await FileStore.readText(paths().user, '');
  assert.ok(!after.includes('Prefers short answers'), 'the duplicate went');
  assert.ok(after.includes('kept short and to the point'), 'into its survivor');

  // The version before it is on the shared timeline, not a private backup.
  const { versions, readVersion } = await import('../src/reflect/Versions.js');
  const kept = await versions();
  assert.equal(await readVersion(kept[0].id), MESSY, 'the original is one click away');
  assert.equal(kept[0].reason, 'tidied overnight');
});

test('a fenced answer is unwrapped rather than refused', async () => {
  await reset();
  const result = await sleep({ runtime: modelSaying('```markdown\n' + TIDY + '\n```'), model: 'm', now: NOW });
  assert.equal(result.changed, true);
});

// ------------------------------------------------------------------ refusals

test('losing a name refuses the whole pass', async () => {
  await reset();
  const lossy = TIDY.replace('- Rides a Vespa GTS300\n', '');
  const result = await sleep({ runtime: modelSaying(lossy), model: 'm', now: NOW });
  assert.equal(result.changed, false);
  assert.match(result.reason, /Vespa/);
  assert.equal(await FileStore.readText(paths().user, ''), MESSY, 'nothing moved');
});

test('losing a section refuses the whole pass', async () => {
  await reset();
  const lossy = TIDY.replace(/## Working style\n- Rides a Vespa GTS300\n/, '');
  const result = await sleep({ runtime: modelSaying(lossy), model: 'm', now: NOW });
  assert.equal(result.changed, false);
  assert.match(result.reason, /section/);
});

test('halving the file is deletion, not merging', async () => {
  const before = '# User\n\n## Notes\n' + Array.from({ length: 10 }, (_, i) => `- Fact number ${i}`).join('\n') + '\n';
  await reset(before);
  const gutted = '# User\n\n## Notes\n- Fact number 0\n- Fact number 1\n';
  const result = await sleep({ runtime: modelSaying(gutted), model: 'm', now: NOW });
  assert.equal(result.changed, false);
});

test('consolidation cannot add facts', async () => {
  await reset();
  const invented = TIDY.replace('## Working style', '## Working style\n- Also owns a boat\n- And a plane\n- Plus a helicopter\n- Even a submarine');
  const result = await sleep({ runtime: modelSaying(invented), model: 'm', now: NOW });
  assert.equal(result.changed, false, 'a tidying pass that grew the file invented something');
});

test('a model that errors changes nothing and does not throw', async () => {
  await reset();
  const broken = { async complete() { throw new Error('runtime went away'); } };
  const result = await sleep({ runtime: broken, model: 'm', now: NOW });
  assert.equal(result.ran, false);
  assert.equal(await FileStore.readText(paths().user, ''), MESSY);
});

test('a nearly empty profile is left alone', async () => {
  await reset('# User\n\n## Identity\n- Name: Sam\n');
  const result = await sleep({ runtime: modelSaying('anything'), model: 'm', now: NOW });
  assert.equal(result.ran, false);
  assert.match(result.reason, /not enough/);
});

// ------------------------------------------------------------------ helpers

test('anchors finds the substance and skips the scaffolding', () => {
  const found = anchors('- Prefers short answers\n- Rides a Vespa GTS300\n- Deadline 14 November');
  assert.ok(found.has('Vespa'));
  assert.ok(found.has('GTS300'));
  assert.ok(found.has('14'));
  assert.ok(!found.has('Prefers'), 'sentence-starters are not substance');
});

test('acceptable is a pure judgement, testable without a model', () => {
  assert.equal(acceptable(MESSY, TIDY).ok, true);
  assert.equal(acceptable(MESSY, MESSY).ok, true, 'no change is always safe');
});

// Seen live: the runner crashed mid-generation and handed back an empty string,
// and sleep marked the day done as "nothing needed tidying". Empty is a
// failure; identical is a clean bill. They must not share a verdict.
test('an empty reply is a failure, not a tidy file', async () => {
  await reset();
  const result = await sleep({ runtime: modelSaying(''), model: 'm', now: NOW });
  assert.equal(result.ran, false);
  assert.match(result.reason, /nothing/i);
  assert.equal((await shouldSleep({ now: NOW, lastChatAt: 0 })).should, false,
    'but the day is still marked, or a broken runner would be retried every minute');
});
