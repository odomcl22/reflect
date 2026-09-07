/**
 * Browsing Hugging Face for a model.
 *
 * The searching is a thin wrapper over a public API and hard to get wrong. What
 * is easy to get wrong — and was, twice, in the first version — is deciding
 * which of the `.gguf` files in a repository is a model you can actually run.
 * A repository holds vision projectors, draft heads, and multi-part sets
 * alongside the weights, and offering one of those as "the model" produces a
 * download that succeeds and then is not the thing.
 *
 * Sizes are the other half. A list of quantisations without them is a list of
 * names; with them, and with a judgement about what fits, it is a choice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { quantOf, shardOf, pullName, listQuants } = await import('../src/runtimes/Catalogue.js');
const { MEMORY_SHARE } = await import('../src/core/ModelChoice.js');

test('a quantisation is read off the filename', () => {
  assert.equal(quantOf('gemma-3-4b-it-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOf('model-IQ2_XXS.gguf'), 'IQ2_XXS');
  assert.equal(quantOf('model-BF16.gguf'), 'BF16');
  assert.equal(quantOf('something-else.gguf'), null);
});

test('a multi-part model is one choice, not five', () => {
  // Offering `-00001-of-00004` on its own downloads a quarter of a model and
  // reports success.
  assert.ok(shardOf('gemma-4-31B-it-BF16-00001-of-00002.gguf'));
  assert.equal(shardOf('gemma-3-4b-it-Q4_K_M.gguf'), null);
});

test('what gets downloaded is the name the existing pull already takes', () => {
  // Not a second way of naming a model — `repo:QUANT` is what llama.cpp's -hf
  // flag speaks and what /api/models/pull already expects.
  assert.equal(pullName('ggml-org/gemma-3-4b-it-GGUF', 'Q4_K_M'), 'ggml-org/gemma-3-4b-it-GGUF:Q4_K_M');
});

/** Stand in for Hugging Face with the file list that actually broke this. */
function hf(files) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ siblings: files.map(([rfilename, size]) => ({ rfilename, size })) }),
  });
  return () => (globalThis.fetch = original);
}

test('a draft head is not offered as the model', async () => {
  // Verbatim from unsloth/gemma-4-31B-it-GGUF. `mtp-` files are Multi-Token
  // Prediction draft heads for speculative decoding: half a gigabyte, parsing
  // cleanly as "Q8_0", sitting beside a real Q8_0 of 32 GB. The first version
  // offered the small one — a 31B model with a 0.5 GB Q8_0, which would have
  // downloaded happily and not been the model.
  const restore = hf([
    ['MTP/mtp-gemma-4-31B-it-Q8_0.gguf', 0.51e9],
    ['mtp-gemma-4-31B-it.gguf', 0.51e9],
    ['mmproj-F16.gguf', 1.2e9],
    ['gemma-4-31B-it-Q8_0.gguf', 32.64e9],
  ]);
  try {
    const quants = await listQuants('unsloth/gemma-4-31B-it-GGUF');
    assert.deepEqual(quants.map((q) => q.quant), ['Q8_0']);
    assert.ok(quants[0].bytes > 30e9, 'the real weights, not the draft head');
    assert.ok(!quants.some((q) => /mtp|mmproj/i.test(q.file)));
  } finally {
    restore();
  }
});

test('a sharded set keeps its quantisation instead of becoming "unknown"', async () => {
  // The quant sits before the shard suffix, not before `.gguf`, so reading it
  // the obvious way labels a 61 GB BF16 set "unknown" — the one label nobody
  // can choose by.
  const restore = hf([
    ['BF16/gemma-4-31B-it-BF16-00001-of-00002.gguf', 30e9],
    ['BF16/gemma-4-31B-it-BF16-00002-of-00002.gguf', 31.4e9],
  ]);
  try {
    const [only] = await listQuants('unsloth/gemma-4-31B-it-GGUF');
    assert.equal(only.quant, 'BF16');
    assert.equal(only.parts, 2);
    assert.ok(only.bytes > 60e9, 'the size is the whole set, not one shard');
  } finally {
    restore();
  }
});

test('what fits is judged by the same rule the default model uses', async () => {
  // Two opinions about what "fits" would eventually disagree, and the one the
  // user sees here has to match the one that picked their model.
  const restore = hf([
    ['m-Q4_K_M.gguf', 4e9],
    ['m-Q8_0.gguf', 40e9],
  ]);
  try {
    const quants = await listQuants('a/b', { totalMemoryBytes: 16e9 });
    const budget = 16e9 * MEMORY_SHARE;
    assert.equal(quants.find((q) => q.quant === 'Q4_K_M').fits, 4e9 <= budget);
    assert.equal(quants.find((q) => q.quant === 'Q8_0').fits, false);

    // With no memory figure there is nothing to judge, and guessing would be
    // worse than saying nothing.
    const blind = await listQuants('a/b');
    assert.equal(blind[0].fits, null);
  } finally {
    restore();
  }
});
