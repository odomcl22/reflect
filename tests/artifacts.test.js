/**
 * Charts and artifacts.
 *
 * Two halves. The chart renderer is ordinary code with ordinary tests: does a
 * spec become a picture, does a bad spec become nothing, does a label from a
 * model get escaped on its way into an SVG.
 *
 * The second half is the contract the artifact pane depends on: a block that is
 * a *thing* becomes a card carrying its own source, and a block that is merely
 * code stays code. The pane reads that card. If the shape here changes without
 * the pane changing, these fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { parseChart, renderChart, chartFromSource } = await import('../public/chart.js');
const { renderMarkdown } = await import('../public/markdown.js');

const spec = (extra = {}) =>
  JSON.stringify({
    type: 'bar',
    title: 'Tokens per second',
    data: [
      { label: 'gemma', value: 11.7 },
      { label: 'ornith', value: 4.5 },
    ],
    ...extra,
  });

// ────────────────────────────────────────────────────────────── the spec

test('a spec becomes numbers and labels', () => {
  const parsed = parseChart(spec());
  assert.equal(parsed.type, 'bar');
  assert.equal(parsed.title, 'Tokens per second');
  assert.deepEqual(parsed.data, [
    { label: 'gemma', value: 11.7 },
    { label: 'ornith', value: 4.5 },
  ]);
});

test('the shapes a model actually writes are accepted', () => {
  // Models reach for name/y/count as often as label/value, and sometimes just
  // hand over an array of numbers.
  assert.equal(parseChart('{"data":[{"name":"a","y":2}]}').data[0].label, 'a');
  assert.equal(parseChart('{"data":[{"name":"a","y":2}]}').data[0].value, 2);
  assert.equal(parseChart('{"data":[5,6]}').data[1].value, 6);
  assert.equal(parseChart('{"data":[{"label":"a","value":"nonsense"}]}').data[0].value, 0);
});

test('an unknown type falls back to bars rather than to nothing', () => {
  assert.equal(parseChart('{"type":"sunburst","data":[{"label":"a","value":1}]}').type, 'bar');
});

test('what is not a chart is not a chart', () => {
  assert.equal(parseChart('not json at all'), null);
  assert.equal(parseChart('{"type":"bar"}'), null, 'no data is not a chart');
  assert.equal(parseChart('{"type":"bar","data":[]}'), null);
  assert.equal(parseChart('[1,2,3]'), null, 'a bare array is ambiguous; refuse it');
  assert.equal(parseChart('{"type":"bar","data":[{"label":"a","value":1}'), null, 'half-streamed');
});

// ───────────────────────────────────────────────────────────── the picture

test('every type draws something', () => {
  for (const type of ['bar', 'line', 'area', 'pie', 'donut']) {
    const svg = renderChart(parseChart(spec({ type })));
    assert.match(svg, /^<svg /, `${type} produced no svg`);
    assert.match(svg, /<\/svg>$/);
    assert.ok(svg.length > 200, `${type} produced a suspiciously empty svg`);
  }
});

test('the numbers reach the picture', () => {
  const svg = renderChart(parseChart(spec()));
  assert.match(svg, /11\.7/);
  assert.match(svg, /gemma/);
  assert.match(svg, /<title>gemma: 11\.7<\/title>/, 'hovering a bar should say what it is');
});

test('a label from a model cannot become markup', () => {
  const evil = JSON.stringify({
    type: 'bar',
    title: '<script>alert(1)</script>',
    data: [{ label: '"><script>alert(2)</script>', value: 1 }],
  });
  const svg = renderChart(parseChart(evil));
  assert.doesNotMatch(svg, /<script/, 'an SVG is a document too');
  assert.match(svg, /&lt;script&gt;/);
});

test('one slice covering everything still draws', () => {
  // The arc degenerates when start and end are the same point, which is how a
  // pie chart of a single value renders as an empty box.
  const svg = renderChart(parseChart('{"type":"pie","data":[{"label":"all","value":9}]}'));
  assert.match(svg, /<circle/, 'a single slice is a circle, not an arc');
});

test('a zero total does not divide by nothing', () => {
  assert.doesNotThrow(() => renderChart(parseChart('{"type":"pie","data":[{"label":"a","value":0}]}')));
  assert.doesNotThrow(() => renderChart(parseChart('{"type":"bar","data":[{"label":"a","value":0}]}')));
});

test('chartFromSource is the one call the renderer needs', () => {
  assert.equal(chartFromSource('nope'), null);
  const made = chartFromSource(spec());
  assert.match(made.svg, /^<svg /);
  assert.equal(made.spec.title, 'Tokens per second');
});

// ─────────────────────────────────────────────────── the card the pane reads

test('a chart block becomes a card, not a wall of json', () => {
  const html = renderMarkdown('```chart\n' + spec() + '\n```');
  assert.match(html, /class="artifact" data-kind="chart"/);
  assert.match(html, /data-do="open"/);
  assert.match(html, /<svg /, 'the card previews the chart');
  assert.doesNotMatch(html, /class="code"/, 'a chart is not a code block');
});

test('the card carries its own source for the pane to read back', () => {
  const html = renderMarkdown('```chart\n' + spec() + '\n```');
  const src = /<pre class="art-src" hidden>([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(src, 'the pane has no other way to get the original text');
  // Escaped in the HTML; the browser hands it back verbatim via textContent.
  assert.match(src[1], /&quot;type&quot;/);
  assert.doesNotMatch(src[1], /<script/);
});

test('an html block becomes a card and never renders inline', () => {
  const html = renderMarkdown('```html\n<title>Sales</title><script>alert(1)</script>\n```');
  assert.match(html, /class="artifact" data-kind="html"/);
  assert.match(html, /Sales/, 'the document names itself');
  assert.doesNotMatch(html, /<script>alert/, 'nothing from the artifact runs in the transcript');
});

test('a chart spec that does not parse stays visible as code', () => {
  const html = renderMarkdown('```chart\n{"type":"bar", oops\n```');
  assert.match(html, /class="code"/, 'a broken spec should be readable, not an empty frame');
  assert.doesNotMatch(html, /class="artifact"/);
});

test('an unclosed block is never an artifact', () => {
  // Mid-stream, half a spec would otherwise flicker a broken chart into view.
  const html = renderMarkdown('```chart\n{"type":"bar","data":[{"label":"a","value":1}]}');
  assert.doesNotMatch(html, /class="artifact"/);
  assert.match(html, /data-open="1"/);
});

test('ordinary code is still ordinary code', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.match(html, /class="code"/);
  assert.doesNotMatch(html, /class="artifact"/);
});

// ──────────────────────────────────────────────────────────── the sandbox

test('the pane runs artifacts with scripts but no same-origin', () => {
  // The single most important line in the client: `allow-scripts` together with
  // `allow-same-origin` would let a model-written page read Reflect's API and
  // walk out with the memory files. This asserts on the source because the rule
  // is a property of the code, not of a particular run.
  const client = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // Read the *values* rather than grepping the file: the phrase appears in the
  // comments that explain why it is forbidden, and a test that cannot tell a
  // warning from a vulnerability is a test nobody will trust.
  const set = [...client.matchAll(/setAttribute\('sandbox',\s*'([^']*)'\)/g)].map((m) => m[1]);
  const attrs = [...client.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);

  assert.ok(set.length >= 1, 'the pane must set a sandbox at all');
  for (const value of [...set, ...attrs]) {
    assert.match(value, /allow-scripts/, 'an artifact that cannot run is not interactive');
    assert.doesNotMatch(value, /allow-same-origin/, 'never, in any combination');
    assert.doesNotMatch(value, /allow-top-navigation|allow-popups|allow-forms/, 'nothing that reaches outward');
  }
});

test('the sandboxed document forbids the network', () => {
  const client = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(client, /default-src 'none'/, 'an artifact must not be able to phone home');
  assert.match(client, /Content-Security-Policy/);
});
