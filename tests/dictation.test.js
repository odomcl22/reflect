/**
 * Dictation.
 *
 * The point of doing this the hard way is stated in one line and defended
 * here: the microphone must not reach a speech service. `SpeechRecognition`
 * would be twenty lines and would send audio to Google; Reflect prints
 * "nothing leaves this machine" under its composer, so it runs whisper.cpp
 * instead. A test asserts the shortcut has not crept back in.
 *
 * The rest is what happens on a machine that has none of this set up, which is
 * every machine before someone turns dictation on. Absent must degrade, never
 * throw — an app that fails to boot because a 78 MB model is missing is worse
 * than one that simply does not offer a microphone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const W = await import('../src/speech/Whisper.js');

// ─────────────────────────────────────────────────────────── where things are

test('the model lives beside the chat models, not in the memory folder', () => {
  const home = '/tmp/home';
  assert.equal(W.whisperDir(home), path.join(home, 'models', 'whisper'));
  // Everything under the memory folder is meant to be readable and diffable.
  // 78 MB of weights in there would make `git init` in ~/.reflect a trap.
  assert.ok(!W.whisperDir(home).includes('conversations'));
  assert.match(W.modelPath('tiny.en', home), /ggml-tiny\.en\.bin$/);
});

test('an unknown model is refused rather than guessed at', () => {
  assert.throws(() => W.modelPath('enormous'), /Unknown whisper model/);
});

test('the default is the fast one, because dictation is a latency feature', () => {
  // Text that arrives a beat behind your voice feels broken however accurate
  // it is. Anyone who would rather have the accuracy can pick base.
  assert.equal(W.DEFAULT_MODEL, 'tiny.en');
  assert.ok(W.MODELS[W.DEFAULT_MODEL].bytes < W.MODELS['base.en'].bytes);
});

// ──────────────────────────────────────────────────────── where the binary is

test('an explicit binary wins, then the packaged app, then the checkout', () => {
  const order = W.candidatePaths({
    resourcesPath: '/Applications/Reflect.app/Contents/Resources',
    env: { REFLECT_WHISPER_SERVER: '/my/whisper-server', PATH: '/usr/bin' },
  });
  assert.equal(order[0], '/my/whisper-server');
  assert.match(order[1], /Resources\/whisper\/whisper-server$/);
  // Running from source. PATH was supposed to cover this and does not: nobody
  // adds a project subfolder to PATH, so without this entry the bundled engine
  // is invisible to everyone except a packaged build.
  assert.match(order[2], /vendor\/whisper\/whisper-server$/);
});

test('no binary and no model degrade to "not offered", not to a crash', async () => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-nowhisper-'));
  // `root` too: this checkout has a real binary in vendor/, which is correct
  // for a developer and wrong for a test pretending to be a bare machine.
  assert.equal(W.findBinary({ resourcesPath: empty, env: { PATH: empty }, root: empty }), null);
  assert.equal(W.hasModel('tiny.en', empty), false);
  // The state of every machine before dictation is turned on.
  assert.equal(await W.ensureServer({ home: empty, resourcesPath: empty, root: empty }), null);
  assert.equal(await W.transcribe(new Uint8Array(8), { home: empty, resourcesPath: empty, root: empty }), null);
  await fsp.rm(empty, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────── the boundary

test('the microphone does not go to a speech service', async () => {
  const client = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const code = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  // The twenty-line shortcut. If it appears, audio is leaving the machine and
  // the line under the composer has become a lie.
  assert.ok(!/webkitSpeechRecognition|new SpeechRecognition\(/.test(code), 'browser speech recognition is back');
  assert.match(code, /\/api\/dictation\/transcribe/, 'dictation should go to our own engine');
});

test('audio is never written to disk', async () => {
  const server = await fsp.readFile(new URL('../src/speech/Whisper.js', import.meta.url), 'utf8');
  const routes = await fsp.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const dictation = routes.slice(routes.indexOf('---- dictation'), routes.indexOf('---- grants'));
  // A recording saved "just for debugging" is a recording that outlives the
  // reason for it.
  assert.ok(!/writeFile|writeBytes|createWriteStream/.test(dictation), 'the route must not persist audio');
  // Whisper.js writes exactly one thing: the downloaded model.
  const writes = server.match(/createWriteStream|writeFile/g) || [];
  assert.ok(writes.length <= 1, `Whisper.js writes ${writes.length} things; only the model download should`);
});

test('a transcript has no line breaks in it', async () => {
  // Whisper joins its timed segments with newlines, mid-clause. In a composer
  // where Enter sends the message, that is not cosmetic.
  const source = await fsp.readFile(new URL('../src/speech/Whisper.js', import.meta.url), 'utf8');
  assert.match(source, /replace\(\/\\s\+\/g, ' '\)/, 'segment newlines must be collapsed');
});
