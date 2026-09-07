/**
 * Rolling conversation summaries. One file per conversation, one owner.
 *
 * Reflect 1.0 had two components writing summaries.json in incompatible shapes —
 * ConversationSummary wrote an object map, compaction wrote an array — and each
 * silently destroyed the other's work on every turn. Nothing else in this
 * codebase may write a summary.
 *
 * The summary is Markdown with frontmatter, like every other memory file, so it
 * is readable and editable by hand.
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readText, writeText, exists } from './FileStore.js';
import { parseFrontmatter, serializeFrontmatter, bodyOf } from './MemoryFiles.js';

function fileFor(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe conversation id: ${id}`);
  return join(paths().summaries, `${id}.md`);
}

/**
 * @returns {Promise<{text, covers, throughTurnId, updatedAt}|null>}
 */
export async function read(id) {
  const raw = await readText(fileFor(id), '');
  if (!raw.trim()) return null;
  const { data, body } = parseFrontmatter(raw);
  const text = bodyOf(body);
  if (!text) return null;
  return {
    text,
    covers: Number(data.covers) || 0,
    throughTurnId: data.through || null,
    carriedFrom: data.carried_from || null,
    updatedAt: data.updated || null,
  };
}

/**
 * Replace the summary for a conversation.
 *
 * Summaries are cumulative: each compaction summarizes the previous summary
 * plus the newly dropped turns, so nothing that was ever summarized is lost by
 * being summarized again.
 */
export async function write(id, { text, covers, throughTurnId, carriedFrom = null }) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const doc =
    serializeFrontmatter({
      conversation: id,
      covers,
      through: throughTurnId || '',
      // Set when this summary is not of *this* conversation's own earlier turns
      // but of the one it continues. The distinction reaches the prompt: telling
      // a model "earlier in this conversation" about turns that happened in a
      // different one invites it to refer back to things this transcript cannot
      // show.
      ...(carriedFrom ? { carried_from: carriedFrom } : {}),
      updated: new Date().toISOString(),
    }) + `\n# Summary of earlier turns\n\n${clean}\n`;

  await writeText(fileFor(id), doc);
  return { text: clean, covers, throughTurnId };
}

export async function has(id) {
  return exists(fileFor(id));
}
