/**
 * The memory layer: USER.md, projects/*.md, journal/YYYY-MM-DD.md.
 *
 * These files are the truth. Everything else — the index in M3, the trace in the
 * UI — is derived from them and can be thrown away. A user can open any of them
 * in a text editor, delete a line, and Reflect forgets it. That property is the
 * whole reason for the substrate, so nothing here may store anything in a form a
 * person can't read.
 *
 * All writes go through FileStore, so they are atomic.
 */

import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import { readText, writeText, listFiles, ensureDir, updateText, exists, remove } from './FileStore.js';
import { contentWords, informativeOverlap } from '../text.js';

// ─────────────────────────────────────────────────────────── markdown helpers

const stripComments = (md) => md.replace(/<!--[\s\S]*?-->/g, '');
const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();

/**
 * Do these two lines say the same thing?
 *
 * Used by every write path, so "already known" means the same thing whether a
 * fact arrives from the user, a tool call, or automatic extraction. Without one
 * shared answer, the files accumulate the same fact in three phrasings.
 */
export function isSameFact(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (!A.size || !B.size) return false;

  const { shared, informative } = informativeOverlap(A, B);

  // Two shared words is the floor, and at least one of them has to mean
  // something. "my favourite colour is oxblood" and "my favourite season is
  // autumn" share *my* and *favourite* and nothing else — the same count and
  // the same ratio as a real duplicate, which is why counting alone cannot
  // decide this.
  //
  // One informative word, not two: "Name: Sam" and "name: sam" share only
  // *name* and *sam*, and *name* is scaffolding. Demanding two would stop the
  // shortest facts from ever deduplicating, which is the opposite failure.
  if (shared.length < 2 || informative.length < 1) return false;

  // Measure against the *shorter* line, not the union. One line restating
  // another with extra detail is still the same fact, and Jaccard punishes it
  // for the extra words.
  return shared.length / Math.min(A.size, B.size) >= 0.5;
}


export { contentWords as factWords };

/**
 * Tidy a fact before it is written.
 *
 * Models sometimes prefix an entry with the heading they chose — "Preferences:
 * Prefers short answers". That belongs in the section, not the sentence, and on
 * disk it reads as noise. Applied at the write layer so every path benefits:
 * explicit save, tool call, and extraction alike.
 */
const SECTION_LABEL =
  /^(identity|relationships|preferences|working style|notes|what it is|decisions|open)\s*[:\u2014-]\s+/i;

export function tidyFact(text) {
  return String(text || '').trim().replace(SECTION_LABEL, '').replace(/\s+/g, ' ').trim();
}

/** Body of a Markdown doc with the H1 title and editor comments removed. */
export function bodyOf(markdown) {
  return stripComments(String(markdown || ''))
    .split('\n')
    .filter((l) => !/^#\s/.test(l))
    .join('\n')
    .trim();
}

/** True when a doc has nothing but headings — i.e. it is seeded, not filled. */
export function isEmptyDoc(markdown) {
  const body = bodyOf(markdown);
  return !body.split('\n').some((l) => l.trim() && !/^#{2,}\s/.test(l));
}

/**
 * Insert a bullet under `## Section`, creating the section at the end if it is
 * missing. Returns the new document, or null when the bullet is already there.
 */
export function insertUnderSection(markdown, section, bullet) {
  const doc = String(markdown || '');
  const wanted = bullet.replace(/^-\s*/, '');

  // Idempotent, and not merely on exact text: a fact already recorded in other
  // words is still already recorded.
  const already = doc
    .split('\n')
    .some((l) => /^\s*-\s+/.test(l) && isSameFact(l.replace(/^\s*-\s*/, ''), wanted));
  if (already) return null;

  const lines = doc.split('\n');
  const heading = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

  let start = lines.findIndex((l) => heading.test(l));
  if (start === -1) {
    const trimmed = doc.replace(/\s+$/, '');
    return `${trimmed}\n\n## ${section}\n\n- ${bullet}\n`;
  }

  // Find the end of this section: the next H2, or the end of the document.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // Insert after the last non-empty line inside the section.
  let insertAt = start + 1;
  for (let i = end - 1; i > start; i--) {
    if (lines[i].trim()) {
      insertAt = i + 1;
      break;
    }
  }
  if (insertAt === start + 1 && !lines[start + 1]?.trim()) insertAt = start + 2;

  lines.splice(insertAt, 0, `- ${bullet}`);
  return lines.join('\n');
}

/**
 * Remove every bullet matching `needle`, by substring *or* by meaning.
 *
 * Substring alone is not enough. A correction arrives from a model, and models
 * paraphrase: asked which line it was replacing, one answered
 * "Preferences: Prefers short answers" for a bullet reading "Prefers short
 * answers". The substring never matched, the old line survived, and the
 * replacement was then rejected as a duplicate of it — so a changed preference
 * changed nothing at all.
 */
export function removeBullets(markdown, needle) {
  const want = normalize(needle);
  if (!want) return { doc: markdown, removed: 0 };
  let removed = 0;
  const doc = String(markdown || '')
    .split('\n')
    .filter((l) => {
      if (!/^\s*-\s+/.test(l)) return true;
      const bullet = l.replace(/^\s*-\s*/, '');
      if (normalize(bullet).includes(want) || isSameFact(bullet, needle)) {
        removed++;
        return false;
      }
      return true;
    })
    .join('\n');
  return { doc, removed };
}

// ──────────────────────────────────────────────────────────────────── USER.md

/**
 * Keep the file as it was, so the change about to happen can be undone.
 *
 * This lives in the writer rather than at the call sites because the promise —
 * every change to memory is on the timeline — should not depend on each future
 * caller remembering to make it. Extraction is the writer that matters most
 * here: it is the one the person did not perform themselves, and so the one
 * they are most likely to want back.
 *
 * Best-effort by design. Failing to record history is not a reason to refuse
 * to record the fact.
 */
async function keepPrevious(before, reason) {
  if (!before || !before.trim()) return;
  const { snapshot } = await import('../reflect/Versions.js');
  await snapshot({ reason, content: before }).catch(() => {});
}

export async function readProfileRaw() {
  return readText(paths().user, '');
}

/** The profile as it should appear in the prompt. '' when nothing is recorded. */
export async function readProfile() {
  const raw = await readProfileRaw();
  return isEmptyDoc(raw) ? '' : bodyOf(raw);
}

export async function writeProfile(content) {
  await writeText(paths().user, content);
}

/** @returns {{written: boolean, section: string, text: string}} */
export async function addFact({ section = 'Notes', text }) {
  const clean = tidyFact(text);
  if (!clean) return { written: false, section, text: '' };

  let reason = null;
  let before = '';
  const { changed } = await updateText(paths().user, (raw) => {
    before = raw;
    const next = insertUnderSection(raw || '# User\n', section, clean);
    if (!next) reason = 'already known';
    return next;
  });
  if (changed) await keepPrevious(before, 'Reflect recorded a fact');

  return changed
    ? { written: true, section, text: clean }
    : { written: false, section, text: clean, reason: reason || 'unchanged' };
}

export async function forgetFact(needle) {
  let removed = 0;
  let before = '';
  const { changed } = await updateText(paths().user, (raw) => {
    before = raw;
    const result = removeBullets(raw, needle);
    removed = result.removed;
    return removed ? result.doc : null;
  });
  if (changed) await keepPrevious(before, 'Reflect dropped a fact');
  return { removed };
}

/**
 * Replace a fact in place. Used by the Reflector for supersession.
 *
 * One transform, one lock, one write — because the obvious version of this
 * (forget, then add) is not a replacement at all. It is a deletion followed by
 * something that is allowed to decline, and when it declined the fact was
 * simply gone: an empty replacement, or one that collided with a bullet
 * already on file, removed the old fact and put nothing in its place. It
 * returned `removed: 1` while doing it, so the loss read as success.
 *
 * The rule now is that nothing is removed unless the replacement lands. A
 * needle matching several bullets is refused rather than guessed at, because
 * guessing which of two facts the model meant costs the user the other one —
 * and in an assistant whose whole promise is remembering, a silently dropped
 * memory is the worst thing the file can do.
 */
export async function replaceFact(needle, replacement, { section = 'Notes' } = {}) {
  const clean = tidyFact(replacement);
  if (!clean) return { removed: 0, written: false, section, text: '', reason: 'no replacement given' };

  let removed = 0;
  let reason = null;
  let before = '';
  const { changed } = await updateText(paths().user, (raw) => {
    before = raw;
    const cut = removeBullets(raw || '# User\n', needle);

    // Which one was meant is a guess, and a wrong guess is a lost memory.
    if (cut.removed > 1) {
      reason = `the needle matched ${cut.removed} facts`;
      return null;
    }

    const next = insertUnderSection(cut.removed ? cut.doc : raw || '# User\n', section, clean);

    // The replacement did not land — it is already on file in these words.
    // Keeping the old fact is the only outcome here that loses nothing.
    if (!next) {
      reason = 'already known';
      return null;
    }

    removed = cut.removed;
    return next;
  });
  if (changed) await keepPrevious(before, 'Reflect replaced a fact');

  return changed
    ? { removed, written: true, section, text: clean }
    : { removed: 0, written: false, section, text: clean, reason: reason || 'unchanged' };
}

// ──────────────────────────────────────────────────────────────────── journal

/**
 * The date as the person lives it, not as UTC has it.
 *
 * This used toISOString(), which files an evening under tomorrow: 9pm in New
 * York is 1am UTC, so a journal entry written after 8pm landed on the wrong
 * day — and "a year ago today" quietly missed the evenings, which is when
 * people write journals. A day is a local phenomenon.
 */
const dayStamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const journalPath = (stamp) => join(paths().journal, `${stamp}.md`);

/** Append a timestamped bullet to a day's log. Today by default. */
export async function appendJournal(text, { date = new Date() } = {}) {
  const clean = tidyFact(text);
  if (!clean) return { written: false };

  const stamp = dayStamp(date);
  const time = date.toTimeString().slice(0, 5);

  const { changed } = await updateText(journalPath(stamp), (raw) =>
    insertUnderSection(raw || `# ${stamp}\n`, 'Log', `${time} — ${clean}`)
  );

  return changed ? { written: true, date: stamp, text: clean } : { written: false, reason: 'already logged' };
}

/** The last `days` journal files that exist, newest last. */
export async function readJournal(days = 1) {
  if (!days || days < 1) return [];
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const stamp = dayStamp(d);
    const body = bodyOf(await readText(journalPath(stamp), ''));
    if (body) out.push({ date: stamp, body });
  }
  return out;
}

/**
 * The journal for one particular day, however long ago.
 *
 * readJournal() walks back from now, which serves recall. This serves the
 * mirror: "a year ago today" is a specific date, not a recent window.
 */
export async function readJournalOn(date) {
  const stamp = dayStamp(date instanceof Date ? date : new Date(date));
  const body = bodyOf(await readText(journalPath(stamp), ''));
  return body ? { date: stamp, body } : null;
}

// ─────────────────────────────────────────────────────────────────── projects

export const slugify = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/^(the|my|our)\s+/, '') // "The Turtles Book" and "Turtles Book" are one project
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Find the project a name refers to, however it was phrased.
 *
 * Without this, "The Turtles Book" and "Turtles Book" become two files and the
 * project's memory is split in half — observed live, in the second conversation
 * about the same book. Slug normalization catches the common case; matching
 * against existing names and aliases catches the rest.
 */
export async function findProjectByName(name) {
  const target = slugify(name);
  if (!target) return null;

  const projects = await listProjects();
  const direct = projects.find((p) => p.slug === target);
  if (direct) return direct;

  return (
    projects.find((p) =>
      [p.name, ...p.aliases].some((candidate) => slugify(candidate) === target)
    ) || null
  );
}

const projectPath = (slug) => join(paths().projects, `${slug}.md`);

/** Minimal frontmatter parser: `key: value` and `key: [a, b]`. No YAML dep. */
export function parseFrontmatter(markdown) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(markdown || ''));
  if (!m) return { data: {}, body: String(markdown || '') };

  const data = {};
  for (const line of m[1].split('\n')) {
    // Hyphens allowed: the Agent Skills format uses `allowed-tools`, and a
    // parser that silently drops a key is worse than one that rejects it.
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (/^\[.*\]$/.test(value)) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: String(markdown).slice(m[0].length) };
}

export function serializeFrontmatter(data) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export async function listProjects() {
  const names = await listFiles(paths().projects, '.md');
  const out = [];
  for (const name of names) {
    const slug = name.replace(/\.md$/, '');
    const raw = await readText(projectPath(slug), '');
    const { data } = parseFrontmatter(raw);
    out.push({
      slug,
      name: data.name || slug,
      aliases: Array.isArray(data.aliases) ? data.aliases : [],
      status: data.status || 'active',
      lastTouched: data.last_touched || null,
    });
  }
  return out.sort((a, b) => String(b.lastTouched).localeCompare(String(a.lastTouched)));
}

export async function readProject(slug) {
  const raw = await readText(projectPath(slug), '');
  if (!raw) return null;
  const { data, body } = parseFrontmatter(raw);
  return { slug, meta: data, body: bodyOf(body), raw };
}

export async function writeProject(slug, raw) {
  await ensureDir(paths().projects);
  await writeText(projectPath(slug), raw);
}

/** Create the project if new, then add a bullet under `section`. */
export async function upsertProject({ slug, name, section = 'Notes', text, aliases = [] }) {
  // Resolve to an existing project before creating a new one, so the same book
  // called two slightly different things stays one file.
  const known = await findProjectByName(slug || name);
  const key = known?.slug || slug || slugify(name);
  if (!key) return { written: false };

  // Record the phrasing that was used, so it resolves directly next time.
  if (known && name && slugify(name) !== known.slug) {
    aliases = [...aliases, String(name).trim()];
  }

  const existing = await readText(projectPath(key), '');
  let raw = existing;

  if (!raw) {
    raw =
      serializeFrontmatter({
        name: name || key,
        aliases,
        status: 'active',
        last_touched: dayStamp(),
      }) + `\n# ${name || key}\n`;
  }

  const { data, body } = parseFrontmatter(raw);
  if (aliases.length) {
    data.aliases = [...new Set([...(data.aliases || []), ...aliases])];
  }
  data.last_touched = dayStamp();

  const clean = tidyFact(text);
  let nextBody = body;
  if (clean) {
    const inserted = insertUnderSection(body, section, clean);
    if (!inserted) {
      await writeProject(key, serializeFrontmatter(data) + body);
      return { written: false, slug: key, reason: 'already known' };
    }
    nextBody = inserted;
  }

  await writeProject(key, serializeFrontmatter(data) + nextBody);
  return { written: Boolean(clean), slug: key, section, text: clean };
}

/**
 * Create an empty project, because someone asked for one.
 *
 * Every other project here is born sideways: the Reflector notices you talking
 * about a book and writes the file. That covers the case where you did not know
 * you had a project, and misses the one where you know exactly what you are
 * starting and want somewhere to put it before the first chat exists.
 *
 * Resolves against existing names first, so "Turtle Book" does not become a
 * second file beside "turtles-book".
 */
export async function createProject(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('A project needs a name.');

  const known = await findProjectByName(trimmed);
  if (known) return { slug: known.slug, name: known.name, created: false };

  const slug = slugify(trimmed);
  if (!slug) throw new Error('That name has no letters or numbers in it.');

  // serializeFrontmatter takes the data and returns the block — it has no body
  // parameter, and passing one is silently ignored. The sections are appended.
  // last_touched from the start. Without it a project made deliberately sorts
  // below every project the Reflector wrote, and can never go stale — the
  // staleness check has nothing to measure from.
  await writeText(
    projectPath(slug),
    `${serializeFrontmatter({ name: trimmed, aliases: [], status: 'active', last_touched: dayStamp() })}` +
      `\n## What it is\n\n## Decisions\n\n## Open\n`,
  );
  return { slug, name: trimmed, created: true };
}

/** Rename the label without moving the file, so filed chats keep pointing at it. */
export async function renameProject(slug, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('A project needs a name.');
  const raw = await readText(projectPath(slug), '');
  if (!raw) return null;
  const { data, body } = parseFrontmatter(raw);
  // The old name becomes an alias, so a sentence using it still resolves here.
  const aliases = new Set([...(Array.isArray(data.aliases) ? data.aliases : [])]);
  if (data.name && data.name !== trimmed) aliases.add(data.name);
  // The body has to be put back by hand. Passing it to serializeFrontmatter
  // looks right and does nothing, which would have made renaming a project
  // delete everything the Reflector had ever written into it.
  await writeText(
    projectPath(slug),
    `${serializeFrontmatter({ ...data, name: trimmed, aliases: [...aliases] })}\n${body.replace(/^\n+/, '')}`,
  );
  return { slug, name: trimmed };
}

/** @returns {boolean} whether there was one to remove. */
export async function removeProject(slug) {
  if (!(await exists(projectPath(slug)))) return false;
  await remove(projectPath(slug));
  return true;
}

export async function touchProject(slug) {
  const raw = await readText(projectPath(slug), '');
  if (!raw) return false;
  const { data, body } = parseFrontmatter(raw);
  data.last_touched = dayStamp();
  await writeProject(slug, serializeFrontmatter(data) + body);
  return true;
}

/**
 * Resolve a message to a project by name or alias.
 *
 * This runs before any embedding, and it is what makes "I want to work on the
 * book project again" land on turtles-book.md deterministically instead of
 * hoping cosine similarity gets there. Longest match wins, so "reflect forge"
 * beats a project merely aliased "reflect".
 */
export async function resolveProject(message) {
  const text = ` ${normalize(message)} `;
  if (!text.trim()) return null;

  const projects = await listProjects();
  let best = null;

  for (const project of projects) {
    for (const candidate of [project.name, project.slug.replace(/-/g, ' '), ...project.aliases]) {
      const needle = normalize(candidate);
      if (needle.length < 3) continue;
      if (!text.includes(` ${needle} `) && !text.includes(` ${needle}'`) && !text.includes(`${needle}s `)) {
        continue;
      }
      if (!best || needle.length > best.matchedOn.length) {
        best = { ...project, matchedOn: needle };
      }
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────────── retrieval

/**
 * Every memory file flattened into addressable chunks.
 *
 * One bullet is one chunk — the natural unit of a remembered fact. M3's indexer
 * consumes exactly this, so the shape is the seam between keyword search now and
 * hybrid search later.
 *
 * Each chunk carries a `title`: for a project, its name and aliases. That title
 * is searchable but is not part of the text shown to the model, which is what
 * lets "work on that book idea again" find a project called "Turtles Book"
 * whose bullets never say the word "book".
 *
 * @returns {Promise<Array<{source, section, text, title, kind, date}>>}
 */
export async function collectChunks() {
  const chunks = [];

  const walk = (markdown, source, kind, { date = null, title = '' } = {}) => {
    let section = '';
    for (const line of bodyOf(markdown).split('\n')) {
      const h = /^#{2,}\s+(.+?)\s*$/.exec(line);
      if (h) {
        section = h[1];
        continue;
      }
      const bullet = /^\s*-\s+(.*\S)\s*$/.exec(line);
      const text = bullet ? bullet[1] : line.trim();
      if (!text || text.length < 3) continue;
      chunks.push({ source, section, text, title, kind, date });
    }
  };

  walk(await readProfileRaw(), 'USER.md', 'profile');

  for (const project of await listProjects()) {
    const doc = await readProject(project.slug);
    if (!doc) continue;
    const title = [project.name, ...project.aliases].join(' ');
    walk(doc.raw.replace(/^---[\s\S]*?---\n/, ''), `projects/${project.slug}.md`, 'project', { title });
  }

  for (const name of await listFiles(paths().journal, '.md')) {
    const date = name.replace(/\.md$/, '');
    walk(await readText(join(paths().journal, name), ''), `journal/${name}`, 'journal', { date });
  }

  return chunks;
}
