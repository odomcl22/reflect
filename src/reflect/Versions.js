/**
 * Memory with a timeline: what Reflect believed, and when.
 *
 * Two questions this answers that no other assistant can. "What did you think
 * about me in March" — because the file is small enough to keep every version
 * of. And "undo that" — because a bad extraction, or a sleep pass that merged
 * two facts that were not the same fact, should cost one click rather than
 * being permanent by default.
 *
 * The first design here was git, and it was wrong. USER.md is under a kilobyte:
 * a year of daily snapshots is a couple of hundred kilobytes, so version
 * control buys nothing on storage — and shelling out to `git` on a Mac without
 * the Xcode tools installed pops a modal system dialog at whoever is holding
 * the laptop. A consumer app does not get to summon that. Plain dated copies
 * cost less, work identically on Windows, and keep the promise that everything
 * here is a file you could read without us.
 *
 * The index is append-only, like the transcripts and the receipts. A snapshot
 * is a byte-exact copy, which is what makes restoring it trivially correct.
 */

import { readText, writeText, listFiles, appendLine, remove, exists } from '../store/FileStore.js';
import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';

const DIR = 'memory-history';
const INDEX = 'memory-history/index.jsonl';

/**
 * How many versions to keep.
 *
 * At roughly a kilobyte each this is under a megabyte — less than one
 * photograph. A version is taken per change rather than per day, so a talkative
 * week costs more of this than a quiet month does. The cap exists so the folder
 * cannot grow without bound, not because the space matters.
 */
export const KEEP = 400;

const bullets = (text) => (String(text).match(/^\s*-\s+.+$/gm) || []).length;
// To the millisecond, not the second. Extraction files two or three facts
// inside the same second, and a shared id means one file on disk with two
// lines in the index pointing at it — a timeline that shows a version you
// cannot actually get back.
const idFor = (d) => d.toISOString().replace(/[:.]/g, '-').slice(0, 23);

/** Every version, newest first. */
export async function versions() {
  const raw = await readText(INDEX, '');
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // One bad line must not cost the rest of the timeline.
    }
  }
  return out.reverse();
}

export const versionPath = (id) => join(DIR, `USER-${id}.md`);

export async function readVersion(id) {
  const path = versionPath(id);
  return (await exists(path)) ? readText(path, '') : null;
}

/**
 * Take a version of the memory file as it stands.
 *
 * A no-op when nothing has changed since the last one — the timeline should
 * show the days memory *moved*, not one entry per time something looked at it.
 *
 * @param {object} opts
 * @param {string} opts.reason  what caused this change, in a few words
 * @returns {Promise<{taken: boolean, id?: string, reason?: string}>}
 */
export async function snapshot({ reason = 'changed', now = new Date(), content = null } = {}) {
  // A caller that is about to overwrite the file hands over the bytes it is
  // replacing, because by the time it knows the write happened, the state
  // worth keeping is already gone.
  const current = content === null ? await readText(paths().user, '') : content;
  if (!current.trim()) return { taken: false, reason: 'nothing on file yet' };

  const all = await versions();
  if (all.length) {
    const newest = await readVersion(all[0].id);
    if (newest === current) return { taken: false, reason: 'unchanged since the last version' };
  }

  const id = idFor(now);
  await writeText(versionPath(id), current);
  await appendLine(INDEX, { id, at: now.toISOString(), reason, bullets: bullets(current) });

  // Oldest first out. The index keeps its line — a timeline with a gap in it is
  // more honest than one that silently renumbers itself.
  const kept = await listFiles(DIR, '.md');
  if (kept.length > KEEP) {
    for (const name of kept.sort().slice(0, kept.length - KEEP)) {
      await remove(join(DIR, name)).catch(() => {});
    }
  }

  return { taken: true, id };
}

/**
 * Put an older version back.
 *
 * Takes a version of the present first, so restoring is itself undoable — the
 * one property that makes a restore button safe to press. Restoring is a
 * change like any other, so it appears on the timeline with its own reason.
 */
export async function restore(id, { now = new Date() } = {}) {
  const older = await readVersion(id);
  if (older === null) return { ok: false, reason: 'that version is no longer kept' };

  await snapshot({ reason: 'before restoring', now });
  await writeText(paths().user, older);
  // The restored-from id travels as data rather than being formatted into the
  // reason. Turning an id back into a date meant unpicking the colons that had
  // been swapped out to make it a filename — three lines of regex to produce a
  // string the client could format from the id itself.
  const at = new Date(now.getTime() + 1000);
  await appendLine(INDEX, {
    id: idFor(at),
    at: at.toISOString(),
    reason: 'restored an earlier version',
    bullets: bullets(older),
    restoredFrom: id,
  });
  return { ok: true, id };
}
