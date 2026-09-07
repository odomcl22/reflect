/**
 * What left this machine.
 *
 * The value of this file is entirely in the classification: a ledger that
 * called a machine across the room "this machine" would launder exactly the
 * claim it exists to check. So the boundary cases — the ones where a host looks
 * local and is not, or looks remote and is not — carry most of the weight here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-ledger-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const { scopeOf, hostOf, record, summary, entries } = await import('../src/reflect/Ledger.js');

await FileStore.scaffold();

const at = (n) => new Date(Date.parse('2026-09-06T10:00:00Z') + n * 60_000);

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('this machine', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '127.1.2.3']) {
    assert.equal(scopeOf(h), 'loopback', h);
  }
});

// The readable form of an IPv4-mapped address is the one people paste into a
// config, and it is loopback wearing a different hat.
test('an IPv6-mapped loopback address is still this machine', () => {
  assert.equal(scopeOf('::ffff:127.0.0.1'), 'loopback');
});

test('your own network is not this machine', () => {
  for (const h of ['192.168.1.50', '10.0.0.5', '172.16.4.2', '169.254.1.1', 'nas.local', 'bigbox']) {
    assert.equal(scopeOf(h), 'private', h);
  }
});

// 172.16–172.31 is private; 172.32 is somebody else's. Getting this wrong in
// the lenient direction would quietly file an internet host as your own LAN.
test('addresses that only look private are not', () => {
  assert.equal(scopeOf('172.32.4.2'), 'internet');
  assert.equal(scopeOf('172.15.4.2'), 'internet');
  assert.equal(scopeOf('11.0.0.1'), 'internet');
});

test('the open internet', () => {
  for (const h of ['html.duckduckgo.com', 'api.tavily.com', '8.8.8.8']) {
    assert.equal(scopeOf(h), 'internet', h);
  }
});

test('the port is not part of the host', () => {
  assert.equal(hostOf('http://192.168.1.50:11434/v1'), '192.168.1.50:11434');
});

test('a local model call leaves the count at zero', async () => {
  await record({ kind: 'model', url: 'http://localhost:11434', detail: 'a-model · chat', at: at(0) });
  const s = await summary();
  assert.equal(s.total, 1);
  assert.equal(s.offMachine, 0, 'a loopback call must never count as leaving');
  assert.deepEqual(s.hosts, []);
});

// The model running on your own box is Reflect working, not your data
// escaping. Counting it made the headline two-thirds noise — capability probes
// carrying nothing of yours outnumbered the real web searches three to one.
test('the model on your own network is reported, not counted as leaving', async () => {
  await record({ kind: 'model', url: 'http://192.168.1.50:11434/v1', detail: 'a-model · chat', at: at(1) });
  const s = await summary();
  assert.equal(s.offMachine, 0, 'your own hardware is not somebody else');
  assert.equal(s.onYourNetwork, 1, 'but it is still reported');
  assert.deepEqual(s.yourHosts, ['192.168.1.50:11434'], 'and still named');
  assert.deepEqual(s.hosts, [], 'and kept out of the third-party list');
});

// The case that must still count loudly: a runtime pointed at somebody's cloud
// is every prompt going to a stranger, which is precisely what this exists for.
test('a runtime on the public internet counts every time', async () => {
  await record({ kind: 'model', url: 'https://api.example-cloud.com/v1', detail: 'gpt · chat', at: at(4) });
  const s = await summary();
  assert.ok(s.offMachine >= 1, 'a cloud runtime must count');
  assert.ok(s.hosts.includes('api.example-cloud.com'));
});

test('a search counts, and says what was asked', async () => {
  await record({ kind: 'search', host: 'html.duckduckgo.com', detail: 'best kettle 2026', at: at(2) });
  const s = await summary();
  assert.ok(s.byScope.internet >= 1);
  assert.equal(s.byKind.search, 1);
  assert.ok((await entries()).some((e) => e.detail === 'best kettle 2026'));
});

test('newest first, because that is the question being asked', async () => {
  const rows = await entries();
  assert.equal(rows[0].kind, 'search');
  assert.ok(rows[0].at >= rows[rows.length - 1].at);
});

// Recording must never be able to break the thing it records.
test('a malformed entry is stored rather than thrown', async () => {
  await record({ kind: 'fetch', url: 'not a url at all', at: at(3) });
  const rows = await entries();
  assert.equal(rows[0].kind, 'fetch');
});

// Measured before this existed: a year of ordinary use is ~180,000 entries and
// 20MB, and reading it on every page load cost 219ms — for one line under the
// composer. The list is bounded now; the count must not be.
test('trimming bounds the file without touching the count', async () => {
  const home2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-ledger-trim-'));
  process.env.REFLECT_HOME = home2;
  const FS2 = await import(`../src/store/FileStore.js?trim=1`);
  await FS2.scaffold();
  const L2 = await import(`../src/reflect/Ledger.js?trim=1`);

  const N = 12_000;
  for (let i = 0; i < N; i++) {
    const off = i % 40 === 0;
    await L2.record({
      kind: off ? 'search' : 'probe',
      host: off ? 'html.duckduckgo.com' : 'localhost:11434',
      at: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
    });
  }

  const s = await L2.summary();
  assert.equal(s.total, N, 'the lifetime count must survive trimming');
  assert.equal(s.offMachine, N / 40, 'what went to the internet must be counted exactly');

  const onDisk = (await fsp.readFile(path.join(home2, 'ledger.jsonl'), 'utf8')).trim().split('\n').length;
  assert.ok(onDisk < N, `the file should be bounded, held ${onDisk}`);

  // The rare rows are the whole question, so they outlive the noise.
  const keptOff = (await L2.entries(99_999)).filter((e) => e.scope !== 'loopback').length;
  assert.equal(keptOff, N / 40, 'off-machine detail was dropped');

  await fsp.rm(home2, { recursive: true, force: true });
  process.env.REFLECT_HOME = tmpHome;
});
