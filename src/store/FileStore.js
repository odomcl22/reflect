/**
 * Everything Reflect writes goes through here.
 *
 * This used to be the filesystem layer. It is now the *semantics* layer — JSON
 * records, JSONL transcripts, read-modify-write under a lock, the first-run
 * layout — and it performs none of that on a disk itself. The seven-method
 * storage port does that (`core/Storage.js`), and which adapter is behind it is
 * decided at boot.
 *
 * The distinction matters: locking, atomic-update semantics, and "a corrupt
 * derived file is not a crash" are product rules that hold on every platform.
 * `tmp + rename` is a filesystem trick and lives in the filesystem adapter.
 */

import { storage } from '../core/Storage.js';
import { paths, REQUIRED_DIRS, DEFAULT_CONFIG } from '../core/Keys.js';

export async function ensureDir(prefix) {
  await (await storage()).ensure(prefix);
}

export async function exists(key) {
  return (await storage()).exists(key);
}

/** Returns the fallback when nothing is stored under that key. */
export async function readText(key, fallback = '') {
  return (await storage()).read(key, fallback);
}

export async function writeText(key, contents) {
  return (await storage()).write(key, contents);
}

/**
 * Serialize access to one key across concurrent callers.
 *
 * Atomic writes stop the torn file, but not the lost update: every memory write
 * is read-modify-write, so two turns landing together would both read the old
 * profile and the second would overwrite the first's fact — silently, which is
 * the worst way for a memory system to fail. Chaining per key makes each
 * read-modify-write atomic with respect to the others.
 */
const fileLocks = new Map();

export function withFileLock(key, fn) {
  const previous = fileLocks.get(key) || Promise.resolve();
  const result = previous.then(fn, fn);
  // Keep the chain alive even when a caller throws.
  fileLocks.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  );
  return result;
}

/** Read, transform, write back — as one indivisible step. */
export async function updateText(key, transform) {
  return withFileLock(key, async () => {
    const current = await readText(key, '');
    const next = await transform(current);
    if (next === null || next === undefined) return { changed: false, content: current };
    await writeText(key, next);
    return { changed: true, content: next };
  });
}

export async function readJSON(key, fallback = null) {
  const raw = await readText(key, '');
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt derived file is not a crash — the caller gets the fallback and
    // the bad file is preserved for inspection rather than silently overwritten.
    return fallback;
  }
}

export async function writeJSON(key, data) {
  await writeText(key, JSON.stringify(data, null, 2) + '\n');
}

/** Append one JSON record as a line. */
export async function appendLine(key, record) {
  await (await storage()).append(key, JSON.stringify(record) + '\n');
}

export async function readLines(key) {
  const raw = await readText(key, '');
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // Skip a torn final line rather than losing the whole conversation.
    }
  }
  return out;
}

export async function listFiles(prefix, ext = '') {
  return (await storage()).list(prefix, ext);
}

export async function remove(key) {
  return (await storage()).remove(key);
}

/** Everything under a prefix. Used to reset a store; there is no undo. */
export async function removeAll(prefix) {
  return (await storage()).removeAll(prefix);
}

/** Create the layout on first run. Idempotent, and safe on a store with no dirs. */
export async function scaffold() {
  const p = paths();
  const store = await storage();
  for (const dir of REQUIRED_DIRS) await store.ensure(dir);

  if (!(await exists(p.config))) await writeJSON(p.config, DEFAULT_CONFIG);
  if (!(await exists(p.user))) await writeText(p.user, SEED_USER);
  return { ...p, ...store.describe() };
}

export async function loadConfig() {
  const saved = (await readJSON(paths().config, {})) || {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  await writeJSON(paths().config, next);
  return next;
}

const SEED_USER = `# User

<!--
Reflect keeps what it learns about you here. Edit this file freely — it is read
fresh at the start of every conversation, and whatever it says is treated as true.
Delete a line and Reflect forgets it.
-->

## Identity

## Preferences

## Working style
`;
