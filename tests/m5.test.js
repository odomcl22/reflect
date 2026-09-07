/**
 * M5 — compaction.
 *
 * The milestone is done when a conversation far larger than the model's window
 * still knows what happened at the start. The acceptance test builds a ~40k
 * token conversation, compacts it repeatedly against an 8k budget, and then
 * checks that a fact stated in turn 3 is still reachable.
 *
 * The invariant that matters more than any of it: **compaction never deletes.**
 * The raw turns stay in the .jsonl forever. Only what gets loaded into the
 * prompt changes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-m5-'));
process.env.REFLECT_HOME = tmpHome;

const { paths } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const Conversations = await import('../src/store/ConversationStore.js');
const Summaries = await import('../src/store/Summaries.js');
const { plan, estimateTokens } = await import('../src/context/ContextBudget.js');
const { compact, shouldCompact, PROTECT_FIRST, PROTECT_LAST } = await import('../src/context/Compactor.js');
const { loadSoul } = await import('../src/modes/Soul.js');
const { build } = await import('../src/context/PromptAssembler.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

async function resetMemory() {
  await Memory.writeProfile('# User\n\n## Identity\n');
  await FileStore.removeAll(paths().projects);
  await FileStore.removeAll(paths().journal);
  await FileStore.ensureDir(paths().projects);
  await FileStore.ensureDir(paths().journal);
}

/** An "Ollama" that summarizes by listing, and extracts whatever is scripted. */
function stubOllama({ extraction = null, summary = null, fail = false } = {}) {
  return {
    summaries: 0,
    async complete({ messages, format }) {
      if (fail) throw new Error('model unavailable');
      if (format) {
        // The extraction call — recognised by its JSON schema.
        return {
          content: JSON.stringify(
            extraction || { facts: [], corrections: [], projects: [], journal: [] }
          ),
          metrics: {},
        };
      }
      this.summaries++;
      const source = messages[messages.length - 1].content;
      const carried = /## Earlier summary to fold in\n([\s\S]*?)\n\n/.exec(source);
      return {
        content:
          (summary || '- compressed turns') + (carried ? `\n${carried[1].trim()}` : ''),
        metrics: {},
      };
    },
  };
}

/** Build a conversation of `pairs` exchanges, each roughly `chars` long. */
async function makeConversation(pairs, chars = 800, opening = null) {
  const id = Conversations.newId();
  await Conversations.ensure(id);
  if (opening) {
    await Conversations.append(id, { role: 'user', content: opening });
    await Conversations.append(id, { role: 'assistant', content: 'Understood.' });
  }
  for (let i = 0; i < pairs; i++) {
    await Conversations.append(id, { role: 'user', content: `Turn ${i}. ${'x'.repeat(chars)}` });
    await Conversations.append(id, { role: 'assistant', content: `Reply ${i}. ${'y'.repeat(chars)}` });
  }
  return id;
}

const budget8k = () => plan({ contextLength: 8192 });

// ──────────────────────────────────────────────────────────────── summaries

test('a summary round-trips through its file', async () => {
  const id = Conversations.newId();
  await Summaries.write(id, { text: '- They decided on Ollama', covers: 12, throughTurnId: 't_abc' });
  const back = await Summaries.read(id);
  assert.equal(back.text, '- They decided on Ollama');
  assert.equal(back.covers, 12);
  assert.equal(back.throughTurnId, 't_abc');
});

test('no summary reads as null rather than throwing', async () => {
  assert.equal(await Summaries.read(Conversations.newId()), null);
});

test('an unsafe conversation id cannot escape the summaries directory', async () => {
  await assert.rejects(() => Summaries.read('../../etc/passwd'), /Unsafe conversation id/);
});

// ────────────────────────────────────────────────────────────── the trigger

test('a short conversation is left alone', async () => {
  const id = await makeConversation(2);
  const { turns } = await Conversations.contextTurns(id);
  assert.equal(shouldCompact(turns, budget8k()).should, false);
});

test('a long one trips the trigger, but only if there is a middle to compress', async () => {
  const long = await makeConversation(20);
  const { turns } = await Conversations.contextTurns(long);
  const check = shouldCompact(turns, budget8k());
  assert.equal(check.should, true);
  assert.ok(check.used > check.limit);

  // Enough tokens, but every turn is protected: nothing to do.
  const fat = await makeConversation(3, 6000);
  const { turns: fatTurns } = await Conversations.contextTurns(fat);
  assert.equal(fatTurns.length, PROTECT_FIRST + PROTECT_LAST - 2);
  assert.equal(shouldCompact(fatTurns, budget8k()).should, false);
});

// ──────────────────────────────────────────────────────────── the operation

test('compaction summarizes the middle and protects both ends', async () => {
  await resetMemory();
  const id = await makeConversation(20);
  const before = (await Conversations.turns(id)).length;

  const result = await compact({
    conversationId: id,
    budget: budget8k(),
    runtime: stubOllama({ summary: '- They were counting turns' }),
    model: 'stub',
  });

  assert.equal(result.ran, true);
  assert.equal(result.compressed, before - PROTECT_FIRST - PROTECT_LAST);

  const { turns: after } = await Conversations.contextTurns(id);
  assert.equal(after.length, PROTECT_FIRST + PROTECT_LAST, 'the opening and the tail survive verbatim');
  assert.match(after[0].content, /Turn 0/, 'the conversation must still open where it opened');
  assert.match(after.at(-1).content, /Reply 19/);
  assert.match((await Summaries.read(id)).text, /counting turns/);
});

test('INVARIANT: compaction never deletes a turn from disk', async () => {
  const id = await makeConversation(20);
  const before = await Conversations.turns(id);

  await compact({ conversationId: id, budget: budget8k(), runtime: stubOllama(), model: 'stub' });

  const after = await Conversations.turns(id);
  assert.equal(after.length, before.length, 'the transcript must remain complete');
  assert.deepEqual(after.map((t) => t.id), before.map((t) => t.id));
});

test('the flush runs before the summary, so nothing durable is lost with the turns', async () => {
  await resetMemory();
  const id = await makeConversation(2);
  // Stated mid-conversation, so it lands in the middle that compaction drops.
  await Conversations.append(id, { role: 'user', content: 'My wife is called Priya and I ride a Vespa GTS300' });
  await Conversations.append(id, { role: 'assistant', content: 'Noted.' });
  for (let i = 0; i < 18; i++) {
    await Conversations.append(id, { role: 'user', content: `Filler ${i}. ${'x'.repeat(800)}` });
    await Conversations.append(id, { role: 'assistant', content: `Reply ${i}. ${'y'.repeat(800)}` });
  }

  const result = await compact({
    conversationId: id,
    budget: budget8k(),
    runtime: stubOllama({
      extraction: {
        facts: [{ text: 'Wife: Priya', section: 'Relationships' }],
        corrections: [],
        projects: [],
        journal: [],
      },
    }),
    model: 'stub',
  });

  assert.equal(result.flushed, true);
  assert.match(await Memory.readProfile(), /Wife: Priya/, 'the flush should have saved it to USER.md');
});

test('successive compactions fold the previous summary in rather than dropping it', async () => {
  await resetMemory();
  const id = await makeConversation(20);
  const ollama = stubOllama({ summary: '- first pass' });

  const first = await compact({ conversationId: id, budget: budget8k(), runtime: ollama, model: 'stub' });
  assert.equal(first.ran, true);

  for (let i = 0; i < 20; i++) {
    await Conversations.append(id, { role: 'user', content: `More ${i}. ${'z'.repeat(800)}` });
    await Conversations.append(id, { role: 'assistant', content: `And ${i}. ${'w'.repeat(800)}` });
  }

  ollama.summaries = 0;
  const second = await compact({ conversationId: id, budget: budget8k(), runtime: ollama, model: 'stub' });
  assert.equal(second.ran, true);
  assert.ok(second.covers > first.covers, 'coverage should accumulate');
  assert.match((await Summaries.read(id)).text, /first pass/, 'the earlier summary must survive');
});

test('a failed summary leaves the conversation untouched', async () => {
  const id = await makeConversation(20);
  const result = await compact({
    conversationId: id,
    budget: budget8k(),
    runtime: stubOllama({ fail: true }),
    model: 'stub',
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /summary failed/);
  assert.equal(await Summaries.read(id), null);
  const { compacted } = await Conversations.contextTurns(id);
  assert.equal(compacted, 0, 'no marker should have been written');
});

test('a compaction marker pointing at a missing turn degrades to the full transcript', async () => {
  const id = await makeConversation(3);
  await Conversations.markCompacted(id, { throughTurnId: 't_does_not_exist', covers: 99 });
  const { turns, compacted } = await Conversations.contextTurns(id);
  assert.equal(compacted, 0);
  assert.equal(turns.length, 6, 'better to send too much than to silently lose the conversation');
});

// ──────────────────────────────────────────────────────── prompt assembly

test('the summary enters the prompt as its own message, above the live turns', async () => {
  const soul = await loadSoul();
  const budget = budget8k();
  const { messages } = build({
    soul,
    profile: '',
    summary: '- They chose Ollama as the backend',
    turns: [{ role: 'user', content: 'and then?' }],
    message: 'what did we settle on?',
    budget,
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'system');
  assert.match(messages[1].content, /Earlier in this conversation/);
  assert.match(messages[1].content, /chose Ollama/);
  assert.equal(messages.at(-1).content, 'what did we settle on?');
});

// ─────────────────────────────────────────── the M5 acceptance scenario

test('ACCEPTANCE: a 40k-token conversation on an 8k model still knows turn 3', async () => {
  await resetMemory();

  const budget = plan({ contextLength: 8192 });
  const opening = 'Before we start: the deploy key is rotated every Tuesday, and Priya owns the runbook.';
  const id = await makeConversation(0, 0, opening);

  const ollama = stubOllama({
    summary: '- Deploy key rotates on Tuesdays; Priya owns the runbook',
    extraction: {
      facts: [{ text: 'Priya owns the deploy runbook', section: 'Notes' }],
      corrections: [],
      projects: [],
      journal: [],
    },
  });

  // Grow the conversation past 40k tokens, compacting whenever it overflows —
  // exactly what the controller does after each turn.
  let compactions = 0;
  for (let i = 0; i < 30; i++) {
    await Conversations.append(id, { role: 'user', content: `Question ${i}. ${'q'.repeat(2800)}` });
    await Conversations.append(id, { role: 'assistant', content: `Answer ${i}. ${'a'.repeat(2800)}` });
    const result = await compact({ conversationId: id, budget, runtime: ollama, model: 'stub' });
    if (result.ran) compactions++;
  }

  const everything = await Conversations.turns(id);
  const totalTokens = everything.reduce((s, t) => s + estimateTokens(t.content), 0);
  assert.ok(totalTokens > 40000, `expected a 40k+ conversation, got ${totalTokens}`);
  assert.ok(compactions >= 2, `expected repeated compaction, got ${compactions}`);

  // 1. The full transcript is still on disk. Nothing was destroyed to save room.
  assert.equal(everything.length, 62);
  assert.match(everything[0].content, /deploy key is rotated every Tuesday/);

  // 2. What the model would actually see fits the 8k budget.
  const { turns: contextual } = await Conversations.contextTurns(id);
  const summary = await Summaries.read(id);
  const { messages, trace } = build({
    soul: await loadSoul(),
    profile: await Memory.readProfile(),
    summary: summary.text,
    turns: contextual,
    message: 'who owns the runbook again?',
    budget,
  });
  assert.ok(trace.promptTokens < budget.window, `prompt of ${trace.promptTokens} exceeds the 8k window`);

  // 3. And turn 3's fact survived, by both routes: the summary carries it, and
  //    the flush filed it into USER.md where recall can reach it from any
  //    future conversation.
  const prompt = messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Priya/, 'the opening fact did not survive into context');
  assert.match(await Memory.readProfile(), /Priya owns the deploy runbook/);
});

test('REGRESSION: the depth turn ceiling triggers compaction, not silent loss', async () => {
  // Observed live: a 30-turn conversation on Balanced depth (10-turn ceiling)
  // had its opening dropped by fitTurns before compaction ever considered it.
  // The tokens fit; the turn count did not. Only the token check existed.
  const budget = plan({ contextLength: 131072, depth: 3 }); // a huge window...
  const id = await makeConversation(15, 40);                // ...and tiny turns
  const { turns } = await Conversations.contextTurns(id);

  const check = shouldCompact(turns, budget);
  assert.ok(turns.length > budget.limits.turns, 'setup: must exceed the turn ceiling');
  assert.ok(check.used < check.limit, 'setup: must be comfortably within the token budget');
  assert.equal(check.should, true, 'the turn ceiling alone must trigger compaction');
  assert.equal(check.reason, 'turn ceiling');
});

test('nothing overflowing means nothing compacted', async () => {
  const id = await makeConversation(3, 40);
  const { turns } = await Conversations.contextTurns(id);
  const check = shouldCompact(turns, plan({ contextLength: 32768, depth: 3 }));
  assert.equal(check.should, false);
  assert.equal(check.reason, 'within budget');
});

test('the live message is not duplicated between prior turns and the current turn', async () => {
  // ChatController appends the user's message, then slices it back off before
  // passing `prior` to the assembler. If that slice is ever wrong the model sees
  // the question twice — once as history, once as the ask.
  const id = await makeConversation(2);
  await Conversations.append(id, { role: 'user', content: 'the live question' });

  const { turns } = await Conversations.contextTurns(id);
  const prior = turns.slice(0, -1);
  assert.equal(turns.at(-1).content, 'the live question', 'the appended message must be last');
  assert.ok(!prior.some((t) => t.content === 'the live question'));

  const { messages } = build({
    soul: await loadSoul(),
    profile: '',
    turns: prior,
    message: 'the live question',
    budget: budget8k(),
  });
  const occurrences = messages.filter((m) => m.content === 'the live question').length;
  assert.equal(occurrences, 1, 'the question appears once, as the current turn');
});

test('compaction leaves the live message in the protected tail', async () => {
  await resetMemory();
  const id = await makeConversation(20);
  await Conversations.append(id, { role: 'user', content: 'the live question' });

  await compact({ conversationId: id, budget: budget8k(), runtime: stubOllama(), model: 'stub' });

  const { turns } = await Conversations.contextTurns(id);
  assert.equal(turns.at(-1).content, 'the live question', 'compaction must never swallow the turn being answered');
});
