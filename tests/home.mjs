/**
 * No test ever runs against a real person's memory.
 *
 * Most test files make their own temp home. The ones that do not were pure
 * functions with nothing to write, so falling through to ~/.reflect was
 * harmless — right up until the ledger began recording DNS lookups from inside
 * Safety.checkUrl, at which point running the suite wrote `good.test` and
 * `rebind.test` into a real record of what had left a real machine.
 *
 * That is the worst place in the project for invented data. The ledger's only
 * claim is that it contains what actually happened, and a test hostname in it
 * makes the whole file worthless as evidence.
 *
 * So the default is set here, before any test module is imported, rather than
 * asked of eighteen files and of every file added later. A test that wants its
 * own home still sets one; this only catches the ones that never thought about
 * it, which is precisely the set that got it wrong.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const real = path.join(os.homedir(), '.reflect');

if (!process.env.REFLECT_HOME || path.resolve(process.env.REFLECT_HOME) === real) {
  process.env.REFLECT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-test-'));
}
