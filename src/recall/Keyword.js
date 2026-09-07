/**
 * Keyword recall — the BM25 half of the hybrid ranker, landing first.
 *
 * M3 adds the vector half and merges the two. Building this side first is
 * deliberate: for a personal assistant, exact tokens carry more weight than
 * paraphrase. "Priya", "Vespa GTS300", "ReflectForge" are precisely the queries
 * where embeddings are weakest and keyword matching is exact.
 *
 * The contract this establishes, and which M3 must preserve: **search always
 * returns a ranked list, never a decision about whether to search.** An empty
 * list is an honest answer. Reflect 1.0 had nine components devoted to deciding
 * whether to retrieve, and several of them resolved to "don't".
 */

import { queryWords, stemWord } from '../text.js';

export const tokenize = (text) => queryWords(text);
export const stem = (token) => stemWord(token);

const key = (t) => stem(t);

/**
 * Score chunks against a query with BM25-style term weighting.
 *
 * @param {string} query
 * @param {Array<{source,section,text,kind,date}>} chunks   from MemoryFiles.collectChunks()
 * @param {object} [opts]
 * @param {number} [opts.limit]      max results
 * @param {number} [opts.threshold]  minimum score to return at all
 * @returns {Array<{source,section,text,kind,date,score,matched:string[]}>}
 */
export function search(query, chunks, { limit = 8, threshold = 0.12 } = {}) {
  const terms = [...new Set(tokenize(query).map(key))];
  if (!terms.length || !chunks.length) return [];

  const N = chunks.length;
  const docs = chunks.map((c) => {
    // `title` carries a project's name and aliases. It is searchable but never
    // shown, so an oblique reference — "that book idea" — reaches a project
    // whose bullets never use the word.
    const tokens = tokenize(`${c.title || ''} ${c.section} ${c.text}`).map(key);
    return { chunk: c, tokens, set: new Set(tokens), length: tokens.length };
  });

  const avgLength = docs.reduce((s, d) => s + d.length, 0) / N || 1;

  // Document frequency per query term.
  const df = new Map();
  for (const term of terms) {
    df.set(term, docs.reduce((n, d) => n + (d.set.has(term) ? 1 : 0), 0));
  }

  const k1 = 1.2;
  const b = 0.6;
  const scored = [];

  for (const doc of docs) {
    let score = 0;
    const matched = [];

    for (const term of terms) {
      const n = df.get(term);
      if (!n) continue;
      const tf = doc.tokens.reduce((c, t) => c + (t === term ? 1 : 0), 0);
      if (!tf) continue;
      matched.push(term);
      // +1 smoothing keeps IDF positive even when a term is in every chunk.
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLength)));
    }

    if (!score) continue;

    // Coverage matters more than raw frequency for one-line facts: a chunk that
    // hits every term of "wife name" should beat one that hits "name" twice.
    score *= 0.5 + 0.5 * (matched.length / terms.length);

    // The curated profile is the user's own statement of what is true. It
    // outranks an offhand journal line that happens to share wording.
    if (doc.chunk.kind === 'profile') score *= 1.35;
    else if (doc.chunk.kind === 'project') score *= 1.15;

    scored.push({ ...doc.chunk, score: Number(score.toFixed(4)), matched });
  }

  const max = scored.reduce((m, s) => Math.max(m, s.score), 0) || 1;
  return scored
    .map((s) => ({ ...s, score: Number((s.score / max).toFixed(4)) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
