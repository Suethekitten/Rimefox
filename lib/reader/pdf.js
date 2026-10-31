// PdfDocument：把 pdf.js 的页面包成 reader 能用的只读文档。
// 只做解析 / 文本块 / 渲染，不碰 chrome.*（pdf.js 由调用方注入，便于测试与换版本）。
import { pageBlocks } from './pdf-text.js';

const METADATA_KEYS = ['Title', 'Author', 'Subject', 'Keywords'];

function textOf(value) {
  return value == null ? '' : String(value).trim();
}

export async function openPdfDocument({ data, loadPdfjs, workerSrc, cMapUrl }) {
  if (!loadPdfjs) throw new Error('loadPdfjs is required');
  const pdfjs = await loadPdfjs();
  if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  // useWorkerFetch:false：CMap / 标准字体数据改由主线程取，worker 取不到时不至于卡住渲染。
  const options = { data: data, isEvalSupported: false, useWorkerFetch: false };
  if (cMapUrl) {
    options.cMapUrl = cMapUrl;
    options.cMapPacked = true;
  }
  const doc = await pdfjs.getDocument(options).promise;
  let info = {};
  try {
    const meta = await doc.getMetadata();
    info = (meta && meta.info) || {};
  } catch (err) {
    info = {};
  }
  const metadata = {
    title: textOf(info.Title) || '未命名 PDF',
    authors: textOf(info.Author) ? [textOf(info.Author)] : [],
    language: textOf(info.Language) || '',
    publisher: textOf(info.Producer) || '',
    description: textOf(info.Subject) || '',
    identifier: textOf(info.Keywords) || ''
  };
  const pageCache = new Map();

  async function loadPage(index) {
    const pageNo = Math.max(1, Math.min(doc.numPages, Number(index) || 1));
    if (pageCache.has(pageNo)) return pageCache.get(pageNo);
    const promise = (async () => {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      return {
        pageNo: pageNo,
        page: page,
        viewport: viewport,
        blocks: pageBlocks(textContent, viewport)
      };
    })();
    pageCache.set(pageNo, promise);
    return promise;
  }

  return {
    format: 'pdf',
    numPages: doc.numPages,
    metadata: metadata,
    async page(index) { return loadPage(index); },
    async render(index, canvas, scale) {
      const loaded = await loadPage(index);
      // 先按 1:1 渲染，再用 CSS 缩放到容器宽度：探针页验证过 1:1 能稳定完成，
      // 分数缩放（0.66 等）在 reader 页里会让 render 永不 resolve。
      const viewport = loaded.viewport;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await loaded.page.render({ canvas: canvas, canvasContext: ctx, viewport: viewport }).promise;
      return { width: viewport.width, height: viewport.height };
    },
    destroy() {
      pageCache.clear();
      try { doc.destroy(); } catch (err) { /* ignore */ }
    }
  };
}

// 给 fetch 回来的字节做一次轻量校验，避免把 HTML 错误页当成 PDF。
export function looksLikePdf(bytes) {
  if (!bytes || bytes.byteLength < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}
