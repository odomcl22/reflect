/**
 * Third-party renderers, and the rules that make them safe to have.
 *
 * Two of them, and they are the reason this file exists rather than a
 * `<script src>` in the page:
 *
 *   1. Absent is normal. The extras are optional dependencies, so every path
 *      has to work when they are not installed — a diagram becomes a code
 *      block, not a broken card.
 *   2. Third-party renderers run in the sandbox, never in the transcript.
 *      Mermaid and KaTeX both draw untrusted text into a document and both
 *      have had advisories; inside an opaque-origin frame with no network, a
 *      bad version is an annoyance instead of a breach.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { renderMarkdown } = await import('../public/markdown.js');
const root = new URL('..', import.meta.url).pathname;
const client = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

/**
 * The client with its prose removed.
 *
 * The comments explain which directives are forbidden and why, so a test that
 * greps the whole file flags its own documentation. Strip the comments and
 * assert on the code, or the safe thing to do becomes deleting the comment.
 */
const code = client
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

const diagram = '```mermaid\ngraph TD\n  A[Ask] --> B[Recall]\n```';

// ──────────────────────────────────────────────────────── absent is normal

test('without the library, a diagram is a code block', () => {
  const html = renderMarkdown(diagram);
  assert.match(html, /class="code"/);
  assert.doesNotMatch(html, /class="artifact"/, 'never offer to open what cannot be drawn');
});

test('with it, a diagram is an artifact', () => {
  const html = renderMarkdown(diagram, { mermaid: true });
  assert.match(html, /class="artifact" data-kind="mermaid"/);
  assert.match(html, /Flowchart/, 'the first line says what kind of diagram it is');
});

test('the diagram names itself from a title directive when it has one', () => {
  const html = renderMarkdown('```mermaid\nsequenceDiagram\n  title How recall works\n  A->>B: ask\n```', {
    mermaid: true,
  });
  assert.match(html, /How recall works/);
});

test('the client asks what is installed rather than assuming', () => {
  assert.match(client, /vendor\/manifest\.json/);
  assert.match(client, /renderMarkdown\(markdown, \{ mermaid: Boolean\(extras\.mermaid\) \}\)/);
});

// ─────────────────────────────────────────────────── the sandbox rule

test('a diagram is drawn inside the sandbox, not the transcript', () => {
  const html = renderMarkdown(diagram, { mermaid: true });
  assert.doesNotMatch(html, /<script/, 'no third-party code runs where the conversation lives');
  assert.doesNotMatch(html, /<svg/, 'and it is not drawn there either');
});

test('the sandbox loads nothing at all, so the renderer is inlined', () => {
  // Measured in a browser: a frame with an opaque origin cannot fetch a
  // subresource from this server — script or module, CSP or no CSP. So the
  // library is fetched by the app and inlined, and the policy never has to
  // name an origin. Anything that reintroduces one is a regression.
  assert.match(code, /script-src 'unsafe-inline'; /, 'inline only');
  assert.match(code, /default-src 'none'/);
  assert.doesNotMatch(code, /script-src[^"]*location\.origin/, 'the sandbox must not be given an origin to load from');
  assert.doesNotMatch(code, /connect-src/, 'nothing should ever widen connect-src');
});

test('the library is fetched by the app and cached, not by the frame', () => {
  assert.match(code, /function vendorCode/);
  assert.match(code, /vendored\.set/, 'one download, however many artifacts');
});

test('mermaid runs with its own strict mode as a second layer', () => {
  assert.match(client, /securityLevel:\s*'strict'/);
});

// ─────────────────────────────────────────────────────── the update path

test('the library is pinned, optional, and vendored on install', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.optionalDependencies?.mermaid, 'optional: the app must run without it');
  assert.match(pkg.optionalDependencies.mermaid, /^\d+\.\d+\.\d+$/, 'pinned exactly, so an update is a decision');
  assert.equal(pkg.scripts.postinstall, 'node scripts/vendor.js');
  assert.ok(pkg.scripts['update:extras'], 'there has to be one command that updates them');
});

test('vendored files are generated, never committed', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /public\/vendor/, 'a copy in git is a copy nobody updates');
});

test('the manifest records what a doctor needs to judge staleness', () => {
  const manifestPath = path.join(root, 'public/vendor/manifest.json');
  if (!fs.existsSync(manifestPath)) return; // not installed here; that is allowed
  const { libraries } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const lib of libraries) {
    for (const field of ['name', 'version', 'license', 'url', 'type', 'bytes', 'sha256', 'why']) {
      assert.ok(lib[field] !== undefined, `${lib.name} is missing ${field}`);
    }
  }
});

test('doctor reports the extras and how to update them', () => {
  const doctor = fs.readFileSync(path.join(root, 'bin/reflect.js'), 'utf8');
  assert.match(doctor, /npm run update:extras/, 'telling someone it is stale without saying what to do is noise');
  assert.match(doctor, /could not reach npm/, 'offline is a normal state for this app, not a failure');
});

// ───────────────────────────────────────────────────────────── the editor

test('codemirror is optional, pinned, and shipped as an import map', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.optionalDependencies.codemirror, /^\d+\.\d+\.\d+$/);

  const manifestPath = path.join(root, 'public/vendor/manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const cm = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).libraries.find((l) => l.name === 'codemirror');
  if (!cm) return;
  assert.equal(cm.type, 'importmap');
  assert.ok(Object.keys(cm.importMap.imports).length > 10, 'the whole graph has to be mapped, not just the entry');
  assert.ok(cm.importMap.imports['@codemirror/view'], 'keymap lives here and is imported directly');
});

test('the page installs the import map before anything imports a bare name', () => {
  // An import map added after module resolution has begun is rejected by the
  // browser, so it goes in during boot, before the first dynamic import.
  assert.match(code, /type = 'importmap'/);
  assert.match(code, /document\.head\.append\(map\)/);
});

test('keymap is imported from @codemirror/view, not the meta package', () => {
  // The bug this guards: the `codemirror` package exports only EditorView,
  // basicSetup and minimalSetup. `cm.keymap` was undefined, the constructor
  // threw, and every install silently fell back to the plain textarea — which
  // looked exactly like "codemirror is not installed".
  assert.match(code, /import\('@codemirror\/view'\)/);
  assert.doesNotMatch(code, /cm\.keymap/);
});

test('no editor still means an editable pane', () => {
  assert.match(code, /if \(!extras\.codemirror\) return plain\(\)/, 'a fallback, not a setting');
  assert.match(code, /createElement\('textarea'\)/);
});

// ─────────────────────────────────────────────────────────────────── maths

test('inline and display maths become placeholders the client can draw', () => {
  const inline = renderMarkdown('The area is $A = \\pi r^2$ exactly.');
  assert.match(inline, /<span class="math" data-tex="A = \\pi r\^2">/);

  const display = renderMarkdown('$$E = mc^2$$');
  assert.match(display, /data-display="1"/);
});

test('money is not mathematics', () => {
  // The failure that would make this feature hated: "$5 and $7" typeset as an
  // equation in the middle of a sentence about money.
  const html = renderMarkdown('It costs $5 and $7 today.');
  assert.doesNotMatch(html, /class="math"/);
  assert.match(html, /\$5 and \$7/);
});

test('without KaTeX the TeX is still readable', () => {
  // The placeholder carries the expression as its text, so an install with no
  // extras shows `A = \pi r^2` rather than an empty gap.
  const html = renderMarkdown('area $A = \\pi r^2$');
  assert.match(html, />A = \\pi r\^2<\/span>/);
});

test('an expression cannot smuggle markup', () => {
  const html = renderMarkdown('$x <script>alert(1)</script>$');
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
});

test('KaTeX is rendered with trust off, which is the whole argument', () => {
  // trust:false is why maths is allowed to render in the transcript while
  // mermaid is not: KaTeX then emits a fixed grammar of spans and refuses
  // \href, \htmlClass and friends. If this flips, the exception is void.
  assert.match(code, /trust:\s*false/);
  assert.match(code, /throwOnError:\s*false/, 'one bad expression must not cost the whole reply');
});

test('KaTeX ships its stylesheet and fonts, because it is useless without them', () => {
  const manifestPath = path.join(root, 'public/vendor/manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const katex = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).libraries.find((l) => l.name === 'katex');
  if (!katex) return;
  assert.ok(fs.existsSync(path.join(root, 'public/vendor/katex/katex.min.css')));
  const fonts = fs.readdirSync(path.join(root, 'public/vendor/katex/fonts'));
  assert.ok(fonts.length >= 10, 'the glyphs are the renderer');
  assert.ok(fonts.every((f) => f.endsWith('.woff2')), 'woff2 only — the ttf and woff copies double the size for nothing');
});

// ────────────────────────────────────────────────────────────────── icons

test('the interface draws its icons rather than typing them', async () => {
  const client = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  // Strip the comment that explains the change, so naming the old glyphs there
  // does not fail the test that forbids them.
  const live = client.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  // Colour emoji render from Apple Color Emoji on this machine and from
  // something else entirely on Windows — a cross-platform bug wearing an
  // aesthetic costume.
  assert.ok(!/📎|🎙/.test(live), 'colour emoji are back in the interface');
  // Unicode geometry comes from whatever font the system picks, so weight and
  // size cannot be made to agree between one glyph and the next.
  assert.ok(!/[◈◷✦▤◐⚙☰]/.test(live), 'unicode geometry is back in the interface');

  assert.match(live, /const ICONS = \{/, 'there should be one drawn set');
  assert.match(live, /function icon\(/);
});

test('every icon shares one box and one stroke', () => {
  const client = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const set = /const ICONS = \{([\s\S]*?)\n\};/.exec(client);
  assert.ok(set, 'no icon set found');

  // Magnitude, not sign. SVG path data is full of *relative* deltas — `h-8.5`
  // means "left 8.5", which is entirely legal inside the box — so an earlier
  // version of this check flagged six perfectly good icons. What actually
  // indicates a different grid is a number larger than the box itself: no
  // coordinate and no single move can exceed 20 in a 20×20 icon.
  const numbers = [...set[1].matchAll(/[-\d.]+/g)].map(Number).filter((n) => !Number.isNaN(n));
  const offGrid = numbers.filter((n) => Math.abs(n) > 20);
  assert.deepEqual(offGrid, [], 'an icon is drawn on a different grid from the rest');

  // One weight, set once on the wrapper rather than per path.
  assert.match(client, /stroke-width="1\.6"/);
  assert.ok(!/stroke-width="(?!1\.6)/.test(set[1]), 'an icon overrode the shared stroke weight');
});

// ─────────────────────────────────────────────────────────── forms

test('the interface no longer asks the browser to collect input', () => {
  const client = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const live = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  // `prompt()` put a whole SKILL.md into a single-line input, and built a task
  // from three sequential boxes with no way back to the first. Both are the
  // kind of thing that looks acceptable in code and is indefensible on screen.
  for (const native of ['prompt(', 'confirm(', 'alert(']) {
    const hits = [...live.matchAll(new RegExp(`(?<![.\\w])${native.replace('(', '\\(')}`, 'g'))];
    // askConfirm is ours and contains the word.
    const real = hits.filter((h) => !live.slice(Math.max(0, h.index - 12), h.index).includes('askCon'));
    assert.deepEqual(real.map((h) => live.slice(h.index, h.index + 40)), [], `${native} is back`);
  }

  assert.match(live, /function openForm\(/, 'forms should be collected in one place');
});

test('a schedule is composed, not typed at a parser', () => {
  const client = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  // Schedules are stored as English so the file stays readable, but *typing*
  // English at a parser is a guessing game: you learn whether it understood
  // only after saving, and a misread silently becomes "manual".
  assert.match(client, /composeWhen\s*=/, 'the sentence is built from parts');
  assert.match(client, /name: 'preview'/, 'the composed line has to be visible before saving');
});

// ------------------------------------------------------------------- theming
//
// Three states, and the middle one is where this goes wrong silently. Choosing
// "light" on a machine set to dark has to beat the media query — a
// [data-theme="light"] rule that only lives outside it loses on specificity,
// so the setting appears to do nothing at night and works perfectly by day.
test('a chosen theme wins in both directions', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/,
    'the dark media query must exempt an explicit light choice',
  );
  assert.match(html, /:root\[data-theme="dark"\] \{/, 'and dark must be selectable on a light machine');
});

// --------------------------------------------------------------- keeping warm
//
// A bare number in keep_alive is read by Ollama as *nanoseconds*. 30 would mean
// thirty billionths of a second — indistinguishable from unloading immediately,
// and it would have made this setting look broken for anyone who touched it.
test('keep-warm minutes become a duration Ollama understands', async () => {
  const { keepWarm } = await import('../src/api/ChatController.js');
  assert.equal(keepWarm(30), '30m');
  assert.equal(keepWarm(5), '5m');
  assert.equal(keepWarm(0), '0m', 'unload straight away');
  assert.equal(keepWarm(-1), -1, 'negative is forever, and stays a number');
  assert.equal(keepWarm('nonsense'), undefined, 'no opinion beats a wrong one');
});
