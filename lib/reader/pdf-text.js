// PDF 文本层 → 翻译单元（段落块）。
//
// pdf.js 的 getTextContent() 给的是按内容流顺序排列的文本片段，不是段落：
//   - 开头往往是页眉（期刊名 / DOI / 页码），结尾是页脚；
//   - 双栏论文的片段顺序是「左栏全部 → 右栏全部」，直接按顺序合并会串栏；
//   - 一句话可能被拆成多个片段，行尾还可能有断词连字符。
// 这里全部做成纯函数，方便 Node 单测；不做任何 DOM / pdf.js 依赖。

// 长块阈值：PDF 单块超过这个字数就先按句末标点切开再送翻。
// 阅读器的「复杂版式」提示也用同一个值，避免两处各写一个 1500。
export const PDF_LONG_BLOCK_LIMIT = 1500;

// 公式在文本层里的占位。公式块不送翻译，混合段落里的占位保留给模型。
export const FORMULA_PLACEHOLDER = '[公式]';

const DEFAULTS = {
  yTolerance: 3,        // 同一行的 y 误差（pt）
  marginRatio: 0.06,    // 上下各 6% 视为页眉页脚
  columnGapRatio: 0.08, // 两栏之间至少这么宽的空隙才判定为双栏
  columnMinGap: 10,     // 两段文字之间至少这么宽才当成两栏（pt）
  fragmentGap: 10,      // 内容流里允许拼成同一行的最大间隙；栏内 justified 碎片后面再拼回
  lineJoinGap: 15,      // 栏检测后，同一栏内拼回被 justified 间隙拆开的碎片
  paragraphGapRatio: 1.6, // 行距超过 1.6 倍行高视为新段落
  tableMinRows: 3,      // 连续多少行才当作表格
  tableCellMaxChars: 40, // 单元格超过这个长度就不按表格拆
  tableXAlign: 12       // 同一列单元格起始 x 允许的误差（pt）
};

function textOfFragments(fragments) {
  let out = '';
  let prev = null;
  for (const frag of fragments) {
    const str = String(frag.str || '');
    if (!str || frag.sup) continue;
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

// 片段 → 行：按内容流顺序拼行，行内按 x 排序。
// 内容流顺序本身就是「一行一行、一栏一栏」的；先按 y 全局聚类会把左右两栏
// 同一行的文字拼成一句（中文期刊实测会串栏）。栏内被 justified 间隙拆开的
// 碎片由 orderColumns 的 mergeSameLineFragments() 再拼回。
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
    const h = Number(item.height) || 0;
    const frag = { x, y, w, h, str };
    const sameLine = current
      && Math.abs(current.y - y) <= o.yTolerance
      && x >= current.startX - 4
      && x - current.endX <= o.fragmentGap;
    // 小字号上标（km² 的 2、引用编号）基线比正文高几 pt：并进当前行，
    // 在 textOfFragments 里跳过，避免把上标数字留在正文里或拆成孤块。
    const superscript = !sameLine && current
      && Math.abs(current.y - y) <= 6
      && h > 0
      && current.size > 0
      && h < current.size * 0.7
      && x >= current.startX
      && x - current.endX <= o.fragmentGap + 4;
    if (sameLine || superscript) {
      current.items.push(superscript ? { ...frag, sup: true } : frag);
      current.endX = Math.max(current.endX, x + w);
      current.size = Math.max(current.size, h);
    } else {
      current = { y, startX: x, endX: x + w, size: h, items: [frag] };
      lines.push(current);
    }
  }
  return lines
    .map((line) => {
      const first = line.items[0];
      const last = line.items[line.items.length - 1];
      const x0 = first.x;
      const x1 = last.w > 0 ? last.x + last.w : last.x + String(last.str).length * 5;
      const size = Math.max(...line.items.map((frag) => frag.h || 0));
      return { y: line.y, x0: x0, x1: x1, size: size, text: textOfFragments(line.items) };
    })
    .filter((line) => line.text);
}

// 栏起始位置聚类：正文每行都从同一 x 开始，缩进最多几十 pt。
// 用「出现次数足够多的行首 x」作为栏中心，比按空白带切更抗跨栏标题：
// 标题会横跨多栏，但它的行首仍然只有一个，空白带法会被标题连成一片。
// 出现次数按页内行数取 5%，避免把图注、页码这类一两行的缩进当成新栏。
function columnStartCenters(lines, pageWidth, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (!lines || lines.length < 6) return [];
  const xs = lines.map((line) => line.x0).sort((a, b) => a - b);
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
  const minCount = Math.max(2, Math.ceil(lines.length * 0.05));
  const centers = clusters
    .filter((cluster) => cluster.n >= minCount)
    .map((cluster) => cluster.sum / cluster.n)
    .sort((a, b) => a - b);
  const minGap = Math.max(100, pageWidth * 0.12);
  const out = [];
  for (const center of centers) {
    if (!out.length || center - out[out.length - 1] > minGap) out.push(center);
  }
  return out.length >= 2 && out.length <= 4 ? out : [];
}

// 按最近的栏中心分组，栏内从上到下；跨整页宽的标题单独放最前面。
function orderByCenters(lines, centers, pageWidth) {
  const spanning = lines.filter((line) => line.x1 - line.x0 > pageWidth * 0.5);
  const body = lines.filter((line) => line.x1 - line.x0 <= pageWidth * 0.5);
  const groups = centers.map(() => []);
  for (const line of body) {
    let best = 0;
    let distance = Infinity;
    for (let i = 0; i < centers.length; i += 1) {
      const next = Math.abs(line.x0 - centers[i]);
      if (next < distance) { distance = next; best = i; }
    }
    groups[best].push(line);
  }
  const out = spanning.slice().sort((a, b) => b.y - a.y);
  for (const group of groups) {
    group.sort((a, b) => b.y - a.y);
    out.push(...group);
  }
  return out;
}

// 按「行首落在哪一栏的起点之后」约定碎片属于哪一栏，而不是最近中心：
// 行中间被 justified 拆出的碎片（x 已经靠近下一栏）仍然属于它出发的那一栏。
function columnIndexOf(x, centers, tol) {
  let best = 0;
  for (let i = 0; i < centers.length; i += 1) {
    if (x + tol >= centers[i]) best = i;
  }
  return best;
}

function bandIndexOf(x, bands) {
  for (let i = 0; i < bands.length; i += 1) {
    if (x >= bands[i][0] - 2 && x <= bands[i][1] + 2) return i;
  }
  return -1;
}

// 同一栏内被 justified 间隙拆开的行碎片（"submerged" + "natural"）在栏检测后拼回。
// 只合并相邻、同 y、同栏且间隙接近词间距的碎片；左右栏间距也是 12pt，
// 所以必须靠「同栏」判断，不能放宽 itemsToLines 的全局阈值。
function mergeSameLineFragments(lines, columnOf, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    const gap = last ? line.x0 - last.x1 : Infinity;
    if (last
        && columnOf(last) === columnOf(line)
        && Math.abs(last.y - line.y) <= o.yTolerance
        && gap >= -2
        && gap <= o.lineJoinGap) {
      const needSpace = gap > 1.5
        && !/\s$/.test(last.text)
        && !/^\s/.test(line.text)
        && !/^[,.;:!?，。；：！？)\]]/.test(line.text);
      last.text = (last.text + (needSpace ? ' ' : '') + line.text).replace(/\s+/g, ' ').trim();
      last.x1 = Math.max(last.x1, line.x1);
      continue;
    }
    out.push({ ...line });
  }
  return out;
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
  const centers = columnStartCenters(lines, pageWidth, o);
  if (centers.length) {
    const tol = Math.max(6, pageWidth * 0.01);
    const merged = mergeSameLineFragments(lines, (line) => columnIndexOf(line.x0, centers, tol), o);
    return orderByCenters(merged, centers, pageWidth);
  }
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
    return mergeSameLineFragments(out, (line) => bandIndexOf(line.x0, bands), o);
  }
  const mid = pageWidth / 2;
  const left = lines.filter((line) => line.x0 < mid - pageWidth * 0.02);
  const right = lines.filter((line) => line.x0 >= mid - pageWidth * 0.02);
  if (!left.length || !right.length) return mergeSameLineFragments(lines, () => 0, o);
  const leftMax = Math.max(...left.map((line) => line.x1));
  const rightMin = Math.min(...right.map((line) => line.x0));
  if (rightMin - leftMax < pageWidth * o.columnGapRatio) return mergeSameLineFragments(lines, () => 0, o);
  return mergeSameLineFragments(
    left.sort((a, b) => b.y - a.y).concat(right.sort((a, b) => b.y - a.y)),
    (line) => (line.x0 < mid ? 0 : 1),
    o
  );
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
  let prevSize = null;
  for (const line of lines) {
    if (line.breakBefore && current) {
      out.push(current);
      current = null;
      prevY = null;
      prevX0 = null;
      prevSize = null;
    }
    const gap = prevY == null ? 0 : prevY - line.y;
    const lineHeight = 12;
    const bullet = BULLET_RE.test(line.text);
    const xJump = prevX0 != null && Math.abs(line.x0 - prevX0) > 40;
    // 字号明显变化（标题 / 表头 vs 正文）单独成段，避免「作者名 + 正文」粘在一起
    const sizeJump = prevSize != null && line.size
      && Math.abs(line.size - prevSize) > Math.max(1.5, prevSize * 0.12);
    // gap < -1：y 变大，说明从上一栏末尾跳到了新栏开头，必须断段
    if (current && (gap > lineHeight * o.paragraphGapRatio || gap < -1 || xJump || bullet || sizeJump)) {
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
    prevSize = line.size;
  }
  if (current) out.push(current);
  return out
    .map((block) => {
      const text = block.text.replace(/\s+/g, ' ').trim();
      return { ...block, text: text, noTranslate: isFormulaOnly(text) };
    })
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

// 文本清洗：LaTeX 公式残渣本地占位，脚注标记从正文剥离。
// opts.dropTexts：跨页重复的页眉/页脚整行，拼行后按行过滤。
export function stripLatexArtifacts(text) {
  // 有些 PDF（arXiv 上的 LaTeX 论文）把公式转成图片后，把 base64 数据留在文本层里。
  // 公式位置换成 [公式] 占位：可读，且公式块不会送翻译。
  let out = String(text)
    .replace(/<latexitsha1_base64="[^"]*">/g, ' ' + FORMULA_PLACEHOLDER + ' ')
    .replace(/<latexit[^>]*>/g, ' ' + FORMULA_PLACEHOLDER + ' ')
    .replace(/<\/latexit>/g, ' ');
  // 纯 base64 长串（≥60 字符）不是正文
  out = out.replace(/\S{60,}/g, (token) => (/^[A-Za-z0-9+/=]+$/.test(token) ? ' ' + FORMULA_PLACEHOLDER + ' ' : token));
  out = out.replace(/\s+/g, ' ').trim();
  // 同一位置可能同时命中多个标签 / base64，只留一个占位
  out = out.replace(/(?:\[公式\]\s*){2,}/g, FORMULA_PLACEHOLDER);
  return out.trim();
}

// 脚注 / 参考文献标记：正文只留句子，标记本身不参与翻译。
// 只处理方括号数字和 Unicode 上标，避免误伤 [A]、[注] 这类正文。
export function stripFootnoteMarkers(text) {
  return String(text)
    .replace(/\s*\[\d{1,3}(?:\s*[-–,，]\s*\d{1,3})*\]/g, '')
    .replace(/(?<=[\p{L}\p{N}])\s*[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu, '')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isFormulaOnly(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value || !value.includes(FORMULA_PLACEHOLDER)) return false;
  return value.replace(/\[公式\]/g, '').replace(/[\s,.;:!?，。；：！？、\-–—()（）]+/g, '') === '';
}

// 复杂页提示：块太大（合并风险）或碎块太多（顺序风险）时只提示，不静默切。
// 目录条目 / 表格单元格本身就该一块一块出现，不参与「碎块太多」判断。
export function isComplexPage(blocks) {
  const list = blocks || [];
  if (!list.length) return false;
  const chars = list.reduce((sum, block) => sum + String(block.text || '').length, 0);
  if (list.length <= 2 && chars > PDF_LONG_BLOCK_LIMIT) return true;
  const prose = list.filter((block) => block.kind !== 'toc' && block.kind !== 'table-cell');
  if (prose.length < 40) return false;
  const short = prose.filter((block) => String(block.text || '').length < 80).length;
  return short / prose.length >= 0.8;
}

function cleanLineText(text) {
  return stripFootnoteMarkers(stripLatexArtifacts(text));
}

// 印刷版目录页：大量「. . . .」点线 + 右侧页码。页码只是目录条目的一部分，
// 不能当成第二栏；否则所有标题会先输出、所有页码后输出，条目对不上。
function looksLikePrintedToc(lines) {
  if (!lines || lines.length < 6) return false;
  let dotted = 0;
  let numbers = 0;
  for (const line of lines) {
    const text = String(line.text || '').trim();
    if (/\.\s*\.\s*\./.test(text)) dotted += 1;
    if (/^\d{1,4}$/.test(text)) numbers += 1;
  }
  // 有些目录把页码直接写在条目末尾（没有独立数字行），点线足够多也算目录
  return dotted >= 5 || (dotted >= 3 && numbers >= 3);
}

// 目录条目：标题换行（以 and / 小写开头）并回上一条；页码行接到条目末尾。
function tocBlocks(lines, pageWidth) {
  const out = [];
  let current = null;
  const hasTrailingPage = (text) => /(?:\.{2,}|…)\s*\d{1,4}$/.test(text) || /\s{3,}\d{1,4}$/.test(text);
  const rightPage = (line) => !pageWidth || line.x0 >= pageWidth * 0.5;
  const heading = /^(?:Contents|Table of Contents|目录)$/i;
  for (const line of lines.slice().sort((a, b) => b.y - a.y || a.x0 - b.x0)) {
    const text = String(line.text || '').trim();
    if (!text) continue;
    if (heading.test(text)) {
      if (current) out.push(current);
      out.push({ text: text, y: line.y });
      current = null;
      continue;
    }
    // 右侧的纯数字才是页码；左侧的纯数字是章编号，要作为下一条标题的前缀。
    if (/^\d{1,4}$/.test(text) && rightPage(line)) {
      if (current) {
        current.text = (current.text + ' ' + text).trim();
        out.push(current);
        current = null;
      } else {
        out.push({ text: text, y: line.y });
      }
      continue;
    }
    const startsEntry = /^\d+(?:\.\d+)*\s/.test(text)
      || /^(?:Foreword|Preface|Contents|Index|Appendix|References|Bibliography|Glossary|Acknowledg(?:e)?ments)\b/i.test(text);
    const sectionNumber = /^\d+(?:\.\d+)*$/.test(current ? current.text : '');
    if (current && (!startsEntry || sectionNumber) && !hasTrailingPage(current.text)) {
      current.text = (current.text + ' ' + text).trim();
    } else {
      if (current) out.push(current);
      current = { text: text, y: line.y };
    }
    if (hasTrailingPage(text)) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out
    .map((block) => {
      const text = block.text.replace(/\s+/g, ' ').trim();
      return { ...block, text: text, kind: 'toc', noTranslate: isFormulaOnly(text) };
    })
    .filter((block) => block.text.length > 1);
}

// 表格：单元格之间的空隙远大于词间距，itemsToLines 会把同一行的每个单元格
// 拆成独立行对象（x 不同、y 相同）。这里按 y 聚成行，再做保守判定：
// - 连续 ≥ tableMinRows 行，每行 2–6 个单元格；
// - 每行单元格数相同、列起始 x 对齐；
// - 单元格都很短，且不是上一行的续句（避免把多栏正文误判成表格）。
// 只对单栏页启用；多栏页保持原来的栏顺序，宁可不洗也不串栏。
function tableRows(lines, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const sorted = lines.slice().sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const rows = [];
  for (const line of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - line.y) <= o.yTolerance) last.cells.push(line);
    else rows.push({ y: line.y, cells: [line] });
  }
  for (const row of rows) row.cells.sort((a, b) => a.x0 - b.x0);
  const candidate = (row) => {
    if (row.cells.length < 2 || row.cells.length > 6) return false;
    return row.cells.every((cell) => {
      const text = cell.text.trim();
      return text.length > 0 && text.length <= o.tableCellMaxChars;
    });
  };
  const continues = (prev, next) => {
    for (let i = 0; i < prev.cells.length; i += 1) {
      const a = prev.cells[i].text.trim();
      const b = next.cells[i].text.trim();
      if (!a || !b) continue;
      if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return true;
      if (!/[.!?。！？:：;；]$/.test(a) && /^[a-z]/.test(b)) return true;
    }
    return false;
  };
  const aligned = (a, b) => a.cells.every((cell, i) => Math.abs(cell.x0 - b.cells[i].x0) <= o.tableXAlign);
  // 数据表通常至少有一列数字；纯文字多栏正文没有。没有数字的「表格」宁可
  // 不拆，避免把 4 栏正文按行读成表格（列顺序比表格清洗更重要）。
  const numericCell = (text) => /\d/.test(text) && /^[\s\d.,%+\-–—/()]+$/.test(text);
  const looksLikeData = (rows) => {
    const data = rows.slice(1);
    if (!data.length) return false;
    const numeric = data.filter((row) => row.cells.some((cell) => numericCell(cell.text.trim()))).length;
    return numeric >= Math.ceil(data.length * 0.8);
  };
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= o.tableMinRows && looksLikeData(run)) out.push(...run);
    run = [];
  };
  for (const row of rows) {
    if (!candidate(row)) { flush(); continue; }
    if (!run.length) { run = [row]; continue; }
    const prev = run[run.length - 1];
    if (prev.cells.length !== row.cells.length || !aligned(prev, row) || continues(prev, row)) {
      flush();
      run = [row];
    } else {
      run.push(row);
    }
  }
  flush();
  return out;
}

function hasMultipleColumns(lines, pageWidth, opts) {
  return columnStartCenters(lines, pageWidth, opts).length > 0 || detectColumns(lines, pageWidth, opts).length > 0;
}

// 单栏页：把表格行按 y 插回段落之间，同一行的单元格从左到右各成一块。
function mergeTableBlocks(proseBlocks, rows) {
  const entries = [];
  for (const block of proseBlocks) entries.push({ y: block.y, table: 0, blocks: [block] });
  for (const row of rows) {
    entries.push({
      y: row.y,
      table: 1,
      blocks: row.cells.map((cell) => ({
        text: cell.text,
        y: cell.y,
        kind: 'table-cell',
        noTranslate: isFormulaOnly(cell.text)
      }))
    });
  }
  entries.sort((a, b) => b.y - a.y || a.table - b.table);
  const out = [];
  for (const entry of entries) out.push(...entry.blocks);
  return out;
}

export function pageBlocks(textContent, viewport, opts) {
  const drop = (opts && opts.dropTexts) || [];
  const dropSet = drop.map((text) => normalizeForCompare(text)).filter(Boolean);
  const width = Number(viewport && viewport.width) || 595;
  const height = Number(viewport && viewport.height) || 842;
  let lines = dropMargins(itemsToLines((textContent && textContent.items) || [], opts), height, opts);
  lines = lines
    .map((line) => ({ ...line, text: cleanLineText(line.text) }))
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
  // 目录页逐条输出，不参与栏 / 表格重排；标题换行合并，页码行接到条目末尾
  if (looksLikePrintedToc(lines)) {
    return tocBlocks(lines, width);
  }
  // 表格只在单栏页拆：多栏页把表格列当页面栏排序会更糟，保持现状。
  const rows = tableRows(lines, opts);
  if (rows.length) {
    const tableSet = new Set();
    for (const row of rows) for (const cell of row.cells) tableSet.add(cell);
    const prose = lines.filter((line) => !tableSet.has(line));
    if (!hasMultipleColumns(prose, width, opts)) {
      // 表格前后的正文不能跨过表格并成一段
      const all = lines.slice().sort((a, b) => b.y - a.y);
      let prevTable = false;
      for (const line of all) {
        if (tableSet.has(line)) { prevTable = true; continue; }
        if (prevTable) line.breakBefore = true;
        prevTable = false;
      }
      const ordered = prose.slice().sort((a, b) => b.y - a.y);
      return mergeTableBlocks(groupParagraphs(ordered, opts), rows);
    }
  }
  const ordered = orderColumns(lines, width, opts);
  return groupParagraphs(ordered, opts);
}
