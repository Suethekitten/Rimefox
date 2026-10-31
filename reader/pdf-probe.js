// PDF 探针：在扩展页里加载 legacy pdf.js，渲染一页并取文本层，结果写到 window.__probe。
// 只用于阶段 0 评估，不进正式 reader 流程。
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { pageBlocks, itemsToLines, dropMargins, detectColumns, parsePrintedToc } from '../lib/reader/pdf-text.js';

const params = new URLSearchParams(location.search);
const name = params.get('sample') || 'single';
const noCmap = params.get('nocmap') === '1';
const dir = params.get('dir') === 'real' ? 'reader/pdf-real/' : 'reader/pdf-samples/';
const pageNo = Math.max(1, Number(params.get('page') || 1));
const loadPages = Math.max(0, Math.min(60, Number(params.get('loadPages') || 0)));
const status = document.getElementById('status');
const out = {
  sample: name + (noCmap ? '+nocmap' : '') + (dir === 'reader/pdf-real/' ? ' (real)' : ''),
  version: pdfjsLib.version,
  ok: false,
  error: '',
  pages: 0,
  bytes: 0,
  renderMs: 0,
  textMs: 0,
  totalMs: 0,
  chars: 0,
  cmapUrl: '',
  cmapStatus: 0,
  head: ''
};
window.__probe = out;

function show(text) {
  if (status) status.textContent = text;
}

(async () => {
  const t0 = performance.now();
  const url = chrome.runtime.getURL(dir + name + '.pdf');
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  out.bytes = buf.byteLength;

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('reader/vendor/pdfjs/pdf.worker.min.mjs');
  const options = { data: buf, isEvalSupported: false, useWorkerFetch: false };
  if (!noCmap) {
    // CJK 内置编码（Adobe-GB1 / GBK / CNS …）需要字形 → Unicode 映射；纯数据文件，不影响浏览器版本
    options.cMapUrl = chrome.runtime.getURL('reader/vendor/pdfjs/cmaps/');
    out.cmapUrl = options.cMapUrl;
    try { out.cmapStatus = (await fetch(options.cMapUrl + 'GBK-EUC-H.bcmap')).status; } catch (err) { out.cmapStatus = -1; }
    options.cMapPacked = true;
  }
  const doc = await pdfjsLib.getDocument(options).promise;
  out.pages = doc.numPages;
  try {
    const outline = await doc.getOutline();
    out.outline = outline ? outline.length : 0;
    out.outlineFirst = outline && outline[0] ? String(outline[0].title || '') : '';
  } catch (err) {
    out.outline = -1;
  }
  try {
    const outline = await doc.getOutline();
    out.outline = outline ? outline.length : 0;
    out.outlineFirst = outline && outline[0] ? String(outline[0].title || '') : '';
    if (!outline || !outline.length) {
      const tocEntries = [];
      for (let i = 1; i <= Math.min(doc.numPages, 20); i += 1) {
        const tocPage = await doc.getPage(i);
        const tocContent = await tocPage.getTextContent();
        tocEntries.push(...parsePrintedToc(tocContent.items, { maxPage: doc.numPages }));
      }
      out.printedToc = tocEntries.length;
      out.printedSample = tocEntries.slice(0, 3).map((e) => e.title + ' p.' + e.page);
    }
  } catch (err) { out.outline = -1; }
  out.heapLoadMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0;

  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = document.getElementById('page');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');

  const renderStart = performance.now();
  await page.render({ canvas: canvas, canvasContext: ctx, viewport: viewport }).promise;
  out.renderMs = Math.round(performance.now() - renderStart);

  const textStart = performance.now();
  const content = await page.getTextContent();
  out.textMs = Math.round(performance.now() - textStart);
  out.chars = content.items.reduce((n, item) => n + String(item.str || '').length, 0);
  out.head = content.items.slice(0, 8).map((item) => item.str).join(' | ');

  // 文本块还原（页眉页脚过滤 / 双栏排序 / 段落合并）
  const blocks = pageBlocks(content, viewport);
  out.blocks = blocks.length;
  out.firstBlock = blocks.length ? blocks[0].text.slice(0, 140) : '';
  out.blockSample = blocks.slice(0, 5).map((b) => ({ s: b.text.slice(0, 45), e: b.text.slice(-45) }));
  const keptLines = dropMargins(itemsToLines(content.items), viewport.height);
  out.tocLines = dropMargins(itemsToLines(content.items, { fragmentGap: 1000 }), viewport.height).slice(0, 12).map((l) => l.text);
  out.tocDebug = content.items.filter((i) => /PACIFIC REGION|^11$|Tides/.test(i.str)).slice(0, 6).map((i) => [i.str, Math.round(i.transform[4]), Math.round(i.transform[5])]);
  out.lineCount = keptLines.length;
  out.bands = detectColumns(keptLines, viewport.width).map((b) => [Math.round(b[0]), Math.round(b[1])]);
  const wide = keptLines.filter((l) => l.x1 - l.x0 > viewport.width * 0.7);
  out.wideLines = wide.length;
  out.wideSample = wide.slice(0, 2).map((l) => ({ t: l.text.slice(0, 60), x0: Math.round(l.x0), x1: Math.round(l.x1) }));

  // 前 3 页文本量：真实 PDF 首页常常是标题页
  out.perPage = [out.chars];
  const extraPages = Math.min(doc.numPages, 3);
  for (let i = 2; i <= extraPages; i += 1) {
    const extra = await doc.getPage(i);
    const extraText = await extra.getTextContent();
    out.perPage.push(extraText.items.reduce((n, item) => n + String(item.str || '').length, 0));
  }
  out.chars3 = out.perPage.reduce((n, value) => n + value, 0);

  if (loadPages) {
    const loadStart = performance.now();
    for (let i = 1; i <= Math.min(doc.numPages, loadPages); i += 1) {
      const p = await doc.getPage(i);
      await p.getTextContent();
    }
    out.loadMs = Math.round(performance.now() - loadStart);
    out.loadedPages = Math.min(doc.numPages, loadPages);
  }
  out.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0;
  out.totalMs = Math.round(performance.now() - t0);
  out.ok = true;
  show('done: ' + name + ' · ' + out.pages + 'p · ' + out.chars + ' chars · ' + out.totalMs + 'ms');
})().catch((err) => {
  out.error = String((err && err.message) || err);
  show('error: ' + out.error);
  console.error('[pdf-probe]', err);
});
