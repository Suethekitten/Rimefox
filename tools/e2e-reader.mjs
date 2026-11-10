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
import { spoofedEpubZip } from '../test/fixtures/qa-archives.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = process.env.RIMEFOX_EXTENSION || ROOT;
const BROWSER = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
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
  files['OEBPS/content.opf'] = enc('<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Reader Smoke</dc:title><dc:creator>QA Author</dc:creator><dc:language>en</dc:language><dc:identifier id="id">urn:reader-smoke</dc:identifier></metadata><manifest><item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="pic" href="Images/pic.png" media-type="image/png"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  files['OEBPS/toc.ncx'] = enc('<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>First Chapter</text></navLabel><content src="Text/ch1.xhtml"/><navPoint id="n2"><navLabel><text>Second Chapter</text></navLabel><content src="Text/ch2.xhtml"/></navPoint></navPoint></navMap></ncx>');
  // Sigil 常见结构：章节在 Text/、图片在 Images/，书内链接以 ../ 开头（QA E1）
  files['OEBPS/Text/ch1.xhtml'] = enc('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><h1 id="top">First Chapter</h1><p id="para">Hello <b>bold</b> and <a href="../Text/ch2.xhtml#note">second chapter</a>.</p><p>Note <a epub:type="noteref" href="#note1">[1]</a>.</p><aside id="note1"><p>Footnote text.</p></aside><p><img src="../Images/pic.png" alt="dot"/></p><script>alert(1)<\/script><p>Safe tail.</p></body></html>');
  files['OEBPS/Text/ch2.xhtml'] = enc('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="note">Second Chapter</h1><p>Second body text.</p></body></html>');
  files['OEBPS/Images/pic.png'] = png;
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
        const traditional = /唯一目标语言：[^\n]*\(zh-TW\)/.test(sys);
        const prefix = traditional ? '繁:' : '译:';
        const content = JSON.stringify(texts.map((t) => {
          const s = String(t);
          return s.split('\n').map(line => prefix + line + prefix +
            (traditional ? '文檔閱讀翻譯測試內容。' : '文档阅读翻译测试内容。').repeat(Math.max(1, Math.ceil(line.length / 12)))).join('\n');
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
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
// 只删 Chrome 用户目录（每次约 50 MB），WORK 里的 result.json 留作结果。正常结束先等 Chrome 退出再删；中途退出时 exit 里同步兜底。
let profileRemoved = false;
function removeProfile() {
  if (profileRemoved) return;
  profileRemoved = true;
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (err) { console.log('NOTE temporary profile not fully removed (' + err.code + '): ' + profile); }
}
process.on('exit', () => { try { browser.kill('SIGKILL'); } catch (err) { /* cleanup */ } removeProfile(); });
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

const { id: extId } = await send('Extensions.loadUnpacked', { path: EXTENSION });
const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/reader/index.html' });
console.log('reader target', targetId);
const page = await attach(targetId);
const pageEval = (code) => evalIn(page, '(() => {' + code + '})()');
// #bookGrid is static HTML. boot() binds the import controls only after settings, font,
// config and translator load, then renderLibrary() fills the grid; wait for that on a new document.
async function readerBooted(previousDocument = null) {
  const ready = await until(() => pageEval('return performance.timeOrigin !== ' + JSON.stringify(previousDocument) + ' && !!document.querySelector("#bookGrid .empty-library, #bookGrid .book-card")'), 20000);
  if (!ready) throw new Error('Reader did not finish booting');
  return pageEval('return performance.timeOrigin');
}
let readerDocument = await readerBooted();
const cfg = {
  _v: 6,
  currentProvider: '__custom__',
  customProviders: [{ id: '__custom__', name: 'Fake' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-test', model: 'fake' } },
  targetLang: 'zh-CN', mode: 'dual', lazy: false, thinkingMode: 'off', hoverCompare: false
};
await pageEval('return chrome.storage.local.set({ config: ' + JSON.stringify(cfg) + ' }).then(() => true)');
await send('Page.reload', {}, page);
readerDocument = await readerBooted(readerDocument);
check('阅读器页面加载', await pageEval("return document.title.indexOf('凛狐') >= 0;"), await pageEval('return document.title'));

const bomb = path.join(WORK, 'qa-size-spoof.epub');
fs.writeFileSync(bomb, spoofedEpubZip());
const bombDoc = await send('DOM.getDocument', { depth: -1, pierce: true }, page);
const bombInput = await send('DOM.querySelector', { nodeId: bombDoc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: bombInput.nodeId, files: [bomb] }, page);
await pageEval('window.__heartbeat=0;window.__pulse=setInterval(()=>window.__heartbeat++,5);document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
const rejected = await until(() => pageEval('return document.getElementById("cancelImport").hidden && /大|安全|EPUB/.test(document.getElementById("libraryStatus").textContent)'), 5000);
const bombState = await pageEval('clearInterval(window.__pulse);return {heartbeat:window.__heartbeat,cards:document.querySelectorAll(".book-card").length,status:document.getElementById("libraryStatus").textContent};');
check('QA E2：尺寸伪造 EPUB 被拒绝且主线程仍响应、不写入书库', !!rejected && bombState.heartbeat>0 && bombState.cards===0, JSON.stringify(bombState));
const workerChecks = await pageEval('return import("/lib/reader/epub-loader.js").then(async({loadEpub})=>{const bytes=new Uint8Array(' + JSON.stringify(Array.from(zipSync({ a: strToU8('hello') }))) + ');const c=new AbortController();const p=loadEpub(bytes.slice().buffer,{signal:c.signal}).catch(e=>e.name);c.abort();const cancelled=await p;const timed=await loadEpub(bytes.slice().buffer,{timeout:0}).catch(e=>e.code);return {cancelled,timed};})');
check('EPUB Worker 可立即取消且超时后被终止', workerChecks.cancelled === 'AbortError' && workerChecks.timed === 'timeout', JSON.stringify(workerChecks));
await send('DOM.setFileInputFiles', { nodeId: bombInput.nodeId, files: [bomb] }, page);
await pageEval('document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));document.getElementById("cancelImport").click();return true;');
check('取消导入按钮阻止保存异常书籍', !!await until(() => pageEval('return document.getElementById("libraryStatus").textContent.includes("已取消") && !document.querySelector(".book-card")'), 5000));

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
check('Text/ + Images/ 结构的 ../ 图片与跨章链接能渲染', await pageEval("const img=document.querySelector('#bookContent img'); return !!img && img.src.startsWith('blob:') && document.getElementById('bookContent').textContent.includes('second chapter');"));

const firstRequests = hits.requests;
await pageEval("document.getElementById('backToLibrary').click(); return true;");
// renderLibrary 先清空书卡、读完书库再重画：书库可见不等于书卡已经回来，要等到要点的那张书卡出现
await until(() => pageEval("return !document.getElementById('libraryView').hidden && !!document.querySelector('.book-card .reader-button')"), 10000);
await pageEval("document.querySelector('.book-card .reader-button').click(); return true;");
await until(() => pageEval("return !document.getElementById('readerView').hidden"), 10000);
await until(() => pageEval("return !!document.querySelector('#bookContent [data-dt-target]')"), 15000);
await sleep(500);
check('重新打开记住双语模式', await pageEval("return document.getElementById('modeSelect').value === 'bilingual';"));
check('重新打开命中 reader 缓存，不新增请求', hits.requests === firstRequests, JSON.stringify({ before: firstRequests, after: hits.requests }));
await documentMode('parallel');
check('EPUB 双列保留左侧原文、图片和书内链接', !!await until(() => pageEval("const s=document.getElementById('sourceContent');return !s.hidden && !!s.querySelector('img[src^=\"blob:\"]') && !!s.querySelector('a[data-reader-target]') && !s.textContent.includes('译:') && document.getElementById('bookContent').textContent.includes('译:')")));
check('EPUB 双列复用已有译文缓存', hits.requests === firstRequests);
await documentMode('bilingual');
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
readerDocument = await readerBooted(readerDocument);
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
await until(() => pageEval("return !document.getElementById('libraryView').hidden && Array.from(document.querySelectorAll('.book-card')).some((x) => x.textContent.includes('Legacy Book'))"), 10000);
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
// 书卡由 renderLibrary 异步重画，等它稳定在 1 张；真的重复导入会一直是 2 张，仍然失败
const dupCards = await until(() => pageEval("return document.querySelectorAll('.book-card').length === 1"), 5000);
check('书库接近上限时重复导入已有书不被误拦', /已导入/.test(dupStatus) && !!dupCards, dupStatus);

// Documents and split view: use the same extension, API and persistent reader store.
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);
async function importDocument(name, text) {
  await pageEval("document.getElementById('backToLibrary').click(); return true;");
  await until(() => pageEval("return !document.getElementById('libraryView').hidden"));
  const file = path.join(WORK, name); fs.writeFileSync(file, text);
  const document = await send('DOM.getDocument', { depth: 0 }, page);
  const node = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#fileInput' }, page);
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] }, page);
  await pageEval("document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
  return until(() => pageEval("return !document.getElementById('readerView').hidden && !!document.getElementById('bookContent').textContent.trim()"));
}
async function documentMode(mode) {
  await pageEval("const m=document.getElementById('modeSelect');m.value=" + JSON.stringify(mode) + ";m.dispatchEvent(new Event('change',{bubbles:true}));return true;");
  await sleep(1000);
}
check('TXT 导入并按段落 / 换行阅读', !!await importDocument('Plain Document.txt', 'The original first paragraph.\nA second line.\n\nAnother paragraph for local document translation.'));
const txtSource = await pageEval("return document.getElementById('bookContent').textContent");
check('TXT 保留段落和换行', await pageEval("return document.querySelectorAll('#bookContent p').length===2 && !!document.querySelector('#bookContent br')"));
await pageEval("const s=document.getElementById('targetSelect');s.value='zh-CN';s.dispatchEvent(new Event('change',{bubbles:true}));return true;");
await until(() => pageEval("return !document.getElementById('targetSelect').disabled"));
await documentMode('parallel');
check('TXT 双列：左边原文，右边译文', !!await until(() => pageEval("return document.getElementById('sourceContent').textContent === " + JSON.stringify(txtSource) + " && document.getElementById('bookContent').textContent.includes('译:')")));
check('双列真正并排且左侧没有被翻译', await pageEval("const a=document.getElementById('sourceContent'),b=document.getElementById('bookContent');return a.getBoundingClientRect().right<=b.getBoundingClientRect().left+1 && !a.querySelector('[data-dt-target]') && !a.textContent.includes('译:')"));
await sleep(700);
const beforeColumns = hits.requests;
await documentMode('bilingual');
await documentMode('parallel');
check('TXT 双语 / 双列切换复用缓存，不重复请求', hits.requests === beforeColumns, beforeColumns + ' → ' + hits.requests);
await pageEval("document.getElementById('backToLibrary').click();return true;");
await until(() => pageEval("return !document.getElementById('libraryView').hidden && Array.from(document.querySelectorAll('.book-card')).some(c=>c.textContent.includes('Plain Document'))"));
await pageEval("const c=Array.from(document.querySelectorAll('.book-card')).find(c=>c.textContent.includes('Plain Document'));c.querySelector('button').click();return true;");
await until(() => pageEval("return !document.getElementById('readerView').hidden && document.getElementById('bookContent').textContent.includes('译:')"));
await sleep(700);
check('TXT 重开恢复双列并命中缓存', hits.requests === beforeColumns && await pageEval("return document.getElementById('modeSelect').value==='parallel' && !document.getElementById('sourceContent').hidden"));
await pageEval("const s=document.getElementById('targetSelect');s.value='zh-TW';s.dispatchEvent(new Event('change',{bubbles:true}));return true;");
check('双列切换语言保留版式，译文按新语言更新', !!await until(() => pageEval("return document.getElementById('modeSelect').value==='parallel' && document.getElementById('bookContent').textContent.includes('繁:') && !document.getElementById('bookContent').textContent.includes('译:')")));
await documentMode('original');
check('TXT 切回原文恢复内容并收起左列', await pageEval("return document.getElementById('sourceContent').hidden && document.getElementById('bookContent').textContent===" + JSON.stringify(txtSource)));

check('中文小说 TXT 导入', !!await importDocument('章节小说.txt', '书名：章节小说\n\n第一章 初见\n　　他说：“第一章就讲过了。”\n第二章 重逢\n　　第二章的正文。\n番外1 后日谈\n　　番外的正文。'));
check('TXT 按章节标题生成目录', !!await until(() => pageEval("return [...document.querySelectorAll('#tocList a')].map(a=>a.textContent.trim()).join('|')==='章节小说|第一章 初见|第二章 重逢|番外1 后日谈'")),
  await pageEval("return [...document.querySelectorAll('#tocList a')].map(a=>a.textContent.trim()).join('|')"));
await pageEval("document.querySelectorAll('#tocList a')[2].click(); return true;");
check('TXT 目录跳到对应章节', !!await until(() => pageEval("const h=document.querySelector('#bookContent h2');return !!h && h.textContent==='第二章 重逢' && document.getElementById('bookContent').textContent.includes('第二章的正文') && !document.getElementById('bookContent').textContent.includes('番外的正文')")),
  await pageEval("return document.getElementById('bookContent').textContent.slice(0,80)"));

check('Markdown 导入', !!await importDocument('formatted.md', '# Markdown Document\n\nA **bold** paragraph with `keep_code` and [safe link](https://example.com).\n\n- First list item\n- Second list item\n\n> A quoted paragraph.\n\n```js\nconst keep_code = "unchanged";\n```\n\n| Name | Value |\n| --- | --- |\n| Item | Example |\n\n<script>window.__markdownExecuted=true</script>\n\n![blocked](https://example.com/remote.png)\n\n[Next section](#next-section)\n\n## Next Section\n\nAnother chapter body.'));
check('Markdown 标题、列表、引用、代码块保留', await pageEval("return !!document.querySelector('#bookContent h1') && !!document.querySelector('#bookContent strong') && document.querySelectorAll('#bookContent li').length===2 && !!document.querySelector('#bookContent blockquote') && !!document.querySelector('#bookContent pre code')"));
check('Markdown HTML 不执行、不加载远程图片', await pageEval("return !window.__markdownExecuted && !document.querySelector('#bookContent script, #bookContent img') && document.getElementById('bookContent').textContent.includes('<script>')"));
check('Markdown 表格保留行列结构', await pageEval("return document.querySelectorAll('#bookContent th').length===2 && document.querySelectorAll('#bookContent td').length===2"));
await documentMode('parallel');
check('Markdown 双列翻译，代码不变', !!await until(() => pageEval("return document.getElementById('bookContent').textContent.includes('繁:') && document.querySelector('#bookContent pre code').textContent.includes('const keep_code') && document.querySelector('#bookContent p code')?.textContent==='keep_code' && !document.getElementById('sourceContent').textContent.includes('繁:')")));
await send('Page.bringToFront', {}, page);
const docShot = await send('Page.captureScreenshot', { format: 'png' }, page);
fs.writeFileSync(path.join(WORK, 'markdown-parallel.png'), Buffer.from(docShot.data, 'base64'));
await pageEval("document.querySelector('#sourceContent a[data-reader-fragment=\"next-section\"]').click();return true;");
check('左列 Markdown 内链可跨章节导航', !!await until(() => pageEval("return document.getElementById('sourceContent').textContent.includes('Another chapter body') && !document.getElementById('sourceContent').textContent.includes('const keep_code')")));

// User-configurable library limit is distinct from the browser's much larger quota.
await pageEval('document.getElementById("backToLibrary").click();document.getElementById("settingsToggle").click();return true;');
check('书库默认上限为 1 GB', await pageEval('return document.getElementById("maxLibraryGb").value === "1"'));
await pageEval('navigator.storage.estimate=async()=>({usage:1.5*1073741824,quota:10*1073741824});document.getElementById("settingsDialog").close();return true;');
const beforeQuotaCards = await pageEval('return document.querySelectorAll(".book-card").length');
const quotaFile = path.join(WORK, 'quota-test.txt'); fs.writeFileSync(quotaFile, 'A document used to verify the configured library import limit.');
const quotaDoc = await send('DOM.getDocument', { depth: 0 }, page);
const quotaInput = await send('DOM.querySelector', { nodeId: quotaDoc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: quotaInput.nodeId, files: [quotaFile] }, page);
await pageEval('document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
check('浏览器仍有 10 GB 配额时也遵守用户的 1 GB 书库上限', !!await until(() => pageEval('return document.getElementById("libraryStatus").textContent.includes("书库容量上限 1.0 GB") && document.querySelectorAll(".book-card").length===' + beforeQuotaCards)));
await pageEval('document.getElementById("settingsToggle").click();const n=document.getElementById("maxLibraryGb");n.value="2";n.dispatchEvent(new Event("change",{bubbles:true}));document.getElementById("settingsDialog").close();return true;');
check('可自行调高书库容量，界面显示所设上限', !!await until(() => pageEval('return document.getElementById("libraryUsage").textContent.includes("书库上限 2.0 GB")')));
check('调高到 2 GB 后可继续导入', !!await importDocument('quota-test.txt', 'A document used to verify the configured library import limit.'));
await send('Page.reload', {}, page); await readerBooted();
check('重开后保留用户容量设置，不误显示浏览器的 10 GB 配额', await pageEval('return document.getElementById("maxLibraryGb").value==="2" && document.getElementById("libraryUsage").textContent.includes("2.0 GB") && !document.getElementById("libraryUsage").textContent.includes("10 GB")'));

// 界面语言跟随扩展 uiLang：打开着的阅读器就地切换；书的正文 / 目录里恰好是界面词的文字不能被改写。
const setUiLang = (lang) => pageEval("return chrome.storage.local.get('config').then((r) => chrome.storage.local.set({ config: Object.assign({}, r.config, { uiLang: " + JSON.stringify(lang) + " }) })).then(() => true)");
await setUiLang('en');
check('切到英文后书库界面跟着变', !!await until(() => pageEval("return document.documentElement.lang==='en' && document.getElementById('backToLibrary').textContent.trim()==='← Library' && document.querySelector('.library-section h2').textContent==='My books' && document.getElementById('tocToggle').textContent==='Contents' && document.getElementById('settingsToggle').title==='Reading settings'")),
  await pageEval("return document.getElementById('backToLibrary').textContent + ' | ' + document.querySelector('.library-section h2').textContent"));
check('英文界面下书卡按钮与进度是英文，书名保持原样', await pageEval("const c=[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-title').textContent==='章节小说');return !!c && c.querySelector('.book-actions button').textContent==='Open' && /^(Not started|Last read)/.test(c.querySelector('.book-progress').textContent)"));
check('英文界面导入书', !!await importDocument('界面词.txt', '目录\n\n打开\n\n第一章 搜索\n正文写着停止和完成。\n第二章 移除\n继续。'));
check('书的正文和目录里的界面词不被界面翻译改写', !!await until(() => pageEval("const toc=[...document.querySelectorAll('#tocList a')].map(a=>a.textContent.trim());return document.getElementById('bookContent').textContent.includes('目录打开') && toc.join('|')==='界面词|第一章 搜索|第二章 移除' && document.getElementById('readerTitle').textContent==='界面词' && document.getElementById('translateChapter').textContent==='Translate chapter'")),
  await pageEval("return [...document.querySelectorAll('#tocList a')].map(a=>a.textContent.trim()).join('|') + ' / ' + document.getElementById('bookContent').textContent.slice(0, 40)"));
await setUiLang('zh');
check('切回中文后界面恢复，书的内容不变', !!await until(() => pageEval("return document.documentElement.lang==='zh-CN' && document.getElementById('backToLibrary').textContent.trim()==='← 书库' && document.getElementById('translateChapter').textContent==='翻译本章' && document.getElementById('bookContent').textContent.includes('目录打开')")));

check('阅读器无未捕获异常', exceptions.length === 0, exceptions.join(' | '));
console.log('\n[阅读器 E2E]');
console.log(hits.requests + ' 请求 / ' + hits.texts + ' 条；异常 ' + exceptions.length);
server.close();
const browserExited = browser.exitCode !== null || browser.signalCode !== null ? Promise.resolve() : new Promise((resolve) => browser.once('exit', resolve));
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
await Promise.race([browserExited, sleep(5000)]);
removeProfile();
const failed = results.filter((r) => !r.ok);
console.log((results.length - failed.length) + ' / ' + results.length + ' 通过');
fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify({ results, hits, exceptions }, null, 2));
console.log('结果：' + path.join(WORK, 'result.json'));
process.exit(failed.length || exceptions.length ? 1 : 0);
