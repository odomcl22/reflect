/**
 * The renderer.
 *
 * Two things are being protected here. The obvious one is that a reply with a
 * table looks like a table. The one that matters more is that this is the single
 * place in Reflect where *untrusted model output becomes HTML*, so every rule
 * about escaping and link schemes gets a test that fails loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { renderMarkdown, escapeHtml } = await import('../public/markdown.js');

const render = (md) => renderMarkdown(md);

/**
 * What the reader sees, with tags removed.
 *
 * Code blocks are syntax-highlighted now, so their contents arrive split across
 * spans. The safety assertions still look at the raw HTML — that is the point of
 * them — but assertions about *content* have to look at the text.
 */
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// ─────────────────────────────────────────────────────────────────── safety

test('the input is escaped before any rule runs', () => {
  const html = render('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script/, 'a script tag must never survive');
  assert.match(html, /&lt;script&gt;/);
});

test('html inside a code fence stays inert', () => {
  const html = render('```html\n<img src=x onerror=alert(1)>\n```');
  assert.doesNotMatch(html, /<img/, 'the tag must never reach the DOM as a tag');
  assert.match(plain(html), /<img src=x onerror=alert\(1\)>/, 'but the reader still sees the source');
});

test('a javascript: link is not a link', () => {
  const html = render('[click me](javascript:alert(1))');
  assert.doesNotMatch(html, /<a /, 'only the scheme allowlist may produce an anchor');
  assert.match(html, /click me/, 'the text is still shown, just not linked');
});

test('data: and vbscript: are refused too', () => {
  assert.doesNotMatch(render('[x](data:text/html;base64,PHN2Zz4=)'), /<a /);
  assert.doesNotMatch(render('[x](vbscript:msgbox)'), /<a /);
});

test('http and mailto links are allowed, and leave this tab alone', () => {
  const html = render('[docs](https://example.com) and [mail](mailto:a@b.c)');
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener">docs<\/a>/);
  assert.match(html, /href="mailto:a@b\.c"/);
});

test('an attribute cannot be broken out of', () => {
  const html = render('[x](https://a.com"onmouseover="alert(1))');
  assert.doesNotMatch(html, /onmouseover="alert/, 'quotes in a href must already be escaped');
});

// ───────────────────────────────────────────────────────────────── the marks

test('bold, italic, strike, and code', () => {
  assert.match(render('**bold**'), /<strong>bold<\/strong>/);
  assert.match(render('*italic*'), /<em>italic<\/em>/);
  assert.match(render('_italic_'), /<em>italic<\/em>/);
  assert.match(render('~~gone~~'), /<del>gone<\/del>/);
  assert.match(render('`x = 1`'), /<code>x = 1<\/code>/);
});

test('underscores inside a word are left alone', () => {
  // snake_case_names are not emphasis, and models write them constantly.
  assert.doesNotMatch(render('call read_memory_file now'), /<em>/);
});

test('a code span protects what is inside it', () => {
  const html = render('use `**not bold**` here');
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('a bare number is not mistaken for a code span', () => {
  // The placeholder bug this exists for: with ` 0 `-style markers, "in 3 days"
  // came back as a code span as soon as the numbering lined up.
  const html = render('`a` and `b` and gap 1 gap and in 3 days');
  assert.match(html, /gap 1 gap/);
  assert.match(html, /in 3 days/);
});

// ──────────────────────────────────────────────────────────────────── blocks

test('headings, quotes, and rules', () => {
  assert.match(render('## Title'), /<h2>Title<\/h2>/);
  assert.match(render('> quoted'), /<blockquote>[\s\S]*quoted[\s\S]*<\/blockquote>/);
  assert.match(render('---'), /<hr \/>/);
});

test('bullet and numbered lists', () => {
  const ul = render('- one\n- two');
  assert.match(ul, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  const ol = render('1. first\n2. second');
  assert.match(ol, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test('a nested list nests', () => {
  const html = render('- one\n  - deeper\n- two');
  assert.match(html, /<ul>/);
  assert.match(html, /deeper/);
  assert.ok((html.match(/<ul>/g) || []).length >= 2, 'the nested level should open its own list');
});

test('a fenced code block keeps its language and its whitespace', () => {
  const html = render('```js\nconst a = 1;\n  indented\n```');
  assert.match(html, /class="lang-js"/);
  assert.match(html, /data-lang="js"/);
  assert.match(plain(html), /const a = 1;\n {2}indented/, 'indentation is content, not decoration');
});

test('a table becomes a table, with alignment', () => {
  const html = render('| Model | tok/s |\n|---|---:|\n| gemma | 11.7 |\n| ornith | 4.5 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>Model<\/th>/);
  assert.match(html, /<th style="text-align:right">tok\/s<\/th>/);
  assert.match(html, /<td[^>]*>gemma<\/td>/);
  assert.ok((html.match(/<tr>/g) || []).length === 3, 'a header row and two body rows');
});

test('paragraph line breaks survive', () => {
  assert.match(render('one\ntwo'), /one<br \/>two/);
});

// ────────────────────────────────────────────────────────────────── streaming

test('an unterminated fence renders as an open code block', () => {
  // Half a reply is the normal case while streaming, not a broken document.
  const html = render('Here you go:\n```python\nprint("hi")');
  assert.match(html, /data-open="1"/);
  assert.match(plain(html), /print\("hi"\)/);
});

test('a half-written table does not explode', () => {
  assert.doesNotThrow(() => render('| a | b |\n|---|'));
  assert.doesNotThrow(() => render('| a | b'));
});

test('empty input is empty output', () => {
  assert.equal(render(''), '');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});

test('escapeHtml is exported and total', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

// ------------------------------------------------------------------ choices
//
// A question with its likely answers attached. The reason follow-ups feel
// expensive is that each one costs a typed reply, so an assistant that asks
// twice is one you stop asking things — offering the answers makes a question
// cost a click, which is what makes it reasonable to ask at all.

test('a choices block becomes buttons, not a code block', () => {
  const html = render(
    '```choices\n{"question":"How formal?","options":[' +
      '{"label":"Formal","note":"For the board","recommended":true},' +
      '{"label":"Plain","note":"For everyone else"}]}\n```',
  );
  assert.match(html, /class="choices"/);
  assert.equal((html.match(/data-choice=/g) || []).length, 2);
  assert.match(html, /ch-rec/, 'the recommended one is marked');
  assert.ok(!/<pre>/.test(html), 'it is not left as source');
});

// Same rule the charts follow: a spec that does not parse stays visible as
// source. A visible mistake beats an empty frame where a question should be.
test('a broken choices block falls back to code', () => {
  const html = render('```choices\n{not json at all\n```');
  assert.match(html, /<pre>/);
  assert.ok(!/class="choices"/.test(html));
});

test('one option is not a choice, and a dozen is a menu', () => {
  const one = render('```choices\n{"question":"?","options":[{"label":"Only"}]}\n```');
  assert.match(one, /<pre>/, 'a single option is not a question worth offering');

  const many = JSON.stringify({ question: '?', options: Array.from({ length: 9 }, (_, i) => ({ label: `Option ${i}` })) });
  assert.match(render('```choices\n' + many + '\n```'), /<pre>/, 'past five, typing is faster than reading');
});

// The labels are model-written and land in the DOM, and the click puts one in
// the composer — so they are escaped like everything else here.
test('a hostile label cannot inject markup', () => {
  const html = render(
    '```choices\n' +
      JSON.stringify({ question: '<img src=x onerror=alert(1)>', options: [
        { label: '<script>alert(1)</script>' }, { label: 'Fine' }] }) +
      '\n```',
  );
  assert.ok(!/<script>/.test(html));
  assert.ok(!/<img/.test(html));
  assert.match(html, /&lt;script&gt;/);
});

// Observed in real use: a model wrote a sentence, then the word `choices` on
// its own line, then the JSON — with no backticks anywhere. The renderer was
// right to treat that as prose, and the result, a paragraph of raw JSON in the
// middle of an answer, is worse than if the format had never been offered.
test('a choices block that forgot its fence still becomes buttons', () => {
  const html = render(
    'Could you clarify what topic these relate to? For example:\nchoices\n' +
      JSON.stringify({ question: 'What area?', options: [{ label: 'Business' }, { label: 'Personal' }] }),
  );
  assert.match(html, /class="choices"/);
  assert.equal((html.match(/data-choice=/g) || []).length, 2);
  assert.match(html, /Could you clarify/, 'the question before it is kept');
  assert.ok(!html.includes('"options"'), 'and no JSON is left on screen');
});

// The pattern has to be narrow enough that it cannot fire on ordinary writing.
test('the word choices in a sentence is just a word', () => {
  assert.ok(!render('I have some choices\nto make today.').includes('class="choices"'));
  assert.ok(!render('choices\nare hard').includes('class="choices"'));
  assert.ok(!render('choices\n{ not json at all').includes('class="choices"'));
});
