/**
 * Skills.
 *
 * Three things are being defended here, and only one of them is "does it load".
 *
 *   1. **The format is not ours.** SKILL.md with `name` and `description` in
 *      frontmatter is the open Agent Skills format that Claude and Codex read.
 *      A skill written for either should work here unchanged, so these tests
 *      assert the format rather than a convenient subset of it.
 *   2. **Progressive disclosure.** Only names and descriptions go into an
 *      ordinary turn. If the instructions ever leak into every prompt, adding a
 *      skill starts costing latency, and people stop adding them.
 *   3. **`allowed-tools` is a request, not a grant.** The field is parsed and
 *      reported, and nothing acts on it. A skill is know-how; it does not widen
 *      its own access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { useStorage, resetStorage } = await import('../src/core/Storage.js');
const { MemoryStorage } = await import('../src/adapters/storage/MemoryStorage.js');
useStorage(new MemoryStorage());

const FileStore = await import('../src/store/FileStore.js');
const Skills = await import('../src/skills/Skills.js');
const { build } = await import('../src/context/PromptAssembler.js');
const { plan, estimateTokens } = await import('../src/context/ContextBudget.js');

await FileStore.scaffold();

const SKILL = `---
name: write-like-me
description: Match the user's own writing voice in emails and notes.
license: MIT
allowed-tools: [Read, Write]
---

Prefer short sentences. Never open with "I hope this finds you well".
`;

await Skills.writeSkill('write-like-me', SKILL);
await Skills.writeSkill(
  'summarise-thread',
  '---\nname: summarise-thread\ndescription: Boil a long thread down to decisions and owners.\n---\n\nLead with what was decided.\n'
);

test.after(() => resetStorage());

const soul = { block: () => 'identity' };
const budget = plan({ contextLength: 8192 });
const systemOf = (messages) => messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

// ────────────────────────────────────────────────────────────── the format

test('a SKILL.md is read as the open format defines it', async () => {
  const skill = await Skills.readSkill('write-like-me');
  assert.equal(skill.name, 'write-like-me');
  assert.match(skill.description, /writing voice/);
  assert.equal(skill.license, 'MIT');
  assert.match(skill.body, /short sentences/);
  assert.equal(skill.valid, true);
});

test('the folder and the name have to agree', () => {
  const skill = Skills.parseSkill('---\nname: something-else\ndescription: x\n---\nbody', 'my-folder');
  assert.equal(skill.valid, false);
  assert.match(skill.problems.join(' '), /does not match its folder/);
});

test('the rules that make a skill usable are enforced', () => {
  const noDescription = Skills.parseSkill('---\nname: a\n---\nbody', 'a');
  assert.match(noDescription.problems.join(' '), /no description/);

  const noBody = Skills.parseSkill('---\nname: a\ndescription: d\n---\n', 'a');
  assert.match(noBody.problems.join(' '), /no instructions/);

  const badName = Skills.parseSkill('---\nname: Not Valid\ndescription: d\n---\nbody', 'Not Valid');
  assert.match(badName.problems.join(' '), /lowercase words joined by hyphens/);
});

test('a broken skill is reported, not hidden and not fatal', async () => {
  await Skills.writeSkill('broken-one', '---\nname: broken-one\n---\n');
  const all = await Skills.listSkills();
  const broken = all.find((s) => s.name === 'broken-one');

  assert.ok(broken, 'a skill that does not parse must still be listed');
  assert.equal(broken.valid, false);
  assert.ok(broken.problems.length, 'and it must say what is wrong');
  assert.ok(all.some((s) => s.valid), 'one bad file cannot take the others down');
});

// ──────────────────────────────────────────────── progressive disclosure

test('an ordinary turn gets names and descriptions, never instructions', async () => {
  const skills = await Skills.listSkills();
  const { messages } = build({
    soul,
    message: 'hello',
    budget,
    skills: Skills.catalogue(skills),
    skillInstructions: Skills.instructionsFor(Skills.invoked('hello', skills)),
  });

  const system = systemOf(messages);
  assert.match(system, /write-like-me/, 'the catalogue tells the model what exists');
  assert.match(system, /writing voice/);
  assert.doesNotMatch(system, /I hope this finds you well/, 'the instructions must not be in an ordinary turn');
});

test('naming a skill loads its instructions for that turn', async () => {
  const skills = await Skills.listSkills();
  const asked = Skills.invoked('/write-like-me draft a reply to Priya', skills);
  assert.deepEqual(asked.map((s) => s.name), ['write-like-me']);

  const { messages } = build({
    soul,
    message: 'draft a reply',
    budget,
    skills: Skills.catalogue(skills),
    skillInstructions: Skills.instructionsFor(asked),
  });
  assert.match(systemOf(messages), /I hope this finds you well/, 'now the instructions are there');
});

test('@name works too, and an unknown name asks for nothing', async () => {
  const skills = await Skills.listSkills();
  assert.equal(Skills.invoked('@summarise-thread please', skills).length, 1);
  assert.equal(Skills.invoked('/no-such-skill', skills).length, 0);
  assert.equal(Skills.invoked('an email address a@b.com is not an invocation', skills).length, 0);
});

test('the catalogue is bounded, and says when it left something out', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({
    name: `skill-${i}`,
    description: 'A description long enough to cost real tokens when repeated many times over.',
    valid: true,
  }));

  const text = Skills.catalogue(many);
  assert.ok(
    estimateTokens(text) <= Skills.CATALOGUE_BUDGET + 20,
    `the catalogue costs ${estimateTokens(text)} tokens, over its budget`
  );
  assert.match(text, /more not listed/, 'silently truncating would misreport what the model can do');
});

test('no skills means nothing in the prompt at all', () => {
  assert.equal(Skills.catalogue([]), '');
  const { messages } = build({ soul, message: 'hi', budget, skills: '' });
  assert.doesNotMatch(systemOf(messages), /## Skills/);
});

// ─────────────────────────────────────────────────── the permission boundary

test('allowed-tools is recorded and obeyed by nothing', async () => {
  const skill = await Skills.readSkill('write-like-me');
  assert.deepEqual(skill.requestedTools, ['Read', 'Write']);

  // The field is a request in the format's own words. If Reflect ever grants
  // access, it will be because a person approved it — not because a file asked.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/skills/Skills.js', import.meta.url), 'utf8')
  );
  assert.match(source, /request, not a grant/i);
  assert.doesNotMatch(source, /allowedTools\s*\)/, 'nothing should branch on the requested tools');
});

// ───────────────────────────────────────────────────────────────── the store

test('skills live in a folder you own, like everything else', async () => {
  assert.equal(Skills.skillKey('write-like-me'), 'skills/write-like-me/SKILL.md');
  assert.ok(await FileStore.exists('skills/write-like-me/SKILL.md'));
});

test('a skill can be removed, and an unsafe name cannot be touched', async () => {
  await Skills.writeSkill('temporary-one', '---\nname: temporary-one\ndescription: d\n---\nbody\n');
  assert.equal(await Skills.removeSkill('temporary-one'), true);
  assert.equal(await Skills.removeSkill('temporary-one'), false);
  await assert.rejects(() => Skills.writeSkill('../escape', 'x'), /Unsafe skill name/);
  await assert.rejects(() => Skills.removeSkill('../escape'), /Unsafe skill name/);
});

// ─────────────────────────────────────────────────── switching one off

test('a skill switched off is offered to nobody, including by name', async () => {
  await Skills.writeSkill(
    'quiet-one',
    '---\nname: quiet-one\ndescription: Say very little.\n---\n\nBe brief.\n'
  );

  const on = await Skills.readSkill('quiet-one');
  assert.equal(on.enabled, true, 'a skill with no `enabled` line is on');
  assert.match(Skills.catalogue([on]), /quiet-one/);
  assert.equal(Skills.invoked('/quiet-one hello', [on]).length, 1);

  const off = await Skills.setSkillEnabled('quiet-one', false);
  assert.equal(off.enabled, false);
  // Every catalogue line is paid for on every turn — which is the whole reason
  // someone switches one off.
  assert.ok(!Skills.catalogue([off]).includes('quiet-one'));
  // And off means off even when asked for by name, or the switch is a
  // suggestion rather than a setting.
  assert.equal(Skills.invoked('/quiet-one hello', [off]).length, 0);

  const backOn = await Skills.setSkillEnabled('quiet-one', true);
  assert.equal(backOn.enabled, true, 'and it comes back');
  await Skills.removeSkill('quiet-one');
});

test('the state lives in the skill file, not in config', async () => {
  await Skills.writeSkill('portable', '---\nname: portable\ndescription: Test.\n---\n\nDo a thing.\n');
  await Skills.setSkillEnabled('portable', false);

  const raw = await FileStore.readText('skills/portable/SKILL.md', '');
  // A skill is a document you own. Someone opening it in an editor should see
  // why it is not being offered, and copying the folder should carry it.
  assert.match(raw, /^enabled: false$/m);
  assert.match(raw, /^name: portable$/m, 'and the rest of the frontmatter survives');
  assert.match(raw, /Do a thing/);

  // Flipping it twice must not leave two lines behind.
  await Skills.setSkillEnabled('portable', true);
  const back = await FileStore.readText('skills/portable/SKILL.md', '');
  assert.equal((back.match(/^enabled:/gm) || []).length, 1);
  await Skills.removeSkill('portable');
});

test('a new install starts with usable examples, and forgets ones you delete', async () => {
  const { installStarterSkills, STARTER_SKILLS } = await import('../src/skills/Starter.js');

  // Every starter has to pass the same bar a hand-written one does.
  for (const starter of STARTER_SKILLS) {
    const parsed = Skills.parseSkill(starter.body, starter.name);
    assert.equal(parsed.valid, true, `${starter.name}: ${parsed.problems.join(', ')}`);
    assert.ok(parsed.description.length > 20, `${starter.name} needs a description the model can judge`);
  }

  // Only installs into an empty folder. Checking name-by-name would resurrect
  // a deleted starter on every boot, which is a haunting, not a feature.
  const already = await Skills.listSkills();
  const second = await installStarterSkills({ listSkills: Skills.listSkills, writeSkill: Skills.writeSkill });
  assert.deepEqual(second, [], 'nothing is installed over an existing set');
  assert.equal((await Skills.listSkills()).length, already.length);
});
