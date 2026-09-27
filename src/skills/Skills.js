/**
 * Skills — reusable instructions, in the open Agent Skills format.
 *
 * A skill is a folder with a `SKILL.md` inside it:
 *
 *     skills/
 *       write-like-me/
 *         SKILL.md
 *         references/     (optional, loaded only when the skill asks)
 *         scripts/        (optional)
 *
 * and the file is YAML frontmatter over Markdown instructions:
 *
 *     ---
 *     name: write-like-me
 *     description: Match the user's own writing voice in emails and notes.
 *     ---
 *     Prefer short sentences...
 *
 * We implement that format rather than inventing one. It is the format Claude
 * and Codex already read, which means a skill someone wrote for either of them
 * works here unchanged, and one written here works there. Reflect's own
 * character comes from *where skills live* — a folder you own, next to your
 * memory, editable in any text editor — not from a proprietary schema.
 *
 * **Progressive disclosure** is the load-bearing idea, and it is the same idea
 * Reflect's recall already rests on. Only `name` and `description` are put in
 * front of the model on an ordinary turn — a line each, so a dozen skills cost
 * a couple of hundred tokens. The instructions themselves are loaded only when
 * a skill is actually called for. A system that pastes every skill into every
 * prompt is a system that gets slower with each one you add.
 *
 * **`allowed-tools` is a request, not a grant.** The field exists in the
 * format and is parsed and reported here, but nothing in Reflect treats it as
 * permission. A skill is know-how; it does not get to widen its own access.
 * When Reflect grows real tool grants, they will live outside the skill and be
 * approved by the person, not declared by the file.
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readText, writeText, listFiles, exists, removeAll } from '../store/FileStore.js';
import { parseFrontmatter } from '../store/MemoryFiles.js';
import { estimateTokens } from '../context/ContextBudget.js';

/** The file inside a skill folder. Fixed by the format. */
export const SKILL_FILE = 'SKILL.md';

/** What the catalogue of skills may cost on an ordinary turn. */
export const CATALOGUE_BUDGET = 400;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillKey = (name) => join(paths().skills, name, SKILL_FILE);

/**
 * Read one SKILL.md into something usable, and say what is wrong with it.
 *
 * Never throws: a malformed skill is reported, listed, and skipped, because the
 * alternative is one bad file stopping the app from starting.
 */
export function parseSkill(markdown, folder = '') {
  const { data, body } = parseFrontmatter(markdown);
  const problems = [];

  const name = String(data.name || folder || '').trim();
  const description = String(data.description || '').trim();

  if (!name) problems.push('no name');
  else if (!NAME.test(name)) problems.push('name must be lowercase words joined by hyphens');
  else if (folder && name !== folder) problems.push(`name "${name}" does not match its folder "${folder}"`);

  if (!description) problems.push('no description — this is what the model reads when deciding to use it');
  else if (description.length > 1024) problems.push('description is over 1024 characters');

  if (!body.trim()) problems.push('no instructions');

  return {
    name: name || folder,
    description,
    license: data.license ? String(data.license) : '',
    // Which plugin brought it, if one did. Shown so a skill written by a
    // stranger never looks like one the person wrote.
    source: data.source ? String(data.source) : '',
    // Off is a real state, and it lives in the file rather than in config.
    // A skill is a document you own; someone editing SKILL.md in an editor
    // should be able to switch it off there and have Reflect agree.
    enabled: String(data.enabled ?? 'true') !== 'false',
    // Parsed and shown, never obeyed. See the note at the top of this file.
    requestedTools: Array.isArray(data['allowed-tools'])
      ? data['allowed-tools']
      : data['allowed-tools']
        ? [String(data['allowed-tools'])]
        : [],
    body: body.trim(),
    problems,
    valid: problems.length === 0,
  };
}

/** Every skill installed, valid or not, sorted by name. */
export async function listSkills() {
  const folders = await listFiles(paths().skills);
  const found = [];

  for (const folder of folders) {
    const key = skillKey(folder);
    if (!(await exists(key))) continue;
    const skill = parseSkill(await readText(key, ''), folder);
    found.push({ ...skill, folder, key });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(name) {
  const key = skillKey(name);
  if (!(await exists(key))) return null;
  return { ...parseSkill(await readText(key, ''), name), folder: name, key };
}

/**
 * The other files a skill carries.
 *
 * Tested against the skills on a real machine: 14 of 24 ship reference
 * documents that SKILL.md tells the reader to open ("see references/forms.md"),
 * and 5 ship scripts. Reflect only ever read SKILL.md, so more than half of the
 * ecosystem's skills were pointing at pages the model could not turn to.
 *
 * Documents are readable. Scripts are listed so the model can say honestly
 * which part of a skill needs something Reflect will not do — run code.
 */
const DOC = /\.(md|txt)$/i;
const SCRIPT = /\.(py|sh|bash|js|mjs|cjs|ts|rb|pl|ps1|bat)$/i;

export async function skillResources(name) {
  const none = { docs: [], scripts: [] };
  if (!NAME.test(String(name || ''))) return none;
  const base = join(paths().skills, name);
  const docs = [];
  const scripts = [];
  const sort = (rel) => {
    if (DOC.test(rel)) docs.push(rel);
    else if (SCRIPT.test(rel)) scripts.push(rel);
  };
  for (const entry of await listFiles(base).catch(() => [])) {
    if (entry === SKILL_FILE) continue;
    // One level down is where real skills keep things (references/, scripts/).
    let inner = null;
    try {
      inner = await listFiles(join(base, entry));
    } catch {
      inner = null; // a file, not a folder
    }
    if (inner && inner.length) inner.forEach((f) => sort(`${entry}/${f}`));
    else sort(entry);
  }
  return { docs, scripts };
}

/**
 * One of those documents — and only from inside the skill's own folder.
 *
 * The storage port already keeps reads inside Reflect's home, but "inside the
 * home" includes USER.md and every conversation. A skill asking for
 * `../../USER.md` is a skill asking for something that is not its own, so
 * paths are held to plain names under the skill, and to text.
 */
export async function readSkillFile(name, file) {
  if (!NAME.test(String(name || ''))) return null;
  const rel = String(file || '').replace(/^\.\//, '');
  const parts = rel.split('/');
  if (!DOC.test(rel) || parts.some((p) => !p || p === '.' || p === '..' || !/^[A-Za-z0-9_.-]+$/.test(p))) return null;
  const key = join(paths().skills, name, ...parts);
  if (!(await exists(key))) return null;
  return readText(key, '');
}

export async function writeSkill(name, markdown) {
  if (!NAME.test(name)) throw new Error(`Unsafe skill name: ${name}`);
  await writeText(skillKey(name), markdown);
  return readSkill(name);
}

/**
 * Switch a skill on or off by editing its own frontmatter.
 *
 * Not a config entry. A skill is a document you own, so the state belongs in
 * the document — someone who opens SKILL.md in an editor should see why it is
 * not being offered, and someone who copies the folder to another machine
 * should carry the setting with it.
 */
export async function setSkillEnabled(name, enabled) {
  if (!NAME.test(name)) throw new Error(`Unsafe skill name: ${name}`);
  const source = await readText(skillKey(name), '');
  if (!source) return null;

  const flag = `enabled: ${enabled ? 'true' : 'false'}`;
  const next = /^enabled:.*$/m.test(source)
    ? source.replace(/^enabled:.*$/m, flag)
    : // Insert inside the existing frontmatter rather than prepending a second
      // block, which would make the file unparseable.
      source.replace(/^---\n/, `---\n${flag}\n`);

  await writeText(skillKey(name), next);
  return readSkill(name);
}

export async function removeSkill(name) {
  if (!NAME.test(name)) throw new Error(`Unsafe skill name: ${name}`);
  if (!(await exists(skillKey(name)))) return false;
  await removeAll(join(paths().skills, name));
  return true;
}

/**
 * The line-per-skill catalogue that goes in the prompt.
 *
 * Bounded on purpose: this is paid for on every turn, so it stops at the budget
 * and says how many it left out rather than quietly growing until first-token
 * latency doubles.
 */
export function catalogue(skills, { budget = CATALOGUE_BUDGET } = {}) {
  // A skill switched off costs nothing and is offered to nobody. Every line in
  // the catalogue is paid for on every turn, which is the whole reason someone
  // would want to switch one off.
  const usable = skills.filter((s) => s.valid && s.enabled !== false);
  if (!usable.length) return '';

  const lines = [];
  let used = estimateTokens('## Skills\n\nOne line each. When one fits, load it with skill_use before following it.\n');
  let dropped = 0;

  for (const skill of usable) {
    const line = `- ${skill.name} — ${skill.description}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += cost;
  }

  if (!lines.length) return '';
  return [
    '## Skills',
    '',
    // This line used to say "these are instructions you can follow" over a list
    // of one-line descriptions — the model was told to follow instructions it
    // had never been shown. It worked for the starters only because their
    // descriptions were nearly the whole skill.
    'One line each. When one fits, load it with skill_use before following it, and say which you are using.',
    '',
    ...lines,
    dropped ? `\n(${dropped} more not listed; the user can name one with /name.)` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Skills the message asked for by name: `/write-like-me` or `@write-like-me`.
 *
 * Explicit beats clever. Automatic selection can come later from the same
 * recall machinery that ranks memory, but being able to *insist* is what makes
 * a skill feel like a tool rather than a suggestion.
 */
export function invoked(message, skills) {
  const text = String(message || '');
  const named = new Set();

  for (const match of text.matchAll(/(?:^|\s)[/@]([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    named.add(match[1]);
  }

  // Naming a disabled skill does not run it. Off means off, including when
  // asked for by name — otherwise the switch is a suggestion.
  return skills.filter((s) => s.valid && s.enabled !== false && named.has(s.name));
}

/** The full instructions for the skills a turn actually calls for. */
export function instructionsFor(skills) {
  if (!skills.length) return '';
  return skills
    .map((s) => `## Skill: ${s.name}\n\n${s.body}`)
    .join('\n\n---\n\n');
}
