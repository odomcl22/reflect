/**
 * Searching Hugging Face for something to run.
 *
 * Until now, downloading a model meant already knowing its exact name —
 * `ggml-org/gemma-3-270m-it-GGUF:Q8_0` typed from memory into a box. That is
 * fine for someone who lives on Hugging Face and useless for everyone else,
 * which is why every other local-model app has a browser and this one did not.
 *
 * Two calls, both public and unauthenticated:
 *
 *   /api/models?search=…&filter=gguf   → repositories
 *   /api/models/<repo>?blobs=true      → the .gguf files inside, with sizes
 *
 * The sizes are the point. A list of quantizations means nothing without them;
 * a list that says which ones fit in this machine's memory is the difference
 * between choosing and guessing. That judgement reuses `pickDefaultModel`'s
 * rule rather than inventing a second opinion about what "fits" means.
 *
 * Nothing here is cached to disk. A search is a live question with a live
 * answer, and a stale catalogue is worse than a slow one.
 */

import { MEMORY_SHARE } from '../core/ModelChoice.js';
import { record as ledger } from '../reflect/Ledger.js';

const HF = 'https://huggingface.co/api';

/** Quantisation, pulled out of a filename like `gemma-3-270m-it-Q8_0.gguf`. */
export function quantOf(filename) {
  const m = /[-.]((?:IQ|Q)\d+[A-Z_0-9]*|BF16|F16|F32)\.gguf$/i.exec(String(filename || ''));
  return m ? m[1].toUpperCase() : null;
}

/**
 * A sharded model is several files that must all be present.
 *
 * Offering `-00001-of-00004` as a thing to download would fetch a quarter of a
 * model and report success, so multi-part files are recognised and grouped
 * rather than listed as separate options.
 */
export const shardOf = (filename) => /-(\d{5})-of-(\d{5})\.gguf$/i.exec(String(filename || ''));

/** Search repositories that contain GGUF files. */
export async function searchModels(query, { limit = 20, signal } = {}) {
  const url = new URL(`${HF}/models`);
  url.searchParams.set('search', String(query || '').trim());
  url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(limit));

  // Browsing for a model is a search of somebody else's index, and the terms
  // are the name of the thing you were looking for.
  ledger({ kind: 'catalogue', host: 'huggingface.co', detail: `search: ${String(query || '').slice(0, 80)}` });
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Hugging Face search returned ${res.status}`);

  return (await res.json()).map((m) => ({
    id: m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    updated: m.lastModified || m.createdAt || null,
    // Tags are the only signal the search endpoint gives about what a model is
    // for; the detail call does not add much and doubles the round trips.
    tags: (m.tags || []).filter((t) => /vision|tools|reasoning|chat|instruct/i.test(t)).slice(0, 3),
  }));
}

/**
 * The downloadable quantisations inside one repository, largest last.
 *
 * @param {object}  opts
 * @param {number} [opts.totalMemoryBytes] to mark which ones fit
 */
export async function listQuants(repo, { totalMemoryBytes = 0, signal } = {}) {
  ledger({ kind: 'catalogue', host: 'huggingface.co', detail: `quants: ${repo}` });
  const res = await fetch(`${HF}/models/${repo}?blobs=true`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status} for ${repo}`);
  const data = await res.json();

  const budget = totalMemoryBytes > 0 ? totalMemoryBytes * MEMORY_SHARE : 0;
  const shards = new Map();
  const single = [];

  for (const file of data.siblings || []) {
    const name = file.rfilename || '';
    if (!name.toLowerCase().endsWith('.gguf')) continue;
    // Not every .gguf in a repository is a model you can run.
    //
    //  - mmproj is the vision half of a multimodal model, downloaded alongside
    //    one rather than instead of it.
    //  - mtp-* is a Multi-Token Prediction draft head for speculative decoding.
    //    unsloth ships one beside the real weights, and it is the trap here:
    //    `mtp-gemma-4-31B-it-Q8_0.gguf` is 0.5 GB and parses as "Q8_0", so a
    //    31B model offered a half-gigabyte Q8_0 that would download happily and
    //    then not be the model.
    if (/(?:^|\/)mmproj|(?:^|\/)mtp-/i.test(name)) continue;

    const shard = shardOf(name);
    if (shard) {
      const key = name.replace(/-\d{5}-of-\d{5}\.gguf$/i, '');
      const group = shards.get(key) || {
        file: `${key}-00001-of-${shard[2]}.gguf`,
        // The quantisation sits before the shard suffix, not before `.gguf`,
        // so it has to be read from the stem or a sharded model shows up as
        // "unknown" — which is the one label nobody can choose by.
        quant: quantOf(`${key}.gguf`),
        bytes: 0,
        parts: 0,
      };
      group.bytes += file.size || 0;
      group.parts += 1;
      shards.set(key, group);
      continue;
    }
    single.push({ file: name, bytes: file.size || 0, parts: 1 });
  }

  // Two files can still parse to the same quantisation — a repository may ship
  // one at the top level and another under a folder. Keep the larger, which is
  // the full model rather than a trimmed variant, and never show a label twice
  // with two different meanings.
  const byQuant = new Map();
  for (const q of [...single, ...shards.values()]) {
    const label = q.quant || quantOf(q.file) || 'unknown';
    const seen = byQuant.get(label);
    if (!seen || q.bytes > seen.bytes) byQuant.set(label, q);
  }

  return [...byQuant.values()]
    .map((q) => ({
      ...q,
      quant: q.quant || quantOf(q.file) || 'unknown',
      // The same two-thirds rule the default-model picker uses. One opinion
      // about what "fits" is better than two that disagree.
      fits: budget ? q.bytes <= budget : null,
    }))
    .sort((a, b) => a.bytes - b.bytes);
}

/**
 * What to hand llama.cpp for a chosen quantisation.
 *
 * `repo:QUANT` is the form its `-hf` flag takes, and the form our pull already
 * speaks — so the browser produces exactly what the existing download path
 * expects rather than a second way of naming a model.
 */
export const pullName = (repo, quant) => `${repo}:${quant}`;
