/**
 * The write path. One component owns every memory write.
 *
 * Reflect 1.0 wrote memory from five places — the chat route, MemoryNodeService,
 * an explicit-save short-circuit, a pending-save fallback, and compaction — and
 * two of them wrote incompatible shapes to the same file. Everything that
 * changes a memory file goes through here.
 *
 * M2 handles only what can be decided deterministically: the user explicitly
 * asked to remember something. M4 adds the model call that notices durable facts
 * nobody flagged.
 */

import * as Memory from '../store/MemoryFiles.js';
import { extract, findSuperseded } from './Extractor.js';

/**
 * "Remember this: X" / "note that X" / "don't forget X".
 *
 * Explicit save always wins — no classifier, no confidence score, no policy
 * check. If the user said remember, it gets written. This was the one thing 1.0
 * got right and it is ported deliberately.
 */
export const EXPLICIT_SAVE =
  /^\s*(?:please\s+)?(?:remember|note|save|keep in mind|don'?t forget|make a note(?: of)?)\b[\s:,-]*(?:this|that|the following)?\b[\s:,-]*/i;

const FORGET =
  /^\s*(?:please\s+)?(?:forget|remove|delete)\b[\s:,-]*(?:that|about|the fact that)?\b[\s:,-]*/i;

export function detectExplicitSave(message) {
  const text = String(message || '');

  const forget = FORGET.exec(text);
  if (forget) {
    const content = text.slice(forget[0].length).trim();
    if (content) return { kind: 'forget', content };
  }

  const save = EXPLICIT_SAVE.exec(text);
  if (!save) return null;

  const content = text.slice(save[0].length).trim();
  // "remember?" on its own is a question, not an instruction.
  if (!content || content.length < 3) return null;
  return { kind: 'save', content };
}

/**
 * Handle an explicit instruction before the model is called, so the fact is
 * durable even if generation fails.
 *
 * @returns {Promise<null | {action, target, section, text, written, reason?}>}
 */
export async function applyExplicit(message) {
  const detected = detectExplicitSave(message);
  if (!detected) return null;

  if (detected.kind === 'forget') {
    const { removed } = await Memory.forgetFact(detected.content);
    return {
      action: 'forget',
      target: 'USER.md',
      text: detected.content,
      written: removed > 0,
      // How many. "Forget Priya" can take the wife, the allergy and the
      // birthday, and being told only that something was removed leaves the
      // person to discover the other two by missing them later.
      removed,
      ...(removed ? {} : { reason: 'no matching fact' }),
    };
  }

  // A save that names a known project belongs in that project's file, not in the
  // user's profile. Nothing else is inferred — guessing which USER.md section a
  // fact belongs to is exactly the regex classification M4's model call replaces.
  const project = await Memory.resolveProject(detected.content);

  if (project) {
    const result = await Memory.upsertProject({
      slug: project.slug,
      section: 'Notes',
      text: detected.content,
    });
    return {
      action: 'save',
      target: `projects/${project.slug}.md`,
      section: 'Notes',
      text: detected.content,
      written: result.written,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  const result = await Memory.addFact({ section: 'Notes', text: detected.content });
  return {
    action: 'save',
    target: 'USER.md',
    section: 'Notes',
    text: detected.content,
    written: result.written,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/**
 * Below this, a turn cannot plausibly contain a durable fact, and the extraction
 * call is not worth its latency. This is a cost guard, not a memory policy —
 * everything above it goes to the model, which decides. The distinction matters:
 * Reflect 1.0's failure was letting a cheap heuristic make the *memory* decision.
 */
const MIN_LENGTH_TO_EXTRACT = 15;

export function worthExtracting(message) {
  const text = String(message || '').trim();
  if (text.length < MIN_LENGTH_TO_EXTRACT) return false;
  return true;
}

/**
 * Post-turn bookkeeping and automatic extraction.
 *
 * @param {object} opts
 * @param {string} opts.message        what the user said
 * @param {string} opts.reply          what Reflect said
 * @param {string|null} opts.projectSlug   project resolved during recall
 * @param {object} [opts.extractor]    { runtime, model } — omit to skip extraction
 * @returns {Promise<{writes: Array, extracted: boolean, reason?: string}>}
 */
export async function observe({ message, reply = '', projectSlug = null, extractor = null, alreadyWritten = [], signal }) {
  const writes = [];

  if (projectSlug) {
    const touched = await Memory.touchProject(projectSlug);
    if (touched) writes.push({ action: 'touch', target: `projects/${projectSlug}.md` });
  }

  if (!extractor?.runtime || !extractor?.model) {
    return { writes, extracted: false, reason: 'extraction disabled' };
  }
  if (!worthExtracting(message)) {
    return { writes, extracted: false, reason: 'too short to contain a durable fact' };
  }

  const { ok, extraction, reason, metrics } = await extract({
    runtime: extractor.runtime,
    model: extractor.model,
    userText: message,
    assistantText: reply,
    profile: await Memory.readProfileRaw(),
    projects: await Memory.listProjects(),
    alreadyWritten,
    // True when memory is being written by a model other than the one that
    // just answered — which is the only case where shrinking its window and
    // unloading it afterwards is the right thing to do.
    separate: Boolean(extractor.separate),
    signal,
  });

  if (!ok) return { writes, extracted: false, reason };

  // Promote any fact that contradicts something already on file into a
  // correction, so the old line is replaced rather than left to argue with it.
  await promoteConflicts(extraction, extractor, signal);

  writes.push(...(await applyExtraction(extraction)));
  return {
    writes,
    extracted: true,
    metrics,
    found: countOf(extraction),
    ...(extraction.rejected?.length ? { rejected: extraction.rejected } : {}),
  };
}

/**
 * Turn contradicting facts into corrections before anything is written.
 *
 * Mutates `extraction` in place: a fact that supersedes an existing line moves
 * out of `facts` and into `corrections`, where applyExtraction removes the old
 * line first.
 */
export async function promoteConflicts(extraction, extractor, signal) {
  if (!extraction.facts.length || !extractor?.runtime || !extractor?.model) return extraction;

  const profile = await Memory.readProfileRaw();
  const bySection = sectionBullets(profile);
  const kept = [];

  for (const fact of extraction.facts) {
    const existing = (bySection.get(fact.section.toLowerCase()) || []).filter(
      (line) => !Memory.isSameFact(line, fact.text)
    );

    const replaces = existing.length
      ? await findSuperseded({
          runtime: extractor.runtime,
          model: extractor.model,
          candidate: fact.text,
          existing,
          signal,
        })
      : null;

    if (replaces) extraction.corrections.push({ replaces, text: fact.text, section: fact.section });
    else kept.push(fact);
  }

  extraction.facts = kept;
  return extraction;
}

/** Bullets of a Markdown doc, grouped by their `## Section`. */
function sectionBullets(markdown) {
  const map = new Map();
  let section = '';
  for (const line of String(markdown || '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    const bullet = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (bullet && section) {
      if (!map.has(section)) map.set(section, []);
      map.get(section).push(bullet[1]);
    }
  }
  return map;
}

/** Apply a sanitized extraction to the memory files. Corrections go first. */
export async function applyExtraction(extraction) {
  const writes = [];

  // Supersession before addition: replacing "keep it short" with "prefers depth"
  // must not leave both lines in the file contradicting each other.
  for (const c of extraction.corrections) {
    const result = await Memory.replaceFact(c.replaces, c.text, { section: c.section });
    writes.push({
      action: 'supersede',
      target: 'USER.md',
      section: c.section,
      text: c.text,
      replaced: c.replaces,
      written: result.written,
      // `removed: 0` used to mean one thing — nothing matched, so the fact was
      // recorded as new. Now that a replacement can be refused to avoid losing
      // the fact it was replacing, it means four, and three of them are not
      // that. Saying "recorded as new" about a write that did not happen is the
      // kind of reassuring wrong answer this file exists to avoid.
      ...(result.written && result.removed
        ? {}
        : { reason: result.written ? 'nothing matched — recorded as new' : result.reason }),
      auto: true,
    });
  }

  for (const f of extraction.facts) {
    const result = await Memory.addFact({ section: f.section, text: f.text });
    if (result.written) {
      writes.push({ action: 'save', target: 'USER.md', section: f.section, text: f.text, written: true, auto: true });
    }
  }

  for (const p of extraction.projects) {
    const result = await Memory.upsertProject({ name: p.name, section: p.section, text: p.text });
    if (result.written) {
      writes.push({
        action: 'save',
        target: `projects/${result.slug}.md`,
        section: p.section,
        text: p.text,
        written: true,
        auto: true,
      });
    }
  }

  for (const entry of extraction.journal) {
    const result = await Memory.appendJournal(entry);
    if (result.written) {
      writes.push({ action: 'save', target: 'journal', text: entry, written: true, auto: true });
    }
  }

  return writes;
}

const countOf = (e) => e.facts.length + e.corrections.length + e.projects.length + e.journal.length;
