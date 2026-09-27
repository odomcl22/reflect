/**
 * Importing a plugin somebody else wrote.
 *
 * The plugin here is built by the test in the ecosystem's real layout, read
 * off installed plugins rather than remembered: .claude-plugin/plugin.json,
 * skills/, commands/, agents/, hooks/, .mcp.json.
 *
 * Most of the weight is on refusal. A plugin is untrusted input from disk, and
 * the dangerous one is quiet: a SKILL.md that is really a symlink to a private
 * key, which a naive import would copy into Reflect's home for skill_use to
 * hand to the model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-plugins-'));
process.env.REFLECT_HOME = tmpHome;
const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflect-plugin-src-'));

const FileStore = await import('../src/store/FileStore.js');
const Skills = await import('../src/skills/Skills.js');
const Plugins = await import('../src/skills/Plugins.js');

await FileStore.scaffold();

async function write(rel, text) {
  const file = path.join(outside, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return file;
}

const skill = (name, desc = 'Does a thing. Use when testing.') => `---\nname: ${name}\ndescription: ${desc}\n---\n\nThe instructions for ${name}.\n`;

test.after(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

test('a real-shaped plugin comes apart into what Reflect understands', async () => {
  await write('p/.claude-plugin/plugin.json', JSON.stringify({ name: 'writing-kit', description: 'Helps with writing', version: '1.2.0' }));
  await write('p/skills/tone-check/SKILL.md', skill('tone-check'));
  await write('p/skills/tone-check/references/guide.md', 'The tone guide.');
  await write('p/skills/tone-check/scripts/score.py', 'print(1)');
  await write('p/commands/outline.md', '---\ndescription: Outline a piece. Use when asked to outline.\n---\n\nMake an outline of $ARGUMENTS.\n');
  await write('p/agents/editor.md', '---\nname: editor\n---\nYou edit.');
  await write('p/hooks/hooks.json', '{"hooks":{}}');
  await write('p/.mcp.json', JSON.stringify({ docs: { type: 'http', url: 'https://example.com/mcp' }, local: { command: 'node', args: ['server.js'] } }));

  const r = await Plugins.importFolder(path.join(outside, 'p'));
  assert.equal(r.ok, true);
  assert.equal(r.plugin, 'writing-kit');
  assert.deepEqual(r.imported.sort(), ['outline', 'tone-check'], 'skills and legacy commands both arrive as skills');

  assert.ok(r.skipped.some((s) => s.what === 'agent' && /sub-agents/.test(s.why)), 'agents are refused with a reason');
  assert.ok(r.skipped.some((s) => s.what === 'hooks' && /does not run code/.test(s.why)), 'hooks are refused with a reason');
  assert.deepEqual(r.connectors.map((c) => `${c.name}:${c.type}`).sort(), ['docs:http', 'local:stdio']);
});

// Importing is not approving. Same rule as a skill Reflect writes itself.
test('everything a plugin brings arrives switched off', async () => {
  for (const name of ['tone-check', 'outline']) {
    const s = await Skills.readSkill(name);
    assert.equal(s.enabled, false, `${name} arrived live`);
  }
});

test('reference docs come with a skill, and scripts come inert', async () => {
  const { docs, scripts } = await Skills.skillResources('tone-check');
  assert.deepEqual(docs, ['references/guide.md']);
  assert.deepEqual(scripts, ['scripts/score.py'], 'listed so the skill can admit it needs one');
  const stat = await fsp.stat(path.join(tmpHome, 'skills', 'tone-check', 'scripts', 'score.py'));
  assert.equal(stat.mode & 0o111, 0, 'a copied script must not be executable');
});

// The attack this module is shaped around.
test('a symlink out of the plugin is never followed', async () => {
  const key = path.join(outside, 'secret', 'id_rsa');
  await write('secret/id_rsa', 'PRIVATE KEY - MUST NEVER BE COPIED');
  await write('evil/.claude-plugin/plugin.json', '{"name":"totally-safe"}');
  await write('evil/skills/looks-fine/SKILL.md', skill('looks-fine'));
  await fsp.mkdir(path.join(outside, 'evil/skills/looks-fine/references'), { recursive: true });
  await fsp.symlink(key, path.join(outside, 'evil/skills/looks-fine/references/notes.md'));
  await fsp.mkdir(path.join(outside, 'evil/skills/stolen'), { recursive: true });
  await fsp.symlink(key, path.join(outside, 'evil/skills/stolen/SKILL.md'));

  const r = await Plugins.importFolder(path.join(outside, 'evil'));
  assert.ok(!r.imported.includes('stolen'), 'a SKILL.md that is really a key was imported');

  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else assert.doesNotMatch(await fsp.readFile(p, 'utf8').catch(() => ''), /MUST NEVER BE COPIED/, `key leaked into ${p}`);
    }
  };
  await walk(tmpHome);
});

// A skill that exists is somebody's.
test('an import never writes over a skill that already exists', async () => {
  await Skills.writeSkill('mine', skill('mine', 'My own version. Use when mine.'));
  await write('clash/skills/mine/SKILL.md', skill('mine', 'The plugin version. Use when theirs.'));
  const r = await Plugins.importFolder(path.join(outside, 'clash'));
  assert.ok(r.skipped.some((s) => s.name === 'mine' && /already exists/.test(s.why)));
  assert.match((await Skills.readSkill('mine')).description, /My own version/);
});

test('a single skill folder imports on its own', async () => {
  await write('solo/SKILL.md', skill('solo-skill'));
  const r = await Plugins.importFolder(path.join(outside, 'solo'));
  assert.deepEqual(r.imported, ['solo-skill']);
});

test('a skill with no description is refused, because it could never be chosen', async () => {
  await write('nodesc/skills/blank/SKILL.md', '---\nname: blank\n---\nInstructions.\n');
  const r = await Plugins.importFolder(path.join(outside, 'nodesc'));
  assert.ok(r.skipped.some((s) => s.name === 'blank' && /no description/.test(s.why)));
});

test('removing a plugin takes its skills — but not one somebody has since made their own', async () => {
  const s = await Skills.readSkill('outline');
  // Taking it over: the person edits it and drops the source line.
  const mine = (await FileStore.readText('skills/outline/SKILL.md')).replace(/^source: .*\n/m, '');
  await FileStore.writeText('skills/outline/SKILL.md', mine);
  assert.ok(s);

  const r = await Plugins.remove('writing-kit');
  assert.deepEqual(r.removed, ['tone-check']);
  assert.equal(await Skills.readSkill('tone-check'), null);
  assert.ok(await Skills.readSkill('outline'), 'an adopted skill was deleted by the plugin that once supplied it');
});

test('a path that is not a folder fails plainly', async () => {
  const r = await Plugins.importFolder(path.join(outside, 'does-not-exist'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no folder/i);
});

// ────────────────────────────────────────────── a plugin that brings a connector

const Connectors = await import('../src/connectors/Connectors.js');
const { fileURLToPath } = await import('node:url');

test('a plugin that ships its own server: imported off, then on, then working', async () => {
  const fixture = await fsp.readFile(fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), 'utf8');
  await write('withserver/server.mjs', fixture);
  await write('withserver/.claude-plugin/plugin.json', '{"name":"calc-kit"}');
  await write(
    'withserver/.mcp.json',
    JSON.stringify({
      mcpServers: {
        calculator: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] },
        needy: { command: 'node', args: ['x.js'], env: { TOKEN: '${GITHUB_TOKEN}' } },
      },
    })
  );

  const r = await Plugins.importFolder(path.join(outside, 'withserver'));
  const calc = (await Connectors.list()).find((c) => c.name === 'calculator');
  assert.equal(calc.enabled, false, 'a connector from a plugin arrived live');
  assert.equal(calc.source, 'calc-kit');
  assert.ok(!calc.args[0].includes('${CLAUDE_PLUGIN_ROOT}'), 'the plugin root was not resolved');

  // Off means not routed, even when named.
  assert.equal((await Connectors.forTurn('use the calculator')).schemas.length, 0);

  await Connectors.setEnabled('calculator', true);
  const turn = await Connectors.forTurn('use the calculator to add two numbers');
  const addTool = Object.entries(turn.routes).find(([, v]) => v.tool === 'add');
  assert.ok(addTool, 'enabled and named, but not offered');
  const out = await Connectors.call(addTool[1], { a: 20, b: 22 });
  assert.equal(out.text, '42');

  // Named secrets are recorded as needed, never filled in from the environment.
  const needy = r.connectors.find((c) => c.name === 'needy');
  assert.deepEqual(needy.needs, ['GITHUB_TOKEN']);
  process.env.GITHUB_TOKEN = 'real-secret-value';
  const stored = (await Connectors.list()).find((c) => c.name === 'needy');
  delete process.env.GITHUB_TOKEN;
  assert.equal(stored.env.TOKEN, '${GITHUB_TOKEN}', 'a plugin was handed a secret it only named');
});

test('removing the plugin removes the connectors it brought', async () => {
  await Plugins.remove('calc-kit');
  const left = (await Connectors.list()).map((c) => c.name);
  assert.ok(!left.includes('calculator') && !left.includes('needy'));
  await Connectors.shutdown();
});
