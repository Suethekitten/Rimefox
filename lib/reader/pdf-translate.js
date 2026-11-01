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

// 超长块（默认 1500 字）在送翻前按句末标点切开，避免整段丢给模型导致质量崩。
export function splitLongText(text, limit = 1500) {
  const value = String(text == null ? '' : text);
  if (value.length <= limit) return [value];
  const parts = [];
  let rest = value;
  while (rest.length > limit) {
    const windowText = rest.slice(0, limit + 1);
    let cut = 0;
    // 中文句号后通常没有空格，英文句号要跟空格/结尾才算句末（避免切小数）
    const re = /[。！？]|[.!?](?=\s|$)/g;
    let match = null;
    while ((match = re.exec(windowText))) {
      const end = match.index + 1;
      if (end <= limit) cut = end;
    }
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter((part) => part.length);
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
    const pending = new Map();
    for (let i = 0; i < blocks.length; i += 1) {
      const text = String(blocks[i].text || '').trim();
      if (!text) continue;
      const key = 'pdf|' + bookId + '|page:' + page.pageNo + '|' + i + '|' + hashText(text);
      let cached = null;
      try { cached = await getTranslation(key); } catch (err) { cached = null; }
      if (cached && typeof cached.translated === 'string' && cached.translated.trim()) {
        out[i] = cached.translated;
        continue;
      }
      pending.set(i, { index: i, key: key, source: text, parts: [] });
      for (const chunk of splitLongText(text)) {
        todo.push({ blockIndex: i, key: key, text: chunk });
      }
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
        const item = pending.get(group[i].blockIndex);
        if (item) item.parts.push(value.trim());
      }
    }
    for (const item of pending.values()) {
      const joined = item.parts.join(' ').trim();
      if (!joined) continue;
      out[item.index] = joined;
      translated += 1;
      try {
        await putTranslation({
          key: item.key,
          bookId: bookId,
          sectionId: 'page:' + page.pageNo,
          contentHash: hashText(item.source),
          targetLang: target || '',
          style: style,
          intensity: 'standard',
          provider: '',
          model: '',
          source: item.source,
          translated: joined,
          updatedAt: Date.now()
        });
      } catch (err) { /* 缓存失败不影响展示 */ }
    }
    if (translated) this.onStatus({ translated: translated });
    return out;
  }
}
