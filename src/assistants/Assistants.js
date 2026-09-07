/**
 * Assistants — a role you can pick, not a separate mind.
 *
 * The obvious way to build this is the way most apps do: several assistants,
 * each with its own identity, its own settings, and its own memory. That is
 * wrong here, and it is worth being explicit about why, because it is the one
 * decision in this file that cannot be reversed later without losing data.
 *
 * Reflect exists because a long conversation hit a context limit and everything
 * in it was gone. The promise is continuity: it knows you, and it keeps knowing
 * you. Split the memory across assistants and that promise breaks in the most
 * confusing way available — you tell the study assistant you are working on
 * brevity, and the work assistant has never heard of it. Nobody would predict
 * which one remembers what, and the answer would be an implementation detail.
 *
 * So: **one memory, many hats.** An assistant changes how Reflect speaks, which
 * model answers, and which tools and skills are on the table. It does not
 * change what Reflect knows about you. Everything written during a conversation
 * with any assistant is written to the same USER.md, the same projects, the
 * same journal.
 *
 * This is also not a new mechanism. SOUL.md already had an identity and a block
 * per interaction mode; an assistant is that idea made editable, with a model
 * and a tool set attached.
 *
 * An assistant is a file: `assistants/<name>.md`.
 *
 *     ---
 *     name: study
 *     description: Patient, asks questions back, explains rather than answers.
 *     model: qwen3:4b
 *     tools: memory_search, memory_get
 *     ---
 *     You are helping someone study...
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readText, writeText, listFiles, exists, remove } from '../store/FileStore.js';
import { parseFrontmatter, serializeFrontmatter } from '../store/MemoryFiles.js';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const assistantKey = (name) => join(paths().assistants, `${name}.md`);

/**
 * The one every install starts with.
 *
 * Deliberately not written to disk. It is what Reflect is when nobody has
 * chosen anything, and a default that exists only as a file is a default
 * someone can delete themselves out of.
 */
export const DEFAULT_ASSISTANT = {
  name: 'reflect',
  description: 'The everyday assistant. Warm, direct, and remembers what you are working on.',
  model: null, // whatever is selected
  tools: null, // all of them
  skills: null, // all of them
  persona: '',
  builtIn: true,
  valid: true,
  problems: [],
};

const listOf = (value) =>
  value === undefined || value === null || String(value).trim() === ''
    ? null
    : String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

export function parseAssistant(markdown, file = '') {
  const { data, body } = parseFrontmatter(markdown);
  const name = String(data.name || file.replace(/\.md$/, '')).trim();
  const description = String(data.description || '').trim();
  const problems = [];

  if (!NAME.test(name)) problems.push('name must be lowercase words joined by hyphens');
  if (!description) problems.push('no description — this is how you tell them apart');

  return {
    name,
    description,
    // Null means "whatever the person picked", not "none". An assistant that
    // pinned a model it does not have would be unusable on another machine.
    model: data.model ? String(data.model).trim() : null,
    // Null means every tool. A named list is a restriction, and restricting is
    // the only reason to write one.
    tools: listOf(data.tools),
    skills: listOf(data.skills),
    persona: body.trim(),
    builtIn: false,
    problems,
    valid: problems.length === 0,
  };
}

export function serializeAssistant(a) {
  return (
    serializeFrontmatter({
      name: a.name,
      description: a.description,
      ...(a.model ? { model: a.model } : {}),
      ...(a.tools?.length ? { tools: a.tools.join(', ') } : {}),
      ...(a.skills?.length ? { skills: a.skills.join(', ') } : {}),
    }) + `\n${(a.persona || '').trim()}\n`
  );
}

/** Everyone, with the built-in first so the list never looks empty. */
export async function listAssistants() {
  const files = await listFiles(paths().assistants, '.md');
  const found = [];
  for (const file of files) {
    found.push(parseAssistant(await readText(join(paths().assistants, file), ''), file));
  }
  return [DEFAULT_ASSISTANT, ...found.sort((a, b) => a.name.localeCompare(b.name))];
}

export async function readAssistant(name) {
  if (!name || name === DEFAULT_ASSISTANT.name) return DEFAULT_ASSISTANT;
  const key = assistantKey(name);
  if (!(await exists(key))) return null;
  return parseAssistant(await readText(key, ''), `${name}.md`);
}

export async function writeAssistant(name, fields) {
  if (!NAME.test(name)) throw new Error(`Unsafe assistant name: ${name}`);
  if (name === DEFAULT_ASSISTANT.name) throw new Error('The built-in assistant cannot be overwritten.');
  const current = (await readAssistant(name)) || { name, description: '', persona: '' };
  await writeAssistant.write(name, { ...current, ...fields, name });
  return readAssistant(name);
}
writeAssistant.write = async (name, next) => writeText(assistantKey(name), serializeAssistant(next));

export async function removeAssistant(name) {
  if (!NAME.test(name)) throw new Error(`Unsafe assistant name: ${name}`);
  if (name === DEFAULT_ASSISTANT.name) throw new Error('The built-in assistant cannot be deleted.');
  if (!(await exists(assistantKey(name)))) return false;
  await remove(assistantKey(name));
  return true;
}

/**
 * Fold an assistant into the identity the prompt is built from.
 *
 * The assistant's persona *follows* the soul rather than replacing it: Reflect
 * is still Reflect, still bound by the same rules about not inventing details
 * and not narrating its own memory. A role is a way of speaking, not a licence
 * to become something else.
 */
export function personaFor(soulBlock, assistant) {
  if (!assistant?.persona) return soulBlock;
  return `${soulBlock}\n\nROLE: ${assistant.name.toUpperCase()}\n${assistant.persona}`;
}

/** Narrow a tool list to what this assistant is allowed. Null means all. */
export function toolsAllowedBy(assistant, tools) {
  if (!assistant?.tools) return tools;
  const allowed = new Set(assistant.tools);
  return tools.filter((t) => allowed.has(t.function.name));
}

/** Same, for skills — an assistant with a short list has a shorter catalogue. */
export function skillsAllowedBy(assistant, skills) {
  if (!assistant?.skills) return skills;
  const allowed = new Set(assistant.skills);
  return skills.filter((s) => allowed.has(s.name));
}
