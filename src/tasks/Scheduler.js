/**
 * The clock that runs saved tasks.
 *
 * It checks every minute for anything due and sends the instruction through the
 * app's own `/api/chat` — over loopback, to the server it is running inside.
 * That looks indirect and is deliberate: a task must take exactly the path a
 * typed message takes, or the two will drift and "run it on Monday" will stop
 * meaning what "type it on Monday" means. Reusing the endpoint makes that
 * impossible rather than merely unlikely.
 *
 * Three rules the scheduler holds:
 *
 *   1. **One at a time.** A local model can serve one conversation at a time;
 *      two tasks firing at nine would fight for the same GPU and both be slow.
 *   2. **A missed slot still runs.** If the laptop was asleep at nine, the task
 *      runs when it wakes. Comparing against the last scheduled moment rather
 *      than counting intervals is what makes that true — see Tasks.isDue.
 *   3. **A failure is recorded, not retried.** The run is marked, the journal
 *      says what happened, and it waits for the next slot. A scheduler that
 *      retries in a loop is how a broken task becomes a busy machine.
 */

import { dueTasks, markRun } from './Tasks.js';
import { appendJournal } from '../store/MemoryFiles.js';

/** A minute is short enough to feel prompt and long enough to cost nothing. */
const TICK_MS = 60_000;

/**
 * Run one task by sending its instruction through the ordinary chat path.
 *
 * @returns {Promise<{name: string, ok: boolean, conversationId?: string, error?: string}>}
 */
export async function runTask(task, { baseUrl, signal } = {}) {
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The name, not the permission. What this task may reach is read from its
      // own file at the other end, so a caller cannot ask for more than the
      // task was written to have.
      body: JSON.stringify({ message: task.instruction, mode: 'companion', taskName: task.name }),
      signal,
    });

    // The reply streams; the scheduler only needs to know it happened and
    // where it went. The conversation itself is the record, in the same list
    // as everything else — a task's output should be readable exactly like a
    // conversation you had.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let conversationId = null;
    let failure = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, cut).replace(/^data: /, '').trim();
        buffer = buffer.slice(cut + 2);
        if (!raw) continue;
        try {
          const event = JSON.parse(raw);
          if (event.type === 'start') conversationId = event.conversationId;
          if (event.type === 'error') failure = event.message;
        } catch {
          /* a partial line completes on the next read */
        }
      }
    }

    await markRun(task.name, { conversationId });
    await appendJournal(
      failure
        ? `Task "${task.name}" ran and failed: ${failure}`
        : `Task "${task.name}" ran ${task.schedule.text}.`
    );

    return { name: task.name, ok: !failure, conversationId, error: failure || undefined };
  } catch (err) {
    // Still mark it: an unrunnable task must not fire again every minute.
    await markRun(task.name).catch(() => {});
    await appendJournal(`Task "${task.name}" could not run: ${err.message}`).catch(() => {});
    return { name: task.name, ok: false, error: err.message };
  }
}

/**
 * Start the clock. Returns a stop function.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl   where this server is listening
 * @param {(run: object) => void} [opts.onRun]
 * @param {() => Promise<void>} [opts.onQuiet]  called on a tick where no task
 *   was due — the machine is on and nothing louder wants it. Sleep rides here:
 *   it is maintenance, and maintenance yields to everything with a schedule.
 */
export function startScheduler({ baseUrl, onRun = () => {}, onQuiet = null }) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return; // never overlap ticks
    running = true;
    try {
      const due = await dueTasks();
      for (const task of due) {
        if (stopped) break;
        const result = await runTask(task, { baseUrl });
        onRun(result);
      }
      if (!due.length && !stopped && onQuiet) await onQuiet();
    } catch {
      // A scheduler that throws is a scheduler that stops. Whatever went wrong
      // will still be wrong in a minute, and the journal will have said so.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.(); // never hold the process open just to tick

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
