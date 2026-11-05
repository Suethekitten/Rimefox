import { Unzip, UnzipInflate } from '../vendor/fflate.browser.mjs';

export const EPUB_LIMITS = Object.freeze({
  maxEntryBytes: 24 * 1024 * 1024,
  maxTotalBytes: 320 * 1024 * 1024,
  maxCompressionRatio: 180,
  maxEntries: 10000,
  maxTimeMs: 20000
});
export class EpubError extends Error {
  constructor(code, message) { super(message || code); this.name = 'EpubError'; this.code = code; }
}
export function safeName(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  if (!decoded || decoded.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(decoded) || decoded.includes('\0')) {
    throw new EpubError('unsafe_archive', 'EPUB contains an unsafe path');
  }
  return decoded;
}

// Feed bounded compressed chunks. Unlike unzipSync, output allocation does not trust
// attacker-supplied ZIP sizes. The reader runs this code in a terminable Worker too.
export function unpackEpub(input, limits = EPUB_LIMITS) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const files = Object.create(null);
  const started = performance.now();
  let total = 0, count = 0, unfinished = 0, failure;
  const unzip = new Unzip((file) => {
    const name = safeName(file.name);
    if (++count > limits.maxEntries) throw new EpubError('too_large', 'EPUB contains too many entries');
    if (Object.hasOwn(files, name)) throw new EpubError('unsafe_archive', 'Duplicate EPUB path');
    if (file.originalSize > limits.maxEntryBytes) throw new EpubError('too_large', 'EPUB entry is too large');
    if (file.size > 0 && file.originalSize / file.size > limits.maxCompressionRatio) throw new EpubError('unsafe_archive', 'EPUB compression ratio is unsafe');
    let length = 0;
    const chunks = [];
    files[name] = null;
    unfinished += 1;
    file.ondata = (err, data, final) => {
      if (failure) return;
      if (err) { failure = err; return; }
      length += data.length; total += data.length;
      if (length > limits.maxEntryBytes || total > limits.maxTotalBytes) { failure = new EpubError('too_large', 'EPUB expands beyond the limit'); return; }
      if (file.size > 0 && length / file.size > limits.maxCompressionRatio) { failure = new EpubError('unsafe_archive', 'EPUB compression ratio is unsafe'); return; }
      chunks.push(data);
      if (final) {
        if (file.originalSize !== undefined && length !== file.originalSize) { failure = new EpubError('unsafe_archive', 'EPUB entry size does not match'); return; }
        const out = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
        files[name] = out;
        unfinished -= 1;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      if (performance.now() - started > limits.maxTimeMs) throw new EpubError('timeout', 'EPUB 解压超时，请检查文件后重试。');
      unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
      if (failure) throw failure;
    }
    if (!count || unfinished) throw new EpubError('not_epub', 'Incomplete EPUB archive');
    return files;
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError('not_epub', 'This file is not a readable EPUB');
  }
}
