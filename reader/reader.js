// 阅读器页面入口：书库、章节渲染、阅读进度、设置。
// EPUB 结构由 lib/reader/epub.js；清洗由 lib/reader/sanitize.js；
// 翻译复用 content/dom.js 的 collect/inject，缓存由 reader 自己管理。
import { EpubError } from '../lib/reader/epub.js';
import { loadEpub } from '../lib/reader/epub-loader.js';
import { sanitizeXhtml } from '../lib/reader/sanitize.js';
import { listBooks, getBook, saveBook, createBook, saveBookFile, getBookFile, deleteBook, saveProgress, sha256, getReaderSettings, saveReaderSettings, estimateUsage, requestPersistence, getUserFont, saveUserFont, deleteUserFont, READER_LIMITS } from '../lib/reader/store.js';
import { saveConfig } from '../lib/config.js';
import { LOCAL_SECRETS, SESSION_SECRETS } from '../lib/config-storage.js';
import { ReaderTranslator } from '../lib/reader/translate.js';
import { PdfTranslator } from '../lib/reader/pdf-translate.js';
import { pdfCacheIdentity } from '../lib/reader/pdf-cache.js';
import { openPdfDocument, looksLikePdf } from '../lib/reader/pdf.js';
import { isComplexPage } from '../lib/reader/pdf-text.js';

const PDF_TRANS_MAX = 24;
let pdfViewEpoch = 0;
let pdfModeTimer = 0;
let pdfFlowScrollRaf = 0;
let openSeq = 0;
let searchSeq = 0;
const pdfPageTimers = new Map();
const PDF_MODE_OPTIONS = [
  { value: 'pdf-original', text: '原版版面', view: 'pdf', lang: 'original' },
  { value: 'flow-original', text: '流式原版', view: 'flow', lang: 'original' },
  { value: 'flow-bilingual', text: '流式双语', view: 'flow', lang: 'bilingual' },
  { value: 'flow-translation', text: '流式仅译文', view: 'flow', lang: 'translation' }
];
const EPUB_MODE_OPTIONS = [
  { value: 'original', text: '原文' },
  { value: 'bilingual', text: '双语' },
  { value: 'translation', text: '仅译文' }
];
function setModeOptions(kind) {
  const select = $('modeSelect');
  if (!select) return;
  select.textContent = '';
  for (const option of (kind === 'pdf' ? PDF_MODE_OPTIONS : EPUB_MODE_OPTIONS)) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.text;
    select.appendChild(item);
  }
}

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  book: null,
  doc: null,
  section: null,
  pdf: null,
  pdfObserver: null,
  pdfPage: 0,
  pdfTrans: null,
  pdfTranslator: null,
  pdfGeneration: 0,
  pdfIdentity: '',
  pdfStopped: false,
  pdfTranslating: new Map(),
  pdfTransFails: new Map(),
  pdfZoom: 1,
  pdfTransDone: 0,
  pdfTransPending: 0,
  pdfProgressTimer: 0,
  readerTarget: '',
  mode: 'original',
  assets: [],
  noteAssets: [],
  settings: null,
  userFontFace: null,
  userFontName: '',
  scrollTimer: 0,
  saveTimer: 0,
  translating: false
};
let translator = null;
let configSequence = 0;

function toast(message, kind) {
  const el = $('readerToast');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'reader-toast show' + (kind === 'error' ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'reader-toast'; }, 4200);
}
function setStatus(id, message, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.dataset.kind = kind || '';
}
function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return (n < 10 && i ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
}
function errorText(err) {
  const name = err && err.name;
  if (name === 'PasswordException') return '这个 PDF 有密码保护，凛狐不会绕过。';
  if (name === 'InvalidPDFException') return '这个 PDF 已损坏或不是有效的 PDF 文件。';
  if (name === 'MissingPDFException') return 'PDF 文件不完整（可能下载中断）。';
  const code = err && err.code;
  const map = {
    not_epub: '这不是可读取的 EPUB 文件。',
    drm_protected: '这本 EPUB 有 DRM / 加密保护，凛狐不会绕过。',
    unsupported_layout: '暂不支持固定版式 EPUB（0.13.0 只支持可重排文字书）。',
    too_large: '文件或解压后的内容超过安全上限，请缩小文件后重试。',
    corrupt_epub: 'EPUB 结构损坏或缺少必要文件。',
    unsafe_archive: 'EPUB 压缩包异常，已拒绝导入。',
    missing_content: 'EPUB 缺少章节内容。',
    unsupported_media: 'EPUB 含有不支持的媒体资源。'
  };
  return map[code] || (err && err.message) || '导入失败。';
}
function runtimeMessage(msg) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    // 后台没起来 / 没有响应时不能把阅读器启动卡死
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 8000);
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        finish(err ? { ok: false, error: err.message } : (res || { ok: false }));
      });
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    }
  });
}
async function loadConfig() {
  const sequence = ++configSequence;
  const res = await runtimeMessage({ type: 'config:get' });
  const config = res && res.ok ? res.config : null;
  const doc = state.pdf;
  const target = state.readerTarget;
  const identity = doc && config ? await pdfCacheIdentity(config, target, 'plain') : '';
  if (sequence !== configSequence) return state.config;
  const changed = doc && doc === state.pdf && target === state.readerTarget
    && state.pdfIdentity && state.pdfIdentity !== identity;
  const wasPaused = state.config && state.config.authPaused;
  state.config = config;
  if (config && config.authPaused) {
    if (doc) cancelPdfTranslations(false);
    if (translator) translator.stop();
    setStatus('readerStatus', '接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。', 'error');
  } else if (translator && config) {
    await translator.configure(readerConfig());
    if (wasPaused && state.section && !doc) await translator.start(state.book, state.section, $('bookContent'), state.mode);
  }
  if (changed) {
    cancelPdfTranslations(true);
    setPdfOriginalMode();
    state.pdfIdentity = identity;
    await applyPdfViewMode();
    setStatus('readerStatus', '翻译配置已变化；请选择双语或点「翻译本章」使用新配置。');
  }
  if (state.book) $('translateChapter').disabled = !(config && config.hasKey && !config.authPaused);
  if (!state.config) {
    setStatus('libraryStatus', '无法读取扩展配置，请重新打开阅读器。', 'error');
    return null;
  }
  renderTargetSelect();
  return state.config;
}

// 阅读器自己的翻译配置：目标语言来自 reader settings，不跟随网页翻译的全局设置。
function readerConfig() {
  const base = state.config || {};
  const target = state.readerTarget || base.targetLang || '';
  const chosen = (base.languages || []).find((language) => language.value === target);
  const cfg = Object.assign({}, base, { targetLang: target });
  if (chosen) cfg.activeLanguage = { value: chosen.value, label: chosen.label, code: chosen.code, kind: chosen.kind };
  return cfg;
}

function renderTargetSelect() {
  const select = $('targetSelect');
  if (!select) return;
  select.textContent = '';
  const languages = (state.config && state.config.languages) || [];
  for (const language of languages) {
    const option = document.createElement('option');
    option.value = language.value;
    option.textContent = language.label;
    select.appendChild(option);
  }
  const wanted = state.readerTarget || (state.config && (state.config.targetLang || (state.config.activeLanguage && state.config.activeLanguage.value))) || '';
  if (wanted && !Array.from(select.options).some((option) => option.value === wanted)) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = wanted;
    select.appendChild(option);
  }
  select.value = wanted;
  select.disabled = !state.config || !select.options.length;
}

async function changeTarget() {
  const select = $('targetSelect');
  if (!select || !state.config || !state.book) return;
  const target = select.value;
  if (!target) return;
  select.disabled = true;
  try {
    // 只改阅读器自己的设置，不动网页翻译的全局 targetLang
    await saveReaderSettings({ targetLang: target });
    state.settings = Object.assign({}, state.settings || {}, { targetLang: target });
    state.readerTarget = target;
    if (state.pdf) {
      const previousLang = state.pdfLang;
      const previousView = state.pdfView;
      cancelPdfTranslations(true);
      state.pdfStopped = false;
      state.pdfIdentity = await pdfCacheIdentity(readerConfig(), target, 'plain');
      if (previousLang === 'original') {
        setPdfOriginalMode();
      } else {
        // 保持原来的版式（流式双语 / 仅译文），只换目标语言后自动重译当前可见页。
        state.pdfView = previousView;
        state.pdfLang = previousLang;
        state.mode = previousLang;
        $('modeSelect').value = state.book.pdfMode || (previousView === 'flow' ? 'flow-bilingual' : 'pdf-original');
      }
      try { await saveBook(state.book); } catch (err) { /* ignore */ }
      if (previousLang === 'original') {
        setStatus('readerStatus', '目标语言已切换（只影响阅读器）；点「双语」或「翻译本章」按新语言翻译 PDF。');
      } else {
        await applyPdfViewMode();
        setStatus('readerStatus', '目标语言已切换，正在按新语言重新翻译。');
      }
      return;
    }
    const cfg = readerConfig();
    if (translator) await translator.configure(cfg);
    if (translator) translator.stop();
    translator = new ReaderTranslator({ onStatus: onTranslateStatus });
    await translator.configure(cfg);
    translator.setDocument(state.doc);
    try { window.__DT && window.__DT.restore && window.__DT.restore(); } catch (err) { /* ignore */ }
    for (const node of Array.from(document.querySelectorAll('#bookContent [data-dt-target]'))) node.remove();
    state.mode = 'original';
    $('modeSelect').value = 'original';
    state.book.mode = 'original';
    try { await saveBook(state.book); } catch (err) { /* ignore */ }
    if (state.section) {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const ratio = Math.max(0, Math.min(1, window.scrollY / max));
      await loadSection(state.section.id, '', ratio);
    }
    setStatus('readerStatus', '目标语言已切换（只影响阅读器）；点「双语」或「翻译本章」按新语言翻译。');
  } catch (err) {
    setStatus('readerStatus', '切换目标语言失败：' + ((err && err.message) || '未知错误'), 'error');
    renderTargetSelect();
  } finally {
    select.disabled = false;
  }
}

function applySettings() {
  const s = state.settings || {};
  const root = document.documentElement;
  root.style.setProperty('--reader-font-size', (s.fontSize || 18) + 'px');
  root.style.setProperty('--reader-line-height', String(s.lineHeight || 1.75));
  root.style.setProperty('--reader-measure', (s.measure || 720) + 'px');
  root.style.setProperty('--reader-letter-spacing', (Number(s.letterSpacing) || 0) + 'em');
  root.style.setProperty('--reader-paragraph-gap', (Number(s.paragraphSpacing) || 1.05) + 'em');
  $('fontSize').value = String(s.fontSize || 18);
  $('lineHeight').value = String(s.lineHeight || 1.75);
  $('measure').value = String(s.measure || 720);
  $('letterSpacing').value = String(Number(s.letterSpacing) || 0);
  $('paragraphSpacing').value = String(Number(s.paragraphSpacing) || 1.05);
  const maxBookMb = Math.round((Number(s.maxBookBytes) || READER_LIMITS.maxBookBytes) / 1048576);
  $('maxBookMb').value = String(maxBookMb);
  const dropNote = $('dropNote');
  if (dropNote) dropNote.textContent = '支持无 DRM 的 EPUB 2/3 与文本型 PDF，单本最大 ' + maxBookMb + ' MB（设置里可调）';
  $('themeSelect').value = s.theme || 'auto';
  const hasUserFont = !!state.userFontFace;
  const family = s.fontFamily === 'user' && !hasUserFont ? 'serif' : (s.fontFamily || 'serif');
  $('fontSelect').value = family === 'sans' ? 'sans' : (family === 'user' ? 'user' : 'serif');
  const userOption = $('fontSelect').querySelector('option[value="user"]');
  if (userOption) userOption.disabled = !hasUserFont;
  if (s.theme && s.theme !== 'auto') root.setAttribute('data-reader-theme', s.theme);
  else root.removeAttribute('data-reader-theme');
  document.body.classList.toggle('reader-sans', family === 'sans');
  document.body.classList.toggle('reader-serif', family !== 'sans' && family !== 'user');
  document.body.classList.toggle('reader-user', family === 'user' && hasUserFont);
}

async function loadUserFont() {
  try {
    const record = await getUserFont();
    if (!record || !record.blob) {
      state.userFontFace = null;
      state.userFontName = '';
      updateUserFontUi();
      return;
    }
    const face = new FontFace('Rimefox User Font', await record.blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    state.userFontFace = face;
    state.userFontName = record.name || '我的字体';
  } catch (err) {
    state.userFontFace = null;
    state.userFontName = '';
  }
  updateUserFontUi();
}

function updateUserFontUi() {
  if (!$('userFontName')) return;
  $('userFontName').textContent = state.userFontName || '未上传';
  $('userFontRemove').disabled = !state.userFontFace;
  const option = $('fontSelect') && $('fontSelect').querySelector('option[value="user"]');
  if (option) option.disabled = !state.userFontFace;
}

async function handleUserFontFile(file) {
  if (!file) return;
  if (file.size > 24 * 1024 * 1024) {
    setStatus('libraryStatus', '字体文件超过 24 MB，未上传。', 'error');
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    const face = new FontFace('Rimefox User Font', buffer);
    await face.load();
    if (state.userFontFace) document.fonts.delete(state.userFontFace);
    document.fonts.add(face);
    state.userFontFace = face;
    state.userFontName = file.name || '我的字体';
    await saveUserFont({ name: state.userFontName, type: file.type || 'font/ttf', blob: new Blob([buffer], { type: file.type || 'font/ttf' }), addedAt: Date.now() });
    await saveSettings({ fontFamily: 'user' });
    updateUserFontUi();
    toast('字体已保存到本机。');
  } catch (err) {
    setStatus('libraryStatus', '无法读取这个字体文件：' + ((err && err.message) || '格式不支持'), 'error');
  }
}

async function removeUserFont() {
  if (state.userFontFace) {
    try { document.fonts.delete(state.userFontFace); } catch (err) { /* ignore */ }
  }
  state.userFontFace = null;
  state.userFontName = '';
  try { await deleteUserFont(); } catch (err) { /* ignore */ }
  await saveSettings({ fontFamily: 'serif' });
  updateUserFontUi();
  toast('已移除本机字体。');
}

async function saveSettings(patch) {
  state.settings = Object.assign({}, state.settings || {}, patch);
  applySettings();
  // 只写这次改动的字段：整行写回会把旧快照里的 targetLang 等字段带回去。
  try { await saveReaderSettings(patch); } catch (err) { /* ignore */ }
}

function coverNode(book) {
  if (book.coverBlob) {
    const img = document.createElement('img');
    img.className = 'book-cover';
    img.alt = '';
    img.src = URL.createObjectURL(book.coverBlob);
    img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
    return img;
  }
  const div = document.createElement('div');
  div.className = 'book-cover empty';
  div.textContent = '书';
  return div;
}

async function renderLibrary() {
  const grid = $('bookGrid');
  grid.textContent = '';
  const books = await listBooks();
  $('libraryUsage').textContent = '';
  if (!books.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-library';
    empty.textContent = '还没有导入 EPUB / PDF。选择一本无 DRM 的书开始。';
    grid.appendChild(empty);
  }
  for (const book of books) {
    const card = document.createElement('article');
    card.className = 'book-card';
    card.setAttribute('data-dt-ui', '1');
    card.appendChild(coverNode(book));
    const body = document.createElement('div');
    body.className = 'book-body';
    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = book.title || 'Untitled';
    const author = document.createElement('div');
    author.className = 'book-author';
    author.textContent = (book.authors || []).join(' · ') || book.language || '';
    const progress = document.createElement('div');
    progress.className = 'book-progress';
    const p = book.progress || {};
    progress.textContent = p.sectionId ? '上次读到 ' + String(p.sectionId).replace(/^s/, '第 ') + ' 节 · ' + Math.round((p.offsetRatio || 0) * 100) + '%' : '尚未开始';
    const actions = document.createElement('div');
    actions.className = 'book-actions';
    const open = document.createElement('button');
    open.className = 'reader-button';
    open.type = 'button';
    open.textContent = '打开';
    open.addEventListener('click', () => openBook(book));
    const del = document.createElement('button');
    del.className = 'reader-button';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (!confirm('删除《' + (book.title || 'Untitled') + '》及其全部译文？')) return;
      await deleteBook(book.id);
      if (state.book && state.book.id === book.id) closeReader();
      await renderLibrary();
    });
    actions.appendChild(open);
    actions.appendChild(del);
    body.appendChild(title);
    body.appendChild(author);
    body.appendChild(progress);
    body.appendChild(actions);
    card.appendChild(body);
    grid.appendChild(card);
  }
  const est = await estimateUsage();
  $('libraryUsage').textContent = est.quota ? '本地书库 ' + formatBytes(est.usage || 0) + ' / 约 ' + formatBytes(est.quota) : '';
}

let importController = null;
let epubOpenController = null;
function checkImport(controller) { controller.signal.throwIfAborted(); }
async function importFile(file) {
  if (!file) return;
  importController?.abort();
  const controller = new AbortController();
  importController = controller;
  $('cancelImport').hidden = false;
  const maxBookBytes = (state.settings && Number(state.settings.maxBookBytes)) || READER_LIMITS.maxBookBytes;
  // 单本上限只拦新书：已在书库里的书（之后调低了上限）重新导入时仍直接打开（QA G7）。
  // 超过设置页最大可选值的文件不读进内存，直接拒绝。
  const tooBig = file.size > maxBookBytes;
  if (tooBig && file.size > READER_LIMITS.maxSelectableBookBytes) {
    setStatus('libraryStatus', '文件超过 ' + Math.round(maxBookBytes / 1048576) + ' MB 上限，可在设置里调高。', 'error');
    $('cancelImport').hidden = true;
    return;
  }
  setStatus('libraryStatus', '正在解析…');
  try {
    const buffer = await file.arrayBuffer();
    checkImport(controller);
    const hash = await sha256(buffer);
    const existing = await getBook(hash);
    checkImport(controller);
    if (existing) {
      $('cancelImport').hidden = true;
      // 书记录还在但文件丢了（例如另一个标签页删书时本页把记录写回）：用这次选的文件补上。
      if (!(await getBookFile(hash))) await saveBookFile(hash, file);
      setStatus('libraryStatus', '这本书已导入，直接打开。', 'ok');
      await openBook(existing);
      return;
    }
    if (tooBig) {
      setStatus('libraryStatus', '文件超过 ' + Math.round(maxBookBytes / 1048576) + ' MB 上限，可在设置里调高。', 'error');
      return;
    }
    const est = await estimateUsage();
    checkImport(controller);
    if (est.usage && est.quota && est.usage + file.size > READER_LIMITS.maxLibraryBytes) {
      setStatus('libraryStatus', '书库接近 500 MB，请先删除一本书。', 'error');
      return;
    }
    if (/\.pdf$/i.test(file.name) || looksLikePdf(new Uint8Array(buffer))) {
      $('cancelImport').hidden = true;
      await importPdf(file, buffer, hash);
      return;
    }
    const doc = await loadEpub(buffer, { signal: controller.signal });
    checkImport(controller);
    const coverBlob = doc.cover ? new Blob([doc.cover.bytes], { type: doc.cover.mediaType || 'image/jpeg' }) : null;
    const first = doc.sections[0];
    const record = {
      id: hash,
      hash,
      format: 'epub',
      title: doc.metadata.title,
      authors: doc.metadata.authors,
      language: doc.metadata.language,
      metadata: doc.metadata,
      coverBlob,
      toc: doc.toc,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      mode: 'original',
      progress: { sectionId: first ? first.id : '', offsetRatio: 0 }
    };
    // Cancellation ends before the short database commit; a cancelled parse never saves a book.
    $('cancelImport').hidden = true;
    await saveBookFile(record.id, file);
    await createBook(record);
    requestPersistence().catch(() => {});
    setStatus('libraryStatus', '已导入。', 'ok');
    await renderLibrary();
    await openBook(record);
  } catch (err) {
    if (importController === controller) setStatus('libraryStatus', err.name === 'AbortError' ? '已取消导入。' : errorText(err), err.name === 'AbortError' ? '' : 'error');
  } finally {
    if (importController === controller) { importController = null; $('cancelImport').hidden = true; }
  }
}

async function importPdf(file, buffer, hash) {
  setStatus('libraryStatus', '正在解析 PDF…');
  // 只存文件、不在这里开 pdf.js 文档：同一次导入里开两个文档会让后一个的 render 卡住。
  // 元数据在 openPdfBook 里补齐（书名先用文件名）。
  const record = {
    id: hash,
    hash,
    format: 'pdf',
    title: file.name.replace(/\.pdf$/i, '') || '未命名 PDF',
    authors: [],
    language: '',
    metadata: {},
    coverBlob: null,
    toc: [],
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    mode: 'original',
    progress: { sectionId: 'page:1', offsetRatio: 0 }
  };
  await saveBookFile(record.id, file);
  await createBook(record);
  requestPersistence().catch(() => {});
  setStatus('libraryStatus', '已导入。', 'ok');
  await renderLibrary();
  await openBook(record);
}

function loadPdfDocument(buffer, signal) {
  return openPdfDocument({
    data: buffer,
    signal,
    loadPdfjs: () => import(chrome.runtime.getURL('reader/vendor/pdfjs/pdf.min.mjs')),
    workerSrc: chrome.runtime.getURL('reader/vendor/pdfjs/pdf.worker.min.mjs'),
    cMapUrl: chrome.runtime.getURL('reader/vendor/pdfjs/cmaps/')
  });
}

function jumpToPdfPage(n) {
  const el = document.querySelector('.pdf-page[data-page="' + n + '"]');
  if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function jumpToPdfHit(page) {
  if (!state.pdf) return;
  const target = Math.max(1, Math.min(state.pdf.numPages, Number(page) || 1));
  if (state.pdfView === 'flow') {
    const section = document.querySelector('#pdfFlow .pdf-flow-page[data-page="' + target + '"]');
    if (section) {
      section.scrollIntoView({ block: 'start' });
      ensurePdfFlowPage(section).catch(() => {});
    }
  } else {
    jumpToPdfPage(target);
  }
  updatePdfAnchor();
}

async function searchPdf(query) {
  const results = $('pdfSearchResults');
  if (!results) return;
  results.textContent = '';
  const q = String(query || '').trim();
  if (!q || !state.pdf) return;
  const doc = state.pdf;
  const token = ++searchSeq;
  const alive = () => token === searchSeq && doc === state.pdf;
  setStatus('readerStatus', '搜索中…');
  const hits = [];
  for (let page = 1; page <= doc.numPages && hits.length < 50; page += 1) {
    if (!alive()) return;
    const loaded = await doc.page(page);
    if (!alive()) return;
    for (const block of loaded.blocks) {
      const index = block.text.toLowerCase().indexOf(q.toLowerCase());
      if (index < 0) continue;
      hits.push({
        page: page,
        snippet: block.text.slice(Math.max(0, index - 20), index + q.length + 20)
      });
      if (hits.length >= 50) break;
    }
  }
  if (!alive()) return;
  setStatus('readerStatus', hits.length ? '找到 ' + hits.length + ' 处「' + q + '」' : '没有找到「' + q + '」。');
  for (const hit of hits) {
    if (!alive()) return;
    const row = document.createElement('a');
    row.href = '#';
    row.className = 'pdf-search-hit';
    row.textContent = 'p.' + hit.page + ' · ' + hit.snippet;
    row.addEventListener('click', (event) => { event.preventDefault(); jumpToPdfHit(hit.page); });
    results.appendChild(row);
  }
}

function updatePdfZoomUi() {
  const pdf = !!state.pdf && state.pdfView === 'pdf';
  const out = $('pdfZoomOut');
  const label = $('pdfZoomLabel');
  const zoomIn = $('pdfZoomIn');
  if (!out || !label || !zoomIn) return;
  out.hidden = !pdf;
  zoomIn.hidden = !pdf;
  label.hidden = !pdf;
  label.textContent = Math.round(state.pdfZoom * 100) + '%';
  const fitWidth = document.getElementById('pdfFitWidth');
  const fitColumn = document.getElementById('pdfFitColumn');
  if (fitWidth) fitWidth.hidden = !pdf;
  if (fitColumn) fitColumn.hidden = !pdf;
}

function setPdfZoom(value) {
  if (!state.pdf) return;
  pdfRasterEpoch += 1;
  state.pdf.cancelRendering();
  pdfRenderQueue = Promise.resolve();
  state.pdfZoom = Math.max(0.5, Math.min(3, Math.round(Number(value) * 20) / 20));
  updatePdfZoomUi();
  for (const el of document.querySelectorAll('.pdf-page')) {
    const canvas = el.querySelector('canvas');
    if (canvas) canvas.remove();
    const blocks = el.querySelector('.pdf-blocks');
    if (blocks) blocks.remove();
    delete el.dataset.rendered;
    el.style.minHeight = '';
  }
  renderVisiblePdfPages();
}

function applyPdfZoom(delta) {
  if (!state.pdf) return;
  setPdfZoom(state.pdfZoom + delta);
}

async function renderPdfPage(el, index, epoch) {
  const doc = state.pdf;
  if (!doc || epoch !== pdfRasterEpoch || !el.isConnected) return;
  const loaded = await doc.page(index);
  if (doc !== state.pdf || epoch !== pdfRasterEpoch || !el.isConnected) return;
  // 失败重试 / 缩放后重画时先清掉上一轮的画布、文本块和错误提示，避免叠加。
  for (const old of el.querySelectorAll('canvas, .pdf-blocks, .pdf-render-failed')) { if (old.tagName === 'CANVAS') doc.releaseCanvas(old); old.remove(); }
  const content = document.getElementById('bookContent');
  const baseWidth = Math.max(320, (content ? content.clientWidth : 720) - 56);
  const cssWidth = Math.round(baseWidth * state.pdfZoom);
  const dpr = window.devicePixelRatio || 1;
  // 按屏幕像素比和缩放渲染，避免 CSS 拉伸导致的模糊
  const renderScale = Math.min(3, Math.max(1.5, dpr) * state.pdfZoom);
  const canvas = document.createElement('canvas');
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = 'auto';
  el.appendChild(canvas);
  el.dataset.rendered = '1';
  const result = await doc.render(index, canvas, renderScale, { onEvict() {
    // Keep the layout stable while an offscreen bitmap is released.
    el.style.minHeight = el.offsetHeight + 'px';
    canvas.remove();
    delete el.dataset.rendered;
  } });
  if (doc !== state.pdf || epoch !== pdfRasterEpoch || !el.isConnected) return;
  el.style.minHeight = '';
  if (result.limited) {
    const label = el.querySelector('.pdf-page-label');
    if (label) label.textContent = '第 ' + index + ' / ' + doc.numPages + ' 页 · 页面较大，已降低预览分辨率';
  }
  if (loaded.blocks.length) {
    const panel = document.createElement('div');
    panel.className = 'pdf-blocks';
    for (let i = 0; i < loaded.blocks.length; i += 1) {
      const block = document.createElement('div');
      block.className = 'pdf-block';
      block.dataset.block = String(i);
      const src = document.createElement('span');
      src.className = 'pdf-src';
      src.textContent = loaded.blocks[i].text;
      block.appendChild(src);
      panel.appendChild(block);
    }
    el.appendChild(panel);
    if (isComplexPage(loaded.blocks)) {
      const label = el.querySelector('.pdf-page-label');
      if (label) label.textContent = '第 ' + index + ' / ' + doc.numPages + ' 页 · 复杂版式，文本顺序可能不准确';
    }
    applyPdfTranslations(index);
    if (state.mode !== 'original' && state.config && state.config.hasKey) {
      schedulePdfPageTranslation(index);
    }
  } else {
    const note = document.createElement('p');
    note.className = 'pdf-empty-text';
    note.textContent = '本页没有可提取的文字（可能是扫描页）。';
    el.appendChild(note);
  }
}

function applyPdfTranslationsTo(root, texts) {
  if (!root) return;
  const blocks = root.querySelectorAll('.pdf-block');
  for (let i = 0; i < blocks.length; i += 1) {
    const value = texts[i] || '';
    let trans = blocks[i].querySelector('.pdf-trans');
    if (!value) {
      if (trans) trans.remove();
      continue;
    }
    if (!trans) {
      trans = document.createElement('div');
      trans.className = 'pdf-trans';
      blocks[i].appendChild(trans);
    }
    trans.textContent = value;
  }
}

function applyPdfTranslations(index) {
  const texts = (state.pdfTrans && state.pdfTrans.get(index)) || [];
  applyPdfTranslationsTo(document.querySelector('.pdf-page[data-page="' + index + '"]'), texts);
  applyPdfTranslationsTo(document.querySelector('#pdfFlow .pdf-flow-page[data-page="' + index + '"]'), texts);
}

function visibleFlowPageIndexes() {
  const out = [];
  for (const section of document.querySelectorAll('#pdfFlow .pdf-flow-page')) {
    const rect = section.getBoundingClientRect();
    if (rect.bottom < -700 || rect.top > window.innerHeight + 700) continue;
    out.push(Number(section.dataset.page));
  }
  return out;
}

function renderPdfProgress() {
  const el = $('pdfProgress');
  if (!el) return;
  const done = state.pdfTransDone;
  const pending = state.pdfTransPending;
  if (!pending && !done) { el.hidden = true; return; }
  el.hidden = false;
  const total = Math.max(1, done + pending);
  $('pdfProgressBar').style.width = Math.round((done / total) * 100) + '%';
  $('pdfProgressText').textContent = 'PDF 翻译中 ' + done + '/' + total;
}

function beginPdfTranslation() {
  $('pdfTranslateStop').hidden = false;
  if (state.pdfProgressTimer) { clearTimeout(state.pdfProgressTimer); state.pdfProgressTimer = 0; }
  state.pdfTransDone = 0;
  state.pdfTransPending = 0;
  // 用户明确点「翻译本章」/ 切模式时，失败退避要清零，否则刚失败过的页会被 15s 退避直接跳过。
  state.pdfTransFails = new Map();
  renderPdfProgress();
}

// 清理整代任务；旧 finally 不能删掉新一代同页任务或修改新进度。
function cancelPdfTranslations(clear) {
  state.pdfGeneration += 1;
  if (state.pdfTranslator) state.pdfTranslator.stop();
  state.pdfTranslator = null;
  state.pdfTranslating = new Map();
  state.pdfTransFails = new Map();
  clearPdfPageTimers();
  state.pdfStopped = true;
  state.pdfTransDone = 0;
  state.pdfTransPending = 0;
  clearTimeout(state.pdfProgressTimer);
  state.pdfProgressTimer = 0;
  $('pdfProgress').hidden = true;
  if (clear) {
    state.pdfTrans = new Map();
    document.querySelectorAll('.pdf-trans').forEach((node) => node.remove());
  }
}

function setPdfOriginalMode() {
  state.mode = 'original';
  state.pdfLang = 'original';
  const mode = state.pdfView === 'flow' ? 'flow-original' : 'pdf-original';
  $('modeSelect').value = mode;
  if (state.book) state.book.pdfMode = mode;
  $('bookContent').dataset.pdfMode = 'original';
}

function endPdfProgressIfIdle() {
  if (state.pdfTransPending) return;
  if (state.pdfProgressTimer) clearTimeout(state.pdfProgressTimer);
  state.pdfProgressTimer = setTimeout(() => {
    state.pdfProgressTimer = 0;
    const el = $('pdfProgress');
    if (el) el.hidden = true;
  }, 600);
}

function pdfRetryDelay(count) {
  return Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.max(0, (count || 1) - 1)));
}

function showPdfPageTranslations(index, texts) {
  if (!state.pdfTrans) state.pdfTrans = new Map();
  if (state.pdfTrans.has(index)) state.pdfTrans.delete(index);
  state.pdfTrans.set(index, texts);
  if (state.pdfTrans.size > PDF_TRANS_MAX) {
    // 淘汰最久未用、且不在当前可视窗口里的页：否则补译上一页时会把正在看的这页译文清掉。
    const keep = new Set(state.pdfView === 'flow' ? visibleFlowPageIndexes() : visiblePdfPageIndexes());
    keep.add(index);
    for (const old of Array.from(state.pdfTrans.keys())) {
      if (state.pdfTrans.size <= PDF_TRANS_MAX) break;
      if (keep.has(old)) continue;
      state.pdfTrans.delete(old);
      applyPdfTranslations(old);
    }
  }
  applyPdfTranslations(index);
}

async function translatePdfPage(index) {
  if (!state.pdf || !state.config || !state.config.hasKey || state.config.authPaused || state.pdfStopped) return;
  if (state.pdfTranslating.has(index)) return;
  // 失败后按次数指数退避（15 s 起，最长 5 分钟）；滚动回来只重试过了退避期的页（QA G11）。
  const failed = state.pdfTransFails.get(index);
  if (failed && Date.now() - failed.at < pdfRetryDelay(failed.count)) return;
  const token = {};
  const jobs = state.pdfTranslating;
  jobs.set(index, token);
  const generation = state.pdfGeneration;
  const doc = state.pdf;
  const bookId = state.book && state.book.id;
  const target = state.readerTarget;
  const config = readerConfig();
  if (!state.pdfTranslator) state.pdfTranslator = new PdfTranslator({ onStatus: onPdfTranslateStatus });
  const currentTranslator = state.pdfTranslator;
  const current = () => generation === state.pdfGeneration && doc === state.pdf && currentTranslator === state.pdfTranslator;
  state.pdfTransPending += 1;
  renderPdfProgress();
  try {
    const page = await doc.page(index);
    if (!current()) return;
    const texts = await currentTranslator.translatePage({
      bookId: bookId,
      page: page,
      target: target,
      style: 'plain',
      config: config
    });
    if (!current() || !texts) return;
    state.pdfTransFails.delete(index);
    showPdfPageTranslations(index, texts);
  } catch (err) {
    if (current()) {
      // 部分批次成功：先显示已完成的块（它们已进缓存，重试时不再计费）。
      if (Array.isArray(err && err.partial) && err.partial.some(Boolean)) showPdfPageTranslations(index, err.partial);
      if (!(err && err.code === 'config_changed')) {
        const previous = state.pdfTransFails.get(index);
        state.pdfTransFails.set(index, { at: Date.now(), count: ((previous && previous.count) || 0) + 1 });
      }
    }
    throw err;
  } finally {
    if (jobs.get(index) === token) jobs.delete(index);
    if (current()) {
      state.pdfTransPending = Math.max(0, state.pdfTransPending - 1);
      state.pdfTransDone += 1;
      renderPdfProgress();
      endPdfProgressIfIdle();
    }
  }
}

// 滚动时不要给“一闪而过”的页排队送翻：页面停满 400ms 且仍在可视范围才发请求。
// 否则快速拖到 250 页会一次排几十页，进度看起来一直卡在 2/64。
const PDF_PAGE_TRANSLATE_DELAY = 400;
function pdfPageVisible(index) {
  if (!state.pdf) return false;
  const selector = state.pdfView === 'flow'
    ? '#pdfFlow .pdf-flow-page[data-page="' + index + '"]'
    : '.pdf-pages .pdf-page[data-page="' + index + '"]';
  const el = document.querySelector(selector);
  if (!el) return false;
  // 流式页在文本加载前只有一个标签，高度很矮，会被误判成“可视”；
  // 等它真正加载出文本块后再允许排队翻译。
  if (state.pdfView === 'flow' && el.dataset.loaded !== '1') return false;
  const rect = el.getBoundingClientRect();
  if (!(rect.bottom >= -800 && rect.top <= window.innerHeight + 800)) return false;
  // 像素窗口之外再按页数限制：仅译文等模式下页面很矮，±800 px 可能覆盖十几页（QA G3）。
  // 只给屏幕上真正可见的页、前 1 页和后 2 页送翻。
  const onScreen = pdfPageWindow(0, state.pdfView === 'flow' ? '#pdfFlow' : '.pdf-pages', state.pdfView === 'flow' ? '.pdf-flow-page' : '.pdf-page');
  if (!onScreen.length) return true;
  const first = Number(onScreen[0].dataset.page);
  const last = Number(onScreen[onScreen.length - 1].dataset.page);
  return index >= first - 1 && index <= last + 2;
}

function schedulePdfPageTranslation(index) {
  if (!state.pdf || pdfPageTimers.has(index)) return;
  const timer = setTimeout(() => {
    pdfPageTimers.delete(index);
    if (!state.pdf || !pdfPageVisible(index)) return;
    translatePdfPage(index).catch(() => {});
  }, PDF_PAGE_TRANSLATE_DELAY);
  pdfPageTimers.set(index, timer);
}

function clearPdfPageTimers() {
  for (const timer of pdfPageTimers.values()) clearTimeout(timer);
  pdfPageTimers.clear();
}

function onPdfTranslateStatus(status) {
  if (!status) return;
  if (status.error) setStatus('readerStatus', 'PDF 翻译失败：' + status.error, 'error');
  else if (status.translated) setStatus('readerStatus', 'PDF 已翻译 ' + status.translated + ' 段。');
}

function buildPdfFlow() {
  let flow = document.getElementById('pdfFlow');
  if (flow) return flow;
  flow = document.createElement('div');
  flow.id = 'pdfFlow';
  flow.className = 'pdf-flow';
  for (let i = 1; i <= state.pdf.numPages; i += 1) {
    const section = document.createElement('section');
    section.className = 'pdf-flow-page';
    section.dataset.page = String(i);
    section.dataset.loaded = '0';
    const label = document.createElement('div');
    label.className = 'pdf-flow-label';
    label.textContent = '第 ' + i + ' 页';
    section.appendChild(label);
    flow.appendChild(section);
  }
  $('bookContent').appendChild(flow);
  return flow;
}

async function ensurePdfFlowPage(section) {
  if (!section || !state.pdf) return;
  if (section.dataset.loaded === '1') {
    const loadedPage = Number(section.dataset.page);
    if (state.pdfLang !== 'original' && state.config && state.config.hasKey && !state.config.authPaused
        && !(state.pdfTrans && state.pdfTrans.has(loadedPage))) {
      schedulePdfPageTranslation(loadedPage);
    }
    return;
  }
  section.dataset.loaded = '1';
  const pageNo = Number(section.dataset.page);
  const doc = state.pdf;
  try {
    const loaded = await doc.page(pageNo);
    if (doc !== state.pdf || !section.isConnected) return;
    const holder = document.createElement('div');
    holder.className = 'pdf-flow-blocks';
    for (let i = 0; i < loaded.blocks.length; i += 1) {
      const block = document.createElement('div');
      block.className = 'pdf-block';
      block.dataset.page = String(pageNo);
      block.dataset.block = String(i);
      const src = document.createElement('span');
      src.className = 'pdf-src';
      src.textContent = loaded.blocks[i].text;
      block.appendChild(src);
      holder.appendChild(block);
    }
    section.appendChild(holder);
    if (isComplexPage(loaded.blocks)) {
      const label = section.querySelector('.pdf-flow-label');
      if (label) label.textContent = '第 ' + pageNo + ' 页 · 复杂版式，文本顺序可能不准确';
    }
    applyPdfTranslations(pageNo);
    if (state.pdfLang !== 'original' && state.config && state.config.hasKey) {
      schedulePdfPageTranslation(pageNo);
    }
  } catch (err) {
    // 加载失败不能永久标成 loaded，否则滚动回来也不会再试。
    if (doc === state.pdf && section.isConnected) section.dataset.loaded = '0';
    throw err;
  }
}

function ensureVisiblePdfFlowPages() {
  const flow = document.getElementById('pdfFlow');
  if (!flow) return;
  for (const section of flow.querySelectorAll('.pdf-flow-page')) {
    const rect = section.getBoundingClientRect();
    if (rect.bottom < -700 || rect.top > window.innerHeight + 700) continue;
    ensurePdfFlowPage(section).catch(() => {});
  }
}

// 滚动事件可到 60–120 次/秒；每帧最多扫一次，避免 600 页时持续触发布局。
function schedulePdfFlowScroll() {
  if (pdfFlowScrollRaf) return;
  pdfFlowScrollRaf = requestAnimationFrame(() => {
    pdfFlowScrollRaf = 0;
    if (!state.pdf || state.pdfView !== 'flow') return;
    ensureVisiblePdfFlowPages();
    updatePdfAnchor();
  });
}

function stablePdfPage() {
  const flow = document.getElementById('pdfFlow');
  if (flow && !flow.hidden) {
    let page = 0;
    let lastRect = null;
    for (const section of flow.querySelectorAll('.pdf-flow-page')) {
      const rect = section.getBoundingClientRect();
      if (rect.top > 120) break;
      if (!section.querySelector('.pdf-flow-blocks')) {
        if (lastRect && lastRect.bottom < -120) page = 0;
        break;
      }
      page = Number(section.dataset.page);
      lastRect = rect;
    }
    if (page) return page;
    const first = Array.from(flow.querySelectorAll('.pdf-flow-page'))
      .find((section) => section.querySelector('.pdf-flow-blocks'));
    if (first) {
      const top = first.getBoundingClientRect().top;
      if (top > -120 && top <= 400) return Number(first.dataset.page);
    }
    return 0;
  }
  const pages = document.querySelector('.pdf-pages');
  if (pages && !pages.hidden) {
    let page = 0;
    let lastRect = null;
    for (const el of pages.querySelectorAll('.pdf-page')) {
      const rect = el.getBoundingClientRect();
      if (rect.top > 120) break;
      if (!el.querySelector('canvas')) {
        if (lastRect && lastRect.bottom < -120) page = 0;
        break;
      }
      page = Number(el.dataset.page);
      lastRect = rect;
    }
    if (page) return page;
    const first = Array.from(pages.querySelectorAll('.pdf-page'))
      .find((el) => el.querySelector('canvas'));
    if (first) {
      const top = first.getBoundingClientRect().top;
      if (top > -120 && top <= 400) return Number(first.dataset.page);
    }
    return 0;
  }
  return 0;
}

function updatePdfAnchor() {
  if (!state.pdf) return;
  const page = stablePdfPage();
  if (!page) return;
  let text = '';
  if (state.pdfView === 'flow') {
    const section = document.querySelector('#pdfFlow .pdf-flow-page[data-page="' + page + '"]');
    const firstBlock = section && section.querySelector('.pdf-block .pdf-src');
    text = firstBlock ? firstBlock.textContent.slice(0, 40) : '';
  }
  state.pdfAnchor = { page: page, text: text };
}

async function findPdfPageByText(text, near) {
  if (!text || !state.pdf) return 0;
  const start = Math.max(1, near - 6);
  const end = Math.min(state.pdf.numPages, near + 6);
  for (let page = start; page <= end; page += 1) {
    try {
      const loaded = await state.pdf.page(page);
      if (loaded.blocks.some((block) => block.text.includes(text))) return page;
    } catch (err) { /* 跳过 */ }
  }
  return 0;
}

async function applyPdfViewMode(epoch) {
  if (!state.pdf) return;
  if (epoch != null && epoch !== pdfViewEpoch) return;
  const content = $('bookContent');
  const pages = content.querySelector('.pdf-pages');
  const flow = state.pdfView === 'flow' ? buildPdfFlow() : document.getElementById('pdfFlow');
  content.dataset.pdfMode = state.pdfLang;
  content.classList.toggle('pdf-flow-mode', state.pdfView === 'flow');
  if (pages) pages.hidden = state.pdfView === 'flow';
  if (flow) flow.hidden = state.pdfView !== 'flow';
  const flowBanner = document.getElementById('pdfFlowBanner');
  if (flowBanner) flowBanner.hidden = state.pdfView !== 'flow';
  updatePdfZoomUi();
  if (state.pdfView === 'flow') {
    const anchorPage = state.pdfAnchor && state.pdfAnchor.page ? state.pdfAnchor.page : 1;
    const section = flow && flow.querySelector('.pdf-flow-page[data-page="' + anchorPage + '"]');
    if (section) section.scrollIntoView({ block: 'start' });
    ensureVisiblePdfFlowPages();
    if (state.pdfLang !== 'original' && state.config && state.config.hasKey) {
      beginPdfTranslation();
      for (const index of visibleFlowPageIndexes()) schedulePdfPageTranslation(index);
    }
  } else {
    let page = state.pdfAnchor && state.pdfAnchor.page ? state.pdfAnchor.page : 1;
    if (state.pdfAnchor && state.pdfAnchor.text) {
      const found = await findPdfPageByText(state.pdfAnchor.text, page);
      if (epoch != null && epoch !== pdfViewEpoch) return;
      if (found) page = found;
    }
    jumpToPdfPage(page);
    renderVisiblePdfPages();
    if (state.pdfLang !== 'original' && state.config && state.config.hasKey) {
      beginPdfTranslation();
      for (const index of visiblePdfPageIndexes()) schedulePdfPageTranslation(index);
    }
  }
  updatePdfAnchor();
}

async function openPdfBook(record, seq, signal) {
  pdfRasterEpoch += 1;
  pdfRenderQueue = Promise.resolve();
  if (seq !== openSeq) return;
  cancelPdfTranslations(true);
  pdfViewEpoch += 1;
  clearTimeout(pdfModeTimer);
  if (pdfFlowScrollRaf) { cancelAnimationFrame(pdfFlowScrollRaf); pdfFlowScrollRaf = 0; }
  if (state.pdf) { try { state.pdf.destroy(); } catch (err) { /* ignore */ } }
  if (state.pdfObserver) { state.pdfObserver.disconnect(); state.pdfObserver = null; }
  const file = await getBookFile(record.id);
  if (seq !== openSeq) return;
  if (!file) throw new Error('书文件丢失，请重新导入。');
  const buffer = await file.arrayBuffer();
  if (seq !== openSeq) return;
  const doc = await loadPdfDocument(buffer, signal);
  if (seq !== openSeq) { try { doc.destroy(); } catch (err) { /* ignore */ } return; }
  state.pdf = doc;
  state.pdfIdentity = await pdfCacheIdentity(readerConfig(), state.readerTarget, 'plain');
  if (seq !== openSeq) {
    if (state.pdf === doc) state.pdf = null;
    try { doc.destroy(); } catch (err) { /* ignore */ }
    return;
  }
  state.pdfStopped = false;
  state.book = record;
  // 元数据在打开时补齐（导入时只存文件，避免同页开两个 pdf.js 文档）
  if (doc.metadata && doc.metadata.title && doc.metadata.title !== '未命名 PDF') {
    record.title = doc.metadata.title;
    record.authors = doc.metadata.authors || [];
    record.language = doc.metadata.language || '';
    record.metadata = doc.metadata;
    await saveBook(record);
    if (seq !== openSeq) return;
  }
  state.doc = null;
  state.section = null;
  const savedMode = record.pdfMode || 'pdf-original';
  const savedOption = PDF_MODE_OPTIONS.find((option) => option.value === savedMode) || PDF_MODE_OPTIONS[0];
  state.mode = savedOption.lang;
  state.pdfView = savedOption.view;
  state.pdfLang = savedOption.lang;
  state.pdfAnchor = null;
  setModeOptions('pdf');
  const pdfNav = document.querySelector('.pdf-nav');
  if (pdfNav) pdfNav.hidden = false;
  const searchResults = document.getElementById('pdfSearchResults');
  if (searchResults) searchResults.textContent = '';
  state.pdfTrans = new Map();
  state.pdfZoom = 1;
  if (state.pdfTranslator) state.pdfTranslator.stop();
  state.pdfTranslator = null;
  updatePdfZoomUi();
  $('libraryView').hidden = true;
  $('readerView').hidden = false;
  $('modeSelect').disabled = false;
  $('modeSelect').value = savedMode;
  $('targetSelect').disabled = false;
  $('tocToggle').disabled = false;
  $('translateChapter').disabled = !(state.config && state.config.hasKey && !state.config.authPaused);
  const content = $('bookContent');
  content.textContent = '';
  content.dataset.pdfMode = state.pdfLang;
  const wrap = document.createElement('div');
  wrap.className = 'pdf-pages';
  content.appendChild(wrap);
  const first = await doc.page(1);
  if (seq !== openSeq) {
    if (state.pdf === doc) state.pdf = null;
    try { doc.destroy(); } catch (err) { /* ignore */ }
    return;
  }
  const ratio = first.viewport.height / Math.max(1, first.viewport.width);
  for (let i = 1; i <= doc.numPages; i += 1) {
    const pageEl = document.createElement('section');
    pageEl.className = 'pdf-page';
    pageEl.dataset.page = String(i);
    pageEl.style.setProperty('--pdf-ratio', ratio.toFixed(4));
    const label = document.createElement('div');
    label.className = 'pdf-page-label';
    label.textContent = '第 ' + i + ' / ' + doc.numPages + ' 页';
    pageEl.appendChild(label);
    wrap.appendChild(pageEl);
  }
  $('tocList').textContent = '';
  const tocWrap = document.createElement('div');
  setReaderHeader({ title: 'PDF · ' + doc.numPages + ' 页' });
  // 不用 IntersectionObserver：后台标签页里它不回调，PDF 会一直空白。
  // 改成按 getBoundingClientRect 判断可视范围，滚动 / 窗口尺寸变化时补渲染。
  state.pdfObserver = null;
  const target = Number(String((record.progress && record.progress.sectionId) || '').replace('page:', '')) || 1;
  if (target > 1) state.pdfAnchor = { page: target, text: '' };
  renderVisiblePdfPages();
  requestAnimationFrame(() => renderVisiblePdfPages());
  const viewPromise = applyPdfViewMode();
  // 先让第一页进入渲染队列，再开始目录扫描；目录晚一点出现没关系。
  const tocPromise = doc.toc().catch(() => ({ source: 'pages', entries: [] }));
  await viewPromise;
  if (seq !== openSeq) return;
  const toc = await tocPromise;
  if (seq !== openSeq) return;
  if (toc.entries.length) {
    const hint = document.createElement('div');
    hint.className = 'toc-hint';
    hint.textContent = toc.source === 'outline' ? '目录来自 PDF 书签' : '目录来自书内目录页（页码为书内页码）';
    tocWrap.appendChild(hint);
    for (const entry of toc.entries) {
      const row = document.createElement('div');
      row.className = 'toc-item';
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = entry.title + (entry.page ? ' · p.' + entry.page : '');
      a.addEventListener('click', (event) => {
        event.preventDefault();
        const target = Math.max(1, Math.min(doc.numPages, Number(entry.page) || 1));
        jumpToPdfPage(target);
      });
      row.appendChild(a);
      tocWrap.appendChild(row);
    }
  } else {
    for (let i = 1; i <= Math.min(doc.numPages, 200); i += 1) {
      const row = document.createElement('div');
      row.className = 'toc-item';
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = '第 ' + i + ' 页';
      a.addEventListener('click', (event) => { event.preventDefault(); jumpToPdfPage(i); });
      row.appendChild(a);
      tocWrap.appendChild(row);
    }
  }
  $('tocList').appendChild(tocWrap);
  record.lastOpenedAt = Date.now();
  await saveBook(record);
}

let pdfRenderQueue = Promise.resolve();
let pdfRasterEpoch = 0;
function pdfPageWindow(margin, rootSelector, pageSelector) {
  const root = document.querySelector(rootSelector || '.pdf-pages');
  if (!root || root.hidden) return [];
  const pages = Array.from(root.querySelectorAll(pageSelector || '.pdf-page'));
  if (!pages.length) return [];
  const pad = margin === undefined ? 800 : margin;
  const topLimit = -pad;
  // 页面按顺序堆叠，先二分找到第一个仍在上边距内的页，再从它往后扫；
  // 不再为每一页读一次 getBoundingClientRect（500 页时每次滚动省下大量布局计算）。
  let lo = 0;
  let hi = pages.length - 1;
  let first = pages.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = pages[mid].getBoundingClientRect();
    if (rect.top + rect.height >= topLimit) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const bottomLimit = window.innerHeight + pad;
  const out = [];
  for (let i = first; i < pages.length; i += 1) {
    if (pages[i].getBoundingClientRect().top > bottomLimit) break;
    out.push(pages[i]);
  }
  return out;
}

function visiblePdfPageIndexes() {
  return pdfPageWindow(800).map((el) => Number(el.dataset.page));
}

function renderVisiblePdfPages() {
  if (!state.pdf) return;
  const pages = pdfPageWindow(800);
  for (const el of pages) { const canvas = el.querySelector('canvas'); if (canvas) state.pdf.touchCanvas(canvas); }
  for (const el of pages) {
    if (el.dataset.rendered === '1') continue;
    // 一页一页排队：pdf.js 的 render task 并发容易互相拖慢
    el.dataset.rendered = '1';
    const epoch = pdfRasterEpoch;
    pdfRenderQueue = pdfRenderQueue
      .then(() => renderPdfPage(el, Number(el.dataset.page), epoch))
      .catch((err) => {
        if (!el.isConnected || epoch !== pdfRasterEpoch || err.name === 'AbortError' || err.name === 'RenderingCancelledException') return;
        delete el.dataset.rendered;
        let note = el.querySelector('.pdf-render-failed');
        if (!note) {
          note = document.createElement('p');
          note.className = 'pdf-empty-text pdf-render-failed';
          el.appendChild(note);
        }
        note.textContent = '本页渲染失败，点击重试。';
        note.onclick = () => {
          note.remove();
          delete el.dataset.rendered;
          renderVisiblePdfPages();
        };
      });
  }
  // 译文内存只保留最近页；滚回旧页时直接复用 IndexedDB 缓存补回来。
  if (state.pdfLang !== 'original' && state.config && state.config.hasKey && !state.config.authPaused) {
    for (const el of pages) {
      const page = Number(el.dataset.page);
      if (el.dataset.rendered !== '1') continue;
      if (state.pdfTrans && state.pdfTrans.has(page)) continue;
      schedulePdfPageTranslation(page);
    }
  }
}

function closeReader() {
  pdfRasterEpoch += 1;
  pdfRenderQueue = Promise.resolve();
  epubOpenController?.abort();
  openSeq += 1;
  searchSeq += 1;
  cancelPdfTranslations(true);
  pdfViewEpoch += 1;
  clearTimeout(pdfModeTimer);
  if (pdfFlowScrollRaf) { cancelAnimationFrame(pdfFlowScrollRaf); pdfFlowScrollRaf = 0; }
  state.pdfIdentity = '';
  if (state.pdf) { try { state.pdf.destroy(); } catch (err) { /* ignore */ } state.pdf = null; }
  if (state.pdfObserver) { state.pdfObserver.disconnect(); state.pdfObserver = null; }
  const pdfNav = document.querySelector('.pdf-nav');
  if (pdfNav) pdfNav.hidden = true;
  state.pdfPage = 0;
  state.pdfZoom = 1;
  updatePdfZoomUi();
  translator && translator.stop();
  for (const url of state.noteAssets) { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }
  state.noteAssets = [];
  try { window.__DT && window.__DT.restore && window.__DT.restore(); } catch (err) { /* ignore */ }
  if (state.assets.length) {
    for (const url of state.assets) { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }
  }
  state.assets = [];
  state.book = null;
  state.doc = null;
  state.section = null;
  $('readerView').hidden = true;
  $('libraryView').hidden = false;
  $('tocPanel').hidden = true;
  $('footnotePanel').hidden = true;
  $('readerTitle').textContent = '凛狐阅读器';
  $('readerSubtitle').textContent = '';
  $('modeSelect').disabled = true;
  $('targetSelect').disabled = true;
  $('translateChapter').disabled = true;
  $('tocToggle').disabled = true;
  $('bookContent').textContent = '';
  renderLibrary();
}

function setReaderHeader(section) {
  $('readerTitle').textContent = (state.book && state.book.title) || '凛狐阅读器';
  const author = state.book && state.book.authors && state.book.authors.length ? state.book.authors.join(' · ') : '';
  const secTitle = section && section.title ? ' · ' + section.title : '';
  $('readerSubtitle').textContent = author + secTitle;
}

function renderToc(items, parent) {
  const list = document.createElement('div');
  for (const item of items || []) {
    const row = document.createElement('div');
    row.className = 'toc-item';
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = item.title || 'Untitled';
    a.addEventListener('click', (event) => {
      event.preventDefault();
      jumpTo(item.sectionHref, item.href.split('#')[1] || '');
    });
    row.appendChild(a);
    if (item.children && item.children.length) {
      const child = document.createElement('div');
      child.className = 'toc-children';
      renderToc(item.children, child);
      row.appendChild(child);
    }
    list.appendChild(row);
  }
  parent.appendChild(list);
}

function sectionForHref(href) {
  if (!state.doc) return null;
  return state.doc.sections.find((sec) => sec.href === href) || null;
}

async function jumpTo(sectionHref, fragment) {
  const sec = sectionForHref(sectionHref);
  if (!sec) return;
  if (state.section && sec.id === state.section.id) {
    scrollToFragment(fragment);
    return;
  }
  await loadSection(sec.id, fragment);
}

async function showFootnote(targetHref, fragment) {
  if (!fragment || !state.doc) return;
  let host = null;
  if (state.section && targetHref === state.section.href) host = $('bookContent');
  if (!host) {
    const sec = sectionForHref(targetHref);
    if (!sec) return;
    const raw = sec.load();
    const san = sanitizeXhtml(raw.html, { baseHref: raw.baseHref, book: state.doc, document, DOMParser: window.DOMParser });
    for (const url of san.assets.values()) state.noteAssets.push(url);
    host = document.createElement('div');
    host.appendChild(san.fragment);
  }
  let target = null;
  try { target = host.querySelector('#' + CSS.escape(fragment)); } catch (err) { target = null; }
  if (!target) return;
  const body = $('footnoteBody');
  body.textContent = '';
  const clone = target.cloneNode(true);
  clone.removeAttribute('id');
  body.appendChild(clone);
  $('footnotePanel').hidden = false;
}

function scrollToFragment(fragment) {
  const content = $('bookContent');
  if (!fragment) { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
  let target = null;
  try { target = content.querySelector('#' + CSS.escape(fragment)); } catch (err) { target = document.getElementById(fragment); }
  if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function openBook(record) {
  epubOpenController?.abort();
  const controller = new AbortController();
  epubOpenController = controller;
  const seq = ++openSeq;
  await loadConfig();
  if (seq !== openSeq) return;
  // 没有配置也能读原文；只有翻译相关入口不可用
  if (record.format === 'pdf') {
    try { await openPdfBook(record, seq, controller.signal); } catch (err) {
      if (seq !== openSeq) return;
      setStatus('libraryStatus', errorText(err), 'error');
      closeReader();
    }
    return;
  }
  if (state.pdf) { try { state.pdf.destroy(); } catch (err) { /* ignore */ } state.pdf = null; }
  cancelPdfTranslations(true);
  if (state.pdfObserver) { state.pdfObserver.disconnect(); state.pdfObserver = null; }
  updatePdfZoomUi();
  try {
    const file = await getBookFile(record.id);
    if (seq !== openSeq) return;
    if (!file) throw new Error('书文件丢失，请重新导入。');
    const buffer = await file.arrayBuffer();
    if (seq !== openSeq) return;
    const doc = await loadEpub(buffer, { signal: controller.signal });
    if (seq !== openSeq) return;
    state.book = record;
    state.doc = doc;
    state.mode = record.mode || 'original';
    setModeOptions('epub');
    const pdfNav = document.querySelector('.pdf-nav');
    if (pdfNav) pdfNav.hidden = true;
    $('libraryView').hidden = true;
    $('readerView').hidden = false;
    $('modeSelect').disabled = false;
    $('targetSelect').disabled = false;
    $('tocToggle').disabled = false;
    $('translateChapter').disabled = !(state.config && state.config.hasKey && !state.config.authPaused);
    translator = translator || new ReaderTranslator({ onStatus: onTranslateStatus });
    await translator.configure(readerConfig());
    if (seq !== openSeq) return;
    translator.setDocument(doc);
    $('modeSelect').value = state.mode;
    const progress = record.progress || {};
    const sec = doc.sections.find((one) => one.id === progress.sectionId) || doc.sections[0];
    $('tocList').textContent = '';
    renderToc(doc.toc, $('tocList'));
    if (!sec) throw new Error('章节为空');
    await loadSection(sec.id, '', progress.offsetRatio || 0);
    if (seq !== openSeq) return;
    record.lastOpenedAt = Date.now();
    await saveBook(record);
  } catch (err) {
    if (seq !== openSeq) return;
    setStatus('libraryStatus', errorText(err), 'error');
    closeReader();
  }
}

async function loadSection(sectionId, fragment, offsetRatio) {
  if (!state.doc) return;
  const sec = state.doc.sections.find((one) => one.id === sectionId);
  if (!sec) return;
  const seq = openSeq;
  translator && translator.stop();
  try { window.__DT && window.__DT.restore && window.__DT.restore(); } catch (err) { /* ignore */ }
  for (const url of state.assets) { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }
  for (const url of state.noteAssets) { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }
  state.assets = [];
  state.noteAssets = [];
  const content = $('bookContent');
  $('footnotePanel').hidden = true;
  content.textContent = '';
  const raw = sec.load();
  const sanitized = sanitizeXhtml(raw.html, {
    baseHref: raw.baseHref,
    book: state.doc,
    document,
    DOMParser: window.DOMParser
  });
  for (const url of sanitized.assets.values()) state.assets.push(url);
  content.appendChild(sanitized.fragment);
  state.section = sec;
  translator && translator.setDocument(state.doc);
  setReaderHeader(sec);
  $('translateChapter').disabled = !(state.config && state.config.hasKey && !state.config.authPaused);
  const mode = state.mode || 'original';
  if (translator) await translator.start(state.book, sec, content, mode);
  if (seq !== openSeq) return;
  const ratio = typeof offsetRatio === 'number' ? Math.max(0, Math.min(1, offsetRatio)) : 0;
  requestAnimationFrame(() => {
    if (fragment) scrollToFragment(fragment);
    else {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.round(max * ratio), behavior: 'instant' });
    }
    saveProgressSoon();
  });
  if (state.book) {
    state.book.progress = { sectionId: sec.id, offsetRatio: ratio };
  }
}

function onTranslateStatus(status) {
  if (status && status.error) {
    setStatus('readerStatus', '翻译失败：' + status.error, 'error');
  } else if (status && status.units) {
    setStatus('readerStatus', '已准备 ' + status.units + ' 段；滚动到哪，翻到哪。');
  } else if (status && status.translated) {
    setStatus('readerStatus', '已翻译 ' + status.translated + ' 段。');
  } else if (status && status.sameLanguage) {
    setStatus('readerStatus', '原文已经是目标语言，未发送翻译请求。');
  } else if (status && status.hasKey === false) {
    setStatus('readerStatus', '尚未配置翻译 API。');
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    setStatus('readerStatus', '当前环境不支持全屏。', 'error');
  }
}

function saveProgressSoon() {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = 0;
    if (!state.book) return;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = Math.max(0, Math.min(1, window.scrollY / max));
    if (state.pdf) {
      updatePdfAnchor();
      const current = (state.pdfAnchor && state.pdfAnchor.page) || 1;
      state.pdfPage = current;
      state.book.progress = { sectionId: 'page:' + current, offsetRatio: ratio };
    } else if (state.section) {
      state.book.progress = { sectionId: state.section.id, offsetRatio: ratio };
    } else {
      return;
    }
    state.book.lastOpenedAt = Date.now();
    saveProgress(state.book.id, state.book.progress).catch(() => {});
  }, 500);
}

async function changeMode(mode) {
  if (!state.book) return;
  if (state.pdf) {
    const epoch = ++pdfViewEpoch;
    const stable = stablePdfPage();
    if (stable) state.pdfAnchor = { page: stable, text: '' };
    await loadConfig();
    if (epoch !== pdfViewEpoch || !state.pdf || !state.book) return;
    const option = PDF_MODE_OPTIONS.find((item) => item.value === mode);
    if (!option) return;
    state.pdfView = option.view;
    state.pdfLang = option.lang;
    state.mode = option.lang;
    if (option.lang !== 'original') state.pdfStopped = false;
    state.book.pdfMode = mode;
    $('modeSelect').value = mode;
    try { await saveBook(state.book); } catch (err) { /* ignore */ }
    if (epoch !== pdfViewEpoch) return;
    const hasKey = state.config && state.config.hasKey && !state.config.authPaused;
    if (option.lang !== 'original' && state.config && state.config.authPaused) {
      setStatus('readerStatus', '接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。', 'error');
    } else if (option.lang !== 'original' && !hasKey) {
      setStatus('readerStatus', '还没有配置翻译 API，流式视图可看原文。', 'error');
    } else {
      setStatus('readerStatus', option.text + '模式。');
    }
    // 快速连点时只应用最后一次；120ms 足够合并一次真实点击，又不会让用户觉得卡。
    clearTimeout(pdfModeTimer);
    pdfModeTimer = setTimeout(() => {
      if (epoch === pdfViewEpoch) applyPdfViewMode(epoch).catch(() => {});
    }, 120);
    return;
  }
  $('modeSelect').value = mode;
  state.mode = mode;
  state.book.mode = mode;
  try { await saveBook(state.book); } catch (err) { /* ignore */ }
  $('translateChapter').disabled = !(state.config && state.config.hasKey && !state.config.authPaused);
  translator && translator.stop();
  try { window.__DT && window.__DT.restore && window.__DT.restore(); } catch (err) { /* ignore */ }
  if (mode === 'original') {
    setStatus('readerStatus', '原文模式。');
    return;
  }
  if (!(state.config && state.config.hasKey && !state.config.authPaused)) {
    setStatus('readerStatus', state.config && state.config.authPaused ? '接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。' : '还没有配置翻译 API，无法显示译文。', 'error');
    return;
  }
  await translator.start(state.book, state.section, $('bookContent'), mode);
}

function bindEvents() {
  $('cancelImport').addEventListener('click', () => importController?.abort());
  $('fileInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    importFile(file);
  });
  const drop = $('dropZone');
  ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    importFile(file);
  });
  $('backToLibrary').addEventListener('click', () => {
    closeReader();
  });
  $('tocToggle').addEventListener('click', () => { $('tocPanel').hidden = !$('tocPanel').hidden; });
  $('tocClose').addEventListener('click', () => { $('tocPanel').hidden = true; });
  $('modeSelect').addEventListener('change', () => changeMode($('modeSelect').value));
  $('targetSelect').addEventListener('change', changeTarget);
  $('translateChapter').addEventListener('click', async () => {
    await loadConfig();
    if (!(state.config && state.config.hasKey && !state.config.authPaused)) return;
    if (state.pdf) {
      state.pdfStopped = false;
      if (state.pdfLang === 'original') await changeMode('flow-bilingual');
      const pages = state.pdfView === 'flow' ? visibleFlowPageIndexes() : visiblePdfPageIndexes();
      setStatus('readerStatus', '正在翻译当前 ' + pages.length + ' 页…');
      beginPdfTranslation();
      for (const index of pages) schedulePdfPageTranslation(index);
      return;
    }
    if (!translator || !state.section) return;
    const stats = translator.chapterStats();
    if ((stats.units > 400 || stats.chars > 50000) && !confirm('本章约 ' + stats.units + ' 段 / ' + stats.chars + ' 字，会分批发送翻译请求。继续？')) return;
    if (state.mode === 'original') await changeMode('bilingual');
    await translator.translateChapter();
  });
  $('settingsToggle').addEventListener('click', () => {
    if (!$('settingsDialog').open) $('settingsDialog').showModal();
  });
  $('fullscreenToggle').addEventListener('click', toggleFullscreen);
  $('pdfZoomOut').addEventListener('click', () => applyPdfZoom(-0.25));
  $('pdfZoomIn').addEventListener('click', () => applyPdfZoom(0.25));
  $('pdfFitWidth').addEventListener('click', () => setPdfZoom(1));
  $('pdfFitColumn').addEventListener('click', () => setPdfZoom(1.9));
  $('pdfFlowBack').addEventListener('click', () => changeMode('pdf-original'));
  $('pdfJumpGo').addEventListener('click', () => {
    if (!state.pdf) return;
    const page = Number($('pdfJumpInput').value);
    if (!page) return;
    jumpToPdfHit(page);
  });
  $('pdfJumpInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('pdfJumpGo').click();
  });
  $('pdfSearchGo').addEventListener('click', () => searchPdf($('pdfSearchInput').value));
  $('pdfSearchInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('pdfSearchGo').click();
  });
  $('pdfTranslateStop').addEventListener('click', () => {
    cancelPdfTranslations(false);
    $('pdfTranslateStop').hidden = true;
    setStatus('readerStatus', '已停止翻译。');
  });
  $('bookContent').addEventListener('wheel', (event) => {
    if (!state.pdf || !event.ctrlKey) return;
    event.preventDefault();
    applyPdfZoom(event.deltaY < 0 ? 0.25 : -0.25);
  }, { passive: false });
  document.addEventListener('fullscreenchange', () => {
    $('fullscreenToggle').textContent = document.fullscreenElement ? '⤡' : '⛶';
    $('fullscreenToggle').title = document.fullscreenElement ? '退出全屏' : '全屏阅读';
  });
  $('fontSize').addEventListener('input', () => saveSettings({ fontSize: Number($('fontSize').value) }));
  $('lineHeight').addEventListener('input', () => saveSettings({ lineHeight: Number($('lineHeight').value) }));
  $('measure').addEventListener('input', () => saveSettings({ measure: Number($('measure').value) }));
  $('letterSpacing').addEventListener('input', () => saveSettings({ letterSpacing: Number($('letterSpacing').value) }));
  $('paragraphSpacing').addEventListener('input', () => saveSettings({ paragraphSpacing: Number($('paragraphSpacing').value) }));
  $('maxBookMb').addEventListener('change', () => {
    const mb = Math.max(50, Math.min(500, Math.round(Number($('maxBookMb').value) || 100)));
    $('maxBookMb').value = String(mb);
    saveSettings({ maxBookBytes: mb * 1024 * 1024 });
  });
  $('themeSelect').addEventListener('change', () => saveSettings({ theme: $('themeSelect').value }));
  $('fontSelect').addEventListener('change', () => saveSettings({ fontFamily: $('fontSelect').value }));
  $('userFontUploadBtn').addEventListener('click', () => $('userFontInput').click());
  $('userFontInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    handleUserFontFile(file);
  });
  $('userFontRemove').addEventListener('click', removeUserFont);
  window.addEventListener('scroll', () => {
    saveProgressSoon();
    if (!state.pdf) return;
    if (state.pdfView === 'flow') {
      schedulePdfFlowScroll();
    } else {
      renderVisiblePdfPages();
    }
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!state.pdf) return;
    if (state.pdfView === 'flow') ensureVisiblePdfFlowPages();
    else renderVisiblePdfPages();
  }, { passive: true });
  // pdf.js 的 render 靠 rAF 推进；标签页切到后台会暂停，回来时必须补渲染
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.pdf) renderVisiblePdfPages();
  });
  document.addEventListener('keydown', (event) => {
    if ($('readerView').hidden) return;
    if (event.target && /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.key === 'ArrowLeft') {
      const i = state.doc.sections.findIndex((s) => s.id === (state.section && state.section.id));
      if (i > 0) { event.preventDefault(); loadSection(state.doc.sections[i - 1].id, ''); }
    } else if (event.key === 'ArrowRight') {
      const i = state.doc.sections.findIndex((s) => s.id === (state.section && state.section.id));
      if (i >= 0 && i < state.doc.sections.length - 1) { event.preventDefault(); loadSection(state.doc.sections[i + 1].id, ''); }
    }
  });
  $('bookContent').addEventListener('click', (event) => {
    const note = event.target.closest && event.target.closest('a[data-reader-note]');
    if (note) {
      event.preventDefault();
      showFootnote(note.getAttribute('data-reader-target'), note.getAttribute('data-reader-fragment') || '');
      return;
    }
    const link = event.target.closest && event.target.closest('a[data-reader-target]');
    if (!link) return;
    event.preventDefault();
    jumpTo(link.getAttribute('data-reader-target'), link.getAttribute('data-reader-fragment') || '');
  });
  $('footnoteClose').addEventListener('click', () => {
    $('footnotePanel').hidden = true;
    for (const url of state.noteAssets) { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }
    state.noteAssets = [];
  });
}

async function boot() {
  state.settings = await getReaderSettings();
  await loadUserFont();
  applySettings();
  await loadConfig();
  // 阅读器的目标语言独立保存；首次打开时继承网页翻译的当前目标，之后互不影响
  const settings = state.settings || {};
  const fallback = (state.config && (state.config.targetLang || (state.config.activeLanguage && state.config.activeLanguage.value))) || '';
  state.readerTarget = settings.targetLang || fallback;
  renderTargetSelect();
  translator = new ReaderTranslator({ onStatus: onTranslateStatus });
  if (state.config) await translator.configure(readerConfig());
  bindEvents();
  // 阅读器是可信扩展页；只重拉去 Key 的配置，配置变化不自动触发付费翻译。
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && (changes.config || changes[LOCAL_SECRETS])) || (area === 'session' && changes[SESSION_SECRETS])) loadConfig().catch(() => {});
  });
  await renderLibrary();
}

boot().catch((err) => {
  setStatus('libraryStatus', errorText(err), 'error');
});
