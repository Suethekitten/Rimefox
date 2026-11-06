// OCR 行 → 阅读器文本块：纯函数。保持引擎给出的阅读顺序，只把明显属于同一段的相邻行合并。
// 不做版面重建（多栏重排、表格、竖排古籍）；那些仍按引擎顺序逐行 / 逐段输出，见 docs/OCR-INTERFACE.md §6.2。

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
// 段内续行的最大行距（相对行高）和左缘偏移（相对行高）；行高差过大视为标题 / 正文切换。
const GAP_RATIO = 0.75;
const INDENT_RATIO = 2.5;
const HEIGHT_RATIO = 1.45;
const BLOCK_MAX_CHARS = 1800;
// 上一行以句末标点结束、且右缘明显短于本段最宽行（差距超过 1 个行高）时视为段落结束。
const TERMINAL_RE = /[。！？!?.…」』”"）)]$/;

function median(values) {
  const list = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

// 两行拼接：CJK 之间不加空格；英文行尾连字符去掉后直接连上小写开头的下一行；其余加一个空格。
export function joinOcrText(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const last = prev.slice(-1);
  const first = next.charAt(0);
  if (CJK_RE.test(last) || CJK_RE.test(first)) return prev + next;
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return prev.slice(0, -1) + next;
  return prev + ' ' + next;
}

function sameParagraph(a, b, lineHeight) {
  if (!a.box || !b.box) return false;
  const [ax, ay, , ah] = a.box;
  const [bx, by, , bh] = b.box;
  const h = Math.max(1, lineHeight || Math.max(ah, bh));
  const gap = by - (ay + ah);
  if (gap < -0.5 * h || gap > GAP_RATIO * h) return false;
  if (Math.abs(bx - ax) > INDENT_RATIO * h) return false;
  const ratio = Math.max(ah, bh) / Math.max(1, Math.min(ah, bh));
  return ratio <= HEIGHT_RATIO;
}

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
}

function rightEdge(line) {
  return line.box ? line.box[0] + line.box[2] : 0;
}

function endsParagraph(last, block, lineHeight) {
  if (!last || !last.box || !TERMINAL_RE.test(last.text)) return false;
  return rightEdge(last) < block.right - Math.max(1, lineHeight);
}

// lines: [{ text, confidence, box: [x, y, w, h] | null }] → [{ text, lines: n, confidence, boxes }]
// boxes：块内每行的识别框（识别图像像素），任一行缺框时为 null，版式预览据此决定能否定位。
export function linesToBlocks(lines) {
  const list = (Array.isArray(lines) ? lines : [])
    .map((line) => ({ ...line, text: String((line && line.text) || '').replace(/\s+/g, ' ').trim() }))
    .filter((line) => line.text);
  if (!list.length) return [];
  const lineHeight = median(list.map((line) => (line.box ? line.box[3] : 0)));
  const blocks = [];
  let current = null;
  for (const line of list) {
    const last = current && current.items[current.items.length - 1];
    if (current && sameParagraph(last, line, lineHeight) && !endsParagraph(last, current, lineHeight) &&
        current.text.length + line.text.length <= BLOCK_MAX_CHARS) {
      current.text = joinOcrText(current.text, line.text);
      current.items.push(line);
      current.right = Math.max(current.right, rightEdge(line));
      continue;
    }
    current = { text: line.text, items: [line], right: rightEdge(line) };
    blocks.push(current);
  }
  return blocks.map((block) => {
    const conf = block.items.map((one) => one.confidence).filter((c) => typeof c === 'number');
    const boxes = block.items.every((one) => validBox(one.box)) ? block.items.map((one) => one.box.slice()) : null;
    return {
      text: block.text,
      lines: block.items.length,
      confidence: conf.length ? Math.round((conf.reduce((s, c) => s + c, 0) / conf.length) * 1000) / 1000 : null,
      boxes
    };
  });
}

// 识别框（识别图像像素，左上原点）→ 版式预览的 layoutLines（PDF 视口单位，基线自下而上），
// 与文字层同一格式，交给 lib/reader/pdf-layout.js 的 layoutRect。scale = 识别图像宽 / 视口宽。
// 识别框紧贴墨迹，扫描件字边还有模糊晕边：四周各补 OCR_BOX_PAD 倍框高，相当于文字层按字号留出的上下空白
// （实测 0.3 最好，更大会碰到相邻文字和表格线）。layoutRect 把每行看成基线以上 size、以下 0.25·size，
// 所以 size 取补边后高度 / 1.25，矩形贴合补边后的框；起始字号另按墨迹高度和字符种类估算（inkEmRatio）。
export const OCR_BOX_PAD = 0.3;
// 墨迹高度占字号的比例：大写 / 数字 / 有升部约 0.72，只有 x 高度约 0.5，下伸部再加 0.22，中日韩约 0.9。
export function inkEmRatio(text) {
  const s = String(text || '');
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(s)) return 0.9;
  const top = /[A-Z0-9bdfhiklt'"!?%&]/.test(s) ? 0.72 : 0.5;
  const bottom = /[gjpqy,;()[\]{}]/.test(s) ? 0.22 : 0;
  return top + bottom;
}
export function ocrLayoutLines(boxes, scale, viewportHeight, text) {
  if (!Array.isArray(boxes) || !boxes.length || !(scale > 0) || !(viewportHeight > 0)) return null;
  if (!boxes.every(validBox)) return null;
  return boxes.map((box) => {
    const [bx, by, bw, bh] = box.map((v) => v / scale);
    const pad = bh * OCR_BOX_PAD;
    const x = bx - pad, y = by - pad, h = bh + pad * 2;
    const size = h / 1.25;
    return { x0: x, x1: bx + bw + pad, size, fontSize: text == null ? bh : bh / inkEmRatio(text), y: viewportHeight - y - size };
  });
}
