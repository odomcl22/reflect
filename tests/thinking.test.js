/**
 * The thinking dial.
 *
 * Four stops in the UI, two shapes in Ollama, and models that support neither.
 * The mapping is the only place that knows how to reconcile those, so it is the
 * only place worth testing directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-think-'));
process.env.REFLECT_HOME = tmpHome;

const { LEVELS, DEFAULT_LEVEL, normalizeLevel, thinkParam, describeThinking, honoursLevels } =
  await import('../src/core/Thinking.js');
const FileStore = await import('../src/store/FileStore.js');

await FileStore.scaffold();

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────── the mapping

test('off means off, and it is the default', () => {
  assert.equal(DEFAULT_LEVEL, 'off');
  assert.equal(thinkParam('off', true), false);
  assert.deepEqual(LEVELS, ['off', 'low', 'medium', 'high']);
});

test('a level is passed through for a model that can reason', () => {
  assert.equal(thinkParam('low', true), 'low');
  assert.equal(thinkParam('medium', true), 'medium');
  assert.equal(thinkParam('high', true), 'high');
});

test('a model that cannot reason is never sent a think flag at all', () => {
  // Not `false` — sending a thinking parameter to a model with no thinking is a
  // request it never needed to see, and older Ollama builds reject it.
  // Off is sent regardless. The old behaviour returned undefined here, and the
  // dial did nothing on exactly the models people complain about: qwen3 and
  // deepseek-r1 reason by default and are not always marked `thinking`.
  assert.equal(thinkParam('off', false), false, 'off must reach the runtime even for an "incapable" model');
  // Asking for *more* reasoning still requires believing it can.
  assert.equal(thinkParam('high', false), undefined);
});

test('junk falls back to off rather than throwing', () => {
  assert.equal(normalizeLevel('MEDIUM'), 'medium');
  assert.equal(normalizeLevel('maximum'), 'off');
  assert.equal(normalizeLevel(undefined), 'off');
  assert.equal(normalizeLevel(null), 'off');
  assert.equal(normalizeLevel(3), 'off');
});

// ───────────────────────────────────────────────────────────── what it admits

test('a level flattened to plain on is reported as degraded', () => {
  const flattened = describeThinking('high', true, true, 'gpt-oss:20b');
  assert.equal(flattened.degraded, true);
  assert.equal(flattened.asked, 'high');
  assert.equal(flattened.applied, 'true');
});

test('a level Ollama accepted but the model ignores is still degraded', () => {
  // The trap this exists for: gemma accepts "high" and reasons exactly as much
  // as it would have at "low". Accepted is not the same as honoured.
  const swallowed = describeThinking('high', true, 'high', 'gemma4:e4b-mlx');
  assert.equal(swallowed.degraded, true, 'a level the model ignores must not be reported as honoured');
  assert.equal(swallowed.applied, 'high');
});

test('a level that was actually honoured is not degraded', () => {
  const kept = describeThinking('high', true, 'high', 'gpt-oss:20b');
  assert.equal(kept.degraded, false);
  assert.equal(kept.applied, 'high');
});

test('only measured families are credited with honouring levels', () => {
  assert.equal(honoursLevels('gpt-oss:20b'), true);
  assert.equal(honoursLevels('gpt-oss:120b-cloud'), true);
  assert.equal(honoursLevels('gemma4:e4b-mlx'), false);
  assert.equal(honoursLevels('qwen3:4b'), false);
  assert.equal(honoursLevels(undefined), false);
});

test('off is never degraded, and an unsupported model says so', () => {
  assert.equal(describeThinking('off', true, false, 'gemma4:e4b-mlx').degraded, false);
  const unsupported = describeThinking('high', false, undefined, 'llama3.2:1b');
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.applied, 'unsupported');
  assert.equal(unsupported.degraded, false);
});

// ─────────────────────────────────────────────────────────────────── settings

test('the setting round-trips through the API and rejects junk', async () => {
  const { createApp } = await import('../src/app.js');
  const { app } = await createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const set = async (thinking) => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking }),
    });
    return (await res.json()).thinking;
  };

  try {
    assert.equal(await set('high'), 'high');
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).thinking, 'high');
    assert.equal(await set('maximum overdrive'), 'off', 'an unknown level must land on off, not in the file');

    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.deepEqual(settings.thinkingLevels.map((l) => l.key), ['off', 'low', 'medium', 'high']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
