export const PDF_RASTER_LIMITS = Object.freeze({ pagePixels: 4 * 1024 * 1024, totalPixels: 16 * 1024 * 1024, maxDimension: 8192 });

export function boundedPdfScale(width, height, scale = 1) {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) throw new Error('PDF 页面尺寸无效');
  const wanted = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const factor = Math.min(wanted, Math.sqrt(PDF_RASTER_LIMITS.pagePixels / width / height), PDF_RASTER_LIMITS.maxDimension / width, PDF_RASTER_LIMITS.maxDimension / height);
  return { scale: factor, limited: factor < wanted };
}

export function createRasterBudget() {
  const canvases = new Map();
  let pixels = 0;
  function release(canvas) {
    const entry = canvases.get(canvas);
    if (!entry) return;
    canvases.delete(canvas); pixels -= entry.pixels;
    entry.evict?.();
    canvas.width = 0; canvas.height = 0;
  }
  return {
    reserve(canvas, width, height, evict) {
      release(canvas);
      const size = width * height;
      if (!Number.isSafeInteger(size) || size <= 0 || size > PDF_RASTER_LIMITS.pagePixels) throw new Error('PDF 页面超出预览上限');
      while (pixels + size > PDF_RASTER_LIMITS.totalPixels) release(canvases.keys().next().value);
      canvases.set(canvas, { pixels: size, evict }); pixels += size;
      canvas.width = width; canvas.height = height;
    },
    touch(canvas) { const entry = canvases.get(canvas); if (entry) { canvases.delete(canvas); canvases.set(canvas, entry); } },
    release,
    clear() { for (const canvas of canvases.keys()) release(canvas); },
    get pixels() { return pixels; }
  };
}
