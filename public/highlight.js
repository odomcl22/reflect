/**
 * Syntax highlighting, for the same reason the markdown renderer is ours: this
 * runs over untrusted model output, and the usual answer is a 200KB dependency
 * that ships its own escaping rules.
 *
 * It is one pass with one regex per language family. Comments and strings are
 * matched first because they contain everything else — a `#` inside a string is
 * not a comment, and the classic bug in a highlighter this size is finding out
 * the hard way.
 *
 * Anything it does not recognise comes back escaped and unstyled, which is the
 * correct outcome for a language it has never heard of. Highlighting is a
 * convenience; being unable to read your own code is not an acceptable failure.
 *
 * Pure string in, string out. Every character of the input is escaped exactly
 * once, on its way into a span or into the plain-text remainder.
 */

import { escapeHtml } from './markdown.js';

const KEYWORDS = {
  js: 'await async break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  sh: 'alias case cd do done echo elif else esac exit export fi for function if in local read return set shift source then unset until while',
  sql: 'select from where join left right inner outer on group by order having insert into values update set delete create table drop alter add index primary key foreign references null not and or as distinct limit offset union all case when then else end',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while',
  css: 'important media supports keyframes import charset font-face',
};

const LITERALS = 'true false null undefined None True False nil NaN Infinity';

/** Which keyword set, and which comment syntax, a language name maps to. */
function dialect(lang) {
  const l = String(lang || '').toLowerCase();
  if (/^(js|jsx|javascript|ts|tsx|typescript|json5|java|c|cpp|c\+\+|cs|csharp|swift|kotlin|php|scala|dart)$/.test(l))
    return { words: KEYWORDS.js, line: '//', block: true };
  if (/^(py|python|rb|ruby)$/.test(l)) return { words: KEYWORDS.py, line: '#', block: false };
  if (/^(sh|bash|zsh|shell|console|terminal)$/.test(l)) return { words: KEYWORDS.sh, line: '#', block: false };
  if (/^(sql|postgres|mysql|sqlite)$/.test(l)) return { words: KEYWORDS.sql, line: '--', block: true };
  if (/^go(lang)?$/.test(l)) return { words: KEYWORDS.go, line: '//', block: true };
  if (/^(rs|rust)$/.test(l)) return { words: KEYWORDS.rust, line: '//', block: true };
  if (/^(css|scss|less)$/.test(l)) return { words: KEYWORDS.css, line: '//', block: true };
  if (/^(json|jsonc)$/.test(l)) return { words: '', line: '', block: false, json: true };
  if (/^(html|xml|svg|vue|svelte)$/.test(l)) return { markup: true };
  if (/^(yaml|yml|toml|ini|conf)$/.test(l)) return { words: LITERALS, line: '#', block: false };
  return null;
}

const wrap = (cls, text) => `<span class="t-${cls}">${escapeHtml(text)}</span>`;

/** Markup is a different shape: tags, attributes, and text between them. */
function highlightMarkup(code) {
  const out = [];
  const pattern = /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?>)/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(code)) !== null) {
    if (m.index > last) out.push(escapeHtml(code.slice(last, m.index)));
    if (m[1]) {
      out.push(wrap('com', m[1]));
    } else {
      const attrs = m[4].replace(/([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')?/g, (_, name, eq, value) =>
        `${wrap('attr', name)}${escapeHtml(eq)}${value ? wrap('str', value) : ''}`
      );
      out.push(`${escapeHtml(m[2])}${wrap('tag', m[3])}${attrs}${escapeHtml(m[5])}`);
    }
    last = pattern.lastIndex;
  }
  out.push(escapeHtml(code.slice(last)));
  return out.join('');
}

/**
 * Highlight one code block.
 *
 * @param {string} code  raw source, unescaped
 * @param {string} lang  the fence's language, or ''
 * @returns {string} HTML: escaped text, wrapped in spans this file wrote
 */
export function highlight(code, lang) {
  const rules = dialect(lang);
  if (!rules) return escapeHtml(code);
  if (rules.markup) return highlightMarkup(code);

  const words = new Set(`${rules.words} ${LITERALS}`.split(/\s+/).filter(Boolean));
  const parts = [
    rules.block ? '(\\/\\*[\\s\\S]*?\\*\\/)' : null,
    rules.line ? `(${rules.line.replace(/[/*-]/g, '\\$&')}[^\\n]*)` : null,
    '(`(?:\\\\.|[^`\\\\])*`|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')',
    '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b)',
    '([A-Za-z_$][\\w$]*)',
  ].filter(Boolean);

  const pattern = new RegExp(parts.join('|'), 'g');
  const commentGroups = (rules.block ? 1 : 0) + (rules.line ? 1 : 0);

  const out = [];
  let last = 0;
  let m;
  while ((m = pattern.exec(code)) !== null) {
    if (m.index > last) out.push(escapeHtml(code.slice(last, m.index)));
    const text = m[0];

    // Groups are positional: comments, then strings, then numbers, then words.
    const isComment = commentGroups > 0 && (m[1] !== undefined || (commentGroups > 1 && m[2] !== undefined));
    const stringIndex = commentGroups + 1;

    if (isComment) out.push(wrap('com', text));
    else if (m[stringIndex] !== undefined) out.push(wrap('str', text));
    else if (m[stringIndex + 1] !== undefined) out.push(wrap('num', text));
    else if (words.has(text)) out.push(wrap('kw', text));
    else if (rules.json) {
      // In JSON the only words are literals; everything else is a bare value.
      out.push(escapeHtml(text));
    } else if (code[pattern.lastIndex] === '(') out.push(wrap('fn', text));
    else out.push(escapeHtml(text));

    last = pattern.lastIndex;
  }
  out.push(escapeHtml(code.slice(last)));
  return out.join('');
}

/** Does this language get colours at all? The UI uses it to label honestly. */
export const isHighlightable = (lang) => Boolean(dialect(lang));
