// PDF 探针：在扩展页里加载 legacy pdf.js，渲染一页并取文本层，结果写到 window.__probe。
// 只用于阶段 0 评估，不进正式 reader 流程。
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { pageBlocks } from '../lib/reader/pdf-text.js';

const params = new URLSearchParams(location.search);
const name = params.get('sample') || 'single';
const noCmap = params.get('nocmap') === '1';
const dir = params.get('dir') === 'real' ? 'reader/pdf-real/' : 'reader/pdf-samples/';
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

  const page = await doc.getPage(1);
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

  // 前 3 页文本量：真实 PDF 首页常常是标题页
  out.perPage = [out.chars];
  const extraPages = Math.min(doc.numPages, 3);
  for (let i = 2; i <= extraPages; i += 1) {
    const extra = await doc.getPage(i);
    const extraText = await extra.getTextContent();
    out.perPage.push(extraText.items.reduce((n, item) => n + String(item.str || '').length, 0));
  }
  out.chars3 = out.perPage.reduce((n, value) => n + value, 0);

  out.totalMs = Math.round(performance.now() - t0);
  out.ok = true;
  show('done: ' + name + ' · ' + out.pages + 'p · ' + out.chars + ' chars · ' + out.totalMs + 'ms');
})().catch((err) => {
  out.error = String((err && err.message) || err);
  show('error: ' + out.error);
  console.error('[pdf-probe]', err);
});
