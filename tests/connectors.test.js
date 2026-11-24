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

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const PORT = 38000 + Math.floor(Math.random() * 1000);
const http = spawn(process.execPath, [FIXTURE, '--http', String(PORT)], { stdio: 'ignore' });
const httpToken = spawn(process.execPath, [FIXTURE, '--http', String(PORT + 1), '--token', 'sekrit'], { stdio: 'ignore' });
await Promise.all([listening(PORT), listening(PORT + 1)]);

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

// "Calendars" should reach a connector named calendar; a plural is not a
// different system. Both sides are reduced alike, so imperfect rules still meet.
test('plural and singular reach the same connector', () => {
  const cs = [
    { name: 'google-calendar', enabled: true },
    { name: 'issue-tracker', enabled: true },
    { name: 'address-book', enabled: true },
    { name: 'journal-entries', enabled: true },
  ];
  assert.equal(C.named('what is on my calendars', cs)[0]?.name, 'google-calendar');
  assert.equal(C.named('any new issues?', cs)[0]?.name, 'issue-tracker');
  assert.equal(C.named('look up the addresses', cs)[0]?.name, 'address-book');
  assert.equal(C.named('add a journal entry', cs).map((c) => c.name).includes('journal-entries'), true);
  assert.equal(C.named('restart the servers', [{ name: 'notes-server', enabled: true }]).length, 0, 'plural of a generic word is still generic');
});

// ──────────────────────────────────────────────── secrets

const Secrets = await import('../src/connectors/Secrets.js');

// A pasted token used to be written into connectors.json as a header, and sent
// back to the settings page with every listing. It now lives in its own
// owner-only file, and the header carries only a placeholder.
test('a pasted token is kept apart, owner-only, and never listed', async () => {
  const added = await C.add({ name: 'tokenbox', url: `http://127.0.0.1:${PORT + 1}/mcp`, token: 'sekrit' });
  assert.equal(added.ok, true);
  assert.equal((await C.test('tokenbox')).ok, true, 'the token did not reach the server');

  const stored = JSON.parse(await fsp.readFile(path.join(tmpHome, 'connectors.json'), 'utf8')).connectors.find((c) => c.name === 'tokenbox');
  assert.ok(!JSON.stringify(stored).includes('sekrit'), 'the token was written into connectors.json');
  assert.equal(stored.headers.Authorization, 'Bearer ${TOKEN}');
  const secrets = path.join(tmpHome, 'connector-secrets.json');
  assert.ok((await fsp.readFile(secrets, 'utf8')).includes('sekrit'));
  assert.equal((await fsp.stat(secrets)).mode & 0o077, 0, 'the secrets file is readable by others');

  const listed = JSON.stringify(await C.listWithStatus());
  assert.ok(!listed.includes('sekrit'), 'a token reached the settings page');
  assert.ok(!listed.includes('Authorization'), 'headers reached the settings page');
});

// The case imported plugins create: a placeholder with no value yet.
test('a connector missing a secret says which one, and works once it is filled in', async () => {
  await C.add({ name: 'needsbox', url: `http://127.0.0.1:${PORT + 1}/mcp`, headers: { Authorization: 'Bearer ${API_TOKEN}' } });
  const listed = (await C.listWithStatus()).find((c) => c.name === 'needsbox');
  assert.deepEqual(listed.secrets, [{ name: 'API_TOKEN', set: false }]);

  const refused = await C.test('needsbox');
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.missing, ['API_TOKEN']);
  assert.match(refused.reason, /API_TOKEN/);

  assert.equal((await C.setSecret('needsbox', 'API_TOKEN', 'sekrit')).ok, true);
  assert.equal((await C.test('needsbox')).ok, true);
  assert.deepEqual((await C.listWithStatus()).find((c) => c.name === 'needsbox').secrets, [{ name: 'API_TOKEN', set: true }]);
});

// A plugin naming ${GITHUB_TOKEN} is naming a secret, not asking for the one
// that happens to be in Reflect's environment.
test('a placeholder is never filled from the environment', async () => {
  process.env.ENV_ONLY_TOKEN = 'sekrit';
  await C.add({ name: 'envbox', url: `http://127.0.0.1:${PORT + 1}/mcp`, headers: { Authorization: 'Bearer ${ENV_ONLY_TOKEN}' } });
  const r = await C.test('envbox');
  delete process.env.ENV_ONLY_TOKEN;
  assert.equal(r.ok, false, 'a secret was taken from the environment');
  assert.deepEqual(r.missing, ['ENV_ONLY_TOKEN']);
});

test('only names a connector uses can be set', async () => {
  assert.match((await C.setSecret('needsbox', 'SOMETHING_ELSE', 'x')).reason, /does not use/);
  assert.match((await C.setSecret('needsbox', 'not a name', 'x')).reason, /not a name/);
});

test('an empty value clears a secret, and removing the connector removes its secrets', async () => {
  await C.setSecret('needsbox', 'API_TOKEN', '');
  assert.deepEqual((await C.listWithStatus()).find((c) => c.name === 'needsbox').secrets, [{ name: 'API_TOKEN', set: false }]);
  await C.remove('tokenbox');
  const left = await fsp.readFile(path.join(tmpHome, 'connector-secrets.json'), 'utf8');
  assert.ok(!left.includes('tokenbox'), 'a removed connector left its secrets behind');
});

test('every place a placeholder can sit is filled in', async () => {
  await Secrets.setMany('everywhere', { A: '1', B: '2', C: '3' });
  const r = await Secrets.resolve({
    name: 'everywhere', command: 'run-${A}', args: ['--key=${B}'], env: { KEY: '${C}' }, headers: { X: '${A}${B}' }, url: 'https://x.invalid/${C}',
  });
  assert.deepEqual([r.command, r.args[0], r.env.KEY, r.headers.X, r.url], ['run-1', '--key=2', '3', '12', 'https://x.invalid/3']);
});
