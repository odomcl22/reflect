/**
 * Telling the model what it can make.
 *
 * A format nobody knows about is never used, so the brief has to be in the
 * prompt. It also has to stay small: prompt evaluation on this machine runs
 * around 100 tokens per second, which makes every 100 tokens here a second of
 * silence before the first word. These tests are mostly about that trade —
 * the block is present, it is in the frozen prefix so the cache survives, it
 * can be switched off, and it cannot quietly grow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { ARTIFACTS_BRIEF, ABILITY_BUDGET, abilitiesFor } = await import('../src/context/Abilities.js');
const { build } = await import('../src/context/PromptAssembler.js');
const { plan, estimateTokens } = await import('../src/context/ContextBudget.js');
const { parseSoul, DEFAULT_SOUL } = await import('../src/modes/Soul.js');

const soul = {
  ...parseSoul(DEFAULT_SOUL),
  block: (mode) => `identity for ${mode}`,
};
const budget = plan({ contextLength: 8192 });

const systemOf = (messages) => messages.find((m) => m.role === 'system').content;

// ─────────────────────────────────────────────────────────────── the trade

test('the brief costs less than a second of first-token latency', () => {
  const cost = estimateTokens(ARTIFACTS_BRIEF);
  assert.ok(
    cost <= ABILITY_BUDGET,
    `the abilities brief is ${cost} tokens, over the ${ABILITY_BUDGET} budget — every 100 is a second of silence`
  );
});

test('it is switchable, because prose-only is a legitimate preference', () => {
  assert.equal(abilitiesFor({}), ARTIFACTS_BRIEF, 'on by default');
  assert.equal(abilitiesFor({ artifacts: true }), ARTIFACTS_BRIEF);
  assert.equal(abilitiesFor({ artifacts: false }), '');
});

// ───────────────────────────────────────────────────────── what it teaches

test('it names both formats and gives exactly one example', () => {
  assert.match(ARTIFACTS_BRIEF, /```chart/);
  assert.match(ARTIFACTS_BRIEF, /`html`/);
  assert.match(ARTIFACTS_BRIEF, /bar, line, area, pie, donut/);
  // One example. A second one is how a brief becomes a specification.
  assert.equal((ARTIFACTS_BRIEF.match(/```chart/g) || []).length, 1);
});

test('it tells the model when *not* to use them', () => {
  // Without this a small model answers every question with a chart.
  assert.match(ARTIFACTS_BRIEF, /only when asked|Ordinary answers stay prose/i);
});

test('the example parses as a real chart spec', async () => {
  // A brief that teaches a format the renderer rejects is worse than none.
  const { parseChart } = await import('../public/chart.js');
  const example = /```chart\n([\s\S]*?)\n```/.exec(ARTIFACTS_BRIEF)[1];
  const parsed = parseChart(example);
  assert.ok(parsed, 'the example in the prompt must be something we can draw');
  assert.equal(parsed.type, 'bar');
  assert.equal(parsed.data.length, 2);
});

// ───────────────────────────────────────────────────────── where it lands

test('it goes in the frozen prefix, with identity', () => {
  const { messages } = build({ soul, message: 'hello', budget, abilities: ARTIFACTS_BRIEF });
  assert.match(systemOf(messages), /Showing things/);
  assert.match(systemOf(messages), /identity for companion/);
});

test('the prefix stays byte-identical across turns', () => {
  // The whole point of the frozen prefix: anything that varies per message
  // throws away the model's KV cache and pays for the prompt again.
  const first = build({ soul, message: 'one', budget, abilities: ARTIFACTS_BRIEF });
  const second = build({
    soul,
    message: 'a completely different question',
    budget,
    abilities: ARTIFACTS_BRIEF,
    turns: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }],
  });
  assert.equal(systemOf(first.messages), systemOf(second.messages));
});

test('switched off, nothing about artifacts reaches the prompt', () => {
  const { messages } = build({ soul, message: 'hello', budget, abilities: abilitiesFor({ artifacts: false }) });
  assert.doesNotMatch(systemOf(messages), /Showing things|chart/i);
});
