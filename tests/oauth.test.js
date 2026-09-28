/**
 * Signing in to a connector through the browser.
 *
 * Against a local stand-in for a hosted service (fixtures/oauth-server.mjs)
 * that is strict where real ones are: PKCE checked, registered redirect URIs
 * only, resource indicator matched, codes single-use. The step where a person
 * signs in and presses Allow is the one fetch below that follows the
 * authorization page's redirect — which is all a browser does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-oauth-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const C = await import('../src/connectors/Connectors.js');
const OAuth = await import('../src/connectors/OAuth.js');

await FileStore.scaffold();

/** Wait until a fixture server answers. A fixed pause loses under a busy full suite. */
async function listening(port) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`fixture server on ${port} never started`);
}

const FIXTURE = fileURLToPath(new URL('./fixtures/oauth-server.mjs', import.meta.url));
const PORT = 39000 + Math.floor(Math.random() * 500);
const servers = [
  spawn(process.execPath, [FIXTURE, String(PORT)], { stdio: 'ignore' }),
  spawn(process.execPath, [FIXTURE, String(PORT + 1), '--no-register'], { stdio: 'ignore' }),
];
await Promise.all([listening(PORT), listening(PORT + 1)]);

const REDIRECT = 'http://127.0.0.1:5555/api/connectors/oauth/callback';

/** What the person's browser does: open the page, sign in, get sent back. */
async function approve(url) {
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302, 'the sign-in page refused the request');
  const back = new URL(res.headers.get('location'));
  return { code: back.searchParams.get('code'), state: back.searchParams.get('state') };
}

test.after(async () => {
  await C.shutdown();
  servers.forEach((s) => s.kill());
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('an unsigned connector says it needs signing in, not that it is broken', async () => {
  await C.add({ name: 'cloudy', url: `http://127.0.0.1:${PORT}/mcp` });
  const t = await C.test('cloudy');
  assert.equal(t.ok, false);
  assert.equal(t.needsSignIn, true);
});

test('sign in: discover, register, PKCE, come back, exchange — then it works', async () => {
  const c = (await C.list()).find((x) => x.name === 'cloudy');
  const started = await OAuth.begin(c, { redirectUri: REDIRECT });
  assert.equal(started.ok, true);
  const u = new URL(started.url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('resource'), `http://127.0.0.1:${PORT}/mcp`, 'the token must be minted for this connector only');

  const { code, state } = await approve(started.url);
  const done = await OAuth.finish(state, code);
  assert.equal(done.ok, true, done.reason);

  const t = await C.test('cloudy');
  assert.equal(t.ok, true, t.reason);
  assert.equal((await C.call({ connector: 'cloudy', tool: 'whoami' }, {})).text, 'signed in as the test user');
});

// A sign-in link is single-use. A page elsewhere cannot finish one twice, or
// finish one the person never started.
test('a sign-in cannot be finished twice, or with a made-up state', async () => {
  const c = (await C.list()).find((x) => x.name === 'cloudy');
  const { url } = await OAuth.begin(c, { redirectUri: REDIRECT });
  const { code, state } = await approve(url);
  assert.equal((await OAuth.finish(state, code)).ok, true);
  assert.equal((await OAuth.finish(state, code)).ok, false, 'the same state finished twice');
  assert.equal((await OAuth.finish('made-up', 'code-1')).ok, false);
});

// An expired token is the ordinary case. It refreshes quietly and the call
// goes through; the person is not asked to sign in again.
test('an expired token refreshes quietly and the call still works', async () => {
  await fetch(`http://127.0.0.1:${PORT}/test/expire-all`, { method: 'POST' });
  await C.shutdown(); // a fresh connection, so the stale token is actually used
  const out = await C.call({ connector: 'cloudy', tool: 'whoami' }, {});
  assert.equal(out.ok, true, out.text);
});

test('the tokens are readable by their owner only, and listed without them', async () => {
  const stat = await fsp.stat(path.join(tmpHome, 'connector-auth.json'));
  assert.equal(stat.mode & 0o077, 0, 'the token file is readable by others');
  const listed = (await C.listWithStatus()).find((x) => x.name === 'cloudy');
  assert.equal(listed.auth.signedIn, true);
  assert.ok(!JSON.stringify(listed).includes('at-'), 'a token leaked into the connector list');
});

test('signing out means signing in again', async () => {
  await OAuth.signOut('cloudy');
  await C.shutdown();
  const t = await C.test('cloudy');
  assert.equal(t.needsSignIn, true);
});

test('removing a connector removes its tokens', async () => {
  const c = (await C.list()).find((x) => x.name === 'cloudy');
  const { url } = await OAuth.begin(c, { redirectUri: REDIRECT });
  const { code, state } = await approve(url);
  await OAuth.finish(state, code);
  await C.remove('cloudy');
  assert.equal((await OAuth.status('cloudy')).signedIn, false);
});

// Some services will not let apps register themselves. Say so, and let a
// pasted client ID do what registration would have.
test('a service that will not register apps asks for a client ID — and works with one', async () => {
  await C.add({ name: 'strict', url: `http://127.0.0.1:${PORT + 1}/mcp` });
  let c = (await C.list()).find((x) => x.name === 'strict');
  const refused = await OAuth.begin(c, { redirectUri: REDIRECT });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /client ID/);

  await C.remove('strict');
  await C.add({ name: 'strict', url: `http://127.0.0.1:${PORT + 1}/mcp`, clientId: 'pre-registered' });
  c = (await C.list()).find((x) => x.name === 'strict');
  const { url } = await OAuth.begin(c, { redirectUri: REDIRECT });
  const { code, state } = await approve(url);
  assert.equal((await OAuth.finish(state, code)).ok, true);
});

test('sign-in over plain HTTP is only allowed on this machine', () => {
  assert.equal(OAuth.secureEnough('https://accounts.example.com/authorize'), true);
  assert.equal(OAuth.secureEnough('http://127.0.0.1:9000/authorize'), true);
  assert.equal(OAuth.secureEnough('http://accounts.example.com/authorize'), false);
});
