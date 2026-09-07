/**
 * Which model writes memory.
 *
 * This has been both ways round, and the second answer is the one that came
 * from watching it run.
 *
 * At first, `extractModel: null` meant "reuse the chat model", and memory cost
 * whatever the largest installed model cost — an 8B took over 180 seconds for
 * one extraction here, past the timeout, and that failure is silent: the reply
 * streams fine and only the memory never appears.
 *
 * So it picked the smallest competent model instead. That reasoning was right
 * and its conclusion was wrong, because it ignored what *loading* costs. With a
 * 9 GB chat model resident, asking for a second model made Ollama evict the
 * first; the small model did its work and unloaded, and the next thing typed
 * paid a full reload — twenty seconds before the first word, every second
 * message. Reported from real use as "the model seems to reload between
 * messages", which is exactly what it was.
 *
 * The real cause of the original timeout was the window, not the model: left at
 * its default, a 2.6 GB download held 9.2 GB resident, almost all of it KV
 * cache nobody reads. That is fixed where it belongs.
 *
 * So the default is the model already warm, and a separate one is a decision
 * someone makes in Settings rather than a guess made for them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { memoryModelFor } = await import('../src/api/ChatController.js');
const { EXTRACT_CONTEXT } = await import('../src/reflect/Extractor.js');

const runtime = { async listModels() { throw new Error('should not be asked'); } };

test('memory is written by the model that is already loaded', async () => {
  assert.equal(await memoryModelFor(runtime, 'gemma4:12b'), 'gemma4:12b');
  assert.equal(await memoryModelFor(runtime, 'qwen3:4b'), 'qwen3:4b');
});

// It used to call listModels() on the reply path to decide. Nothing to decide
// now, so nothing to call — a network round trip between the answer and the
// memory pass bought nothing.
test('choosing costs no round trip', async () => {
  await memoryModelFor(runtime, 'anything'); // the fake throws if asked
});

// Extraction reads a system prompt plus one exchange — around a thousand tokens
// — and writes at most 600. Everything above that is cache nobody reads, and
// cache is resident memory competing with the model being talked to.
test('a model of its own gets a small window, and the warm one does not', async () => {
  const { extract } = await import('../src/reflect/Extractor.js');
  const seen = [];
  const fake = {
    async complete(req) {
      seen.push(req);
      return { content: '{"facts":[],"corrections":[],"projects":[],"journal":[]}' };
    },
  };

  await extract({ runtime: fake, model: 'small:4b', userText: 'hi', assistantText: 'hello', profile: '', projects: [], separate: true });
  assert.equal(seen[0].options.num_ctx, EXTRACT_CONTEXT);
  assert.equal(seen[0].keepAlive, 0, 'and it lets go of the memory afterwards');

  // On the model mid-conversation both would be actively harmful: Ollama
  // reloads whenever num_ctx changes, so asking for a smaller window would
  // evict the very model this is trying not to disturb.
  await extract({ runtime: fake, model: 'chat:12b', userText: 'hi', assistantText: 'hello', profile: '', projects: [], separate: false });
  assert.equal(seen[1].options.num_ctx, undefined);
  assert.equal(seen[1].keepAlive, undefined);
});
