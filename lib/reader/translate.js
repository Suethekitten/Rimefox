// 阅读器翻译调度：复用 content/dom.js 的 collect / inject（行内格式、双语/仅译文、方向），
// 但使用 reader 自己的 book/section 缓存与取消代际。background 只负责模型请求。
import { getTranslation, putTranslation, putFailure } from './store.js';
import { sanitizeXhtml } from './sanitize.js';
import { pdfCacheIdentity } from './pdf-cache.js';

const BATCH_ITEMS = 8;
const BATCH_CHARS = 1000;
const LOOK_AHEAD_SCREENS = 2;
const RETRY_MS = 15000;
// 与 PDF 一致的停留防抖：快速翻章时，只停留不足这么久的章节不发付费请求（QA G9）。
const DWELL_MS = 400;

function hash32(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16) + ':' + s.length;
}

function rectOf(unit) {
  try { return unit.el && unit.el.getBoundingClientRect ? unit.el.getBoundingClientRect() : null; } catch (err) { return null; }
}

function inWindow(rect, ahead) {
  if (!rect || !rect.height) return false;
  const vh = window.innerHeight || 800;
  return rect.bottom >= -vh * 0.2 && rect.top <= vh * (1 + ahead);
}

// 顺序装箱：每种协议只往「最近一组」里放，满了才开新组。
// 以前用 groups.find() 总回到第一个未满组，一旦溢出就每段新开一组，几乎一段一请求（QA G5）。
export function batchOf(units) {
  const groups = [];
  const open = new Map();
  for (const unit of units) {
    const protocol = unit.inlineProtocol || '';
    let group = open.get(protocol);
    if (!group || group.items.length >= BATCH_ITEMS || group.chars >= BATCH_CHARS) {
      group = { protocol, items: [], chars: 0 };
      groups.push(group);
    }
    const text = unit.wire || unit.text || '';
    if (group.items.length && group.chars + text.length > BATCH_CHARS) {
      group = { protocol, items: [], chars: 0 };
      groups.push(group);
    }
    open.set(protocol, group);
    group.items.push(unit);
    group.chars += text.length;
  }
  return groups;
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message, results: [] });
        else resolve(res || { ok: false, error: 'empty response', results: [] });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, results: [] });
    }
  });
}

// 正文和下章预取共用请求字段；各自决定要发送的单元与代际。
function translationMessage(texts, protocol, cfg, identity) {
  const state = window.__DT && window.__DT.state;
  const message = {
    type: 'translate',
    texts,
    target: (state && state.target) || (cfg && cfg.targetLang) || 'zh-CN',
    style: (state && state.style) || 'plain',
    noCache: true
  };
  if (identity) message.pdfCacheIdentity = identity;
  if (protocol) message.inlineProtocol = protocol;
  if (message.style !== 'plain') message.intensity = (state && state.intensity) || 'standard';
  return message;
}

export class ReaderTranslator {
  constructor(opts) {
    this.store = opts.store;
    this.onStatus = opts.onStatus || function () {};
    this.doc = opts.document || document;
    this.root = null;
    this.book = null;
    this.section = null;
    this.cfg = null;
    this.mode = 'original';
    this.units = [];
    this.byKey = new Map();
    this.pending = new Set();
    this.failures = new Map();
    this.generation = 0;
    this.timer = 0;
    this.controller = null;
    this.scrollHandler = null;
    this.active = false;
    this.doc = null;
    this.prefetchSection = '';
    this.prefetchToken = 0;
    this.prefetchPending = false;
    this.identity = '';
  }

  async configure(cfg) {
    this.cfg = cfg || {};
    const DT = window.__DT;
    if (!DT || !DT.state) return;
    const previous = this.identity;
    DT.state.config = cfg || {};
    const info = (cfg && cfg.activeLanguage) || null;
    const target = info && info.value ? info.value : ((cfg && cfg.targetLang) || 'zh-CN');
    DT.state.target = target;
    DT.state.langInfo = info;
    DT.state.targetCode = (info && info.code) || target;
    DT.state.selectedStyle = (cfg && cfg.funStyle) || 'plain';
    DT.state.style = (cfg && cfg.funStyle) || 'plain';
    DT.state.intensity = (cfg && cfg.funIntensity) || 'standard';
    DT.state.mode = this.mode === 'translation' ? 'translation' : 'dual';
    // 与 PDF 共用的配置身份：请求带上它，后台发现设置页已换模型 / 术语等就拒绝，
    // 新配置的结果不会写进旧配置的缓存键（QA G1）。
    try { this.identity = await pdfCacheIdentity(this.cfg, target, DT.state.style); } catch (err) { this.identity = ''; }
    if (previous && this.identity !== previous && this.units.length) this.rekey();
    this.onStatus({ hasKey: !!(cfg && cfg.hasKey), target: DT.state.targetCode });
  }

  // 配置变化：丢弃在途结果，按新配置重算每段的缓存键；不主动发请求，滚动或「翻译本章」时才按新配置翻译。
  rekey() {
    this.generation += 1;
    this.pending.clear();
    this.failures.clear();
    this.prefetchToken += 1;
    this.prefetchSection = '';
    this.prefetchPending = false;
    this.byKey.clear();
    for (const unit of this.units) {
      unit.__readerKey = this.keyFor(unit, unit.__readerHash);
      this.byKey.set(unit.__readerKey, unit);
    }
  }

  async start(book, section, root, mode) {
    this.stop();
    this.book = book;
    this.section = section;
    this.root = root;
    this.mode = mode === 'parallel' ? 'translation' : (mode || 'original');
    this.active = true;
    const DT = window.__DT;
    if (DT && DT.state) DT.state.mode = this.mode === 'translation' ? 'translation' : 'dual';
    if (this.mode === 'original') {
      this.onStatus({ mode: this.mode });
      return;
    }
    if (this.sameLanguage()) {
      this.onStatus({ sameLanguage: true, mode: this.mode });
      return;
    }
    // 重新打开 / 切章是用户动作：上一轮的失败退避不应挡住已缓存的译文（QA G8）。
    this.failures.clear();
    await this.collect();
    this.bindScroll();
    // 已缓存的译文立即显示；需要付费请求的部分等停留满 DWELL_MS 再发。
    this.schedule({ cacheOnly: true });
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = 0;
      if (generation !== this.generation) return;
      this.schedule();
      this.maybePrefetchNext();
    }, DWELL_MS);
  }

  sameLanguage() {
    const source = String((this.book && this.book.language) || '').toLowerCase();
    const target = String((window.__DT && window.__DT.state && window.__DT.state.targetCode) || (this.cfg && this.cfg.targetLang) || '').toLowerCase();
    if (!source || !target) return false;
    if (source === target) return true;
    const srcBase = source.split('-')[0];
    const dstBase = target.split('-')[0];
    return srcBase === dstBase && !source.includes('-') && !target.includes('-');
  }

  stop() {
    this.active = false;
    this.generation += 1;
    this.pending.clear();
    this.units = [];
    this.byKey.clear();
    this.prefetchToken += 1;
    this.prefetchSection = '';
    this.prefetchPending = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler, true);
      this.scrollHandler = null;
    }
    this.onStatus({ mode: 'original', busy: false });
  }

  async collect() {
    const DT = window.__DT;
    this.units = [];
    this.byKey.clear();
    if (!DT || !DT.collect || !this.root) return;
    let raw = [];
    try { raw = DT.collect(this.root); } catch (err) { raw = []; }
    for (const unit of raw) {
      if (!unit || !unit.el || !unit.text || !String(unit.text).trim()) continue;
      const source = unit.wire || unit.text;
      const contentHash = hash32(source);
      const key = this.keyFor(unit, contentHash);
      unit.__readerKey = key;
      unit.__readerHash = contentHash;
      unit.__readerSection = this.section && this.section.id;
      this.units.push(unit);
      this.byKey.set(key, unit);
    }
    this.onStatus({ units: this.units.length, mode: this.mode });
  }

  setDocument(doc) {
    this.doc = doc || null;
  }

  keyFor(unit, contentHash, sectionOverride) {
    const cfg = this.cfg || {};
    const provider = cfg.currentProvider || '';
    const slot = (cfg.providerConfig && cfg.providerConfig[provider]) || {};
    const glossary = JSON.stringify((cfg.glossary || []).map((g) => [g.source, g.target]));
    const language = hash32(JSON.stringify((cfg && cfg.activeLanguage) || null));
    const professional = (cfg && (cfg.professionalProfile || (cfg.medicalMode ? 'medical' : 'general'))) || 'general';
    return [
      this.book && ['txt', 'markdown'].includes(this.book.format) ? 'text-v1' : 'epub-v1',
      this.book && this.book.id,
      this.book && this.book.hash,
      (sectionOverride || this.section) && (sectionOverride || this.section).id,
      contentHash,
      (window.__DT && window.__DT.state && window.__DT.state.targetCode) || cfg.targetLang || '',
      (window.__DT && window.__DT.state && window.__DT.state.style) || 'plain',
      (window.__DT && window.__DT.state && window.__DT.state.intensity) || 'standard',
      provider,
      slot.engine || '',
      slot.baseUrl || '',
      slot.model || '',
      professional,
      language,
      hash32(glossary + '|' + String(cfg.customPrompt || ''))
    ].join('|');
  }

  bindScroll() {
    if (this.scrollHandler) return;
    this.scrollHandler = () => {
      if (!this.active) return;
      if (this.timer) return;
      this.timer = setTimeout(() => { this.timer = 0; this.schedule(); this.maybePrefetchNext(); }, 160);
    };
    window.addEventListener('scroll', this.scrollHandler, true);
  }

  visibleUnits(all) {
    const list = all || this.units;
    return list.filter((unit) => inWindow(rectOf(unit), LOOK_AHEAD_SCREENS));
  }

  schedule(options) {
    if (!this.active || this.mode === 'original' || this.cfg?.authPaused) return;
    const cacheOnly = !!(options && options.cacheOnly);
    const candidates = this.visibleUnits().filter((unit) => {
      if (!unit.__readerKey || this.pending.has(unit.__readerKey)) return false;
      if (cacheOnly) return true;
      const failed = this.failures.get(unit.__readerKey);
      return !failed || Date.now() - failed > RETRY_MS;
    });
    if (!candidates.length) return;
    this.run(candidates, { cacheOnly }).catch((err) => this.onStatus({ error: err && err.message }));
  }


  maybePrefetchNext() {
    if (!this.active || !this.doc || !this.book || !this.section || this.mode === 'original' || this.cfg?.authPaused) return;
    if (this.prefetchPending || this.sameLanguage()) return;
    const index = this.section.index;
    const next = this.doc.sections[index + 1];
    if (!next) return;
    if (this.prefetchSection === next.id) return;
    const vh = window.innerHeight || 800;
    const nearEnd = window.scrollY + vh >= document.documentElement.scrollHeight - vh * LOOK_AHEAD_SCREENS;
    if (!nearEnd) return;
    this.prefetchSection = next.id;
    this.prefetchPending = true;
    const token = ++this.prefetchToken;
    this.prefetchSectionContent(next, token).catch((err) => {
      this.onStatus({ prefetchError: err && err.message });
    }).finally(() => {
      if (token === this.prefetchToken) this.prefetchPending = false;
    });
  }

  async prefetchSectionContent(section, token) {
    let raw;
    try { raw = section.load(); } catch (err) { return; }
    const sanitized = sanitizeXhtml(raw.html, {
      baseHref: raw.baseHref,
      book: this.doc,
      document,
      DOMParser: window.DOMParser
    });
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:720px;opacity:0;pointer-events:none;';
    host.appendChild(sanitized.fragment);
    document.body.appendChild(host);
    try {
      if (token !== this.prefetchToken) return;
      let units = [];
      try { units = window.__DT.collect(host); } catch (err) { units = []; }
      if (token !== this.prefetchToken) return;
      const todo = [];
      for (const unit of units.slice(0, 12)) {
        if (!unit || !unit.el || !unit.text || !String(unit.text).trim()) continue;
        const source = unit.wire || unit.text;
        const contentHash = hash32(source);
        unit.__prefetchKey = this.keyFor(unit, contentHash, section);
        unit.__prefetchHash = contentHash;
        let cached = null;
        try { cached = await getTranslation(unit.__prefetchKey); } catch (err) { cached = null; }
        if (!cached) todo.push(unit);
        if (todo.length >= 8) break;
      }
      if (!todo.length || token !== this.prefetchToken) return;
      for (const group of batchOf(todo)) {
        if (token !== this.prefetchToken) return;
        const message = translationMessage(group.items.map((unit) => unit.wire || unit.text), group.protocol, this.cfg, this.identity);
        const res = await sendMessage(message);
        if (token !== this.prefetchToken) return;
        if (!res || res.ok !== true) return;
        const results = res.results || [];
        for (let i = 0; i < group.items.length; i += 1) {
          const unit = group.items[i];
          const value = results[i];
          if (typeof value !== 'string' || !value.trim()) continue;
          try {
            await putTranslation({
              key: unit.__prefetchKey,
              bookId: this.book && this.book.id,
              sectionId: section.id,
              contentHash: unit.__prefetchHash,
              targetLang: (window.__DT && window.__DT.state && window.__DT.state.targetCode) || '',
              style: (window.__DT && window.__DT.state && window.__DT.state.style) || 'plain',
              intensity: (window.__DT && window.__DT.state && window.__DT.state.intensity) || 'standard',
              provider: (this.cfg && this.cfg.currentProvider) || '',
              model: (this.cfg && this.cfg.providerConfig && this.cfg.providerConfig[this.cfg.currentProvider] && this.cfg.providerConfig[this.cfg.currentProvider].model) || '',
              source: unit.text,
              translated: value,
              updatedAt: Date.now()
            });
          } catch (err) { /* cache only */ }
        }
      }
    } finally {
      if (host.parentNode) host.parentNode.removeChild(host);
      for (const url of sanitized.assets.values()) { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }
    }
  }

  chapterStats() {
    return {
      units: this.units.length,
      chars: this.units.reduce((sum, unit) => sum + String(unit.text || '').length, 0)
    };
  }

  async translateChapter() {
    if (!this.active || this.mode === 'original') return;
    this.onStatus({ busy: true, chapter: true });
    try {
      await this.run(this.units.slice());
    } finally {
      this.onStatus({ busy: false, chapter: false });
    }
  }

  async run(units, options) {
    const generation = this.generation;
    const groups = batchOf(units);
    for (const group of groups) {
      if (generation !== this.generation) return;
      await this.runGroup(group, generation, options);
    }
  }

  async runGroup(group, generation, options) {
    const todo = [];
    for (const unit of group.items) {
      const key = unit.__readerKey;
      if (!key || this.pending.has(key)) continue;
      this.pending.add(key);
      let cached = null;
      try { cached = await getTranslation(key); } catch (err) { cached = null; }
      if (generation !== this.generation) return;
      if (cached && typeof cached.translated === 'string') {
        if (!this.inject(unit, cached.translated)) this.failures.set(key, Date.now());
        this.pending.delete(key);
        continue;
      }
      todo.push(unit);
    }
    if (!todo.length) return;
    if (options && options.cacheOnly) {
      for (const unit of todo) this.pending.delete(unit.__readerKey);
      return;
    }
    const message = translationMessage(todo.map((unit) => unit.wire || unit.text), group.protocol, this.cfg, this.identity);
    // 记录元数据必须取发请求这一刻的书 / 目标语言 / 模型：晚归时这些可能已经换了。
    const meta = this.meta();
    const sent = todo.map((unit) => ({ unit, key: unit.__readerKey, hash: unit.__readerHash, section: unit.__readerSection }));
    const res = await sendMessage(message);
    if (generation !== this.generation) {
      // 切章 / 换书 / 停止后晚归的结果已经付过费：不再写进页面，但按请求时的键存进缓存，
      // 回到这一章时直接复用（QA G10）。后台已按配置身份核对过，键与结果一致。
      if (res && res.ok === true) await this.storeLate(sent, res.results || [], meta);
      return;
    }
    if (res && res.errorCode === 'config_changed') {
      // 设置刚变：不是失败，不记退避；阅读器收到配置广播后会 rekey。
      for (const unit of todo) this.pending.delete(unit.__readerKey);
      return;
    }
    if (!res || res.ok !== true) {
      for (const unit of todo) {
        this.failures.set(unit.__readerKey, Date.now());
        this.pending.delete(unit.__readerKey);
        try {
          await putFailure({ key: unit.__readerKey, bookId: this.book && this.book.id, sectionId: this.section && this.section.id, reason: (res && res.error) || 'translate_failed', updatedAt: Date.now() });
        } catch (err) { /* ignore */ }
      }
      this.onStatus({ error: (res && res.error) || 'translate_failed' });
      return;
    }
    const results = res.results || [];
    for (let i = 0; i < todo.length; i += 1) {
      const unit = todo[i];
      const value = results[i];
      this.pending.delete(unit.__readerKey);
      if (typeof value !== 'string' || !value.trim() || value.trim() === String(unit.text || '').trim()) {
        this.failures.set(unit.__readerKey, Date.now());
        if (typeof value === 'string' && value.trim()) this.inject(unit, value);
        continue;
      }
      const ok = this.inject(unit, value);
      if (!ok) {
        this.failures.set(unit.__readerKey, Date.now());
        continue;
      }
      this.failures.delete(unit.__readerKey);
      try {
        await putTranslation({
          key: unit.__readerKey,
          bookId: this.book && this.book.id,
          sectionId: this.section && this.section.id,
          contentHash: unit.__readerHash,
          targetLang: (window.__DT && window.__DT.state && window.__DT.state.targetCode) || '',
          style: (window.__DT && window.__DT.state && window.__DT.state.style) || 'plain',
          intensity: (window.__DT && window.__DT.state && window.__DT.state.intensity) || 'standard',
          provider: (this.cfg && this.cfg.currentProvider) || '',
          model: (this.cfg && this.cfg.providerConfig && this.cfg.providerConfig[this.cfg.currentProvider] && this.cfg.providerConfig[this.cfg.currentProvider].model) || '',
          source: unit.text,
          translated: value,
          updatedAt: Date.now()
        });
      } catch (err) { /* cache failure does not hide translation */ }
    }
    this.onStatus({ translated: todo.length });
  }

  // sent：发请求时的键快照。配置变化后 rekey() 会改写 unit 上的键，晚归结果只能落在旧键下。
  async storeLate(sent, results, meta) {
    for (let i = 0; i < sent.length; i += 1) {
      const { unit, key, hash, section } = sent[i];
      const value = results[i];
      if (!key || typeof value !== 'string' || !value.trim() || value.trim() === String(unit.text || '').trim()) continue;
      const row = Object.assign({}, meta, {
        key,
        sectionId: section,
        contentHash: hash,
        source: unit.text,
        translated: value,
        updatedAt: Date.now()
      });
      try { await putTranslation(row); } catch (err) { /* cache only */ }
    }
  }

  meta() {
    const DT = window.__DT;
    const st = (DT && DT.state) || {};
    const cfg = this.cfg || {};
    const slot = (cfg.providerConfig && cfg.providerConfig[cfg.currentProvider]) || {};
    return {
      bookId: this.book && this.book.id,
      targetLang: st.targetCode || '',
      style: st.style || 'plain',
      intensity: st.intensity || 'standard',
      provider: cfg.currentProvider || '',
      model: slot.model || ''
    };
  }

  inject(unit, value) {
    const DT = window.__DT;
    if (!DT || !DT.inject) return false;
    const lang = (DT.state && DT.state.targetCode) || '';
    let result = false;
    try { result = DT.inject(unit, value, lang); } catch (err) { result = false; }
    if (result) return true;
    // 行内协议失败：整段降级为纯文本，避免把标记失真的译文写进页面。
    if (unit.inlineProtocol) {
      try {
        const fallback = Object.assign({}, unit, { inlineProtocol: '', wire: unit.text, keep: [] });
        return !!DT.inject(fallback, value, lang);
      } catch (err) { return false; }
    }
    return false;
  }
}

export function hasTranslationProvider(cfg) {
  return !!(cfg && cfg.hasKey);
}
