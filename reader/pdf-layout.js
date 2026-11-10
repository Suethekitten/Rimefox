import { t } from '../lib/i18n.js';
import { layoutRect, layoutRectsOverlap, flatBackground, growLayoutRect, expandLayoutRect, separateLayoutRects } from '../lib/reader/pdf-layout.js';

export function clearPdfLayout(el, doc) {
  const view = el.querySelector('.pdf-layout-view');
  if (view) view.dataset.disposing = '1';
  const canvas = view?.querySelector('canvas');
  if (canvas) doc.releaseCanvas(canvas);
  view?.remove();
  el.querySelector('.pdf-layout-notice')?.remove();
  const details = el.querySelector('.pdf-layout-text');
  if (details) { const panel = details.querySelector('.pdf-blocks'); if (panel) el.appendChild(panel); details.remove(); }
  for (const block of el.querySelectorAll('.pdf-block[data-layout-skip]')) delete block.dataset.layoutSkip;
}

// 未放入版式的原因（与 data-layout-skips 的键一致）；untranslated 单独说「尚未翻译」。
const SKIP_LABELS = { position: '无法定位或与其他文字重叠', background: '背景不是纯色', fit: '译文放不下' };

export function layoutNoticeText({ blocks, placed, skips, pending }) {
  if (!blocks) return '版式预览：本页没有可定位的文字，原页保留。';
  const unplaced = skips.position + skips.background + skips.fit;
  if (!placed && !unplaced) return '版式预览：本页译文尚未生成，暂时显示原页。';
  const reasons = Object.keys(SKIP_LABELS).filter((key) => skips[key]).map((key) => SKIP_LABELS[key] + ' ' + skips[key] + ' 处');
  return '版式预览：已替换 ' + placed + ' 处'
    + (unplaced ? '，' + unplaced + ' 处保留原文（' + reasons.join('、') + '）' : '')
    + (pending ? '，' + pending + ' 处尚未翻译' : '')
    + '。只覆盖纯色背景上的文字，复杂背景、表格和公式保留原样；字体、颜色可能与原页不同，请核对原页。';
}

export function updatePdfLayout(el, loaded, texts, doc) {
  clearPdfLayout(el, doc);
  const source = el.querySelector(':scope > canvas');
  if (!source?.width) return;
  const view = document.createElement('div'); view.className = 'pdf-layout-view';
  view.setAttribute('aria-label', t('保留版式的译文页（预览）'));
  const canvas = document.createElement('canvas'); view.appendChild(canvas); el.appendChild(view);
  doc.copyCanvas(source, canvas, () => { view.remove(); if (view.dataset.disposing !== '1') delete el.dataset.rendered; });
  const width = view.getBoundingClientRect().width;
  const scale = width / loaded.viewport.width;
  const sx = source.width / loaded.viewport.width, sy = source.height / loaded.viewport.height;
  let placed = 0;
  // 未替换的原因计数，写在 data-layout-skips 上供诊断：untranslated / position / background / fit
  const skips = { untranslated: 0, position: 0, background: 0, fit: 0 };
  const count = Math.min(loaded.blocks.length, 400);
  const rects = separateLayoutRects(Array.from({ length: count }, (_, i) => layoutRect(loaded.blocks[i], loaded.viewport)));
  const image = rects.some((rect, i) => rect && !rect.blocked && texts[i])
    ? source.getContext('2d').getImageData(0, 0, source.width, source.height) : null;
  const toPixels = (r) => ({ x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy });
  const vp = loaded.viewport;
  // 两遍放置，保证最终的译文框互不重叠（扫描页曾出现下一块盖住上一段末行，2026-11 Mac 实机验收）：
  // 第一遍按顺序确定每块的底色框；扫描页需要补边时，只能避开已确定的框和其余块的原框。
  // 第二遍再缩字 / 向右下扩展，扩展只到下一块「实际使用的框」之上，并且不碰任何已放置的框。
  const base = rects.slice();
  const colors = new Array(count).fill(null);
  const reasons = new Array(count).fill(null);
  for (let i = 0; i < count; i += 1) {
    if (!texts[i]) { skips.untranslated += 1; continue; }
    let rect = rects[i];
    if (!rect || rect.blocked || rects.some((other) => other && other !== rect
      && (rect.rotation || other.rotation || other.blocked) && layoutRectsOverlap(rect, other))) {
      skips.position += 1;
      reasons[i] = 'position';
      continue;
    }
    // 笔画半宽随字号增长：粗大标题的笔画中心也要能找到附近的背景。
    // 扫描页：纸面噪点放宽颜色容差到 ±16，但边缘仍须 98% 一致——放宽比例会让框边切过倾斜的字，露出原字残片。
    const check = { stroke: Math.max(4, Math.ceil(rect.fontSize * sy * 0.15)), ...(loaded.scanned ? { tolerance: 16 } : {}) };
    let color = flatBackground(image, toPixels(rect), check);
    // OCR 框不随扫描倾斜，长行两端的字会出框：逐级加大四周边距（不碰其他块的实际框、不出页面），取第一个边缘干净的框。
    if (!color && loaded.scanned) {
      for (const step of [0.25, 0.5, 0.75, 1]) {
        const wider = expandLayoutRect(rects[i], rects[i].fontSize * step, base.map((o, k) => (k === i ? null : o)), vp);
        if (!wider) break;
        color = flatBackground(image, toPixels(wider), check);
        if (color) { rect = wider; break; }
      }
    }
    if (!color) { skips.background += 1; reasons[i] = 'background'; continue; }
    base[i] = rect;
    colors[i] = { color, check };
  }
  const final = new Array(count).fill(null);
  for (let i = 0; i < count; i += 1) {
    if (!colors[i]) continue;
    const { color, check } = colors[i];
    const rect = base[i];
    const text = document.createElement('div'); text.className = 'pdf-layout-translation';
    const page = loaded.blocks[i].tocPage;
    if (page && texts[i].endsWith(' ' + page)) {
      text.classList.add('pdf-layout-toc');
      const title = document.createElement('span');
      title.textContent = texts[i].slice(0, -page.length);
      title.dir = 'auto';
      const number = document.createElement('span');
      number.textContent = page;
      text.append(title, number);
    } else {
      text.textContent = texts[i]; text.dir = 'auto';
    }
    const place = (r) => {
      if (r.rotation) {
        const sideways = r.rotation % 180 !== 0;
        text.style.left = (r.x + r.width / 2) / vp.width * 100 + '%';
        text.style.top = (r.y + r.height / 2) / vp.height * 100 + '%';
        text.style.width = (sideways ? r.height : r.width) / vp.width * 100 + '%';
        text.style.height = (sideways ? r.width : r.height) / vp.height * 100 + '%';
        text.style.transform = 'translate(-50%, -50%) rotate(' + r.rotation + 'deg)';
        return;
      }
      text.style.left = r.x / vp.width * 100 + '%';
      text.style.top = r.y / vp.height * 100 + '%';
      text.style.width = r.width / vp.width * 100 + '%';
      text.style.height = r.height / vp.height * 100 + '%';
    };
    place(rect);
    let used = rect;
    // 底色画在译文层上而不是改画布：画布保持原页，「显示原文」只需隐藏译文层。
    text.style.backgroundColor = 'rgb(' + color.join(',') + ')';
    text.style.color = color.reduce((a, b) => a + b) > 384 ? '#111' : '#fff';
    view.appendChild(text);
    const base0 = Math.max(8, rect.fontSize * scale);
    let font = base0;
    const fits = () => text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
    const shrink = (min) => {
      text.style.fontSize = font + 'px';
      while (!fits() && font > min) { font = Math.max(min, font - 0.5); text.style.fontSize = font + 'px'; }
      return fits();
    };
    // 先在原框里缩到原字号的 80%；仍放不下时，向右（本栏右缘）和向下（下一段之前）的同色空白扩展，
    // 扩展区也要通过同一底色检查，最后才继续缩到 8px。避免单行短段的长译文缩成极小字。
    let ok = shrink(Math.max(8, base0 * 0.8));
    if (!ok) {
      const others = base.map((o, k) => (k === i ? null : final[k] || o));
      const grown = !page && !rect.rotation && growLayoutRect(rect, others, vp);
      const same = grown && flatBackground(image, toPixels(grown), check);
      if (same && same.every((v, k) => Math.abs(v - color[k]) <= 10)) { place(grown); used = grown; font = base0; }
      ok = shrink(8);
    }
    if (!ok) { text.remove(); skips.fit += 1; reasons[i] = 'fit'; continue; }
    final[i] = used;
    placed += 1;
  }
  view.dataset.layoutSkips = Object.entries(skips).map(([k, v]) => k + ':' + v).join(',');
  // 原页未翻译的块里，页码 / 公式这类本来就不送翻的不算「尚未翻译」。
  let pending = 0;
  for (let i = 0; i < count; i += 1) if (!texts[i] && !loaded.blocks[i].noTranslate) pending += 1;
  const unplaced = skips.position + skips.background + skips.fit;
  const note = document.createElement('p'); note.className = 'pdf-layout-notice'; note.dataset.i18n = '';
  note.textContent = layoutNoticeText({ blocks: loaded.blocks.length, placed, skips, pending });
  // 提示和完整译文放在原页上方：不用滚过整页才找到没放进版式的文字。
  const label = el.querySelector('.pdf-page-label');
  if (label) label.after(note); else el.appendChild(note);
  const panel = el.querySelector('.pdf-blocks');
  if (panel) {
    for (const block of panel.querySelectorAll('.pdf-block')) {
      const reason = reasons[Number(block.dataset.block)];
      if (reason) block.dataset.layoutSkip = reason;
    }
    const details = document.createElement('details'); details.className = 'pdf-layout-text';
    const summary = document.createElement('summary'); summary.dataset.i18n = '';
    summary.textContent = unplaced ? '查看本页完整译文（含未放入版式的 ' + unplaced + ' 处）' : '查看本页完整译文';
    details.appendChild(summary); details.appendChild(panel); note.after(details);
  }
}
