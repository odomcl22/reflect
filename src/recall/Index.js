/**
 * The vector index. Derived, disposable, and safe to delete.
 *
 * Everything in here is reconstructible from the Markdown files. If it is
 * corrupt, missing, or was built by a different embedding model, it is thrown
 * away and rebuilt. That is the payoff of the file-first substrate: an index
 * bug can cost time, never data.
 *
 * A note on storage: the design document said `index.sqlite`. Node 22 only
 * exposes `node:sqlite` behind an experimental flag, and adding either a native
 * dependency or a runtime flag to a personal app is a poor trade for a few
 * thousand rows. This stores the same records as one JSON file with vectors
 * base64-packed as Float32 — about 3 KB per hundred chunks. The module boundary
 * is the same either way, so swapping in sqlite later touches only this file.
 */

import { paths } from '../core/Keys.js';
import { readJSON, writeJSON, exists } from '../store/FileStore.js';
import { Embedder, normalize } from './Embeddings.js';

/** Bump when the chunking strategy changes, to force a rebuild. */
const CHUNK_VERSION = 1;

const pack = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64');
const unpack = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

/** Stable identity for a chunk: its location plus its text. */
export function chunkKey(chunk) {
  const basis = `${chunk.source}|${chunk.section || ''}|${chunk.text}`;
  // FNV-1a — short, dependency-free, and collision-safe enough for a personal store.
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}-${basis.length.toString(36)}`;
}

export class MemoryIndex {
  #records = new Map(); // key → { chunk fields..., vec: Float32Array }
  #fingerprint = null;
  #loaded = false;

  constructor({ file = null, embedder = null, model } = {}) {
    this.file = file || paths().index;
    // No base URL: the embedder reaches the runtime through the inference port,
    // so it follows whatever the user chose rather than a second copy of a URL.
    this.embedder = embedder || new Embedder({ model });
    this.status = { ready: false, vectors: 0, reason: 'not synced' };
  }

  async load() {
    if (this.#loaded) return;
    this.#loaded = true;

    const data = await readJSON(this.file, null);
    if (!data?.records || !Array.isArray(data.records)) return;

    this.#fingerprint = data.fingerprint || null;
    for (const r of data.records) {
      try {
        this.#records.set(r.key, { ...r, vec: unpack(r.vec) });
      } catch {
        // A single unreadable record is dropped; it will be re-embedded on sync.
      }
    }
  }

  async save() {
    await writeJSON(this.file, {
      fingerprint: this.#fingerprint,
      chunkVersion: CHUNK_VERSION,
      updatedAt: new Date().toISOString(),
      records: [...this.#records.values()].map(({ vec, ...rest }) => ({ ...rest, vec: pack(vec) })),
    });
  }

  /**
   * Bring the index in line with the current chunks.
   *
   * Unchanged text keeps its vector — this is the embedding cache, and it means
   * editing one line of USER.md costs one embedding call, not a full rebuild.
   *
   * @returns {Promise<{ready, embedded, reused, dropped, vectors, reason}>}
   */
  async sync(chunks) {
    await this.load();

    const model = await this.embedder.resolve();
    if (!model) {
      this.status = { ready: false, vectors: this.#records.size, reason: this.embedder.reason };
      return { ...this.status, embedded: 0, reused: 0, dropped: 0 };
    }

    // A changed embedding model invalidates every vector in the store. Rebuild
    // rather than compare across incompatible spaces.
    const current = this.embedder.fingerprint();
    const dimKnown = this.embedder.dim !== null;
    if (dimKnown && this.#fingerprint && this.#fingerprint !== current) {
      this.#records.clear();
    }

    const wanted = new Map();
    for (const chunk of chunks) wanted.set(chunkKey(chunk), chunk);

    // Drop records whose source line no longer exists — the user deleted it.
    let dropped = 0;
    for (const key of [...this.#records.keys()]) {
      if (!wanted.has(key)) {
        this.#records.delete(key);
        dropped++;
      }
    }

    const missing = [...wanted.entries()].filter(([key]) => !this.#records.has(key));
    let embedded = 0;

    if (missing.length) {
      // A project's title is searchable but never shown; embedding it with the
      // text is what lets an oblique reference find the file semantically.
      const texts = missing.map(([, c]) => [c.title, c.section, c.text].filter(Boolean).join(' — '));
      const vectors = await this.embedder.embed(texts);

      if (!vectors) {
        this.status = { ready: false, vectors: this.#records.size, reason: this.embedder.reason };
        return { ...this.status, embedded: 0, reused: this.#records.size, dropped };
      }

      missing.forEach(([key, chunk], i) => {
        this.#records.set(key, {
          key,
          source: chunk.source,
          section: chunk.section || '',
          text: chunk.text,
          title: chunk.title || '',
          kind: chunk.kind,
          date: chunk.date || null,
          vec: vectors[i],
        });
      });
      embedded = missing.length;
    }

    this.#fingerprint = this.embedder.fingerprint();
    if (embedded || dropped) await this.save();

    this.status = { ready: true, vectors: this.#records.size, reason: 'ok', model };
    return {
      ...this.status,
      embedded,
      reused: this.#records.size - embedded,
      dropped,
    };
  }

  /** Cosine scores for every indexed chunk. Empty when the index is not ready. */
  async score(query) {
    if (!this.status.ready || !this.#records.size) return new Map();
    const vectors = await this.embedder.embed([query]);
    if (!vectors?.length) return new Map();

    const q = normalize(vectors[0]);
    const scores = new Map();
    for (const [key, record] of this.#records) {
      if (record.vec.length !== q.length) continue; // stale dimension, ignore
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * record.vec[i];
      scores.set(key, dot);
    }
    return scores;
  }

  /**
   * Measure how similar *unrelated* things look in this embedding space.
   *
   * M3 used a constant floor calibrated by hand against nomic-embed-text. That
   * number is meaningless for another model: an embedder whose vectors all sit
   * within 30 degrees of each other would admit everything, and one with a wide
   * spread would admit nothing. So measure instead of assume.
   *
   * Most random pairs of a user's own memory lines are unrelated, so the mean
   * pairwise cosine is a good estimate of this space's noise level. Sampling
   * caps the cost at a few thousand dot products regardless of corpus size.
   *
   * @returns {{mean, sd, n}|null} null when there is too little to measure
   */
  calibrate({ sample = 60 } = {}) {
    const vectors = [...this.#records.values()].map((r) => r.vec);
    if (vectors.length < 8) return null;

    const step = Math.max(1, Math.floor(vectors.length / sample));
    const picked = vectors.filter((_, i) => i % step === 0).slice(0, sample);

    const scores = [];
    for (let i = 0; i < picked.length; i++) {
      for (let j = i + 1; j < picked.length; j++) {
        if (picked[i].length !== picked[j].length) continue;
        let dot = 0;
        for (let k = 0; k < picked[i].length; k++) dot += picked[i][k] * picked[j][k];
        scores.push(dot);
      }
    }
    if (scores.length < 20) return null;

    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
    return { mean, sd: Math.sqrt(variance), n: scores.length };
  }

  get size() {
    return this.#records.size;
  }

  get fingerprint() {
    return this.#fingerprint;
  }

  /** Delete the index from disk. It rebuilds from the Markdown on next sync. */
  async clear() {
    this.#records.clear();
    this.#fingerprint = null;
    if (await exists(this.file)) await writeJSON(this.file, { records: [] });
  }
}
