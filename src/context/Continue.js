/**
 * Carrying a conversation forward into a new one.
 *
 * This is the thing Reflect was built for. The founding complaint was a long
 * ChatGPT conversation that hit its limit and took everything in it with it:
 * no way to keep going, no way to branch, and no way to get back what was said.
 *
 * Compaction already keeps a long conversation *usable* — it summarizes the
 * middle and drops it from the prompt. What it cannot do is give you a fresh
 * start. Past a certain length a conversation is slow, expensive, and full of
 * turns about something you finished an hour ago, and the honest move is a new
 * one that still knows everything.
 *
 * So: summarize the whole thing, open a new conversation, and hand it that
 * summary as its own — marked as carried, so the model knows those turns are
 * real but not in front of it.
 *
 * Nothing is deleted or moved. The old conversation stays exactly as it was and
 * stays readable; the new one records which conversation it continues, so the
 * thread can be walked back. That is the difference between continuing and
 * starting again, and it is the whole promise.
 */

import * as Conversations from '../store/ConversationStore.js';
import * as Summaries from '../store/Summaries.js';

/**
 * Long enough that a summary is worth more than the turns themselves.
 *
 * Below this, carrying forward loses more than it saves: six turns compress to
 * bullets that are longer than the exchange and blunter than it.
 */
export const MIN_TURNS = 8;

const SYSTEM = `You are summarizing a conversation so it can be continued in a new one without losing its thread.

Write 6-12 short bullets covering:
- what the person is working on, and where they got to
- every decision reached, in the words they reached it in
- facts they gave that the rest of the work depends on
- what is still open, or what they were about to do next

Keep names, numbers, file paths and specifics exactly as stated. Drop
pleasantries. Never invent, and never write anything the transcript does not
support — the new conversation will treat this as established fact and cannot
check it.

Write only the bullets.`;

/**
 * @returns {Promise<{ok: true, id: string, title: string, turns: number, summary: string}
 *                 | {ok: false, reason: string}>}
 *
 * Never throws. A failure here has to leave the original conversation untouched
 * and say why, because the person asking is usually mid-thought.
 */
export async function continueElsewhere({ conversationId, runtime, model, signal }) {
  const from = await Conversations.meta(conversationId);
  if (!from) return { ok: false, reason: 'that conversation does not exist' };

  const turns = await Conversations.turns(conversationId);
  if (turns.length < MIN_TURNS) {
    return {
      ok: false,
      reason: `only ${turns.length} turns so far — carrying on here is better until there are ${MIN_TURNS}`,
    };
  }

  // The whole conversation, not the compacted view. This is the one place that
  // wants everything: the summary being written replaces the entire history, so
  // reading only what currently fits in context would quietly drop whatever
  // compaction had already dropped.
  const previous = await Summaries.read(conversationId);
  const transcript = turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n');

  let summary = '';
  try {
    const { content } = await runtime.complete({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            previous ? `## Summary of turns already dropped from this conversation\n${previous.text}\n` : '',
            '## The conversation',
            transcript,
            '',
            'Summarize it so it can be continued in a new conversation.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      options: { num_predict: 900 },
      signal,
    });
    summary = String(content || '').trim();
  } catch (err) {
    return { ok: false, reason: err.message || 'the summary could not be written' };
  }

  if (!summary) return { ok: false, reason: 'the model returned an empty summary' };

  const id = Conversations.newId();
  const title = from.title ? `${from.title} (continued)` : 'Continued conversation';

  // Created before the summary is written, so the summary is never orphaned on
  // a conversation that does not exist.
  await Conversations.ensure(id, {
    title,
    mode: from.mode || 'companion',
    // A continued conversation belongs where the one it continues belonged.
    project: from.project || null,
    continues: conversationId,
  });

  await Summaries.write(id, {
    text: summary,
    covers: turns.length,
    throughTurnId: turns[turns.length - 1]?.id || '',
    carriedFrom: conversationId,
  });

  return { ok: true, id, title, turns: turns.length, summary };
}

/**
 * Start a new conversation from a point in an existing one.
 *
 * The other half of what continuing solves. Continuing is for a conversation
 * that has gone on too long; branching is for one that went the wrong way —
 * you want to be back at turn six and say something different, without losing
 * the eleven turns that came after it.
 *
 * Every other assistant makes you choose. Editing a message rewrites the thread
 * and the version you had is gone; regenerating replaces the answer you were
 * reading. Reflect never edits a transcript in place, so it does not have to
 * choose: the branch is a new conversation and the original is untouched, still
 * in the list, still readable.
 *
 * Turns are copied verbatim rather than summarized. The point of going back to
 * a specific moment is to have that moment, in the words it happened in — a
 * summary would be a description of the thing you were trying to return to.
 *
 * Where it cuts depends on what you picked, and the difference matters:
 *
 *   an assistant turn — everything through it comes across, and you type what
 *                       happens next
 *   a user turn       — everything *before* it comes across, and that message
 *                       is handed back to you to edit. This is "let me ask that
 *                       differently", which is the reason people reach for it.
 *
 * @returns {Promise<{ok: true, id, title, turns, editing: string|null}
 *                 | {ok: false, reason: string}>}
 */
export async function branchFrom({ conversationId, turnId }) {
  const from = await Conversations.meta(conversationId);
  if (!from) return { ok: false, reason: 'that conversation does not exist' };

  const all = await Conversations.turns(conversationId);
  const at = all.findIndex((t) => t.id === turnId);
  if (at === -1) return { ok: false, reason: 'that turn is not in this conversation' };

  const picked = all[at];
  // Inclusive of an assistant turn, exclusive of a user one — see above.
  const keep = picked.role === 'user' ? all.slice(0, at) : all.slice(0, at + 1);
  const editing = picked.role === 'user' ? picked.content : null;

  if (!keep.length && !editing) {
    return { ok: false, reason: 'there is nothing before that turn to branch from' };
  }

  const id = Conversations.newId();
  await Conversations.ensure(id, {
    title: from.title ? `${from.title} (branch)` : 'Branch',
    mode: from.mode || 'companion',
    project: from.project || null,
    branchedFrom: conversationId,
  });

  // Copied one at a time through append(), so each gets its own id and its own
  // timestamp in the new transcript. Sharing turn ids across two conversations
  // would make "which conversation was this turn in" unanswerable, and both
  // compaction and branching key off exactly that.
  for (const t of keep) {
    await Conversations.append(id, {
      role: t.role,
      content: t.content,
      thinking: t.thinking,
      model: t.model,
      stopped: t.stopped,
      attachments: t.attachments,
    });
  }

  // A branch carries the summary of whatever had already been compacted away,
  // or the turns it copied would be missing the start of their own story.
  const previous = await Summaries.read(conversationId);
  if (previous) {
    await Summaries.write(id, {
      text: previous.text,
      covers: previous.covers,
      throughTurnId: previous.throughTurnId || '',
    });
  }

  return { ok: true, id, title: `${from.title || 'Branch'}`, turns: keep.length, editing };
}
