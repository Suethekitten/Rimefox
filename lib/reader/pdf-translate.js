// PDF 页翻译：按块分批发送，复用 reader 的 IndexedDB 译文缓存。
// 与 EPUB 的 ReaderTranslator 分开：PDF 没有 DOM 单元，译文由调用方渲染。
import { getTranslation, getTranslations, putTranslation } from './store.js';
import { pdfCacheIdentity, PDF_CACHE_VERSION } from './pdf-cache.js';
import { activeConfig } from '../config.js';
import { PDF_LONG_BLOCK_LIMIT, isFormulaOnly } from './pdf-text.js';

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
export function splitLongText(text, limit = PDF_LONG_BLOCK_LIMIT) {
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
  constructor({ onStatus, cache = { get: getTranslation, getMany: getTranslations, put: putTranslation } } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.cache = cache;
    this.epoch = 0;
  }

  stop() {
    this.epoch += 1;
  }

  // 返回与 page.blocks 等长的译文数组；null 表示任务已作废，不能写回视图。
  async translatePage({ bookId, page, target, style = 'plain', config = {} }) {
    if (config.authPaused) {
      this.onStatus({ error: '接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。' });
      return null;
    }
    const epoch = this.epoch;
    const active = activeConfig(config);
    const identity = await pdfCacheIdentity(config, target, style);
    if (epoch !== this.epoch) return null;
    const blocks = (page && page.blocks) || [];
    const out = new Array(blocks.length).fill('');
    const todo = [];
    const pending = new Map();
    const work = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const text = String(blocks[i].text || '').trim();
      if (!text) continue;
      // 公式块 / 只有占位的块不送翻译，避免把 base64 残渣或 [公式] 交给模型
      if (blocks[i].noTranslate || isFormulaOnly(text)) continue;
      const key = [PDF_CACHE_VERSION, bookId, 'page:' + page.pageNo, i, identity, hashText(text)].join('|');
      work.push({ index: i, text: text, key: key });
    }
    let cachedRows = [];
    try {
      cachedRows = this.cache.getMany
        ? await this.cache.getMany(work.map((one) => one.key))
        : await Promise.all(work.map((one) => this.cache.get(one.key)));
    } catch (err) {
      cachedRows = [];
    }
    if (epoch !== this.epoch) return null;
    for (let n = 0; n < work.length; n += 1) {
      const item = work[n];
      const cached = cachedRows[n];
      if (cached && cached.cacheIdentity === identity && cached.source === item.text
          && typeof cached.translated === 'string' && cached.translated.trim()) {
        out[item.index] = cached.translated;
        continue;
      }
      const chunks = splitLongText(item.text);
      pending.set(item.index, { index: item.index, key: item.key, source: item.text, parts: new Array(chunks.length).fill(null) });
      for (let part = 0; part < chunks.length; part += 1) {
        todo.push({ blockIndex: item.index, part: part, text: chunks[part] });
      }
    }
    let translated = 0;
    // 一页分多批时，某批失败不能丢掉其他批已付费的结果：先把完整的块存进缓存再报错，
    // 重试只补失败的块（QA G4）。
    let failure = null;
    for (const group of batch(todo)) {
      if (epoch !== this.epoch) return null;
      if (failure) break;
      const res = await sendMessage({
        type: 'translate',
        texts: group.map((one) => one.text),
        target: target || 'zh-CN',
        style: style,
        pdfCacheIdentity: identity,
        noCache: true
      });
      if (epoch !== this.epoch) return null;
      if (!res || res.ok !== true) {
        const message = (res && res.error) || '翻译请求失败';
        this.onStatus({ error: message });
        failure = new Error(message);
        if (res && res.errorCode) failure.code = res.errorCode;
        // 鉴权失败 / 配置已变：后面的批次同样会失败，不再继续发送。
        break;
      }
      const results = res.results || [];
      for (let i = 0; i < group.length; i += 1) {
        const value = results[i];
        if (typeof value !== 'string' || !value.trim()) continue;
        const item = pending.get(group[i].blockIndex);
        if (item) item.parts[group[i].part] = value.trim();
      }
    }
    for (const item of pending.values()) {
      if (epoch !== this.epoch) return null;
      // 一块的所有切片成功后才可显示 / 缓存，不能把半段译文永久当成完整结果。
      if (item.parts.some((part) => !part)) continue;
      const joined = item.parts.join(' ').trim();
      if (!joined) continue;
      out[item.index] = joined;
      translated += 1;
      try {
        await this.cache.put({
          key: item.key,
          cacheIdentity: identity,
          bookId: bookId,
          sectionId: 'page:' + page.pageNo,
          contentHash: hashText(item.source),
          targetLang: target || '',
          style: style,
          intensity: 'standard',
          provider: active.provider,
          model: active.model,
          source: item.source,
          translated: joined,
          updatedAt: Date.now()
        });
      } catch (err) { /* 缓存失败不影响展示 */ }
    }
    if (epoch !== this.epoch) return null;
    if (translated) this.onStatus({ translated: translated });
    if (failure) {
      failure.partial = out;
      throw failure;
    }
    return out;
  }
}
