// Conservative, raster-backed layout preview. No PDF source bytes are changed.
// Complex backgrounds and unplaceable text stay visible in the original page.
export function layoutRect(block, viewport) {
  const lines = block.layoutLines;
  if (!lines?.length || block.noTranslate || block.text.includes('[公式]')) return null;
  const { angle, bounds } = lines[0];
  if (lines.some((line) => line.angle !== angle) || (angle === null && !bounds)) return null;
  const left = (bounds?.x0 ?? Math.min(...lines.map((line) => line.x0))) - 1.5;
  const right = (bounds?.x1 ?? Math.max(...lines.map((line) => line.x1))) + 1.5;
  const top = (bounds?.y1 ?? Math.max(...lines.map((line) => line.y + line.size))) + 1.5;
  const bottom = (bounds?.y0 ?? Math.min(...lines.map((line) => line.y - line.size * 0.25))) - 1.5;
  // OCR 坐标已经基于旋转后的位图。文字层先从行轴转回 PDF 用户空间，再经视口投影。
  const [a, b, c, d, e, f] = (angle !== undefined && viewport.transform) || [1, 0, 0, -1, 0, viewport.height];
  const project = (u, v) => {
    const x = angle ? -Math.sign(angle) * v : u;
    const y = angle ? Math.sign(angle) * u : v;
    return [a * x + c * y + e, b * x + d * y + f];
  };
  const [x0, y0] = project(left, top);
  const [x1, y1] = project(right, bottom);
  const rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
    // OCR 行的 fontSize 是墨迹高度，和补边后的框高分开计算。
    fontSize: Math.min(...lines.map((line) => line.fontSize || line.size)) * Math.hypot(a, b) };
  const outside = rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height;
  const rotation = angle !== undefined && angle !== null ? ((viewport.rotation || 0) - angle + 360) % 360 : 0;
  const blocked = angle === null || ((angle || rotation) && outside);
  if (blocked) {
    rect.width = Math.min(viewport.width, rect.x + rect.width) - Math.max(0, rect.x);
    rect.height = Math.min(viewport.height, rect.y + rect.height) - Math.max(0, rect.y);
    rect.x = Math.max(0, rect.x);
    rect.y = Math.max(0, rect.y);
  } else if (outside) return null;
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || rect.fontSize <= 0
      || rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) return null;
  if (blocked) rect.blocked = true;
  if (rotation) rect.rotation = rotation;
  return rect;
}

export function layoutRectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Require a nearly uniform perimeter and mostly solid interior, not a guessed white rectangle.
export function flatBackground(image, rect, { stroke = 4, edgeShare = 0.98, tolerance = 10 } = {}) {
  const { data, width, height } = image;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width - 1, Math.ceil(rect.x + rect.width)), y1 = Math.min(height - 1, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const pixel = (x, y) => { const at = (y * width + x) * 4; return [data[at], data[at + 1], data[at + 2]]; };
  const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const edges = [];
  const stepX = Math.max(1, Math.ceil((x1 - x0) / 80)), stepY = Math.max(1, Math.ceil((y1 - y0) / 80));
  for (let x = x0; x <= x1; x += stepX) { edges.push(pixel(x, y0), pixel(x, y1)); }
  for (let y = y0; y <= y1; y += stepY) { edges.push(pixel(x0, y), pixel(x1, y)); }
  const color = [0, 1, 2].map((i) => edges.map((p) => p[i]).sort((a, b) => a - b)[Math.floor(edges.length / 2)]);
  if (edges.filter((p) => distance(p, color) <= tolerance).length < edges.length * edgeShare) return null;
  // Dense CJK text alone can cover more than 28% of its box. Pixels that are not background
  // still pass when they are strokes (background within `stroke` px, which callers scale with
  // the font size); a filled box or a picture has deep interior pixels and is rejected.
  const reach = Math.max(1, Math.round(stroke));
  const nearBackground = (x, y) => {
    for (let d = 1; d <= reach; d += 1) {
      for (const [nx, ny] of [[x - d, y], [x + d, y], [x, y - d], [x, y + d]]) {
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && distance(pixel(nx, ny), color) <= 12) return true;
      }
    }
    return false;
  };
  let solid = 0, strokes = 0, total = 0;
  for (let y = y0; y <= y1; y += stepY) for (let x = x0; x <= x1; x += stepX) {
    total += 1;
    if (distance(pixel(x, y), color) <= 12) solid += 1;
    else if (nearBackground(x, y)) strokes += 1;
  }
  if (solid / total >= 0.72) return color;
  return solid / total >= 0.5 && (solid + strokes) / total >= 0.97 ? color : null;
}

// Grow a rect by `margin` on every side; null when it would leave the page or touch another block.
export function expandLayoutRect(rect, margin, rects, viewport) {
  const g = { ...rect, x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
  if (g.x < 0 || g.y < 0 || g.x + g.width > viewport.width || g.y + g.height > viewport.height) return null;
  return rects.some((o) => o && o !== rect && layoutRectsOverlap(o, g)) ? null : g;
}

// Free space a translation may grow into when it would otherwise shrink far below the source size:
// right to the column edge (blocks sharing this left edge), down to just above the next block in
// that column, at most three times the original height. Returns null when nothing can grow or the
// grown box would touch another block; the caller still checks the grown area is the same flat colour.
export function growLayoutRect(rect, rects, viewport) {
  const others = rects.filter((o) => o && o !== rect);
  const bottom = rect.y + rect.height;
  let right = rect.x + rect.width;
  for (const o of others) if (!o.rotation && !o.blocked && Math.abs(o.x - rect.x) <= 6) right = Math.max(right, o.x + o.width);
  right = Math.min(right, viewport.width);
  let limit = Math.min(viewport.height, rect.y + rect.height * 3);
  for (const o of others) if (o.y >= bottom - 0.5 && o.x < right && o.x + o.width > rect.x) limit = Math.min(limit, o.y - 2);
  const grown = { ...rect, width: right - rect.x, height: Math.max(rect.height, limit - rect.y) };
  if (grown.width <= rect.width + 0.5 && grown.height <= rect.height + 0.5) return null;
  return others.some((o) => layoutRectsOverlap(o, grown)) ? null : grown;
}

// OCR 行框四周各补了一截晕边（lib/ocr/layout.js 的 OCR_BOX_PAD），上下两块靠得近时补边之和会超过两块的间距，
// 原框就互相重叠：后画的块盖住前一块的末行。左右有交叠、上下重叠的两块，从重叠区中线各让一半（各留 0.5 单位缝），
// 保持补边对称；一块完全落在另一块里等无法判断上下关系的情况不动。返回新数组，不改入参。
// 只处理「上下叠放」的两块：水平交叠须超过较窄一块宽度的一半。窄栏距的双栏扫描页，左右两栏的补边也会交叠几个单位，
// 那是并排而不是上下，若从中线切开，两块的框边都会切过正文，底色检查失败、整段退回原文（0.17.2 回归）。
export function separateLayoutRects(rects) {
  const out = rects.map((r) => (r ? { ...r } : r));
  for (let a = 0; a < out.length; a += 1) {
    for (let b = a + 1; b < out.length; b += 1) {
      const A = out[a], B = out[b];
      if (!A || !B || A.rotation || B.rotation || A.blocked || B.blocked) continue;
      const shared = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x);
      if (shared <= Math.min(A.width, B.width) * 0.5) continue;
      const [top, low] = A.y <= B.y ? [A, B] : [B, A];
      const overlap = top.y + top.height - low.y;
      if (overlap <= 0 || low.y + low.height <= top.y + top.height || low.y <= top.y) continue;
      const mid = low.y + overlap / 2;
      top.height = mid - 0.5 - top.y;
      const bottom = low.y + low.height;
      low.y = mid + 0.5;
      low.height = bottom - low.y;
    }
  }
  return out.map((r) => (r && (r.height <= 0 || r.width <= 0) ? null : r));
}
