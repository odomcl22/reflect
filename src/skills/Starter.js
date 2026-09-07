/**
 * The skills a new install starts with.
 *
 * Borrowed in spirit from what the Llama app does well: a small default set you
 * can see, switch off, edit, or throw away — rather than an empty panel and a
 * blank editor, which is a worse first impression than a handful of examples
 * that happen to be useful.
 *
 * These are written to disk once, on first scaffold, and then belong to the
 * user completely. Reflect never rewrites them, never restores a deleted one,
 * and never upgrades them in place: a starter skill someone has edited is their
 * file, and quietly replacing it would be the opposite of the promise the
 * memory folder makes.
 *
 * They are deliberately ordinary. A starter set is there to show the shape of
 * the thing — frontmatter, a description the model reads, instructions written
 * as if briefing a colleague — not to be clever.
 */

export const STARTER_SKILLS = [
  {
    name: 'brief',
    body: `---
name: brief
description: Answer in one or two sentences with no preamble. Use when the user wants a quick answer, not an explanation.
---

Answer in one or two sentences.

No preamble, no restating the question, no offer of further help at the end.
If the honest answer is "it depends", say what it depends on in the same breath
rather than asking a clarifying question.
`,
  },
  {
    name: 'proofread',
    body: `---
name: proofread
description: Correct grammar, spelling and punctuation without changing voice. Use when the user wants text fixed rather than rewritten.
---

Return the corrected text and nothing else.

Fix grammar, spelling, punctuation and obvious slips. Leave word choice,
rhythm and register alone — the point is that it still sounds like the person
who wrote it. British or American spelling: follow whichever the text already
uses.

If a sentence is genuinely ambiguous, correct what you can and add one line
underneath naming the ambiguity.
`,
  },
  {
    name: 'plain-english',
    body: `---
name: plain-english
description: Rewrite jargon-heavy text so a smart non-specialist can follow it. Use when something needs to be explained rather than shortened.
---

Rewrite the text so someone competent but outside the field can follow it.

Keep every fact and every number. Replace terms of art with what they mean, or
define them in passing the first time. Prefer short sentences and concrete
nouns. Do not add encouragement, do not add a summary, and do not make it
longer than it needs to be — plain is not the same as padded.
`,
  },
  {
    name: 'devils-advocate',
    body: `---
name: devils-advocate
description: Argue the strongest case against the user's plan. Use when they want their thinking stress-tested rather than supported.
---

Argue the strongest honest case *against* what the user has proposed.

Lead with the objection you think is most likely to be right, not the easiest
one to make. Be specific about what would go wrong and under what conditions.
If the plan is actually sound, say so and give the one risk worth watching —
inventing objections to seem rigorous wastes their time.

End with what evidence would change your mind.
`,
  },
];

/**
 * Install any starter skill that is not already present.
 *
 * Absence is respected: a skill the user deleted stays deleted, because this
 * only writes what is missing on a folder that has never had skills at all.
 */
export async function installStarterSkills({ listSkills, writeSkill }) {
  const existing = await listSkills();
  // Only on a genuinely empty skills folder. Checking name-by-name would
  // resurrect deleted starters on every boot, which is a haunting, not a
  // feature.
  if (existing.length) return [];

  const installed = [];
  for (const skill of STARTER_SKILLS) {
    await writeSkill(skill.name, skill.body);
    installed.push(skill.name);
  }
  return installed;
}
