/**
 * Embeddings, via whatever runtime is installed.
 *
 * This used to be a second Ollama client sitting beside the inference port —
 * its own `/api/tags` call, its own `/api/embed` call, its own base URL — which
 * meant "choose your runtime" would have silently left recall talking to Ollama
 * whatever the user picked. It now goes through the port like everything else.
 *
 * Everything here still degrades rather than fails. No embedding model, or a
 * runtime that is down, means `embed()` returns null and recall continues on
 * keyword scoring alone. A local assistant that refuses to answer because a
 * side-car model is missing is worse than one that recalls slightly less well.
 * The adapters throw; deciding to degrade is this class's job, and `reason`
 * is how it explains itself.
 */

import { inference } from '../core/Inference.js';

/** Preference order when the user has not chosen. All are small and local. */
const PREFERRED = ['nomic-embed-text', 'embeddinggemma', 'mxbai-embed-large', 'all-minilm'];

export class Embedder {
  /**
   * @param {object}  [opts]
   * @param {object}  [opts.adapter]  an inference adapter; defaults to the installed one
   * @param {string}  [opts.model]    skip resolution and use this
   */
  constructor({ adapter = null, model = null } = {}) {
    this.adapter = adapter;
    this.model = model;
    this.dim = null;
    this.reason = model ? 'configured' : 'not resolved yet';
  }

  async #runtime() {
    return this.adapter || (this.adapter = await inference());
  }

  /**
   * Pick an embedding model from what is actually installed.
   *
   * The interesting case is a runtime whose model list is unlabelled — a bare
   * `/v1/models` cannot tell an embedding model from a chat model. Guessing
   * there would embed the whole corpus with a chat model: vectors that look
   * fine, score badly, and are wrong in a way nobody notices for weeks. So on
   * an unlabelled runtime we match known names and otherwise decline, which
   * costs semantic recall until someone chooses, rather than poisoning it.
   */
  async resolve() {
    if (this.model) return this.model;
    try {
      const runtime = await this.#runtime();
      const labelled = runtime.capabilities?.().embeddingModels !== 'unlabelled';
      const found = await runtime.listEmbeddingModels();

      for (const wanted of PREFERRED) {
        const hit = found.find((m) => m.name.includes(wanted));
        if (hit) {
          this.model = hit.name;
          this.reason = 'auto-selected';
          return this.model;
        }
      }

      if (labelled && found.length) {
        this.model = found[0].name;
        this.reason = 'auto-selected';
        return this.model;
      }

      this.reason = labelled
        ? 'no embedding model installed — pull one to enable semantic recall'
        : 'this runtime does not say which models embed — choose one in settings';
    } catch (err) {
      this.reason = `runtime unreachable: ${err.message}`;
    }
    return null;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]|null>} null when embeddings are unavailable
   */
  async embed(texts) {
    const inputs = texts.filter((t) => String(t || '').trim());
    if (!inputs.length) return [];

    const model = await this.resolve();
    if (!model) return null;

    try {
      const runtime = await this.#runtime();
      const rows = await runtime.embed({ model, texts: inputs });
      const out = rows.map((row) => normalize(Float32Array.from(row)));
      this.dim = out[0].length;
      this.reason = 'ok';
      return out;
    } catch (err) {
      this.reason = `embedding failed: ${err.message}`;
      return null;
    }
  }

  /**
   * Identifies what produced the vectors in the index. Changing any part of it
   * invalidates every stored vector — this is what prevents Reflect 1.0's bug
   * where summaries embedded with a different model scored -1 forever and were
   * silently unretrievable.
   */
  fingerprint() {
    return `${this.model || 'none'}@${this.dim || '?'}/v1`;
  }
}

/** Unit-normalize so cosine similarity is a plain dot product. */
export function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (!norm) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Both vectors must be unit-normalized. Returns -1 on a dimension mismatch. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
