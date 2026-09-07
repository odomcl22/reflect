/**
 * Carrying a conversation into a new one.
 *
 * The thing Reflect was built for. The founding complaint was a long ChatGPT
 * conversation that hit its limit and took everything in it with it — no way to
 * keep going, no way to get back what was said. Compaction keeps a long
 * conversation *usable*; this is the fresh start that still knows everything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-cont-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Conversations = await import('../src/store/ConversationStore.js');
const Summaries = await import('../src/store/Summaries.js');
const { continueElsewhere, MIN_TURNS } = await import('../src/context/Continue.js');
const { build } = await import('../src/context/PromptAssembler.js');
const { plan } = await import('../src/context/ContextBudget.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

/** A runtime that returns a fixed summary, so the test is about the plumbing. */
const fakeRuntime = (text = '- Writing a book called Shellshock\n- Deadline is 14 November') => ({
  calls: [],
  async complete({ messages }) {
    this.calls.push(messages);
    return { content: text };
  },
});

async function conversationOf(id, turns, meta = {}) {
  await Conversations.ensure(id, { title: 'The turtle book', mode: 'companion', ...meta });
  for (let i = 0; i < turns; i++) {
    await Conversations.append(id, { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` });
  }
}

test('a conversation carries forward into a new one that knows it', async () => {
  await conversationOf('long', 12);
  const runtime = fakeRuntime();

  const result = await continueElsewhere({ conversationId: 'long', runtime, model: 'm' });
  assert.equal(result.ok, true);
  assert.notEqual(result.id, 'long');
  assert.equal(result.turns, 12);

  // The summary belongs to the new conversation, marked as somebody else's
  // turns rather than its own.
  const carried = await Summaries.read(result.id);
  assert.match(carried.text, /Shellshock/);
  assert.equal(carried.carriedFrom, 'long');

  // And the way back is recorded, which is the difference between continuing
  // and starting again.
  assert.equal((await Conversations.meta(result.id)).continues, 'long');
});

// Nothing is deleted or moved. Someone carrying a conversation forward is
// mid-thought and must not lose the thing they were thinking about.
test('the conversation it came from is left exactly as it was', async () => {
  await conversationOf('intact', 10);
  const before = await Conversations.turns('intact');

  await continueElsewhere({ conversationId: 'intact', runtime: fakeRuntime(), model: 'm' });

  const after = await Conversations.turns('intact');
  assert.deepEqual(after.map((t) => t.content), before.map((t) => t.content));
  assert.equal((await Conversations.meta('intact')).title, 'The turtle book');
});

test('a continued conversation stays in its project', async () => {
  await conversationOf('filed', 10, { project: 'turtles-book' });
  const result = await continueElsewhere({ conversationId: 'filed', runtime: fakeRuntime(), model: 'm' });
  assert.equal((await Conversations.meta(result.id)).project, 'turtles-book');
});

// Below this the summary is longer than the exchange and blunter than it, so
// carrying on where you are is the better answer — and saying so beats making
// a worse copy of a conversation that was working.
test('a short conversation is told to carry on where it is', async () => {
  await conversationOf('short', 4);
  const result = await continueElsewhere({ conversationId: 'short', runtime: fakeRuntime(), model: 'm' });
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(String(MIN_TURNS)));
});

test('a conversation that does not exist fails without throwing', async () => {
  const result = await continueElsewhere({ conversationId: 'nope', runtime: fakeRuntime(), model: 'm' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
});

// A model that returns nothing must not produce a conversation that claims to
// remember something and holds an empty summary.
test('an empty summary makes no conversation at all', async () => {
  await conversationOf('empty', 10);
  const before = (await Conversations.list()).length;

  const result = await continueElsewhere({ conversationId: 'empty', runtime: fakeRuntime('   '), model: 'm' });
  assert.equal(result.ok, false);
  assert.equal((await Conversations.list()).length, before, 'nothing was created');
});

// The whole conversation, not the compacted view: the summary being written
// replaces the entire history, so reading only what currently fits would
// quietly drop whatever compaction had already dropped.
test('the summary is written from every turn, including compacted ones', async () => {
  await conversationOf('deep', 20);
  await Conversations.markCompacted('deep', { throughTurnId: 't5', covers: 6, head: 2 });
  await Summaries.write('deep', { text: '- an early decision nobody must lose', covers: 6, throughTurnId: 't5' });

  const runtime = fakeRuntime();
  const result = await continueElsewhere({ conversationId: 'deep', runtime, model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.turns, 20, 'all of them, not just what fits');

  const prompt = runtime.calls[0].map((m) => m.content).join('\n');
  assert.match(prompt, /an early decision nobody must lose/, 'the existing summary was folded in');
  assert.match(prompt, /turn 19/, 'and so were the newest turns');
});

// Telling a model "earlier in this conversation" about turns that happened
// somewhere else invites it to offer to scroll back to them.
test('a carried summary is labelled as coming from elsewhere', () => {
  const soul = { block: () => 'You are Reflect.' };
  const budget = plan({ mode: 'companion', depth: 3, window: 8192 });

  const own = build({ soul, message: 'hi', budget, summary: '- a thing' });
  const carried = build({ soul, message: 'hi', budget, summary: '- a thing', carried: true });

  const text = (r) => r.messages.map((m) => m.content).join('\n');
  assert.match(text(own), /Earlier in this conversation/);
  assert.match(text(carried), /Carried over from the conversation this continues/);
  assert.match(text(carried), /not in this transcript/);
});

// ------------------------------------------------------------------ branching
//
// Continuing is for a conversation that has gone on too long. Branching is for
// one that went the wrong way: you want to be back at turn six and say
// something different, without losing the eleven turns that came after.
//
// Every other assistant makes you choose — editing a message rewrites the
// thread and the version you had is gone. Reflect never edits a transcript in
// place, so it does not have to choose.

const { branchFrom } = await import('../src/context/Continue.js');

test('branching from a reply keeps everything through it', async () => {
  await conversationOf('road', 10);
  const all = await Conversations.turns('road');
  const reply = all[5]; // an assistant turn

  const result = await branchFrom({ conversationId: 'road', turnId: reply.id });
  assert.equal(result.ok, true);
  assert.equal(result.turns, 6, 'inclusive of the reply you picked');
  assert.equal(result.editing, null, 'there is nothing to put differently');

  const copied = await Conversations.turns(result.id);
  assert.deepEqual(copied.map((t) => t.content), all.slice(0, 6).map((t) => t.content));
});

// The reason to go back to your own turn is to put it differently, so it is
// handed back rather than repeated.
test('branching from your own message hands it back to edit', async () => {
  await conversationOf('rephrase', 10);
  const all = await Conversations.turns('rephrase');
  const mine = all[6]; // a user turn
  assert.equal(mine.role, 'user');

  const result = await branchFrom({ conversationId: 'rephrase', turnId: mine.id });
  assert.equal(result.ok, true);
  assert.equal(result.turns, 6, 'exclusive of the message being rewritten');
  assert.equal(result.editing, mine.content);

  const copied = await Conversations.turns(result.id);
  assert.equal(copied.at(-1).role, 'assistant', 'it ends on a complete exchange');
});

// The whole point. Both roads exist afterwards.
test('the conversation branched from is untouched', async () => {
  await conversationOf('keep', 10);
  const before = await Conversations.turns('keep');
  await branchFrom({ conversationId: 'keep', turnId: before[4].id });

  const after = await Conversations.turns('keep');
  assert.deepEqual(after.map((t) => t.content), before.map((t) => t.content));
});

// Sharing turn ids across two conversations would make "which conversation was
// this turn in" unanswerable, and both compaction and branching key off exactly
// that question.
test('copied turns get their own ids', async () => {
  await conversationOf('ids', 10);
  const all = await Conversations.turns('ids');
  const result = await branchFrom({ conversationId: 'ids', turnId: all[5].id });

  const copied = await Conversations.turns(result.id);
  const shared = copied.filter((c) => all.some((o) => o.id === c.id));
  assert.equal(shared.length, 0, 'no id appears in both transcripts');
});

test('a branch stays in its project and remembers where it split', async () => {
  await conversationOf('filed-branch', 10, { project: 'turtles-book' });
  const all = await Conversations.turns('filed-branch');
  const result = await branchFrom({ conversationId: 'filed-branch', turnId: all[5].id });

  const meta = await Conversations.meta(result.id);
  assert.equal(meta.project, 'turtles-book');
  assert.equal(meta.branchedFrom, 'filed-branch');
});

// Turns already compacted away are not in the copied range, so without this the
// branch would be missing the start of its own story.
test('a branch carries the summary of what had already been compacted', async () => {
  await conversationOf('deep-branch', 20);
  await Summaries.write('deep-branch', { text: '- the opening decision', covers: 6, throughTurnId: 't5' });

  const all = await Conversations.turns('deep-branch');
  const result = await branchFrom({ conversationId: 'deep-branch', turnId: all[15].id });

  const carried = await Summaries.read(result.id);
  assert.match(carried.text, /the opening decision/);
});

test('a turn from some other conversation is refused', async () => {
  await conversationOf('mine', 10);
  const result = await branchFrom({ conversationId: 'mine', turnId: 't_nonsense' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in this conversation/);
});

// meta()'s title came straight off the metadata line, which is null for almost
// every conversation — one is appended later, or derived from the first thing
// said. Anything reading meta().title got nothing while the sidebar showed the
// real name, which surfaced as branches called "Branch".
test('a branch inherits the name the conversation actually goes by', async () => {
  await Conversations.ensure('untitled', { mode: 'companion' });
  for (let i = 0; i < 10; i++) {
    await Conversations.append('untitled', { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` });
  }
  await Conversations.setTitle('untitled', 'The turtle book');

  const all = await Conversations.turns('untitled');
  const result = await branchFrom({ conversationId: 'untitled', turnId: all[5].id });
  assert.match(result.title, /The turtle book/);
  assert.match((await Conversations.meta(result.id)).title, /The turtle book/);
});
