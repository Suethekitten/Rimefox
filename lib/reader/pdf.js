// PdfDocument：把 pdf.js 的页面包成 reader 能用的只读文档。
// 只做解析 / 文本块 / 渲染，不碰 chrome.*（pdf.js 由调用方注入，便于测试与换版本）。
import { pageBlocks, parsePrintedToc, findRepeatedBandTexts } from './pdf-text.js';

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
  let repeatedPromise = null;

  // 跨页页眉/页脚只算一次：取前 16 页上下边带里重复出现的片段。
  async function repeatedBandTexts() {
    if (!repeatedPromise) {
      repeatedPromise = (async () => {
        const pages = [];
        const limit = Math.min(doc.numPages, 16);
        for (let i = 1; i <= limit; i += 1) {
          try {
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();
            pages.push({ items: textContent.items, height: viewport.height });
          } catch (err) { /* 跳过这一页 */ }
        }
        return findRepeatedBandTexts(pages);
      })();
    }
    return repeatedPromise;
  }

  async function loadPage(index) {
    const pageNo = Math.max(1, Math.min(doc.numPages, Number(index) || 1));
    if (pageCache.has(pageNo)) return pageCache.get(pageNo);
    const promise = (async () => {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const dropTexts = await repeatedBandTexts();
      return {
        pageNo: pageNo,
        page: page,
        viewport: viewport,
        blocks: pageBlocks(textContent, viewport, { dropTexts: dropTexts })
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
    // 三档目录：内嵌 outline → 印刷版目录页 → 页列表（entries 为空）
    async toc() {
      const entries = [];
      try {
        const outline = await doc.getOutline();
        if (outline && outline.length) {
          const walk = async (items, depth) => {
            for (const item of items) {
              let page = null;
              try {
                let dest = item.dest;
                if (typeof dest === 'string') dest = await doc.getDestination(dest);
                if (dest && dest[0]) page = (await doc.getPageIndex(dest[0])) + 1;
              } catch (err) {
                page = null;
              }
              if (item.title) entries.push({ title: String(item.title).trim(), page: page, depth: depth });
              if (item.items && item.items.length) await walk(item.items, depth + 1);
            }
          };
          await walk(outline, 0);
        }
      } catch (err) { /* outline 不可用，走下一档 */ }
      if (entries.length) return { source: 'outline', entries: entries.slice(0, 500) };

      for (let i = 1; i <= Math.min(doc.numPages, 20); i += 1) {
        try {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          const found = parsePrintedToc(textContent.items, { maxPage: doc.numPages });
          if (found.length >= 3) entries.push(...found);
        } catch (err) { /* 跳过这一页 */ }
      }
      const seen = new Set();
      const unique = entries.filter((one) => {
        const key = one.title + '|' + one.page;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { source: unique.length ? 'printed' : 'pages', entries: unique.slice(0, 500) };
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
