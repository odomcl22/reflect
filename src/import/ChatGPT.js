/**
 * Bringing your ChatGPT history home.
 *
 * An export is years of conversation locked in someone else's format. This
 * converts it into the same append-only JSONL every other conversation uses, so
 * imported history is not a second-class citizen — it lists, opens, searches,
 * and compacts exactly like a conversation you had here.
 *
 * What it deliberately does not do is run extraction over thousands of old
 * turns. That would be tens of thousands of model calls, and it would flood
 * USER.md with facts that were true in 2023. Imported history becomes
 * *searchable*; turning any of it into memory is a separate, deliberate act.
 *
 * The format: a ChatGPT export is a zip containing conversations.json, an array
 * of conversations. Each holds a `mapping` of message nodes forming a tree —
 * regenerations and edits create branches — plus `current_node`, the leaf of the
 * branch actually shown. Walking parents from that leaf gives the conversation
 * as the user last saw it.
 */

// `node:fs` here is deliberate and stays: the export being imported is a file
// the user picked on their own disk, not Reflect's storage. Everything written
// *into* Reflect goes through the storage port like everything else.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { paths } from '../config.js';
import { join } from '../core/Storage.js';
import { appendLine, exists, ensureDir } from '../store/FileStore.js';

/** Roles worth keeping. Tool chatter and system preambles are not conversation. */
const KEEP_ROLES = new Set(['user', 'assistant']);

/** Pull displayable text out of a node's content, whatever shape it is in. */
export function textOf(message) {
  const content = message?.content;
  if (!content) return '';

  // The common case, and the multimodal case where parts mix strings and
  // objects (images, audio). Objects have no text to keep.
  if (Array.isArray(content.parts)) {
    return content.parts
      .filter((p) => typeof p === 'string')
      .join('\n')
      .trim();
  }
  if (typeof content.text === 'string') return content.text.trim();
  if (typeof content.result === 'string') return content.result.trim();
  return '';
}

function isHidden(node) {
  const m = node?.message;
  if (!m) return true;
  if (m.metadata?.is_visually_hidden_from_conversation) return true;
  const role = m.author?.role;
  if (!KEEP_ROLES.has(role)) return true;
  // System messages disguised as user turns — custom instructions, tool results.
  if (role === 'user' && m.metadata?.is_user_system_message) return true;
  return false;
}

/**
 * Flatten one exported conversation into ordered turns.
 *
 * Follows parents from `current_node` so edits and regenerations resolve to the
 * branch the user actually kept, rather than every draft they discarded.
 */
export function linearize(conversation) {
  const mapping = conversation?.mapping || {};
  const turns = [];

  let cursor = conversation?.current_node;
  const seen = new Set();
  const chain = [];

  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(mapping[cursor]);
    cursor = mapping[cursor].parent;
  }
  chain.reverse();

  // A malformed export with no usable current_node still has its nodes; fall
  // back to creation order rather than importing nothing.
  const nodes = chain.length
    ? chain
    : Object.values(mapping).sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));

  for (const node of nodes) {
    if (isHidden(node)) continue;
    const text = textOf(node.message);
    if (!text) continue;
    turns.push({
      role: node.message.author.role,
      content: text,
      at: node.message.create_time
        ? new Date(node.message.create_time * 1000).toISOString()
        : null,
    });
  }

  return turns;
}

const stamp = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString() : new Date().toISOString();

/** A stable, filesystem-safe id derived from the export's own identifiers. */
export function idFor(conversation, index) {
  const created = conversation?.create_time ? new Date(conversation.create_time * 1000) : null;
  const date = created ? created.toISOString().slice(0, 10) : 'imported';
  const raw = String(conversation?.conversation_id || conversation?.id || index);
  const suffix = raw.replace(/[^A-Za-z0-9]/g, '').slice(-8) || String(index);
  return `${date}-gpt-${suffix}`;
}

/** Does a file exist on the user's own disk? Not a storage-port question. */
async function fileOnDisk(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Read conversations.json out of an export, whether zipped or already extracted. */
export async function readExport(file) {
  const resolved = path.resolve(file);
  if (!(await fileOnDisk(resolved))) throw new Error(`No such file: ${resolved}`);

  if (/\.json$/i.test(resolved)) {
    const raw = await fsp.readFile(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.conversations || [];
  }

  if (/\.zip$/i.test(resolved)) {
    // Reflect ships with two dependencies and no zip reader. Rather than adding
    // one for a step most people run once, say plainly what to do — an
    // ERR_MODULE_NOT_FOUND stack is not an instruction.
    let AdmZip;
    try {
      ({ default: AdmZip } = await import('adm-zip'));
    } catch {
      throw new Error(
        `Cannot read a zip without adm-zip installed. Either unzip it and point at conversations.json:\n` +
          `    unzip "${path.basename(resolved)}" && reflect import conversations.json\n` +
          `  or install the reader once:\n` +
          `    npm install adm-zip`
      );
    }
    const zip = new AdmZip(resolved);
    const entry = zip.getEntries().find((e) => /(^|\/)conversations\.json$/i.test(e.entryName));
    if (!entry) throw new Error('That zip has no conversations.json — is it a ChatGPT export?');
    const parsed = JSON.parse(entry.getData().toString('utf8'));
    return Array.isArray(parsed) ? parsed : parsed.conversations || [];
  }

  throw new Error('Expected a .zip export or a conversations.json file.');
}

/**
 * Import an export into the conversation store.
 *
 * Idempotent by conversation id: running it twice imports nothing the second
 * time, so a user who re-runs it after a new export only gets what is new.
 *
 * @param {string} file            path to the .zip or conversations.json
 * @param {object} [opts]
 * @param {number} [opts.limit]    stop after this many conversations
 * @param {boolean} [opts.dryRun]  report what would happen, write nothing
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function importExport(file, { limit = Infinity, dryRun = false, onProgress } = {}) {
  const conversations = await readExport(file);
  await ensureDir(paths().conversations);

  const summary = { found: conversations.length, imported: 0, skipped: 0, empty: 0, turns: 0, ids: [] };

  for (const [index, conversation] of conversations.entries()) {
    if (summary.imported >= limit) break;

    const id = idFor(conversation, index);
    const target = join(paths().conversations, `${id}.jsonl`);

    if (await exists(target)) {
      summary.skipped++;
      continue;
    }

    const turns = linearize(conversation);
    if (!turns.length) {
      summary.empty++;
      continue;
    }

    if (!dryRun) {
      await appendLine(target, {
        type: 'meta',
        id,
        title: conversation.title || null,
        mode: 'companion',
        createdAt: stamp(conversation.create_time),
        source: 'chatgpt-import',
      });
      for (const turn of turns) {
        await appendLine(target, {
          type: 'turn',
          id: `t_${id}_${summary.turns}`,
          role: turn.role,
          content: turn.content,
          at: turn.at || stamp(conversation.create_time),
          imported: true,
        });
        summary.turns++;
      }
    } else {
      summary.turns += turns.length;
    }

    summary.imported++;
    summary.ids.push(id);
    onProgress?.({ ...summary, current: conversation.title || id });
  }

  return summary;
}
