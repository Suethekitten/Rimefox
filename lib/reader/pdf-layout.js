// Conservative, raster-backed layout preview. No PDF source bytes are changed.
// Complex backgrounds and unplaceable text stay visible in the original page.
export function layoutRect(block, viewport) {
  const lines = block.layoutLines;
  if (!lines?.length || block.noTranslate || block.text.includes('[公式]')) return null;
  const x = Math.min(...lines.map((line) => line.x0)) - 1.5;
  const right = Math.max(...lines.map((line) => line.x1)) + 1.5;
  const top = Math.max(...lines.map((line) => line.y + line.size)) + 1.5;
  const bottom = Math.min(...lines.map((line) => line.y - line.size * 0.25)) - 1.5;
  const rect = { x, y: viewport.height - top, width: right - x, height: top - bottom,
    fontSize: Math.min(...lines.map((line) => line.size)) };
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || rect.fontSize <= 0
      || rect.x < 0 || rect.y < 0 || right > viewport.width || rect.y + rect.height > viewport.height) return null;
  return rect;
}

// Require a nearly uniform perimeter and mostly solid interior, not a guessed white rectangle.
export function flatBackground(image, rect, { stroke = 4 } = {}) {
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
  if (edges.filter((p) => distance(p, color) <= 10).length < edges.length * 0.98) return null;
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
