/**
 * Conversations are append-only JSONL, one file per conversation.
 *
 * The file is the truth. There is no index, no second store to fall out of sync
 * with — the first line of each file is its metadata record, and listing scans
 * the directory. Reflect 1.0 kept conversations in one big JSON blob that was
 * rewritten on every turn; a crash mid-write lost the lot.
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { appendLine, readLines, listFiles, exists, remove as removeKey } from './FileStore.js';

const META = 'meta';

export function newId() {
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

function fileFor(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe conversation id: ${id}`);
  return join(paths().conversations, `${id}.jsonl`);
}

/** Create the conversation file with its metadata line. Safe to call twice. */
export async function ensure(id, { title = null, mode = 'companion', project = null, continues = null, branchedFrom = null } = {}) {
  const file = fileFor(id);
  if (await exists(file)) return id;
  await appendLine(file, {
    type: META,
    id,
    title,
    mode,
    ...(project ? { project } : {}),
    // Which conversation this one picks up from, when it was started by
    // carrying an older one forward. Recorded so the thread can be walked back
    // — the point of continuing is that nothing was abandoned.
    ...(continues ? { continues } : {}),
    // Which conversation this one split off from. Distinct from `continues`:
    // that one carries a whole conversation forward, this one goes back to a
    // moment in it and takes a different road.
    ...(branchedFrom ? { branchedFrom } : {}),
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function append(id, turn) {
  await ensure(id);
  const record = {
    type: 'turn',
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    role: turn.role,
    content: turn.content,
    at: turn.at || new Date().toISOString(),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.metrics ? { metrics: turn.metrics } : {}),
    // A reply the reader cut short is still a reply; the flag is how anyone
    // reading the transcript later knows why it ends mid-sentence.
    ...(turn.stopped ? { stopped: true } : {}),
    // Which files came with the turn. The excerpt is not stored — it is
    // rebuilt from the files when needed — but the transcript has to say what
    // was brought, or reopening a conversation shows a question about a
    // document with no sign that a document was ever there.
    ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
  };
  await appendLine(fileFor(id), record);
  return record;
}

/** All turns for a conversation, oldest first. Metadata excluded. */
export async function turns(id) {
  const records = await readLines(fileFor(id));
  return records.filter((r) => r.type === 'turn');
}

/**
 * Record that everything up to `throughTurnId` now lives in the summary.
 *
 * Compaction is append-only and lossless: the raw turns stay on disk forever,
 * and this marker only changes what gets *loaded into context*. Reflect 1.0
 * conflated the two and rewrote history to save tokens. A user should always be
 * able to scroll back and read what was actually said.
 */
export async function markCompacted(id, { throughTurnId, covers, head = 0 }) {
  await appendLine(fileFor(id), {
    type: 'compaction',
    through: throughTurnId,
    covers,
    head,
    at: new Date().toISOString(),
  });
  return { throughTurnId, covers, head };
}

/** The newest compaction marker, or null. */
export async function compaction(id) {
  const records = await readLines(fileFor(id));
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'compaction') return records[i];
  }
  return null;
}

/**
 * The turns that should go into the prompt: the protected opening, then
 * everything after the last compaction point. The summary covers the middle.
 *
 * The opening is kept verbatim because it is where a conversation says what it
 * is about, and a summary of it is never as good as the thing itself. Keeping
 * `head` on the marker rather than assuming a constant means changing
 * PROTECT_FIRST later cannot orphan turns in already-compacted conversations.
 *
 * @returns {Promise<{turns: Array, compacted: number, marker: object|null}>}
 */
export async function contextTurns(id) {
  const records = await readLines(fileFor(id));
  const all = records.filter((r) => r.type === 'turn');

  let marker = null;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'compaction') {
      marker = records[i];
      break;
    }
  }
  if (!marker) return { turns: all, compacted: 0, marker: null };

  const cut = all.findIndex((t) => t.id === marker.through);
  // A marker we cannot resolve means sending too much, never losing the thread.
  if (cut === -1) return { turns: all, compacted: 0, marker };

  const head = Math.min(Number(marker.head) || 0, cut);
  return {
    turns: [...all.slice(0, head), ...all.slice(cut + 1)],
    compacted: cut + 1 - head,
    marker,
  };
}

export async function meta(id) {
  const records = await readLines(fileFor(id));
  const found = records.find((r) => r.type === META);
  if (!found) return null;
  // The newest project and title records win over whatever the conversation
  // started as. Titles were missing here: the META line's title is null for
  // almost every conversation — one is appended later, or derived from the
  // first thing said — so anything reading meta().title got nothing while the
  // sidebar showed the real name. It surfaced as branches called "Branch" and
  // a link back that said "an earlier conversation".
  return { ...found, title: titleOf(records), project: projectOf(records) };
}

/**
 * File a conversation under a project, or take it out of one with null.
 *
 * Appended rather than rewritten, exactly as the title is: the transcript is
 * the one thing in Reflect that is never edited in place, and "which project
 * was this in last March" is a question the file can then still answer.
 *
 * A project here is only the slug of a `projects/<slug>.md` that the Reflector
 * already maintains. Grouping chats does not create a second kind of project —
 * it points at the one that exists.
 */
export async function setProject(id, slug) {
  // Filing a conversation that does not exist yet is the ordinary case — it is
  // how someone opens a new chat *inside* a project. Without this the append
  // creates a transcript whose first record is not the meta line, `ensure()`
  // then skips it because the file exists, and the conversation has no
  // createdAt or mode for the rest of its life.
  await ensure(id);
  await appendLine(fileFor(id), { type: 'project', project: slug || null, at: new Date().toISOString() });
  return slug || null;
}

function projectOf(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'project') return records[i].project;
  }
  return records.find((r) => r.type === META)?.project || null;
}

/** Set the title by appending a correction record; the newest one wins. */
export async function setTitle(id, title) {
  await appendLine(fileFor(id), { type: 'title', title, at: new Date().toISOString() });
  return title;
}

function titleOf(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'title') return records[i].title;
  }
  const m = records.find((r) => r.type === META);
  if (m?.title) return m.title;
  const firstUser = records.find((r) => r.type === 'turn' && r.role === 'user');
  if (!firstUser) return 'New conversation';
  const t = firstUser.content.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

/** Newest first. Reads whole files — fine at personal scale, revisit past ~10k. */
/**
 * Delete a conversation and the summary derived from it.
 *
 * The one destructive operation in the store, and deliberately the only one:
 * compaction never deletes, extraction never deletes, the reflector never
 * deletes. This exists because a person asked for it about a specific thing,
 * which is a different act entirely.
 */
export async function remove(id) {
  const file = fileFor(id);
  if (!(await exists(file))) return false;
  await removeKey(file);
  await removeKey(join(paths().summaries, `${id}.md`));
  return true;
}

export async function list() {
  const names = await listFiles(paths().conversations, '.jsonl');
  const out = [];
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, '');
    const records = await readLines(join(paths().conversations, name));
    if (!records.length) continue;
    const turnRecords = records.filter((r) => r.type === 'turn');
    const last = turnRecords[turnRecords.length - 1];
    out.push({
      id,
      title: titleOf(records),
      project: projectOf(records),
      turnCount: turnRecords.length,
      createdAt: records.find((r) => r.type === META)?.createdAt || null,
      updatedAt: last?.at || null,
      preview: last ? last.content.trim().replace(/\s+/g, ' ').slice(0, 120) : '',
    });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
