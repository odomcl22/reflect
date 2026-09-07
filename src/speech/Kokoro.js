/**
 * A voice worth listening to, for people who want one.
 *
 * The browser's own speech is instant and free, and on a Mac without the
 * enhanced voices installed it sounds like 2005. Kokoro is an 82M-parameter
 * neural model that sounds like a person. The trade is entirely speed:
 * measured on an M-series Mac it generates roughly 0.7 to 1.4 times real time,
 * so a sentence takes a few seconds to appear. That is why this is off by
 * default and why the browser voice remains the fallback — an assistant that
 * pauses for four seconds before speaking is worse than one that sounds plain.
 *
 * ## Why it is not installed with everything else
 *
 * Reflect has one runtime dependency. Kokoro needs two more — a phonemizer
 * (2.6 MB, no dependencies of its own) and ONNX Runtime (283 MB, because it
 * ships binaries for every platform) — plus an 82 MB model. Making everyone
 * carry 370 MB for a feature most will not turn on would be the wrong trade,
 * so they are optional dependencies, fetched by `npm run install:voice`, and
 * everything here degrades to "not available" without them.
 *
 * ## Voices are vectors, which is more interesting than it sounds
 *
 * A Kokoro voice is not a recording. It is a 256-float style vector, 510 of
 * them per file, indexed by how many phonemes you are about to speak. Because
 * they are vectors, two of them average into a third that sounds like neither
 * parent exactly — a real voice between two voices, for the cost of adding
 * some numbers. `blend` does that. It is the whole "custom voice" feature, and
 * it needs no extra model, no training and no recording of anybody.
 *
 * Cloning someone's actual voice is a different model and a different
 * conversation, and is deliberately not here.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { record as ledger } from '../reflect/Ledger.js';

const HF = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';

/** Beside the chat and dictation models. Weights are not memories. */
export const modelDir = (home = path.join(os.homedir(), '.reflect')) =>
  path.join(process.env.REFLECT_HOME || home, 'models', 'kokoro');

/**
 * The quantisation to fetch.
 *
 * q8f16 is 82 MB against 325 MB for the full weights, and the difference is not
 * audible on a laptop speaker. The larger ones are not offered because the cost
 * is real and the gain is not.
 */
export const MODEL_FILE = 'model_q8f16.onnx';
export const MODEL_BYTES = 86_000_000;

/**
 * The voices worth offering, rather than all fifty-five.
 *
 * A list nobody can get through is not a choice. These are the clearest of the
 * English voices, two accents, both registers.
 */
export const VOICES = [
  { id: 'af_heart', name: 'Heart', note: 'American, warm' },
  { id: 'af_bella', name: 'Bella', note: 'American, bright' },
  { id: 'af_nicole', name: 'Nicole', note: 'American, soft' },
  { id: 'am_michael', name: 'Michael', note: 'American, low' },
  { id: 'am_fenrir', name: 'Fenrir', note: 'American, firm' },
  { id: 'bf_emma', name: 'Emma', note: 'British, warm' },
  { id: 'bf_isabella', name: 'Isabella', note: 'British, even' },
  { id: 'bm_george', name: 'George', note: 'British, low' },
  { id: 'bm_lewis', name: 'Lewis', note: 'British, dry' },
];

const SAMPLE_RATE = 24_000;

let session = null;
let vocab = null;
let phonemize = null;

/** Both optional dependencies, loaded only when something asks to speak. */
async function deps() {
  try {
    const [ort, ph] = await Promise.all([import('onnxruntime-node'), import('phonemizer')]);
    return { ort: ort.default || ort, phonemize: ph.phonemize };
  } catch {
    return null;
  }
}

export async function installed() {
  return Boolean(await deps());
}

export const hasModel = (dir = modelDir()) => fs.existsSync(path.join(dir, MODEL_FILE));

/** Everything present and ready to speak. */
export async function available(dir = modelDir()) {
  return hasModel(dir) && (await installed());
}

/**
 * Fetch the model and the voices. About 90 MB, once.
 *
 * Written to a temporary name and renamed, so an interrupted download cannot
 * leave a half file that looks complete on the next run.
 */
export async function download({ dir = modelDir(), onProgress = null, signal } = {}) {
  await fsp.mkdir(dir, { recursive: true });

  const want = [
    { url: `${HF}/onnx/${MODEL_FILE}`, to: MODEL_FILE, bytes: MODEL_BYTES },
    { url: `${HF}/tokenizer.json`, to: 'tokenizer.json', bytes: 40_000 },
    ...VOICES.map((v) => ({ url: `${HF}/voices/${v.id}.bin`, to: `${v.id}.bin`, bytes: 523_000 })),
  ];

  for (const item of want) {
    const dest = path.join(dir, item.to);
    if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 1000) continue;

    ledger({ kind: 'download', host: 'huggingface.co', detail: `kokoro ${item.to}` });
    const res = await fetch(item.url, { redirect: 'follow', signal });
    if (!res.ok) throw new Error(`Downloading ${item.to} returned ${res.status}`);

    const tmp = `${dest}.part`;
    const total = Number(res.headers.get('content-length')) || item.bytes;
    let got = 0;
    const out = fs.createWriteStream(tmp);
    for await (const chunk of res.body) {
      got += chunk.length;
      out.write(chunk);
      onProgress?.({ file: item.to, got, total });
    }
    await new Promise((r) => out.end(r));
    await fsp.rename(tmp, dest);
  }
  return { ok: true, dir };
}

/** Loaded once and kept. The model is 82 MB; reloading it per sentence is silly. */
async function load(dir = modelDir()) {
  if (session) return true;
  const d = await deps();
  if (!d || !hasModel(dir)) return false;

  session = await d.ort.InferenceSession.create(path.join(dir, MODEL_FILE));
  vocab = JSON.parse(await fsp.readFile(path.join(dir, 'tokenizer.json'), 'utf8')).model.vocab;
  phonemize = d.phonemize;
  return true;
}

export function unload() {
  session = null;
  vocab = null;
  phonemize = null;
}

/**
 * A voice, or the average of two.
 *
 * The file is [510][1][256] — one style vector per possible phoneme count, so
 * the right row depends on how much you are about to say. Blending averages
 * the same row of two voices, which is why it produces something coherent
 * rather than noise.
 */
async function styleFor(dir, voice, blend, tokenCount) {
  const read = async (id) => {
    const buf = await fsp.readFile(path.join(dir, `${id}.bin`));
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };
  const rows = (v) => v.length / 256;
  const a = await read(voice);
  const row = Math.min(tokenCount, rows(a) - 1);
  const slice = (v) => v.slice(row * 256, row * 256 + 256);

  if (!blend || blend.with === voice || !(blend.amount > 0)) return slice(a);

  const b = await read(blend.with);
  const x = slice(a);
  const y = b.slice(Math.min(tokenCount, rows(b) - 1) * 256, Math.min(tokenCount, rows(b) - 1) * 256 + 256);
  const k = Math.min(1, Math.max(0, blend.amount));
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) out[i] = x[i] * (1 - k) + y[i] * k;
  return out;
}

const wav = (samples) => {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24);
  head.writeUInt32LE(SAMPLE_RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
};

/**
 * Say something. Returns a WAV buffer, or a reason it could not.
 *
 * Text longer than the model's window is spoken in pieces and joined, because
 * the alternative is a reply that stops mid-sentence.
 */
export async function speak({ text, voice = 'af_heart', speed = 1, blend = null, dir = modelDir() } = {}) {
  const said = String(text || '').trim();
  if (!said) return { ok: false, reason: 'nothing to say' };
  if (!(await load(dir))) {
    return { ok: false, reason: 'The voice is not installed. Settings → Voice → Install.' };
  }

  const ort = (await deps()).ort;
  const chunks = await phonemize(said, 'en-us');
  const pieces = [];

  for (const ps of Array.isArray(chunks) ? chunks : [chunks]) {
    const ids = [0, ...[...ps].map((c) => vocab[c]).filter((n) => n !== undefined), 0];
    if (ids.length <= 2) continue;
    // 510 style rows is also the model's practical ceiling; longer runs are cut
    // rather than sent, because a failed tensor is worse than a pause.
    if (ids.length > 509) ids.length = 509;

    const style = await styleFor(dir, voice, blend, ids.length);
    const out = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      style: new ort.Tensor('float32', style, [1, 256]),
      speed: new ort.Tensor('float32', Float32Array.from([Math.min(2, Math.max(0.5, speed))]), [1]),
    });
    pieces.push(out.waveform.data);
  }

  if (!pieces.length) return { ok: false, reason: 'nothing speakable in that' };
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const p of pieces) {
    all.set(p, at);
    at += p.length;
  }
  return { ok: true, wav: wav(all), seconds: total / SAMPLE_RATE };
}
