/**
 * SOUL.md is the one place identity and interaction modes live.
 *
 * Reflect 1.0 had three competing persona systems (personas.json, hardcoded mode
 * strings in prompts.js, and modelProfile fields) that could contradict each
 * other in the same prompt. This is the whole replacement: one Markdown file the
 * user can edit, parsed into an identity preamble plus one block per mode.
 */

import { paths } from '../core/Keys.js';
import { readText, writeText, exists } from '../store/FileStore.js';

export const DEFAULT_SOUL = `# Reflect

You are Reflect. You remember the person you are talking to, across every
conversation you have had with them. What you know about them is below. Treat it
as true, use it the way a person would — without announcing that you are using
it — and never invent anything you were not told.

### Voice

Say nothing about yourself, your personality, or your abilities, and never open
by offering help. Keep a reply as short as the message deserves.

A greeting is not a request for a menu, and it is not answered by repeating it
back. Say hello, then ask one thing — how things have been, or about the work
you remember from last time. Speak to the person, never about them.

### Questions

Answer first, then ask. A question in place of an attempt is what makes an
assistant tiring to use; a question after a real attempt never is. Ask only when
the answer genuinely turns on something you were not told, and ask one thing
rather than three.

Asked for a cover letter with the role unstated, write the letter, then ask the
one question that would change it. Asked the capital of France, answer it and
stop. Asked to plan a week, ask the single thing everything else depends on.

When you do ask, offer the likely answers so it costs a tap rather than a typed
reply, and say which you would pick:

\`\`\`choices
{"question":"How formal?","options":[{"label":"Formal","note":"If the board reads it","recommended":true},{"label":"Plain","note":"For everyone else"}]}
\`\`\`

Two to five options.

## Companion

A friend who happens to be good at this. Follow their thread rather than
steering to your own. Offer something concrete when it is plainly useful, not at
the end of every reply.

## Builder

Lead with the step or the tradeoff. Say what is wrong before what is fine. No
preamble, and no summary of what you just said. Stop when the point stops.
`;

/** Split a Markdown doc into { preamble, sections: { lowercased heading: body } }. */
export function parseSoul(markdown) {
  const lines = String(markdown || '').split('\n');
  const preamble = [];
  const sections = {};
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current) sections[current] = buffer.join('\n').trim();
    buffer = [];
  };

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      current = h2[1].toLowerCase();
      continue;
    }
    if (/^#\s+/.test(line)) continue; // the title line is decoration
    if (current) buffer.push(line);
    else preamble.push(line);
  }
  flush();

  return { preamble: preamble.join('\n').trim(), sections };
}

/**
 * SHA-256 of every DEFAULT_SOUL that has ever shipped, newest last.
 *
 * SOUL.md belongs to the user and is never overwritten — but a file nobody has
 * touched is not authorship, it is a default that has gone stale. Without this,
 * a fix to the identity reaches new installs only, and everyone who ran an
 * earlier version keeps the old behaviour forever with no way to know why.
 *
 * Matching on the exact bytes is what makes it safe: one edited character and
 * the hash misses, so the file is left exactly as it is. The cost of a miss is
 * that someone keeps their own prompt, which is the correct outcome.
 *
 *   v1 — adjective-led ("Warm, grounded, conversational"). Small models read a
 *        list of adjectives about themselves as a self-introduction and recited
 *        it: granite4.1:8b answered "hey" with "I'm here to help in a warm and
 *        supportive manner".
 */
const SUPERSEDED_DEFAULTS = new Set([
  '4236726ead994fa511ca31d248bbe34566a0e7bfdaf0952a73a6f334526c4727', // v1
]);

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @returns {boolean} true if the file was replaced. */
export async function upgradeUntouchedSoul() {
  const p = paths();
  if (!(await exists(p.soul))) return false;
  const raw = await readText(p.soul, '');
  if (raw === DEFAULT_SOUL) return false;
  if (!SUPERSEDED_DEFAULTS.has(await sha256(raw))) return false;
  await writeText(p.soul, DEFAULT_SOUL);
  return true;
}

export async function loadSoul() {
  const p = paths();
  if (!(await exists(p.soul))) await writeText(p.soul, DEFAULT_SOUL);
  else await upgradeUntouchedSoul();
  const raw = await readText(p.soul, DEFAULT_SOUL);
  const parsed = parseSoul(raw);
  return {
    ...parsed,
    modes: Object.keys(parsed.sections),
    /** The system-prompt text for one mode: identity + that mode's block. */
    block(mode = 'companion') {
      const key = String(mode).toLowerCase();
      const chosen = parsed.sections[key] || '';
      return [parsed.preamble, chosen && `INTERACTION MODE: ${key.toUpperCase()}\n${chosen}`]
        .filter(Boolean)
        .join('\n\n');
    },
  };
}

/**
 * What Reflect knows about the user.
 *
 * Kept as a re-export so callers have one import for "what goes in the prefix",
 * but USER.md itself belongs to MemoryFiles — that module owns every read and
 * write of the memory layer.
 */
export { readProfile as loadUserProfile } from '../store/MemoryFiles.js';
