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
