/**
 * Appearance: text size, reading font, accent, width, send key.
 *
 * The page draws every value in APPEARANCE and nothing else, so the server
 * keeps anything else out of the config — a stray request cannot leave the app
 * in a look its own settings screen has no option for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-look-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { createApp, APPEARANCE } = await import('../src/app.js');
await FileStore.scaffold();

const { app } = await createApp();
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

const set = async (appearance) =>
  (await (await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appearance }),
  })).json()).appearance;

test('every choice the page offers is kept', async () => {
  const all = { textSize: 'xl', font: 'serif', accent: 'violet', width: 'wide', sendKey: 'mod-enter' };
  assert.deepEqual(await set(all), all);
  for (const [k, values] of Object.entries(APPEARANCE)) for (const v of values) assert.equal((await set({ [k]: v }))[k], v);
});

test('one change does not reset the others', async () => {
  await set({ textSize: 'l', accent: 'rose' });
  const after = await set({ font: 'mono' });
  assert.equal(after.textSize, 'l');
  assert.equal(after.accent, 'rose');
});

test('a value the page cannot draw keeps the one before it', async () => {
  await set({ accent: 'green' });
  const after = await set({ accent: 'url(javascript:alert(1))', textSize: 9000, width: { nested: true } });
  assert.equal(after.accent, 'green');
  assert.ok(APPEARANCE.textSize.includes(after.textSize));
  assert.ok(APPEARANCE.width.includes(after.width));
  assert.deepEqual(Object.keys(await set({ evil: 'x' })).includes('evil'), false);
});
