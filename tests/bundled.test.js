/**
 * The runtime Reflect ships with.
 *
 * Almost nothing here can be tested by running it — the binary is fetched at
 * packaging time and is not in the repo. What *can* be tested is every decision
 * made around it, and those are the parts that would go wrong quietly:
 *
 *   - looking in the wrong places, or in the wrong order;
 *   - treating a missing binary as a failure rather than as "not available on
 *     this machine", which would stop the app booting for everyone who chose
 *     Ollama instead;
 *   - starting the server with arguments that lose a capability the other
 *     runtimes have, which is the worst kind of difference between backends
 *     because it only shows up on one of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';

const {
  platformKey,
  candidatePaths,
  findBinary,
  serverArgs,
  modelsDir,
  startBundled,
} = await import('../src/runtimes/Bundled.js');

const { adapterFor } = await import('../src/runtimes/Providers.js');

// ─────────────────────────────────────────────────────────── which archive

test('every platform we ship to has a build name', () => {
  assert.equal(platformKey({ platform: 'darwin', arch: 'arm64' }), 'macos-arm64');
  assert.equal(platformKey({ platform: 'darwin', arch: 'x64' }), 'macos-x64');
  assert.equal(platformKey({ platform: 'win32', arch: 'x64' }), 'win-cpu-x64');
  assert.equal(platformKey({ platform: 'linux', arch: 'x64' }), 'ubuntu-x64');
  assert.equal(platformKey({ platform: 'linux', arch: 'arm64' }), 'ubuntu-arm64');
  // Something we have no build for is null, not a guess that 404s at build time
  // with a confusing message.
  assert.equal(platformKey({ platform: 'aix', arch: 'ppc64' }), null);
});

// ──────────────────────────────────────────────────────── where to look

test('an explicit binary beats the bundled one, which beats the checkout, which beats PATH', () => {
  const order = candidatePaths({
    resourcesPath: '/Applications/Reflect.app/Contents/Resources',
    env: { REFLECT_LLAMA_SERVER: '/my/own/llama-server', PATH: '/usr/local/bin' },
    root: '/checkout',
  });
  assert.equal(order[0], '/my/own/llama-server', 'someone who named a binary meant it');
  assert.match(order[1], /Resources\/llama\/llama-server$/, 'then what shipped in the app');
  // Running from source. PATH was supposed to cover this and does not — nobody
  // adds a project subfolder to PATH.
  assert.equal(order[2], '/checkout/vendor/llama/llama-server');
  assert.match(order[3], /^\/usr\/local\/bin/, 'then whatever is installed on the machine');
});

test('a brew or hand-built server on PATH is still found', () => {
  const order = candidatePaths({
    env: { PATH: ['/opt/homebrew/bin', '/usr/bin'].join(path.delimiter) },
    root: null,
  });
  assert.deepEqual(order, ['/opt/homebrew/bin/llama-server', '/usr/bin/llama-server']);
});

test('no binary anywhere is null, not an exception', async () => {
  // This is the state on every machine where the user picked Ollama. If it
  // threw, the app would not boot for them.
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-nollama-'));
  // `root` too: this checkout has a real binary in vendor/, which is right for
  // a developer and wrong for a test pretending to be a bare machine.
  assert.equal(findBinary({ resourcesPath: empty, env: { PATH: empty }, root: empty }), null);
  assert.equal(await startBundled({ port: 1, home: empty, resourcesPath: empty, root: empty }), null);
  await fsp.rm(empty, { recursive: true, force: true });
});

test('a file that is not executable is not the binary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-notexec-'));
  const fake = path.join(dir, 'llama-server');
  await fsp.writeFile(fake, 'not a program');
  await fsp.chmod(fake, 0o644);
  assert.equal(findBinary({ env: { PATH: dir }, root: null }), null, 'unreadable-as-a-program is the same as absent');

  await fsp.chmod(fake, 0o755);
  assert.equal(findBinary({ env: { PATH: dir }, root: null }), fake);
  await fsp.rm(dir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────── how it is started

test('the bundled server starts in router mode, not serving one model', () => {
  const args = serverArgs({ port: 9931, modelsDir: '/m' });
  const value = (flag) => args[args.indexOf(flag) + 1];

  assert.ok(!args.includes('--model') && !args.includes('-m'), 'naming a model would give up router mode');
  assert.equal(value('--models-dir'), '/m', 'it supervises a folder of models');
  assert.ok(args.includes('--models-max'), 'and evicts, so several models do not all stay resident');
  assert.ok(args.includes('--sleep-idle-seconds'), 'and releases memory when nobody is asking');
});

test('the bundled server is loopback-only too', () => {
  const args = serverArgs({ port: 9931, modelsDir: '/m' });
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--port') + 1], '9931');
});

test('tool calling is enabled, or folder tools would work on every runtime but this one', () => {
  // llama.cpp silently serves no tools without --jinja. Folder grants would
  // appear to work and then never be used, on the bundled runtime only.
  assert.ok(serverArgs({ port: 1, modelsDir: '/m' }).includes('--jinja'));
});

test('only a couple of models stay loaded at once', () => {
  // Each one is resident memory, and the machine where this matters most is the
  // one with the least of it.
  const max = Number(serverArgs({ port: 1, modelsDir: '/m' })[
    serverArgs({ port: 1, modelsDir: '/m' }).indexOf('--models-max') + 1
  ]);
  assert.ok(max >= 1 && max <= 3, `${max} loaded models is not a small number`);
});

// ───────────────────────────────────────────────────────────── where things go

test('downloaded models sit beside the memory folder, not inside it', () => {
  // Everything under the memory folder is meant to be readable, diffable and
  // yours. Several gigabytes of weights in there would make `git init` in
  // ~/.reflect a trap.
  const home = path.join(os.homedir(), '.reflect');
  assert.equal(modelsDir(home), path.join(home, 'models'));
  assert.ok(!modelsDir(home).includes('conversations'));
});

// ──────────────────────────────────────────────────────────────── the adapter

test('the bundled runtime is llama.cpp, and says so', () => {
  // It differs from any other llama-server only in who started the process,
  // which is the shell's business and not the adapter's.
  const caps = adapterFor({ provider: 'builtin', baseUrl: 'http://127.0.0.1:9931' }).capabilities();
  assert.equal(caps.id, 'llamacpp');
  assert.equal(caps.models, 'list+pull');
});

// ─────────────────────────────────────────────────────────── the build step

test('the llama.cpp build is pinned, not "latest"', async () => {
  const source = await fsp.readFile(new URL('../scripts/fetch-llama.js', import.meta.url), 'utf8');
  const pin = /LLAMA_BUILD \|\| '([^']+)'/.exec(source);
  assert.ok(pin, 'no pinned build found');
  assert.match(pin[1], /^b\d+$/, `"${pin[1]}" is not a llama.cpp build tag`);
  // llama.cpp tags several releases a day. "Whatever was newest at packaging
  // time" is not something anyone can reproduce or bisect.
  assert.ok(!/latest/i.test(pin[1]));
});

test('the packaged app carries the binary outside the asar', async () => {
  const pkg = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const resources = pkg.build?.extraResources || [];
  const llama = resources.find((r) => r.to === 'llama');
  assert.ok(llama, 'nothing copies the binary into the app');
  // Inside an asar it is an entry in an archive, and nothing can exec that.
  assert.equal(llama.from, 'vendor/llama');
});

test('the binary is not committed to the repo', () => {
  const ignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /vendor\/llama/, 'an 11 MB binary per platform does not belong in git');
});

// ------------------------------------------------------------- packaging
//
// `main` in package.json is src/server.js, which is right for `npm start`, the
// CLI, and anyone requiring this as a library — and wrong for the packaged
// desktop app, where it is the Electron main process. Without an override the
// built Reflect.app starts a headless server and shows nothing at all: no
// window, no tray, no dock icon. Found by reading the built asar, because
// nothing about it fails — the app "launches" perfectly.

test('the packaged app boots the desktop shell, not the bare server', async () => {
  const pkg = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.build?.extraMetadata?.main, 'desktop/main.js');
  assert.equal(pkg.main, 'src/server.js', 'npm start and the CLI still want the server');
});

test('the entry the packaged app points at is actually shipped', async () => {
  const pkg = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const entry = pkg.build.extraMetadata.main;
  await fsp.access(new URL(`../${entry}`, import.meta.url));
  // ...and inside a directory electron-builder is told to include.
  const globs = pkg.build.files.filter((f) => !f.startsWith('!'));
  assert.ok(
    globs.some((g) => entry.startsWith(g.split('/')[0])),
    `${entry} is not covered by build.files`,
  );
});
