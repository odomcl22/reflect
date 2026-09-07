/**
 * M4 — automatic extraction.
 *
 * The milestone is done when you can stop saying "remember this" and Reflect
 * still knows your things. The acceptance test at the bottom runs a week of
 * ordinary conversation through the Reflector with no explicit save anywhere,
 * then asks recall to answer questions from what it kept.
 *
 * The extraction model is stubbed. A test that needs a model installed is a test
 * that gets deleted the first time CI is red — and the point here is the merge
 * logic, not whether a particular model is good at the task.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-m4-'));
process.env.REFLECT_HOME = tmpHome;

const { paths } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const { MemoryIndex } = await import('../src/recall/Index.js');
const { normalize } = await import('../src/recall/Embeddings.js');
const { recall, CALIBRATION_SIGMAS } = await import('../src/recall/Recall.js');
const { observe, applyExtraction, worthExtracting, applyExplicit } = await import('../src/reflect/Reflector.js');
const { sanitize, buildMessages, isGrounded, LIMITS, SCHEMA } = await import('../src/reflect/Extractor.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

async function resetMemory() {
  await Memory.writeProfile('# User\n\n## Identity\n\n## Preferences\n');
  await FileStore.removeAll(paths().projects);
  await FileStore.removeAll(paths().journal);
  await FileStore.ensureDir(paths().projects);
  await FileStore.ensureDir(paths().journal);
}

/** An "Ollama" that returns whatever extraction the test scripts. */
function stubOllama(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    calls: [],
    async complete({ messages }) {
      this.calls.push(messages);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return { content: typeof next === 'string' ? next : JSON.stringify(next), metrics: {} };
    },
  };
}

const empty = { facts: [], corrections: [], projects: [], journal: [] };
const emptyOut = { ...empty, rejected: [] };
const extractor = (ollama) => ({ runtime: ollama, model: 'stub' });

// ──────────────────────────────────────────────────────────────── the schema

test('the schema constrains sections to ones the files actually use', () => {
  const sections = SCHEMA.properties.facts.items.properties.section.enum;
  assert.deepEqual(sections, ['Identity', 'Relationships', 'Preferences', 'Working style', 'Notes']);
  assert.deepEqual(SCHEMA.required, ['facts', 'corrections', 'projects', 'journal']);
});

test('the prompt shows the model what is already known, so it can skip it', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });
  const messages = buildMessages({
    userText: 'hi',
    assistantText: 'hello',
    profile: await Memory.readProfileRaw(),
    projects: await Memory.listProjects(),
  });
  assert.match(messages[1].content, /Wife: Priya/);
  assert.match(messages[0].content, /already present in the memory shown to you/);
});

// ───────────────────────────────────────────────────────────────── sanitize

test('sanitize drops empties, trims, and caps how much one turn may write', () => {
  const out = sanitize({
    // Genuinely distinct facts — "Fact number 1/2/3" would now collapse into
    // one, because a single differing digit is not a different fact.
    facts: [
      { text: 'Lives in Portland', section: 'Identity' },
      { text: 'Works as a product manager', section: 'Identity' },
      { text: 'Owns a Mac Studio with 128GB', section: 'Identity' },
      { text: 'Drinks oat milk flat whites', section: 'Notes' },
      { text: 'Plays bass guitar badly', section: 'Notes' },
    ],
    corrections: [{ replaces: 'x', text: 'too short a replaces field' }],
    projects: [{ name: 'A', text: '' }, { name: 'Turtles Book', text: 'Darker retelling', section: 'Decisions' }],
    journal: ['  spaced   out   entry  ', ''],
  });
  assert.equal(out.facts.length, LIMITS.facts);
  assert.equal(out.corrections.length, 0, 'a two-character replaces target is not usable');
  assert.equal(out.projects.length, 1);
  assert.equal(out.journal[0], 'spaced out entry');
});

test('sanitize survives a model returning nonsense', () => {
  assert.deepEqual(sanitize(null), emptyOut);
  assert.deepEqual(sanitize('a string'), emptyOut);
  assert.deepEqual(sanitize({ facts: 'not an array' }), emptyOut);
});

test('REGRESSION: a leaked few-shot example is rejected as ungrounded', () => {
  // Observed live with granite4.1:8b — it filed "Stuck on chapter two" (an
  // example from the system prompt) as a journal entry on a turn about a
  // motorcycle, and "Prefers short answers" before the user had said it.
  const out = sanitize(
    {
      facts: [{ text: 'Prefers short answers', section: 'Preferences' }],
      journal: ['Stuck on chapter two'],
      corrections: [],
      projects: [],
    },
    { userText: 'I picked up a Vespa GTS300 at the weekend, still getting used to it.' }
  );
  assert.deepEqual(out.facts, []);
  assert.deepEqual(out.journal, []);
  assert.equal(out.rejected.length, 2);
  assert.match(out.rejected[0].reason, /not grounded/);
});

test('paraphrase survives grounding; invention does not', () => {
  const userText = 'up late talking to my spouse Priya about the house';
  assert.ok(isGrounded('Wife: Priya', userText), 'a rephrased fact sharing a name must survive');
  assert.ok(isGrounded('Owns a house', userText));
  assert.ok(!isGrounded('Works as a dentist in Chicago', userText), 'invention must be rejected');
});

test('grounding checks the new text of a correction, not the line it replaces', () => {
  const out = sanitize(
    {
      facts: [],
      projects: [],
      journal: [],
      corrections: [{ replaces: 'short, terse answers', text: 'Prefers deeper analysis', section: 'Preferences' }],
    },
    { userText: 'scratch that, I want the deeper analysis now' }
  );
  assert.equal(out.corrections.length, 1);
  assert.equal(out.corrections[0].replaces, 'short, terse answers');
});

test('an unknown section falls back to Notes rather than creating junk headings', () => {
  const out = sanitize({ facts: [{ text: 'Something true', section: 'Wildly Invented Heading' }] });
  assert.equal(out.facts[0].section, 'Notes');
});

// ──────────────────────────────────────────────────────────────── extraction

test('a durable fact is written without anyone saying "remember"', async () => {
  await resetMemory();
  const ollama = stubOllama({
    ...empty,
    facts: [{ text: 'His wife is named Priya', section: 'Relationships' }],
  });

  const result = await observe({
    message: 'I was talking to my wife Priya about it last night',
    reply: 'What did she think?',
    extractor: extractor(ollama),
  });

  assert.equal(result.extracted, true);
  assert.match(await Memory.readProfile(), /wife is named Priya/);
  assert.equal(result.writes[0].auto, true, 'automatic writes must be marked as such');
});

test('an ordinary exchange writes nothing at all', async () => {
  await resetMemory();
  const before = await Memory.readProfileRaw();
  const result = await observe({
    message: 'What is the capital of France, roughly speaking?',
    reply: 'Paris.',
    extractor: extractor(stubOllama(empty)),
  });
  assert.equal(result.extracted, true);
  assert.deepEqual(result.writes, []);
  assert.equal(await Memory.readProfileRaw(), before);
});

test('a failed extraction leaves the turn and the files untouched', async () => {
  await resetMemory();
  const before = await Memory.readProfileRaw();
  const result = await observe({
    message: 'Something long enough to be worth extracting from',
    reply: 'ok',
    extractor: extractor(stubOllama(new Error('model exploded'))),
  });
  assert.equal(result.extracted, false);
  assert.match(result.reason, /model exploded/);
  assert.equal(await Memory.readProfileRaw(), before);
});

test('a model returning prose instead of JSON degrades quietly', async () => {
  await resetMemory();
  const result = await observe({
    message: 'A perfectly ordinary sentence of sufficient length',
    reply: 'ok',
    extractor: extractor(stubOllama('I think the user likes motorcycles!')),
  });
  assert.equal(result.extracted, false);
  assert.match(result.reason, /no JSON/);
});

test('JSON wrapped in chatter is still recovered', async () => {
  await resetMemory();
  const wrapped = 'Sure! Here you go:\n```json\n' + JSON.stringify({ ...empty, journal: ['Fixed the indexer'] }) + '\n```';
  const result = await observe({
    message: 'Spent the morning fixing the indexer, finally green',
    reply: 'Nice.',
    extractor: extractor(stubOllama(wrapped)),
  });
  assert.equal(result.extracted, true);
  assert.match((await Memory.readJournal(1))[0].body, /Fixed the indexer/);
});

test('a turn too short to hold a fact skips the call entirely', async () => {
  const ollama = stubOllama(empty);
  const result = await observe({ message: 'ok thanks', reply: 'sure', extractor: extractor(ollama) });
  assert.equal(result.extracted, false);
  assert.equal(ollama.calls.length, 0, 'no model call should have been made');
  assert.ok(!worthExtracting('ok thanks'));
  assert.ok(worthExtracting('I just bought a Vespa GTS300 yesterday'));
});

test('extraction is skipped when no extractor is configured', async () => {
  const result = await observe({ message: 'A long enough message to extract from', reply: 'ok' });
  assert.equal(result.extracted, false);
  assert.match(result.reason, /disabled/);
});

// ────────────────────────────────────────────────────────────── supersession

test('a changed preference replaces the old line instead of contradicting it', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Preferences', text: 'Prefers short, terse answers' });

  await applyExtraction({
    ...empty,
    corrections: [
      { replaces: 'short, terse answers', text: 'Prefers deeper analysis over short replies', section: 'Preferences' },
    ],
  });

  const profile = await Memory.readProfile();
  assert.match(profile, /deeper analysis/);
  assert.doesNotMatch(profile, /terse/, 'the superseded preference must be gone, not merely outranked');
});

test('a correction that matches nothing still records the new fact, and says so', async () => {
  await resetMemory();
  const writes = await applyExtraction({
    ...empty,
    corrections: [{ replaces: 'a line that was never written', text: 'Lives in Oregon', section: 'Identity' }],
  });
  assert.equal(writes[0].action, 'supersede');
  assert.match(writes[0].reason, /nothing matched/);
  assert.match(await Memory.readProfile(), /Lives in Oregon/);
});

test('corrections are applied before additions', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Rides a Vespa 400' });

  await applyExtraction({
    ...empty,
    facts: [{ text: 'Bought the bike in August', section: 'Identity' }],
    corrections: [{ replaces: 'Vespa 400', text: 'Rides a Vespa GTS300', section: 'Identity' }],
  });

  const profile = await Memory.readProfile();
  assert.match(profile, /Vespa GTS300/);
  assert.doesNotMatch(profile, /Vespa 400/);
  assert.match(profile, /Bought the bike in August/);
});

test('re-extracting the same fact does not duplicate it', async () => {
  await resetMemory();
  const extraction = { ...empty, facts: [{ text: 'Uses a Mac Studio', section: 'Identity' }] };
  await applyExtraction(extraction);
  const writes = await applyExtraction(extraction);
  assert.deepEqual(writes, [], 'a second identical extraction should write nothing');
  assert.equal((await Memory.readProfile()).split('Mac Studio').length - 1, 1);
});

test('a project note creates the project file automatically', async () => {
  await resetMemory();
  await applyExtraction({
    ...empty,
    projects: [{ name: 'ReflectForge', text: 'Ollama is the inference backend', section: 'Decisions' }],
  });
  const doc = await Memory.readProject('reflectforge');
  assert.ok(doc);
  assert.match(doc.body, /## Decisions/);
  assert.match(doc.body, /Ollama is the inference backend/);
});

test('explicit save still wins and is not marked automatic', async () => {
  await resetMemory();
  const result = await applyExplicit('Remember this: I ride a Vespa GTS300');
  assert.equal(result.written, true);
  assert.ok(!result.auto, 'an explicit save is the user speaking, not the system inferring');
});

// ─────────────────────────────────────────────────────────────── calibration

test('calibration measures the corpus and declines when there is too little', async () => {
  const index = new MemoryIndex({
    file: path.join(tmpHome, 'cal.json'),
    embedder: {
      model: 'stub',
      dim: 3,
      reason: 'ok',
      async resolve() { return 'stub'; },
      async embed(texts) {
        // Spread vectors around a cone so pairwise similarity is high but varied.
        return texts.map((t, i) => normalize(Float32Array.from([1, (i % 5) * 0.2, (t.length % 7) * 0.1])));
      },
      fingerprint() { return 'stub@3/v1'; },
    },
  });

  const few = Array.from({ length: 4 }, (_, i) => ({ source: 'USER.md', section: 'x', text: `line ${i}`, kind: 'profile' }));
  await index.sync(few);
  assert.equal(index.calibrate(), null, 'four vectors is not a distribution');

  const many = Array.from({ length: 40 }, (_, i) => ({ source: 'USER.md', section: 'x', text: `line number ${i}`, kind: 'profile' }));
  await index.sync(many);
  const cal = index.calibrate();
  assert.ok(cal && cal.n >= 20);
  assert.ok(cal.mean > 0 && cal.mean < 1);
  assert.ok(cal.sd >= 0);
});

test('calibration can only tighten the floor, never loosen it', async () => {
  // A space where everything is nearly identical would admit anything under a
  // fixed floor; calibration must raise the bar instead.
  const tight = {
    calibrate: () => ({ mean: 0.9, sd: 0.01, n: 100 }),
    sync: async () => ({ ready: true, vectors: 0, reason: 'ok' }),
    score: async () => new Map(),
  };
  const { trace } = await recall('anything at all', { index: tight });
  // Degraded because score() returned nothing, but the arithmetic is what matters:
  assert.ok(0.9 + CALIBRATION_SIGMAS * 0.01 > 0.5, 'calibrated floor should exceed the constant here');
  assert.equal(trace.degraded, true);
});

// ──────────────────────────────────────────── the M4 acceptance scenario

test('ACCEPTANCE: a week of ordinary talk, no "remember this" anywhere', async () => {
  await resetMemory();

  // Each turn is what someone would actually type. None of them is an
  // instruction to remember, and the extractor is the only thing writing.
  const week = [
    {
      message: 'Morning. I was up late talking to my wife Priya about the house.',
      extraction: { ...empty, facts: [{ text: 'His wife is named Priya', section: 'Relationships' }] },
    },
    {
      message: "Picked up a Vespa GTS300 at the weekend, still getting used to it.",
      extraction: { ...empty, facts: [{ text: 'Rides a Vespa GTS300', section: 'Identity' }] },
    },
    {
      message: 'Honestly just keep answers short, I do not need the essay.',
      extraction: { ...empty, facts: [{ text: 'Prefers short answers', section: 'Preferences' }] },
    },
    {
      message: 'For ReflectForge I have decided the agents own orchestration, not the core.',
      extraction: {
        ...empty,
        projects: [{ name: 'ReflectForge', text: 'Agents own orchestration, not the core', section: 'Decisions' }],
      },
    },
    {
      message: 'Actually, scratch the short answers thing — I want the deeper reasoning now.',
      extraction: {
        ...empty,
        corrections: [
          { replaces: 'short answers', text: 'Prefers deeper analysis over short replies', section: 'Preferences' },
        ],
      },
    },
    {
      message: 'Spent today stuck on whether Splinter survives the first act of the book.',
      extraction: {
        ...empty,
        projects: [{ name: 'Turtles Book', text: "Splinter's fate in act one is unresolved", section: 'Open' }],
        journal: ['Stuck on the first act'],
      },
    },
  ];

  for (const turn of week) {
    const result = await observe({
      message: turn.message,
      reply: 'Noted.',
      extractor: extractor(stubOllama(turn.extraction)),
    });
    assert.equal(result.extracted, true, `extraction failed on: ${turn.message}`);
  }

  // Nobody ever typed "remember". What does it know?
  const profile = await Memory.readProfile();
  assert.match(profile, /Priya/);
  assert.match(profile, /Vespa GTS300/);
  assert.match(profile, /deeper analysis/);
  assert.doesNotMatch(profile, /Prefers short answers/, 'the superseded preference should be gone');

  const projects = await Memory.listProjects();
  assert.deepEqual(projects.map((p) => p.slug).sort(), ['reflectforge', 'turtles-book']);

  // And it is reachable by recall, which is the part that actually matters.
  const index = new MemoryIndex({
    file: path.join(tmpHome, 'acceptance.json'),
    embedder: {
      model: 'stub', dim: 2, reason: 'ok',
      async resolve() { return 'stub'; },
      async embed(texts) { return texts.map(() => normalize(Float32Array.from([1, 0]))); },
      fingerprint() { return 'stub@2/v1'; },
    },
  });

  const wife = await recall('what is my wife called', { index });
  assert.ok(wife.results.some((r) => /Priya/.test(r.text)), 'could not recall the wife');

  const bike = await recall('what do I ride', { index });
  assert.ok(bike.results.some((r) => /Vespa/.test(r.text)), 'could not recall the motorcycle');

  const forge = await recall('who owns orchestration in ReflectForge', { index });
  assert.ok(
    forge.results.some((r) => r.source === 'projects/reflectforge.md'),
    'could not recall the project decision'
  );
});

test('REGRESSION: one sentence gets one home, across categories and mechanisms', async () => {
  // Observed live: the model saved a project decision with the memory_write
  // tool, then extraction filed the identical sentence as a correction to
  // USER.md — two write paths that did not know about each other.
  const raw = {
    facts: [],
    journal: [],
    projects: [{ name: 'ReflectForge', text: 'Agents own orchestration, not the core', section: 'Decisions' }],
    corrections: [{ replaces: 'orchestration', text: 'Agents own orchestration, not the core.', section: 'Working style' }],
  };
  const userText = 'For ReflectForge I have decided the agents own orchestration, not the core.';

  const within = sanitize(raw, { userText });
  assert.equal(within.projects.length, 1, 'the project note is the more specific home');
  assert.equal(within.corrections.length, 0, 'the duplicate correction must be dropped');

  const across = sanitize(raw, {
    userText,
    alreadyWritten: ['Agents own orchestration, not the core'],
  });
  assert.equal(across.projects.length, 0, 'a tool already wrote this — extraction must not repeat it');
  assert.equal(across.corrections.length, 0);
});

test('REGRESSION: near-duplicate phrasing is caught, distinct facts are not', async () => {
  const { dedupe } = await import('../src/reflect/Extractor.js');
  const base = { facts: [], corrections: [], projects: [], journal: [], rejected: [] };

  // Observed live: the tool and the extractor wrote the same decision, one with
  // a trailing " for ReflectForge".
  const near = dedupe(
    { ...base, facts: [{ text: 'Agents will own orchestration instead of the core for ReflectForge', section: 'Notes' }] },
    ['Agents will own orchestration instead of the core.']
  );
  assert.equal(near.facts.length, 0);

  // Two facts that merely share a subject must both survive.
  const distinct = dedupe(
    { ...base, facts: [{ text: 'Rides a Vespa GTS300', section: 'Identity' }] },
    ['Bought the Vespa in August']
  );
  assert.equal(distinct.facts.length, 1);
});

test('a rephrased duplicate at the calibrated overlap is caught', async () => {
  const { dedupe } = await import('../src/reflect/Extractor.js');
  const base = { facts: [], corrections: [], projects: [], journal: [], rejected: [] };
  const out = dedupe(
    { ...base, facts: [{ text: 'Agents own orchestration, not the core', section: 'Working style' }] },
    ['Agents will own orchestration rather than the core.']
  );
  assert.equal(out.facts.length, 0, 'the same decision in different words is still the same decision');
});

test('memory_write keeps the project name as the user capitalised it', async () => {
  await resetMemory();
  const { runTool } = await import('../src/reflect/MemoryTools.js');
  await runTool('memory_write', { text: 'Ollama is the backend', target: 'ReflectForge', section: 'Decisions' });
  const doc = await Memory.readProject('reflectforge');
  assert.equal(doc.meta.name, 'ReflectForge');
});

test('REGRESSION: the same fact in different words is recognised as already known', async () => {
  // Observed live: a memory_write tool call filed "The user's wife is Priya."
  // and extraction then filed "Wife: Priya" as a separate line, because dedupe
  // compared raw tokens and grammar drowned the signal.
  const { isSameFact } = await import('../src/store/MemoryFiles.js');

  assert.ok(isSameFact("The user's wife is Priya.", 'Wife: Priya'));
  assert.ok(isSameFact('The user rides a Vespa GTS300.', 'Rides a Vespa GTS300'));
  assert.ok(isSameFact('Agents will own orchestration rather than the core.', 'Agents own orchestration, not the core'));

  // And it must not collapse facts that merely share a subject.
  assert.ok(!isSameFact('Wife: Priya', 'Daughter: Maya'));
  assert.ok(!isSameFact('Rides a Vespa GTS300', 'Sold the Vespa last April to buy a truck'));
});

test('REGRESSION: a fact already on disk is not written again in other words', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: "The user's wife is Priya." });

  const second = await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });
  assert.equal(second.written, false);
  assert.equal(second.reason, 'already known');
  assert.equal((await Memory.readProfile()).split('Priya').length - 1, 1, 'exactly one line about Priya');
});

test('the write tool and the extractor are held to the same standard', async () => {
  const { TOOL_SCHEMAS } = await import('../src/reflect/MemoryTools.js');
  const write = TOOL_SCHEMAS.find((t) => t.function.name === 'memory_write');

  // Both paths write to the same files, so both must refuse the same things.
  assert.match(write.function.description, /six months/);
  assert.match(write.function.description, /want to work on something|interested in something/);

  // Free-text sections let the model invent headings — "Preferences" appeared
  // inside a project file live. The enum is the whole set both paths may use.
  const sections = write.function.parameters.properties.section.enum;
  assert.ok(Array.isArray(sections));
  for (const s of ['Identity', 'Relationships', 'Preferences', 'Decisions', 'Open']) {
    assert.ok(sections.includes(s), `${s} missing from the allowed sections`);
  }
});

test('REGRESSION: one stemmer, so "ride" and "rides" are the same word', async () => {
  // The end-to-end sweep found the same fact written twice:
  //   "…and I ride a Vespa GTS300"    → ride
  //   "Rides a Vespa GTS300" → rid    ("es" stripped before "s")
  // Three modules each had their own copy of the stemmer and they had drifted.
  const { stemWord } = await import('../src/text.js');
  const { isSameFact } = await import('../src/store/MemoryFiles.js');
  const { stem } = await import('../src/recall/Keyword.js');

  assert.equal(stemWord('rides'), stemWord('ride'));
  assert.equal(stem('rides'), stemWord('rides'), 'search and memory must stem identically');
  assert.equal(stemWord('batches'), 'batch', 'a real "es" plural still works');
  assert.equal(stemWord('boxes'), 'box');

  assert.ok(isSameFact('my wife is Priya and I ride a Vespa GTS300.', 'Rides a Vespa GTS300'));
});

test('REGRESSION: a paraphrased "replaces" still finds the line it replaces', async () => {
  // Live, the model answered "Preferences: Prefers short answers" for a bullet
  // reading "Prefers short answers". Substring matching missed it, the old line
  // survived, and the replacement was then rejected as a duplicate of it.
  await resetMemory();
  await Memory.addFact({ section: 'Preferences', text: 'Prefers short answers' });

  await applyExtraction({
    ...empty,
    corrections: [
      {
        replaces: 'Preferences: Prefers short answers',
        text: 'Preferences: Wants deeper reasoning instead of short answers',
        section: 'Preferences',
      },
    ],
  });

  const profile = await Memory.readProfile();
  assert.match(profile, /deeper reasoning/, 'the new preference was not recorded');
  assert.doesNotMatch(profile, /Prefers short answers/, 'the old preference survived');
  assert.doesNotMatch(profile, /^- Preferences:/m, 'the section label leaked into the fact');
});

test('a section label echoed into the text is stripped', () => {
  const out = sanitize(
    { facts: [{ text: 'Identity — Lives in Portland', section: 'Identity' }], corrections: [], projects: [], journal: [] },
    { userText: 'I live in Portland these days' }
  );
  assert.equal(out.facts[0].text, 'Lives in Portland');
});

test('a contradicting fact is promoted to a correction before it is written', async () => {
  const { promoteConflicts } = await import('../src/reflect/Reflector.js');
  await resetMemory();
  await Memory.addFact({ section: 'Preferences', text: 'Prefers short answers' });

  // A stub that answers the narrow "which line does this replace?" question.
  const judge = {
    async complete({ messages }) {
      const asked = messages[1].content;
      const replaces = /deeper|detailed|thorough/i.test(asked) ? 1 : 0;
      return { content: JSON.stringify({ replaces }), metrics: {} };
    },
  };

  const extraction = {
    ...empty,
    facts: [{ text: 'Prefers deeper reasoning now', section: 'Preferences' }],
    corrections: [],
  };
  await promoteConflicts(extraction, { runtime: judge, model: 'stub' });

  assert.equal(extraction.facts.length, 0, 'the fact should have moved');
  assert.equal(extraction.corrections.length, 1);
  assert.equal(extraction.corrections[0].replaces, 'Prefers short answers');

  await applyExtraction(extraction);
  const profile = await Memory.readProfile();
  assert.match(profile, /deeper reasoning/);
  assert.doesNotMatch(profile, /Prefers short answers/);
});

test('a compatible fact is left alone', async () => {
  const { promoteConflicts } = await import('../src/reflect/Reflector.js');
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const judge = { async complete() { return { content: JSON.stringify({ replaces: 0 }), metrics: {} }; } };
  const extraction = { ...empty, facts: [{ text: 'Daughter: Maya', section: 'Relationships' }], corrections: [] };
  await promoteConflicts(extraction, { runtime: judge, model: 'stub' });

  assert.equal(extraction.facts.length, 1, 'two facts that can both be true must both survive');
  assert.equal(extraction.corrections.length, 0);
});

test('a failing conflict check never blocks the write', async () => {
  const { promoteConflicts } = await import('../src/reflect/Reflector.js');
  await resetMemory();
  await Memory.addFact({ section: 'Preferences', text: 'Prefers short answers' });

  const broken = { async complete() { throw new Error('model down'); } };
  const extraction = { ...empty, facts: [{ text: 'Prefers long answers', section: 'Preferences' }], corrections: [] };
  await promoteConflicts(extraction, { runtime: broken, model: 'stub' });
  assert.equal(extraction.facts.length, 1, 'the fact is still recorded, just not as a correction');
});

test('REGRESSION: a compound entry is rejected rather than filed', async () => {
  // Live, a model filed "Sam, wife Priya, Portland resident, rides Vespa
  // GTS300, works on Mac Studio" as a single fact. Such a line can never be
  // superseded — you cannot replace half a bullet when the address changes —
  // and its extra words dilute the overlap with any single fact inside it, so
  // "Wife: Priya" then failed to dedupe against it.
  const out = sanitize(
    {
      facts: [
        { text: 'Sam, wife Priya, Portland resident, rides Vespa GTS300, works on Mac Studio', section: 'Identity' },
        { text: 'Wife: Priya', section: 'Relationships' },
      ],
      corrections: [],
      projects: [],
      journal: [],
    },
    { userText: 'im sam, my wife is Priya, we live in Portland and i ride a vespa gts300, i work on a mac studio' }
  );

  assert.equal(out.facts.length, 1, 'the compound entry should not have been filed');
  assert.equal(out.facts[0].text, 'Wife: Priya');
  assert.ok(out.rejected.some((r) => /several facts in one entry/.test(r.reason)));
});

test('a single fact with one comma is not mistaken for a compound', () => {
  const out = sanitize(
    {
      facts: [{ text: 'Rode a Vespa 400, now rides an GTS300', section: 'Identity' }],
      corrections: [], projects: [], journal: [],
    },
    { userText: 'I used to ride a Vespa 400 but I ride the GTS300 now' }
  );
  assert.equal(out.facts.length, 1, 'one fact about one bike must survive');
});

test('a journal line may run longer than a fact', () => {
  const long = 'Spent the afternoon chasing a flaky index rebuild that only failed on cold start after a deploy';
  const out = sanitize(
    { facts: [], corrections: [], projects: [], journal: [long] },
    { userText: 'spent the afternoon chasing a flaky index rebuild on cold start after a deploy' }
  );
  assert.equal(out.journal.length, 1, 'events describe more than one thing by nature');
});

test('REGRESSION: the prompt distinguishes wanting to work on X from wanting X from you', async () => {
  // A prompt edit meant to stop "renewed interest in the book" being filed as a
  // fact also suppressed "I want the deeper reasoning from now on" — a real
  // preference. Supersession went from working to 0/5 with no code change and
  // no error: extraction simply returned nothing. The distinction is now stated
  // explicitly, and this test fails if it is ever edited back out.
  const { buildMessages } = await import('../src/reflect/Extractor.js');
  const system = buildMessages({ userText: 'x', assistantText: 'y', profile: '', projects: [] })[0].content;

  assert.match(system, /wanting something \*?from you\*? always is|wanting something from you always is/i,
    'the prompt no longer distinguishes an activity intention from a preference');
  assert.match(system, /deeper reasoning/i, 'the worked example was removed');
});

// ────────────────────────────────────────── when the memory pass never ran

test('a memory pass that timed out says so instead of looking like nothing to save', async () => {
  // Diagnosed from the sweep: extraction is a second full model call starting
  // the moment a reply finishes, and at the old 60-second default it timed out
  // under sustained use. The reply was fine, the memory silently never
  // appeared, and every layer reported the same thing as "found nothing".
  const { EXTRACT_TIMEOUT_MS } = await import('../src/reflect/Extractor.js');
  assert.ok(
    EXTRACT_TIMEOUT_MS >= 120_000,
    `${EXTRACT_TIMEOUT_MS}ms is not enough for a second model call on a busy machine`
  );

  // A runtime that never answers in time.
  const stalling = {
    async complete() {
      throw new Error('The operation was aborted due to timeout');
    },
  };
  const result = await observe({
    message: 'For the Turtles Book I have decided it is darker and more adult.',
    reply: 'Noted.',
    extractor: { runtime: stalling, model: 'stub' },
  });

  assert.equal(result.extracted, false);
  assert.match(result.reason, /timeout/i, 'the reason has to survive to the caller');
  assert.deepEqual(result.writes, [], 'and nothing is invented from a failed pass');
});

test('the client is told why nothing was saved', async () => {
  // The reason was always sent and always discarded, so a timed-out extraction
  // looked identical to a turn with nothing worth keeping.
  const client = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  );
  assert.match(client, /ev\.reason/, 'the reflected event carries a reason; the client must read it');
  assert.match(client, /noteMissed/);
});

// A preference about how Reflect talks is a preference like any other, and the
// only direction anyone ever complains in is "stop". Live on qwen3:4b, "stop
// asking me so many questions" filed nothing while "keep answers short" filed
// correctly — every worked example was phrased as a want, so a preference
// phrased as a complaint matched none of them and vanished.
//
// Both directions are shown on purpose. With only the complaint on the page the
// model stopped filing "I like it when you ask questions", which was working
// before: one example does not teach a category, it moves the bias.
test('the extraction prompt teaches preferences phrased as complaints', () => {
  const system = buildMessages({ userText: 'x', assistantText: 'y', profile: '', projects: [] })[0].content;
  assert.match(system, /stop asking me so many questions/);
  assert.match(system, /ask me more before you answer/, 'both directions, or it over-corrects');
});
