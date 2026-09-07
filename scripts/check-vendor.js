#!/usr/bin/env node
/**
 * Refuse to package binaries for the wrong operating system.
 *
 * `extraResources` copies whatever is in `vendor/` into the app, with no idea
 * what platform it was fetched for. Build for Windows on a Mac and the
 * installer ships macOS `.dylib` files — it builds cleanly, installs cleanly,
 * and then dictation and the bundled runtime do not work, with nothing
 * anywhere saying why.
 *
 * Run before packaging. It compares what is on disk against what is being
 * built and says exactly which command fixes it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformKey } from '../src/runtimes/Bundled.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** What a build for this platform must contain, and what it must not. */
const SHAPES = {
  darwin: { want: /\.dylib$|^llama-server$|^whisper-server$/, wrong: /\.dll$|\.so(\.|$)|\.exe$/ },
  win32: { want: /\.dll$|\.exe$/, wrong: /\.dylib$|\.so(\.|$)/ },
  linux: { want: /\.so(\.|$)|^llama-server$|^whisper-server$/, wrong: /\.dylib$|\.dll$|\.exe$/ },
};

async function filesIn(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

const target = process.argv[2] || process.platform;
const shape = SHAPES[target];
if (!shape) {
  console.error(`check-vendor: no idea what a ${target} build should look like.`);
  process.exit(1);
}

let bad = false;
for (const name of ['llama', 'whisper']) {
  const dir = path.join(root, 'vendor', name);
  const files = await filesIn(dir);

  if (!files.length) {
    console.log(`  vendor/${name}  empty — the app will look for a runtime instead of bundling one`);
    continue;
  }

  const wrong = files.filter((f) => shape.wrong.test(f));
  if (wrong.length) {
    console.error(
      `\n  vendor/${name} holds ${wrong.length} file(s) that cannot run on ${target}:\n` +
        `    ${wrong.slice(0, 3).join(', ')}${wrong.length > 3 ? ' …' : ''}\n\n` +
        `  These would ship inside the installer and fail silently at runtime.\n` +
        `  Fetch the right ones first:\n` +
        `    node scripts/fetch-${name}.js ${platformKey({ platform: target, arch: 'x64' })}\n`
    );
    bad = true;
    continue;
  }

  console.log(`  vendor/${name}  ${files.length} file(s), correct for ${target}`);
}

process.exit(bad ? 1 : 0);
