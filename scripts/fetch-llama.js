#!/usr/bin/env node
/**
 * Fetch the `llama-server` binary that gets packaged into the desktop app.
 *
 *   node scripts/fetch-llama.js                 # this machine
 *   node scripts/fetch-llama.js macos-arm64     # a specific target
 *   LLAMA_BUILD=b10453 node scripts/fetch-llama.js
 *
 * A build step, not a runtime one. It runs on the machine doing the packaging
 * and drops the binary in `vendor/llama/`, which electron-builder copies into
 * the app's resources. Nothing downloads on a user's machine at install time —
 * a first run should not depend on the network being up, and a person who
 * already has Ollama should not be made to fetch a runtime they will not use.
 *
 * The build is pinned. llama.cpp tags several releases a day, and "whatever was
 * newest when this was packaged" is not a thing anyone can reproduce or bisect.
 * Raising the pin is a commit, with the version in the diff.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { platformKey } from '../src/runtimes/Bundled.js';

/** Pinned. See the note above before changing it. */
const BUILD = process.env.LLAMA_BUILD || 'b10453';
const REPO = 'https://github.com/ggml-org/llama.cpp/releases/download';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'vendor', 'llama');

/**
 * What we actually need out of the archive.
 *
 * The release carries the CLI, the benchmark tools, and the shared libraries.
 * The server needs the libraries, so this is not just one file — but it is also
 * not the whole archive, and shipping tools nobody runs is weight in a download
 * someone is waiting on.
 */
const WANTED = /(?:^|\/)(llama-server(?:\.exe)?|.*\.(?:dylib|so(?:\.\d+)*|dll))$/;

async function main() {
  const target = process.argv[2] || platformKey();
  if (!target) {
    console.error(`No llama.cpp build for ${process.platform}/${process.arch}.`);
    console.error('The desktop app will still run; the built-in runtime just will not be offered.');
    process.exit(0);
  }

  const archive = `llama-${BUILD}-bin-${target}.${target.startsWith('win') ? 'zip' : 'tar.gz'}`;
  const url = `${REPO}/${BUILD}/${archive}`;
  console.log(`  fetching ${archive}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`\n  ${url}\n  returned ${res.status}.`);
    console.error('  Check the build tag and the target name against the releases page.');
    process.exit(1);
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-llama-'));
  const file = path.join(tmp, archive);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log(`  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);

  // `tar` reads zip as well as tar.gz on macOS, modern Windows and most Linux,
  // which avoids adding an archive library for one build-time step.
  execFileSync('tar', ['-xf', file, '-C', tmp], { stdio: 'inherit' });

  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  // Symlinks are preserved rather than followed. The release ships each shared
  // library under three names — libggml-base.0.20.0.dylib and two symlinks to it
  // — and copying through them turns 20 MB of libraries into 60 MB of identical
  // copies, in a download somebody is waiting on.
  let copied = 0;
  let links = 0;
  for (const found of walk(tmp)) {
    if (!WANTED.test(found)) continue;
    const dest = path.join(OUT, path.basename(found));
    const info = await fsp.lstat(found);
    if (info.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(found), dest).catch(() => {});
      links++;
      continue;
    }
    await fsp.copyFile(found, dest);
    await fsp.chmod(dest, 0o755).catch(() => {});
    copied++;
  }

  await fsp.rm(tmp, { recursive: true, force: true });

  if (!copied) {
    console.error('  archive contained no llama-server — the layout may have changed.');
    process.exit(1);
  }

  // Recorded so `reflect doctor` and a bug report can say which build this is.
  await fsp.writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify({ build: BUILD, target, files: copied, links, fetchedAt: new Date().toISOString() }, null, 2)
  );
  const size = du(OUT);
  console.log(`  ${copied} file(s) + ${links} symlink(s) → vendor/llama  (${size}, llama.cpp ${BUILD}, ${target})\n`);
}

/** Bytes on disk, symlinks not counted twice. */
function du(dir) {
  let total = 0;
  for (const f of walk(dir)) {
    const st = fs.lstatSync(f);
    if (!st.isSymbolicLink()) total += st.size;
  }
  return `${(total / 1e6).toFixed(1)} MB`;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
