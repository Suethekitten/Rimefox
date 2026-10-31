// PDF 页翻译：按块分批发送，复用 reader 的 IndexedDB 译文缓存。
// 与 EPUB 的 ReaderTranslator 分开：PDF 没有 DOM 单元，译文由调用方渲染。
import { getTranslation, putTranslation } from './store.js';

const MAX_UNITS = 16;
const MAX_CHARS = 3600;

function hashText(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : (res || { ok: false }));
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

function batch(items) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const length = item.text.length;
    if (current.length && (current.length >= MAX_UNITS || chars + length > MAX_CHARS)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += length;
  }
  if (current.length) groups.push(current);
  return groups;
}

export class PdfTranslator {
  constructor({ onStatus } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.epoch = 0;
  }

  stop() {
    this.epoch += 1;
  }

  // 返回与 page.blocks 等长的译文数组（无译文的位置是空串）。
  async translatePage({ bookId, page, target, style = 'plain' }) {
    const epoch = this.epoch;
    const blocks = (page && page.blocks) || [];
    const out = new Array(blocks.length).fill('');
    const todo = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const text = String(blocks[i].text || '').trim();
      if (!text) continue;
      const key = 'pdf|' + bookId + '|page:' + page.pageNo + '|' + i + '|' + hashText(text);
      let cached = null;
      try { cached = await getTranslation(key); } catch (err) { cached = null; }
      if (cached && typeof cached.translated === 'string' && cached.translated.trim()) out[i] = cached.translated;
      else todo.push({ index: i, text: text, key: key });
    }
    let translated = 0;
    for (const group of batch(todo)) {
      if (epoch !== this.epoch) return out;
      const res = await sendMessage({
        type: 'translate',
        texts: group.map((one) => one.text),
        target: target || 'zh-CN',
        style: style,
        noCache: true
      });
      if (!res || res.ok !== true) {
        this.onStatus({ error: (res && res.error) || '翻译请求失败' });
        return out;
      }
      const results = res.results || [];
      for (let i = 0; i < group.length; i += 1) {
        const value = results[i];
        if (typeof value !== 'string' || !value.trim()) continue;
        out[group[i].index] = value;
        translated += 1;
        try {
          await putTranslation({
            key: group[i].key,
            bookId: bookId,
            sectionId: 'page:' + page.pageNo,
            contentHash: hashText(group[i].text),
            targetLang: target || '',
            style: style,
            intensity: 'standard',
            provider: '',
            model: '',
            source: group[i].text,
            translated: value,
            updatedAt: Date.now()
          });
        } catch (err) { /* 缓存失败不影响展示 */ }
      }
    }
    if (translated) this.onStatus({ translated: translated });
    return out;
  }
}
