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
  columnMinGap: 10,     // 两段文字之间至少这么宽才当成两栏（pt）
  fragmentGap: 12,      // 同一行内两个片段允许的最大间隙；超过就当作换行/换栏
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
// 同一行里如果出现「贴着另一栏起始位置」的片段，就认为跨栏了——
// 有些书的栏间距几乎为 0（左栏文字顶到右栏），只靠空隙拆不开。
export function itemsToLines(items, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  // 按内容流顺序拼行：pdf.js 的片段顺序本身就是「一行一行、一栏一栏」的，
  // 先按 y 全局聚类会把左右两栏同一行的文字拼成一句（中文期刊实测会串栏）。
  const lines = [];
  let current = null;
  for (const item of items || []) {
    const str = String((item && item.str) || '');
    if (!str.trim()) continue;
    const tr = item.transform || [];
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    const w = Number(item.width) || 0;
    const frag = { x, y, w, str };
    const sameLine = current
      && Math.abs(current.y - y) <= o.yTolerance
      && x >= current.startX - 4
      && x - current.endX <= o.fragmentGap;
    if (sameLine) {
      current.items.push(frag);
      current.endX = Math.max(current.endX, x + w);
    } else {
      current = { y, startX: x, endX: x + w, items: [frag] };
      lines.push(current);
    }
  }
  return lines
    .map((line) => {
      const first = line.items[0];
      const last = line.items[line.items.length - 1];
      const x0 = first.x;
      const x1 = last.w > 0 ? last.x + last.w : last.x + String(last.str).length * 5;
      return { y: line.y, x0: x0, x1: x1, text: textOfFragments(line.items) };
    })
    .filter((line) => line.text);
}

// 栏起始位置聚类：正文每行都从同一 x 开始，缩进最多几十 pt；
// 只保留出现 ≥3 次、彼此距离 >100pt 的起点，作为「栏」的候选。
function columnCenters(fragments) {
  const xs = fragments.map((frag) => frag.x).sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.max <= 30) {
      last.max = x;
      last.sum += x;
      last.n += 1;
    } else {
      clusters.push({ max: x, sum: x, n: 1 });
    }
  }
  const centers = clusters.filter((cluster) => cluster.n >= 3).map((cluster) => cluster.sum / cluster.n).sort((a, b) => a - b);
  const out = [];
  for (const center of centers) {
    if (!out.length || center - out[out.length - 1] > 100) out.push(center);
  }
  return out.length >= 2 ? out : [];
}

function nearestCenter(centers, x) {
  let best = centers[0];
  for (const center of centers) if (Math.abs(x - center) < Math.abs(x - best)) best = center;
  return best;
}

// 去掉页眉页脚（按上下边距）。
export function dropMargins(lines, pageHeight, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const top = pageHeight * (1 - o.marginRatio);
  const bottom = pageHeight * o.marginRatio;
  return lines.filter((line) => line.y <= top && line.y >= bottom);
}

// 按空白间隙把页面切成竖条（栏 / 侧栏），返回 [x0, x1] 区间列表。
// 行区间取整行左右边界：同一栏内的行会被 word gap 连成一条，栏与栏之间的
// 装订线（> columnMinGap）才会断开。返回空数组表示「没检测到多栏」。
export function detectColumns(lines, pageWidth, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (!lines.length) return [];
  // 跨全宽的标题/图注不参与栏划分，否则会把所有栏粘成一条
  const narrow = lines.filter((line) => line.x1 - line.x0 <= pageWidth * 0.7);
  const intervals = narrow.map((line) => [line.x0, line.x1]).sort((a, b) => a[0] - b[0]);
  const bands = [];
  for (const interval of intervals) {
    const last = bands[bands.length - 1];
    if (last && interval[0] - last[1] < o.columnMinGap) last[1] = Math.max(last[1], interval[1]);
    else bands.push([interval[0], interval[1]]);
  }
  const minWidth = Math.min(60, pageWidth * 0.08);
  const solid = bands.filter((band) => band[1] - band[0] >= minWidth);
  if (solid.length < 2 || solid.length > 4) return [];
  return solid;
}

// 先把行分到各栏（左→右），栏内按 y 从上到下。
// 检测不到多栏时回退到「按中线分左右」，再不行就保持原顺序。
export function orderColumns(lines, pageWidth, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (!lines.length) return [];
  const bands = detectColumns(lines, pageWidth, o);
  if (bands.length) {
    const used = new Set();
    const out = [];
    for (const band of bands) {
      const inBand = lines.filter((line) => line.x0 >= band[0] - 2 && line.x0 <= band[1] + 2);
      inBand.sort((a, b) => b.y - a.y);
      for (const line of inBand) { used.add(line); out.push(line); }
    }
    for (const line of lines) if (!used.has(line)) out.push(line);
    return out;
  }
  const mid = pageWidth / 2;
  const left = lines.filter((line) => line.x0 < mid - pageWidth * 0.02);
  const right = lines.filter((line) => line.x0 >= mid - pageWidth * 0.02);
  if (!left.length || !right.length) return lines.slice();
  const leftMax = Math.max(...left.map((line) => line.x1));
  const rightMin = Math.min(...right.map((line) => line.x0));
  if (rightMin - leftMax < pageWidth * o.columnGapRatio) return lines.slice();
  return left.sort((a, b) => b.y - a.y).concat(right.sort((a, b) => b.y - a.y));
}

// 行 → 段落：同一栏内，行距超过阈值就断开；行尾连字符拼回单词。
// 项目符号（• · - 等）另起一段，避免一整份名单被并成一大段。
const BULLET_RE = /^[•·‣▪◦●○\-–—*]\s+/;
export function groupParagraphs(lines, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const out = [];
  let current = null;
  let prevY = null;
  let prevX0 = null;
  for (const line of lines) {
    const gap = prevY == null ? 0 : prevY - line.y;
    const lineHeight = 12;
    const bullet = BULLET_RE.test(line.text);
    const xJump = prevX0 != null && Math.abs(line.x0 - prevX0) > 40;
    // gap < -1：y 变大，说明从上一栏末尾跳到了新栏开头，必须断段
    if (current && (gap > lineHeight * o.paragraphGapRatio || gap < -1 || xJump || bullet)) {
      out.push(current);
      current = null;
    }
    if (!current) current = { text: line.text, y: line.y };
    else {
      const joinsWord = /[A-Za-z]-$/.test(current.text) && /^[a-z]/.test(line.text);
      current.text = joinsWord ? current.text.slice(0, -1) + line.text : current.text + ' ' + line.text;
    }
    prevY = line.y;
    prevX0 = line.x0;
  }
  if (current) out.push(current);
  return out
    .map((block) => ({ ...block, text: block.text.replace(/\s+/g, ' ').trim() }))
    .filter((block) => block.text.length > 1);
}

// 印刷版目录：按「同一水平带（±6pt）里标题片段 + 末尾页码片段」配对。
// OBP 这类书的页码常比标题基线高/低几 pt，按行解析会拆开，所以直接吃原始片段。
// 跨行标题：下一行没有页码且与标题左边界对齐时，拼回上一条。
export function parsePrintedToc(items, opts) {
  const maxPage = Number(opts && opts.maxPage) || 99999;
  const pageWidth = Number(opts && opts.pageWidth) || 0;
  const rows = [];
  for (const item of items || []) {
    const str = String((item && item.str) || '').trim();
    if (!str) continue;
    const tr = item.transform || [];
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    let row = null;
    for (const candidate of rows) {
      if (Math.abs(candidate.y - y) <= 6) { row = candidate; break; }
    }
    if (!row) { row = { y, segs: [] }; rows.push(row); }
    row.segs.push({ x, str });
  }
  rows.sort((a, b) => b.y - a.y);
  const out = [];
  let last = null;
  let lastY = null;
  let lastX = null;
  for (const row of rows) {
    row.segs.sort((a, b) => a.x - b.x);
    const lastSeg = row.segs[row.segs.length - 1];
    const startX = row.segs[0] ? row.segs[0].x : 0;
    if (!/^\d{1,4}$/.test(lastSeg.str)) {
      // 没有页码：可能是上一条标题的续行
      const text = row.segs.map((seg) => seg.str).join(' ').replace(/\s+/g, ' ').trim();
      if (last && lastY != null && Math.abs(lastY - row.y) <= 24 && Math.abs(startX - lastX) <= 12 && last.title.length >= 20 && text.length >= 4) {
        last.title = (last.title + ' ' + text).replace(/\s+/g, ' ').trim().slice(0, 160);
      }
      continue;
    }
    const page = Number(lastSeg.str);
    if (!page || page > maxPage) continue;
    // 页码必须在页面右侧，避免把正文里「某某 2024」当成目录条目
    if (pageWidth && lastSeg.x < pageWidth * 0.45) continue;
    const title = row.segs.slice(0, -1).map((seg) => seg.str).join(' ').replace(/\s+/g, ' ').trim();
    if (title.length < 6 || title.length > 160) continue;
    if (!/[A-Za-z\u4e00-\u9fff]/.test(title)) continue;
    if (/\d$/.test(title)) continue; // 以数字结尾多半是把「第 1 章」误切
    if (!/\s/.test(title) && /^[A-Z]+$/.test(title)) continue; // CHAPTER / SECTION
    const entry = { title: title, page: page };
    out.push(entry);
    last = entry;
    lastY = row.y;
    lastX = startX;
  }
  return out;
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// 页眉页脚里的页码/年份每页不同，比较时把数字归一成 #，否则永远匹配不上。
function normalizeForCompare(value) {
  return normalizeText(value).replace(/\d+/g, '#');
}

// 跨页页眉/页脚：统计上下 14% 区域里「几乎每页都出现」的整行（书眉、DOi 行、期号行）。
// 用整行而不是片段：中文页眉常被拆成「2022 / 年 / 第 / 67 …」这种单字片段，
// 按片段过滤会把正文里的「年」也删掉。
export function findRepeatedBandTexts(pages, opts) {
  const band = Number(opts && opts.band) || 0.20;
  const counts = new Map();
  let eligible = 0;
  for (const page of pages || []) {
    const items = page && page.items;
    if (!items || !items.length) continue;
    eligible += 1;
    const height = Number(page.height) || 842;
    const lines = itemsToLines(items);
    const seen = new Set();
    for (const line of lines) {
      if (line.y <= height * (1 - band) && line.y >= height * band) continue;
      const text = normalizeForCompare(line.text);
      if (text.length < 6 || text.length > 120) continue;
      if (!/[A-Za-z\u4e00-\u9fff]/.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      counts.set(text, (counts.get(text) || 0) + 1);
    }
  }
  if (eligible < 3) return [];
  const threshold = Math.max(3, Math.ceil(eligible * 0.2));
  return Array.from(counts.entries())
    .filter((entry) => entry[1] >= threshold)
    .map((entry) => entry[0]);
}

// 首页顶部的栏目横幅（OPEN / RESEARCH ARTICLE 等）：不在页边距内，也不是跨页重复，
// 单独按「顶部 12% + 固定词表」剥掉；和标题同一行时只去掉前缀。
const BANNER_RE = /^(OPEN|RESEARCH ARTICLE|REVIEW ARTICLE|ORIGINAL ARTICLE|BRIEF REPORT|LETTER|ARTICLE)\b\s*/i;

// 入口：文本层 + 页面尺寸 → 段落块
// opts.dropTexts：跨页重复的页眉/页脚整行，拼行后按行过滤。
function stripLatexArtifacts(text) {
  // 有些 PDF（arXiv 上的 LaTeX 论文）把公式转成图片后，把 base64 数据留在文本层里
  let out = String(text)
    .replace(/<latexitsha1_base64="[^"]*">/g, ' ')
    .replace(/<\/latexit>/g, ' ')
    .replace(/<latexit[^>]*>/g, ' ');
  // 纯 base64 长串（≥60 字符）不是正文
  out = out.replace(/\S{60,}/g, (token) => (/^[A-Za-z0-9+/=]+$/.test(token) ? ' ' : token));
  return out.replace(/\s+/g, ' ').trim();
}

export function pageBlocks(textContent, viewport, opts) {
  const drop = (opts && opts.dropTexts) || [];
  const dropSet = drop.map((text) => normalizeForCompare(text)).filter(Boolean);
  const width = Number(viewport && viewport.width) || 595;
  const height = Number(viewport && viewport.height) || 842;
  let lines = dropMargins(itemsToLines((textContent && textContent.items) || [], opts), height, opts);
  lines = lines
    .map((line) => ({ ...line, text: stripLatexArtifacts(line.text) }))
    .filter((line) => line.text);
  if (dropSet.length) {
    lines = lines.filter((line) => {
      const text = normalizeForCompare(line.text);
      return !dropSet.some((dropped) => text === dropped || text.startsWith(dropped));
    });
  }
  for (const line of lines) {
    if (line.y >= height * 0.72) line.text = line.text.replace(BANNER_RE, '').trim();
    // 中文期刊的卷期行 / 英文 Vol 行：只在顶部出现，直接判为页眉
    if (line.y >= height * 0.80 && /^(第\s*\d+\s*(卷|期)|Vol\.?\s*[:.]?\s*\(?\d+)/i.test(line.text)) line.text = '';
  }
  lines = lines.filter((line) => line.text);
  const ordered = orderColumns(lines, width, opts);
  return groupParagraphs(ordered, opts);
}
