/**
 * Markdown, rendered locally.
 *
 * Replies used to be drawn with `textContent`, so a model that answered with a
 * table produced a wall of pipes and a model that answered with code produced
 * unindented prose. This turns that into what the model meant.
 *
 * Why hand-written rather than a library: Reflect ships with two dependencies
 * and no build step, and the alternative here is three more (a parser, a
 * sanitizer, a highlighter) loaded into the one place in the app that renders
 * *untrusted model output* as HTML. A small renderer that escapes everything
 * first and can only emit tags from a fixed list is easier to be sure about than
 * a large one plus a sanitizer to undo it.
 *
 * The safety rule, and the only one that matters: the input is escaped before a
 * single rule runs, so nothing in the source can become a tag. Every tag in the
 * output is one this file wrote. Link targets are checked against a scheme
 * allowlist, because `[click](javascript:...)` is the obvious way through.
 *
 * It is also written to be streamed into: an unterminated fence renders as an
 * open code block rather than as garbage, so a code answer looks like code from
 * the first line rather than snapping into place at the end.
 *
 * Pure string in, string out — no DOM — so it runs in the tests too.
 */

import { highlight } from './highlight.js';
import { chartFromSource } from './chart.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Anything not on this list is not a link. `javascript:` is why. */
const SAFE_HREF = /^(https?:\/\/|mailto:|#|\/)/i;

/** Language labels we are willing to echo back into a class name. */
const LANG = /^[a-z0-9+#.-]{1,20}$/i;

// ─────────────────────────────────────────────────────────────────── inline

/**
 * Inline rules, applied to already-escaped text.
 *
 * Code spans are lifted out first so that `**` inside `` `code` `` stays
 * literal — the usual bug in a renderer this size.
 */
// Private-use sentinels, not something like " 0 ": a placeholder made of ordinary
// characters gets confused with ordinary text, and "in 3 days" comes back as a
// code span the moment the numbering lines up.
const SENTINEL_A = String.fromCharCode(0xe000);
const SENTINEL_B = String.fromCharCode(0xe001);
const RESTORE = new RegExp(SENTINEL_A + '(\\d+)' + SENTINEL_B, 'g');

function inline(text) {
  const spans = [];
  // Private-use sentinels rather than something like ` 0 `: a placeholder made of
  // ordinary characters gets confused with ordinary text, and "in 3 days" comes
  // back as a code span.
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(`<code>${code}</code>`);
    return SENTINEL_A + (spans.length - 1) + SENTINEL_B;
  });

  // Math, before the emphasis rules: a^2 and x_i are TeX, not italics, and
  // \\frac{a}{b} should not lose its braces to something else first. The client
  // draws these if KaTeX is installed; if it is not, the TeX stays readable,
  // which is what a mathematician would want anyway.
  out = out
    .replace(/\$\$([^$\n]+?)\$\$/g, (_, tex) => `<span class="math" data-display="1" data-tex="${tex}">${tex}</span>`)
    .replace(/(^|[^$\\])\$([^$\n]+?)\$(?!\d)/g, (_, before2, tex) =>
      `${before2}<span class="math" data-tex="${tex}">${tex}</span>`
    );

  out = out
    // [label](target)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
      SAFE_HREF.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>` : whole
    )
    // Bare URLs, which models write far more often than markdown links.
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g,
      (_, before, url) => `${before}<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`)
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return out.replace(RESTORE, (_, i) => spans[Number(i)]);
}

// ──────────────────────────────────────────────────────────────────── blocks

const isFence = (line) => /^\s{0,3}(```|~~~)/.test(line);
const isHr = (line) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
const isHeading = (line) => /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
const isQuote = (line) => /^\s{0,3}>\s?(.*)$/.exec(line);
const isBullet = (line) => /^(\s*)([-*+])\s+(.*)$/.exec(line);
const isNumber = (line) => /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line.trim()) || /^[^|\n]*\|/.test(line.trim());
const isTableRule = (line) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes('-');

const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** `:---`, `---:`, `:---:` → left, right, center. */
function alignments(rule) {
  return cells(rule).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return right && left ? 'center' : right ? 'right' : left ? 'left' : '';
  });
}

/**
 * Turn markdown into HTML.
 *
 * @param {string} src  markdown, possibly cut off mid-stream
 * @returns {string} HTML built entirely from tags this file wrote
 */
export function renderMarkdown(src, options = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. Unterminated is normal while streaming, not an error.
    if (isFence(line)) {
      const marker = line.trim().slice(0, 3);
      const rawLang = line.trim().slice(3).trim().split(/\s+/)[0] || '';
      const lang = LANG.test(rawLang) ? rawLang.toLowerCase() : '';
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      const closed = i < lines.length;
      if (closed) i++;
      const source = body.join('\n');

      // Some blocks are not code, they are a thing the model made. Those become
      // a card here and open in the artifact pane, rather than being flattened
      // into the transcript as text. Only once the fence has closed: half a
      // chart spec is not a chart, and half an HTML document is not a page.
      const artifact = closed ? artifactFor(lang, source, options) : null;
      if (artifact) {
        html.push(artifact);
        continue;
      }

      // A question with its likely answers attached. Not an artifact — there is
      // nothing to open, and the whole point is that it is answerable where it
      // stands.
      if (closed && lang === 'choices') {
        const asked = choicesFor(source);
        if (asked) {
          html.push(asked);
          continue;
        }
      }

      html.push(
        `<div class="code"${lang ? ` data-lang="${lang}"` : ''}${closed ? '' : ' data-open="1"'}>` +
          `<pre><code${lang ? ` class="lang-${lang}"` : ''}>${highlight(source, lang)}</code></pre></div>`
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (isHr(line)) {
      html.push('<hr />');
      i++;
      continue;
    }

    const heading = isHeading(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // Tables: a header row, a rule, then rows until something else.
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]) && isTableRow(line)) {
      const header = cells(line);
      const align = alignments(lines[i + 1]);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(cells(lines[i++]));

      const th = header
        .map((c, n) => `<th${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(escapeHtml(c))}</th>`)
        .join('');
      const rows = body
        .map(
          (row) =>
            `<tr>${row
              .map((c, n) => `<td${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(escapeHtml(c))}</td>`)
              .join('')}</tr>`
        )
        .join('');
      html.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`);
      continue;
    }

    if (isQuote(line)) {
      const body = [];
      while (i < lines.length && isQuote(lines[i])) body.push(isQuote(lines[i++])[1]);
      html.push(`<blockquote>${renderMarkdown(body.join('\n'), options)}</blockquote>`);
      continue;
    }

    if (isBullet(line) || isNumber(line)) {
      html.push(list(lines, i));
      i = listEnd(lines, i);
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !isHr(lines[i]) &&
      !isHeading(lines[i]) &&
      !isQuote(lines[i]) &&
      !isBullet(lines[i]) &&
      !isNumber(lines[i])
    ) {
      para.push(lines[i++]);
    }
    // A single newline inside a paragraph is a line break: models mean it.
    // A model that wrote a choices block and forgot its fence lands here as an
    // ordinary paragraph. Rendered as buttons rather than as raw JSON.
    const loose = looseChoices(para.join('\n'));
    if (loose) {
      html.push(loose);
      continue;
    }

    html.push(`<p>${inline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br />')}</p>`);
  }

  return html.join('\n');
}


/**
 * A question the reader can answer with one tap.
 *
 * The reason follow-up questions feel expensive is that each one costs a typed
 * reply, so an assistant that asks twice is an assistant you stop asking
 * things. Offering the likely answers makes a question cost a click, which is
 * what makes it reasonable for Reflect to ask at all.
 *
 * Rendered inline rather than as a card. There is nothing to open, and a
 * question you have to click through to is a question you ignore.
 *
 *     ```choices
 *     {"question": "How should I write it?",
 *      "options": [{"label": "Formal", "note": "For the board", "recommended": true},
 *                  {"label": "Plain", "note": "For everyone else"}]}
 *     ```
 *
 * A spec that does not parse falls through to a code block, the same way a
 * broken chart does: a visible mistake beats an empty frame.
 */
function choicesFor(source) {
  let spec;
  try {
    spec = JSON.parse(source);
  } catch {
    return null;
  }
  return choicesFrom(spec);
}

/**
 * The same block, written without its fence.
 *
 * Observed in real use: a model wrote the word `choices` on one line and the
 * JSON on the next, with no backticks anywhere. The renderer was right to treat
 * that as prose, and the result — a paragraph of raw JSON in the middle of an
 * answer — is worse than if the format had never been offered.
 *
 * Being tolerant costs almost nothing. The pattern is narrow enough that it
 * cannot fire on ordinary text: the line has to be exactly "choices", what
 * follows has to parse as JSON, and that JSON has to have the right shape.
 */
export function looseChoices(text) {
  // Anywhere in the paragraph, not only at its start: what a model actually
  // wrote was a sentence, then `choices`, then the JSON, all in one block.
  // Whatever came before is kept as prose, because it is usually the question.
  const match = /(^|\n)[ \t]*choices[ \t]*\n([ \t]*\{[\s\S]+\})[ \t]*$/i.exec(String(text));
  if (!match) return null;
  let spec;
  try {
    spec = JSON.parse(match[2].trim());
  } catch {
    return null;
  }
  const rendered = choicesFrom(spec);
  if (!rendered) return null;

  const before = String(text).slice(0, match.index).trim();
  return before ? `<p>${inline(escapeHtml(before)).replace(/\n/g, '<br />')}</p>${rendered}` : rendered;
}

function choicesFrom(spec) {

  const options = Array.isArray(spec?.options) ? spec.options.filter((o) => o && o.label) : [];
  // One option is not a choice, and past about five this is a menu rather than
  // a question — at which point typing the answer is faster than reading them.
  if (options.length < 2 || options.length > 5) return null;

  const question = String(spec.question || '').trim();

  return (
    '<div class="choices">' +
      (question ? `<p class="ch-q">${escapeHtml(question)}</p>` : '') +
      options
        .map(
          (o) =>
            `<button type="button" class="ch-opt${o.recommended ? ' rec' : ''}" data-choice="${escapeHtml(String(o.label))}">` +
              `<span class="ch-label">${escapeHtml(String(o.label))}` +
              (o.recommended ? '<span class="ch-rec">recommended</span>' : '') +
              '</span>' +
              (o.note ? `<span class="ch-note">${escapeHtml(String(o.note))}</span>` : '') +
            '</button>'
        )
        .join('') +
      '<p class="ch-foot">or just tell me</p>' +
    '</div>'
  );
}

/**
 * Turn a fenced block into an artifact card, or return null to leave it as code.
 *
 * The card carries its own source in a hidden <pre>, which is how the pane gets
 * the original text back without the renderer having to keep state. Escaped on
 * the way in like everything else; the browser hands it back verbatim through
 * textContent.
 */
function artifactFor(lang, source, options = {}) {
  if (!source.trim()) return null;

  if (lang === 'mermaid') {
    // Only when the renderer is actually installed. Offering to open a diagram
    // that cannot be drawn is worse than showing the source, which at least
    // says what was meant.
    if (!options.mermaid) return null;
    return card('mermaid', diagramName(source), '', source);
  }

  if (lang === 'chart') {
    const chart = chartFromSource(source);
    // A spec that does not parse is a code block. Better a visible mistake than
    // an empty frame where a picture should be.
    if (!chart) return null;
    const name = chart.spec.title || `${chart.spec.type} chart`;
    return card('chart', name, chart.svg, source);
  }

  if (lang === 'html' || lang === 'svg') {
    const name = titleOf(source) || (lang === 'svg' ? 'Drawing' : 'Page');
    // No preview here: an HTML artifact only runs inside the sandbox, and the
    // transcript is not the sandbox.
    return card(lang, name, '', source);
  }

  return null;
}

const KIND_NAMES = { chart: 'Chart', html: 'Page', svg: 'Drawing', mermaid: 'Diagram' };

/** Mermaid's first line declares the kind; a title directive beats it. */
function diagramName(source) {
  const titled = /^\s*title\s+(.{1,60})$/m.exec(source);
  if (titled) return titled[1].trim();
  const kind = /^\s*(\w[\w-]*)/.exec(source.trim());
  const names = {
    graph: 'Flowchart', flowchart: 'Flowchart', sequenceDiagram: 'Sequence',
    classDiagram: 'Classes', stateDiagram: 'States', 'stateDiagram-v2': 'States',
    erDiagram: 'Entities', gantt: 'Gantt', pie: 'Pie', journey: 'Journey',
    mindmap: 'Mindmap', timeline: 'Timeline', gitGraph: 'Git graph',
  };
  return (kind && names[kind[1]]) || 'Diagram';
}

function card(kind, name, preview, source) {
  return (
    `<div class="artifact" data-kind="${kind}">` +
      (preview ? `<div class="art-preview">${preview}</div>` : '') +
      `<div class="art-bar">` +
        `<span class="art-kind">${escapeHtml(KIND_NAMES[kind] || kind)}</span>` +
        `<span class="art-name">${escapeHtml(name)}</span>` +
        `<button type="button" data-do="open">Open</button>` +
      `</div>` +
      `<pre class="art-src" hidden>${escapeHtml(source)}</pre>` +
    `</div>`
  );
}

/** A name for the card: the document's own title, or its first heading. */
function titleOf(source) {
  const title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(source);
  if (title) return title[1].trim();
  const heading = /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(source);
  if (heading) return heading[1].trim();
  return '';
}

/** How far the list starting at `start` runs. */
function listEnd(lines, start) {
  let i = start;
  while (i < lines.length && (isBullet(lines[i]) || isNumber(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i])))) i++;
  return i;
}

/**
 * One list, with nesting by indentation.
 *
 * Kept deliberately simple: indentation decides depth, and a deeper item opens a
 * nested list of its own kind. Anything more elaborate belongs to a real parser.
 */
function list(lines, start) {
  const end = listEnd(lines, start);
  const items = [];

  for (let i = start; i < end; i++) {
    const bullet = isBullet(lines[i]);
    const numbered = !bullet && isNumber(lines[i]);
    if (!bullet && !numbered) {
      // A continuation line belongs to the item above it.
      if (items.length) items[items.length - 1].text += `\n${lines[i].trim()}`;
      continue;
    }
    const match = bullet || numbered;
    items.push({ depth: Math.floor(match[1].length / 2), ordered: Boolean(numbered), text: match[3] });
  }

  const render = (from, depth) => {
    const out = [];
    let i = from;
    const ordered = items[from]?.ordered;
    while (i < items.length && items[i].depth >= depth) {
      if (items[i].depth > depth) {
        const nested = render(i, items[i].depth);
        out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, `${nested.html}</li>`);
        i = nested.next;
        continue;
      }
      out.push(`<li>${inline(escapeHtml(items[i].text))}</li>`);
      i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}>${out.join('')}</${tag}>`, next: i };
  };

  return items.length ? render(0, items[0].depth).html : '';
}
