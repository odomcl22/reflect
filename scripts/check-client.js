#!/usr/bin/env node
/**
 * Parse the client the way the browser does.
 *
 * `node --check` on a hand-carved slice of index.html was checking a *partial*
 * script and reporting it fine — which is how a duplicate `const` shipped and
 * broke the whole page while the check said "parses". This writes each real
 * module block to a temporary .mjs and asks Node to parse it as a module, so
 * import statements are legal and duplicate declarations are caught.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const blocks = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

if (!blocks.length) {
  console.error('  no module script found in public/index.html');
  process.exit(1);
}

let failed = 0;
for (const [i, code] of blocks.entries()) {
  const file = path.join(os.tmpdir(), `reflect-client-${process.pid}-${i}.mjs`);
  fs.writeFileSync(file, code);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  block ${i}: ${code.split('\n').length} lines, parses`);
  } catch (err) {
    console.error(`  block ${i}:\n${String(err.stderr || err.message).trim()}`);
    failed++;
  } finally {
    fs.rmSync(file, { force: true });
  }
}
process.exit(failed ? 1 : 0);
