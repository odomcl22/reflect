/**
 * Connectors: MCP, spoken directly, and routed so a small model survives it.
 *
 * Everything here runs against a real MCP server — tests/fixtures/mcp-server.mjs
 * — over stdio and over HTTP, with pagination, a server-initiated ping that
 * must be answered, and a tool-call answer delivered as an event stream. It
 * never contacts anything outside this machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-connectors-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const C = await import('../src/connectors/Connectors.js');

await FileStore.scaffold();

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const PORT = 38000 + Math.floor(Math.random() * 1000);
const http = spawn(process.execPath, [FIXTURE, '--http', String(PORT)], { stdio: 'ignore' });
const httpToken = spawn(process.execPath, [FIXTURE, '--http', String(PORT + 1), '--token', 'sekrit'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

test.after(async () => {
  await C.shutdown();
  http.kill();
  httpToken.kill();
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

// ──────────────────────────────────────────────── adding one

test('only a well-formed connector can be added', async () => {
  assert.match((await C.add({ name: 'Bad Name', command: 'x' })).reason, /lowercase/);
  assert.match((await C.add({ name: 'nothing' })).reason, /command to run or an address/);
  assert.match((await C.add({ name: 'ftp-thing', url: 'ftp://x' })).reason, /http or https/);
});

test('a local server speaks the protocol end to end', async () => {
  const added = await C.add({ name: 'testbox', command: process.execPath, args: [FIXTURE] });
  assert.equal(added.ok, true);
  assert.match((await C.add({ name: 'testbox', command: 'x' })).reason, /already/);

  // Listing needs the pagination cursor followed, and the server's own ping
  // answered first — the fixture holds the list until it is.
  const t = await C.test('testbox');
  assert.equal(t.ok, true, t.reason);
  assert.equal(t.server?.name, 'test-server');
  assert.deepEqual(t.tools.map((x) => x.name).sort(), ['add', 'broken', 'echo', 'env']);
});

test('a routed call reaches the tool and brings its answer back', async () => {
  const out = await C.call({ connector: 'testbox', tool: 'echo' }, { text: 'hello' });
  assert.deepEqual(out, { ok: true, text: 'echo: hello' });
  assert.equal((await C.call({ connector: 'testbox', tool: 'add' }, { a: 2, b: 3 })).text, '5');
});

test('a tool that reports an error is not reported as success', async () => {
  const out = await C.call({ connector: 'testbox', tool: 'broken' }, {});
  assert.equal(out.ok, false);
});

// A connector is somebody else's program. Reflect's environment can hold keys
// for other things, and a server gets only what it needs to run.
test("a local server does not inherit Reflect's environment", async () => {
  process.env.REFLECT_TEST_SECRET = 'do-not-pass-this-on';
  await C.remove('testbox');
  await C.add({ name: 'testbox', command: process.execPath, args: [FIXTURE] });
  const out = await C.call({ connector: 'testbox', tool: 'env' }, {});
  delete process.env.REFLECT_TEST_SECRET;
  assert.equal(out.text, 'clean');
});

test('a connector that will not start fails the tool, not the turn', async () => {
  await C.add({ name: 'ghost', command: '/nonexistent/binary/reflect-test' });
  const turn = await C.forTurn('ask ghost something');
  assert.equal(turn.schemas.length, 0);
  assert.equal(turn.failed[0].name, 'ghost');
  await C.remove('ghost');
});

// ──────────────────────────────────────────────── routing

test('a connector comes into a turn only when the turn is about it', async () => {
  const about = await C.forTurn('can you echo something with testbox');
  assert.ok(about.schemas.length > 0, 'named, but not offered');
  assert.ok(about.schemas.every((s) => s.function.name.startsWith('testbox__')));

  const not = await C.forTurn('what is the capital of France?');
  assert.equal(not.schemas.length, 0, 'offered to a turn that never mentioned it');
});

test('@name routes, and so do words the person gave it', async () => {
  const all = await C.list();
  assert.equal(C.named('@testbox please', all).length, 1);
  await C.remove('testbox');
  await C.add({ name: 'testbox', command: process.execPath, args: [FIXTURE], aliases: 'calculator, sums' });
  assert.equal(C.named('do my sums', await C.list()).length, 1);
});

// Generic words say nothing about a connector. "server" in a message is not a
// request for every connector whose name contains it.
test('generic words do not route', () => {
  const fake = [{ name: 'notes-mcp-server', enabled: true }];
  assert.equal(C.named('restart the server', fake).length, 0);
  assert.equal(C.named('open my notes', fake).length, 1);
});

test('a switched-off connector is never routed', async () => {
  await C.setEnabled('testbox', false);
  assert.equal((await C.forTurn('testbox echo')).schemas.length, 0);
  await C.setEnabled('testbox', true);
});

// Past the cap, the tools that share the most words with the request win.
test('the cap keeps the tools that fit the request', async () => {
  const turn = await C.forTurn('testbox: add two numbers together', { cap: 1 });
  assert.equal(turn.schemas.length, 1);
  assert.equal(turn.routes[turn.schemas[0].function.name].tool, 'add');
  assert.equal(turn.dropped, 3);
});

// ──────────────────────────────────────────────── over HTTP

test('a remote server works over HTTP, JSON and event-stream answers both', async () => {
  await C.add({ name: 'remotebox', url: `http://127.0.0.1:${PORT}/mcp` });
  const t = await C.test('remotebox');
  assert.equal(t.ok, true, t.reason);
  assert.equal(t.tools.length, 4);
  const out = await C.call({ connector: 'remotebox', tool: 'echo' }, { text: 'over http' });
  assert.equal(out.text, 'echo: over http');
});

test('a server that wants a token says so, and works once given one', async () => {
  await C.add({ name: 'lockedbox', url: `http://127.0.0.1:${PORT + 1}/mcp` });
  const refused = await C.test('lockedbox');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /credentials|token/);

  await C.remove('lockedbox');
  await C.add({ name: 'lockedbox', url: `http://127.0.0.1:${PORT + 1}/mcp`, headers: { Authorization: 'Bearer sekrit' } });
  assert.equal((await C.test('lockedbox')).ok, true);
});

// A skill that names a connector brings it — the composition of the two. The
// controller routes on the message plus any skill's instructions; here, the
// part that decides it: a skill's words route the same way a person's do.
test("a skill's own instructions route its connector", async () => {
  const body = 'Work out the total with the testbox connector, then say what each person pays.';
  const turn = await C.forTurn(body);
  assert.ok(turn.connectors.includes('testbox'));
});
