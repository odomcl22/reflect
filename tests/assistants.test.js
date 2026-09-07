/**
 * Assistants.
 *
 * The whole design rests on one decision, and it is the one thing here that
 * cannot be undone later without losing data: an assistant is a role, not a
 * separate mind. It changes how Reflect speaks, which model answers, and what
 * is on the table. It does not change what Reflect knows.
 *
 * Every other app in this space gives each assistant its own memory. Reflect
 * exists because a long conversation hit a context limit and everything in it
 * was gone, so continuity is the product. Split memory by assistant and you get
 * the most confusing possible failure: you tell the study assistant you are
 * working on brevity, and the work assistant has never heard of it, and nobody
 * can predict which one remembers what.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { useStorage, resetStorage } = await import('../src/core/Storage.js');
const { MemoryStorage } = await import('../src/adapters/storage/MemoryStorage.js');
useStorage(new MemoryStorage());

const FileStore = await import('../src/store/FileStore.js');
const A = await import('../src/assistants/Assistants.js');

await FileStore.scaffold();
test.after(() => resetStorage());

const tool = (name) => ({ type: 'function', function: { name } });

// ───────────────────────────────────────────────────────── the boundary

test('an assistant changes the voice, never the memory', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/assistants/Assistants.js', import.meta.url), 'utf8')
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  // If any of these appear, memory has started to belong to an assistant
  // rather than to the person, and the promise the product is built on is
  // quietly gone.
  for (const word of ['USER.md', 'journal', 'projects', 'recall', 'memoryFor']) {
    assert.ok(!code.includes(word), `assistants reached into memory via "${word}"`);
  }
});

test('a role is appended to the soul, not swapped for it', () => {
  // Reflect is still Reflect underneath: still bound by the rules about not
  // inventing details and not narrating its own memory. A role is a way of
  // speaking, not a licence to become something else.
  const combined = A.personaFor('You are Reflect. Never invent details.', {
    name: 'study',
    persona: 'Ask one question back.',
  });
  assert.match(combined, /Never invent details/);
  assert.match(combined, /ROLE: STUDY/);
  assert.match(combined, /Ask one question back/);

  // An assistant with no persona changes nothing at all.
  assert.equal(A.personaFor('base', { name: 'x', persona: '' }), 'base');
});

// ──────────────────────────────────────────────────────────── the file

test('an assistant is a file, and a bad one says why', async () => {
  await A.writeAssistant('study', {
    description: 'Patient. Explains rather than answers.',
    persona: 'Ask one question back.',
    model: 'qwen3:4b',
    tools: ['memory_search'],
  });

  const saved = await A.readAssistant('study');
  assert.equal(saved.valid, true);
  assert.equal(saved.model, 'qwen3:4b');
  assert.deepEqual(saved.tools, ['memory_search']);

  const raw = await FileStore.readText('assistants/study.md', '');
  assert.match(raw, /^description: Patient/m, 'the description is readable in the file');
  assert.match(raw, /Ask one question back/);

  await A.writeAssistant('vague', { description: '', persona: 'hi' });
  const vague = await A.readAssistant('vague');
  assert.equal(vague.valid, false);
  assert.match(vague.problems.join(' '), /no description/);
});

test('the built-in one always exists and cannot be removed', async () => {
  // A default that exists only as a file is a default someone can delete
  // themselves out of, leaving an app with no assistant at all.
  const all = await A.listAssistants();
  assert.equal(all[0].name, 'reflect');
  assert.equal(all[0].builtIn, true);

  await assert.rejects(() => A.removeAssistant('reflect'), /cannot be deleted/);
  await assert.rejects(() => A.writeAssistant('reflect', {}), /cannot be overwritten/);
  assert.equal((await A.readAssistant(null)).name, 'reflect', 'no choice means the built-in');
  assert.equal((await A.readAssistant('ghost')), null, 'a name nobody has is not silently the default');
});

test('unsafe names are refused', async () => {
  await assert.rejects(() => A.writeAssistant('../escape', {}), /Unsafe assistant name/);
  await assert.rejects(() => A.removeAssistant('../escape'), /Unsafe assistant name/);
});

// ─────────────────────────────────────────────────────── what it may use

test('a named tool list is a restriction; no list means everything', () => {
  const all = [tool('memory_search'), tool('memory_write'), tool('file_write')];

  // Null is "all of them", not "none". An assistant that quietly had no tools
  // would look broken rather than restricted.
  assert.equal(A.toolsAllowedBy({ tools: null }, all).length, 3);
  assert.equal(A.toolsAllowedBy(null, all).length, 3);

  const narrowed = A.toolsAllowedBy({ tools: ['memory_search'] }, all);
  assert.deepEqual(narrowed.map((t) => t.function.name), ['memory_search']);
});

test('skills narrow the same way, so a role has a shorter catalogue', () => {
  const skills = [{ name: 'brief' }, { name: 'proofread' }];
  assert.equal(A.skillsAllowedBy({ skills: null }, skills).length, 2);
  assert.deepEqual(A.skillsAllowedBy({ skills: ['brief'] }, skills).map((s) => s.name), ['brief']);
});

test('a model is pinned only when the assistant says so', async () => {
  // An assistant that pinned a model the machine does not have would be
  // unusable on any other machine, so silence means "whatever is selected".
  assert.equal((await A.readAssistant('study')).model, 'qwen3:4b');
  assert.equal(A.DEFAULT_ASSISTANT.model, null);
});
