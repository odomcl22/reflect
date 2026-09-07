/**
 * M3 — hybrid recall.
 *
 * The milestone is done when an oblique reference finds the right memory even
 * though it shares no words with it. M2 could already do the easy version of
 * this by matching the project's title; the acceptance test at the bottom of
 * this file deliberately removes every shared token so only the vector half can
 * succeed.
 *
 * Embeddings here come from a deterministic stub, not Ollama. A recall test that
 * depends on a model being installed is a test that gets deleted the first time
 * CI is red. The live check against real embeddings is a separate, manual run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-m3-'));
process.env.REFLECT_HOME = tmpHome;

const { paths } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
const Memory = await import('../src/store/MemoryFiles.js');
const { MemoryIndex, chunkKey } = await import('../src/recall/Index.js');
const { normalize, cosine } = await import('../src/recall/Embeddings.js');
const { recall, temporalDecay, mmr, similarity, WEIGHTS } = await import('../src/recall/Recall.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

async function resetMemory() {
  await Memory.writeProfile('# User\n\n## Identity\n');
  await FileStore.removeAll(paths().projects);
  await FileStore.removeAll(paths().journal);
  await FileStore.remove(paths().index);
  await FileStore.ensureDir(paths().projects);
  await FileStore.ensureDir(paths().journal);
}

/**
 * A stub embedder with a hand-built concept space.
 *
 * Each dimension is a topic. Text is mapped to topics by the words it contains,
 * which lets a query share a topic with a chunk while sharing no tokens — the
 * exact property real embeddings provide and keyword search cannot.
 */
const TOPICS = {
  motorcycle: ['vespa', 'gts300', 'vespa', 'bike', 'motorcycle', 'riding', 'insurance', 'helmet'],
  family: ['wife', 'priya', 'married', 'spouse', 'partner', 'anniversary'],
  fiction: ['turtles', 'novel', 'story', 'chapter', 'characters', 'writing', 'narrative', 'plot', 'protagonist'],
  software: ['forge', 'orchestration', 'agents', 'framework', 'architecture', 'ollama', 'backend'],
  hardware: ['studio', 'ram', 'gpu', 'machine', 'laptop', 'memory'],
};
const TOPIC_KEYS = Object.keys(TOPICS);

class StubEmbedder {
  constructor() {
    this.model = 'stub-embed';
    this.dim = TOPIC_KEYS.length;
    this.reason = 'ok';
    this.calls = 0;
  }
  async resolve() {
    return this.model;
  }
  async embed(texts) {
    this.calls += texts.length;
    return texts.map((t) => {
      const lower = String(t).toLowerCase();
      const vec = new Float32Array(TOPIC_KEYS.length);
      TOPIC_KEYS.forEach((topic, i) => {
        for (const word of TOPICS[topic]) if (lower.includes(word)) vec[i] += 1;
      });
      if (!vec.some(Boolean)) vec[0] = 0.001; // avoid a zero vector
      return normalize(vec);
    });
  }
  fingerprint() {
    return `${this.model}@${this.dim}/v1`;
  }
}

class DeadEmbedder {
  constructor() {
    this.model = null;
    this.dim = null;
    this.reason = 'no embedding model installed';
  }
  async resolve() {
    return null;
  }
  async embed() {
    return null;
  }
  fingerprint() {
    return 'none@?/v1';
  }
}

const freshIndex = (embedder = new StubEmbedder()) =>
  new MemoryIndex({ file: path.join(tmpHome, `index-${Math.random().toString(36).slice(2)}.json`), embedder });

// ─────────────────────────────────────────────────────────────── vector math

test('normalized vectors make cosine a dot product, and identical text scores 1', () => {
  const v = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
});

test('a dimension mismatch scores -1 instead of throwing or silently matching', () => {
  // This is Reflect 1.0's silent bug made loud: summaries embedded by a
  // different model scored -1 forever and were unretrievable with no error.
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), -1);
});

// ────────────────────────────────────────────────────────────────── indexing

test('chunk keys are stable for identical content and differ when text changes', () => {
  const a = { source: 'USER.md', section: 'Identity', text: 'Name: Sam' };
  assert.equal(chunkKey(a), chunkKey({ ...a }));
  assert.notEqual(chunkKey(a), chunkKey({ ...a, text: 'Name: Samuel' }));
  assert.notEqual(chunkKey(a), chunkKey({ ...a, section: 'Notes' }));
});

test('unchanged chunks reuse their vectors — editing one line is not a rebuild', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Name: Sam' });
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const embedder = new StubEmbedder();
  const index = freshIndex(embedder);

  const first = await index.sync(await Memory.collectChunks());
  assert.equal(first.embedded, 2);
  assert.equal(embedder.calls, 2);

  await Memory.addFact({ section: 'Identity', text: 'Rides a Vespa GTS300' });
  const second = await index.sync(await Memory.collectChunks());
  assert.equal(second.embedded, 1, 'only the new line should be embedded');
  assert.equal(second.reused, 2);
});

test('deleting a line drops its vector from the index', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Name: Sam' });
  await Memory.addFact({ section: 'Identity', text: 'Temporary note' });

  const index = freshIndex();
  await index.sync(await Memory.collectChunks());
  assert.equal(index.size, 2);

  await Memory.forgetFact('Temporary note');
  const sync = await index.sync(await Memory.collectChunks());
  assert.equal(sync.dropped, 1);
  assert.equal(index.size, 1);
});

test('a changed embedding model invalidates every stored vector', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Name: Sam' });

  const index = freshIndex();
  await index.sync(await Memory.collectChunks());
  const before = index.fingerprint;

  const other = new StubEmbedder();
  other.model = 'different-embed';
  index.embedder = other;

  const sync = await index.sync(await Memory.collectChunks());
  assert.notEqual(index.fingerprint, before);
  assert.equal(sync.embedded, 1, 'vectors from another model must not be reused');
});

test('the index survives a reload from disk without re-embedding', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Name: Sam' });

  const file = path.join(tmpHome, 'persist-index.json');
  const first = new MemoryIndex({ file, embedder: new StubEmbedder() });
  await first.sync(await Memory.collectChunks());

  const embedder = new StubEmbedder();
  const second = new MemoryIndex({ file, embedder });
  const sync = await second.sync(await Memory.collectChunks());
  assert.equal(sync.embedded, 0, 'a warm index should embed nothing');
  assert.equal(second.size, 1);
});

test('a corrupt index rebuilds instead of failing — it is derived data', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Name: Sam' });

  const file = path.join(tmpHome, 'corrupt-index.json');
  await FileStore.writeText(file, '{ not json at all');

  const index = new MemoryIndex({ file, embedder: new StubEmbedder() });
  const sync = await index.sync(await Memory.collectChunks());
  assert.equal(sync.ready, true);
  assert.equal(sync.embedded, 1);
});

// ──────────────────────────────────────────────────────────── decay and MMR

test('evergreen files never decay; journal entries do', () => {
  const now = Date.parse('2026-08-12T00:00:00Z');
  assert.equal(temporalDecay(null, { now }), 1, 'no date means evergreen');
  assert.ok(Math.abs(temporalDecay('2026-07-13', { now }) - 0.5) < 0.02, '30 days ≈ half');
  assert.ok(temporalDecay('2026-02-13', { now }) < 0.06, '180 days should be nearly gone');
});

test('MMR drops a near-duplicate in favour of something different', () => {
  const candidates = [
    { text: 'Configured the Omada router and set VLAN 10 for IoT', score: 0.92 },
    { text: 'Configured the Omada router, moved IoT onto VLAN 10', score: 0.89 },
    { text: 'AdGuard DNS runs on 192.168.10.2', score: 0.7 },
  ];
  const picked = mmr(candidates, { limit: 2 });
  assert.equal(picked[0].score, 0.92);
  assert.equal(picked[1].text, 'AdGuard DNS runs on 192.168.10.2');
});

test('similarity is symmetric and bounded', () => {
  assert.equal(similarity('the vespa bike', 'the vespa bike'), 1);
  assert.equal(similarity('vespa bike', 'quantum physics'), 0);
  assert.equal(similarity('a b', 'b a'), similarity('b a', 'a b'));
});

// ──────────────────────────────────────────────────────────────── the merge

test('recall returns a ranked list and never a decision to skip', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const index = freshIndex();
  const hit = await recall('who is my wife', { index });
  assert.ok(Array.isArray(hit.results));
  assert.ok(hit.results.length > 0);

  const miss = await recall('quantum chromodynamics lattice gauge', { index });
  assert.deepEqual(miss.results, [], 'an empty list is the honest answer');
  assert.ok(!('search' in miss), 'recall must not return a search/skip decision');
});

test('REGRESSION: the word "memory" does not suppress recall', async () => {
  // Reflect 1.0 routed any message containing "memory", "reflect", or "prompt"
  // to project buckets, which outside a project session returned search:false.
  // A personal question containing those words retrieved nothing at all.
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const index = freshIndex();
  const { results, trace } = await recall(
    'my memory is bad — remind me what my wife is called, and what did we say about the prompt in Reflect?',
    { index }
  );
  assert.ok(results.length > 0, 'retrieval was suppressed');
  assert.ok(results.some((r) => /Priya/.test(r.text)));
  assert.notEqual(trace.mode, 'off');
});

test('hybrid beats either half alone, and the trace says which ran', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const index = freshIndex();
  const { results, trace } = await recall('wife', { index });
  assert.equal(trace.mode, 'hybrid');
  assert.deepEqual(trace.weights, WEIGHTS);
  assert.equal(results[0].via, 'both', 'both halves should have fired on an exact token');
  assert.ok(results[0].parts.vector > 0 && results[0].parts.keyword > 0);
});

test('no embedding model degrades to keyword-only rather than returning nothing', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const index = freshIndex(new DeadEmbedder());
  const { results, trace } = await recall('wife', { index });

  assert.equal(trace.mode, 'keyword-only');
  assert.equal(trace.degraded, true);
  assert.match(trace.reason, /no embedding model/);
  assert.ok(results.length > 0, 'degraded must still recall');
  assert.equal(results[0].via, 'keyword');
});

test('a stale journal line loses to a current profile fact on the same topic', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Preferences', text: 'Prefers deep analysis over short replies' });

  const old = new Date();
  old.setDate(old.getDate() - 150);
  await Memory.appendJournal('asked for short replies today', { date: old });

  const index = freshIndex();
  const { results } = await recall('how much detail do I want in replies', { index });
  assert.equal(results[0].kind, 'profile', 'a five-month-old note outranked the curated profile');
});

test('naming a project boosts its file above unrelated matches', async () => {
  await resetMemory();
  await Memory.upsertProject({
    name: 'ReflectForge',
    aliases: ['forge'],
    section: 'Decisions',
    text: 'Orchestration is delegated to the agents',
  });
  await Memory.addFact({ section: 'Notes', text: 'Orchestration of the school run is a nightmare' });

  const index = freshIndex();
  const { results, trace } = await recall('rethinking orchestration in forge', { index });
  assert.equal(trace.project, 'reflectforge');
  assert.equal(results[0].source, 'projects/reflectforge.md');
  assert.equal(results[0].alias, 'reflectforge');
});

// ────────────────────────────────────────────── the M3 acceptance scenario

test('ACCEPTANCE: an oblique reference with no shared words finds the project', async () => {
  await resetMemory();

  // Deliberately hostile to keyword search: the project is called "Turtles
  // Book", and every note in it avoids the words the user will actually type.
  await Memory.upsertProject({
    name: 'Turtles Book',
    aliases: ['turtles'],
    section: 'Decisions',
    text: 'Darker and more adult, keeping the original characters intact',
  });
  await Memory.upsertProject({
    name: 'ReflectForge',
    aliases: ['forge'],
    section: 'Decisions',
    text: 'Ollama is the backend; agents own orchestration',
  });
  await Memory.addFact({ section: 'Identity', text: 'Rides a Vespa GTS300' });

  const index = freshIndex();

  // "novel" and "protagonist" share no token with any stored line — only the
  // fiction topic connects them. Keyword search alone cannot make this hop.
  const query = 'I want to get back to the novel and rework its protagonist';
  const { results, trace } = await recall(query, { index });

  assert.equal(trace.mode, 'hybrid');
  assert.ok(results.length > 0, 'semantic recall found nothing');
  assert.equal(results[0].source, 'projects/turtles-book.md');
  assert.equal(results[0].via, 'vector', 'this hop must come from the vector half');

  // And prove the negative: the keyword half on its own genuinely fails here.
  const { search } = await import('../src/recall/Keyword.js');
  const keywordOnly = search(query, await Memory.collectChunks());
  assert.ok(
    !keywordOnly.some((h) => h.source === 'projects/turtles-book.md'),
    'the test is not proving anything if keyword search already succeeds'
  );
});

test('a pure-vector hit below the floor is not recalled at all', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Relationships', text: 'Wife: Priya' });

  const index = freshIndex();
  // Shares no tokens and no topic — the only thing linking them is that every
  // pair of sentences has *some* cosine similarity. That must not be enough.
  const { results } = await recall('quantum chromodynamics lattice gauge', { index });
  assert.deepEqual(results, []);
});

test('the floor admits and rejects on either side of a controlled similarity', async () => {
  await resetMemory();
  await Memory.addFact({ section: 'Identity', text: 'Rides a Vespa GTS300' });

  // An embedder that puts query and chunk at a known 45 degrees: cosine ~0.707.
  class AngleEmbedder {
    constructor() { this.model = 'angle'; this.dim = 2; this.reason = 'ok'; }
    async resolve() { return this.model; }
    async embed(texts) {
      return texts.map((t) =>
        normalize(/vespa|gts300/i.test(t) ? Float32Array.from([1, 0]) : Float32Array.from([1, 1]))
      );
    }
    fingerprint() { return 'angle@2/v1'; }
  }

  const below = await recall('completely different words', {
    index: freshIndex(new AngleEmbedder()), minVector: 0.8,
  });
  const above = await recall('completely different words', {
    index: freshIndex(new AngleEmbedder()), minVector: 0.6,
  });

  assert.deepEqual(below.results, [], 'a floor above the similarity must reject');
  assert.equal(above.results.length, 1, 'a floor below the similarity must admit');
  assert.equal(above.results[0].via, 'vector');
});
