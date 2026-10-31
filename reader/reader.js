// 阅读器页面入口：书库、章节渲染、阅读进度、设置。
// EPUB 结构由 lib/reader/epub.js；清洗由 lib/reader/sanitize.js；
// 翻译复用 content/dom.js 的 collect/inject，缓存由 reader 自己管理。
import { parseEpub, EpubError } from '../lib/reader/epub.js';
import { sanitizeXhtml } from '../lib/reader/sanitize.js';
import { listBooks, getBook, saveBook, deleteBook, saveProgress, sha256, getReaderSettings, saveReaderSettings, estimateUsage, requestPersistence, getUserFont, saveUserFont, deleteUserFont, deleteBookTranslations, READER_LIMITS } from '../lib/reader/store.js';
import { saveConfig } from '../lib/config.js';
import { ReaderTranslator } from '../lib/reader/translate.js';
import { PdfTranslator } from '../lib/reader/pdf-translate.js';
import { openPdfDocument, looksLikePdf } from '../lib/reader/pdf.js';

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
  const code = err && err.code;
  const map = {
    not_epub: '这不是可读取的 EPUB 文件。',
    drm_protected: '这本 EPUB 有 DRM / 加密保护，凛狐不会绕过。',
    unsupported_layout: '暂不支持固定版式 EPUB（0.13.0 只支持可重排文字书）。',
    too_large: '文件太大：单本最多 100 MB，书库最多 500 MB。',
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
  const res = await runtimeMessage({ type: 'config:get' });
  state.config = res && res.ok ? res.config : null;
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
    state.readerTarget = target;
    if (state.pdf) {
      state.pdfTrans = new Map();
      if (state.pdfTranslator) state.pdfTranslator.stop();
      state.pdfTranslator = null;
      document.querySelectorAll('.pdf-trans').forEach((node) => node.remove());
      state.mode = 'original';
      $('modeSelect').value = 'original';
      state.book.mode = 'original';
      $('bookContent').dataset.pdfMode = 'original';
      try { await saveBook(state.book); } catch (err) { /* ignore */ }
      setStatus('readerStatus', '目标语言已切换（只影响阅读器）；点「双语」或「翻译本章」按新语言翻译 PDF。');
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
    try { await deleteBookTranslations(state.book.id); } catch (err) { /* cache cleanup is best effort */ }
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
  $('maxBookMb').value = String(Math.round((Number(s.maxBookBytes) || READER_LIMITS.maxBookBytes) / 1048576));
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
  try { await saveReaderSettings(state.settings); } catch (err) { /* ignore */ }
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

async function importFile(file) {
  if (!file) return;
  const maxBookBytes = (state.settings && Number(state.settings.maxBookBytes)) || READER_LIMITS.maxBookBytes;
  if (file.size > maxBookBytes) {
    setStatus('libraryStatus', '文件超过 ' + Math.round(maxBookBytes / 1048576) + ' MB 上限，可在设置里调高。', 'error');
    return;
  }
  setStatus('libraryStatus', '正在解析…');
  try {
    const est = await estimateUsage();
    if (est.usage && est.quota && est.usage + file.size > READER_LIMITS.maxLibraryBytes) {
      setStatus('libraryStatus', '书库接近 500 MB，请先删除一本书。', 'error');
      return;
    }
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);
    const existing = await getBook(hash);
    if (existing) {
      setStatus('libraryStatus', '这本书已导入，直接打开。', 'ok');
      await openBook(existing);
      return;
    }
    if (/\.pdf$/i.test(file.name) || looksLikePdf(new Uint8Array(buffer))) {
      await importPdf(file, buffer, hash);
      return;
    }
    const doc = parseEpub(buffer);
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
      fileBlob: file,
      toc: doc.toc,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      mode: 'original',
      progress: { sectionId: first ? first.id : '', offsetRatio: 0 }
    };
    await saveBook(record);
    requestPersistence().catch(() => {});
    setStatus('libraryStatus', '已导入。', 'ok');
    await renderLibrary();
    await openBook(record);
  } catch (err) {
    setStatus('libraryStatus', errorText(err), 'error');
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
    fileBlob: file,
    toc: [],
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    mode: 'original',
    progress: { sectionId: 'page:1', offsetRatio: 0 }
  };
  await saveBook(record);
  requestPersistence().catch(() => {});
  setStatus('libraryStatus', '已导入。', 'ok');
  await renderLibrary();
  await openBook(record);
}

function loadPdfDocument(buffer) {
  return openPdfDocument({
    data: buffer,
    loadPdfjs: () => import(chrome.runtime.getURL('reader/vendor/pdfjs/pdf.min.mjs')),
    workerSrc: chrome.runtime.getURL('reader/vendor/pdfjs/pdf.worker.min.mjs'),
    cMapUrl: chrome.runtime.getURL('reader/vendor/pdfjs/cmaps/')
  });
}

function jumpToPdfPage(n) {
  const el = document.querySelector('.pdf-page[data-page="' + n + '"]');
  if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
}

async function renderPdfPage(el, index) {
  const doc = state.pdf;
  if (!doc) return;
  const loaded = await doc.page(index);
  const width = el.clientWidth || 720;
  const scale = Math.max(0.5, Math.min(2, width / loaded.viewport.width));
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  await doc.render(index, canvas, scale);
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
    applyPdfTranslations(index);
    if (state.mode !== 'original' && state.config && state.config.hasKey) {
      translatePdfPage(index).catch((err) => setStatus('readerStatus', 'PDF 翻译失败：' + ((err && err.message) || '未知错误'), 'error'));
    }
  } else {
    const note = document.createElement('p');
    note.className = 'pdf-empty-text';
    note.textContent = '本页没有可提取的文字（可能是扫描页）。';
    el.appendChild(note);
  }
}

function applyPdfTranslations(index) {
  const texts = (state.pdfTrans && state.pdfTrans.get(index)) || [];
  const el = document.querySelector('.pdf-page[data-page="' + index + '"]');
  if (!el) return;
  const blocks = el.querySelectorAll('.pdf-block');
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

async function translatePdfPage(index) {
  if (!state.pdf || !state.config || !state.config.hasKey) return;
  if (!state.pdfTranslator) state.pdfTranslator = new PdfTranslator({ onStatus: onPdfTranslateStatus });
  const page = await state.pdf.page(index);
  const texts = await state.pdfTranslator.translatePage({
    bookId: state.book && state.book.id,
    page: page,
    target: state.readerTarget,
    style: 'plain'
  });
  if (!state.pdfTrans) state.pdfTrans = new Map();
  state.pdfTrans.set(index, texts);
  applyPdfTranslations(index);
}

function onPdfTranslateStatus(status) {
  if (!status) return;
  if (status.error) setStatus('readerStatus', 'PDF 翻译失败：' + status.error, 'error');
  else if (status.translated) setStatus('readerStatus', 'PDF 已翻译 ' + status.translated + ' 段。');
}

async function openPdfBook(record) {
  if (state.pdf) { try { state.pdf.destroy(); } catch (err) { /* ignore */ } }
  if (state.pdfObserver) { state.pdfObserver.disconnect(); state.pdfObserver = null; }
  const buffer = await record.fileBlob.arrayBuffer();
  const doc = await loadPdfDocument(buffer);
  state.pdf = doc;
  state.book = record;
  // 元数据在打开时补齐（导入时只存文件，避免同页开两个 pdf.js 文档）
  if (doc.metadata && doc.metadata.title && doc.metadata.title !== '未命名 PDF') {
    record.title = doc.metadata.title;
    record.authors = doc.metadata.authors || [];
    record.language = doc.metadata.language || '';
    record.metadata = doc.metadata;
    await saveBook(record);
  }
  state.doc = null;
  state.section = null;
  state.mode = record.mode || 'original';
  state.pdfTrans = new Map();
  if (state.pdfTranslator) state.pdfTranslator.stop();
  state.pdfTranslator = null;
  $('libraryView').hidden = true;
  $('readerView').hidden = false;
  $('modeSelect').disabled = false;
  $('modeSelect').value = state.mode;
  $('targetSelect').disabled = false;
  $('tocToggle').disabled = false;
  $('translateChapter').disabled = !(state.config && state.config.hasKey);
  const content = $('bookContent');
  content.textContent = '';
  content.dataset.pdfMode = state.mode;
  const wrap = document.createElement('div');
  wrap.className = 'pdf-pages';
  content.appendChild(wrap);
  const first = await doc.page(1);
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
  let toc = { source: 'pages', entries: [] };
  try { toc = await doc.toc(); } catch (err) { toc = { source: 'pages', entries: [] }; }
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
  setReaderHeader({ title: 'PDF · ' + doc.numPages + ' 页' });
  // 不用 IntersectionObserver：后台标签页里它不回调，PDF 会一直空白。
  // 改成按 getBoundingClientRect 判断可视范围，滚动 / 窗口尺寸变化时补渲染。
  state.pdfObserver = null;
  renderVisiblePdfPages();
  requestAnimationFrame(() => renderVisiblePdfPages());
  record.lastOpenedAt = Date.now();
  await saveBook(record);
  const target = Number(String((record.progress && record.progress.sectionId) || '').replace('page:', '')) || 1;
  if (target > 1) requestAnimationFrame(() => jumpToPdfPage(target));
}

let pdfRenderQueue = Promise.resolve();
function visiblePdfPageIndexes() {
  const margin = 800;
  const out = [];
  for (const el of document.querySelectorAll('.pdf-page')) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < -margin || rect.top > window.innerHeight + margin) continue;
    out.push(Number(el.dataset.page));
  }
  return out;
}

function renderVisiblePdfPages() {
  if (!state.pdf) return;
  const margin = 800;
  for (const el of document.querySelectorAll('.pdf-page')) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < -margin || rect.top > window.innerHeight + margin) continue;
    if (el.dataset.rendered === '1') continue;
    // 一页一页排队：pdf.js 的 render task 并发容易互相拖慢
    el.dataset.rendered = '1';
    pdfRenderQueue = pdfRenderQueue
      .then(() => renderPdfPage(el, Number(el.dataset.page)))
      .catch(() => {});
  }
}

function closeReader() {
  if (state.pdf) { try { state.pdf.destroy(); } catch (err) { /* ignore */ } state.pdf = null; }
  if (state.pdfObserver) { state.pdfObserver.disconnect(); state.pdfObserver = null; }
  state.pdfPage = 0;
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
  if (!state.config) await loadConfig();
  // 没有配置也能读原文；只有翻译相关入口不可用
  if (record.format === 'pdf') { await openPdfBook(record); return; }
  if (state.pdf) { try { state.pdf.destroy(); } catch (err) { /* ignore */ } state.pdf = null; }
  if (state.pdfObserver) { state.pdfObserver.disconnect(); state.pdfObserver = null; }
  try {
    const buffer = await record.fileBlob.arrayBuffer();
    const doc = parseEpub(buffer);
    state.book = record;
    state.doc = doc;
    state.mode = record.mode || 'original';
    $('libraryView').hidden = true;
    $('readerView').hidden = false;
    $('modeSelect').disabled = false;
    $('targetSelect').disabled = false;
    $('tocToggle').disabled = false;
    $('translateChapter').disabled = !(state.config && state.config.hasKey);
    translator = translator || new ReaderTranslator({ onStatus: onTranslateStatus });
    await translator.configure(readerConfig());
    translator.setDocument(doc);
    $('modeSelect').value = state.mode;
    const progress = record.progress || {};
    const sec = doc.sections.find((one) => one.id === progress.sectionId) || doc.sections[0];
    $('tocList').textContent = '';
    renderToc(doc.toc, $('tocList'));
    if (!sec) throw new Error('章节为空');
    await loadSection(sec.id, '', progress.offsetRatio || 0);
    record.lastOpenedAt = Date.now();
    await saveBook(record);
  } catch (err) {
    setStatus('libraryStatus', errorText(err), 'error');
    closeReader();
  }
}

async function loadSection(sectionId, fragment, offsetRatio) {
  if (!state.doc) return;
  const sec = state.doc.sections.find((one) => one.id === sectionId);
  if (!sec) return;
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
  $('translateChapter').disabled = !(state.config && state.config.hasKey);
  const mode = state.mode || 'original';
  if (translator) await translator.start(state.book, sec, content, mode);
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
      let current = 1;
      const pages = document.querySelectorAll('.pdf-page');
      for (const el of pages) {
        if (el.getBoundingClientRect().top <= 120) current = Number(el.dataset.page);
        else break;
      }
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
  $('modeSelect').value = mode;
  state.mode = mode;
  state.book.mode = mode;
  try { await saveBook(state.book); } catch (err) { /* ignore */ }
  if (state.pdf) {
    $('bookContent').dataset.pdfMode = mode;
    if (mode === 'original') {
      setStatus('readerStatus', '原文模式。');
      return;
    }
    if (!(state.config && state.config.hasKey)) {
      setStatus('readerStatus', '还没有配置翻译 API，无法显示译文。', 'error');
      return;
    }
    setStatus('readerStatus', '正在翻译当前页…');
    for (const index of visiblePdfPageIndexes()) {
      translatePdfPage(index).catch(() => {});
    }
    return;
  }
  $('translateChapter').disabled = !(state.config && state.config.hasKey);
  translator && translator.stop();
  try { window.__DT && window.__DT.restore && window.__DT.restore(); } catch (err) { /* ignore */ }
  if (mode === 'original') {
    setStatus('readerStatus', '原文模式。');
    return;
  }
  if (!(state.config && state.config.hasKey)) {
    setStatus('readerStatus', '还没有配置翻译 API，无法显示译文。', 'error');
    return;
  }
  await translator.start(state.book, state.section, $('bookContent'), mode);
}

function bindEvents() {
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
    if (!(state.config && state.config.hasKey)) return;
    if (state.pdf) {
      if (state.mode === 'original') await changeMode('bilingual');
      const pages = visiblePdfPageIndexes();
      setStatus('readerStatus', '正在翻译当前 ' + pages.length + ' 页…');
      for (const index of pages) translatePdfPage(index).catch(() => {});
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
    if (state.pdf) renderVisiblePdfPages();
  }, { passive: true });
  window.addEventListener('resize', () => { if (state.pdf) renderVisiblePdfPages(); }, { passive: true });
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
  await renderLibrary();
}

boot().catch((err) => {
  setStatus('libraryStatus', errorText(err), 'error');
});
