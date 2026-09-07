/**
 * Syntax highlighting.
 *
 * The tests that matter are not "does `const` turn blue". They are: does every
 * character survive exactly once, does escaping still happen on the way into a
 * span, and does a `#` inside a string stay a string. A highlighter that eats a
 * character or lets one through unescaped is worse than no highlighter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { highlight, isHighlightable } = await import('../public/highlight.js');
const { renderMarkdown } = await import('../public/markdown.js');

/** What the user actually sees, with the markup taken back off. */
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// ───────────────────────────────────────────────────────────── faithfulness

test('every character comes back, exactly once', () => {
  const samples = [
    ['js', 'const a = 1; // note\nfunction go(x) { return `t${x}`; }'],
    ['python', 'def go(x):\n    # note\n    return "s" if x else None'],
    ['bash', 'echo "hi" # note\nfor f in *.md; do cat $f; done'],
    ['sql', 'SELECT id, name FROM users WHERE id = 3 -- note'],
    ['json', '{"a": 1, "b": [true, null], "c": "x"}'],
    ['html', '<div class="x">text</div><!-- note -->'],
    ['nonsense-lang', 'whatever ((( this is'],
  ];
  for (const [lang, code] of samples) {
    assert.equal(plain(highlight(code, lang)), code, `${lang} lost or gained characters`);
  }
});

test('escaping still happens inside and outside spans', () => {
  const html = highlight('const a = "<script>alert(1)</script>";', 'js');
  assert.doesNotMatch(html, /<script/, 'a tag must not survive highlighting');
  assert.match(html, /&lt;script&gt;/);
});

test('markup highlighting does not let a tag through', () => {
  const html = highlight('<img src=x onerror=alert(1)>', 'html');
  assert.doesNotMatch(html, /<img/);
  assert.match(plain(html), /<img src=x onerror=alert\(1\)>/);
});

// ─────────────────────────────────────────────────────────────────── tokens

test('comments and strings win over what is inside them', () => {
  // The classic bug: a # inside a string read as a comment.
  const sh = highlight('echo "value # not a comment"', 'bash');
  assert.doesNotMatch(sh, /t-com/, 'a hash inside a string is not a comment');

  const js = highlight('// const is not a keyword here', 'js');
  assert.match(js, /t-com/);
  assert.doesNotMatch(js, /t-kw/, 'nothing inside a comment gets its own colour');
});

test('keywords, numbers, strings, and call names each get a class', () => {
  const html = highlight('const n = 42; run("x");', 'js');
  assert.match(html, /<span class="t-kw">const<\/span>/);
  assert.match(html, /<span class="t-num">42<\/span>/);
  assert.match(html, /<span class="t-str">&quot;x&quot;<\/span>/);
  assert.match(html, /<span class="t-fn">run<\/span>/);
});

test('python and shell use their own comment marker', () => {
  assert.match(highlight('x = 1  # note', 'python'), /<span class="t-com"># note<\/span>/);
  assert.doesNotMatch(highlight('x = 1  // not a comment', 'python'), /t-com/);
});

test('html attributes and tag names are distinguished', () => {
  const html = highlight('<a href="https://x.com">go</a>', 'html');
  assert.match(html, /<span class="t-tag">a<\/span>/);
  assert.match(html, /<span class="t-attr">href<\/span>/);
  assert.match(html, /<span class="t-str">&quot;https:\/\/x\.com&quot;<\/span>/);
});

test('an unknown language is escaped and left alone', () => {
  const html = highlight('!!! whatever <b>', 'brainfuck');
  assert.doesNotMatch(html, /<span/);
  assert.match(html, /&lt;b&gt;/);
  assert.equal(isHighlightable('brainfuck'), false);
  assert.equal(isHighlightable('js'), true);
});

test('empty code does not throw', () => {
  assert.equal(highlight('', 'js'), '');
  assert.equal(highlight('   ', 'js'), '   ');
});

// ───────────────────────────────────────────────────────── through the fence

test('the renderer highlights fenced code and nothing else', () => {
  const html = renderMarkdown('text `const` here\n\n```js\nconst a = 1;\n```');
  // The inline code span is not a code block and gets no colours.
  assert.match(html, /<code>const<\/code>/);
  assert.match(html, /<span class="t-kw">const<\/span>/);
});

test('a fence with no language is still safe and unstyled', () => {
  const html = renderMarkdown('```\n<script>x</script>\n```');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<span class="t-/);
});
