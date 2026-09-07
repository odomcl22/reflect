/**
 * How far a task may reach.
 *
 * A task runs while nobody is watching, which is the point of it and also the
 * reason it should not hold every tool a live conversation holds. At eight in
 * the morning there is no one at the screen to notice a message going to the
 * wrong person, and a message cannot be taken back.
 *
 * The load-bearing property is that the model does not decide this. `task_create`
 * is a tool, so a model able to set the field could grant itself the ability to
 * message people — and a page Reflect read could talk it into doing so. It is
 * read from the person's own instruction instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-reach-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Tasks = await import('../src/tasks/Tasks.js');
const { toolsFor } = await import('../src/reflect/MemoryTools.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('what the instruction asked for is what the task may do', () => {
  assert.equal(Tasks.reachFor('Text my wife good morning and I love you'), 'send');
  assert.equal(Tasks.reachFor('Email Ali the weekly figures'), 'send');
  assert.equal(Tasks.reachFor('Remind me to take my pills'), 'notify');
  assert.equal(Tasks.reachFor('Search the news and summarise it'), 'none');
  assert.equal(Tasks.reachFor('Write my weekly notes into the journal'), 'none');
});

// An instruction asking for both wants the stronger one; the weaker is inside it.
test('asking to search and then text is a task that may text', () => {
  assert.equal(Tasks.reachFor('Search the web every morning then text me the summary'), 'send');
});

test('reach survives a write and a read', async () => {
  await Tasks.writeTask('morning-love', {
    name: 'morning-love',
    when: 'every day at 08:00',
    instruction: 'Text my wife good morning and that I love her.',
  });
  const back = await Tasks.readTask('morning-love');
  assert.equal(back.reach, 'send');

  await Tasks.writeTask('news', {
    name: 'news',
    when: 'every day at 07:00',
    instruction: 'Search the news and write me a summary.',
  });
  assert.equal((await Tasks.readTask('news')).reach, 'none');
});

// A person may disagree with the guess, and their answer is the one that counts.
test('a stored reach beats the guess', async () => {
  await Tasks.writeTask('quiet', {
    name: 'quiet',
    when: 'manual',
    instruction: 'Text my wife good morning.',
    reach: 'none',
  });
  assert.equal((await Tasks.readTask('quiet')).reach, 'none', 'the person overrode it');
});

test('what each reach actually withholds', () => {
  assert.deepEqual(Tasks.toolsBlockedBy('send'), []);
  assert.deepEqual(Tasks.toolsBlockedBy('notify'), ['message', 'mail_draft']);
  assert.deepEqual(Tasks.toolsBlockedBy('none'), ['notify', 'message', 'mail_draft']);
});

// The whole point, expressed as the tool list a run would actually be handed.
test('a news task is not offered the tools that reach people', async () => {
  const withheld = Tasks.toolsBlockedBy((await Tasks.readTask('news')).reach);
  const offered = toolsFor({ contacts: 1, disabled: withheld }).map((t) => t.function.name);
  assert.ok(!offered.includes('message'), 'a news task could message someone');
  assert.ok(!offered.includes('mail_draft'));
  assert.ok(!offered.includes('notify'));
  // It keeps everything it needs to do its actual job.
  assert.ok(offered.includes('memory_search'));
});

test('the task that was asked to text keeps the tool to do it', async () => {
  const withheld = Tasks.toolsBlockedBy((await Tasks.readTask('morning-love')).reach);
  const offered = toolsFor({ contacts: 1, disabled: withheld }).map((t) => t.function.name);
  assert.ok(offered.includes('message'), 'the task exists to send and cannot');
});

// A live turn is supervised by the person having typed it, so nothing changes.
test('a conversation you are present for is unaffected', () => {
  const offered = toolsFor({ contacts: 1 }).map((t) => t.function.name);
  assert.ok(offered.includes('message'));
  assert.ok(offered.includes('notify'));
});
