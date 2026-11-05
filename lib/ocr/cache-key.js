// OCR 结果缓存键：纯函数。区分原书、页码、后端、引擎 / 模型版本和识别参数；
// 刻意不含翻译目标语言、风格、服务商——切翻译配置不应重复识别同一张原图（PDF-HANDOFF §5.3 第 3 步）。
// v2（0.17.1）：缓存的文本块带版式预览定位（layoutLines）；v1 记录没有位置，换版本后重新识别一次。
export const OCR_CACHE_VERSION = 'ocr-v2';

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// params：影响识别结果的输入参数（语言、渲染倍率、设备偏好等）。键顺序不影响结果。
export function ocrParamsFingerprint(params) {
  const src = params && typeof params === 'object' ? params : {};
  const sorted = {};
  for (const key of Object.keys(src).sort()) {
    const value = src[key];
    sorted[key] = Array.isArray(value) ? value.slice().map(String).sort() : value;
  }
  return fnv1a(JSON.stringify(sorted));
}

// { bookId, page, backend, engine: { name, version, model }, params } → 'ocr-v2|book|page:N|backend|name@version|model|fp'
export function ocrCacheKey({ bookId, page, backend, engine, params }) {
  const n = Number(page);
  if (!bookId || !Number.isInteger(n) || n < 1) throw new TypeError('ocrCacheKey 需要 bookId 与从 1 开始的页码');
  if (!backend) throw new TypeError('ocrCacheKey 需要 backend');
  const e = engine || {};
  return [
    OCR_CACHE_VERSION, String(bookId), 'page:' + n, String(backend),
    String(e.name || '') + '@' + String(e.version || ''), String(e.model || ''),
    ocrParamsFingerprint(params)
  ].join('|');
}
