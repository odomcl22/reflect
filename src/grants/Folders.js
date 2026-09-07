/**
 * Reading and writing inside a granted folder.
 *
 * This is the one module allowed to touch files outside REFLECT_HOME, and every
 * call checks a grant first. It uses `node:fs` directly and deliberately: these
 * are the user's own files on their own desktop, not Reflect's storage, and the
 * storage port is rooted at the memory folder for exactly that reason. A phone
 * build will implement this differently — a document picker rather than a path
 * — which is why the surface is four functions rather than a filesystem.
 *
 * The write rules follow the choice made when grants were designed:
 *
 *   - Creating a file is free, and shows up in the trace.
 *   - Replacing one is refused unless the call says `confirm: true`, so the
 *     model has to come back and ask. In a chat app the confirmation *is* the
 *     conversation: "that file exists, shall I replace it?" — answered by a
 *     person, then done.
 *
 * That keeps the rule Reflect already lives by: additive is free, destructive
 * is deliberate.
 */

import path from 'node:path';
import { officeWriterFor } from '../documents/Office.js';
import fsp from 'node:fs/promises';
import { grantFor, canRead, canWrite, listGrants } from './Grants.js';

/** Files worth showing. Anything else is noise or not ours to read. */
const SKIP = /^(\.|node_modules$|\.git$|\.DS_Store$)/;

const TEXT = /\.(md|markdown|txt|rtf|csv|tsv|json|ya?ml|toml|ini|conf|log|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql)$/i;

/** 256KB: enough for any note, small enough not to eat the context window. */
const MAX_READ = 256 * 1024;

/**
 * Turn whatever the model said into a path.
 *
 * Observed live: given a folder listed as "desk — /long/path/to/desk", a 4B
 * model calls the tool with `path: "desk"`. That is the obvious reading of the
 * listing, and the name is unambiguous when it matches one connected folder, so
 * the tool accepts it rather than making the model guess again. Bare names and
 * relative paths resolve against the grants; absolute paths are used as given.
 */
async function locate(target, folders) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('Which folder or file?');
  if (path.isAbsolute(raw)) return path.resolve(raw);

  const [first, ...rest] = raw.replace(/^\.\//, '').split('/');
  const named = folders.filter((g) => g.name.toLowerCase() === first.toLowerCase());
  if (named.length === 1) return path.resolve(named[0].path, ...rest);
  if (named.length > 1) throw new Error(`More than one connected folder is called "${first}" — use the full path.`);

  throw new Error(
    `"${raw}" is not a connected folder. Connected: ${folders.map((g) => `${g.name} (${g.path})`).join(', ') || 'none'}.`
  );
}

async function checked(target, need) {
  const folders = await listGrants();
  const resolved = await locate(target, folders);
  const grant = await grantFor(resolved, folders);

  if (!canRead(grant)) {
    throw new Error(
      `No access to ${resolved}. Connected folders: ${folders.map((g) => g.name).join(', ') || 'none'}. ` +
        'The user connects a folder; you cannot grant it to yourself.'
    );
  }
  if (need === 'write' && !canWrite(grant)) {
    throw new Error(
      `${grant.name} is connected for reading only. The user has to grant writing before you can change anything there.`
    );
  }
  return { resolved, grant };
}

/** What is in a folder — one level, no recursion, directories marked. */
export async function listFolder(target) {
  const { resolved, grant } = await checked(target, 'read');
  const entries = await fsp.readdir(resolved, { withFileTypes: true });

  const items = [];
  for (const entry of entries) {
    if (SKIP.test(entry.name)) continue;
    const full = path.join(resolved, entry.name);
    const stat = await fsp.stat(full).catch(() => null);
    items.push({
      name: entry.name,
      path: full,
      kind: entry.isDirectory() ? 'folder' : 'file',
      bytes: stat && entry.isFile() ? stat.size : null,
      readable: entry.isDirectory() || TEXT.test(entry.name),
    });
  }

  return { path: resolved, grant: grant.access, items: items.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** One text file. Binary and oversized files are refused with a reason. */
export async function readFile(target) {
  const { resolved } = await checked(target, 'read');
  const stat = await fsp.stat(resolved);

  if (stat.isDirectory()) throw new Error(`${resolved} is a folder — list it instead.`);
  if (!TEXT.test(resolved)) throw new Error(`${path.basename(resolved)} is not a text file.`);
  if (stat.size > MAX_READ) {
    throw new Error(`${path.basename(resolved)} is ${Math.round(stat.size / 1024)}KB — too large to read whole.`);
  }

  return { path: resolved, bytes: stat.size, content: await fsp.readFile(resolved, 'utf8') };
}

/**
 * Write a file. New paths go through; existing ones need `confirm`.
 *
 * @returns {Promise<{path, created: boolean, bytes: number}>}
 */
export async function writeFile(target, content, { confirm = false } = {}) {
  const { resolved } = await checked(target, 'write');

  // Word and Excel are written from what a model is actually good at producing
  // — markdown for prose, a table or CSV for a grid — and converted here. The
  // model is never asked to author Office XML, which it would do badly and
  // confidently.
  const office = officeWriterFor(resolved);
  if (!office && !TEXT.test(resolved)) {
    throw new Error(
      'That file type cannot be written. Text formats, .docx, .xlsx and .pdf are supported.'
    );
  }

  const existing = await fsp.stat(resolved).catch(() => null);
  if (existing && !confirm) {
    throw new Error(
      `${path.basename(resolved)} already exists. Ask the user whether to replace it, ` +
        'and call again with confirm: true only if they say yes.'
    );
  }

  await fsp.mkdir(path.dirname(resolved), { recursive: true });

  if (office) {
    const bytes = office(String(content ?? ''));
    await fsp.writeFile(resolved, bytes);
    return { path: resolved, created: !existing, bytes: bytes.length };
  }

  const text = String(content ?? '');
  await fsp.writeFile(resolved, text, 'utf8');
  return { path: resolved, created: !existing, bytes: Buffer.byteLength(text) };
}

/**
 * Make a folder inside one that has been granted for writing.
 *
 * "Create a folder on my Desktop for the science project" is the most ordinary
 * request this app will ever get, and until now the answer was no. It is a
 * separate tool from file_write because creating a container and creating a
 * document are different intentions, and a model that means one should not be
 * able to typo its way into the other.
 */
export async function createFolder(target) {
  const { resolved } = await checked(target, 'write');
  const existing = await fsp.stat(resolved).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`${path.basename(resolved)} exists and is a file.`);
    return { path: resolved, created: false };
  }
  await fsp.mkdir(resolved, { recursive: true });
  return { path: resolved, created: true };
}
