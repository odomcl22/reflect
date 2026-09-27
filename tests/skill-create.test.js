/**
 * Reflect writing down a way of working.
 *
 * This is the only tool that changes what Reflect does on *later* turns.
 * Everything else acts once and stops; a skill is standing instructions, and a
 * page Reflect had just read could ask it to write itself a habit.
 *
 * Two properties carry that, and both are tested here rather than trusted: a
 * skill made this way arrives switched off, and it never lands on top of one
 * somebody wrote by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-skillmake-'));
process.env.REFLECT_HOME = tmpHome;

const FileStore = await import('../src/store/FileStore.js');
const Skills = await import('../src/skills/Skills.js');
const { runTool, toolsFor, allTools } = await import('../src/reflect/MemoryTools.js');

await FileStore.scaffold();

const make = (args) => runTool('skill_create', args, {});

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

test('a skill Reflect writes arrives switched off', async () => {
  const out = await make({
    name: 'standup-notes',
    description: 'Write standups as three bullets. Use when asked for a standup.',
    instructions: 'Three bullets: what moved, what is stuck, what is next. No preamble.',
  });
  assert.match(out.result, /switched off/i, 'the model must be told to say so');

  const saved = await Skills.readSkill('standup-notes');
  assert.equal(saved.enabled, false, 'a skill nobody approved must not be live');
  assert.equal(saved.description, 'Write standups as three bullets. Use when asked for a standup.');
  assert.match(saved.body ?? saved.instructions ?? '', /three bullets/i);
});

// The click is the safety property. If it were on by default, a page Reflect
// read could give it standing instructions nobody chose to follow.
test('and it is not live until a person turns it on', async () => {
  const live = (await Skills.listSkills()).filter((s) => s.enabled).map((s) => s.name);
  assert.ok(!live.includes('standup-notes'), 'it was offered to the model unapproved');
});

test('it will not write over a skill somebody already has', async () => {
  const out = await make({
    name: 'standup-notes',
    description: 'Something else entirely.',
    instructions: 'Different instructions.',
  });
  assert.match(out.result, /already/i);

  const kept = await Skills.readSkill('standup-notes');
  assert.match(kept.description, /three bullets/i, 'the original was replaced');
});

test('a name has to be a name', async () => {
  for (const bad of ['', '../escape', 'Has Spaces And Caps!!']) {
    const out = await make({ name: bad, description: 'x', instructions: 'y' });
    assert.match(out.result, /lowercase words|did not save/i, `accepted ${JSON.stringify(bad)}`);
  }
});

test('both halves are required, because one without the other is useless', async () => {
  const noWhen = await make({ name: 'half-a', description: '', instructions: 'do a thing' });
  assert.match(noWhen.result, /needs both/i);
  const noHow = await make({ name: 'half-b', description: 'when to use it', instructions: '' });
  assert.match(noHow.result, /needs both/i);
});

test('it is offered, and it appears on the screen that lists everything', () => {
  assert.ok(toolsFor({}).map((t) => t.function.name).includes('skill_create'));
  const entry = allTools().find((t) => t.name === 'skill_create');
  assert.ok(entry, 'missing from the tool chooser');
  assert.equal(entry.group, 'Skills');
});

// ────────────────────────────────────────────── skills from somewhere else

const { parseFrontmatter } = await import('../src/store/MemoryFiles.js');

/**
 * Found by running every SKILL.md on a real machine through the parser: 22 of
 * 24 loaded, and one failure was valid YAML — a multi-line quoted description.
 * The skill loaded with no description, the field that decides whether it is
 * ever used.
 */
test('a description written across several lines is read, not lost', () => {
  const { data } = parseFrontmatter('---\nname: m\ndescription:\n  "line one\n  line two"\n---\nbody');
  assert.equal(data.description, 'line one line two');
});

test('folded, literal, and dash-list values all read', () => {
  assert.equal(parseFrontmatter('---\nd: >\n  a\n  b\n---\n').data.d, 'a b');
  assert.equal(parseFrontmatter('---\nd: |\n  a\n  b\n---\n').data.d, 'a\nb');
  assert.deepEqual(parseFrontmatter('---\nt:\n  - Read\n  - Grep\n---\n').data.t, ['Read', 'Grep']);
});

// The quieter bug the old parser had: it trimmed before matching, so a nested
// key under `metadata:` silently replaced the top-level one of the same name.
test('a nested key cannot overwrite a top-level one', () => {
  const { data } = parseFrontmatter('---\nname: real\nmetadata:\n  name: impostor\n---\n');
  assert.equal(data.name, 'real');
});

test('what Reflect writes itself still reads exactly as before', () => {
  const { data } = parseFrontmatter('---\nname: a\nwhen: every day at 08:00\ntags: [x, y]\n---\nbody');
  assert.deepEqual(data, { name: 'a', when: 'every day at 08:00', tags: ['x', 'y'] });
});

test('skills written on Windows read too', () => {
  assert.equal(parseFrontmatter('---\r\nname: w\r\ndescription: d\r\n---\r\nb').data.description, 'd');
});

// ────────────────────────────────────────────── the model loading a skill

async function plantSkill(name, { enabled = true, extra = {} } = {}) {
  await Skills.writeSkill(
    name,
    `---\nname: ${name}\ndescription: Test skill. Use when testing.\nenabled: ${enabled}\n---\n\nFollow these steps. See references/guide.md.\n`
  );
  const base = path.join(tmpHome, 'skills', name);
  for (const [rel, text] of Object.entries(extra)) {
    await fsp.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await fsp.writeFile(path.join(base, rel), text);
  }
}

const load = (args) => runTool('skill_use', args, {});

test('the model can load a skill it has only seen one line of', async () => {
  await plantSkill('guided', { extra: { 'references/guide.md': 'The detailed guide.', 'scripts/run.py': 'print(1)' } });
  const out = await load({ name: 'guided' });
  assert.match(out.result, /Follow these steps/);
  assert.match(out.result, /references\/guide\.md/, 'the reference file must be named so it can be loaded');
  assert.match(out.result, /does not run code/, 'scripts must be admitted to, not silently ignored');
  assert.equal(out.skill, 'guided');
});

test('and the reference document it points to', async () => {
  const out = await load({ name: 'guided', file: 'references/guide.md' });
  assert.equal(out.result, 'The detailed guide.');
});

// Inside Reflect's home is not the same as inside the skill. USER.md is in the
// home; it is not the skill's to hand out.
test('a skill file path cannot leave the skill', async () => {
  for (const escape of ['../../USER.md', '/etc/hosts', 'references/../../../USER.md', 'scripts/run.py']) {
    const out = await load({ name: 'guided', file: escape });
    assert.match(out.result, /no readable file/, `read ${escape}`);
  }
});

test('a switched-off skill cannot be loaded by the model either', async () => {
  await plantSkill('dormant', { enabled: false });
  const out = await load({ name: 'dormant' });
  assert.match(out.result, /switched off/);
});

test('skill_use is offered only when there is something to load', () => {
  assert.ok(!toolsFor({}).map((t) => t.function.name).includes('skill_use'));
  assert.ok(toolsFor({ skills: 1 }).map((t) => t.function.name).includes('skill_use'));
});
