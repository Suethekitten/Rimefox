// 阅读器翻译调度：复用 content/dom.js 的 collect / inject（行内格式、双语/仅译文、方向），
// 但使用 reader 自己的 book/section 缓存与取消代际。background 只负责模型请求。
import { getTranslation, putTranslation, putFailure } from './store.js';
import { sanitizeXhtml } from './sanitize.js';

const BATCH_ITEMS = 8;
const BATCH_CHARS = 1000;
const LOOK_AHEAD_SCREENS = 2;
const RETRY_MS = 15000;

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

function batchOf(units) {
  const groups = [];
  for (const unit of units) {
    const protocol = unit.inlineProtocol || '';
    let group = groups.find((g) => g.protocol === protocol && g.items.length < BATCH_ITEMS && g.chars < BATCH_CHARS);
    if (!group) {
      group = { protocol, items: [], chars: 0 };
      groups.push(group);
    }
    const text = unit.wire || unit.text || '';
    if (group.items.length && group.chars + text.length > BATCH_CHARS) {
      group = { protocol, items: [], chars: 0 };
      groups.push(group);
    }
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
  }

  async configure(cfg) {
    this.cfg = cfg || {};
    const DT = window.__DT;
    if (!DT || !DT.state) return;
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
    this.onStatus({ hasKey: !!(cfg && cfg.hasKey), target: DT.state.targetCode });
  }

  async start(book, section, root, mode) {
    this.stop();
    this.book = book;
    this.section = section;
    this.root = root;
    this.mode = mode || 'original';
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
    await this.collect();
    this.bindScroll();
    this.schedule();
    this.maybePrefetchNext();
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
      'epub-v1',
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

  schedule() {
    if (!this.active || this.mode === 'original') return;
    const candidates = this.visibleUnits().filter((unit) => {
      if (!unit.__readerKey || this.pending.has(unit.__readerKey)) return false;
      const failed = this.failures.get(unit.__readerKey);
      return !failed || Date.now() - failed > RETRY_MS;
    });
    if (!candidates.length) return;
    this.run(candidates).catch((err) => this.onStatus({ error: err && err.message }));
  }


  maybePrefetchNext() {
    if (!this.active || !this.doc || !this.book || !this.section || this.mode === 'original') return;
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
        const message = {
          type: 'translate',
          texts: group.items.map((unit) => unit.wire || unit.text),
          target: (window.__DT && window.__DT.state && window.__DT.state.target) || (this.cfg && this.cfg.targetLang) || 'zh-CN',
          style: (window.__DT && window.__DT.state && window.__DT.state.style) || 'plain',
          noCache: true
        };
        if (group.protocol) message.inlineProtocol = group.protocol;
        if (message.style !== 'plain') message.intensity = (window.__DT && window.__DT.state && window.__DT.state.intensity) || 'standard';
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

  async run(units) {
    const generation = this.generation;
    const groups = batchOf(units);
    for (const group of groups) {
      if (generation !== this.generation) return;
      await this.runGroup(group, generation);
    }
  }

  async runGroup(group, generation) {
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
    const texts = todo.map((unit) => unit.wire || unit.text);
    const message = {
      type: 'translate',
      texts,
      target: (window.__DT && window.__DT.state && window.__DT.state.target) || (this.cfg && this.cfg.targetLang) || 'zh-CN',
      style: (window.__DT && window.__DT.state && window.__DT.state.style) || 'plain',
      noCache: true
    };
    if (group.protocol) message.inlineProtocol = group.protocol;
    if (message.style !== 'plain') {
      message.intensity = (window.__DT && window.__DT.state && window.__DT.state.intensity) || 'standard';
    }
    const res = await sendMessage(message);
    if (generation !== this.generation) return;
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
