/**
 * Choosing a runtime over the API.
 *
 * The adapters are covered in `runtimes.test.js`. What is left is the part a
 * person actually touches, where the risks are different:
 *
 *   - a bad choice must be refused *before* it is saved, or a typo strands the
 *     app behind a runtime that answers nothing;
 *   - switching must reach the next chat turn, not just the settings screen;
 *   - the chosen model rarely exists on the new runtime, and a stale name
 *     produces a confusing failure one turn later instead of an obvious
 *     "pick a model" now.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-runtime-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
await FileStore.scaffold();

const { createApp } = await import('../src/app.js');
const { app } = await createApp();
const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

/** A stand-in llama-server: OpenAI surface, /props, and a model manager. */
const fake = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

  if (url === '/v1/models') return json({ data: [{ id: 'tiny', meta: { n_ctx_train: 4096 } }] });
  if (url === '/props') return json({ default_generation_settings: { n_ctx: 4096 } });
  // Both names: the one already installed, and the one the pull test asks for.
  // A finished download is only believed if the model actually appears here,
  // so a fake that forgets to list it fails the same way a real 401 would.
  if (url === '/models' && req.method === 'GET')
    return json({ models: [{ id: 'tiny' }, { id: 'org/tiny:Q4_K_M' }] });
  if (url === '/models' && req.method === 'POST') return json({ ok: true });
  if (url === '/models/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // `event`, not `type` — the shape a real llama-server sends.
    res.write(`data: ${JSON.stringify({ event: 'download_progress', data: { files: [{ done: 5, total: 10 }] } })}\n\n`);
    res.write(`data: ${JSON.stringify({ event: 'download_finished' })}\n\n`);
    return res.end();
  }
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

test.after(async () => {
  server.close();
  fake.close();
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

const api = async (p, init) => {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
};

// ───────────────────────────────────────────────────────────────────── listing

test('the app reports which runtime it is on before anyone has chosen', async () => {
  const { body } = await api('/api/runtimes');
  assert.equal(body.current.provider, 'ollama');
  assert.equal(body.current.implicit, true, 'an inherited default is not a decision');
  assert.ok(body.current.capabilities, 'the picker needs to know what it can offer');
  assert.ok(Array.isArray(body.detected));
});

// ─────────────────────────────────────────────────────────────────── choosing

test('a runtime that answers nothing is refused before it is saved', async () => {
  const before = (await FileStore.loadConfig()).runtime;

  const dead = await api('/api/runtime', {
    method: 'PUT',
    body: JSON.stringify({ provider: 'openai-compat', baseUrl: 'http://127.0.0.1:1' }),
  });
  assert.equal(dead.status, 400);
  assert.match(dead.body.error, /Nothing is answering/);

  const unknown = await api('/api/runtime', {
    method: 'PUT',
    body: JSON.stringify({ provider: 'telepathy' }),
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown runtime provider/);

  assert.deepEqual((await FileStore.loadConfig()).runtime, before, 'a refused choice must not be written');
});

test('choosing a runtime saves it, and switches the model to one it actually has', async () => {
  await FileStore.saveConfig({ model: 'a-model-only-ollama-had' });

  const { status, body } = await api('/api/runtime', {
    method: 'PUT',
    body: JSON.stringify({ provider: 'llamacpp', baseUrl: FAKE }),
  });
  assert.equal(status, 200);
  assert.equal(body.current.provider, 'llamacpp');
  assert.equal(body.current.capabilities.models, 'list+pull');

  // Keeping the old name would fail one turn later, somewhere far away from the
  // screen where the change was made.
  assert.equal(body.model, 'tiny');
  const saved = await FileStore.loadConfig();
  assert.equal(saved.runtime.provider, 'llamacpp');
  assert.equal(saved.model, 'tiny');
  assert.equal(saved.embedModel, null, 'the old embedding model belonged to the old runtime');
});

test('the switch reaches the rest of the app, not just the settings screen', async () => {
  // /api/models is served by whatever `runtime` currently points at. If the
  // route closed over the old adapter, this would still be listing Ollama's
  // models — which is the bug this asserts against.
  const { body } = await api('/api/models');
  assert.ok(body.models.some((m) => m.name === 'tiny'), 'it should be listing the fake llama.cpp models');
  assert.equal(body.capabilities.id, 'llamacpp');

  const health = await api('/api/health');
  assert.equal(health.body.runtime.ok, true, 'health follows the choice too');
});

test('a chosen runtime survives a restart, and is not re-detected', async () => {
  // A runtime is a decision. Booting into whatever happens to be answering a
  // well-known port would move someone off the runtime holding their models.
  const { app: second } = await createApp();
  const s2 = second.listen(0);
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/runtimes`).then((r) => r.json());
  assert.equal(res.current.provider, 'llamacpp');
  assert.ok(!res.current.implicit, 'a saved choice is not an inherited default');
  s2.close();
});

// ───────────────────────────────────────────────────────────────────── pulling

test('a pull streams progress and finishes', async () => {
  const res = await fetch(`${BASE}/api/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'org/tiny:Q4_K_M' }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const events = (await res.text())
    .split('\n\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)));

  assert.equal(events[0].type, 'progress');
  assert.equal(events[0].percent, 50);
  assert.equal(events.at(-1).type, 'done');
});

test('pulling nothing, or from a runtime that cannot, says so', async () => {
  const empty = await api('/api/models/pull', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /Which model/);

  // A base URL someone pasted has no model manager, so the route refuses rather
  // than opening a stream that will only ever carry an error.
  await api('/api/runtime', {
    method: 'PUT',
    body: JSON.stringify({ provider: 'openai-compat', baseUrl: FAKE }),
  });
  const cannot = await api('/api/models/pull', { method: 'POST', body: JSON.stringify({ model: 'x' }) });
  assert.equal(cannot.status, 400);
  assert.match(cannot.body.error, /cannot download models/);
});
