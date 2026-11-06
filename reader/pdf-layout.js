import { layoutRect, flatBackground, growLayoutRect } from '../lib/reader/pdf-layout.js';

export function clearPdfLayout(el, doc) {
  const view = el.querySelector('.pdf-layout-view');
  if (view) view.dataset.disposing = '1';
  const canvas = view?.querySelector('canvas');
  if (canvas) doc.releaseCanvas(canvas);
  view?.remove();
  el.querySelector('.pdf-layout-notice')?.remove();
  const details = el.querySelector('.pdf-layout-text');
  if (details) { const panel = details.querySelector('.pdf-blocks'); if (panel) el.appendChild(panel); details.remove(); }
}

export function updatePdfLayout(el, loaded, texts, doc) {
  clearPdfLayout(el, doc);
  const source = el.querySelector(':scope > canvas');
  if (!source?.width) return;
  const view = document.createElement('div'); view.className = 'pdf-layout-view';
  view.setAttribute('aria-label', '保留版式的译文页（预览）');
  const canvas = document.createElement('canvas'); view.appendChild(canvas); el.appendChild(view);
  doc.copyCanvas(source, canvas, () => { view.remove(); if (view.dataset.disposing !== '1') delete el.dataset.rendered; });
  const width = view.getBoundingClientRect().width;
  const scale = width / loaded.viewport.width;
  const image = loaded.layoutSupported ? source.getContext('2d').getImageData(0, 0, source.width, source.height) : null;
  const sx = source.width / loaded.viewport.width, sy = source.height / loaded.viewport.height;
  let placed = 0;
  // 未替换的原因计数，写在 data-layout-skips 上供诊断：untranslated / position / background / fit
  const skips = { untranslated: 0, position: 0, background: 0, fit: 0 };
  const count = Math.min(loaded.blocks.length, 400);
  const rects = Array.from({ length: count }, (_, i) => layoutRect(loaded.blocks[i], loaded.viewport));
  const toPixels = (r) => ({ x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy });
  const vp = loaded.viewport;
  for (let i = 0; i < count; i += 1) {
    if (!image) continue;
    if (!texts[i]) { skips.untranslated += 1; continue; }
    const rect = rects[i];
    if (!rect) { skips.position += 1; continue; }
    // 笔画半宽随字号增长：粗大标题的笔画中心也要能找到附近的背景。
    const stroke = Math.max(4, Math.ceil(rect.fontSize * sy * 0.15));
    const color = flatBackground(image, toPixels(rect), { stroke });
    if (!color) { skips.background += 1; continue; }
    const text = document.createElement('div'); text.className = 'pdf-layout-translation';
    text.textContent = texts[i]; text.dir = 'auto';
    const place = (r) => {
      text.style.left = r.x / vp.width * 100 + '%';
      text.style.top = r.y / vp.height * 100 + '%';
      text.style.width = r.width / vp.width * 100 + '%';
      text.style.height = r.height / vp.height * 100 + '%';
    };
    place(rect);
    // 底色画在译文层上而不是改画布：画布保持原页，「显示原文」只需隐藏译文层。
    text.style.backgroundColor = 'rgb(' + color.join(',') + ')';
    text.style.color = color.reduce((a, b) => a + b) > 384 ? '#111' : '#fff';
    view.appendChild(text);
    const base = Math.max(8, rect.fontSize * scale);
    let font = base;
    const fits = () => text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
    const shrink = (min) => {
      text.style.fontSize = font + 'px';
      while (!fits() && font > min) { font = Math.max(min, font - 0.5); text.style.fontSize = font + 'px'; }
      return fits();
    };
    // 先在原框里缩到原字号的 80%；仍放不下时，向右（本栏右缘）和向下（下一段之前）的同色空白扩展，
    // 扩展区也要通过同一底色检查，最后才继续缩到 8px。避免单行短段的长译文缩成极小字。
    let ok = shrink(Math.max(8, base * 0.8));
    if (!ok) {
      const grown = growLayoutRect(rect, rects, vp);
      const same = grown && flatBackground(image, toPixels(grown), { stroke });
      if (same && same.every((v, k) => Math.abs(v - color[k]) <= 10)) { place(grown); font = base; }
      ok = shrink(8);
    }
    if (!ok) { text.remove(); skips.fit += 1; continue; }
    placed += 1;
  }
  view.dataset.layoutSkips = Object.entries(skips).map(([k, v]) => k + ':' + v).join(',');
  const note = document.createElement('p'); note.className = 'pdf-layout-notice';
  note.textContent = !loaded.blocks.length || !loaded.layoutSupported
    ? '版式预览：旋转文字、没有正文或尚未识别出可定位文字的页面暂不替换，原页保留。完整译文可在下方查看。'
    : '版式预览：已替换 ' + placed + ' 处；仅尝试覆盖纯色文字区，复杂背景可能有误。表格、公式或放不下的文字保留原样，完整译文在下方，请核对原页。字体、颜色可能不同。';
  el.appendChild(note);
  const panel = el.querySelector('.pdf-blocks');
  if (panel) {
    const details = document.createElement('details'); details.className = 'pdf-layout-text';
    const summary = document.createElement('summary'); summary.textContent = '完整文字译文';
    details.appendChild(summary); details.appendChild(panel); el.appendChild(details);
  }
}
