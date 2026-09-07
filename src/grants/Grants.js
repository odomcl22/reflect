/**
 * Grants — what Reflect is allowed to touch outside its own memory folder.
 *
 * Everything up to now lived under REFLECT_HOME, which the storage port keeps
 * Reflect inside by construction. A connected folder is the first exception,
 * so it gets an explicit record rather than a flag: a list of folders, each
 * with an access level, written to a file you can read and edit like the rest
 * of your memory.
 *
 * Two rules, both chosen deliberately:
 *
 *   1. **Read by default, write on request.** Connecting a folder lets Reflect
 *      read it. Writing is a second grant on the same folder, so the list can
 *      say "Notes — read" and mean it. There is always a lesser state to fall
 *      back to.
 *   2. **A grant is a person's decision.** Nothing in a skill, a model reply,
 *      or a config file can create one. `allowed-tools` in a SKILL.md is a
 *      request; this file is the answer.
 *
 * The path checks are the security surface, so they are strict and they are
 * tested: absolute paths only, no traversal, no granting the memory folder to
 * itself, no granting a home directory or a filesystem root.
 */

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { homePath } from '../config.js';
import { readJSON, writeJSON } from '../store/FileStore.js';

/** Where the record lives: inside your memory, like everything else. */
export const GRANTS_KEY = 'grants.json';

export const ACCESS = ['read', 'write'];

/** Somewhere a grant may never point. */
function refuseReason(resolved) {
  const home = homePath();
  const userHome = os.homedir();

  if (resolved === path.parse(resolved).root) return 'the filesystem root is not a folder, it is everything';
  if (resolved === userHome) return 'your whole home directory is too much — grant a folder inside it';
  if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
    return 'Reflect already has its own memory folder; it does not need a grant for it';
  }
  return null;
}

/**
 * Normalise and check a folder before it can be granted.
 *
 * @returns {Promise<{path: string}>}
 * @throws if the folder cannot be granted, with a reason a person can act on
 */
export async function resolveFolder(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Which folder?');

  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error('Give the full path to the folder.');

  const resolved = path.resolve(expanded);
  const refused = refuseReason(resolved);
  if (refused) throw new Error(refused);

  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`No folder at ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`${resolved} is a file, not a folder`);

  return { path: resolved };
}

export async function listGrants() {
  const saved = (await readJSON(GRANTS_KEY, { folders: [] })) || { folders: [] };
  return Array.isArray(saved.folders) ? saved.folders : [];
}

/** The grant covering a path, or null. Longest match wins for nested grants. */
export async function grantFor(target, folders = null) {
  const list = folders || (await listGrants());
  const resolved = path.resolve(String(target || ''));

  return (
    list
      .filter((g) => resolved === g.path || resolved.startsWith(`${g.path}${path.sep}`))
      .sort((a, b) => b.path.length - a.path.length)[0] || null
  );
}

export const canRead = (grant) => Boolean(grant);
export const canWrite = (grant) => grant?.access === 'write';

/**
 * Grant a folder, or raise an existing grant to write.
 *
 * Raising is explicit: passing `access: 'write'` for a folder already granted
 * read is how the second decision is recorded.
 */
export async function grant(input, access = 'read') {
  if (!ACCESS.includes(access)) throw new Error(`Access must be read or write, not "${access}".`);
  const { path: resolved } = await resolveFolder(input);

  const folders = await listGrants();
  const existing = folders.find((g) => g.path === resolved);

  if (existing) {
    existing.access = access;
    existing.changedAt = new Date().toISOString();
  } else {
    folders.push({
      path: resolved,
      name: path.basename(resolved),
      access,
      addedAt: new Date().toISOString(),
    });
  }

  await writeJSON(GRANTS_KEY, { folders });
  return folders.find((g) => g.path === resolved);
}

export async function revoke(input) {
  const resolved = path.resolve(String(input || ''));
  const folders = await listGrants();
  const left = folders.filter((g) => g.path !== resolved);
  if (left.length === folders.length) return false;
  await writeJSON(GRANTS_KEY, { folders: left });
  return true;
}

/** One line per grant for the prompt, or '' when nothing is connected. */
export function grantsBrief(folders) {
  if (!folders.length) return '';
  return [
    '## Connected folders',
    '',
    'You may read these. Use the folder tools rather than guessing at contents.',
    '',
    ...folders.map((g) => `- ${g.name} — ${g.path}${g.access === 'write' ? ' (you may also write here)' : ''}`),
  ].join('\n');
}
