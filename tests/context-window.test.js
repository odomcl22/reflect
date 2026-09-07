/**
 * The window Reflect plans for and the window Ollama serves must be one number.
 *
 * They were two until now. Ollama runs `llama-server -c 4096` unless told
 * otherwise; Reflect read `context_length: 32768` from the model metadata and
 * planned against that. Nothing failed loudly — Ollama context-shifts, dropping
 * the front of the prompt, which is where the frozen system prefix lives. These
 * tests exist so the two numbers can never drift apart again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-ctx-'));
process.env.REFLECT_HOME = tmpHome;

const { plan, windowFor, HARD_CAP, FLOOR } = await import('../src/context/ContextBudget.js');
const { OllamaAdapter } = await import('../src/adapters/inference/OllamaAdapter.js');
const FileStore = await import('../src/store/FileStore.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────── the number

test('the ceiling wins over what the model claims', () => {
  assert.equal(windowFor(131072, 8192), 8192);
  assert.equal(windowFor(32768, 8192), 8192);
});

test('a model smaller than the ceiling still wins', () => {
  assert.equal(windowFor(4096, 8192), 4096, 'never ask a 4k model to serve 8k');
});

test('nonsense lands on something serviceable', () => {
  assert.equal(windowFor(null, null), 8192);
  assert.equal(windowFor(0, 0), 8192, 'no numbers at all still has to serve a window');
  assert.equal(windowFor(1_000_000, 1_000_000), HARD_CAP);
  assert.equal(windowFor(32768, -1), HARD_CAP, 'a negative ceiling is no ceiling, not the smallest one');
  assert.equal(windowFor(32768, 512), FLOOR, 'a ceiling below the floor cannot make a useless window');
});

test('the budget plans against the capped window, not the claimed one', () => {
  const capped = plan({ contextLength: 131072, maxContext: 8192 });
  assert.equal(capped.window, 8192);
  assert.ok(capped.usable < 8192);
  // Every allocation is a share of the window actually served.
  const allocated = Object.values(capped.tokens).reduce((a, b) => a + b, 0);
  assert.ok(allocated <= capped.usable, 'the plan must fit inside the served window');
});

// ─────────────────────────────────────────────────────────── what Ollama hears

/** Capture the request bodies without a live Ollama. */
function captureFetch(bodies) {
  return async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '{}' }, done: true }),
      text: async () => '',
    };
  };
}

test('the planned window is sent as num_ctx', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = captureFetch(bodies);
  try {
    const ollama = new OllamaAdapter({ baseUrl: 'http://stub' });
    ollama.useContext('m', 8192);
    await ollama.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(bodies[0].options.num_ctx, 8192);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('one model gets one window across every kind of call', async () => {
  // Ollama reloads llama-server whenever num_ctx changes. A chat at 8192 and an
  // extraction at the default would evict and reload the model mid-turn.
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = captureFetch(bodies);
  try {
    const ollama = new OllamaAdapter({ baseUrl: 'http://stub' });
    ollama.useContext('m', 8192);
    await ollama.complete({ model: 'm', messages: [] });
    await ollama.complete({ model: 'm', messages: [], options: { num_predict: 30 } });
    assert.deepEqual(bodies.map((b) => b.options.num_ctx), [8192, 8192]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a model we know nothing about is not given a window', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = captureFetch(bodies);
  try {
    const ollama = new OllamaAdapter({ baseUrl: 'http://stub' });
    await ollama.complete({ model: 'unknown', messages: [] });
    assert.equal('num_ctx' in bodies[0].options, false, 'inventing a window for an unplanned call is worse than Ollama’s default');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an explicit num_ctx beats the stored one', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = captureFetch(bodies);
  try {
    const ollama = new OllamaAdapter({ baseUrl: 'http://stub' });
    ollama.useContext('m', 8192);
    await ollama.complete({ model: 'm', messages: [], options: { num_ctx: 2048 } });
    assert.equal(bodies[0].options.num_ctx, 2048);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ───────────────────────────────────────────────────────────────────── setting

test('maxContext is clamped on the way into the config', async () => {
  const { createApp } = await import('../src/app.js');
  const { app } = await createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const set = async (maxContext) => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxContext }),
    });
    return (await res.json()).maxContext;
  };

  try {
    assert.equal(await set(16384), 16384);
    assert.equal(await set(999999), HARD_CAP, 'a window larger than the hard cap is not a window, it is a swap file');
    assert.equal(await set(-1), HARD_CAP, 'junk falls back to the cap rather than a broken runtime');
  } finally {
    // Without this a failed assertion leaves the server listening and the whole
    // run hangs on an open handle instead of reporting the failure.
    await new Promise((resolve) => server.close(resolve));
  }
});
