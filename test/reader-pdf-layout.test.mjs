import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutRect, flatBackground } from '../lib/reader/pdf-layout.js';
import { groupParagraphs } from '../lib/reader/pdf-text.js';

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
