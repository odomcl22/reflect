#!/usr/bin/env node
/**
 * Fetch (or build) the `whisper-server` binary that gets packaged with Reflect.
 *
 *   node scripts/fetch-whisper.js
 *   WHISPER_BUILD=v1.9.2 node scripts/fetch-whisper.js
 *
 * Sibling of fetch-llama.js, with one asymmetry worth explaining rather than
 * hiding: whisper.cpp publishes prebuilt archives for Windows and Linux, and
 * for macOS publishes only an xcframework — a library for Xcode, not a binary
 * anyone can run. So on macOS this compiles from source, which needs cmake and
 * the Xcode command line tools on the packaging machine.
 *
 * The alternative was extracting a Homebrew bottle, which would make the build
 * depend on Homebrew's packaging staying the shape it is today. Compiling the
 * tagged source is slower and boring, and boring is the right property for a
 * build step.
 *
 * The model is *not* fetched here. The binary is 2 MB and belongs in the app;
 * the smallest useful model is 78 MB and belongs to whoever turns dictation on.
 * Bundling it would tax every download for a feature many people never use.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Pinned, for the same reason llama.cpp is. */
const BUILD = process.env.WHISPER_BUILD || 'v1.9.2';
const REPO = 'https://github.com/ggml-org/whisper.cpp';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'vendor', 'whisper');

const WANTED = /(?:^|\/)(whisper-server(?:\.exe)?|.*\.(?:dylib|so(?:\.\d+)*|dll))$/;

/**
 * Which platform to fetch for. Defaults to this machine.
 *
 *   node scripts/fetch-whisper.js            # this machine
 *   node scripts/fetch-whisper.js win32      # for a Windows build made here
 *
 * fetch-llama.js has always taken a target and this did not, which meant a
 * Windows package could not be built from a Mac at all — half the binaries
 * would have been the wrong ones.
 */
const TARGET = process.argv[2] || process.platform;
const TARGET_ARCH = process.argv[3] || (TARGET === process.platform ? process.arch : 'x64');

const archiveFor = () => {
  if (TARGET === 'win32') return 'whisper-bin-x64.zip';
  if (TARGET === 'linux') return TARGET_ARCH === 'arm64' ? 'whisper-bin-ubuntu-arm64.tar.gz' : 'whisper-bin-ubuntu-x64.tar.gz';
  // macOS publishes no runnable binary, only an xcframework, so one is compiled
  // — which can only be done *on* a Mac. Cross-building to macOS is not offered.
  if (TARGET !== 'darwin') {
    console.error(`  no whisper build for ${TARGET}.`);
    process.exit(1);
  }
  return null;
};

async function main() {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  const archive = archiveFor();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-whisper-'));

  const produced = archive ? await download(archive, tmp) : await compile(tmp);
  await fsp.rm(tmp, { recursive: true, force: true });

  if (!produced) {
    console.error('  no whisper-server produced — dictation will be offered only if one is on PATH.');
    process.exit(1);
  }

  await fsp.writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify({ build: BUILD, platform: TARGET, arch: TARGET_ARCH, from: archive ? 'release' : 'source', fetchedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`  whisper-server ready → vendor/whisper  (whisper.cpp ${BUILD})\n`);
}

/** Windows and Linux: take the published build. */
async function download(archive, tmp) {
  const url = `${REPO}/releases/download/${BUILD}/${archive}`;
  console.log(`  fetching ${archive}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`  ${url} returned ${res.status}`);
    return false;
  }
  const file = path.join(tmp, archive);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xf', file, '-C', tmp], { stdio: 'inherit' });
  return collect(tmp);
}

/** macOS: compile the tagged source, because no runnable binary is published. */
async function compile(tmp) {
  for (const tool of ['cmake', 'git']) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore' });
    } catch {
      console.error(`  ${tool} is needed to build whisper.cpp on macOS, and is not installed.`);
      return false;
    }
  }

  const src = path.join(tmp, 'whisper.cpp');
  console.log(`  cloning whisper.cpp ${BUILD}`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', BUILD, `${REPO}.git`, src], { stdio: 'inherit' });

  console.log('  building whisper-server (Metal) — a minute or two');
  const build = path.join(src, 'build');
  // Only the server. The CLI, the benchmarks and the examples are weight in an
  // app that will only ever make HTTP calls.
  execFileSync(
    'cmake',
    [
      '-B', build, '-S', src,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      // Look for the libraries next to the binary, not where it was compiled.
      // Without this the rpath points at the build directory, which is a temp
      // folder that no longer exists by the time anyone runs it — the binary
      // works on the machine that built it for as long as nobody cleans up.
      '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
      '-DCMAKE_INSTALL_RPATH=@loader_path',
    ],
    { stdio: 'inherit' }
  );
  execFileSync('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', String(os.cpus().length)], { stdio: 'inherit' });

  return collect(build);
}

/** Pull the server and its libraries out, preserving symlinks as fetch-llama does. */
function collect(dir) {
  let found = 0;
  for (const file of walk(dir)) {
    if (!WANTED.test(file)) continue;
    const dest = path.join(OUT, path.basename(file));
    if (fs.existsSync(dest)) continue;
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(file), dest);
      continue;
    }
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o755);
    found++;
  }
  return found > 0;
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
