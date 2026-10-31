// PDF 文本层 → 翻译单元（段落块）。
//
// pdf.js 的 getTextContent() 给的是按内容流顺序排列的文本片段，不是段落：
//   - 开头往往是页眉（期刊名 / DOI / 页码），结尾是页脚；
//   - 双栏论文的片段顺序是「左栏全部 → 右栏全部」，直接按顺序合并会串栏；
//   - 一句话可能被拆成多个片段，行尾还可能有断词连字符。
// 这里全部做成纯函数，方便 Node 单测；不做任何 DOM / pdf.js 依赖。

const DEFAULTS = {
  yTolerance: 3,        // 同一行的 y 误差（pt）
  marginRatio: 0.06,    // 上下各 6% 视为页眉页脚
  columnGapRatio: 0.08, // 两栏之间至少这么宽的空隙才判定为双栏
  fragmentGap: 24,      // 同一 y 上片段间隙超过这个值就当成两栏的不同行
  paragraphGapRatio: 1.6 // 行距超过 1.6 倍行高视为新段落
};

function textOfFragments(fragments) {
  let out = '';
  let prev = null;
  for (const frag of fragments) {
    const str = String(frag.str || '');
    if (!str) continue;
    if (prev) {
      const gap = frag.x - (prev.x + prev.w);
      const needSpace = gap > 1.5 && !/\s$/.test(out) && !/^\s/.test(str) && !/^[,.;:!?，。；：！？)]/.test(str);
      if (needSpace) out += ' ';
    }
    out += str;
    prev = frag;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// 片段 → 行：按 y 聚类，行内按 x 排序。
export function itemsToLines(items, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const rows = [];
  for (const item of items || []) {
    const str = String((item && item.str) || '');
    if (!str.trim()) continue;
    const tr = item.transform || [];
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    const w = Number(item.width) || 0;
    let row = null;
    for (const candidate of rows) {
      if (Math.abs(candidate.y - y) <= o.yTolerance) { row = candidate; break; }
    }
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, w, str });
  }
  rows.sort((a, b) => b.y - a.y); // 从上到下
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    // 同一基线上左右两栏会各有一条；间隙很大就拆成两行，避免拼成「左栏+右栏」
    let segment = [];
    let prev = null;
    for (const frag of row.items) {
      if (segment.length && frag.x - (prev.x + prev.w) > o.fragmentGap) {
        lines.push({ y: row.y, items: segment });
        segment = [];
      }
      segment.push(frag);
      prev = frag;
    }
    if (segment.length) lines.push({ y: row.y, items: segment });
  }
  return lines
    .map((line) => ({ y: line.y, x: line.items[0].x, text: textOfFragments(line.items) }))
    .filter((line) => line.text);
}

// 去掉页眉页脚（按上下边距）。
export function dropMargins(lines, pageHeight, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const top = pageHeight * (1 - o.marginRatio);
  const bottom = pageHeight * o.marginRatio;
  return lines.filter((line) => line.y <= top && line.y >= bottom);
}

// 双栏排序：按 x 是否越过中线分左右；两栏都有内容时先左后右。
// 单栏（或跨栏行）保持原始从上到下顺序。
export function orderColumns(lines, pageWidth, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (!lines.length) return [];
  const mid = pageWidth / 2;
  const left = lines.filter((line) => line.x < mid - pageWidth * 0.02);
  const right = lines.filter((line) => line.x >= mid - pageWidth * 0.02);
  const hasWide = lines.some((line) => line.x < mid && line.x + line.text.length * 5 > mid + pageWidth * o.columnGapRatio);
  if (hasWide || !left.length || !right.length) return lines.slice();
  // 两栏之间要有明显空隙，否则可能是居中排版
  const leftMaxRight = Math.max(...left.map((line) => line.x + line.text.length * 5));
  const rightMinLeft = Math.min(...right.map((line) => line.x));
  if (rightMinLeft - leftMaxRight < pageWidth * o.columnGapRatio) return lines.slice();
  return left.concat(right);
}

// 行 → 段落：同一栏内，行距超过阈值就断开；行尾连字符拼回单词。
export function groupParagraphs(lines, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const out = [];
  let current = null;
  let prevY = null;
  for (const line of lines) {
    const gap = prevY == null ? 0 : prevY - line.y;
    const lineHeight = 12;
    // gap < -1：y 变大，说明从上一栏末尾跳到了新栏开头，必须断段
    if (current && (gap > lineHeight * o.paragraphGapRatio || gap < -1)) {
      out.push(current);
      current = null;
    }
    if (!current) current = { text: line.text, y: line.y };
    else {
      const joinsWord = /[A-Za-z]-$/.test(current.text) && /^[a-z]/.test(line.text);
      current.text = joinsWord ? current.text.slice(0, -1) + line.text : current.text + ' ' + line.text;
    }
    prevY = line.y;
  }
  if (current) out.push(current);
  return out
    .map((block) => ({ ...block, text: block.text.replace(/\s+/g, ' ').trim() }))
    .filter((block) => block.text.length > 1);
}

// 入口：文本层 + 页面尺寸 → 段落块
export function pageBlocks(textContent, viewport, opts) {
  const items = (textContent && textContent.items) || [];
  const width = Number(viewport && viewport.width) || 595;
  const height = Number(viewport && viewport.height) || 842;
  const lines = dropMargins(itemsToLines(items, opts), height, opts);
  const ordered = orderColumns(lines, width, opts);
  return groupParagraphs(ordered, opts);
}
