/**
 * Writing a PDF, from the markdown a model is actually good at producing.
 *
 * Word and Excel were the easy ones: both are a ZIP of XML, so Zip.js did the
 * work and Office.js only had to write tags. A PDF has no such shortcut. It is
 * a binary file with a cross-reference table of byte offsets into itself, and
 * every offset has to be exact or the file will not open at all.
 *
 * So this does the whole job: lays the text out, breaks the pages, writes the
 * objects, and records where each one starts.
 *
 * Two things keep it small. It uses the base-14 fonts, which every reader has
 * and none of which need embedding — no font file, no subsetting, no licence
 * question. And it renders a deliberately narrow slice of markdown: headings,
 * paragraphs, bullets, and rules. A model asked for a report writes exactly
 * that, and everything else degrades to a paragraph rather than to an error.
 */

/** Points. A4 at 72dpi, with margins wide enough to read at. */
const PAGE = { width: 595.28, height: 841.89, margin: 56 };

/**
 * Helvetica character widths, in thousandths of an em, for the printable
 * ASCII range. Needed because the font is proportional: without real widths
 * every line either wraps early or runs off the page, and there is no way to
 * measure text in a PDF after the fact.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Bold is wider. Same range, same order. */
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * Characters a model writes that are not in WinAnsi's ASCII range.
 *
 * Left alone they render as whatever byte happens to be there, and a report
 * full of curly quotes becomes a report full of mojibake. Mapped to the plain
 * equivalents, which is what most of them were before an autocorrect.
 */
const FOLD = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '—', '…': '...', ' ': ' ',
  '•': '-', '→': '->', '×': 'x',
};

const fold = (s) => String(s).replace(/[‘’“”–—… •→×]/g, (c) => FOLD[c] ?? c);

/** Width of a string at a size, in points. */
function widthOf(text, size, bold) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // Em dash is the one non-ASCII character kept, because a report that wanted
    // one and got a hyphen reads wrong.
    total += code === 0x2014 ? 1000 : code >= 32 && code <= 126 ? table[code - 32] : 500;
  }
  return (total * size) / 1000;
}

/** Break a paragraph into lines that fit. Long words are left to overflow. */
function wrap(text, size, bold, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate, size, bold) <= maxWidth || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * `(`, `)` and `\` end or escape a PDF string, so they cannot go in raw.
 *
 * The em dash needs the same treatment for a different reason: WinAnsi puts it
 * at 0x97, which is outside latin1's printable range, so writing the character
 * itself dropped it and left a gap mid-sentence. It goes in as its octal code.
 */
const pdfString = (s) =>
  s.replace(/([\\()])/g, '\\$1').replace(/\u2014/g, '\\227');

/** One markdown line, as something with a size and a weight. */
function classify(raw) {
  const line = raw.replace(/\s+$/, '');
  if (!line.trim()) return { kind: 'blank' };
  if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) return { kind: 'rule' };

  const heading = /^(#{1,4})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    return { kind: 'heading', text: heading[2], size: [22, 17, 14, 12.5][level - 1], bold: true, above: level === 1 ? 0 : 14, below: 7 };
  }

  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { kind: 'bullet', text: bullet[1], size: 11, bold: false, indent: 16 };

  // Numbered separately from bulleted: it brings its own marker, and drawing a
  // bullet beside it gives every item two.
  const numbered = /^\s*(\d+[.)])\s+(.*)$/.exec(line);
  if (numbered) return { kind: 'numbered', text: `${numbered[1]} ${numbered[2]}`, size: 11, bold: false, indent: 16 };

  return { kind: 'para', text: line.trim(), size: 11, bold: false };
}

/** Inline markers are stripped, not rendered — one font run per line. */
const plain = (s) => fold(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\*)\*(?!\*)(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');

/**
 * Markdown in, PDF bytes out.
 *
 * @returns {Buffer}
 */
export function markdownToPdf(markdown) {
  const usable = PAGE.width - PAGE.margin * 2;
  const pages = [];
  let ops = [];
  let y = PAGE.height - PAGE.margin;

  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PAGE.height - PAGE.margin;
  };

  const put = (text, size, bold, x) => {
    // A line that will not fit starts the next page. Checked before drawing, so
    // nothing is ever written below the bottom margin.
    if (y - size < PAGE.margin) newPage();
    ops.push(
      `BT /${bold ? 'FB' : 'FR'} ${size} Tf ${x.toFixed(2)} ${(y - size).toFixed(2)} Td (${pdfString(text)}) Tj ET`
    );
    y -= size * 1.42;
  };

  for (const raw of String(markdown ?? '').split('\n')) {
    const item = classify(raw);

    if (item.kind === 'blank') {
      y -= 6;
      continue;
    }
    if (item.kind === 'rule') {
      if (y - 12 < PAGE.margin) newPage();
      y -= 6;
      ops.push(`0.75 w 0.8 G ${PAGE.margin} ${y.toFixed(2)} m ${(PAGE.width - PAGE.margin).toFixed(2)} ${y.toFixed(2)} l S 0 G`);
      y -= 12;
      continue;
    }

    if (item.above) y -= item.above;
    const indent = item.indent || 0;
    const text = plain(item.text);
    const lines = wrap(text, item.size, item.bold, usable - indent);

    lines.forEach((line, i) => {
      if (item.kind === 'bullet' && i === 0) {
        if (y - item.size < PAGE.margin) newPage();
        ops.push(`BT /FR ${item.size} Tf ${PAGE.margin} ${(y - item.size).toFixed(2)} Td (\\267) Tj ET`);
      }
      put(line, item.size, item.bold, PAGE.margin + indent);
    });
    if (item.below) y -= item.below;
  }
  pages.push(ops);

  return assemble(pages.filter((p, i) => p.length || i === 0));
}

/**
 * Objects, offsets, xref, trailer.
 *
 * Every offset in the table is the byte position of the object it names, and a
 * reader will refuse the whole file over one wrong number — which is why the
 * body is built as buffers and measured, rather than assembled as a string and
 * hoped over.
 */
function assemble(pages) {
  const chunks = [];
  const offsets = [];
  let position = 0;

  const push = (text) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    position += buf.length;
  };
  const object = (n, body) => {
    offsets[n] = position;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  // 1 catalog, 2 pages, 3 regular font, 4 bold font, then a pair per page.
  const first = 5;
  const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(' ');

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  pages.forEach((ops, i) => {
    const pageNum = first + i * 2;
    const streamNum = pageNum + 1;
    object(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width.toFixed(2)} ${PAGE.height.toFixed(2)}] ` +
        `/Resources << /Font << /FR 3 0 R /FB 4 0 R >> >> /Contents ${streamNum} 0 R >>`
    );
    const stream = ops.join('\n');
    object(streamNum, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  const count = offsets.length;
  const xref = position;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) {
    table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
