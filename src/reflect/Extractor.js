/**
 * Noticing what mattered, without being told.
 *
 * This is the piece Reflect 1.0 never built. It approximated it with a 160-line
 * regex classifier that decided "My wife's name is Priya" was durable because
 * the sentence starts with "my " — and decided a great many other things wrongly
 * for the same reason.
 *
 * A small model is simply better at "did the user reveal something that will
 * still matter next week?" than any pattern can be. The call is constrained to a
 * JSON schema, so it works on a 4B model, and it runs *after* the reply has
 * finished streaming, so the user never waits for it.
 *
 * What it may not do: invent. The prompt and the merge below both treat the
 * user's own words as the only source, because a memory system that embellishes
 * is worse than one that forgets.
 */

import { isSameFact, tidyFact } from '../store/MemoryFiles.js';
import { contentWords } from '../text.js';

const SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      description: 'Durable facts about the user themselves.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          section: {
            type: 'string',
            enum: ['Identity', 'Relationships', 'Preferences', 'Working style', 'Notes'],
          },
        },
        required: ['text', 'section'],
      },
    },
    corrections: {
      type: 'array',
      description: 'Facts that replace something already recorded, because the user changed or corrected it.',
      items: {
        type: 'object',
        properties: {
          replaces: { type: 'string', description: 'Distinctive words from the existing line being replaced.' },
          text: { type: 'string' },
          section: {
            type: 'string',
            enum: ['Identity', 'Relationships', 'Preferences', 'Working style', 'Notes'],
          },
        },
        required: ['replaces', 'text', 'section'],
      },
    },
    projects: {
      type: 'array',
      description: 'Notes belonging to an ongoing piece of work.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          text: { type: 'string' },
          section: { type: 'string', enum: ['What it is', 'Decisions', 'Open'] },
        },
        required: ['name', 'text', 'section'],
      },
    },
    journal: {
      type: 'array',
      description: 'What happened today. Matters now, not necessarily next month.',
      items: { type: 'string' },
    },
  },
  required: ['facts', 'corrections', 'projects', 'journal'],
};

const SYSTEM = `You file durable memory from a conversation. You are a filing clerk, not a participant.

## The test that decides where something goes

Ask: will this still be true, and still matter, in six months?

  yes, and it is about them            → facts
  yes, and it is about something they  → projects
       have named and are working on
  no                                   → journal, if it is worth remembering
                                         happened at all
  neither                              → record nothing

A named piece of work opens its own file whether or not you have seen it
before. You do not need to recognise the name; you need it to have one.

## One fact per entry, and write entries, not sentences

Each entry holds exactly ONE fact. If someone gives you five facts in a
sentence, that is five entries, not one line with commas in it. A compound line
can never be corrected later — when their address changes you cannot replace
half a bullet.

  they said                            you file
  ─────────────────────────────────────────────────────────────────────
  "im sam, my wife is Priya, we      four entries:
   live in Portland and i ride a         "Name: Sam"
   gts300"                               "Wife: Priya"
                                         "Lives in Portland"
                                         "Rides a Vespa GTS300"
                                       NOT one entry reading
                                         "Sam, wife Priya, Portland
                                          resident, rides Vespa GTS300"

An entry is the shortest form that still makes sense alone in six months. Never
narrate what was said, never write "The user...", never include when they told
you.

  they said                            you file
  ─────────────────────────────────────────────────────────────────────
  "up late talking to my wife Priya"   fact: "Wife: Priya"
                                       (that they were up late is not durable)
  "picked up a Vespa GTS300 at the     fact: "Rides a Vespa GTS300"
   weekend, still getting used to it"  (still getting used to it fades — skip it)
  "just keep answers short"            fact: "Prefers short answers"
  "stop asking me so many questions"   fact: "Prefers few follow-up questions"
  "ask me more before you answer"      fact: "Likes being asked clarifying
                                        questions"
                                       (how they want to be talked to is a
                                        preference like any other, and it counts
                                        whether they ask for more of it or less.
                                        File what they want, not the grumble)
  "for Forge, agents own orchestration" project "ReflectForge": "Agents own
                                       orchestration, not the core"
  "for the Ashdown pitch we lead on    project "Ashdown Pitch": "Leads on the
   the cost saving"                     cost saving"
                                       (a project you have never heard of is
                                        still a project)
  "stuck on chapter two all day"       journal: "Stuck on chapter two"
  "I'm knackered"                      nothing
  "what's the capital of France?"      nothing

## Never record

- anything the assistant said, suggested, or inferred — only the user's own words
- questions the user asked
- passing states: tiredness, mood, weather, being busy
- wanting to *work on* something, renewed interest in a project, or plans to
  continue — that is the conversation happening, not a fact about them
- what someone is doing right now or arranging: "coordinating plans for the
  birthday", "looking into flights". The birthday is a fact; the coordinating
  is not

Note the difference, because it matters: wanting to work on a project is not a
fact, but wanting something *from you* always is.

  "I want to get back to the book"        nothing — that is this conversation
  "I want the deeper reasoning from now   fact: "Prefers deeper reasoning"
   on"                                    (and it likely replaces an existing
                                           preference — file it as a correction)
- anything already present in the memory shown to you, in any wording
- detail you are filling in yourself. If they did not say it, it does not exist.

## Corrections

If the user contradicts something already in memory — a changed preference, a
corrected name — file it as a correction, with "replaces" set to a few
distinctive words from the existing line. Do not file the same thing as both a
correction and a fact.

Most turns contain nothing worth filing. Empty arrays are the correct and common
answer, and one precise entry always beats three vague ones.`;

/**
 * Caps per turn. A memory system that hoards is a memory system nobody trusts.
 *
 * Facts sits at 5 rather than 3 because people introduce themselves in one
 * breath — "I'm Sam, my wife is Priya, we're in Portland, I ride a GTS300 and
 * work on a Mac Studio" is five facts in one sentence, and a cap of 3 silently
 * dropped the last two.
 */
export const LIMITS = { facts: 5, corrections: 2, projects: 3, journal: 2 };

export function buildMessages({ userText, assistantText, profile, projects }) {
  const known = projects.length
    ? projects.map((p) => `- ${p.name}${p.aliases?.length ? ` (also: ${p.aliases.join(', ')})` : ''}`).join('\n')
    : '(none yet)';

  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        '## Memory already recorded about this user',
        profile || '(nothing yet)',
        '',
        '## Ongoing projects',
        known,
        '',
        '## The exchange to extract from',
        `USER: ${userText}`,
        `ASSISTANT: ${assistantText}`,
        '',
        'Extract durable memory from what the USER said. Return empty arrays if there is nothing.',
      ].join('\n'),
    },
  ];
}

/**
 * An entry must be traceable to something the user actually said.
 *
 * Two failure modes this catches, both observed with a real 8B model:
 *
 *   1. Few-shot leakage. The examples above are instructions, but a model will
 *      cheerfully file "Stuck on chapter two" as a memory on a turn about a
 *      motorcycle, because it read the example as content.
 *   2. Embellishment. A model that fills in plausible detail the user never
 *      gave is worse than one that forgets, because the invention is
 *      indistinguishable from a real memory once it is on disk.
 *
 * The rule is deliberately weak — one shared content word — so paraphrase
 * survives ("my spouse Priya" → "Wife: Priya" shares *priya*) while invention
 * does not.
 */
export function isGrounded(entry, userText) {
  if (!userText) return true; // nothing to check against
  const source = contentWords(userText);
  if (!source.size) return true;
  for (const w of contentWords(entry)) if (source.has(w)) return true;
  return false;
}

/** Trim, drop empties, cap counts, and reject anything not grounded in the turn. */
export function sanitize(raw, { userText = '', alreadyWritten = [] } = {}) {
  const out = { facts: [], corrections: [], projects: [], journal: [], rejected: [] };
  if (!raw || typeof raw !== 'object') return out;

  const clean = tidyFact; // the write layer's rules, applied before dedupe too
  const usable = (s) => clean(s).length >= 4 && clean(s).length <= 300;

  /**
   * A fact that runs long is almost always several facts wearing one coat.
   * Rejecting it is better than filing it: the information comes back in a
   * later turn, whereas a compound line is permanent — it cannot be superseded,
   * and it hides from the duplicate check because its extra words dilute the
   * overlap with any single fact inside it.
   */
  const COMPOUND_WORDS = 16;
  const COMPOUND_CLAUSES = 3;
  const isCompound = (s) => {
    const text = clean(s);
    // Comma count is the sharper signal. The line that prompted this rule —
    // "Sam, wife Priya, Portland resident, rides Vespa GTS300, works on Mac
    // Studio" — is only 12 words but five clauses. A real single fact rarely
    // has more than one comma: "Rode a Vespa 400, now rides an GTS300" is one
    // fact about one bike and stays.
    const clauses = text.split(/,\s*/).filter((part) => /[a-z0-9]/i.test(part));
    return clauses.length >= COMPOUND_CLAUSES || text.split(/\s+/).length > COMPOUND_WORDS;
  };

  const admit = (text, kind, push, { allowLong = false } = {}) => {
    if (!usable(text)) return;
    if (!allowLong && isCompound(text)) {
      out.rejected.push({ kind, text: clean(text), reason: 'several facts in one entry' });
      return;
    }
    if (!isGrounded(text, userText)) {
      out.rejected.push({ kind, text: clean(text), reason: 'not grounded in what the user said' });
      return;
    }
    push();
  };

  for (const f of asArray(raw.facts).slice(0, LIMITS.facts)) {
    admit(f?.text, 'fact', () => out.facts.push({ text: clean(f.text), section: sectionOf(f.section) }));
  }
  for (const c of asArray(raw.corrections).slice(0, LIMITS.corrections)) {
    if (clean(c?.replaces).length < 3) continue;
    // `replaces` points at existing memory, so only `text` is grounded here.
    admit(c?.text, 'correction', () =>
      out.corrections.push({
        replaces: clean(c.replaces),
        text: clean(c.text),
        section: sectionOf(c.section),
      })
    );
  }
  for (const p of asArray(raw.projects).slice(0, LIMITS.projects)) {
    if (clean(p?.name).length < 2) continue;
    admit(p?.text, 'project', () =>
      out.projects.push({
        name: clean(p.name),
        text: clean(p.text),
        section: ['What it is', 'Decisions', 'Open'].includes(p.section) ? p.section : 'Notes',
      })
    );
  }
  for (const j of asArray(raw.journal).slice(0, LIMITS.journal)) {
    admit(j, 'journal', () => out.journal.push(clean(j)), { allowLong: true });
  }

  return dedupe(out, alreadyWritten);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * One sentence, one home.
 *
 * A model asked for four categories will sometimes file the same statement in
 * two of them — observed live: a project decision filed as a project note *and*
 * as a correction to the user's profile. `alreadyWritten` closes the same hole
 * across mechanisms, when the model already saved something via the memory_write
 * tool earlier in the turn.
 *
 * Precedence is most-specific-first: a project note names its destination, so it
 * outranks a generic fact about the user.
 */
export function dedupe(out, alreadyWritten = []) {
  const seen = alreadyWritten.map(norm).filter(Boolean);

  // Exact matching is not enough: observed live, a tool wrote "Agents will own
  // orchestration instead of the core" and extraction wrote the same sentence
  // with " for ReflectForge" appended. Containment plus a high token overlap
  // catches the near-misses without collapsing genuinely different facts. The
  // 0.55 bar was set by a live miss: "Agents will own orchestration rather than
  // the core" vs "Agents own orchestration, not the core" overlap at 0.55.
  // One shared definition of "the same fact", so a duplicate is a duplicate
  // whether it arrives from a tool, from extraction, or is already on disk.
  const isDuplicateOf = (a, b) => Boolean(a) && Boolean(b) && (a === b || isSameFact(a, b));

  const keep = (text) => {
    const key = norm(text);
    if (!key) return false;
    if (seen.some((prior) => isDuplicateOf(key, prior))) return false;
    seen.push(key);
    return true;
  };

  const projects = out.projects.filter((p) => keep(p.text));
  const corrections = out.corrections.filter((c) => keep(c.text));
  const facts = out.facts.filter((f) => keep(f.text));
  const journal = out.journal.filter((j) => keep(j));

  const dropped =
    out.projects.length - projects.length +
    (out.corrections.length - corrections.length) +
    (out.facts.length - facts.length) +
    (out.journal.length - journal.length);

  return {
    projects,
    corrections,
    facts,
    journal,
    rejected: [
      ...out.rejected,
      ...(dropped ? [{ kind: 'duplicate', text: '', reason: `${dropped} entry already filed elsewhere this turn` }] : []),
    ],
  };
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const SECTIONS = ['Identity', 'Relationships', 'Preferences', 'Working style', 'Notes'];
const sectionOf = (s) => (SECTIONS.includes(s) ? s : 'Notes');

/**
 * Run the extraction call.
 *
 * @returns {Promise<{ok, extraction, reason?, metrics?}>} never throws — a
 *   failed extraction must not disturb a turn that already succeeded.
 */
/**
 * How long the memory pass may take.
 *
 * Longer than a chat turn's default on purpose. Extraction is a second full
 * model call that starts the moment a reply finishes, so it runs on a machine
 * that is already warm, already holding the weights, and often already busy.
 * At the 60-second default it timed out under sustained use — and a timeout
 * here is invisible: the reply is fine, the memory simply never appears.
 */
export const EXTRACT_TIMEOUT_MS = 180_000;

/**
 * The window extraction asks for.
 *
 * Its prompt is the system rules plus one exchange — around a thousand tokens —
 * and the reply is capped at 600. Everything above that is KV cache nobody
 * reads, and KV cache is resident memory competing with the model you are
 * actually talking to.
 */
export const EXTRACT_CONTEXT = 4096;

export async function extract({ runtime, model, userText, assistantText, profile, projects, alreadyWritten = [], signal, separate = false }) {
  try {
    const { content, metrics } = await runtime.complete({
      model,
      messages: buildMessages({ userText, assistantText, profile, projects }),
      timeoutMs: EXTRACT_TIMEOUT_MS,
      format: SCHEMA,
      // Temperature 0. This is classification, not writing: the same sentence
      // should file the same way every time. At the default 0.8 it did not —
      // whether "for the Turtles Book I've decided…" became a project note or
      // an ordinary fact varied run to run, which makes a memory bug
      // unreproducible and therefore unfixable. Measured, it is also no worse.
      //
      // A small window on purpose. The prompt is about a thousand tokens and the
      // reply is capped at 600, so anything larger is cache nobody reads — and
      // that cache is resident memory. Left at the default, qwen3:4b held 9.2 GB
      // for a 2.6 GB download.
      // The window and the unload apply only when extraction is running on a
      // model of its own. On the model mid-conversation they would be actively
      // harmful: Ollama reloads whenever num_ctx changes, so asking for a
      // smaller window would evict the very model this is trying not to
      // disturb, and keep_alive 0 would throw it away entirely.
      options: { num_predict: 600, temperature: 0, ...(separate ? { num_ctx: EXTRACT_CONTEXT } : {}) },
      // Out of memory the moment it is done. Extraction runs once a turn and
      // takes seconds; the chat model is the expensive one and the one worth
      // keeping warm. Without this the small model camped on the memory and
      // evicted the model that was mid-conversation, so every second message
      // paid a full reload — twenty seconds on this machine.
      ...(separate ? { keepAlive: 0 } : {}),
      signal,
    });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = /\{[\s\S]*\}/.exec(content);
      if (!match) return { ok: false, reason: 'model returned no JSON', extraction: sanitize(null) };
      parsed = JSON.parse(match[0]);
    }

    return { ok: true, extraction: sanitize(parsed, { userText, alreadyWritten }), metrics };
  } catch (err) {
    return { ok: false, reason: err.message, extraction: sanitize(null) };
  }
}

/**
 * Does this new fact replace one already on file?
 *
 * The extraction call is asked to spot contradictions itself, and often does —
 * but not reliably. Live, "scratch that, I want the deeper reasoning" was filed
 * as a new fact rather than a correction, leaving both preferences on file
 * contradicting each other. Whether something supersedes is too important to
 * depend on a model volunteering it.
 *
 * So it is asked directly, as a narrow question with the candidates in front of
 * it. "Which of these five lines does this replace, if any?" is a far easier
 * question than "extract everything worth keeping", and small models answer it
 * well. It runs only when a fact lands in a section that already has lines.
 *
 * @returns {Promise<string|null>} the existing line being replaced
 */
export async function findSuperseded({ runtime, model, candidate, existing, signal }) {
  const lines = existing.filter(Boolean).slice(0, 8);
  if (!lines.length) return null;

  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

  try {
    const { content } = await runtime.complete({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You decide whether a new note about a person replaces one already on file.\n\n' +
            'It replaces an existing line only if both cannot be true at once — a changed ' +
            'preference, a corrected name, an updated situation. Two facts that can both be ' +
            'true replace nothing, even when they are about the same subject.\n\n' +
            'Answer with the number of the line it replaces, or 0 for none. Nothing else.',
        },
        { role: 'user', content: `Existing:\n${numbered}\n\nNew note: ${candidate}\n\nWhich number does it replace? 0 if none.` },
      ],
      format: {
        type: 'object',
        properties: { replaces: { type: 'integer' } },
        required: ['replaces'],
      },
      options: { num_predict: 30, temperature: 0 },
      signal,
    });

    const index = Number(JSON.parse(content)?.replaces);
    if (!Number.isInteger(index) || index < 1 || index > lines.length) return null;
    return lines[index - 1];
  } catch {
    return null; // never block a write on this
  }
}

export { SCHEMA };
