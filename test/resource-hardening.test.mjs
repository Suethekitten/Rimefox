import test from 'node:test';
import { spoofedEpubZip } from './fixtures/qa-archives.mjs';
import assert from 'node:assert/strict';
import { zipSync } from '../lib/vendor/fflate.browser.mjs';
import { unpackEpub, EPUB_LIMITS } from '../lib/reader/epub-zip.js';
import { boundedPdfScale, createRasterBudget, PDF_RASTER_LIMITS as L } from '../lib/reader/pdf-raster.js';
import { openPdfDocument } from '../lib/reader/pdf.js';
import { canFetchModels } from '../lib/provider-endpoint.js';

test('a saved credential cannot follow an unsaved endpoint change (QA F9)', () => {
  const saved = { baseUrl: 'https://first.invalid/v1', apiKey: 'old' };
  assert.equal(canFetchModels(saved, { ...saved, baseUrl: saved.baseUrl + '/' }), true);
  for (const baseUrl of ['https://other.invalid/v1', 'https://first.invalid/proxy', 'http://first.invalid/v1']) {
    assert.equal(canFetchModels(saved, { ...saved, baseUrl }), false);
    assert.equal(canFetchModels(saved, { apiKey: 'new', baseUrl }), true);
  }
});

test('spoofed ZIP original sizes cannot bypass actual output limits (QA E2)', () => {
  const archive = spoofedEpubZip();
  assert.throws(() => unpackEpub(archive), (e) => ['too_large', 'unsafe_archive'].includes(e.code));
});

test('ZIP limits cover total actual output, entry count, time, traversal and truncation', () => {
  const small = zipSync({ a: new Uint8Array(30), b: new Uint8Array(30) }, { level: 0 });
  assert.equal(unpackEpub(small).a.length, 30);
  assert.throws(() => unpackEpub(small, { ...EPUB_LIMITS, maxTotalBytes: 50 }), { code: 'too_large' });
  assert.throws(() => unpackEpub(small, { ...EPUB_LIMITS, maxEntries: 1 }), { code: 'too_large' });
  assert.throws(() => unpackEpub(small, { ...EPUB_LIMITS, maxTimeMs: -1 }), { code: 'timeout' });
  assert.throws(() => unpackEpub(zipSync({ '%2e%2e/escape': new Uint8Array(1) })), { code: 'unsafe_archive' });
  assert.throws(() => unpackEpub(small.subarray(0, 32)), { code: 'not_epub' });
});

test('large and rotated page dimensions obey page/dimension budgets (QA E3)', () => {
  for (const [w, h] of [[8100, 8100], [15000, 15000], [842, 595], [1e9, 1], [1, 1e9]]) {
    const s = boundedPdfScale(w, h, 3).scale;
    assert.ok(Math.max(1, Math.floor(w * s)) * Math.max(1, Math.floor(h * s)) <= L.pagePixels);
    assert.ok(w * s <= L.maxDimension && h * s <= L.maxDimension);
  }
  assert.throws(() => boundedPdfScale(Infinity, 1));
  const budget = createRasterBudget();
  const canvases = [];
  for (let i = 0; i < 20; i++) {
    const c = {}; canvases.push(c);
    budget.reserve(c, 2048, 2048);
    assert.ok(budget.pixels <= L.totalPixels);
    assert.ok(canvases.reduce((n, c) => n + c.width * c.height, 0) <= L.totalPixels);
  }
  assert.equal(canvases[0].width, 0);
  budget.touch(canvases.at(-4));
  budget.reserve({}, 2048, 2048);
  assert.equal(canvases.at(-4).width, 2048);
  budget.clear(); assert.equal(budget.pixels, 0);
});

test('document cancellation cancels pdf.js tasks and releases allocated bitmaps', async () => {
  let began, rejectRender, cancels = 0;
  const start = new Promise((r) => { began = r; });
  const page = {
    getViewport: ({ scale }) => ({ width: 15000 * scale, height: 15000 * scale }),
    getTextContent: async () => ({ items: [] }),
    render() { began(); return { promise: new Promise((_, reject) => { rejectRender = reject; }), cancel() { cancels++; rejectRender(new DOMException('Aborted', 'AbortError')); } }; }
  };
  const doc = await openPdfDocument({ data: new Uint8Array(), loadPdfjs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page, getMetadata: async () => ({}), destroy() {} }) }) }) });
  const canvas = { getContext: () => ({}) };
  const rendering = doc.render(1, canvas, 3);
  await start;
  assert.ok(canvas.width * canvas.height <= L.pagePixels);
  doc.cancelRendering();
  await assert.rejects(rendering, { name: 'AbortError' });
  assert.equal(cancels, 1); assert.equal(canvas.width, 0);
  doc.destroy();
  await assert.rejects(doc.render(1, canvas, 1), { name: 'AbortError' });
});

test('cancelling a PDF while loading destroys its pdf.js loading task', async () => {
  const controller = new AbortController();
  let begin, rejectLoad, destroyed = false;
  const began = new Promise((resolve) => { begin = resolve; });
  const opening = openPdfDocument({ data: new Uint8Array(), signal: controller.signal, loadPdfjs: async () => ({ getDocument() {
    begin(); return { promise: new Promise((_, reject) => { rejectLoad = reject; }), destroy() { destroyed = true; rejectLoad(new Error('Loading cancelled')); } };
  } }) });
  await began; controller.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(destroyed, true);
});
