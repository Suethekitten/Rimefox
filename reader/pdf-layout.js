import { layoutRect, flatBackground } from '../lib/reader/pdf-layout.js';

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
  for (let i = 0; i < Math.min(loaded.blocks.length, 400); i += 1) {
    if (!image) continue;
    if (!texts[i]) { skips.untranslated += 1; continue; }
    const rect = layoutRect(loaded.blocks[i], loaded.viewport);
    if (!rect) { skips.position += 1; continue; }
    const pixels = { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
    // 笔画半宽随字号增长：粗大标题的笔画中心也要能找到附近的背景。
    const color = flatBackground(image, pixels, { stroke: Math.max(4, Math.ceil(rect.fontSize * sy * 0.15)) });
    if (!color) { skips.background += 1; continue; }
    const text = document.createElement('div'); text.className = 'pdf-layout-translation';
    text.textContent = texts[i]; text.dir = 'auto';
    text.style.left = rect.x / loaded.viewport.width * 100 + '%';
    text.style.top = rect.y / loaded.viewport.height * 100 + '%';
    text.style.width = rect.width / loaded.viewport.width * 100 + '%';
    text.style.height = rect.height / loaded.viewport.height * 100 + '%';
    // 底色画在译文层上而不是改画布：画布保持原页，「显示原文」只需隐藏译文层。
    text.style.backgroundColor = 'rgb(' + color.join(',') + ')';
    text.style.color = color.reduce((a, b) => a + b) > 384 ? '#111' : '#fff';
    view.appendChild(text);
    let font = Math.max(8, rect.fontSize * scale);
    text.style.fontSize = font + 'px';
    while ((text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1) && font > 8) {
      font = Math.max(8, font - 0.5); text.style.fontSize = font + 'px';
    }
    if (text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1) { text.remove(); skips.fit += 1; continue; }
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
