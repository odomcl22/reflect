/**
 * Searching your own past — conversations, not memory.
 *
 * Deliberately separate from `Recall`. Memory is the small, curated set of
 * things that are true about you, and it goes into the prompt. Conversations are
 * everything you ever said, most of it noise, and importing years of ChatGPT
 * history would drown ambient recall in 2023 chatter — the memory-hoarder
 * failure the North Star warns about. So history is searched only when the user
 * asks, and never injected on its own.
 *
 * Keyword-only, and that is the right call here: you search your history for a
 * word you remember using.
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readLines, listFiles } from '../store/FileStore.js';
import { queryWords, stemWord } from '../text.js';

const SNIPPET = 240;

/** A window of text around the first match, so the result explains itself. */
function snippetAround(text, terms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return text.slice(0, SNIPPET).trim();

  const start = Math.max(0, at - SNIPPET / 3);
  const end = Math.min(text.length, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Search every conversation transcript.
 *
 * @returns {Promise<{results: Array, scanned: number}>}
 */
export async function searchHistory(query, { limit = 20 } = {}) {
  const terms = [...new Set(queryWords(query).map(stemWord))];
  if (!terms.length) return { results: [], scanned: 0 };

  const files = await listFiles(paths().conversations, '.jsonl');
  const hits = [];

  for (const name of files) {
    const id = name.replace(/\.jsonl$/, '');
    const records = await readLines(join(paths().conversations, name));
    const meta = records.find((r) => r.type === 'meta');
    const turns = records.filter((r) => r.type === 'turn');

    for (const turn of turns) {
      const words = new Set(queryWords(turn.content).map(stemWord));
      const matched = terms.filter((t) => words.has(t));
      if (!matched.length) continue;

      hits.push({
        conversationId: id,
        title: meta?.title || null,
        role: turn.role,
        at: turn.at || meta?.createdAt || null,
        imported: Boolean(turn.imported),
        // All terms present beats one term repeated: searching two words means
        // you remember both of them being there.
        score: matched.length / terms.length,
        matched,
        snippet: snippetAround(turn.content, matched),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  return { results: hits.slice(0, limit), scanned: files.length };
}

/**
 * Conversations grouped by month, newest first.
 *
 * The shape the North Star's timeline asks for: a year of your own history at a
 * glance, without loading any of it.
 */
export async function timeline({ months = 24 } = {}) {
  const files = await listFiles(paths().conversations, '.jsonl');
  const buckets = new Map();

  for (const name of files) {
    const id = name.replace(/\.jsonl$/, '');
    const records = await readLines(join(paths().conversations, name));
    const meta = records.find((r) => r.type === 'meta');
    const turns = records.filter((r) => r.type === 'turn');
    if (!turns.length) continue;

    const when = meta?.createdAt || turns[0].at || null;
    const month = when ? String(when).slice(0, 7) : 'undated';

    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push({
      id,
      title: meta?.title || firstLine(turns),
      turnCount: turns.length,
      at: when,
      imported: meta?.source === 'chatgpt-import',
    });
  }

  return [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, months)
    .map(([month, conversations]) => ({
      month,
      count: conversations.length,
      conversations: conversations.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    }));
}

function firstLine(turns) {
  const first = turns.find((t) => t.role === 'user');
  if (!first) return 'Untitled';
  const text = first.content.trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
