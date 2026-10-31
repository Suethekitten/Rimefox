// 生成 PDF 探针用的三份夹具（不依赖第三方库）：
//   single.pdf  单栏文章
//   columns.pdf 双栏排版
//   scan.pdf    只有图形、没有文本层（模拟扫描页）
// 运行：node tools/make-pdf-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reader', 'pdf-samples');
fs.mkdirSync(outDir, { recursive: true });

function esc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (const page of pages) {
    const stream = page.content;
    const contentId = add('<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream');
    const pageId = add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + (page.w || 595) + ' ' + (page.h || 842) + ']' +
      ' /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
  objects[pagesId - 1] = '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>';

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach((offset) => { out += String(offset).padStart(10, '0') + ' 00000 n \n'; });
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

function textBlock(lines, startX, startY, step) {
  let body = 'BT\n/F1 11 Tf\n';
  lines.forEach((line, i) => {
    body += '1 0 0 1 ' + startX + ' ' + (startY - i * step) + ' Tm (' + esc(line) + ') Tj\n';
  });
  return body + 'ET\n';
}

const prose = [
  'The document was opened only to be read, not to be changed.',
  'Every paragraph in this sample is plain English so the translation',
  'layer has something predictable to work with. The reader should',
  'merge lines into paragraphs conservatively, and it should never',
  'join two columns into one sentence.',
  'A second paragraph begins here. It exists to test paragraph',
  'detection: lines are close together, the gap between paragraphs',
  'is larger, and there is no indentation on the first line.',
  'Footnotes and page numbers are the usual sources of noise in',
  'PDF text extraction. This sample has a page number at the bottom.'
];

const single = buildPdf([{
  content: textBlock(prose, 60, 780, 16) + textBlock(['1'], 290, 40, 16)
}]);

const left = [];
const right = [];
for (let i = 0; i < 14; i += 1) {
  left.push('Left column line ' + (i + 1) + ': the quick brown fox jumps over the lazy dog again.');
  right.push('Right column line ' + (i + 1) + ': a second stream of text must stay separate from the first.');
}
const columns = buildPdf([{
  content: textBlock(left, 50, 780, 13) + textBlock(right, 310, 780, 13)
}]);

const scan = buildPdf([{
  content: '0.92 g\n50 120 495 680 re f\n0.4 g\n120 400 355 120 re f\n'
}]);

// 中文 CID 字体：Type0 + GBK-EUC-H + Adobe-GB1，故意不带 ToUnicode。
// 没有 cmaps 时 pdf.js 取不到正确 Unicode（这正是 cmaps 要验证的场景）。
// <C4E3BAC3CAC0BDE7> = GBK 编码的「你好世界」。
function buildCjkPdf() {
  const content = 'BT\n/F1 16 Tf\n60 760 Td\n<C4E3BAC3CAC0BDE7> Tj\n0 -30 Td\n<B2E2CAD4D6D0CEC4D7D6CCE5> Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>'
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach((offset) => { out += String(offset).padStart(10, '0') + ' 00000 n \n'; });
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}
const cjk = buildCjkPdf();

for (const [name, buf] of [['single.pdf', single], ['columns.pdf', columns], ['scan.pdf', scan], ['cjk.pdf', cjk]]) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(name, buf.length, 'bytes');
}
