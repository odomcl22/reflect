/**
 * Word handling, in one place.
 *
 * Three modules needed "reduce this to its content words" — keyword search,
 * grounding, and duplicate detection — and each grew its own copy. The copies
 * drifted, and the drift was invisible until an end-to-end run showed the same
 * fact written twice:
 *
 *     "…and I ride a Vespa GTS300"   → ride
 *     "Rides a Vespa GTS300" → rid      ← "es" stripped before "s"
 *
 * Two stems for one word, so the duplicate check could never fire. This module
 * exists so there is exactly one answer to "is this the same word", the same way
 * chunkKey() is the one answer to "is this the same chunk".
 */

/** Grammar. Carries no fact on its own. */
export const FILLER = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'was', 'are', 'were',
  'be', 'been', 'being', 'for', 'with', 'that', 'this', 'it', 'its', 'he', 'she', 'they',
  'them', 'his', 'her', 'their', 'user', 'users', 'has', 'have', 'had', 'from', 'by', 'as',
  'not', 'but', 'about', 'into', 'over', 'than', 'then', 'so', 'up', 'out', 'will', 'would',
  'can', 'could', 'should', 'also', 'just', 'very', 'really', 'currently', 'now',
]);

/** Stopwords for search queries — broader, since questions carry more scaffolding. */
export const QUERY_STOP = new Set([
  ...FILLER,
  'did', 'do', 'does', 'how', 'i', 'if', 'me', 'my', 'our', 'we', 'what', 'when', 'where',
  'which', 'who', 'why', 'you', 'your', 'again', 'some', 'tell', 'know', 'think', 'want',
  'need', 'get', 'got', 'like',
]);

/**
 * Reduce a word to a comparable stem.
 *
 * Order matters and is the whole point: plurals lose their "s" before anything
 * else gets a chance to eat the "e" in front of it. Deliberately shallow —
 * over-stemming merges facts that should stay apart, which is the worse error.
 */
export function stemWord(word) {
  return String(word)
    .replace(/ies$/, 'y')            // personalities → personality
    .replace(/(ch|sh|ss|x|z)es$/, '$1') // batches → batch, boxes → box
    .replace(/s$/, '')               // rides → ride, characters → character
    .replace(/(ing|ed)$/, '');       // shipping → shipp, decided → decid
}

const split = (text) =>
  String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Content words of a statement, stemmed and de-duplicated. */
export function contentWords(text) {
  return new Set(split(text).filter((w) => w.length > 1 && !FILLER.has(w)).map(stemWord));
}

/**
 * Words that carry a fact's *frame* rather than its content.
 *
 * These survive FILLER because they are meaningful in a search — "my favourite"
 * is a real thing to look for. But two statements sharing only these are not the
 * same statement, and treating them as such loses memories:
 *
 *     "my favourite colour is oxblood"   my, favourite, colour, oxblood
 *     "my favourite season is autumn"    my, favourite, season, autumn
 *
 * Two shared words, ratio 0.50 — identical scores to a genuine duplicate like
 * "Hobbies: Vespa GTS300 rider" against "Rides a Vespa GTS300", which
 * shares *vespa* and *gts300*. No threshold can separate those two cases,
 * because the difference is not how many words are shared but which. The
 * evidence has to come from the subject, not the scaffolding.
 *
 * Found by the adversarial sweep: two conversations saving different favourites
 * at the same time, and the second silently discarded as "already known".
 */
export const QUALIFIER = new Set([
  'my', 'our', 'your', 'favourite', 'favorite', 'prefer', 'preference', 'like',
  'love', 'best', 'own', 'new', 'old', 'current', 'name', 'call', 'thing', 'stuff',
  'want', 'need', 'use', 'today', 'now', 'day', 'time', 'one', 'some', 'main',
]);

/** Shared words that actually argue two statements are the same one. */
export function informativeOverlap(a, b) {
  const B = b instanceof Set ? b : contentWords(b);
  const A = a instanceof Set ? a : contentWords(a);
  const shared = [];
  for (const w of A) if (B.has(w)) shared.push(w);
  return { shared, informative: shared.filter((w) => !QUALIFIER.has(w)) };
}

/** Content words of a search query. */
export function queryWords(text) {
  return split(text).filter((w) => w.length > 1 && !QUERY_STOP.has(w));
}
