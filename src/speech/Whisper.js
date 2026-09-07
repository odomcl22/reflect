/**
 * Dictation, on this machine.
 *
 * The obvious way to do speech-to-text in a browser is `SpeechRecognition`,
 * which is twenty lines and works well. It also hands the microphone to the
 * browser's speech provider, which in Chrome has meant sending the audio to
 * Google. ReflectForge does exactly that and says so in a consent dialog —
 * defensible there, because ReflectForge does not print "nothing leaves this
 * machine" under its composer. Reflect does, and that line is the product.
 *
 * So: whisper.cpp, bundled, speaking HTTP the same way llama-server does. The
 * shape of this module deliberately mirrors `runtimes/Bundled.js` — find a
 * binary in three places, return null rather than throwing when there is none,
 * start it lazily and let it go when nobody is talking.
 *
 * Two things are deliberately *not* here. There is no transcription port,
 * because there is one implementation and inventing an interface for a second
 * that does not exist is how a chat app becomes a framework. And the model is
 * not bundled: the binary is 4 MB and belongs in the app, the smallest useful
 * model is 78 MB and belongs to whoever turns dictation on.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { record as ledger } from '../reflect/Ledger.js';

/**
 * Models, smallest first.
 *
 * `tiny.en` is the default because dictation is a latency feature: text that
 * arrives a beat behind your voice feels broken however accurate it is, and
 * tiny is several times faster than base on the same audio. Anyone who would
 * rather have the accuracy can choose base.
 */
export const MODELS = {
  'tiny.en': { file: 'ggml-tiny.en.bin', bytes: 77_691_713, note: 'fastest, English only' },
  'base.en': { file: 'ggml-base.en.bin', bytes: 147_951_465, note: 'more accurate, English only' },
  base: { file: 'ggml-base.bin', bytes: 147_951_465, note: 'more accurate, many languages' },
};

export const DEFAULT_MODEL = 'tiny.en';

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Beside the chat models, not inside the memory folder. Weights are not memories. */
export const whisperDir = (home = path.join(os.homedir(), '.reflect')) => path.join(home, 'models', 'whisper');

export function modelPath(name = DEFAULT_MODEL, home) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Unknown whisper model: ${name}`);
  return path.join(whisperDir(home), spec.file);
}

export const hasModel = (name = DEFAULT_MODEL, home) => fs.existsSync(modelPath(name, home));

/** Same three places, same order, same reasons as the chat runtime. */
/** Two levels up from src/<dir>/ — the checkout, when there is one. */
const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function candidatePaths({ resourcesPath = null, env = process.env, root = repoRoot() } = {}) {
  const found = [];
  if (env.REFLECT_WHISPER_SERVER) found.push(env.REFLECT_WHISPER_SERVER);
  if (resourcesPath) found.push(path.join(resourcesPath, 'whisper', exe('whisper-server')));
  // Running from source: the repo's own vendor/ is where fetch-whisper.js puts it.
  // PATH was supposed to cover the developer case and does not — nobody adds
  // a project subfolder to PATH, so without this the bundled runtime is
  // invisible to everyone except a packaged build.
  if (root) found.push(path.join(root, 'vendor', 'whisper', exe('whisper-server')));
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    found.push(path.join(dir, exe('whisper-server')));
  }
  return found;
}

export function findBinary(opts = {}) {
  for (const candidate of candidatePaths(opts)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Absent is a fact to report, not a failure to raise: a machine without
      // whisper is a machine where dictation is simply not offered.
    }
  }
  return null;
}

/**
 * Download a model, reporting progress.
 *
 * Yields the same `{type:'progress'|'done'}` shape a chat model pull does, so
 * the client has one way to draw a download rather than two.
 */
export async function* pullModel(name = DEFAULT_MODEL, { home, signal } = {}) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Unknown whisper model: ${name}`);
  const dest = modelPath(name, home);
  if (fs.existsSync(dest)) {
    yield { type: 'done', model: name };
    return;
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // A download is the clearest case of the machine talking to the internet, and
  // the least likely to be noticed, because it happens once and in the
  // background the first time dictation is switched on.
  ledger({ kind: 'download', host: 'huggingface.co', detail: `whisper ${spec.file}` });
  const res = await fetch(`${HF}/${spec.file}`, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Downloading ${spec.file} returned ${res.status}`);

  const total = Number(res.headers.get('content-length')) || spec.bytes;
  // Written to a temp name and renamed, so an interrupted download cannot leave
  // a half a model that looks present and fails at load.
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;

  try {
    for await (const chunk of res.body) {
      out.write(Buffer.from(chunk));
      received += chunk.length;
      yield { type: 'progress', received, total, percent: Math.round((received / total) * 100), status: 'downloading' };
    }
    await new Promise((resolve, reject) => out.end(resolve).on('error', reject));
    await fsp.rename(tmp, dest);
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  yield { type: 'done', model: name };
}

/**
 * A running whisper-server, started on demand.
 *
 * One per process, kept warm. Loading the model takes a second or two, and
 * paying that on every utterance would make dictation feel broken; the server
 * is stopped when it has been idle long enough that the memory matters more.
 */
let running = null;

export async function ensureServer({ model = DEFAULT_MODEL, home, resourcesPath = null, root, idleMs = 5 * 60_000 } = {}) {
  if (running?.model === model) {
    touch(idleMs);
    return running;
  }
  if (running) stopServer();

  const binary = findBinary({ resourcesPath, ...(root === undefined ? {} : { root }) });
  if (!binary) return null;
  const weights = modelPath(model, home);
  if (!fs.existsSync(weights)) return null;

  const port = await freePort();
  const child = spawn(
    binary,
    ['--host', '127.0.0.1', '--port', String(port), '--model', weights, '--threads', String(Math.min(8, os.cpus().length))],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: false }
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`whisper-server exited with ${child.exitCode}`);
    try {
      // No health endpoint; a HEAD on the inference route is enough to know the
      // socket is up and the model has finished loading.
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(800) });
      if (res.status) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  running = { model, baseUrl, child, timer: null };
  touch(idleMs);
  return running;
}

function touch(idleMs) {
  if (!running) return;
  clearTimeout(running.timer);
  running.timer = setTimeout(stopServer, idleMs);
  running.timer.unref?.();
}

export function stopServer() {
  if (!running) return;
  clearTimeout(running.timer);
  try {
    running.child.kill();
  } catch {
    /* already gone */
  }
  running = null;
}

/**
 * Transcribe one WAV.
 *
 * The client sends 16 kHz mono PCM wrapped in a WAV header, which is what
 * whisper wants and what a browser can produce without ffmpeg in the middle.
 */
export async function transcribe(wav, { model = DEFAULT_MODEL, home, resourcesPath = null, root, signal } = {}) {
  const server = await ensureServer({ model, home, resourcesPath, root });
  if (!server) return null;

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');

  const res = await fetch(`${server.baseUrl}/inference`, { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error(`whisper-server returned ${res.status}`);
  const data = await res.json();
  // Whisper breaks its output into timed segments and joins them with
  // newlines. Those are not sentence breaks — they land mid-clause — and in a
  // composer where Enter sends the message, a stray newline is not cosmetic.
  // Speech has no line breaks in it; collapse them.
  return String(data.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ask the OS for a port rather than guessing one nobody else wanted. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
