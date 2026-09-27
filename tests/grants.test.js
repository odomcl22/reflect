/**
 * Grants and connected folders.
 *
 * This is the first time Reflect touches anything outside its own memory
 * folder, so most of these tests are about refusal rather than function. The
 * rules being defended, in order of how much damage they prevent:
 *
 *   1. No access without a grant, and a grant is a person's decision — not a
 *      config value, not a field in a SKILL.md, not something a model can talk
 *      its way into.
 *   2. Read by default. Writing is a second, explicit grant on the same folder.
 *   3. Creating a file is free; replacing one is refused unless the call says
 *      the user agreed. Additive is free, destructive is deliberate — the same
 *      rule the memory store has always followed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-grants-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Grants = await import('../src/grants/Grants.js');
const Folders = await import('../src/grants/Folders.js');
const { toolsFor, runTool } = await import('../src/reflect/MemoryTools.js');

await FileStore.scaffold();

/** A folder standing in for something on the user's desktop. */
const desk = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-desk-'));
await fsp.writeFile(path.join(desk, 'notes.md'), '# Notes\n\nBuy oat milk.\n');
await fsp.writeFile(path.join(desk, 'photo.png'), 'not really a png');
await fsp.mkdir(path.join(desk, 'archive'));

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
  await fsp.rm(desk, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────── what may be granted

test('a grant needs a real, absolute folder', async () => {
  await assert.rejects(() => Grants.grant(''), /Which folder/);
  await assert.rejects(() => Grants.grant('notes'), /full path/);
  await assert.rejects(() => Grants.grant('/nowhere/at/all'), /No folder at/);
  await assert.rejects(() => Grants.grant(path.join(desk, 'notes.md')), /is a file, not a folder/);
});

test('the dangerous ones are refused by name', async () => {
  await assert.rejects(() => Grants.grant('/'), /the filesystem root/);
  await assert.rejects(() => Grants.grant(os.homedir()), /whole home directory is too much/);
  // Granting Reflect its own memory would turn every guard in the storage port
  // into a suggestion.
  await assert.rejects(() => Grants.grant(tmpHome), /already has its own memory folder/);
});

test('connecting a folder gives reading, and nothing more', async () => {
  const granted = await Grants.grant(desk);
  assert.equal(granted.access, 'read');
  assert.equal(granted.name, path.basename(desk));

  const grant = await Grants.grantFor(path.join(desk, 'notes.md'));
  assert.ok(Grants.canRead(grant));
  assert.equal(Grants.canWrite(grant), false, 'read must not imply write');
});

// ──────────────────────────────────────────────────────────────── reading

test('a granted folder can be listed and read', async () => {
  const listed = await Folders.listFolder(desk);
  assert.deepEqual(listed.items.map((i) => i.name), ['archive', 'notes.md', 'photo.png']);
  assert.equal(listed.items.find((i) => i.name === 'archive').kind, 'folder');
  assert.equal(listed.items.find((i) => i.name === 'photo.png').readable, false);

  const file = await Folders.readFile(path.join(desk, 'notes.md'));
  assert.match(file.content, /oat milk/);
});

test('nothing outside a grant can be reached', async () => {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-outside-'));
  await fsp.writeFile(path.join(outside, 'secret.md'), 'private');

  await assert.rejects(() => Folders.listFolder(outside), /No access to/);
  await assert.rejects(() => Folders.readFile(path.join(outside, 'secret.md')), /No access to/);
  // Traversal from inside a granted folder lands outside it, and is refused
  // on the resolved path rather than the string.
  await assert.rejects(() => Folders.readFile(path.join(desk, '..', path.basename(outside), 'secret.md')), /No access to/);

  await fsp.rm(outside, { recursive: true, force: true });
});

test('binaries and oversized files are refused with a reason', async () => {
  await assert.rejects(() => Folders.readFile(path.join(desk, 'photo.png')), /not a text file/);
});

// ──────────────────────────────────────────────────────────────── writing

test('a read grant cannot write', async () => {
  await assert.rejects(
    () => Folders.writeFile(path.join(desk, 'new.md'), 'hello'),
    /connected for reading only/
  );
});

test('raising to write is a second decision, recorded', async () => {
  const raised = await Grants.grant(desk, 'write');
  assert.equal(raised.access, 'write');
  assert.ok(raised.changedAt, 'the change is dated, not silent');
  assert.equal((await Grants.listGrants()).length, 1, 'raising is not a second grant');
});

test('a new file is created without ceremony', async () => {
  const written = await Folders.writeFile(path.join(desk, 'new.md'), '# New\n');
  assert.equal(written.created, true);
  assert.match(await fsp.readFile(path.join(desk, 'new.md'), 'utf8'), /# New/);
});

test('replacing one is refused until the user has agreed', async () => {
  await assert.rejects(
    () => Folders.writeFile(path.join(desk, 'notes.md'), 'wiped'),
    /already exists.*Ask the user/s
  );
  // The original survived the attempt.
  assert.match(await fsp.readFile(path.join(desk, 'notes.md'), 'utf8'), /oat milk/);

  const replaced = await Folders.writeFile(path.join(desk, 'notes.md'), '# Notes\n\nReplaced.\n', { confirm: true });
  assert.equal(replaced.created, false);
  assert.match(await fsp.readFile(path.join(desk, 'notes.md'), 'utf8'), /Replaced/);
});

// ────────────────────────────────────────────────────────── what the model sees

test('folder tools appear only when a folder is connected', () => {
  const names = (list) => list.map((t) => t.function.name);

  assert.equal(names(toolsFor({})).some((n) => n.startsWith('folder_')), false, 'nothing connected, nothing offered');

  const readOnly = names(toolsFor({ grants: [{ path: desk, access: 'read' }] }));
  assert.ok(readOnly.includes('folder_list'));
  assert.ok(readOnly.includes('file_read'));
  assert.equal(readOnly.includes('file_write'), false, 'a tool it cannot use is a tool it will try');

  const writable = names(toolsFor({ grants: [{ path: desk, access: 'write' }] }));
  assert.ok(writable.includes('file_write'));
});

test('the tool call reports a write the way a memory write is reported', async () => {
  const { result, write } = await runTool('file_write', {
    path: path.join(desk, 'from-tool.md'),
    content: 'written by a tool',
  });
  assert.match(result, /Created/);
  assert.equal(write.action, 'created');
  assert.equal(write.written, true);
  assert.match(write.target, /from-tool\.md$/, 'the transcript should name the file');
});

test('a refused tool call explains itself to the model', async () => {
  const { result } = await runTool('file_read', { path: '/etc/hosts' });
  assert.match(result, /No access|error/i);
  assert.match(result, /user grants it, you cannot|No access/, 'the model must not think it can grant itself access');
});

// ─────────────────────────────────────────────────────────────── the prompt

test('connected folders are named in the prompt, revoked ones are not', async () => {
  assert.match(Grants.grantsBrief(await Grants.listGrants()), /Connected folders/);
  assert.match(Grants.grantsBrief(await Grants.listGrants()), /you may also write here/);

  assert.equal(await Grants.revoke(desk), true);
  assert.equal(await Grants.revoke(desk), false);
  assert.equal(Grants.grantsBrief(await Grants.listGrants()), '', 'nothing connected, nothing said');
  await assert.rejects(() => Folders.readFile(path.join(desk, 'notes.md')), /No access/);
});

// ────────────────────────────────────────────── what a small model actually does

test('a bare folder name works, because that is what models send', async () => {
  // Observed live: shown "desk — /long/path/desk", gemma called the tool with
  // path: "desk". Refusing that is technically correct and practically useless.
  await Grants.grant(desk, 'read');
  const name = path.basename(desk);

  const listed = await Folders.listFolder(name);
  assert.equal(listed.path, desk);

  const file = await Folders.readFile(`${name}/notes.md`);
  assert.match(file.content, /Replaced|oat milk/);
});

test('an unknown name says what is connected instead of just refusing', async () => {
  await assert.rejects(() => Folders.listFolder('nowhere'), /is not a connected folder.*Connected:/s);
});

test('a bare name still cannot escape its grant', async () => {
  await assert.rejects(() => Folders.readFile(`${path.basename(desk)}/../../../etc/hosts`), /No access to/);
  await Grants.revoke(desk);
});

// ──────────────────────────────────────────────── turning a tool off

test('a tool switched off is not offered at all', async () => {
  const { allTools } = await import('../src/reflect/MemoryTools.js');
  const names = (list) => list.map((t) => t.function.name);

  // Removed from the offer, not refused when called. A tool the model can see
  // is a tool it will try, and a refusal it does not understand costs a round
  // trip and muddles the answer.
  const without = names(toolsFor({ disabled: ['memory_write'] }));
  assert.ok(!without.includes('memory_write'));
  assert.ok(without.includes('memory_search'), 'only the named one goes');

  // It applies to folder tools too, on top of the grant rules.
  const folders = names(toolsFor({ grants: [{ path: desk, access: 'write' }], disabled: ['file_write'] }));
  assert.ok(folders.includes('file_read'));
  assert.ok(!folders.includes('file_write'));

  // Everything offerable is listed for the screen that lets you choose,
  // grouped so folder tools can explain why they are unavailable.
  const all = allTools();
  assert.deepEqual(
    all.map((t) => t.name).sort(),
    ['file_read', 'file_write', 'folder_create', 'folder_list', 'mail_draft', 'memory_get',
     'memory_search', 'memory_write', 'message', 'notify', 'run_shortcut', 'skill_create', 'skill_use', 'task_create',
     'web_fetch', 'web_search']
  );
  // allTools() is the chooser screen, which lists everything that exists rather
  // than everything available right now — so the delivery tools appear here on
  // every platform, and it is toolsFor() that leaves them out where they cannot
  // work.
  assert.deepEqual(
    [...new Set(all.map((t) => t.group))].sort(),
    ['Connected folders', 'Memory', 'Reaching you', 'Skills', 'Tasks', 'The web', 'Your Mac']
  );
});

// Absent rather than refused, and for a stronger reason than the others: page
// text comes back into the same context as these tools, so a page that asks the
// model to go and read something else must find nothing to call.
test('the web tools are not offered until the web is switched on', () => {
  const names = (list) => list.map((t) => t.function.name);

  const off = names(toolsFor({}));
  assert.ok(!off.includes('web_search'));
  assert.ok(!off.includes('web_fetch'));
  assert.ok(off.includes('memory_search'), 'the rest of the toolset is unaffected');

  const on = names(toolsFor({ web: true }));
  assert.ok(on.includes('web_search'));
  assert.ok(on.includes('web_fetch'));

  // The deny-list still applies on top: someone can keep search and refuse
  // fetching, which is the difference between looking something up and pulling
  // an arbitrary document into the conversation.
  const half = names(toolsFor({ web: true, disabled: ['web_fetch'] }));
  assert.ok(half.includes('web_search'));
  assert.ok(!half.includes('web_fetch'));
});
