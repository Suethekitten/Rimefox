#!/usr/bin/env node
// 阅读器真实 Chrome E2E：加载工作树扩展，导入合成 EPUB，走真实 reader 页面、真实 IndexedDB、
// 真实 content/dom.js collect/inject，再用本地假 API 验证双语翻译与行内格式。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from '../lib/vendor/fflate.browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32'
    ? 'C:\\Program Files\\Google Chrome\\Application\\chrome.exe'
    : 'google-chrome');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-reader-e2e-'));
const PORT = 18800 + Math.floor(Math.random() * 300);
const DEBUG = 19800 + Math.floor(Math.random() * 300);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const hits = { requests: 0, texts: 0, sent: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? ' — ' + detail : ''));
}
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (err) { /* wait */ }
    await sleep(step);
  }
  return null;
}

function makeEpub() {
  const enc = (s) => strToU8(s);
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7ZkAAAAASUVORK5CYII=', 'base64'));
  const files = {};
  files['mimetype'] = [enc('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = enc('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  files['OEBPS/content.opf'] = enc('<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Reader Smoke</dc:title><dc:creator>QA Author</dc:creator><dc:language>en</dc:language><dc:identifier id="id">urn:reader-smoke</dc:identifier></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="pic" href="pic.png" media-type="image/png"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  files['OEBPS/toc.ncx'] = enc('<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>First Chapter</text></navLabel><content src="ch1.xhtml"/><navPoint id="n2"><navLabel><text>Second Chapter</text></navLabel><content src="ch2.xhtml"/></navPoint></navPoint></navMap></ncx>');
  files['OEBPS/ch1.xhtml'] = enc('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><h1 id="top">First Chapter</h1><p id="para">Hello <b>bold</b> and <a href="ch2.xhtml#note">second chapter</a>.</p><p>Note <a epub:type="noteref" href="#note1">[1]</a>.</p><aside id="note1"><p>Footnote text.</p></aside><p><img src="pic.png" alt="dot"/></p><script>alert(1)<\/script><p>Safe tail.</p></body></html>');
  files['OEBPS/ch2.xhtml'] = enc('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="note">Second Chapter</h1><p>Second body text.</p></body></html>');
  files['OEBPS/pic.png'] = png;
  return Buffer.from(zipSync(files));
}

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (req.method === 'POST' && route === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const texts = JSON.parse(body.messages[1].content);
        hits.requests += 1;
        hits.texts += texts.length;
        hits.sent.push(...texts);
        const sys = String((body.messages && body.messages[0] && body.messages[0].content) || '');
        const prefix = /zh-TW|繁體中文/.test(sys) ? '繁:' : '译:';
        const content = JSON.stringify(texts.map((t) => {
          const s = String(t);
          return prefix + s + prefix + '汉汉汉。';
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = path.join(WORK, 'profile');
const browser = spawn(BROWSER, [
  '--headless=new', '--no-sandbox', '--enable-unsafe-extension-debugging', '--remote-debugging-port=' + DEBUG,
  '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
let version = null;
for (let i = 0; i < 100; i += 1) {
  try { version = await (await fetch('http://127.0.0.1:' + DEBUG + '/json/version')).json(); break; } catch (err) { await sleep(150); }
}
if (!version) throw new Error('Chrome did not start');
console.log(version.Browser + ' · reader · ' + ORIGIN);
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    return;
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => {});
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const where = d.url || (d.stackTrace && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || '';
    if (!where || where.startsWith('chrome-extension://')) exceptions.push(((d.exception && d.exception.description) || d.text) + ' @ ' + where);
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evalIn(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  return sessionId;
}

const { id: extId } = await send('Extensions.loadUnpacked', { path: ROOT });
const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/reader/index.html' });
console.log('reader target', targetId);
const page = await attach(targetId);
const pageEval = (code) => evalIn(page, '(() => {' + code + '})()');
await until(() => pageEval("return !!document.getElementById('bookGrid')"), 15000);
const cfg = {
  _v: 6,
  currentProvider: '__custom__',
  customProviders: [{ id: '__custom__', name: 'Fake' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-test', model: 'fake' } },
  targetLang: 'zh-CN', mode: 'dual', lazy: false, thinkingMode: 'off', hoverCompare: false
};
await pageEval('return chrome.storage.local.set({ config: ' + JSON.stringify(cfg) + ' }).then(() => true)');
await send('Page.reload', {}, page);
await sleep(1200);
await until(() => pageEval("return !!document.getElementById('bookGrid')"), 15000);
check('阅读器页面加载', await pageEval("return document.title.indexOf('凛狐') >= 0;"), await pageEval('return document.title'));

const epubPath = path.join(WORK, 'reader-smoke.epub');
fs.writeFileSync(epubPath, makeEpub());
const doc = await send('DOM.getDocument', { depth: -1, pierce: true }, page);
const inputNode = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [epubPath] }, page);
await pageEval("document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(1000);
const imported = await until(() => pageEval("return document.querySelectorAll('.book-card').length > 0"), 15000);
check('导入 EPUB 后出现书卡', !!imported, imported ? 'yes' : 'no');
if (!imported) {
  server.close(); browser.kill('SIGKILL'); process.exit(1);
}
check('书卡标题和作者', await pageEval("const c=document.querySelector('.book-card'); return !!c && c.textContent.includes('Reader Smoke') && c.textContent.includes('QA Author');"));
await pageEval("document.querySelector('.book-card .reader-button').click(); return true;");
await until(() => pageEval("return !document.getElementById('readerView').hidden"), 15000);
const targetValues = await pageEval("return Array.from(document.getElementById('targetSelect').options).map((o) => o.value)");
check('目标语言下拉可用', targetValues.length > 1, targetValues.slice(0, 6).join(','));
await pageEval("const s=document.getElementById('targetSelect'); s.value='zh-TW'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(800);
check('切换目标语言后原文重置', await pageEval("return document.getElementById('modeSelect').value === 'original' && document.querySelectorAll('#bookContent [data-dt-target]').length === 0;"));
const globalTarget = await pageEval("return chrome.storage.local.get('config').then((r) => (r.config || {}).targetLang)");
check('阅读器目标语言不影响网页翻译全局设置', globalTarget === 'zh-CN', String(globalTarget));
await pageEval("const s=document.getElementById('modeSelect'); s.value='bilingual'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
const twTranslated = await until(() => pageEval("const t=document.querySelector('#bookContent [data-dt-target]'); return !!t && t.textContent.indexOf('繁:') >= 0;"), 15000);
check('新目标语言按 zh-TW 重译', !!twTranslated);
await sleep(800);
await pageEval("const s=document.getElementById('targetSelect'); s.value='zh-CN'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(800);
check('切回 zh-CN 后原文重置', await pageEval("return document.getElementById('modeSelect').value === 'original' && document.querySelectorAll('#bookContent [data-dt-target]').length === 0;"));
await pageEval("const s=document.getElementById('modeSelect'); s.value='bilingual'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await pageEval("document.querySelector('#tocList a').click(); return true;");

// 阅读器有 400 ms 停留防抖：等这一章的译文落地后再记请求数。
await until(() => pageEval("return !!document.querySelector('#bookContent [data-dt-target]')"), 15000);
await sleep(800);
check('目录跳转', await pageEval("return document.getElementById('bookContent').textContent.includes('First Chapter');"));

const firstRequests = hits.requests;
await pageEval("document.getElementById('backToLibrary').click(); return true;");
await until(() => pageEval("return !document.getElementById('libraryView').hidden"), 10000);
await pageEval("document.querySelector('.book-card .reader-button').click(); return true;");
await until(() => pageEval("return !document.getElementById('readerView').hidden"), 10000);
await until(() => pageEval("return !!document.querySelector('#bookContent [data-dt-target]')"), 15000);
await sleep(500);
check('重新打开记住双语模式', await pageEval("return document.getElementById('modeSelect').value === 'bilingual';"));
check('重新打开命中 reader 缓存，不新增请求', hits.requests === firstRequests, JSON.stringify({ before: firstRequests, after: hits.requests }));
check('章末预取下一章开头', hits.sent.some((text) => String(text).includes('Second Chapter')), hits.sent.slice(-3).join(' | '));
const afterPrefetch = hits.requests;
await pageEval("document.querySelectorAll('#tocList a')[1].click(); return true;");
await until(() => pageEval("return document.getElementById('bookContent').textContent.includes('Second Chapter');"), 5000);
await sleep(1000);
check('切到下一章命中预取，不重复请求', hits.requests === afterPrefetch, JSON.stringify({ prefetched: afterPrefetch, current: hits.requests }));
await pageEval("const s=document.getElementById('modeSelect'); s.value='original'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(300);
check('切回原文移除译文', await pageEval("return !document.querySelector('#bookContent [data-dt-target]') && document.getElementById('bookContent').textContent.includes('Second Chapter');"));
await pageEval("document.getElementById('translateChapter').click(); return true;");
await until(() => pageEval("return document.getElementById('modeSelect').value === 'bilingual'"), 5000);
await until(() => pageEval("return !!document.querySelector('#bookContent [data-dt-target]')"), 10000);
check('原文状态点「翻译本章」切回双语并注入', await pageEval("return document.getElementById('modeSelect').value === 'bilingual' && !!document.querySelector('#bookContent [data-dt-target]');"));

await pageEval("const b=document.querySelector('.book-actions button:last-child'); b && b.click(); return true;");
await until(() => pageEval("return document.querySelectorAll('.book-card').length === 0"), 10000);
check('删除书：书卡消失、回到书库', await pageEval("return document.querySelectorAll('.book-card').length === 0 && !document.getElementById('libraryView').hidden;"));
const dbLeft = await pageEval("return new Promise((resolve) => { const req = indexedDB.open('rimefox-reader'); req.onsuccess = () => { const db = req.result; const tx = db.transaction(['books', 'translations', 'failures', 'progress', 'files'], 'readonly'); Promise.all(['books', 'translations', 'failures', 'progress', 'files'].map((name) => new Promise((done) => { const q = tx.objectStore(name).count(); q.onsuccess = () => done(q.result); q.onerror = () => done(-1); }))).then((counts) => resolve({ books: counts[0], translations: counts[1], failures: counts[2], progress: counts[3], files: counts[4] })); }; req.onerror = () => resolve({ error: 'open' }); })");
check('删除书清理原书 / 译文 / 进度 / 失败记录 / 文件', dbLeft && dbLeft.books === 0 && dbLeft.translations === 0 && dbLeft.failures === 0 && dbLeft.progress === 0 && dbLeft.files === 0, JSON.stringify(dbLeft));

// 0.16.0 把整本书从 books.fileBlob 搬到 files。用真实 v3 库验证一次升级迁移。
const legacyB64 = makeEpub().toString('base64');
await send('Page.navigate', { url: 'chrome-extension://' + extId + '/welcome/index.html' }, page);
await sleep(800);
const seeded = await pageEval(`
return new Promise((resolve) => {
  const openV3 = () => {
    const req = indexedDB.open('rimefox-reader', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      const tr = db.createObjectStore('translations', { keyPath: 'key' });
      tr.createIndex('bookId', 'bookId', { unique: false });
      const fa = db.createObjectStore('failures', { keyPath: 'key' });
      fa.createIndex('bookId', 'bookId', { unique: false });
      db.createObjectStore('progress', { keyPath: 'bookId' });
      db.createObjectStore('fonts', { keyPath: 'id' });
      db.createObjectStore('settings', { keyPath: 'id' });
    };
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const db = req.result;
      const raw = atob('${legacyB64}');
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/epub+zip' });
      const tx = db.transaction(['books', 'progress'], 'readwrite');
      tx.objectStore('books').put({ id: 'legacy-book', hash: 'legacy-book', format: 'epub', title: 'Legacy Book', authors: ['Old'], language: 'en', metadata: {}, coverBlob: null, fileBlob: blob, toc: [], createdAt: 1, lastOpenedAt: 1, mode: 'original' });
      tx.objectStore('progress').put({ bookId: 'legacy-book', sectionId: '', offsetRatio: 0, updatedAt: 1 });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    };
  };
  const del = indexedDB.deleteDatabase('rimefox-reader');
  del.onsuccess = openV3;
  del.onerror = openV3;
  del.onblocked = () => resolve(false);
})`);
check('旧版 v3 书库已写入', seeded === true, String(seeded));
await send('Page.navigate', { url: 'chrome-extension://' + extId + '/reader/index.html' }, page);
await until(() => pageEval("return !!document.getElementById('bookGrid')"), 15000);
const legacyCard = await until(() => pageEval("return Array.from(document.querySelectorAll('.book-card')).some((c) => c.textContent.includes('Legacy Book'))"), 15000);
check('v3 → v4 升级后旧书仍在书库', !!legacyCard);
const migrated = await pageEval(`
return new Promise((resolve) => {
  const req = indexedDB.open('rimefox-reader');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(['books', 'files'], 'readonly');
    const book = tx.objectStore('books').get('legacy-book');
    const file = tx.objectStore('files').get('legacy-book');
    tx.oncomplete = () => resolve({
      book: !!book.result,
      blobInMeta: !!(book.result && book.result.fileBlob),
      file: !!(file.result && file.result.blob && file.result.blob.size > 0)
    });
    tx.onerror = () => resolve({ error: true });
  };
  req.onerror = () => resolve({ error: true });
})`);
check('迁移把原书搬到 files，books 不再带 fileBlob', migrated && migrated.book && migrated.file && !migrated.blobInMeta, JSON.stringify(migrated));
await pageEval("const c = Array.from(document.querySelectorAll('.book-card')).find((x) => x.textContent.includes('Legacy Book')); c.querySelector('.reader-button').click(); return true;");
const legacyOpened = await until(() => pageEval("return !document.getElementById('readerView').hidden && document.getElementById('bookContent').textContent.includes('First Chapter')"), 15000);
check('升级后的旧书能正常打开和阅读', !!legacyOpened);
await pageEval("document.getElementById('backToLibrary').click(); return true;");
await until(() => pageEval("return !document.getElementById('libraryView').hidden"), 10000);
await pageEval("const c = Array.from(document.querySelectorAll('.book-card')).find((x) => x.textContent.includes('Legacy Book')); c.querySelector('.book-actions button:last-child').click(); return true;");
await until(() => pageEval("return document.querySelectorAll('.book-card').length === 0"), 10000);
const legacyLeft = await pageEval("return new Promise((resolve) => { const req = indexedDB.open('rimefox-reader'); req.onsuccess = () => { const db = req.result; const tx = db.transaction(['books', 'progress', 'files'], 'readonly'); Promise.all(['books', 'progress', 'files'].map((name) => new Promise((done) => { const q = tx.objectStore(name).count(); q.onsuccess = () => done(q.result); q.onerror = () => done(-1); }))).then((counts) => resolve({ books: counts[0], progress: counts[1], files: counts[2] })); }; req.onerror = () => resolve({ error: 'open' }); })");
check('删除旧书清理 books / progress / files', legacyLeft && legacyLeft.books === 0 && legacyLeft.progress === 0 && legacyLeft.files === 0, JSON.stringify(legacyLeft));

// 重导入已有书：即使书库估算已接近 500MB，也应该直接打开已有书，而不是被容量检查误拦。
const doc2 = await send('DOM.getDocument', { depth: -1, pierce: true }, page);
const input2 = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: input2.nodeId, files: [epubPath] }, page);
await pageEval("document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
await until(() => pageEval("return !document.getElementById('readerView').hidden"), 15000);
await pageEval("document.getElementById('backToLibrary').click(); return true;");
await until(() => pageEval("return !document.getElementById('libraryView').hidden"), 10000);
await pageEval("navigator.storage.estimate = async () => ({ usage: 490 * 1024 * 1024, quota: 10 * 1024 * 1024 * 1024 }); return true;");
const doc3 = await send('DOM.getDocument', { depth: -1, pierce: true }, page);
const input3 = await send('DOM.querySelector', { nodeId: doc3.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: input3.nodeId, files: [epubPath] }, page);
await pageEval("document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
await until(() => pageEval("return !document.getElementById('readerView').hidden"), 15000);
const dupStatus = await pageEval("return document.getElementById('libraryStatus').textContent");
const dupCards = await pageEval("return document.querySelectorAll('.book-card').length");
check('书库接近上限时重复导入已有书不被误拦', /已导入/.test(dupStatus) && dupCards === 1, dupStatus);
check('阅读器无未捕获异常', exceptions.length === 0, exceptions.join(' | '));
console.log('\n[阅读器 E2E]');
console.log(hits.requests + ' 请求 / ' + hits.texts + ' 条；异常 ' + exceptions.length);
server.close();
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
const failed = results.filter((r) => !r.ok);
console.log((results.length - failed.length) + ' / ' + results.length + ' 通过');
fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify({ results, hits, exceptions }, null, 2));
console.log('结果：' + path.join(WORK, 'result.json'));
process.exit(failed.length || exceptions.length ? 1 : 0);
