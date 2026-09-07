/**
 * Choosing a model when nobody has chosen one.
 *
 * Found by the sweep, not by reasoning: a fresh home on a 17 GB machine
 * selected a 13.8 GB model, which loads by evicting everything else and then
 * pages. The first turn took longer than the HTTP client was willing to wait,
 * so a working feature reported "fetch failed".
 *
 * The old rule was "largest installed". The new one is "largest that fits",
 * which is a different question and the one that was meant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { pickDefaultModel, pickExtractModel, MEMORY_SHARE } = await import('../src/core/ModelChoice.js');

const GB = 1e9;
const model = (name, gb, extra = {}) => ({ name, sizeBytes: gb * GB, ...extra });

/** What was actually installed on the machine where this went wrong. */
const REAL = [
  model('gpt-oss:20b', 13.8),
  model('gemma4:12b', 7.2),
  model('granite4.1:8b', 4.9),
  model('qwen3:4b', 2.6),
  model('llama3.2:1b', 1.3),
  model('glm-5:cloud', 0, { cloud: true }),
];

test('the biggest model that fits wins, not the biggest model', () => {
  const pick = pickDefaultModel(REAL, { totalMemoryBytes: 17 * GB });
  assert.equal(pick.name, 'gemma4:12b', '13.8 GB does not belong on a 17 GB machine');
  assert.match(pick.reason, /fits/);
});

test('a machine with room gets the big one', () => {
  const pick = pickDefaultModel(REAL, { totalMemoryBytes: 64 * GB });
  assert.equal(pick.name, 'gpt-oss:20b');
  assert.equal(pick.reason, 'largest installed', 'no need to mention memory when nothing was excluded');
});

test('a cloud model is never a local default', () => {
  // It reports no size, so a naive "fits in memory" check would rank it first.
  const pick = pickDefaultModel([model('glm-5:cloud', 0, { cloud: true }), model('tiny', 1)], {
    totalMemoryBytes: 8 * GB,
  });
  assert.equal(pick.name, 'tiny');
});

test('when nothing fits, the smallest runs rather than nothing running', () => {
  const pick = pickDefaultModel([model('huge', 40), model('large', 30)], { totalMemoryBytes: 8 * GB });
  assert.equal(pick.name, 'large', 'slow and working beats correct and unusable');
  assert.match(pick.reason, /nothing here fits/);
});

test('a runtime that does not report sizes still gets a default', () => {
  // /v1/models returns names and little else. Unknown size must not be read as
  // "too big to consider", or an OpenAI-compatible runtime would offer nothing.
  const pick = pickDefaultModel([{ name: 'mystery' }, { name: 'other' }], { totalMemoryBytes: 8 * GB });
  assert.ok(pick, 'a model with no size is still a model');
});

test('no memory figure falls back to the old behaviour rather than guessing', () => {
  assert.equal(pickDefaultModel(REAL, { totalMemoryBytes: 0 }).name, 'gpt-oss:20b');
  assert.equal(pickDefaultModel(REAL).name, 'gpt-oss:20b');
});

test('nothing installed is null, not a crash', () => {
  assert.equal(pickDefaultModel([], { totalMemoryBytes: 17 * GB }), null);
  assert.equal(pickDefaultModel([model('c', 0, { cloud: true })], { totalMemoryBytes: 17 * GB }), null);
});

test('the share leaves room for the OS and the KV cache', () => {
  // The context window is resident for the whole conversation and grows with
  // depth; on Apple Silicon the GPU draws from the same pool. Claiming all of
  // memory for weights would just move the swapping one step later.
  assert.ok(MEMORY_SHARE > 0.5 && MEMORY_SHARE < 0.8, `${MEMORY_SHARE} is not a plausible share`);
});

// --------------------------------------------------------- the memory model
//
// Extraction runs immediately after every reply, so reusing a large chat model
// makes memory as expensive as the largest model installed — and when it times
// out, nothing says so: the reply was fine, only the memory never appeared.
//
// The floor is measured, not guessed. On the extraction contract llama3.2:1b
// scored 3/7 and every case it passed was a rejection — it never extracted
// anything, while returning valid empty JSON each time.

const chat = (name, gb, params) => model(name, gb, { parameterSize: params });

test('memory goes to the smallest competent model, not the largest that fits', () => {
  const pick = pickExtractModel(
    [chat('gemma4:12b', 7.6, '11.9B'), chat('qwen3:4b', 2.6, '4.0B'), chat('cogito:8b', 4.9, '8.0B')],
    { chatModel: 'gemma4:12b', totalMemoryBytes: 17.2 * GB },
  );
  assert.equal(pick.name, 'qwen3:4b');
});

test('a model too small to extract is never chosen, however cheap', () => {
  const pick = pickExtractModel(
    [chat('gemma4:12b', 7.6, '11.9B'), chat('llama3.2:1b', 1.3, '1.2B'), chat('qwen3:4b', 2.6, '4.0B')],
    { chatModel: 'gemma4:12b', totalMemoryBytes: 17.2 * GB },
  );
  assert.equal(pick.name, 'qwen3:4b', '1B models return empty JSON rather than facts');
});

test('an already-small chat model keeps the job', () => {
  const pick = pickExtractModel([chat('qwen3:4b', 2.6, '4.0B')], {
    chatModel: 'qwen3:4b',
    totalMemoryBytes: 17.2 * GB,
  });
  assert.equal(pick, null, 'null means "use the chat model"');
});

// Requiring chat + extract to be resident together refused in exactly the case
// that needed fixing: a 9.6 GB chat model on a 17 GB machine, where the pair
// does not fit, so extraction stayed on the big model. Weights do not predict
// footprint anyway — granite4.1:8b, a 5.3 GB download, was observed at 27.3 GB
// resident. What matters is only that the extractor is cheap to load.
test('a big chat model still hands memory off, pair or no pair', () => {
  const pick = pickExtractModel([chat('gemma4:e4b', 9.6, '8.0B'), chat('qwen3:4b', 2.6, '4.0B')], {
    chatModel: 'gemma4:e4b',
    totalMemoryBytes: 17.2 * GB,
  });
  assert.equal(pick.name, 'qwen3:4b', '9.6 + 2.6 exceeds the share, and that is not the question');
});

test('an extractor too big to swap in cheaply is refused', () => {
  const pick = pickExtractModel([chat('big:70b', 40, '70B'), chat('mid:14b', 9, '14B')], {
    chatModel: 'big:70b',
    totalMemoryBytes: 17.2 * GB,
  });
  assert.equal(pick, null, 'a 9 GB "small" model buys nothing');
});

test('weights that cannot hold a conversation are not memory models', () => {
  const pick = pickExtractModel(
    [chat('gemma4:12b', 7.6, '11.9B'), model('x/flux2-klein', 5.7), model('nomic-embed-text', 2.4)],
    { chatModel: 'gemma4:12b', totalMemoryBytes: 17.2 * GB },
  );
  assert.equal(pick, null, 'an image or embedding model is not a fallback');
});

// Runtimes that report no parameter count still have to be usable, so file size
// stands in — it moves with quantisation, which is why it is the second choice.
test('file size stands in when the runtime reports no parameter count', () => {
  const pick = pickExtractModel([model('mystery:mlx', 4.0), model('tiny:mlx', 0.9)], {
    chatModel: 'other:12b',
    totalMemoryBytes: 17.2 * GB,
  });
  assert.equal(pick.name, 'mystery:mlx');
});

test('nothing installed but the chat model leaves memory where it was', () => {
  assert.equal(pickExtractModel([], { chatModel: 'gemma4:12b' }), null);
});
