// 生成 PDF 探针与阅读器 E2E 夹具（不依赖第三方库）：
//   single.pdf  单栏文章
//   columns.pdf 双栏排版
//   scan.pdf    只有图形、没有文本层（模拟扫描页）
//   ocr-scan.pdf 两页真实文字图像、没有文本层（OCR 端到端样本；图像来自 test/fixtures/ocr-sample.png）
//   cjk.pdf     中文 CID 字体 / cmaps
//   reader.pdf  可搜索、多页的阅读器回归样本
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
      (page.rotation ? ' /Rotate ' + page.rotation : '') + ' /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
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
  left.push('Left column line ' + (i + 1) + ': quick brown fox.');
  right.push('Right column line ' + (i + 1) + ': separate stream.');
}
const columns = buildPdf([{
  content: textBlock(left, 50, 780, 13) + textBlock(right, 310, 780, 13)
}]);

const scan = buildPdf([{
  content: '0.92 g\n50 120 495 680 re f\n0.4 g\n120 400 355 120 re f\n'
}]);
fs.writeFileSync(path.join(outDir, 'text-margin.pdf'), buildPdf([{ content: textBlock(['1'], 60, 820, 16) + textBlock(['1'], 290, 20, 16) }]));

fs.writeFileSync(path.join(outDir, 'layout.pdf'), buildPdf([{ content:
  '1 0.78 0.2 rg 0 0 595 842 re f\n0.1 0.4 0.5 rg 35 100 220 570 re f\n1 1 1 rg 290 400 275 200 re f\n0 0 0 rg\n' +
  'BT /F1 18 Tf 1 0 0 1 310 560 Tm (Layout caption) Tj ET\n' +
  'BT /F1 12 Tf 1 0 0 1 310 510 Tm (Text stays inside this white panel.) Tj ET\n'
}]));

fs.writeFileSync(path.join(outDir, 'layout-mixed.pdf'), buildPdf([{ content:
  'BT /F1 18 Tf 1 0 0 1 90 610 Tm (Horizontal layout caption) Tj ET\n' +
  'BT /F1 18 Tf 0 1 -1 0 325 610 Tm (Upward side heading) Tj ET\n' +
  'BT /F1 18 Tf 0 -1 1 0 430 670 Tm (Downward side heading) Tj ET\n' +
  'BT /F1 18 Tf 0.8 0.6 -0.6 0.8 110 390 Tm (Diagonal note) Tj ET\n' +
  'BT /F1 18 Tf 0 -1 1 0 525 460 Tm (Short side) Tj ET\n'
}, { rotation: 90, content:
  'BT /F1 18 Tf 0 1 -1 0 150 360 Tm (Aligned after page rotation) Tj ET\n' +
  'BT /F1 18 Tf 1 0 0 1 290 660 Tm (Rotated with the page) Tj ET\n'
}, { content:
  'BT /F1 18 Tf 1 0 0 1 100 500 Tm (Collision caption) Tj ET\n' +
  'BT /F1 18 Tf 0 1 -1 0 165 470 Tm (Collision heading) Tj ET\n'
}]));

const tocRows = ['COASTAL WATERS', 'WEATHER PATTERNS', 'WHAT CAN WE DO?'];
fs.writeFileSync(path.join(outDir, 'layout-toc.pdf'), buildPdf([{ content:
  'BT /F1 18 Tf 0 1 -1 0 62 605 Tm (WHAT CAN WE DO?) Tj ET\n' +
  tocRows.map((title, i) => {
    const y = 690 - i * 38;
    return 'BT /F1 14 Tf 1 0 0 1 104 ' + (y - 2) + ' Tm (0' + (i + 4) + ') Tj ET\n' +
      'BT /F1 14 Tf 1 0 0 1 145 ' + y + ' Tm (' + title + ') Tj ET\n' +
      'BT /F1 14 Tf 1 0 0 1 510 ' + (y + 2) + ' Tm (' + (111 + i * 8) + ') Tj ET\n';
  }).join('')
}]));

// 图片多、正文少：上半页是彩色条纹「照片」，下方白底图注和一段短正文，照片右侧白边有竖排署名，
// 左侧纯色色带上有竖排栏目名，照片上压一个短标签（复杂背景，应保留原文），底部页码。
const stripes = Array.from({ length: 12 }, (_, i) => {
  const c = [[0.85, 0.35, 0.2], [0.2, 0.55, 0.75], [0.95, 0.8, 0.3], [0.3, 0.65, 0.35]][i % 4];
  return c.join(' ') + ' rg ' + (60 + i * 40) + ' 330 40 430 re f\n';
}).join('');
fs.writeFileSync(path.join(outDir, 'layout-figure.pdf'), buildPdf([{ content:
  '0.1 0.45 0.5 rg 0 0 32 842 re f\n' + stripes + '0 0 0 rg\n' +
  'BT /F1 14 Tf 0 1 -1 0 22 330 Tm (COASTAL LIFE) Tj ET\n' +
  'BT /F1 16 Tf 1 0 0 1 250 560 Tm (Harbour) Tj ET\n' +
  'BT /F1 9 Tf 0 1 -1 0 552 340 Tm (Photo: Ana Ruiz) Tj ET\n' +
  'BT /F1 10 Tf 1 0 0 1 60 310 Tm (Figure 3. Boats return to the harbour at dawn.) Tj ET\n' +
  'BT /F1 11 Tf 1 0 0 1 60 260 Tm (Most of the catch is sold before the market opens.) Tj ET\n' +
  'BT /F1 11 Tf 1 0 0 1 60 245 Tm (The rest is dried on racks along the shore.) Tj ET\n' +
  'BT /F1 10 Tf 1 0 0 1 290 30 Tm (12) Tj ET\n'
}]));

// 10 页同尺寸竖版正文：版式预览滚动回归（Issue #18）。页数要多到画布预算留不住全部页，
// 且每页同为竖版，未渲染页的占位高度才和真实书籍一样按竖版比例算。
fs.writeFileSync(path.join(outDir, 'layout-scroll.pdf'), buildPdf(Array.from({ length: 10 }, (_, i) => ({
  content: 'BT /F1 16 Tf 1 0 0 1 60 760 Tm (Scroll sample heading ' + (i + 1) + ') Tj ET\n' +
    textBlock(prose.map((line) => 'Leaf ' + (i + 1) + ': ' + line), 60, 700, 16)
}))));

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
const reader = buildPdf(Array.from({ length: 8 }, (_, i) => ({
  rotation: i === 0 ? 90 : 0,
  content: textBlock([
    ...prose.map((line) => 'Page ' + (i + 1) + ': ' + line),
    'Ethical principles are discussed in the middle of page ' + (i + 1) + '.',
    ...prose.map((line) => 'Section ' + (i + 1) + ': ' + line)
  ], 60, 780, 16)
})));

const huge = buildPdf(Array.from({ length: 12 }, (_, i) => ({ w: 15000, h: 15000, content: textBlock(['Huge page ' + (i + 1)], 60, 780, 16) })));
// 把 8 位灰度 / RGB、不隔行的 PNG 直接嵌成 PDF 图像：IDAT 拼起来就是带 PNG 预测器的 zlib 流（FlateDecode + Predictor 15）。
function pngImage(file) {
  const png = fs.readFileSync(file);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file);
  let off = 8;
  let info = null;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') info = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (!info || info.depth !== 8 || info.interlace !== 0 || ![0, 2].includes(info.color)) throw new Error('need 8-bit gray/RGB non-interlaced PNG');
  return { ...info, colors: info.color === 2 ? 3 : 1, data: Buffer.concat(idat) };
}

function buildImagePdf(pages) {
  const parts = [];
  const objects = [];
  const add = (head, stream) => { objects.push({ head, stream }); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const pageIds = [];
  for (const page of pages) {
    const img = page.image;
    const imageId = add('<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h +
      ' /ColorSpace ' + (img.colors === 3 ? '/DeviceRGB' : '/DeviceGray') + ' /BitsPerComponent 8 /Filter /FlateDecode' +
      ' /DecodeParms << /Predictor 15 /Colors ' + img.colors + ' /BitsPerComponent 8 /Columns ' + img.w + ' >> /Length ' + img.data.length + ' >>', img.data);
    const draw = Buffer.from('q ' + page.dw + ' 0 0 ' + page.dh + ' ' + page.dx + ' ' + page.dy + ' cm /Im1 Do Q', 'latin1');
    const contentId = add('<< /Length ' + draw.length + ' >>', draw);
    pageIds.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 ' + imageId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'));
  }
  objects[catalogId - 1] = { head: '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>' };
  objects[pagesId - 1] = { head: '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>' };
  let size = 0;
  const push = (buf) => { parts.push(buf); size += buf.length; };
  push(Buffer.from('%PDF-1.4\n', 'latin1'));
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(size);
    push(Buffer.from((i + 1) + ' 0 obj\n' + obj.head + '\n', 'latin1'));
    if (obj.stream) { push(Buffer.from('stream\n', 'latin1')); push(obj.stream); push(Buffer.from('\nendstream\n', 'latin1')); }
    push(Buffer.from('endobj\n', 'latin1'));
  });
  const xref = size;
  let tail = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach((offset) => { tail += String(offset).padStart(10, '0') + ' 00000 n \n'; });
  tail += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

const sample = pngImage(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'ocr-sample.png'));
// 图像按 1200×700 像素画在 A4 上方，宽 515pt；两页相同，用来检查逐页识别、缓存复用与翻页。
const ocrScan = buildImagePdf([1, 2].map(() => ({ image: sample, dx: 40, dy: 842 - 40 - 300, dw: 515, dh: 300 })));

for (const [name, buf] of [['single.pdf', single], ['columns.pdf', columns], ['scan.pdf', scan], ['cjk.pdf', cjk], ['reader.pdf', reader], ['huge.pdf', huge], ['ocr-scan.pdf', ocrScan]]) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(name, buf.length, 'bytes');
}
