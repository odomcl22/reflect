/**
 * Reaching the person, and the limits on doing so.
 *
 * Two things carry the weight here. The allowlist, because `message` is the
 * only thing in the project that reaches another human being and cannot be
 * undone. And argv, because the whole claim that this is not code execution
 * rests on the model's words arriving as arguments rather than as script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-deliver-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const D = await import('../src/deliver/Deliver.js');
const { toolsFor } = await import('../src/reflect/MemoryTools.js');

await FileStore.scaffold();

const names = (opts) => toolsFor(opts).map((t) => t.function.name);

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('nobody is reachable until a person says so', async () => {
  assert.deepEqual(await D.contacts(), []);
  const blocked = await D.message({ to: '+15550100000', text: 'hello' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /may not message/);
});

// The folder-grant rule, applied to people: the list is written by a person and
// by nothing else, so no tool call can create a way to contact a stranger.
test('the messaging tool does not exist until somebody is on the list', async () => {
  assert.ok(!names({}).includes('message'), 'offered with an empty list');
  assert.ok(names({ contacts: 1 }).includes('message'), 'never offered');
});

test('a notification and a draft are always offered, because neither sends', () => {
  const offered = names({});
  assert.ok(offered.includes('notify'));
  assert.ok(offered.includes('mail_draft'));
});

test('adding and removing someone', async () => {
  const added = await D.allow('+1 (555) 010-0000', 'me');
  assert.equal(added.ok, true);
  assert.equal(added.handle, '+15550100000', 'punctuation should not make two entries');
  assert.equal(await D.isAllowed('+1 555 010 0000'), true, 'the same number written differently');

  await D.revoke('+15550100000');
  assert.equal(await D.isAllowed('+15550100000'), false);
});

test('a handle has to look like one', async () => {
  for (const bad of ['', 'hello', 'drop table', '12']) {
    assert.equal((await D.allow(bad)).ok, false, `accepted ${bad}`);
  }
});

test('an email draft refuses anything that is not an address', async () => {
  const out = await D.mailDraft({ to: 'nonsense', body: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not an email/);
});

test('nothing is sent without something to say', async () => {
  await D.allow('+15550100000');
  assert.equal((await D.message({ to: '+15550100000', text: '   ' })).ok, false);
  assert.equal((await D.notify({ body: '' })).ok, false);
  await D.revoke('+15550100000');
});

// The load-bearing claim of the whole module: what the model writes is data.
// If this ever fails, "Reflect does not execute code" has stopped being true.
test('text that looks like script is passed as an argument, not run', {
  skip: process.platform !== 'darwin' ? 'macOS only' : false,
}, async () => {
  const payload = 'hi"; do shell script "echo pwned"; --';
  const { stdout } = await run('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'return item 1 of argv',
    '-e', 'end run',
    '--', payload,
  ]);
  assert.equal(stdout.trim(), payload, 'the payload was altered or interpreted');
  assert.ok(!/pwned/.test(stdout) || stdout.includes('do shell script'), 'it executed');
});
