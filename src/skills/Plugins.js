/**
 * Bringing in a plugin somebody else wrote.
 *
 * Reflect does not have a plugin system, and still does not: it has skills,
 * and it is about to have connectors. A plugin in the format the ecosystem uses
 * is a folder that bundles those — so importing one means unpacking it into the
 * pieces Reflect already understands, and saying plainly what did not fit.
 *
 * The format, read off real plugins rather than remembered:
 *
 *   .claude-plugin/plugin.json   name, description, version, author
 *   skills/<name>/SKILL.md       skills, with reference files beside them
 *   commands/<name>.md           the older layout; "loaded identically" to
 *                                skills, per the format's own example plugin
 *   agents/<name>.md             sub-agents
 *   hooks/                       shell commands run on events
 *   .mcp.json                    connectors
 *
 * Skills and commands come in as skills. Connectors are recorded and wait for
 * connector support. Agents and hooks are refused, with the reason: Reflect has
 * no sub-agents, and hooks are code, which Reflect does not run.
 *
 * ## What arrives, arrives switched off
 *
 * Every skill a plugin brings is standing instructions written by somebody the
 * person has never met. Same rule as a skill Reflect writes for itself: it is
 * off until somebody has read it. Importing is not approving.
 *
 * ## What is refused
 *
 * A plugin is untrusted input from disk. Files are only ever read from inside
 * the folder that was named — checked on the real path, because a plugin can
 * ship `skills/x/SKILL.md` as a symlink to `~/.ssh/id_rsa`, and a naive import
 * would copy the key into Reflect's home where skill_use would hand it to the
 * model. Nothing is overwritten: a skill that already exists is somebody's.
 * Scripts are copied as inert text with no execute bit, so a skill can admit it
 * needs one; nothing here ever runs them.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readJSON, writeJSON, writeText, readText } from '../store/FileStore.js';
import { parseFrontmatter } from '../store/MemoryFiles.js';
import { parseSkill, readSkill, removeSkill, listSkills } from './Skills.js';
import { homePath } from '../config.js';
import * as Connectors from '../connectors/Connectors.js';

const MANIFEST = 'plugins.json';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT = /\.(md|txt)$/i;
const SCRIPT = /\.(py|sh|bash|js|mjs|cjs|ts|rb|pl|ps1|bat)$/i;
const MAX_FILE = 1_000_000;
const MAX_FILES = 300;

/** Real path, and only if it stays under root. The symlink check lives here. */
async function inside(root, candidate) {
  try {
    const real = await fsp.realpath(candidate);
    return real === root || real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
}

async function readInside(root, file) {
  const real = await inside(root, file);
  if (!real) return null;
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_FILE) return null;
  return fsp.readFile(real, 'utf8');
}

async function dirs(p) {
  return (await fsp.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
}

async function files(p) {
  return (await fsp.readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isFile() || d.isSymbolicLink());
}

/** A skill's frontmatter, rewritten so Reflect holds the switch and knows where it came from. */
function frontmatter({ name, description, license, source }) {
  const one = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  return (
    '---\n' +
    `name: ${name}\n` +
    `description: ${one(description)}\n` +
    (license ? `license: ${one(license)}\n` : '') +
    'enabled: false\n' +
    `source: ${source}\n` +
    '---\n'
  );
}

/** Everything text-like beside a SKILL.md, one level down, confined to the skill. */
async function companions(root, dir) {
  const out = [];
  const walk = async (d, prefix, depth) => {
    for (const f of await files(d)) {
      if (f.name === 'SKILL.md') continue;
      if (!TEXT.test(f.name) && !SCRIPT.test(f.name)) continue;
      const text = await readInside(root, path.join(d, f.name));
      if (text !== null) out.push({ rel: prefix + f.name, text });
    }
    if (depth > 0) for (const sub of await dirs(d)) await walk(path.join(d, sub.name), `${prefix}${sub.name}/`, depth - 1);
  };
  await walk(dir, '', 1);
  return out;
}

/**
 * Read a folder — a whole plugin, or a single skill — and import what fits.
 *
 * @returns {{ok: boolean, plugin?: string, imported: string[], skipped: {what, name, why}[], connectors: object[], reason?: string}}
 */
export async function importFolder(input) {
  const given = path.resolve(String(input || '').replace(/^~(?=$|\/)/, process.env.HOME || ''));
  const root = await fsp.realpath(given).catch(() => null);
  const stat = root && (await fsp.stat(root).catch(() => null));
  if (!stat?.isDirectory()) return { ok: false, reason: `There is no folder at ${input}.`, imported: [], skipped: [], connectors: [] };

  // Keys like paths().skills are storage keys, not filesystem paths; the home
  // itself comes from the one place that decides where it is.
  const home = await fsp.realpath(homePath()).catch(() => homePath());
  if (root === home || root.startsWith(home + path.sep)) {
    return { ok: false, reason: 'That folder is already inside Reflect.', imported: [], skipped: [], connectors: [] };
  }

  // What is being imported, and what to call it.
  const manifestText = await readInside(root, path.join(root, '.claude-plugin', 'plugin.json'));
  let meta = {};
  try {
    meta = manifestText ? JSON.parse(manifestText) : {};
  } catch {
    meta = {};
  }
  const singleSkill = (await readInside(root, path.join(root, 'SKILL.md'))) !== null;
  const plugin = String(meta.name || path.basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'imported';

  const found = []; // { name, description, license, body, extras: [{rel,text}] , origin }
  const skipped = [];
  let count = 0;

  const take = async (file, fallbackName, dir, origin) => {
    if (++count > MAX_FILES) return;
    const text = await readInside(root, file);
    if (text === null) {
      skipped.push({ what: origin, name: fallbackName, why: 'unreadable, too large, or points outside the plugin' });
      return;
    }
    const { data, body } = parseFrontmatter(text);
    const name = String(data.name || fallbackName).toLowerCase();
    if (!NAME.test(name)) {
      skipped.push({ what: origin, name, why: 'its name is not lowercase words joined by hyphens' });
      return;
    }
    const description = String(data.description || '').trim();
    if (!description) {
      skipped.push({ what: origin, name, why: 'it has no description, which is how a skill is ever chosen' });
      return;
    }
    found.push({ name, description, license: data.license, body, extras: dir ? await companions(root, dir) : [], origin });
  };

  if (singleSkill) {
    await take(path.join(root, 'SKILL.md'), path.basename(root).toLowerCase(), root, 'skill');
  } else {
    for (const d of await dirs(path.join(root, 'skills'))) {
      await take(path.join(root, 'skills', d.name, 'SKILL.md'), d.name.toLowerCase(), path.join(root, 'skills', d.name), 'skill');
    }
    for (const f of await files(path.join(root, 'commands'))) {
      if (f.name.endsWith('.md')) await take(path.join(root, 'commands', f.name), f.name.replace(/\.md$/, '').toLowerCase(), null, 'command');
    }
    for (const f of await files(path.join(root, 'agents'))) {
      if (f.name.endsWith('.md')) {
        skipped.push({ what: 'agent', name: f.name.replace(/\.md$/, ''), why: 'Reflect has no sub-agents; that is ReflectForge' });
      }
    }
    if ((await dirs(root)).some((d) => d.name === 'hooks') || (await readInside(root, path.join(root, 'hooks', 'hooks.json'))) !== null) {
      skipped.push({ what: 'hooks', name: 'hooks', why: 'hooks run shell commands, and Reflect does not run code' });
    }
  }

  // Connectors: recorded, not started. Nothing here speaks MCP yet.
  const connectors = [];
  const mcpText = await readInside(root, path.join(root, '.mcp.json'));
  if (mcpText) {
    try {
      const parsed = JSON.parse(mcpText);
      const servers = parsed.mcpServers || parsed;
      // Plugins point their own servers at their own files with
      // ${CLAUDE_PLUGIN_ROOT}; that is resolved to where the plugin actually
      // is. Other ${VARS} are left exactly as written. Filling them from
      // Reflect's environment would let a plugin name any secret the person
      // has — ${AWS_SECRET_ACCESS_KEY} — and have it handed over on first run.
      const resolve = (v) => String(v).split('${CLAUDE_PLUGIN_ROOT}').join(root);
      const needs = (vals) => [...new Set(vals.flatMap((v) => [...String(v).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1])))].filter((n) => n !== 'CLAUDE_PLUGIN_ROOT');
      for (const [name, cfg] of Object.entries(servers || {})) {
        if (!cfg || typeof cfg !== 'object') continue;
        const env = cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, resolve(v)])) : {};
        const args = Array.isArray(cfg.args) ? cfg.args.map(resolve) : [];
        connectors.push({
          name,
          type: cfg.type === 'sse' ? 'http' : cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'http' : 'unknown'),
          ...(cfg.url ? { url: String(cfg.url) } : {}),
          ...(cfg.command ? { command: resolve(cfg.command), args, env } : {}),
          ...(cfg.headers && typeof cfg.headers === 'object' ? { headers: cfg.headers } : {}),
          needs: needs([...Object.values(env), ...Object.values(cfg.headers || {}), ...args, cfg.url || '']),
        });
      }
    } catch {
      skipped.push({ what: 'connectors', name: '.mcp.json', why: 'not valid JSON' });
    }
  }

  // Write what fits. Never over the top of anything that exists.
  const imported = [];
  for (const s of found) {
    if (imported.includes(s.name)) {
      // Plugins ship the same skill in both layouts on purpose, during the
      // move from commands/ to skills/. That is a duplicate, not a conflict.
      skipped.push({ what: s.origin, name: s.name, why: 'the plugin ships this twice, in skills/ and commands/; the first was kept' });
      continue;
    }
    if (await readSkill(s.name)) {
      skipped.push({ what: s.origin, name: s.name, why: 'a skill with this name already exists, and it is somebody else\'s' });
      continue;
    }
    const markdown = frontmatter({ ...s, source: plugin }) + '\n' + s.body.replace(/^\n+/, '');
    const check = parseSkill(markdown, s.name);
    if (check.problems?.length) {
      skipped.push({ what: s.origin, name: s.name, why: check.problems.join('; ') });
      continue;
    }
    await writeText(join(paths().skills, s.name, 'SKILL.md'), markdown);
    for (const extra of s.extras) {
      const parts = extra.rel.split('/');
      if (parts.some((p) => !p || p === '..' || !/^[A-Za-z0-9_.-]+$/.test(p))) continue;
      // writeText creates plain files: no execute bit on anything.
      await writeText(join(paths().skills, s.name, ...parts), extra.text);
    }
    imported.push(s.name);
  }

  for (const c of connectors) {
    const slug = String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (c.type === 'unknown') {
      c.status = 'not imported: neither a command nor an address';
      continue;
    }
    const added = await Connectors.add({ ...c, name: slug, enabled: false, source: plugin });
    c.as = slug;
    c.status = added.ok ? 'added, switched off' : `not imported: ${added.reason}`;
  }

  const record = {
    name: plugin,
    description: String(meta.description || (singleSkill ? 'A single skill' : '')).slice(0, 500),
    version: meta.version ? String(meta.version) : null,
    from: given,
    importedAt: new Date().toISOString(),
    skills: imported,
    connectors,
    skipped,
  };
  const all = (await list()).filter((p) => p.name !== plugin);
  await writeJSON(MANIFEST, { plugins: [...all, record] });

  return { ok: true, plugin, imported, skipped, connectors };
}

export async function list() {
  const state = (await readJSON(MANIFEST, null)) || {};
  return Array.isArray(state.plugins) ? state.plugins : [];
}

/**
 * Take a plugin back out.
 *
 * Removes the skills it brought — only the ones still marked as coming from it,
 * so a skill somebody has since taken over and edited as their own is not
 * deleted from under them by the plugin that once supplied it.
 */
export async function remove(name) {
  const all = await list();
  const record = all.find((p) => p.name === name);
  if (!record) return { ok: false, reason: 'no such plugin' };
  const removed = [];
  const current = await listSkills();
  for (const skill of record.skills || []) {
    const here = current.find((s) => s.name === skill);
    const raw = here ? await readText(join(paths().skills, skill, 'SKILL.md'), '') : '';
    if (parseFrontmatter(raw).data.source === name) {
      await removeSkill(skill);
      removed.push(skill);
    }
  }
  // Its connectors go too — the ones still marked as its own.
  for (const c of await Connectors.list()) {
    if (c.source === name) await Connectors.remove(c.name);
  }
  await writeJSON(MANIFEST, { plugins: all.filter((p) => p.name !== name) });
  return { ok: true, removed };
}
