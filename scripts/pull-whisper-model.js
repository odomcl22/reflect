#!/usr/bin/env node
/**
 * Download a whisper model.
 *
 *   node scripts/pull-whisper-model.js            # tiny.en
 *   node scripts/pull-whisper-model.js base.en
 *
 * The app does this itself when someone turns dictation on; this exists so the
 * same path can be exercised from a terminal, and so a packaging machine can
 * warm the cache before a demo.
 */
import { pullModel, MODELS, DEFAULT_MODEL, modelPath } from '../src/speech/Whisper.js';

const name = process.argv[2] || DEFAULT_MODEL;
if (!MODELS[name]) {
  console.error(`Unknown model "${name}". Known: ${Object.keys(MODELS).join(', ')}`);
  process.exit(1);
}

console.log(`  ${name} — ${MODELS[name].note}`);
let shown = -1;
for await (const ev of pullModel(name)) {
  if (ev.type === 'progress' && ev.percent > shown) {
    shown = ev.percent;
    if (shown % 10 === 0) process.stdout.write(`\r  ${shown}%   `);
  }
}
console.log(`\r  ready → ${modelPath(name)}\n`);
