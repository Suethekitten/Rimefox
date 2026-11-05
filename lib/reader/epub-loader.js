import { parseEpubFiles } from './epub.js';
import { EpubError, EPUB_LIMITS } from './epub-zip.js';

export async function loadEpub(buffer, { signal, timeout = EPUB_LIMITS.maxTimeMs } = {}) {
  signal?.throwIfAborted();
  const files = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./epub-unzip-worker.js', import.meta.url), { type: 'module' });
    let timer;
    function finish(err, value) {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate();
      if (err) reject(err); else resolve(value);
    }
    function abort() { finish(signal.reason || new DOMException('Aborted', 'AbortError')); }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new EpubError('timeout', 'EPUB 解压超时，请检查文件后重试。')), timeout);
    worker.onerror = () => finish(new EpubError('not_epub', 'EPUB 解压失败，请检查文件后重试。'));
    worker.onmessage = ({ data }) => finish(data.error ? new EpubError(data.error.code, data.error.message) : null, data.files);
    worker.postMessage(buffer, [buffer]);
  });
  signal?.throwIfAborted();
  return parseEpubFiles(files);
}
