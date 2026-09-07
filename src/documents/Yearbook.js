/**
 * Your year, as a book.
 *
 * Reflect keeps a dated journal, projects with the decisions you reached in
 * them, and a profile of what it learned about you. Those are already the
 * makings of an annual review; this composes them into one and hands it to the
 * PDF writer.
 *
 * No AI company can offer this, and the reason is structural rather than
 * technical: it requires having given you the files in the first place. A
 * memory you can print and put on a shelf is the opposite of a moat, which is
 * exactly why it is worth doing — the promise is that this outlives us, and a
 * bound copy of the year is that promise made physical.
 *
 * Composed as Markdown so the PDF writer does the layout it already knows how
 * to do, and so the same text can be saved as .md or .docx by anyone who would
 * rather have it that way.
 */

import { readText, listFiles } from '../store/FileStore.js';
import { paths } from '../core/Keys.js';
import { join } from '../core/Storage.js';
import * as Memory from '../store/MemoryFiles.js';
import * as Conversations from '../store/ConversationStore.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The body of a memory file, without its frontmatter or its title line. */
function bodyOnly(raw) {
  return String(raw)
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/^#\s+.*$/m, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/** A journal line without its clock. The times are scaffolding a year later. */
const unstamp = (line) =>
  line.replace(/^\s*[-*]?\s*\d{1,2}:\d{2}\s*—\s*/, '').replace(/^\s*[-*]\s*/, '').trim();

/** Which years there is anything to print. */
export async function yearsAvailable() {
  const names = await listFiles(paths().journal, '.md');
  return [...new Set(names.map((n) => n.slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse();
}

/**
 * The year, as Markdown ready for the PDF writer.
 *
 * @returns {Promise<{markdown: string, days: number, empty: boolean}>}
 */
export async function yearbook(year, { now = new Date() } = {}) {
  const y = String(year);
  const names = (await listFiles(paths().journal, '.md')).filter((n) => n.startsWith(`${y}-`)).sort();

  const byMonth = new Map();
  let days = 0;
  for (const name of names) {
    const body = bodyOnly(await readText(join(paths().journal, name), ''));
    const lines = body.split('\n').map(unstamp).filter((l) => l && !/^#/.test(l));
    if (!lines.length) continue;
    days++;
    const stamp = name.replace(/\.md$/, '');
    const month = Number(stamp.slice(5, 7)) - 1;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push({ stamp, lines });
  }

  // Projects that were alive during the year. last_touched is a day stamp, so
  // a prefix match is the whole test.
  const projects = [];
  for (const p of await Memory.listProjects()) {
    if (p.lastTouched && !String(p.lastTouched).startsWith(y)) continue;
    const doc = await Memory.readProject(p.slug);
    if (!doc) continue;
    const decisions = (doc.body.split(/^##\s+/m).find((s) => /^Decisions/i.test(s)) || '')
      .split('\n')
      .slice(1)
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
    projects.push({ name: p.name, decisions });
  }

  let conversations = 0;
  try {
    conversations = (await Conversations.list()).filter((c) => String(c.createdAt || '').startsWith(y)).length;
  } catch {
    conversations = 0;
  }

  const profile = await Memory.readProfile();
  const empty = !days && !projects.length;

  const out = [`# ${y}`, ''];
  if (empty) {
    out.push('Nothing was written down this year.', '');
    return { markdown: out.join('\n'), days: 0, empty: true };
  }

  // The opening page is the shape of the year in four numbers, because a
  // number you did not know about yourself is the thing that makes someone
  // turn the page.
  const counted = [
    days && `${days} ${days === 1 ? 'day' : 'days'} written down`,
    projects.length && `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`,
    conversations && `${conversations} ${conversations === 1 ? 'conversation' : 'conversations'}`,
  ].filter(Boolean);
  if (counted.length) out.push(counted.join(' · '), '');
  out.push('---', '');

  if (profile) {
    out.push('## What Reflect knows about you', '', profile.trim(), '');
  }

  if (projects.length) {
    out.push('## What you were working on', '');
    for (const p of projects) {
      out.push(`### ${p.name}`, '');
      if (p.decisions.length) for (const d of p.decisions) out.push(`- ${d}`);
      else out.push('No decisions were written down.');
      out.push('');
    }
  }

  if (days) {
    out.push('## The year, month by month', '');
    for (const month of [...byMonth.keys()].sort((a, b) => a - b)) {
      out.push(`### ${MONTHS[month]}`, '');
      for (const day of byMonth.get(month)) {
        const dayNum = Number(day.stamp.slice(8, 10));
        out.push(`**${dayNum} ${MONTHS[month]}**`, '');
        for (const line of day.lines) out.push(`- ${line}`);
        out.push('');
      }
    }
  }

  out.push('---', '', `Printed from Reflect on ${now.toDateString()}. Every word came from your own files.`, '');
  return { markdown: out.join('\n'), days, empty: false };
}
