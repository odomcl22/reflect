/**
 * Word and Excel.
 *
 * Reflect could write `.md` and `.txt`, and the honest description of that was
 * "useful to me, and to nobody who has to send the result to a colleague". The
 * person this product is for takes meeting notes and needs to attach them to
 * an email.
 *
 * Both formats are ZIP archives of XML, and Node already has both halves of a
 * ZIP, so the whole thing is header formats rather than an algorithm. What
 * these tests defend is the part that would silently rot: an archive Word
 * refuses to open looks identical from here to one it accepts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const { zip } = await import('../src/documents/Zip.js');
const { markdownToDocx, rowsToXlsx, parseGrid, cellRef, officeWriterFor } =
  await import('../src/documents/Office.js');

/** Read an archive back without a library, so the test does not share a bug. */
function unzip(buffer) {
  const files = {};
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const method = buffer.readUInt16LE(at + 8);
    const compressed = buffer.readUInt32LE(at + 18);
    const nameLen = buffer.readUInt16LE(at + 26);
    const extraLen = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    const body = buffer.subarray(start, start + compressed);
    files[name] = method === 8 ? zlib.inflateRawSync(body).toString('utf8') : body.toString('utf8');
    at = start + compressed;
  }
  return files;
}

test('the archive round-trips, including data that deflate makes bigger', () => {
  const archive = zip([
    { name: 'a.txt', data: 'hello '.repeat(200) },
    { name: 'tiny.txt', data: 'x' }, // deflating this grows it
  ]);
  const back = unzip(archive);
  assert.equal(back['a.txt'], 'hello '.repeat(200));
  assert.equal(back['tiny.txt'], 'x');
  // The end-of-directory record is what a reader looks for first; without it
  // the file is not a ZIP at all.
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

test('the same content produces the same bytes', () => {
  // A fixed timestamp, so a document that differs only by when it was written
  // is not reported as changed. These are files people will keep in git.
  const once = zip([{ name: 'a.txt', data: 'same' }]);
  const twice = zip([{ name: 'a.txt', data: 'same' }]);
  assert.deepEqual([...once], [...twice]);
});

// ────────────────────────────────────────────────────────────────── Word

test('markdown becomes a Word document with its structure intact', () => {
  const doc = unzip(markdownToDocx('# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n'));

  // The three parts Word needs before it will open anything.
  assert.ok(doc['[Content_Types].xml']);
  assert.ok(doc['_rels/.rels']);
  assert.ok(doc['word/document.xml']);

  const body = doc['word/document.xml'];
  assert.match(body, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(body, /<w:b\/>/, 'bold survives');
  assert.match(body, /<w:i\/>/, 'italic survives');
  assert.match(body, /ListParagraph/, 'bullets are list paragraphs');
  // Without xml:space Word swallows the spaces between runs, and "Some bold
  // and italic text" becomes "Someboldanditalictext".
  assert.match(body, /xml:space="preserve"/);
});

test('markup characters in the text cannot break the document', () => {
  // A single unescaped `&` makes the whole file unopenable, and the content
  // here is written by a model quoting whatever the user said.
  const body = unzip(markdownToDocx('R&D <notes> "quoted"'))['word/document.xml'];
  assert.match(body, /R&amp;D &lt;notes&gt;/);
  assert.ok(!/R&D/.test(body));
});

// ───────────────────────────────────────────────────────────────── Excel

test('a markdown table or CSV both become the same rows', () => {
  const fromTable = parseGrid('| Item | Qty |\n|------|-----|\n| Tea  | 2   |');
  const fromCsv = parseGrid('Item,Qty\nTea,2');
  assert.deepEqual(fromTable, fromCsv);
  // The |---| separator is presentation and must not become a row of dashes.
  assert.equal(fromTable.length, 2);
});

test('a quoted comma stays inside its cell', () => {
  const rows = parseGrid('Name,Note\n"Smith, John",fine');
  assert.deepEqual(rows[1], ['Smith, John', 'fine']);
});

test('numbers are stored as numbers, or the spreadsheet cannot add them up', () => {
  const sheet = unzip(rowsToXlsx(parseGrid('Item,Cost\nTea,12.50\nJam,3')))['xl/worksheets/sheet1.xml'];
  // Which is the entire reason someone asked for a spreadsheet rather than a
  // table in a document.
  assert.match(sheet, /<c r="B2"[^>]*><v>12\.5<\/v>/);
  assert.match(sheet, /<c r="B3"[^>]*><v>3<\/v>/);
  assert.match(sheet, /<c r="A2"[^>]*t="inlineStr"/, 'text stays text');
});

test('columns keep counting past Z', () => {
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(25, 0), 'Z1');
  assert.equal(cellRef(26, 4), 'AA5');
  assert.equal(cellRef(27, 0), 'AB1');
});

test('a workbook carries every part Excel opens', () => {
  const book = unzip(rowsToXlsx([['a']]));
  for (const part of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
  ]) {
    assert.ok(book[part], `missing ${part}`);
  }
});

// ─────────────────────────────────────────────────────────────── routing

test('the writer is chosen by extension, and text files are left alone', () => {
  assert.ok(officeWriterFor('notes.docx'));
  assert.ok(officeWriterFor('BUDGET.XLSX'), 'extensions are not case-sensitive');
  assert.equal(officeWriterFor('notes.md'), null, 'markdown must stay markdown');
  assert.equal(officeWriterFor('data.csv'), null);
});

// ------------------------------------------------------------------ pdf
//
// Word and Excel are a ZIP of XML, so Zip.js did the work. A PDF is a binary
// file holding a table of byte offsets into itself, and a reader refuses the
// whole document over one wrong number — so the offsets are measured from real
// buffers rather than assembled as a string and hoped over.

const { markdownToPdf } = await import('../src/documents/Pdf.js');

test('a PDF is a PDF, with a table a reader can follow', () => {
  const bytes = markdownToPdf('# Title\n\nA paragraph.');
  assert.equal(bytes.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(bytes.toString('latin1'), /%%EOF\s*$/);

  // startxref has to name the byte where the table begins, exactly.
  const at = Number(/startxref\s+(\d+)/.exec(bytes.toString('latin1'))[1]);
  assert.equal(bytes.subarray(at, at + 4).toString('latin1'), 'xref');
});

test('a long document runs onto more pages', () => {
  const short = markdownToPdf('# One\n\nJust a line.');
  const long = markdownToPdf(['# Many', '', ...Array.from({ length: 200 }, (_, i) => `Paragraph number ${i}, with enough words in it to occupy most of a line on the page.`)].join('\n'));

  const count = (b) => Number(/\/Count (\d+)/.exec(b.toString('latin1'))[1]);
  assert.equal(count(short), 1);
  assert.ok(count(long) > 1, `200 paragraphs should not fit on one page, got ${count(long)}`);
});

// Both end a PDF string early, and a stray one truncates the document at that
// point rather than failing loudly.
test('brackets and backslashes in the text cannot break the file', () => {
  const bytes = markdownToPdf('A line with (parentheses) and a back\\slash.');
  const text = bytes.toString('latin1');
  assert.match(text, /\\\(parentheses\\\)/);
  assert.match(text, /%%EOF/);
});

// WinAnsi puts the em dash at 0x97, outside latin1's printable range, so
// writing the character itself dropped it and left a gap mid-sentence.
test('an em dash survives as its WinAnsi code', () => {
  const text = markdownToPdf('An em dash \u2014 mid sentence.').toString('latin1');
  assert.match(text, /\\227/);
  assert.ok(!text.includes('\u2014'), 'and not as the raw character');
});

test('.pdf is offered by the same writer that handles Word and Excel', () => {
  assert.ok(officeWriterFor('report.pdf'));
  assert.ok(officeWriterFor('REPORT.PDF'));
  assert.equal(officeWriterFor('photo.png'), null);
});
