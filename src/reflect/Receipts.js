/**
 * Receipts: where each memory came from.
 *
 * Every other memory system answers "why do you think that?" with silence — the
 * fact is in the black box because it is in the black box. Reflect can do
 * better for free, because every fact arrives through one doorway with the
 * conversation standing right there. This writes that down.
 *
 * An append-only log, one JSON line per write, in the same spirit as the
 * transcripts: never edited, never compacted, the newest line for a given fact
 * wins. It is deliberately a *sidecar* — USER.md stays clean prose a person can
 * edit, and provenance lives next to it rather than as comments smuggled into
 * bullets someone will delete without knowing what they were.
 *
 * Matching is by normalized text and is best-effort by design. Edit a bullet by
 * hand and its receipt no longer matches — which is correct: the words are
 * yours now, and a receipt for words you rewrote would be a false citation.
 */

import { readText, appendLine } from '../store/FileStore.js';

const LOG = 'memory-sources.jsonl';

/** Case, spacing and trailing punctuation are not identity. */
export const normalize = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * One write, witnessed.
 *
 * @param {object} r
 * @param {string} r.text            the fact as written
 * @param {string} r.target         which file it landed in
 * @param {string} r.conversationId  where it was said
 */
export async function record({ text, target, conversationId, at = new Date().toISOString() }) {
  if (!text || !conversationId) return false;
  await appendLine(LOG, { text: String(text), target: String(target || ''), conversationId, at });
  return true;
}

/**
 * Everything witnessed, newest first, deduplicated by normalized text — the
 * newest sighting of a fact is where it was most recently said, which is the
 * conversation worth opening.
 */
export async function sources() {
  const raw = await readText(LOG, '');
  if (!raw.trim()) return [];
  const seen = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      seen.set(normalize(entry.text), entry); // later lines overwrite: newest wins
    } catch {
      // One bad line must not cost the rest of the log.
    }
  }
  return [...seen.values()].reverse();
}
