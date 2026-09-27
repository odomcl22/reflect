/**
 * Running the person's own macOS Shortcuts.
 *
 * These tests never run a real shortcut. A shortcut does whatever its author
 * built it to do — the machine this was written on has one called "Text Last
 * Image" — so a test that ran one would be a test with side effects nobody
 * chose. The execution path is exercised with a name that is allowed but not
 * installed, which is also the real case of a shortcut deleted after it was
 * ticked: it goes all the way through execFile and comes back as a failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-shortcuts-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const S = await import('../src/desktop/Shortcuts.js');
const { toolsFor, runTool } = await import('../src/reflect/MemoryTools.js');
const { mayRunShortcuts } = await import('../src/tasks/Tasks.js');

await FileStore.scaffold();

const mac = S.available();
const names = (opts) => toolsFor(opts).map((t) => t.function.name);

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('nothing may be run until a person chooses', async () => {
  assert.deepEqual(await S.allowed(), []);
  const out = await S.runShortcut({ name: 'Anything' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /No shortcuts are allowed/);
});

// Absent rather than refused, the rule messaging follows: a model that cannot
// see the tool cannot be talked into calling it by a page it just read.
test('the tool does not exist until one is allowed', () => {
  assert.ok(!names({}).includes('run_shortcut'));
  if (mac) assert.ok(names({ shortcuts: 1 }).includes('run_shortcut'));
});

test('only a shortcut that exists can be allowed', async () => {
  const out = await S.allow('reflect-test-this-shortcut-does-not-exist');
  assert.equal(out.ok, false);
  assert.match(out.reason, /no shortcut called/i);
});

// Exact names only. "morning routine" for "Morning Routine" is refused rather
// than matched, because a near match is how the wrong automation runs.
test('a name that is not on the list is refused without running anything', async () => {
  await FileStore.writeJSON('shortcuts.json', { allowed: ['Morning Routine'] });
  const out = await S.runShortcut({ name: 'morning routine' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not one Reflect may run/);
});

test('a shortcut deleted after it was allowed fails plainly', { skip: !mac && 'macOS only' }, async () => {
  await FileStore.writeJSON('shortcuts.json', { allowed: ['reflect-test-deleted-shortcut'] });
  const out = await S.runShortcut({ name: 'reflect-test-deleted-shortcut' });
  assert.equal(out.ok, false, 'a missing shortcut must not report success');
  // The CLI hangs for its whole timeout on a missing name and the timeout then
  // blames the wrong thing. The reason has to be the true one, and fast.
  assert.match(out.reason, /deleted or renamed/);
});

test('the tool reports a refusal as not having run', async () => {
  await FileStore.writeJSON('shortcuts.json', { allowed: [] });
  const out = await runTool('run_shortcut', { name: 'Anything' }, {});
  assert.match(out.result, /did not run/);
  assert.equal(out.sent, undefined, 'nothing ran, so nothing may be reported as having run');
});

// A task runs unattended, so it may run a shortcut only when its own words say
// so — computed from the person's instruction, never set by the model.
test('a task may run a shortcut only if its instruction says so', () => {
  assert.equal(mayRunShortcuts('Every morning, run my Morning Routine shortcut'), true);
  assert.equal(mayRunShortcuts('Run the shortcuts I use for backups'), true);
  assert.equal(mayRunShortcuts('Search the news and summarise it'), false);
  assert.equal(mayRunShortcuts(''), false);
});
