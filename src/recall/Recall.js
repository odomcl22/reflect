/**
 * Recall: the one place that decides what Reflect brings to a turn.
 *
 *   score = 0.70 · vector + 0.30 · keyword     both normalized to 0..1
 *         × temporal decay                     evergreen files exempt
 *         × alias / project boost
 *   then MMR for diversity, then a threshold, then a limit.
 *
 * The contract, stated once and enforced by tests: **this always returns a
 * ranked list and never a decision about whether to search.** An empty list is
 * an honest "nothing of yours is relevant". Reflect 1.0 had nine components
 * devoted to deciding whether to retrieve, several of which resolved to "don't"
 * — including one that suppressed retrieval whenever the user said the word
 * "memory".
 *
 * When embeddings are unavailable this degrades to keyword-only and says so in
 * the trace, rather than returning nothing.
 */

import * as Memory from '../store/MemoryFiles.js';
import { search as keywordSearch, tokenize, stem } from './Keyword.js';
import { MemoryIndex, chunkKey } from './Index.js';

export const WEIGHTS = { vector: 0.7, keyword: 0.3 };
export const HALF_LIFE_DAYS = 30;
export const MMR_LAMBDA = 0.7;

/**
 * The absolute cosine a chunk must clear to be recalled on vector evidence
 * alone.
 *
 * This exists because scores are normalized relative to the best hit, and
 * *every* chunk has some similarity to *every* query — so without a floor,
 * recall would always return its least-bad chunk and never an empty list. That
 * would quietly destroy the property this module promises.
 *
 * A single constant cannot do this job. Measured against nomic-embed-text, the
 * *correct* answer scores anywhere from 0.475 to 0.738 depending on how the
 * question is phrased, which overlaps the noise range of other queries:
 *
 *   "who is my wife"        → Wife: Priya            0.738   best noise 0.453
 *   "decide about inference" → Forge decision        0.628   best noise 0.522
 *   "rework its protagonist" → Turtles decision      0.515   best noise 0.390
 *   "pick up the story"      → Splinter's fate       0.475   best noise 0.454
 *
 * Read down the right-hand column and the pattern is obvious: what identifies a
 * true hit is not its absolute score but how far it stands above *that query's
 * own* distribution. So admission is two gates, and a chunk must pass both:
 *
 *   1. an absolute sanity floor, below every true match measured above
 *   2. at least one standard deviation above the mean score for this query
 *
 * The z-gate needs a population to be meaningful, so it is skipped on corpora
 * smaller than MIN_POPULATION, where the floor governs alone.
 *
 * A chunk that also matched on keywords bypasses both: an exact token is
 * independent evidence and does not need the vector's permission.
 */
export const MIN_VECTOR = 0.5;
export const MIN_Z = 1.0;
export const MIN_POPULATION = 5;

/**
 * How far above the corpus's own noise level a vector-only hit must sit, once
 * there is enough corpus to measure. See MemoryIndex.calibrate(): the constant
 * above is calibrated to one embedding model, this is calibrated to yours.
 * The hand-picked floor becomes a lower bound rather than the whole answer.
 */
export const CALIBRATION_SIGMAS = 2.0;

/** Files that state what is true rather than what happened. Never decayed. */
const EVERGREEN = new Set(['profile', 'project']);

export function temporalDecay(date, { halfLifeDays = HALF_LIFE_DAYS, now = Date.now() } = {}) {
  if (!date) return 1;
  const then = new Date(date).getTime();
  if (!Number.isFinite(then)) return 1;
  const ageDays = Math.max(0, (now - then) / 86400000);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/** Jaccard overlap on stemmed tokens — cheap, and enough to spot near-duplicates. */
export function similarity(a, b) {
  const A = new Set(tokenize(a).map(stem));
  const B = new Set(tokenize(b).map(stem));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Maximal Marginal Relevance: pick results that are relevant *and* different
 * from each other. Without it, three near-identical journal lines from three
 * consecutive days crowd out the one project note that says something else.
 */
export function mmr(candidates, { lambda = MMR_LAMBDA, limit = 8 } = {}) {
  const pool = [...candidates];
  const picked = [];

  while (pool.length && picked.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const redundancy = picked.reduce((max, p) => Math.max(max, similarity(pool[i].text, p.text)), 0);
      const value = lambda * pool[i].score - (1 - lambda) * redundancy;
      if (value > bestScore) {
        bestScore = value;
        bestIndex = i;
      }
    }
    picked.push(pool.splice(bestIndex, 1)[0]);
  }
  return picked;
}

/** One index per process. Syncing is incremental, so this stays cheap. */
let sharedIndex = null;
export function getIndex(options) {
  if (!sharedIndex || options?.fresh) sharedIndex = new MemoryIndex(options);
  return sharedIndex;
}

/** Test seam: drop the cached index so a new REFLECT_HOME is picked up. */
export function resetIndex() {
  sharedIndex = null;
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]      how many to return
 * @param {number} [opts.threshold]  minimum merged score
 * @param {object} [opts.index]      inject a MemoryIndex (tests)
 * @param {number} [opts.now]        clock injection (tests)
 * @returns {Promise<{results: Array, trace: object}>}
 */
export async function recall(query, opts = {}) {
  const {
    limit = 8,
    threshold = 0.15,
    minVector = MIN_VECTOR,
    minZ = MIN_Z,
    now = Date.now(),
  } = opts;
  const text = String(query || '').trim();

  const chunks = await Memory.collectChunks();
  if (!text || !chunks.length) {
    return { results: [], trace: { mode: 'empty', chunks: chunks.length, reason: text ? 'no memories yet' : 'empty query' } };
  }

  // ---- keyword half (always available) --------------------------------------
  // Ask for everything above a low bar; merging happens below.
  const keywordHits = keywordSearch(text, chunks, { limit: chunks.length, threshold: 0 });
  const keywordScores = new Map(keywordHits.map((h) => [chunkKey(h), h.score]));

  // ---- vector half (best effort) --------------------------------------------
  const index = opts.index || getIndex();
  const sync = await index.sync(chunks);
  const vectorScores = sync.ready ? await index.score(text) : new Map();
  const degraded = !sync.ready || vectorScores.size === 0;

  // This query's own score distribution. A true hit stands above it; on a small
  // corpus there is no distribution worth speaking of, so the gate stands down.
  const stats = distribution([...vectorScores.values()]);
  const zGate = stats.n >= MIN_POPULATION && stats.sd > 0.01;

  // Once the corpus is big enough to measure, prefer its own noise level to the
  // constant. Take whichever is stricter so calibration can only tighten.
  const calibration = typeof index.calibrate === 'function' ? index.calibrate() : null;
  const floor = calibration
    ? Math.max(minVector, calibration.mean + CALIBRATION_SIGMAS * calibration.sd)
    : minVector;

  // ---- merge ----------------------------------------------------------------
  const project = await Memory.resolveProject(text);
  const merged = [];

  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    const keyword = keywordScores.get(key) || 0;
    const vector = vectorScores.get(key) ?? 0;

    // Admission: an exact token is evidence on its own; similarity alone has to
    // clear the floor and stand above this query's own noise. Without both,
    // everything is always "relevant" and the empty list never happens.
    if (keyword <= 0) {
      if (vector < floor) continue;
      if (zGate && (vector - stats.mean) / stats.sd < minZ) continue;
    }

    // Score on the keyword half alone when vectors are unavailable, so a
    // degraded run stays comparable to a healthy one.
    let score = degraded ? keyword : WEIGHTS.vector * vector + WEIGHTS.keyword * keyword;
    if (score <= 0) continue;

    const decay = EVERGREEN.has(chunk.kind) ? 1 : temporalDecay(chunk.date, { now });
    score *= decay;

    // The user named this project outright. That beats anything inferred.
    const aliasHit = project && chunk.source === `projects/${project.slug}.md`;
    if (aliasHit) score *= 1.4;

    merged.push({
      source: chunk.source,
      section: chunk.section || '',
      text: chunk.text,
      kind: chunk.kind,
      date: chunk.date,
      score: Number(score.toFixed(4)),
      via: degraded ? 'keyword' : vector > 0 && keyword > 0 ? 'both' : vector > 0 ? 'vector' : 'keyword',
      parts: { vector: Number(vector.toFixed(4)), keyword: Number(keyword.toFixed(4)), decay: Number(decay.toFixed(3)) },
      ...(aliasHit ? { alias: project.slug } : {}),
    });
  }

  // Normalize to the best hit so `threshold` means "relative to what we found",
  // not an absolute the user would have to tune per embedding model.
  const top = merged.reduce((m, r) => Math.max(m, r.score), 0) || 1;
  const scaled = merged
    .map((r) => ({ ...r, score: Number((r.score / top).toFixed(4)) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score);

  const results = mmr(scaled.slice(0, limit * 3), { limit });

  return {
    results,
    trace: {
      mode: degraded ? 'keyword-only' : 'hybrid',
      degraded,
      reason: degraded ? sync.reason : 'ok',
      chunks: chunks.length,
      vectors: sync.vectors ?? 0,
      embedded: sync.embedded ?? 0,
      reused: sync.reused ?? 0,
      model: sync.model || null,
      considered: merged.length,
      returned: results.length,
      project: project?.slug || null,
      weights: degraded ? { keyword: 1 } : WEIGHTS,
      gates: degraded
        ? null
        : {
            floor: round(floor),
            source: calibration ? 'calibrated' : 'constant',
            minZ: zGate ? minZ : null,
            mean: round(stats.mean),
            sd: round(stats.sd),
            ...(calibration
              ? { corpusMean: round(calibration.mean), corpusSd: round(calibration.sd), pairs: calibration.n }
              : {}),
          },
    },
  };
}

const round = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : null);

/** Mean and standard deviation of a set of scores. */
function distribution(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { n, mean, sd: Math.sqrt(variance) };
}

// Keyword hits, vector records, and raw chunks must all key identically or the
// merge silently drops one half. They share chunkKey() from Index.js for exactly
// that reason — two key formats is how the vector half went missing once already.
