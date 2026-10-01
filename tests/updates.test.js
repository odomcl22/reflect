/**
 * Checking whether there is a newer Reflect.
 *
 * The version comparison carries the weight here: Reflect's own versions are
 * milestones (`2.0.0-m9`), and the obvious implementation — semver, or worse,
 * a string compare — puts m10 before m9 and would tell everybody that the
 * update they just installed is older than the one they had.
 *
 * The network half runs against a stand-in for GitHub on this machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import http from 'node:http';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-updates-'));
process.env.REFLECT_HOME = tmpHome;

// A GitHub stand-in, answering whatever the current test puts in `releases`.
let releases = [];
let calls = 0;
const server = http.createServer((req, res) => {
  calls++;
  if (releases === 'boom') {
    res.writeHead(503).end('{}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(releases));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.REFLECT_UPDATE_API = `http://127.0.0.1:${server.address().port}`;

const FileStore = await import('../src/store/FileStore.js');
const U = await import('../src/update/Updates.js');
await FileStore.scaffold();

const release = (tag, extra = {}) => ({
  tag_name: tag,
  name: `Reflect ${tag}`,
  html_url: `https://example.invalid/releases/${tag}`,
  draft: false,
  prerelease: /-/.test(tag),
  published_at: '2026-09-28T00:00:00Z',
  ...extra,
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

// ────────────────────────────────────────────────── comparing versions

test('a later milestone is newer, even past ten', () => {
  assert.equal(U.compare('2.0.0-m10', '2.0.0-m9'), 1, 'm10 must beat m9 — a string compare says otherwise');
  assert.equal(U.compare('2.0.0-m9', '2.0.0-m10'), -1);
  assert.equal(U.compare('2.0.0-m9', '2.0.0-m9'), 0);
});

test('a settled release beats any pre-release of the same number', () => {
  assert.equal(U.compare('2.0.0', '2.0.0-m99'), 1);
  assert.equal(U.compare('2.0.0-m99', '2.0.0'), -1);
});

test('ordinary version numbers still order the ordinary way', () => {
  assert.equal(U.compare('2.1.0', '2.0.9'), 1);
  assert.equal(U.compare('10.0.0', '9.9.9'), 1, 'ten is not less than nine');
  assert.equal(U.compare('2.0.1', '2.0.1'), 0);
  assert.equal(U.compare('v2.0.1', '2.0.1'), 0, 'a leading v is decoration');
});

test('a version nobody can read is treated as the oldest, not the newest', () => {
  assert.equal(U.compare('nightly', '2.0.0'), -1);
  assert.equal(U.compare('2.0.0', ''), 1);
});

// ────────────────────────────────────────────────── choosing one

test('drafts are never offered', () => {
  const best = U.pick([release('2.0.0'), release('3.0.0', { draft: true })], '1.0.0');
  assert.equal(best.tag_name, '2.0.0');
});

// Somebody on a settled version should not be walked onto a pre-release by a
// notice they did not ask for. Somebody already on a milestone build should.
test('a pre-release is offered to milestone users only', () => {
  const all = [release('2.0.0'), release('2.1.0-m10')];
  assert.equal(U.pick(all, '2.0.0-m9').tag_name, '2.1.0-m10', 'a milestone user wants the next milestone');
  assert.equal(U.pick(all, '2.0.0').tag_name, '2.0.0', 'a settled user was pushed onto a pre-release');
});

test('the newest is picked whatever order they arrive in', () => {
  assert.equal(U.pick([release('2.0.0'), release('2.10.0'), release('2.9.0')], '1.0.0').tag_name, '2.10.0');
});

// ────────────────────────────────────────────────── asking

test('a newer release is reported as newer, with somewhere to get it', async () => {
  releases = [release('2.0.0-m9'), release('2.0.0-m10')];
  const s = await U.status({ current: '2.0.0-m9', force: true });
  assert.equal(s.ok, true);
  assert.equal(s.latest, '2.0.0-m10');
  assert.equal(s.newer, true);
  assert.match(s.url, /releases/);
});

test('being up to date is not an update', async () => {
  releases = [release('2.0.0-m9')];
  const s = await U.status({ current: '2.0.0-m9', force: true });
  assert.equal(s.newer, false);
  assert.equal(s.latest, '2.0.0-m9');
});

test('a version ahead of anything published is not told to downgrade', async () => {
  releases = [release('2.0.0-m9')];
  const s = await U.status({ current: '2.0.0-m11', force: true });
  assert.equal(s.newer, false, 'a developer build was offered an older release');
});

// The check is the one thing in Reflect that reaches the internet unprompted,
// so it is counted like every other thing that leaves. (Against the real
// GitHub this lands in the internet column; the stand-in here is on this
// machine, and the ledger is right to file it as local — what matters is that
// the call is recorded at all rather than slipping out uncounted.)
test('the check is written to the ledger', async () => {
  const { entries } = await import('../src/reflect/Ledger.js');
  releases = [release('2.0.0-m9')];
  const before = (await entries()).filter((e) => e.kind === 'update').length;
  await U.check({ current: '2.0.0-m9', force: true });
  const after = (await entries()).filter((e) => e.kind === 'update');
  assert.equal(after.length, before + 1);
  assert.match(after.at(-1).detail, /new version/);
});

test('it does not ask again straight away, but Check now always does', async () => {
  releases = [release('2.0.0-m9')];
  await U.check({ current: '2.0.0-m9', force: true });
  const was = calls;
  await U.check({ current: '2.0.0-m9' });
  assert.equal(calls, was, 'an automatic check went out again within the window');
  await U.check({ current: '2.0.0-m9', force: true });
  assert.equal(calls, was + 1, 'Check now must actually check');
});

test('the window passing lets the next check through', async () => {
  releases = [release('2.0.0-m9')];
  await U.check({ current: '2.0.0-m9', force: true });
  const was = calls;
  await U.check({ current: '2.0.0-m9', now: Date.now() + U.EVERY_MS + 1000 });
  assert.equal(calls, was + 1);
});

// No internet is the ordinary case on a local-first app, and it is not an error
// worth breaking anything over.
test('a failed check says so, and keeps what was already known', async () => {
  releases = [release('2.0.0-m10')];
  await U.check({ current: '2.0.0-m9', force: true });
  releases = 'boom';
  const s = await U.status({ current: '2.0.0-m9', force: true });
  assert.equal(s.ok, false);
  assert.match(s.reason, /503/);
  assert.equal(s.latest, '2.0.0-m10', 'a notice already shown was erased by a failed check');
});

test('switched off, it does not ask at all', async () => {
  releases = [release('9.9.9')];
  const was = calls;
  const s = await U.status({ current: '2.0.0-m9', enabled: false });
  assert.equal(calls, was, 'a check went out with checking switched off');
  assert.equal(s.enabled, false);
  assert.equal(s.newer, false);
});

test('a repository that has published nothing is not an error', async () => {
  releases = [];
  await U.forget();
  const s = await U.status({ current: '2.0.0-m9', force: true });
  assert.equal(s.ok, true);
  assert.equal(s.latest, null);
  assert.equal(s.newer, false);
});

// The update check compares what the server calls itself against what has been
// published, and releases are tagged from package.json's version. If the two
// drift, everybody is told they are out of date, or nobody ever is.
test('the version the app reports is the version it ships as', async () => {
  const { VERSION } = await import('../src/app.js');
  const pkg = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, 'src/app.js and package.json disagree about the version');
});
