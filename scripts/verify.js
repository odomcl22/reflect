#!/usr/bin/env node
/**
 * Run everything, then report.
 *
 * This used to be `npm test && npm run e2e && npm run soak`, which stops at the
 * first failure — so a single brittle assertion in the e2e sweep meant the
 * adversarial sweep never ran, and you learned about one problem instead of
 * however many there were. Both sweeps are built on the principle that one pass
 * should show every bug; chaining them with && quietly threw that away at the
 * level above.
 *
 * So: always run all three, report each, and fail at the end if any failed.
 */

import { spawn } from 'node:child_process';

const STAGES = [
  { name: 'unit', label: '399 unit tests', args: ['test'] },
  { name: 'e2e', label: 'end-to-end sweep', args: ['run', 'e2e'] },
  { name: 'soak', label: 'adversarial sweep', args: ['run', 'soak'] },
];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const run = (args) =>
  new Promise((resolve) => {
    const proc = spawn('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    proc.on('close', (code) => resolve(code ?? 1));
    proc.on('error', () => resolve(1));
  });

const results = [];

for (const stage of STAGES) {
  console.log(c.bold(`\n━━ ${stage.label} ${'━'.repeat(Math.max(0, 50 - stage.label.length))}\n`));
  const started = Date.now();
  const code = await run(stage.args);
  results.push({ ...stage, code, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log(c.bold(`\n${'═'.repeat(56)}`));
for (const r of results) {
  const mark = r.code === 0 ? c.green('✓') : c.red('✗');
  console.log(`  ${mark} ${r.label}${c.dim(`  ${r.seconds}s`)}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(
  failed.length === 0
    ? c.green('\n  everything passed\n')
    : c.red(`\n  ${failed.length} of ${results.length} stages failed: ${failed.map((f) => f.name).join(', ')}\n`)
);

process.exit(failed.length ? 1 : 0);
