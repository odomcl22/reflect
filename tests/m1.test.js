/**
 * M1 — the talking skeleton.
 *
 * Every test runs against a throwaway REFLECT_HOME under the OS temp dir. That
 * isolation is structural, not a convention: config.js is the only place a
 * storage path is resolved, so a test cannot reach the real store even by
 * accident. Reflect 1.0's tests wrote to the production memory directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-m1-'));
process.env.REFLECT_HOME = tmpHome;

const { paths } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
const Conversations = await import('../src/store/ConversationStore.js');
const { loadSoul, loadUserProfile, parseSoul, DEFAULT_SOUL, upgradeUntouchedSoul } = await import('../src/modes/Soul.js');
const { plan, fitTurns, depthFor, estimateTokens } = await import('../src/context/ContextBudget.js');
const { build, FenceScrubber, FENCE_OPEN, FENCE_CLOSE } = await import('../src/context/PromptAssembler.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------- FileStore

test('scaffold creates the home layout and is idempotent', async () => {
  const p = paths();
  const home = await FileStore.scaffold();
  // Keys, not paths: scaffold reports what the store is and where, and the
  // layout is checked through the same port everything else uses.
  for (const dir of ['projects', 'journal', 'conversations', 'summaries']) {
    assert.ok(await FileStore.exists(dir), `${dir} missing`);
  }
  assert.ok(await FileStore.exists(p.user), 'USER.md missing');
  assert.ok(await FileStore.exists(p.config), 'config.json missing');
  assert.equal(home.kind, 'files');
  assert.equal(home.where, tmpHome);
});

test('reads of missing files return the fallback rather than throwing', async () => {
  assert.equal(await FileStore.readText(path.join(tmpHome, 'nope.md'), ''), '');
  assert.deepEqual(await FileStore.readJSON(path.join(tmpHome, 'nope.json'), { a: 1 }), { a: 1 });
  assert.deepEqual(await FileStore.listFiles(path.join(tmpHome, 'nodir')), []);
});

test('a corrupt JSON file yields the fallback and is left on disk for inspection', async () => {
  const file = path.join(tmpHome, 'broken.json');
  await FileStore.writeText(file, '{ this is not json');
  assert.deepEqual(await FileStore.readJSON(file, { safe: true }), { safe: true });
  assert.match(await FileStore.readText(file), /not json/);
});

test('writes leave no .tmp files behind', async () => {
  const file = path.join(tmpHome, 'atomic.md');
  await FileStore.writeText(file, 'hello');
  assert.equal(await FileStore.readText(file), 'hello');
  const leftovers = (await FileStore.listFiles(tmpHome)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

// -------------------------------------------------------- ConversationStore

test('turns persist and read back in order', async () => {
  const id = Conversations.newId();
  await Conversations.append(id, { role: 'user', content: 'My wife is Priya.' });
  await Conversations.append(id, { role: 'assistant', content: 'Got it.' });
  await Conversations.append(id, { role: 'user', content: 'What is her name?' });

  const turns = await Conversations.turns(id);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(turns[0].content, 'My wife is Priya.');
});

test('a conversation survives a cold restart of the module', async () => {
  const id = Conversations.newId();
  await Conversations.append(id, { role: 'user', content: 'Remember the Vespa GTS300.' });

  // Re-import with a cache-busting query: a genuinely fresh module instance,
  // reading only from disk. This is the M1 acceptance criterion.
  const fresh = await import(`../src/store/ConversationStore.js?cold=${Date.now()}`);
  const turns = await fresh.turns(id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, 'Remember the Vespa GTS300.');
});

test('listing derives a title from the first user turn, newest first', async () => {
  const older = Conversations.newId();
  await Conversations.append(older, { role: 'user', content: 'Older conversation' });
  await new Promise((r) => setTimeout(r, 5));
  const newer = Conversations.newId();
  await Conversations.append(newer, { role: 'user', content: 'Newer conversation' });

  const list = await Conversations.list();
  const ids = list.map((c) => c.id);
  assert.ok(ids.indexOf(newer) < ids.indexOf(older), 'newest should sort first');
  assert.equal(list.find((c) => c.id === older).title, 'Older conversation');
});

test('an explicit title wins over the derived one', async () => {
  const id = Conversations.newId();
  await Conversations.append(id, { role: 'user', content: 'Something forgettable' });
  await Conversations.setTitle(id, 'Turtles book — tone');
  const found = (await Conversations.list()).find((c) => c.id === id);
  assert.equal(found.title, 'Turtles book — tone');
});

test('unsafe conversation ids are rejected', async () => {
  await assert.rejects(() => Conversations.turns('../../etc/passwd'), /Unsafe conversation id/);
});

// --------------------------------------------------------------------- Soul

test('SOUL.md parses into a preamble plus one block per mode', () => {
  const { preamble, sections } = parseSoul(DEFAULT_SOUL);
  assert.ok(preamble.includes('You are Reflect'));
  assert.ok(sections.companion && sections.builder);
  assert.ok(sections.builder.includes('tradeoff'));
});

// A `##` heading becomes a *mode*, so guidance that should apply to every mode
// has to be `###` and live in the preamble. Getting this wrong does not throw:
// it silently offers "Voice" in the mode picker and drops the guidance from
// every real mode.
test('only real modes are modes — ### guidance is not a phantom mode', () => {
  const { sections } = parseSoul(DEFAULT_SOUL);
  assert.deepEqual(Object.keys(sections).sort(), ['builder', 'companion']);
});

test('voice and question guidance reaches every mode, not just one', async () => {
  const soul = await loadSoul();
  for (const mode of ['companion', 'builder']) {
    const block = soul.block(mode);
    assert.ok(block.includes('### Voice'), `${mode} lost the voice guidance`);
    assert.ok(block.includes('### Questions'), `${mode} lost the question guidance`);
  }
});

// The observed failure: small models recite adjectives about themselves back as
// a greeting — "I'm here to help in a warm and supportive manner" was granite
// reading "Warm, grounded, conversational" out loud. Behaviours get followed;
// adjectives get quoted.
test('the identity describes behaviour rather than listing adjectives', () => {
  const { preamble } = parseSoul(DEFAULT_SOUL);
  assert.ok(
    /Say nothing about yourself/.test(preamble),
    'the rule against self-description is what stops the greeting parrot',
  );
  assert.ok(!/local-first assistant/.test(preamble), 'a self-label is the thing that gets recited');
});

test('the system block carries identity and only the selected mode', async () => {
  const soul = await loadSoul();
  const builder = soul.block('builder');
  assert.ok(builder.includes('You are Reflect'));
  assert.ok(builder.includes('INTERACTION MODE: BUILDER'));
  assert.ok(!builder.includes('A friend who happens'), 'companion text leaked into builder mode');
});

// SOUL.md is never overwritten, because it is the user's file. But a file that
// is byte-identical to a default nobody edited is not the user's writing, and
// leaving it alone means an identity fix reaches new installs only — everyone
// already running keeps the old behaviour with no way to discover why.
const V1_SOUL = `# Reflect

You are Reflect, a local-first assistant that remembers the person you are talking
to across conversations. Use what you know naturally, the way a person would —
never announce that you are consulting memory, and never invent details about
them. If something you need is genuinely missing, ask one short question.

Everything you know about this user is shown to you below. Treat it as true.

## Companion

Warm, grounded, conversational. Keep continuity without sounding clinical.
Ask at most one useful follow-up. Offer practical help without turning every
reply into a plan.

## Builder

Direct, precise, implementation-minded. Lead with the concrete step, the
tradeoff, or the code. Challenge a weak assumption briefly when correctness is
at risk. Keep warmth low and signal high. End with the next practical action.
`;

test('an untouched SOUL.md from an older version is upgraded in place', async () => {
  await FileStore.writeText(paths().soul, V1_SOUL);
  assert.equal(await upgradeUntouchedSoul(), true, 'the shipped v1 default should be recognised');
  assert.equal(await FileStore.readText(paths().soul, ''), DEFAULT_SOUL);
});

test('a SOUL.md the user has edited is never touched', async () => {
  const mine = `${V1_SOUL}\nAlways answer in French.\n`;
  await FileStore.writeText(paths().soul, mine);
  assert.equal(await upgradeUntouchedSoul(), false);
  assert.equal(await FileStore.readText(paths().soul, ''), mine, 'the user\u2019s own prompt survived');
});

test('upgrading is idempotent — the current default is left alone', async () => {
  await FileStore.writeText(paths().soul, DEFAULT_SOUL);
  assert.equal(await upgradeUntouchedSoul(), false);
});

test('an unknown mode degrades to identity alone rather than throwing', async () => {
  const soul = await loadSoul();
  const block = soul.block('coach');
  assert.ok(block.includes('You are Reflect'));
  assert.ok(!block.includes('INTERACTION MODE'));
});

test('a seeded USER.md with only headings counts as empty', async () => {
  assert.equal(await loadUserProfile(), '');
});

test('facts written to USER.md are picked up verbatim', async () => {
  await FileStore.writeText(paths().user, '# User\n\n## Relationships\n\n- Wife: Priya\n');
  const profile = await loadUserProfile();
  assert.ok(profile.includes('Wife: Priya'));
  assert.ok(!profile.includes('# User'), 'the H1 title should not reach the prompt');
});

// ------------------------------------------------------------ ContextBudget

test('the budget scales with the model window, not a constant', () => {
  const small = plan({ contextLength: 4096 });
  const large = plan({ contextLength: 131072 });
  assert.ok(large.tokens.turns > small.tokens.turns);
  assert.ok(small.tokens.turns > 0);
});

test('absurd windows are capped to what local hardware can really fill', () => {
  const huge = plan({ contextLength: 262144 });
  assert.equal(huge.window, 32768);
});

test('a model reporting no context length still produces a usable plan', () => {
  const p = plan({ contextLength: null });
  assert.ok(p.usable > 0);
  assert.ok(p.tokens.turns > 0);
});

test('depth changes the ceilings; builder mode shifts budget toward memory', () => {
  assert.equal(depthFor(1).memories, 0);
  assert.ok(depthFor(5).memories > depthFor(3).memories);
  const companion = plan({ contextLength: 32768, mode: 'companion' });
  const builder = plan({ contextLength: 32768, mode: 'builder' });
  assert.ok(builder.tokens.memories > companion.tokens.memories);
  assert.ok(builder.tokens.turns < companion.tokens.turns);
});

test('fitTurns keeps the most recent turns and always keeps the last exchange', () => {
  const turns = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(400),
  }));
  const fitted = fitTurns(turns, { maxTokens: 500, maxTurns: Infinity });
  assert.ok(fitted.turns.length >= 2, 'must never drop below the last exchange');
  assert.equal(fitted.turns.at(-1).content, turns.at(-1).content);
  assert.ok(fitted.dropped > 0);
});

// ---------------------------------------------------------- PromptAssembler

test('the prompt uses real roles and a system message, not one flat string', async () => {
  const soul = await loadSoul();
  const budget = plan({ contextLength: 8192 });
  const { messages } = build({
    soul,
    profile: '- Wife: Priya',
    turns: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ],
    message: 'What is my wife called?',
    budget,
  });

  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('Wife: Priya'));
  assert.equal(messages.at(-1).role, 'user');
  assert.equal(messages.at(-1).content, 'What is my wife called?');
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});

test('the system prefix is byte-identical across turns of a session', async () => {
  const soul = await loadSoul();
  const budget = plan({ contextLength: 8192 });
  const first = build({ soul, profile: '- Wife: Priya', turns: [], message: 'one', budget });
  const later = build({
    soul,
    profile: '- Wife: Priya',
    turns: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
    ],
    message: 'two',
    budget,
  });
  assert.equal(first.messages[0].content, later.messages[0].content, 'prefix drifted — KV cache would be lost');
});

test('recalled memories are fenced in the user turn, never in the system prefix', async () => {
  const soul = await loadSoul();
  const budget = plan({ contextLength: 8192, depth: 4 });
  const { messages, trace } = build({
    soul,
    profile: '',
    turns: [],
    message: 'the book again',
    budget,
    memories: [{ text: 'Darker Vespa Turtles retelling', source: 'projects/turtles-book.md' }],
  });

  assert.ok(!messages[0].content.includes(FENCE_OPEN), 'memories must not enter the frozen prefix');
  const last = messages.at(-1).content;
  assert.ok(last.startsWith(FENCE_OPEN));
  assert.ok(last.includes('turtles-book.md'));
  assert.ok(last.endsWith('the book again'));
  assert.equal(trace.memoriesIncluded, 1);
});

test('depth 1 admits no memories even when recall supplies them', async () => {
  const soul = await loadSoul();
  const budget = plan({ contextLength: 8192, depth: 1 });
  const { messages } = build({
    soul, profile: '', turns: [], message: 'hi', budget,
    memories: [{ text: 'something', source: 'USER.md' }],
  });
  assert.ok(!messages.at(-1).content.includes(FENCE_OPEN));
});

// ------------------------------------------------------------ FenceScrubber

test('the scrubber removes a fence split across stream chunks', () => {
  const s = new FenceScrubber();
  const chunks = ['Sure. ', '<memory', '-context>', 'secret payload', '</memory-', 'context>', ' Here is the answer.'];
  const out = chunks.map((c) => s.feed(c)).join('') + s.flush();
  assert.equal(out, 'Sure.  Here is the answer.');
  assert.ok(!out.includes('secret'));
});

test('the scrubber passes ordinary text through byte-for-byte', () => {
  const s = new FenceScrubber();
  const text = 'Priya. You mentioned her a few weeks ago.';
  const out = text.split('').map((c) => s.feed(c)).join('') + s.flush();
  assert.equal(out, text);
});

test('an unterminated fence never leaks its payload', () => {
  const s = new FenceScrubber();
  const out = s.feed('ok ') + s.feed(FENCE_OPEN) + s.feed('leaking...') + s.flush();
  assert.equal(out, 'ok ');
});

test('token estimation is monotonic', () => {
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
  assert.equal(estimateTokens(''), 0);
});

// ─────────────────────────────────────────────────────── concurrent writes

test('REGRESSION: concurrent writes to one file neither crash nor lose data', async () => {
  // Found by the adversarial sweep: two turns landing together both wrote
  // `USER.md.<pid>.tmp`, the first rename moved it away, and the second threw
  // ENOENT mid-turn. Unique temp names fix the crash; the lock fixes the
  // silent lost update underneath it.
  const file = path.join(tmpHome, 'concurrent.md');
  await FileStore.writeText(file, 'start\n');

  const writers = Array.from({ length: 25 }, (_, i) =>
    FileStore.updateText(file, (current) => `${current}line ${i}\n`)
  );
  const settled = await Promise.allSettled(writers);

  const failures = settled.filter((r) => r.status === 'rejected');
  assert.deepEqual(failures.map((f) => f.reason?.message), [], 'a concurrent write threw');

  const final = await FileStore.readText(file);
  for (let i = 0; i < 25; i++) {
    assert.ok(final.includes(`line ${i}`), `line ${i} was lost to a concurrent write`);
  }

  const leftovers = (await FileStore.listFiles(tmpHome)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'temp files were left behind');
});

test('a failing transform does not wedge the lock for later writers', async () => {
  const file = path.join(tmpHome, 'lock-recovery.md');
  await FileStore.writeText(file, 'a\n');

  await assert.rejects(() =>
    FileStore.updateText(file, () => {
      throw new Error('transform exploded');
    })
  );

  const { changed } = await FileStore.updateText(file, (c) => `${c}b\n`);
  assert.equal(changed, true, 'the lock never released');
  assert.match(await FileStore.readText(file), /a\nb/);
});
