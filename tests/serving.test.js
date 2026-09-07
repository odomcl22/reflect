/**
 * How Reflect is served, and to whom.
 *
 * Two things changed when the app grew a desktop shell, and both are the kind
 * that fail silently:
 *
 *   1. **The bind address.** Reflect served on 0.0.0.0 until M10, which meant
 *      that on any shared network — an office, a café, a hotel — anyone could
 *      open it, read the memory files, and use the folder tools on whatever had
 *      been granted. There is no authentication, and there is not meant to be:
 *      the premise is that the only person who can reach it is the person at
 *      the machine. A bind address is what enforces that premise.
 *
 *   2. **The address the server uses to reach itself.** A task run posts to
 *      `/api/chat`, and used to build that URL from the PORT constant. Under
 *      the shell the real port is whatever the OS handed out, so a task would
 *      have posted to 3040 and reached either nothing or a different Reflect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-serving-'));
process.env.REFLECT_HOME = tmpHome;

const { HOST } = await import('../src/config.js');
const FileStore = await import('../src/store/FileStore.js');
await FileStore.scaffold();

const { createApp } = await import('../src/app.js');
const { app } = await createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** Stands in for the server's own /api/chat, so we can see where a task posts. */
const seen = [];
const stub = http.createServer((req, res) => {
  seen.push(req.url);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'start', conversationId: 'from-the-stub' })}\n\n`);
  res.end();
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

test.after(async () => {
  server.close();
  stub.close();
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

/** A GET with headers `fetch` refuses to forge, such as Host. */
const rawGet = (pathname, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: pathname, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });

// ───────────────────────────────────────────────────────────── who can reach it

test('the default bind address is loopback', () => {
  // If this ever reads 0.0.0.0 again, an unauthenticated assistant with file
  // write access is listening to the network.
  assert.equal(HOST, '127.0.0.1');
});

test('serving to the network stays possible, but only on purpose', async () => {
  // Someone deliberately serving Reflect to their own machines should be able
  // to. The requirement is that it cannot happen by default or by accident.
  const before = process.env.REFLECT_HOST;
  process.env.REFLECT_HOST = '0.0.0.0';
  const fresh = await import(`../src/config.js?opt-in=${Date.now()}`);
  assert.equal(fresh.HOST, '0.0.0.0');
  if (before === undefined) delete process.env.REFLECT_HOST;
  else process.env.REFLECT_HOST = before;
});

// ──────────────────────────────────────────────── how it reaches itself

test('a task posts to the port actually bound, not the one configured', async () => {
  await fetch(`${BASE}/api/tasks/selfaddr`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: 'Say something.', when: 'manual' }),
  });

  // What listen() reported, which under the desktop shell is a port the OS
  // chose a moment ago and nothing else knows.
  app.set('selfUrl', STUB);

  const run = await fetch(`${BASE}/api/tasks/selfaddr/run`, { method: 'POST' }).then((r) => r.json());
  assert.deepEqual(seen, ['/api/chat'], 'the task did not reach the address the server is bound to');
  assert.equal(run.conversationId, 'from-the-stub');
});

// ───────────────────────────────────────────────────────────────── the shell

test('the desktop shell adds a window, not a second implementation', async () => {
  const source = await fsp.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  // The shell must reuse the server. The day it grows its own routes there are
  // two Reflects to keep in step, and only one of them has tests.
  for (const forbidden of ['app.get(\'/api', 'app.post(\'/api', 'express(']) {
    assert.ok(!code.includes(forbidden), `the shell started implementing the server: ${forbidden}`);
  }
  assert.match(code, /createApp/, 'it should start the same app npm start does');

  // Loopback in the shell too — it does not read HOST, so it has to say so.
  assert.match(code, /listen\(0, '127\.0\.0\.1'/, 'the shell must bind loopback');

  // Two copies would race for one memory folder and run every scheduled task
  // twice, once per scheduler.
  assert.match(code, /requestSingleInstanceLock/, 'a second copy must not start a second scheduler');

  // The renderer displays model output. It has no business holding Node.
  assert.match(code, /nodeIntegration:\s*false/);
  assert.match(code, /contextIsolation:\s*true/);
});

// ──────────────────────────────────────────────── who else can reach it

test('another website cannot read anything, even from this machine', async () => {
  // The attack this replaces: Reflect ran cors() with no options, so every
  // response carried Access-Control-Allow-Origin: *. Binding to loopback did
  // nothing against it — the request came from the user's own browser. One
  // visit to a hostile page while Reflect was running was enough to read
  // USER.md and list every connected folder.
  const res = await fetch(`${BASE}/api/memory/file?path=USER.md`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /other websites/);
});

test('no response invites a cross-origin read', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    null,
    'a wildcard here hands the API to every page the user has open'
  );
});

test('the app talking to itself is fine', async () => {
  // The client is served by this same app, so its Origin is this same origin.
  const res = await fetch(`${BASE}/api/health`, { headers: { Origin: BASE } });
  assert.equal(res.status, 200);
});

test('a request with no Origin at all still works', async () => {
  // Typing the address, a curl, the Electron window's first load. Only browsers
  // send Origin, and only on cross-document requests.
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
});

test('a name rebound to this machine is refused', async () => {
  // DNS rebinding: the attacker points a domain they own at 127.0.0.1, so their
  // page becomes genuinely same-origin and the Origin check passes honestly.
  // The request still arrives addressed to their hostname.
  // Raw http, because fetch treats Host as a forbidden header and will not let
  // a caller forge it — which is exactly what a rebinding attacker does not
  // need to do, since the browser sets it from the URL for them.
  const res = await rawGet('/api/health', { Host: 'rebound.evil.example' });
  assert.equal(res.status, 403);
  assert.match(res.body, /only answers on localhost/);
});

test('cors is gone from the code, not just unused', async () => {
  const source = await fsp.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  assert.ok(!/require\(['"]cors|from ['"]cors|cors\(\)/.test(code), 'cors() reopens the hole');

  const pkg = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.dependencies?.cors, 'and it should not still be a dependency');
});

// ───────────────────────────────────────────────────── attachments over HTTP

test('an uploaded file comes back as itself, and cannot be run', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
  const put = await fetch(`${BASE}/api/attachments/conv-http/pic.png`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(put.status, 200);

  const got = await fetch(`${BASE}/api/attachments/conv-http/pic.png`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  // These bytes reached disk because someone dragged a file in, and a file the
  // browser decides is HTML would run in this origin — the same origin holding
  // every memory file.
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-security-policy'), /default-src 'none'/);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...png]);
});

test('an attachment name cannot climb out of its conversation', async () => {
  const escape = await fetch(`${BASE}/api/attachments/conv-http/${encodeURIComponent('../../escaped.md')}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal(escape.status, 400);
});
