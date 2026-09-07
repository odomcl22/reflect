/**
 * Word and Excel files, written from what a model can actually produce.
 *
 * Reflect could write `.md` and `.txt`, and the honest description of that was
 * "useful to me and to nobody who has to send the result to a colleague". A
 * person taking meeting notes wants a document they can attach to an email.
 *
 * The model is not asked to produce Office XML. It produces what it is good at
 * — markdown for prose, a markdown table or CSV for a grid — and this turns
 * that into a real file. Anything else would be asking a language model to
 * hand-write a schema, which it will do badly and confidently.
 *
 * These are deliberately plain documents: headings, paragraphs, lists, bold
 * and italic; a single worksheet with a bold header row. Not a layout engine.
 * Someone who needs columns and styles has Word open already.
 */

import { zip } from './Zip.js';
import { markdownToPdf } from './Pdf.js';

const xml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// ────────────────────────────────────────────────────────────────── Word

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Inline `**bold**`, `*italic*` and `` `code` `` become runs with properties. */
function runs(text) {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let at = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    const token = match[0];
    if (token.startsWith('**')) parts.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) parts.push({ text: token.slice(1, -1), mono: true });
    else parts.push({ text: token.slice(1, -1), italic: true });
    at = match.index + token.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  if (!parts.length) parts.push({ text: '' });

  return parts
    .map((p) => {
      const props =
        (p.bold ? '<w:b/>' : '') +
        (p.italic ? '<w:i/>' : '') +
        (p.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '');
      // xml:space="preserve" or Word eats the spaces between runs.
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(p.text)}</w:t></w:r>`;
    })
    .join('');
}

const para = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs(text)}</w:p>`;

/** Markdown in, Word document out. */
export function markdownToDocx(markdown) {
  const body = [];
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      body.push('<w:p/>');
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      body.push(para(heading[2], `Heading${heading[1].length}`));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      body.push(para(bullet[1], 'ListParagraph'));
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      body.push(para(numbered[1], 'ListParagraph'));
      continue;
    }
    body.push(para(line));
  }

  const document =
    `${HEAD}<w:document xmlns:w="${W}"><w:body>${body.join('')}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    '</w:body></w:document>';

  return zip([
    {
      name: '[Content_Types].xml',
      data:
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/document.xml', data: document },
  ]);
}

// ───────────────────────────────────────────────────────────────── Excel

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** `A1`, `B7`, `AA3` — the column letters Excel counts in. */
export function cellRef(col, row) {
  let name = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return `${name}${row + 1}`;
}

/** A markdown table or CSV/TSV becomes rows. Whichever the model produced. */
export function parseGrid(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  if (lines[0].includes('|')) {
    return lines
      // The |---|---| separator is presentation, not data.
      .filter((l) => !/^\|?[\s:|-]+\|[\s:|-]*$/.test(l))
      .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  }

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  return lines.map((l) => splitDelimited(l, delimiter));
}

/** Quoted fields may contain the delimiter, which a plain split would break. */
function splitDelimited(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(field.trim()); field = ''; }
    else field += ch;
  }
  out.push(field.trim());
  return out;
}

const isNumber = (v) => v !== '' && Number.isFinite(Number(v.replace(/,/g, '')));

/** Rows in, Excel workbook out. The first row is treated as a header. */
export function rowsToXlsx(rows, { sheetName = 'Sheet1' } = {}) {
  const body = rows
    .map((cells, r) => {
      const tags = cells
        .map((value, c) => {
          const ref = cellRef(c, r);
          // Numbers stored as numbers, or the spreadsheet cannot add them up —
          // which is the entire reason someone asked for a spreadsheet.
          if (isNumber(value)) return `<c r="${ref}"${r === 0 ? ' s="1"' : ''}><v>${Number(value.replace(/,/g, ''))}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${tags}</row>`;
    })
    .join('');

  const sheet = `${HEAD}<worksheet xmlns="${S}"><sheetData>${body}</sheetData></worksheet>`;

  return zip([
    {
      name: '[Content_Types].xml',
      data:
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        `${HEAD}<workbook xmlns="${S}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${xml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    {
      // One style, used for the header row: bold.
      name: 'xl/styles.xml',
      data:
        `${HEAD}<styleSheet xmlns="${S}">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
        '<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/** What to build for a given filename, or null if it is not an Office file. */
export function officeWriterFor(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  if (ext === 'docx') return (content) => markdownToDocx(content);
  if (ext === 'xlsx') return (content) => rowsToXlsx(parseGrid(content));
  if (ext === 'pdf') return (content) => markdownToPdf(content);
  return null;
}
