/**
 * Keeping a long conversation useful on a small model.
 *
 * The order of operations here is the whole design, and it is taken from
 * OpenClaw's pre-compaction memory flush:
 *
 *   1. flush   — extract durable memory from the turns about to leave context,
 *                while the model can still see them
 *   2. summarize — compress those turns into prose
 *   3. mark    — record where the summary reaches
 *
 * Doing the flush first is what makes compaction safe. Summarizing and *then*
 * asking "was anything in there worth keeping?" asks the question after the
 * evidence has been thrown away. Reflect 1.0 compacted first and never asked at
 * all, so a fact stated in turn 3 of a long conversation was simply gone.
 *
 * Nothing is deleted. The raw turns stay in the .jsonl forever; compaction only
 * changes what is loaded into the prompt.
 */

import * as Conversations from '../store/ConversationStore.js';
import * as Summaries from '../store/Summaries.js';
import { estimateTokens } from './ContextBudget.js';
import { extract } from '../reflect/Extractor.js';
import { applyExtraction } from '../reflect/Reflector.js';
import * as Memory from '../store/MemoryFiles.js';

/** Turns kept verbatim at each end. The opening sets the frame; the tail is live. */
export const PROTECT_FIRST = 2;
export const PROTECT_LAST = 6;

/** Compact when the turns alone would use more than this share of their budget. */
export const TRIGGER = 0.85;

const SUMMARY_SYSTEM = `You compress part of a conversation so it can be dropped from context without losing its thread.

Write 4-8 short bullets covering:
- what the user is trying to do, and any decision they reached
- facts they gave that the later conversation depends on
- questions left open

Keep names, numbers, and specifics exactly as stated. Drop pleasantries, drop
anything the assistant merely suggested, and never invent. If an earlier summary
is provided, fold it in — the result replaces it and must not lose what it held.

Write only the bullets.`;

/**
 * Would this conversation's turns overflow what the prompt will actually carry?
 *
 * Two ways to overflow, and both must trigger. Tokens are the obvious one. The
 * other is the depth setting's turn ceiling: at Balanced only the last 10 turns
 * are included, so a 30-turn conversation loses its opening to `fitTurns` even
 * when the tokens would have fit. Anything dropped that way is dropped
 * *silently and unsummarized* — which is precisely the information loss
 * compaction exists to prevent. So compaction has to fire on whichever limit
 * bites first.
 */
export function shouldCompact(turns, budget) {
  const used = turns.reduce((sum, t) => sum + estimateTokens(t.content) + 4, 0);
  const limit = Math.floor(budget.tokens.turns * TRIGGER);
  const maxTurns = budget.limits.turns;
  const compactable = turns.length - PROTECT_FIRST - PROTECT_LAST;

  const overTokens = used > limit;
  const overTurns = Number.isFinite(maxTurns) && turns.length > maxTurns;

  return {
    should: (overTokens || overTurns) && compactable >= 2,
    reason: overTokens ? 'tokens' : overTurns ? 'turn ceiling' : 'within budget',
    used,
    limit,
    turns: turns.length,
    maxTurns,
    compactable: Math.max(0, compactable),
  };
}

/**
 * @returns {Promise<{ran, reason?, covers?, summary?, writes?, flushed?}>}
 *   Never throws: a failed compaction leaves the conversation exactly as it was,
 *   and the next turn will simply try again.
 */
export async function compact({ conversationId, budget, runtime, model, signal }) {
  const { turns } = await Conversations.contextTurns(conversationId);
  const check = shouldCompact(turns, budget);
  if (!check.should) {
    return {
      ran: false,
      reason: `${check.used} tokens / ${check.turns} turns is within the ${check.limit} token, ${check.maxTurns} turn budget`,
      ...check,
    };
  }

  // The opening stays verbatim, so the middle starts after it — but only on the
  // first pass. Once compacted, `contextTurns` already re-prepends the head, and
  // compacting it again would summarize the same turns forever.
  const alreadyCompacted = Boolean(await Conversations.compaction(conversationId));
  const headSize = alreadyCompacted ? 0 : PROTECT_FIRST;
  const middle = turns.slice(headSize, turns.length - PROTECT_LAST);
  if (!middle.length) return { ran: false, reason: 'nothing between the protected ends' };

  const previous = await Summaries.read(conversationId);
  const transcript = middle.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n');
  const userSaid = middle.filter((t) => t.role === 'user').map((t) => t.content).join('\n');

  // ---- 1. flush ------------------------------------------------------------
  // Ask what mattered while the turns are still here to be read.
  let writes = [];
  let flushed = false;
  try {
    const { ok, extraction } = await extract({
      runtime,
      model,
      userText: userSaid,
      assistantText: '(compaction flush — several turns)',
      profile: await Memory.readProfileRaw(),
      projects: await Memory.listProjects(),
      signal,
    });
    if (ok) {
      writes = await applyExtraction(extraction);
      flushed = true;
    }
  } catch {
    // A failed flush must not block compaction — the raw turns remain on disk
    // either way, so nothing is unrecoverable.
  }

  // ---- 2. summarize --------------------------------------------------------
  let summaryText = '';
  try {
    const { content } = await runtime.complete({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: [
            previous ? `## Earlier summary to fold in\n${previous.text}\n` : '',
            '## Turns to compress',
            transcript,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      options: { num_predict: 500 },
      signal,
    });
    summaryText = String(content || '').trim();
  } catch (err) {
    return { ran: false, reason: `summary failed: ${err.message}`, writes, flushed };
  }

  if (!summaryText) return { ran: false, reason: 'model returned an empty summary', writes, flushed };

  // ---- 3. mark -------------------------------------------------------------
  const through = middle[middle.length - 1];
  const covers = (previous?.covers || 0) + middle.length;

  await Summaries.write(conversationId, { text: summaryText, covers, throughTurnId: through.id });
  await Conversations.markCompacted(conversationId, {
    throughTurnId: through.id,
    covers,
    head: alreadyCompacted ? (await Conversations.compaction(conversationId))?.head || 0 : PROTECT_FIRST,
  });

  return {
    ran: true,
    covers,
    compressed: middle.length,
    summary: summaryText,
    writes,
    flushed,
    tokensBefore: check.used,
  };
}
