/**
 * Working in your desktop apps, through automations you built yourself.
 *
 * The other way to do this — a model watching the screen and clicking — needs
 * a frontier model to be reliable, and is at its most dangerous exactly when it
 * is most useful: unattended, with the power to press Send or Delete. Measured
 * here, an 8B model could not be relied on to call one well-described tool. It
 * is not going to drive Finder.
 *
 * Shortcuts is the version of this that works on the hardware Reflect runs on.
 * A shortcut is a fixed automation somebody built in Apple's visual editor, it
 * already reaches nearly every app on the Mac, and it does the same thing every
 * time. Reflect only has to say which one, and when. The model never decides
 * how to operate an app; the person already did, by building the shortcut.
 *
 * ## Which ones
 *
 * Only shortcuts on a list the person writes. Shortcuts can send messages and
 * delete files — there is one on the machine this was written on called "Text
 * Last Image" — so the rule is the one messaging follows: nothing the model
 * says can add to the list, and while it is empty the tool does not exist.
 *
 * ## How
 *
 * `/usr/bin/shortcuts run <name>`, through execFile with an argument array, so
 * a shortcut name is an argument and never a command. Input goes in as a file
 * and output comes back as one, because that is the interface the CLI has.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJSON, writeJSON } from '../store/FileStore.js';

const run = promisify(execFile);
const CLI = '/usr/bin/shortcuts';
const FILE = 'shortcuts.json';

/**
 * Long enough for a shortcut that opens an app and does some work in it.
 *
 * A shortcut that stops to ask a question — "Ask for Input" — has nobody to ask
 * when Reflect runs it, and will sit until this runs out. That is said plainly
 * in the result rather than reported as a generic failure.
 */
const TIMEOUT_MS = 60_000;

/** Output is read back as text, and a shortcut can return a whole document. */
const MAX_OUTPUT = 20_000;

export const available = () => process.platform === 'darwin' && fs.existsSync(CLI);

/** Every shortcut on this Mac, by name. */
export async function installed() {
  if (!available()) return [];
  try {
    const { stdout } = await run(CLI, ['list'], { timeout: 15_000 });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The ones Reflect may run. Empty until a person chooses. */
export async function allowed() {
  const state = (await readJSON(FILE, null)) || {};
  return Array.isArray(state.allowed) ? state.allowed.filter((n) => typeof n === 'string') : [];
}

/**
 * Put one on the list. A person's decision, like a folder grant or a contact.
 *
 * Checked against the real list of installed shortcuts, so the allowlist can
 * only ever name things that exist.
 */
export async function allow(name) {
  const want = String(name || '');
  if (!(await installed()).includes(want)) return { ok: false, reason: `There is no shortcut called "${want}" on this Mac.` };
  const list = await allowed();
  if (!list.includes(want)) list.push(want);
  await writeJSON(FILE, { allowed: list });
  return { ok: true, allowed: list };
}

export async function revoke(name) {
  const list = (await allowed()).filter((n) => n !== String(name || ''));
  await writeJSON(FILE, { allowed: list });
  return { ok: true, allowed: list };
}

/**
 * Run one. Exact names only — a model that says "morning routine" when the
 * shortcut is "Morning Routine" is told so, rather than matched to something
 * nearby, because nearby is how the wrong automation runs.
 */
export async function runShortcut({ name, input = null }) {
  if (!available()) return { ok: false, reason: 'Shortcuts only exist on macOS.' };
  const want = String(name || '');
  const list = await allowed();
  if (!list.includes(want)) {
    return {
      ok: false,
      reason: list.length
        ? `"${want}" is not one Reflect may run. The allowed ones are: ${list.join(', ')}.`
        : 'No shortcuts are allowed yet. The user can choose some in Settings.',
    };
  }

  // Checked first because the CLI does not fail on a missing shortcut — it
  // hangs until the timeout, and the timeout's explanation ("nobody to answer
  // it") is then the wrong one. Measured: 60 seconds of nothing, then a
  // reason that sent you looking in the wrong place.
  if (!(await installed()).includes(want)) {
    return { ok: false, reason: `"${want}" is allowed but no longer on this Mac — it was deleted or renamed. It can be re-ticked in Settings once it exists.` };
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-shortcut-'));
  const out = path.join(dir, 'output');
  const args = ['run', want, '--output-path', out];
  if (input !== null && input !== undefined && String(input).length) {
    const inFile = path.join(dir, 'input.txt');
    await fsp.writeFile(inFile, String(input));
    args.push('--input-path', inFile);
  }

  try {
    await run(CLI, args, { timeout: TIMEOUT_MS });
    let output = '';
    if (fs.existsSync(out)) {
      const buf = await fsp.readFile(out);
      output = buf.includes(0)
        ? `[returned a ${buf.length}-byte file rather than text]`
        : buf.toString('utf8').slice(0, MAX_OUTPUT);
    }
    return { ok: true, name: want, output };
  } catch (err) {
    const why = err.killed || err.signal === 'SIGTERM'
      ? `It did not finish within ${TIMEOUT_MS / 1000} seconds. If it asks a question or shows a menu, there was nobody to answer it.`
      : String(err.stderr || err.message).trim().slice(0, 300);
    return { ok: false, reason: why };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
