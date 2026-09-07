/**
 * Fetch the Kokoro model and its voices, once.
 *
 * Separate from install because it is 90 MB and because someone should be able
 * to decide. `npm run install:voice` does both; this does only the download.
 */
import { download, modelDir, MODEL_FILE, hasModel } from '../src/speech/Kokoro.js';

const dir = modelDir();
if (hasModel(dir)) {
  console.log(`  already there → ${dir}/${MODEL_FILE}`);
  process.exit(0);
}

console.log(`  fetching Kokoro → ${dir}`);
let last = '';
await download({
  dir,
  onProgress: ({ file, got, total }) => {
    const pct = total ? Math.round((got / total) * 100) : 0;
    const line = `  ${file} ${pct}%`;
    if (line !== last) {
      process.stdout.write(`\r${line.padEnd(48)}`);
      last = line;
    }
  },
});
console.log('\n  done. Turn it on in Settings → Voice.');
