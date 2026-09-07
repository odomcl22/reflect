/**
 * M2 — memory files.
 *
 * The milestone is done when "Remember this: my wife is Priya" writes a line to
 * USER.md, and a new conversation in a fresh process can answer "what's my
 * wife's name?" from it. The last test in this file is that scenario, run
 * end-to-end through cold module reloads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-m2-'));
process.env.REFLECT_HOME = tmpHome;

const { paths } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const { search, tokenize } = await import('../src/recall/Keyword.js');
const { applyExplicit, detectExplicitSave } = await import('../src/reflect/Reflector.js');
const { runTool, readMemoryPath, TOOL_SCHEMAS } = await import('../src/reflect/MemoryTools.js');
const { loadSoul } = await import('../src/modes/Soul.js');
const { plan } = await import('../src/context/ContextBudget.js');
const { build, FENCE_OPEN } = await import('../src/context/PromptAssembler.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

/** Reset the memory layer between tests that care about exact file contents. */
async function resetMemory() {
  await Memory.writeProfile('# User\n\n## Identity\n\n## Preferences\n');
  await FileStore.removeAll(paths().projects);
  await FileStore.removeAll(paths().journal);
  await FileStore.ensureDir(paths().projects);
  await FileStore.ensureDir(paths().journal);
}

// ────────────────────────────────────────────────────────── markdown surgery

test('a bullet lands under an existing section', () => {
  const doc = '# User\n\n## Identity\n\n- Name: Sam\n\n## Preferences\n\n- Direct answers\n';
  const next = Memory.insertUnderSection(doc, 'Identity', 'Lives in Oregon');
  assert.match(next, /## Identity\n\n- Name: Sam\n- Lives in Oregon/);
  assert.match(next, /## Preferences\n\n- Direct answers/, 'other sections must be untouched');
});

test('a missing section is created at the end', () => {
  const next = Memory.insertUnderSection('# User\n\n## Identity\n\n- Name: Sam\n', 'Relationships', 'Wife: Priya');
  assert.match(next, /## Relationships\n\n- Wife: Priya/);
});

test('writing the same fact twice is a no-op', () => {
  const doc = '# User\n\n## Identity\n\n- Name: Sam\n';
  assert.equal(Memory.insertUnderSection(doc, 'Identity', 'name: sam'), null);
  assert.equal(Memory.insertUnderSection(doc, 'Identity', 'Name: Sam.'), null);
});

test('deleting a line is how the user makes Reflect forget', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });
  await Memory.addFact({ section: 'Relationships', text: 'Dog: Rufus' });

  const { removed } = await Memory.forgetFact('Rufus');
  assert.equal(removed, 1);

  const profile = await Memory.readProfile();
  assert.match(profile, /Priya/);
  assert.doesNotMatch(profile, /Rufus/);
});

// ────────────────────────────────────────────────────────────────── profile

test('an empty profile stays out of the prompt entirely', async () => {
  await resetMemory();
  assert.equal(await Memory.readProfile(), '', 'headings alone must not count as knowledge');
});

test('facts survive a cold reload of the module', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const fresh = await import(`../src/store/MemoryFiles.js?cold=${Date.now()}`);
  assert.match(await fresh.readProfile(), /Wife: Priya/);
});

// ────────────────────────────────────────────────────────────────── journal

test('journal entries are timestamped and land in today\'s file', async () => {
  await resetMemory();
  const r = await Memory.appendJournal('Decided Forge delegates orchestration');
  assert.equal(r.written, true);

  const days = await Memory.readJournal(1);
  assert.equal(days.length, 1);
  assert.match(days[0].body, /\d{2}:\d{2} — Decided Forge delegates orchestration/);
});

test('readJournal(0) returns nothing, so depth 1 carries no journal', async () => {
  await Memory.appendJournal('something');
  assert.deepEqual(await Memory.readJournal(0), []);
});

// ────────────────────────────────────────────────────────────────── projects

test('frontmatter round-trips, including alias lists', () => {
  const raw = '---\nname: ReflectForge\naliases: [forge, agent framework]\nstatus: active\n---\n\n# ReflectForge\n\n- Local agent framework\n';
  const { data, body } = Memory.parseFrontmatter(raw);
  assert.equal(data.name, 'ReflectForge');
  assert.deepEqual(data.aliases, ['forge', 'agent framework']);
  assert.match(body, /Local agent framework/);
  assert.match(Memory.serializeFrontmatter(data), /aliases: \[forge, agent framework\]/);
});

test('a project is created on first write and touched on the next', async () => {
  await resetMemory();
  await Memory.upsertProject({
    name: 'ReflectForge',
    aliases: ['forge', 'agent framework'],
    section: 'Decisions',
    text: 'Forge delegates orchestration to agents',
  });

  const doc = await Memory.readProject('reflectforge');
  assert.ok(doc);
  assert.equal(doc.meta.name, 'ReflectForge');
  assert.match(doc.body, /## Decisions/);
  assert.match(doc.body, /delegates orchestration/);

  const list = await Memory.listProjects();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].aliases, ['forge', 'agent framework']);
});

test('a project resolves by alias, which is how indirect recall works', async () => {
  await resetMemory();
  await Memory.upsertProject({ name: 'ReflectForge', aliases: ['forge', 'agent framework'], text: 'x' });
  await Memory.upsertProject({ name: 'Turtles Book', aliases: ['the book', 'book project'], text: 'y' });

  assert.equal((await Memory.resolveProject('I want to rethink my agent framework')).slug, 'reflectforge');
  assert.equal((await Memory.resolveProject('back to the book project again')).slug, 'turtles-book');
  assert.equal(await Memory.resolveProject('what is the weather like'), null);
});

test('the longest alias match wins', async () => {
  await resetMemory();
  await Memory.upsertProject({ name: 'Reflect', aliases: ['reflect'], text: 'a' });
  await Memory.upsertProject({ name: 'Reflect Forge', aliases: ['reflect forge'], text: 'b' });
  const hit = await Memory.resolveProject('lets work on reflect forge today');
  assert.equal(hit.slug, 'reflect-forge');
});

// ─────────────────────────────────────────────────────────────────── recall

test('chunks are collected across every memory file', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });
  await Memory.upsertProject({ name: 'Turtles Book', section: 'Decisions', text: 'Darker retelling' });
  await Memory.appendJournal('Stuck on whether Splinter survives');

  const chunks = await Memory.collectChunks();
  const kinds = new Set(chunks.map((c) => c.kind));
  assert.ok(kinds.has('profile') && kinds.has('project') && kinds.has('journal'));
  assert.ok(chunks.some((c) => c.text.includes('Priya') && c.section === 'Relationships'));
});

test('search finds a fact by its exact token', async () => {
  const chunks = await Memory.collectChunks();
  const hits = search('what is my wife called', chunks);
  assert.ok(hits.length, 'expected at least one hit');
  assert.match(hits[0].text, /Priya/);
  assert.equal(hits[0].source, 'USER.md');
});

test('search returns an empty list rather than a decision not to search', async () => {
  const chunks = await Memory.collectChunks();
  assert.deepEqual(search('quantum chromodynamics', chunks), []);
  assert.deepEqual(search('', chunks), []);
});

test('the curated profile outranks a journal line with the same words', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Preferences', text: 'Prefers deep analysis over short replies' });
  await Memory.appendJournal('short replies felt wrong today');

  const hits = search('do I want short replies', await Memory.collectChunks());
  assert.equal(hits[0].kind, 'profile');
});

test('tokenizing drops stopwords but keeps proper nouns', () => {
  assert.deepEqual(tokenize('What is the name of my Vespa GTS300'), ['name', 'vespa', 'gts300']);
});

// ───────────────────────────────────────────────────────────── explicit save

test('explicit save is detected across the phrasings people actually use', () => {
  for (const phrasing of [
    'Remember this: my wife is Priya',
    'remember that my wife is Priya',
    'Please remember my wife is Priya',
    'note that my wife is Priya',
    "don't forget my wife is Priya",
    'make a note of my wife is Priya',
  ]) {
    const hit = detectExplicitSave(phrasing);
    assert.ok(hit, `not detected: ${phrasing}`);
    assert.equal(hit.kind, 'save');
    assert.match(hit.content, /wife is Priya/i);
  }
});

test('a bare question about remembering is not a save instruction', () => {
  assert.equal(detectExplicitSave('do you remember?'), null);
  assert.equal(detectExplicitSave('remember?'), null);
  assert.equal(detectExplicitSave('what do you remember about me'), null);
});

test('explicit save writes to USER.md and always wins', async () => {
  await resetMemory();
  const result = await applyExplicit('Remember this: my wife is Priya');
  assert.equal(result.written, true);
  assert.equal(result.target, 'USER.md');
  assert.match(await Memory.readProfile(), /my wife is Priya/i);
});

test('a save naming a known project lands in that project file', async () => {
  await resetMemory();
  await Memory.upsertProject({ name: 'ReflectForge', aliases: ['forge'], text: 'seed' });

  const result = await applyExplicit('Remember that ReflectForge ships without a plugin API');
  assert.equal(result.target, 'projects/reflectforge.md');

  const doc = await Memory.readProject('reflectforge');
  assert.match(doc.body, /plugin API/);
  assert.doesNotMatch(await Memory.readProfile(), /plugin API/, 'must not double-write to the profile');
});

test('saving the same thing twice reports "already known" instead of duplicating', async () => {
  await resetMemory();
  await applyExplicit('Remember this: I ride a Vespa GTS300');
  const second = await applyExplicit('Remember this: I ride a Vespa GTS300');
  assert.equal(second.written, false);
  assert.equal(second.reason, 'already known');

  const count = (await Memory.readProfile()).split('Vespa').length - 1;
  assert.equal(count, 1);
});

test('forget removes the fact', async () => {
  await resetMemory();
  await applyExplicit('Remember this: I ride a Vespa GTS300');
  const result = await applyExplicit('Forget that I ride a Vespa GTS300');
  assert.equal(result.action, 'forget');
  assert.equal(result.written, true);
  assert.doesNotMatch(await Memory.readProfile(), /Vespa/);
});

test('an ordinary message triggers no write at all', async () => {
  assert.equal(await applyExplicit('What is the capital of France?'), null);
});

// ─────────────────────────────────────────────────────────────── memory tools

test('every tool schema is well formed', () => {
  assert.equal(TOOL_SCHEMAS.length, 3);
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.name && t.function.description);
    assert.equal(t.function.parameters.type, 'object');
    assert.ok(Array.isArray(t.function.parameters.required));
  }
});

test('memory_search returns readable lines with their source', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });
  const { result } = await runTool('memory_search', { query: 'wife' });
  assert.match(result, /USER\.md/);
  assert.match(result, /Priya/);
});

test('memory_search says so plainly when nothing matches', async () => {
  const { result } = await runTool('memory_search', { query: 'chromodynamics' });
  assert.match(result, /No memories matched/);
});

test('memory_write files a fact and reports where it went', async () => {
  await resetMemory();
  const { result, write } = await runTool('memory_write', {
    text: 'Prefers local-first tools',
    target: 'profile',
    section: 'Preferences',
  });
  assert.match(result, /Saved to USER\.md under Preferences/);
  assert.equal(write.written, true);
  assert.match(await Memory.readProfile(), /Prefers local-first tools/);
});

test('memory_write can create a project by name', async () => {
  await resetMemory();
  await runTool('memory_write', { text: 'Uses Ollama as the backend', target: 'ReflectForge', section: 'Decisions' });
  const doc = await Memory.readProject('reflectforge');
  assert.match(doc.body, /Uses Ollama as the backend/);
});

test('memory_get reads a file and refuses to escape the memory directory', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Name: Sam' });
  assert.match(await readMemoryPath('USER.md'), /Name: Sam/);
  assert.equal(await readMemoryPath('../../etc/passwd'), null);
  assert.equal(await readMemoryPath('projects/nonexistent'), null);
});

test('a failing tool returns text the model can recover from, not an exception', async () => {
  const { result } = await runTool('not_a_tool', {});
  assert.match(result, /Unknown tool/);
});

// ────────────────────────────────────────────────────── prompt integration

test('the journal rides in the frozen prefix, memories in the fenced user turn', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });
  await Memory.appendJournal('Working on the turtles book');

  const soul = await loadSoul();
  const budget = plan({ contextLength: 32768, depth: 4 });
  const { messages, trace } = build({
    soul,
    profile: await Memory.readProfile(),
    journal: await Memory.readJournal(budget.limits.journalDays),
    memories: search('wife', await Memory.collectChunks(), { limit: 3 }),
    turns: [],
    message: 'what is her name?',
    budget,
  });

  const system = messages[0].content;
  assert.match(system, /Wife: Priya/);
  assert.match(system, /Recent days/);
  assert.ok(!system.includes(FENCE_OPEN), 'memories must never enter the frozen prefix');

  assert.ok(messages.at(-1).content.startsWith(FENCE_OPEN));
  assert.ok(trace.memoriesIncluded > 0);
  assert.equal(trace.journalDays, 1);
});

test('the prefix stays byte-identical while recalled memories change', async () => {
  const soul = await loadSoul();
  const budget = plan({ contextLength: 32768, depth: 4 });
  const common = {
    soul,
    profile: await Memory.readProfile(),
    journal: await Memory.readJournal(1),
    turns: [],
    budget,
  };
  const a = build({ ...common, message: 'one', memories: [{ text: 'x', source: 'USER.md' }] });
  const b = build({ ...common, message: 'two', memories: [{ text: 'y', source: 'journal/today.md' }] });
  assert.equal(a.messages[0].content, b.messages[0].content);
});

// ───────────────────────────────────────────── the M2 acceptance scenario

test('ACCEPTANCE: save a fact, then answer from it in a fresh process', async () => {
  await resetMemory();

  // Conversation 1 — the user asks Reflect to remember something.
  const saved = await applyExplicit('Remember this: my wife is named Priya');
  assert.equal(saved.written, true);
  assert.equal(saved.target, 'USER.md');

  // Everything now lives on disk. Reload every module from scratch: this is a
  // different process for all purposes that matter.
  const stamp = Date.now();
  const coldMemory = await import(`../src/store/MemoryFiles.js?acc=${stamp}`);
  const coldRecall = await import(`../src/recall/Keyword.js?acc=${stamp}`);
  const coldSoul = await import(`../src/modes/Soul.js?acc=${stamp}`);
  const coldAssembler = await import(`../src/context/PromptAssembler.js?acc=${stamp}`);

  // Conversation 2 — brand new, no prior turns, asking indirectly.
  const budget = plan({ contextLength: 32768, depth: 3 });
  const chunks = await coldMemory.collectChunks();
  const memories = coldRecall.search("what is my wife's name?", chunks, {
    limit: budget.limits.memories,
  });

  const { messages } = coldAssembler.build({
    soul: await coldSoul.loadSoul(),
    profile: await coldMemory.readProfile(),
    journal: await coldMemory.readJournal(budget.limits.journalDays),
    memories,
    turns: [], // a genuinely new conversation
    message: "what is my wife's name?",
    budget,
  });

  const prompt = messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Priya/, 'the answer must be reachable with zero conversation history');
  assert.ok(memories.some((m) => /Priya/.test(m.text)), 'recall should surface it, not just the profile');
});

test('the write tool is withheld on a turn that already saved', async () => {
  const { toolsFor } = await import('../src/reflect/MemoryTools.js');
  const names = (list) => list.map((t) => t.function.name);
  // Only the memory *write* is withheld. Saving a fact does not mean the turn
  // has finished doing things — "remember that, and remind me on Monday" has to
  // still be able to make the task.
  const after = names(toolsFor({ justWrote: true }));
  assert.deepEqual(
    after.filter((n) => n.startsWith('memory_') || n === 'task_create'),
    ['memory_search', 'memory_get', 'task_create']
  );
  assert.ok(!after.includes('memory_write'));
  assert.ok(names(toolsFor({})).includes('memory_write'));

  // Reaching the person is not a memory write, so having just saved something
  // does not stop Reflect telling you about it. Only offered where it can work,
  // which is why this asks the module rather than hard-coding a platform.
  const { available } = await import('../src/deliver/Deliver.js');
  assert.equal(after.includes('notify'), available(), 'notify should follow platform support');
});

test('REGRESSION: an oblique reference reaches a project whose bullets never say the word', async () => {
  await resetMemory();
  await Memory.upsertProject({
    name: 'Turtles Book',
    aliases: ['the book', 'book project'],
    section: 'Decisions',
    text: 'Darker and more adult, without losing the original personalities',
  });

  // The bullet contains neither "book" nor "idea" — only the project's title does.
  const hits = search('I want to work on that book idea again', await Memory.collectChunks());
  assert.ok(hits.length, 'oblique project reference found nothing');
  assert.equal(hits[0].source, 'projects/turtles-book.md');
  assert.doesNotMatch(hits[0].text, /book/i, 'the match must come from the title, not the text');
});

test('REGRESSION: a project is not forked by a different phrasing of its name', async () => {
  // Observed live: conversation A created projects/turtles-book.md, then
  // conversation B created projects/the-turtles-book.md for the same book,
  // splitting its memory in half.
  await resetMemory();
  await Memory.upsertProject({ name: 'Turtles Book', section: 'Decisions', text: 'Darker retelling' });
  await Memory.upsertProject({ name: 'The Turtles Book', section: 'Open', text: 'Splinter unresolved' });

  const projects = await Memory.listProjects();
  assert.equal(projects.length, 1, 'the same book must not become two projects');
  assert.equal(projects[0].slug, 'turtles-book', 'the leading article is normalized away, not aliased');

  const doc = await Memory.readProject('turtles-book');
  assert.match(doc.body, /Darker retelling/);
  assert.match(doc.body, /Splinter unresolved/);

  // A name that is genuinely different is recorded as an alias, so it resolves
  // directly next time rather than relying on the slug rules again.
  await Memory.upsertProject({ slug: 'turtles-book', name: 'the book', text: 'Chapter two started' });
  const after = await Memory.listProjects();
  assert.equal(after.length, 1);
  assert.ok(after[0].aliases.includes('the book'));
});

test('REGRESSION: a restatement with extra detail counts as already known', async () => {
  // Observed live: the same decision landed under both Decisions and Open in
  // one project file, because Jaccard punished the longer line for its extra
  // words. Measuring against the shorter line is the right comparison.
  const { isSameFact } = await import('../src/store/MemoryFiles.js');
  assert.ok(
    isSameFact(
      'The Turtles Book will be darker and more adult while preserving the original personalities.',
      "Darker, more adult tone while keeping original characters' personalities intact."
    )
  );
  assert.ok(!isSameFact('Wife: Priya', 'Daughter: Maya'));
  assert.ok(!isSameFact('Rides a Vespa GTS300', 'Sold the Vespa last April to buy a truck'));
});

test('REGRESSION: a differently-worded restatement of the same fact is caught at 0.5', async () => {
  // Four separate near-misses in testing all landed between 0.5 and 0.55.
  const { isSameFact } = await import('../src/store/MemoryFiles.js');
  assert.ok(isSameFact('Hobbies: Vespa GTS300 motorcycle rider', 'Rides a Vespa GTS300'));
  assert.ok(isSameFact("The user's wife is Priya.", 'Wife: Priya'));

  // One shared word is coincidence, not duplication — these are opposite facts.
  assert.ok(!isSameFact('Rides a Vespa GTS300', 'Sold the Vespa last April to buy a truck'));
  assert.ok(!isSameFact('Wife: Priya', 'Daughter: Maya'));
  assert.ok(!isSameFact('Lives in Portland', 'Works as a product manager'));
});

test('REGRESSION: sharing only qualifier words is not sharing a fact', async () => {
  // The adversarial sweep saved two different favourites at the same time and
  // the second vanished as "already known". Both statements share *my* and
  // *favourite* — two words, ratio 0.50, exactly the score of a genuine
  // duplicate. No threshold separates them; only the words themselves do.
  const { isSameFact } = await import('../src/store/MemoryFiles.js');

  assert.ok(!isSameFact('my favourite colour is oxblood.', 'my favourite season is autumn.'));
  assert.ok(!isSameFact('my favourite band is Radiohead', 'my favourite food is ramen'));
  assert.ok(!isSameFact('I like my coffee black', 'I like my steak rare'));

  // The subject still decides when it genuinely is the same fact.
  assert.ok(isSameFact('my favourite colour is oxblood', 'Favourite colour: oxblood'));
  assert.ok(isSameFact('Hobbies: Vespa GTS300 motorcycle rider', 'Rides a Vespa GTS300'));
  assert.ok(isSameFact("The user's wife is Priya.", 'Wife: Priya'));
});

test('REGRESSION: two facts saved at once both survive', async () => {
  // The end-to-end version of the above: this is what the user actually loses.
  await resetMemory();
  const a = await Memory.addFact({ section: 'Preferences', text: 'my favourite colour is oxblood' });
  const b = await Memory.addFact({ section: 'Preferences', text: 'my favourite season is autumn' });

  assert.equal(a.written, true);
  assert.equal(b.written, true, `the second was discarded as "${b.reason}"`);

  const profile = await Memory.readProfile();
  assert.match(profile, /oxblood/);
  assert.match(profile, /autumn/);
});
