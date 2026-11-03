#!/usr/bin/env node
// PDF 阅读页 E2E：真实扩展 + 真实 reader 页 + 本地 PDF。
// 默认使用仓库合成 PDF，验证渲染、译文、缓存身份与旧响应；不调用真实付费 API。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const PDF = process.argv[2] || path.join(ROOT, 'reader', 'pdf-samples', 'reader.pdf');
const PORT = 20600 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-pdf-reader-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}
async function until(fn, ms = 30000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (err) { /* wait */ }
    await sleep(step);
  }
  return null;
}

const HEADED = process.env.RIMEFOX_HEADED === '1';

// 本地假翻译 API（OpenAI 兼容），验证 PDF 译文链路
const API_PORT = 18700 + Math.floor(Math.random() * 300);
const API_ORIGIN = 'http://127.0.0.1:' + API_PORT;
const hits = { requests: 0, targets: [], sent: [] };
let holdRequests = false;
const held = [];
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && /\/v1\/chat\/completions$/.test(req.url.split('?')[0])) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const texts = JSON.parse(body.messages[1].content);
        hits.requests += 1;
        const french = /Français|\(fr\)/.test(String(body.messages[0].content));
        hits.targets.push(french ? 'fr' : 'zh-CN');
        hits.sent.push(...texts.map((text) => JSON.stringify([french ? 'fr' : 'zh-CN', body.model, body.messages[0].content, text])));
        const number = hits.requests;
        const content = JSON.stringify(texts.map((text, i) => french
          ? 'Traduction française de contrôle ' + number + '-' + i + '. ' + 'Ce texte vérifie la lecture et la mémoire. '.repeat(Math.ceil(String(text).length / 48))
          : '译:这是阅读器回归测试的中文译文，第' + number + '次请求第' + i + '段。' + '用于验证缓存身份的中文译文。'.repeat(Math.ceil(String(text).length / 24))));
        const reply = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
        };
        if (holdRequests) held.push(reply);
        else reply();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err.message || err) } }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', resolve));

const browser = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  '--no-sandbox', '--enable-unsafe-extension-debugging',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
process.on('exit', () => { try { browser.kill('SIGKILL'); } catch (err) { /* cleanup */ } });
process.on('SIGTERM', () => process.exit(143));

let version = null;
for (let i = 0; i < 100; i += 1) {
  try { version = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); break; } catch (err) { await sleep(150); }
}
if (!version) throw new Error('Chrome did not start');
console.log(version.Browser);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails;
    exceptions.push((d.exception && d.exception.description) || d.text);
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (out.exceptionDetails) throw new Error((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text);
  return out.result.value;
}
const pageEval = (session, code) => evaluate(session, '(() => {' + code + '})()');
async function setInputFile(session, file, dispatch) {
  const doc = await send('DOM.getDocument', { depth: 0, pierce: true }, session);
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' }, session);
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] }, session);
  if (dispatch) {
    await pageEval(session, "document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
  }
}

const { id: extId } = await send('Extensions.loadUnpacked', { path: ROOT });
console.log('Loaded extension ' + extId + ' from ' + ROOT);
const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/reader/index.html' });
const page = await attach(targetId);
check('阅读器页面加载', !!(await until(() => pageEval(page, "return !!document.getElementById('bookGrid')"), 15000)));
check('阅读器启动完成', !!(await until(() => pageEval(page, "return !!document.querySelector('.empty-library, .book-card')"), 20000)));
// 配置假翻译 API（阅读器翻译目标独立，用 zh-CN）
const cfg = {
  _v: 6,
  currentProvider: '__custom__',
  customProviders: [{ id: '__custom__', name: 'Fake' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: API_ORIGIN + '/v1', apiKey: 'sk-test', model: 'fake' } },
  targetLang: 'zh-CN', mode: 'dual', lazy: false, thinkingMode: 'off', hoverCompare: false
};
await pageEval(page, 'return chrome.storage.local.set({ config: ' + JSON.stringify(cfg) + ' }).then(() => true)');
await send('Page.reload', {}, page);
await until(() => pageEval(page, "return !!document.querySelector('.empty-library, .book-card')"), 20000);
// pdf.js 的 render 在后台标签页会暂停；必须先让页面可见再导入
await send('Page.bringToFront', {}, page).catch(() => {});
check('阅读页可见（后台标签页会暂停渲染）', await pageEval(page, "return document.visibilityState" ) === 'visible');

// 先测导入上限，避免后面 pdf.js render 卡住影响页面
check('单本上限默认 100 MB 且可见', await pageEval(page, "return document.getElementById('maxBookMb').value") === '100');
const obpPath = path.join(ROOT, 'reader', 'pdf-real', 'obp.pdf');
if (fs.existsSync(obpPath)) {
  await setInputFile(page, obpPath, true);
  await sleep(1500);
  const statusText = await pageEval(page, "return (document.getElementById('libraryStatus')||{}).textContent || ''");
  check('超过单本上限时拒绝并提示', /上限/.test(statusText), statusText);
}

await setInputFile(page, PDF, true);
const pages = await until(() => pageEval(page, "return document.querySelectorAll('.pdf-page').length"), 30000);
check('PDF 导入后进入阅读页（页容器）', !!pages, pages ? pages + ' 页' : '没有页容器');
check('页标题/页数正确', !!(await pageEval(page, "const s=document.getElementById('readerSubtitle'); return s && s.textContent.indexOf('PDF') >= 0;")));
const tocCount = await until(() => pageEval(page, "return document.querySelectorAll('#tocList a').length"), 15000);
check('目录面板有可跳转条目', tocCount > 0, tocCount + ' 条');

if (process.env.RIMEFOX_PDF_RENDER !== '0') {
  const canvas = await until(() => pageEval(page, "return document.querySelectorAll('.pdf-page canvas').length"), 30000);
  check('首页 canvas 渲染', !!canvas, canvas ? canvas + ' 个' : '没有 canvas');
  const blocks = await until(() => pageEval(page, "return document.querySelectorAll('.pdf-block').length"), 30000);
  check('首页文本块提取', !!blocks, blocks ? blocks + ' 块' : '没有文本块');
  const firstText = await pageEval(page, "const b=document.querySelector('.pdf-block'); return b ? b.textContent.slice(0,60) : ''");
  check('首块不是页眉', !!firstText && !/PLOS One|doi\.org|eLife 2025/i.test(firstText), firstText);
  await pageEval(page, "window.scrollTo(0, document.documentElement.scrollHeight); return true;");
  await sleep(1500);
  const canvases2 = await pageEval(page, "return document.querySelectorAll('.pdf-page canvas').length");
  check('滚动后第二页也被渲染', canvases2 >= 2, canvases2 + ' 个 canvas');
} else {
  console.log('  NOTE 按 RIMEFOX_PDF_RENDER=0 跳过 canvas / 文本块断言');
}

// 缩放：回到顶部再测，避免第一页在可视区外没被重渲染
await pageEval(page, "window.scrollTo(0,0); return true;");
await sleep(1200);
const canvasBefore = await pageEval(page, "const c=document.querySelector('.pdf-page canvas'); return c ? c.width : 0");
await pageEval(page, "document.getElementById('pdfZoomIn').click(); return true;");
const zoomed = await until(() => pageEval(page, "const c=document.querySelector('.pdf-page canvas'); return c && c.width > " + canvasBefore + " ? c.width : 0"), 40000);
check('PDF 放大后重新渲染更高分辨率', !!zoomed, canvasBefore + ' → ' + (zoomed || 0));
const zoomLabel = await pageEval(page, "return document.getElementById('pdfZoomLabel').textContent");
check('缩放比例显示', zoomLabel === '125%', zoomLabel);
await pageEval(page, "document.getElementById('pdfZoomOut').click(); return true;");
await sleep(800);

// 流式视图 + 位置同步
await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='flow-original'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
const flowReady = await until(() => pageEval(page, "return document.querySelectorAll('#pdfFlow .pdf-block').length"), 15000);
check('流式视图渲染文本块', !!flowReady, flowReady ? flowReady + ' 块' : '没有文本块');
await pageEval(page, "const s=document.querySelector('#pdfFlow .pdf-flow-page[data-page=\"5\"]'); if (s) s.scrollIntoView({block:'start'}); return true;");
await sleep(900);
await pageEval(page, "window.dispatchEvent(new Event('scroll')); return true;");
await sleep(400);
await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='pdf-original'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(1500);
const pageAfter = await pageEval(page, "let cur = 1; for (const el of document.querySelectorAll('.pdf-page')) { if (el.getBoundingClientRect().top <= 140) cur = Number(el.dataset.page); else break; } return cur;");
check('流式切回原版：跳到对应页', pageAfter >= 4, '第 ' + pageAfter + ' 页');

// 跳页 + 全文搜索 + 损坏 PDF 提示
await pageEval(page, "const i=document.getElementById('pdfJumpInput'); i.value='3'; document.getElementById('pdfJumpGo').click(); return true;");
await sleep(900);
const jumpPage = await pageEval(page, "let cur=1; for (const el of document.querySelectorAll('.pdf-page')) { if (el.getBoundingClientRect().top <= 140) cur=Number(el.dataset.page); else break; } return cur;");
check('跳页到第 3 页', jumpPage === 3, jumpPage);
await pageEval(page, "document.getElementById('pdfSearchInput').value='Ethical'; document.getElementById('pdfSearchGo').click(); return true;");
const searchHits = await until(() => pageEval(page, "return document.querySelectorAll('.pdf-search-hit').length"), 20000);
check('全文搜索有结果', !!searchHits, searchHits ? searchHits + ' 条' : '没有结果');
await pageEval(page, "const a=document.querySelector('.pdf-search-hit'); if (a) a.click(); return true;");
await sleep(900);


check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

// PDF 译文：切到双语，验证译文注入、请求、进度与延迟
await pageEval(page, "window.scrollTo(0, 0); return true;");
const t0 = Date.now();
await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='flow-bilingual'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
const progressShown = await until(() => pageEval(page, "return !document.getElementById('pdfProgress').hidden"), 2000);
const transCount = await until(() => pageEval(page, "return document.querySelectorAll('.pdf-trans').length"), 30000);
const elapsed = Date.now() - t0;
check('PDF 译文出现', !!transCount, transCount ? transCount + ' 段' : '没有译文');
const transText = await pageEval(page, "const t=document.querySelector('.pdf-trans'); return t ? t.textContent.slice(0,40) : ''");
check('译文来自翻译接口', /^译:/.test(transText), transText);
check('翻译请求已发出', hits.requests > 0, hits.requests + ' 次');
check('翻译开始显示进度条', !!progressShown);
check('双语切换延迟 < 3s', elapsed < 3000, elapsed + 'ms');

await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='flow-translation'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await until(() => pageEval(page, "return document.getElementById('bookContent').dataset.pdfMode === 'translation'"), 5000);
const srcDisplay = await pageEval(page, "const s=document.querySelector('.pdf-block .pdf-src'); return s ? getComputedStyle(s).display : 'missing';");
check('仅译文模式隐藏原文', srcDisplay === 'none', srcDisplay);
await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='pdf-original'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await until(() => pageEval(page, "return document.getElementById('bookContent').dataset.pdfMode === 'original'"), 5000);
const transDisplay = await pageEval(page, "const t=document.querySelector('.pdf-trans'); return t ? getComputedStyle(t).display : 'missing';");
check('原文模式隐藏译文', transDisplay === 'none', transDisplay);

// 字号只影响文本块（PDF 画布是图片，不重排）
await pageEval(page, "const s=document.getElementById('fontSize'); s.value='24'; s.dispatchEvent(new Event('input',{bubbles:true})); return true;");
await sleep(400);
const blockFont = await pageEval(page, "const b=document.querySelector('.pdf-block'); return b ? getComputedStyle(b).fontSize : ''");
check('PDF 文本块跟随阅读字号', parseFloat(blockFont) > 15, blockFont);

// 流式视图内切换译文模式，锚点页保持不变
await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='flow-original'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(800);
await pageEval(page, "const s=document.querySelectorAll('#pdfFlow .pdf-flow-page')[4]; if (s) s.scrollIntoView({block:'start'}); return true;");
await sleep(700);
await pageEval(page, "window.dispatchEvent(new Event('scroll')); return true;");
await sleep(300);
const flowPageBefore = await pageEval(page, "let cur=1; for (const s of document.querySelectorAll('#pdfFlow .pdf-flow-page')) { if (s.getBoundingClientRect().top <= 120) cur=Number(s.dataset.page); else break; } return cur;");
await pageEval(page, "const m=document.getElementById('modeSelect'); m.value='flow-translation'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(600);
const flowPageAfter = await pageEval(page, "let cur=1; for (const s of document.querySelectorAll('#pdfFlow .pdf-flow-page')) { if (s.getBoundingClientRect().top <= 120) cur=Number(s.dataset.page); else break; } return cur;");
check('流式内切换译文模式锚点不变', flowPageAfter === flowPageBefore, flowPageBefore + ' -> ' + flowPageAfter);

// 缓存与生命周期：所有操作走真实阅读器控件、后台和 IndexedDB。
const chooseMode = async (value) => {
  await pageEval(page, "const s=document.getElementById('modeSelect'); s.value=" + JSON.stringify(value) + "; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  await until(() => pageEval(page, 'return document.getElementById("modeSelect").value === ' + JSON.stringify(value)), 5000);
};
const chooseTarget = async (value, expectedMode = 'flow-original') => {
  await pageEval(page, "const s=document.getElementById('targetSelect'); s.value=" + JSON.stringify(value) + "; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  await until(() => pageEval(page, 'return !document.getElementById("targetSelect").disabled && document.getElementById("modeSelect").value === ' + JSON.stringify(expectedMode)), 5000);
  await sleep(400);
};
const firstTranslation = () => pageEval(page, 'return document.querySelector("#pdfFlow .pdf-flow-page")?.querySelector(".pdf-trans")?.textContent || ""');
const idle = async () => {
  await until(() => pageEval(page, 'return document.getElementById("pdfProgress").hidden'), 10000);
  await sleep(300);
};
const clearPdfCache = () => pageEval(page, 'return import("/lib/reader/store.js").then(async s => { const books=await s.listBooks(); await s.deleteBookTranslations(books[0].id); return true; })');
const pdfCacheRows = () => pageEval(page, 'return new Promise((resolve,reject)=>{ const r=indexedDB.open("rimefox-reader"); r.onsuccess=()=>{const db=r.result;const q=db.transaction("translations").objectStore("translations").getAll();q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)};r.onerror=()=>reject(r.error)})');
const patchConfig = (patch) => pageEval(page, 'return import("/lib/config.js").then(m=>m.saveConfig(' + JSON.stringify(patch) + ')).then(()=>true)');

await idle();
await chooseMode('flow-original');
await pageEval(page, 'window.scrollTo(0,0); window.dispatchEvent(new Event("scroll")); return true;');
await sleep(800);
await chooseMode('flow-bilingual');
check('滚回顶部再切模式仍停留第一页', await pageEval(page, 'return document.querySelector("#pdfFlow .pdf-flow-page").getBoundingClientRect().top >= -120'));
await until(async () => (await firstTranslation()).startsWith('译:'));
await idle();
const chineseText = await firstTranslation();
let before = hits.requests;
await chooseTarget('fr', 'flow-bilingual');
await until(async () => (await firstTranslation()).startsWith('Traduction française'));
await idle();
check('切换 PDF 目标语言保持流式双语并按法语重译', hits.requests > before && (await firstTranslation()).startsWith('Traduction française'));
before = hits.requests;
const cachedChinese = new Set(hits.sent);
const sentBeforeChinese = hits.sent.length;
await chooseTarget('zh-CN', 'flow-bilingual');
await until(async () => (await firstTranslation()) === chineseText);
await idle();
check('切回中文复用已有文本缓存，不重复送翻', !hits.sent.slice(sentBeforeChinese).some((text) => cachedChinese.has(text)) && (await firstTranslation()) === chineseText,
  JSON.stringify({ newRequests: hits.requests - before, textMatches: (await firstTranslation()) === chineseText }));
before = hits.requests;
await chooseMode('flow-translation');
await chooseMode('flow-bilingual');
await idle();
check('仅译文 / 双语切换不重复付费', hits.requests === before);

// 快速连点版式：最后一次应生效，且不能被未渲染占位页把锚点带到很远。
await pageEval(page, "const s=document.getElementById('modeSelect'); ['pdf-original','flow-original','flow-bilingual','flow-translation','flow-original','pdf-original','flow-bilingual'].forEach((v) => { s.value=v; s.dispatchEvent(new Event('change',{bubbles:true})); }); return true;");
await until(() => pageEval(page, "return !!document.querySelector('#pdfFlow .pdf-flow-page .pdf-flow-blocks')"), 8000);
await sleep(200);
const rapidState = await pageEval(page, "const f=document.querySelector('#pdfFlow .pdf-flow-page'); return { mode: document.getElementById('modeSelect').value, flow: !!document.getElementById('pdfFlow'), blocks: document.querySelectorAll('#pdfFlow .pdf-flow-blocks').length, top: f ? Math.round(f.getBoundingClientRect().top) : null };");
const rapidTop = rapidState && rapidState.top;
check('快速切换版式后仍停留在第一页', rapidTop != null && rapidTop >= -120 && rapidTop <= 400, String(rapidTop));
await idle();

await send('Page.reload', {}, page);
await until(() => pageEval(page, 'return !!document.querySelector(".book-card .reader-button")'));
await pageEval(page, 'document.querySelector(".book-card .reader-button").click(); return true;');
await until(() => pageEval(page, 'return !document.getElementById("readerView").hidden && document.querySelectorAll(".pdf-page").length > 0'));
await chooseMode('flow-bilingual');
await until(async () => (await firstTranslation()) === chineseText);
await idle();
check('重开阅读页仍复用正确语言的 IndexedDB 缓存', hits.requests === before && (await firstTranslation()) === chineseText);

const changes = [
  ['模型', { providerConfig: { __custom__: { model: 'fake-second' } } }],
  ['接口地址', { providerConfig: { __custom__: { baseUrl: API_ORIGIN + '/second/v1' } } }],
  ['提示词', { customPrompt: 'Use formal wording.' }],
  ['术语', { glossary: [{ source: 'paragraph', target: '段落', note: '回归测试' }] }]
];
for (const [label, patch] of changes) {
  before = hits.requests;
  await patchConfig(patch);
  await until(() => pageEval(page, 'return document.getElementById("modeSelect").value === "flow-original" && !document.querySelector(".pdf-trans")'), 5000);
  await sleep(400);
  check('修改' + label + '不自动翻译并撤去旧配置译文', hits.requests === before && !(await firstTranslation()));
  await chooseMode('flow-bilingual');
  await until(async () => hits.requests > before && (await firstTranslation()).startsWith('译:'));
  await idle();
  check('明确翻译后不复用旧' + label + '缓存', hits.requests > before && (await firstTranslation()).startsWith('译:'));
}
before = hits.requests;
await patchConfig({ uiTheme: 'dark' });
await sleep(500);
check('外观变化保留译文与模式且不发送请求', hits.requests === before && !!(await firstTranslation()) && await pageEval(page, 'return document.getElementById("modeSelect").value === "flow-bilingual"'));
await patchConfig({ providerConfig: cfg.providerConfig, customPrompt: '', glossary: [] });
await until(() => pageEval(page, 'return document.getElementById("modeSelect").value === "flow-original"'), 5000);
await chooseMode('flow-bilingual');
await until(async () => (await firstTranslation()) === chineseText);
await idle();
check('切回原配置可复用原来的缓存', hits.requests === before && (await firstTranslation()) === chineseText);

await chooseMode('flow-original');
const legacySource = (await pdfCacheRows()).find((row) => row.sectionId === 'page:1' && row.key.split('|')[3] === '0');
await clearPdfCache();
if (!legacySource) throw new Error('Legacy cache test requires the translated first block');
const legacyRecord = { ...legacySource, key: 'pdf|' + legacySource.bookId + '|page:1|0|' + legacySource.contentHash, translated: '旧版错误缓存' };
delete legacyRecord.cacheIdentity;
await pageEval(page, 'return import("/lib/reader/store.js").then(s=>s.putTranslation(' + JSON.stringify(legacyRecord) + ')).then(()=>true)');
before = hits.requests;
await chooseMode('flow-bilingual');
await until(async () => hits.requests > before && (await firstTranslation()).startsWith('译:'));
await idle();
check('无配置身份的旧版缓存不能作为新译文复用', hits.requests > before && (await firstTranslation()).startsWith('译:'));

for (const kind of ['config', 'close', 'stop']) {
  await chooseMode('flow-original');
  await clearPdfCache();
  holdRequests = true;
  await chooseMode('flow-bilingual');
  const captured = await until(() => held.length > 0, 5000);
  check(kind + '：假 API 已挂起真实后台请求', !!captured);
  const previousView = await pageEval(page, 'return Array.from(document.querySelectorAll(".pdf-trans"), n=>n.textContent)');
  if (kind === 'config') {
    await patchConfig({ customPrompt: 'Changed while waiting.' });
    await until(() => pageEval(page, 'return document.getElementById("modeSelect").value === "flow-original"'), 5000);
  }
  if (kind === 'close') await pageEval(page, 'document.getElementById("backToLibrary").click(); return true;');
  if (kind === 'stop') await pageEval(page, 'document.getElementById("pdfTranslateStop").click(); window.dispatchEvent(new Event("scroll")); return true;');
  before = hits.requests;
  holdRequests = false;
  for (const release of held.splice(0)) release();
  await sleep(900);
  const cacheRows = await pdfCacheRows();
  const currentView = await pageEval(page, 'return Array.from(document.querySelectorAll(".pdf-trans"), n=>n.textContent)');
  const viewUnchanged = kind === 'stop' ? JSON.stringify(currentView) === JSON.stringify(previousView) : currentView.length === 0;
  check(kind + '：旧响应不写入视图 / 缓存、不再补发', hits.requests === before && cacheRows.length === 0 && viewUnchanged,
    JSON.stringify({ requests: hits.requests - before, cached: cacheRows.length, viewUnchanged }));
  if (kind === 'close') {
    await until(() => pageEval(page, 'return !!document.querySelector(".book-card .reader-button")'));
    await pageEval(page, 'document.querySelector(".book-card .reader-button").click(); return true;');
    await until(() => pageEval(page, 'return !document.getElementById("readerView").hidden && document.querySelectorAll(".pdf-page").length > 0'));
  }
  await chooseMode('flow-bilingual');
  await until(() => hits.requests > before, 10000);
  await until(async () => !!(await firstTranslation()));
  await idle();
  check(kind + '：新任务可正常翻译', hits.requests > before && !!(await firstTranslation()));
}

// 新任务先完成，再放回旧响应；旧 finally 也不能破坏新任务的视图与进度。
await chooseMode('flow-original');
await clearPdfCache();
holdRequests = true;
await chooseMode('flow-bilingual');
check('并发晚归：旧请求已进入接口', !!(await until(() => held.length > 0, 5000)));
const oldReplies = held.splice(0);
holdRequests = false;
await patchConfig({ customPrompt: 'Late reply test ' + Date.now() });
await until(() => pageEval(page, 'return document.getElementById("modeSelect").value === "flow-original"'), 5000);
await chooseMode('flow-bilingual');
await until(async () => (await firstTranslation()).startsWith('译:'));
await sleep(800);
await idle();
await until(async () => (await firstTranslation()).startsWith('译:'), 10000);
await sleep(1500);
const freshText = await firstTranslation();
const freshRows = (await pdfCacheRows()).map((row) => row.key).sort();
before = hits.requests;
for (const release of oldReplies) release();
await sleep(900);
await until(() => pageEval(page, 'return document.getElementById("pdfProgress").hidden'), 10000);
const finalText = await firstTranslation();
const finalRows = (await pdfCacheRows()).map((row) => row.key).sort();
const finalHidden = await pageEval(page, 'return document.getElementById("pdfProgress").hidden');
check('并发晚归：新译文、缓存与进度不受旧任务影响', !!freshText && finalText === freshText
  && JSON.stringify(finalRows) === JSON.stringify(freshRows)
  && hits.requests === before && finalHidden,
  JSON.stringify({ freshText: freshText.slice(0, 30), finalText: finalText.slice(0, 30), sameRows: JSON.stringify(finalRows) === JSON.stringify(freshRows), requests: hits.requests - before, hidden: finalHidden, rows: finalRows.length, freshRows: freshRows.length }));

// 损坏 PDF：放在最后，导入失败会回到书库
const badPdf = path.join(os.tmpdir(), 'rimefox-corrupt-' + Date.now() + '.pdf');
fs.writeFileSync(badPdf, 'this is not a pdf file');
const badDoc = await send('DOM.getDocument', { depth: 0, pierce: true }, page);
const badInput = await send('DOM.querySelector', { nodeId: badDoc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: badInput.nodeId, files: [badPdf] }, page);
await pageEval(page, "document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
await sleep(1500);
const badStatus = await pageEval(page, "return (document.getElementById('libraryStatus')||{}).textContent || '';");
check('损坏 PDF 给出明确提示', /损坏|有效的 PDF/.test(badStatus), badStatus);

const failed = results.filter((one) => !one.ok).length;
console.log('\n' + (results.length - failed) + ' / ' + results.length + ' 通过');
try { server.close(); } catch (err) { /* ignore */ }
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
process.exit(failed ? 1 : 0);
