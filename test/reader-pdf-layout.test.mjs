import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutRect, flatBackground, growLayoutRect, expandLayoutRect } from '../lib/reader/pdf-layout.js';
import { groupParagraphs, pageBlocks } from '../lib/reader/pdf-text.js';

test('layout geometry follows a paragraph without crossing columns; legacy blocks unchanged', () => {
  const lines = [{ text: 'First line', y: 100, x0: 10, x1: 80, size: 10 }, { text: 'next line.', y: 88, x0: 10, x1: 70, size: 10 },
    { text: 'Other column', y: 100, x0: 150, x1: 220, size: 10 }];
  const old = groupParagraphs(lines);
  const blocks = groupParagraphs(lines, { captureLayout: true });
  assert.deepEqual(blocks.map(({ layoutLines, ...rest }) => rest), old);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].layoutLines.length, 2);
  assert.deepEqual(layoutRect(blocks[0], { width: 250, height: 200 }), { x: 8.5, y: 88.5, width: 73, height: 27.5, fontSize: 10 });
  assert.equal(layoutRect({ ...blocks[0], noTranslate: true }, { width: 250, height: 200 }), null);
  assert.equal(layoutRect(blocks[1], { width: 200, height: 200 }), null);
});

test('mixed text orientations never merge into a horizontal layout block', () => {
  const viewport = { width: 595, height: 842 };
  const items = [
    { str: 'Horizontal caption', transform: [18, 0, 0, 18, 90, 610], width: 130, height: 18 },
    { str: 'Side heading', transform: [0, 18, -18, 0, 222, 610], width: 100, height: 18 },
    { str: 'Diagonal note', transform: [8, 6, -6, 8, 110, 390], width: 80, height: 10 }
  ];
  const blocks = pageBlocks({ items }, viewport, { captureLayout: true });
  assert.deepEqual(blocks.map((block) => block.text), items.map((item) => item.str));
  assert.ok(layoutRect(blocks[0], viewport));
  assert.equal(layoutRect(blocks[1], viewport), null);
  assert.equal(layoutRect(blocks[2], viewport), null);
});

test('layout masking accepts solid light/dark backgrounds, declines gradients and illustrated areas', () => {
  const make = (color) => ({ width: 100, height: 50, data: new Uint8ClampedArray(Array.from({ length: 5000 }, () => [...color, 255]).flat()) });
  const rect = { x: 2, y: 2, width: 95, height: 45 };
  const white = make([255, 255, 255]);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) white.data.set([0, 0, 0, 255], (y * 100 + x) * 4);
  assert.deepEqual(flatBackground(white, rect), [255, 255, 255]);
  assert.deepEqual(flatBackground(make([20, 20, 20]), rect), [20, 20, 20]);
  const gradient = make([255, 255, 255]);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 100; x++) gradient.data.set([x * 2, y * 4, 100, 255], (y * 100 + x) * 4);
  assert.equal(flatBackground(gradient, rect), null);
  for (let y = 10; y < 40; y++) for (let x = 10; x < 90; x++) white.data.set([0, 40, 100, 255], (y * 100 + x) * 4);
  assert.equal(flatBackground(white, rect), null);
});

test('layout masking accepts dense thin-stroke text but still declines filled boxes of the same coverage', () => {
  const bg = [54, 59, 64], ink = [220, 220, 220];
  const make = () => ({ width: 120, height: 60, data: new Uint8ClampedArray(Array.from({ length: 7200 }, () => [...bg, 255]).flat()) });
  const rect = { x: 1, y: 1, width: 117, height: 57 };
  // Dense CJK-like strokes: 2 px lines every 4 px inside each "glyph" row, about 36% non-background.
  const text = make();
  for (let y = 2; y < 58; y++) for (let x = 2; x < 118; x++) if ((x % 4 < 2) && (y % 10 < 8)) text.data.set([...ink, 255], (y * 120 + x) * 4);
  let covered = 0;
  for (let i = 0; i < 7200; i++) if (text.data[i * 4] === ink[0]) covered += 1;
  assert.ok(covered / 7200 > 0.3, 'fixture is denser than the old 72% background rule allowed');
  assert.deepEqual(flatBackground(text, rect), bg);
  // Same light colour as one solid block covering a similar share: not text, keep the original page.
  const box = make();
  for (let y = 12; y < 48; y++) for (let x = 20; x < 100; x++) box.data.set([...ink, 255], (y * 120 + x) * 4);
  assert.equal(flatBackground(box, rect), null);
  // Large bold glyphs: 12 px strokes every 30 px. Their centres are 6 px from background, so they
  // pass only with a stroke reach scaled to the font size (the layout passes 15% of the pixel size).
  const bold = make();
  for (let y = 4; y < 56; y++) for (let x = 4; x < 116; x++) if (x % 30 < 12) bold.data.set([...ink, 255], (y * 120 + x) * 4);
  assert.equal(flatBackground(bold, rect), null);
  assert.deepEqual(flatBackground(bold, rect, { stroke: 7 }), bg);
});

test('short paragraphs may grow into free column space but never into another block', () => {
  const viewport = { width: 595, height: 842 };
  const wide = { x: 36, y: 100, width: 516, height: 35, fontSize: 11 };
  const short = { x: 36, y: 150, width: 200, height: 17, fontSize: 11 };
  const next = { x: 36, y: 190, width: 516, height: 35, fontSize: 11 };
  const grown = growLayoutRect(short, [wide, short, next], viewport);
  assert.deepEqual(grown, { x: 36, y: 150, width: 516, height: 38, fontSize: 11 });
  // Never more than three times the original height, even with free space below.
  assert.equal(growLayoutRect(short, [wide, short], viewport).height, 51);
  // A block in the way (e.g. a right-hand note at the same height) blocks growth entirely.
  const note = { x: 300, y: 152, width: 100, height: 14, fontSize: 9 };
  assert.equal(growLayoutRect(short, [wide, short, note, next], viewport), null);
  // Nothing to gain: already full column width with the next block right below.
  assert.equal(growLayoutRect(wide, [wide, { x: 36, y: 137, width: 516, height: 10, fontSize: 9 }], viewport), null);
});

test('scanned-page margins grow evenly but never off the page or into another block', () => {
  const viewport = { width: 595, height: 842 };
  const line = { x: 70, y: 186, width: 451, height: 20, fontSize: 10 };
  const above = { x: 70, y: 150, width: 300, height: 14, fontSize: 10 };
  assert.deepEqual(expandLayoutRect(line, 5, [above, line], viewport), { x: 65, y: 181, width: 461, height: 30, fontSize: 10 });
  assert.equal(expandLayoutRect(line, 25, [above, line], viewport), null);
  assert.equal(expandLayoutRect({ ...line, x: 2 }, 5, [line], viewport), null);
});

test('padded OCR rects that overlap vertically are split at the middle of the overlap; others untouched', async () => {
  const { separateLayoutRects } = await import('../lib/reader/pdf-layout.js');
  const para = { x: 40, y: 100, width: 300, height: 80, fontSize: 18 };
  const next = { x: 42, y: 176, width: 300, height: 60, fontSize: 18 };
  const side = { x: 400, y: 100, width: 100, height: 200, fontSize: 12 };
  const out = separateLayoutRects([para, next, side, null]);
  assert.ok(out[0].y + out[0].height < out[1].y, 'no vertical overlap after separation');
  assert.equal(out[0].y, 100);
  assert.equal(out[0].y + out[0].height, 177.5);
  assert.equal(out[1].y, 178.5);
  assert.equal(out[1].y + out[1].height, 236, 'the lower block keeps its bottom edge');
  assert.deepEqual(out[2], side, 'blocks without horizontal overlap are unchanged');
  assert.equal(out[3], null);
  assert.equal(para.height, 80, 'input is not mutated');
  const apart = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 20, width: 10, height: 10 }];
  assert.deepEqual(separateLayoutRects(apart), apart);
});

test('side-by-side OCR columns with a narrow gutter are not split even though their padding overlaps', async () => {
  const { separateLayoutRects, layoutRect } = await import('../lib/reader/pdf-layout.js');
  const { ocrLayoutLines } = await import('../lib/ocr/layout.js');
  // 双栏扫描页：墨迹栏间只有 8 单位，行高 10，补边后左右两栏的框交叠约 1 单位，上下错开 140
  const viewport = { width: 600, height: 800 };
  const column = (x, y) => ({ text: 'x', layoutLines: ocrLayoutLines(Array.from({ length: 20 }, (_, i) => [x, y + i * 14, 252, 10]), 1, 800, 'Text') });
  const left = layoutRect(column(40, 100), viewport);
  const right = layoutRect(column(300, 240), viewport);
  assert.ok(left.x + left.width > right.x, 'fixture: padded columns overlap horizontally');
  assert.deepEqual(separateLayoutRects([left, right]), [left, right]);
  // 同一栏里上下相邻、补边重叠的两段仍然分开
  const below = layoutRect(column(40, 380), viewport);
  const [a, b] = separateLayoutRects([left, below]);
  assert.ok(a.y + a.height < b.y);
});
