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
export function flatBackground(image, rect) {
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
  let solid = 0, total = 0;
  for (let y = y0; y <= y1; y += stepY) for (let x = x0; x <= x1; x += stepX) {
    total += 1; if (distance(pixel(x, y), color) <= 12) solid += 1;
  }
  return solid / total >= 0.72 ? color : null;
}
