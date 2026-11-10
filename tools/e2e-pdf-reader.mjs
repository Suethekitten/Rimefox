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
const EXTENSION = process.env.RIMEFOX_EXTENSION || ROOT;
const CHROME = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const PDF = process.argv[2] || path.join(ROOT, 'reader', 'pdf-samples', 'reader.pdf');
const PORT = 20600 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-pdf-reader-'));
const badPdf = path.join(profile, 'corrupt.pdf');
// 临时用户目录（损坏 PDF 也放在里面）每次都要删：以前只 kill 浏览器，每跑一次在系统临时目录留下约 120 MB。
// 正常结束先等 Chrome 真正退出再删（SIGKILL 后子进程可能还在写，立即删会 ENOTEMPTY）；中途抛错时 exit 里同步兜底。
let removed = false;
function removeProfile() {
  if (removed) return;
  removed = true;
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (err) { console.log('NOTE temporary profile not fully removed (' + err.code + '): ' + profile); }
}
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
const layoutReplies = {
  'Horizontal layout caption': '横排译文',
  'Upward side heading': '向上译文',
  'Downward side heading': '向下译文',
  'Diagonal note': '斜排译文',
  'Short side': '放不下的译文'.repeat(20),
  'Aligned after page rotation': '随页面转正',
  'Rotated with the page': '随页面旋转',
  'Collision caption': '碰撞图注',
  'Collision heading': '碰撞标题',
  'COASTAL WATERS': '沿海水域',
  'WEATHER PATTERNS': '天气形态',
  'WHAT CAN WE DO?': '我们能做什么',
  'COASTAL LIFE': '海岸生活',
  'Harbour': '港口',
  'Photo: Ana Ruiz': '摄影：安娜',
  'Figure 3. Boats return to the harbour at dawn.': '图 3：黎明时渔船返港。',
  'Most of the catch is sold before the market opens. The rest is dried on racks along the shore.': '大部分渔获在开市前售出，其余晾在岸边架子上。'
};
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
        const content = JSON.stringify(texts.map((text, i) => Object.hasOwn(layoutReplies, text) ? (french ? 'Traduction' : layoutReplies[text])
          : /Layout caption|Text stays inside/.test(text) ? (french ? 'Traduction' : '版式译文') : french
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
process.on('exit', () => { try { browser.kill('SIGKILL'); } catch (err) { /* cleanup */ } removeProfile(); });
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

const { id: extId } = await send('Extensions.loadUnpacked', { path: EXTENSION });
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
check('新 PDF 默认双列对照', await pageEval(page, 'return document.getElementById("modeSelect").value==="pdf-parallel" && document.getElementById("bookContent").dataset.pdfLayout==="parallel"'));
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
  if (!process.argv[2]) check('/Rotate 90 首屏横向渲染并保留正文', await pageEval(page, 'const p=document.querySelector(".pdf-page");const c=p.querySelector("canvas");return c.width>c.height && p.textContent.includes("Ethical principles")'));
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
const cssBefore = await pageEval(page, 'return document.querySelector(".pdf-page > canvas").getBoundingClientRect().width');
await pageEval(page, "document.getElementById('pdfZoomIn').click(); return true;");
const zoomed = await until(() => pageEval(page, "const c=document.querySelector('.pdf-page canvas'); return c && c.width > " + canvasBefore + " ? c.width : 0"), 40000);
check('PDF 放大后重新渲染更高分辨率', !!zoomed, canvasBefore + ' → ' + (zoomed || 0));
check('双列缩放会实际放大页面尺寸', await pageEval(page, 'return document.querySelector(".pdf-page > canvas").getBoundingClientRect().width > ' + cssBefore + '*1.1'));
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
  await until(() => pageEval(page, 'const c=document.getElementById("bookContent");return (c.dataset.pdfFacsimile==="1")===' + (value === 'pdf-layout') + ' && c.classList.contains("pdf-flow-mode")===' + value.startsWith('flow-')), 5000);
  await sleep(500); // includes the product's 120 ms mode debounce and 400 ms page dwell
};
const chooseTarget = async (value, expectedMode = 'flow-original') => {
  await pageEval(page, "const s=document.getElementById('targetSelect'); s.value=" + JSON.stringify(value) + "; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  await until(() => pageEval(page, 'return !document.getElementById("targetSelect").disabled && document.getElementById("modeSelect").value === ' + JSON.stringify(expectedMode)), 5000);
  await sleep(400);
};
const firstTranslation = () => pageEval(page, 'return document.querySelector("#pdfFlow .pdf-flow-page")?.querySelector(".pdf-trans")?.textContent || ""');
const idle = async () => {
  await until(() => pageEval(page, 'return document.getElementById("pdfProgress").hidden'), 10000);
  await sleep(700);
  await until(() => pageEval(page, 'return document.getElementById("pdfProgress").hidden'), 10000);
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
const paidBeforeModes = new Set(hits.sent);
const sentBeforeModes = hits.sent.length;
await chooseMode('flow-translation');
await chooseMode('flow-bilingual');
await idle();
check('仅译文 / 双语切换不重复付费', !hits.sent.slice(sentBeforeModes).some(text => paidBeforeModes.has(text)), JSON.stringify({newRequests:hits.requests-before,duplicateTexts:hits.sent.slice(sentBeforeModes).filter(text=>paidBeforeModes.has(text)).length}));

await chooseMode('pdf-original');
await idle();
await pageEval(page, 'document.getElementById("pdfJumpInput").value="1";document.getElementById("pdfJumpGo").click();return true;');
await idle();
before = hits.requests;
await chooseMode('pdf-parallel');
check('PDF 双列：左侧原页面、右侧译文', !!await until(() => pageEval(page, 'const p=document.querySelector(".pdf-page"),c=p?.querySelector("canvas"),t=p?.querySelector(".pdf-blocks");return c && t && t.querySelector(".pdf-trans") && c.getBoundingClientRect().right<=t.getBoundingClientRect().left && document.getElementById("bookContent").dataset.pdfLayout==="parallel"')));
await idle();
before = hits.requests;
await chooseMode('pdf-original');
await chooseMode('pdf-parallel');
await idle();
check('PDF 双列切换复用已翻译页面缓存', hits.requests === before, before + ' → ' + hits.requests);
await send('Page.bringToFront', {}, page);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);
const tocWasHidden = await pageEval(page, 'const p=document.getElementById("tocPanel");const hidden=p.hidden;p.hidden=true;window.scrollTo(0,0);return hidden;');
await sleep(500);
const parallelScreenshot = await send('Page.captureScreenshot', { format: 'png' }, page);
fs.writeFileSync(path.join(profile, 'pdf-parallel.png'), Buffer.from(parallelScreenshot.data, 'base64'));
console.log('    双列截图：' + path.join(profile, 'pdf-parallel.png'));
await pageEval(page, 'document.getElementById("tocPanel").hidden=' + JSON.stringify(tocWasHidden) + ';return true;');
await send('Emulation.clearDeviceMetricsOverride', {}, page);
await chooseMode('flow-bilingual');

// 快速连点版式：最后一次应生效，且不能被未渲染占位页把锚点带到很远。
await pageEval(page, "const s=document.getElementById('modeSelect'); ['pdf-original','flow-original','flow-bilingual','flow-translation','flow-original','pdf-original','flow-bilingual'].forEach((v) => { s.value=v; s.dispatchEvent(new Event('change',{bubbles:true})); }); return true;");
await until(() => pageEval(page, "return !!document.querySelector('#pdfFlow .pdf-flow-page .pdf-flow-blocks')"), 8000);
await sleep(200);
const rapidState = await pageEval(page, "const f=document.querySelector('#pdfFlow .pdf-flow-page'); return { mode: document.getElementById('modeSelect').value, flow: !!document.getElementById('pdfFlow'), blocks: document.querySelectorAll('#pdfFlow .pdf-flow-blocks').length, top: f ? Math.round(f.getBoundingClientRect().top) : null };");
const rapidTop = rapidState && rapidState.top;
check('快速切换版式后仍停留在第一页', rapidTop != null && rapidTop >= -120 && rapidTop <= 400, String(rapidTop));
await idle();

before = hits.requests;
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

// Raster-backed facsimile preview must preserve illustration pixels and cache identity.
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);
await pageEval(page, 'document.getElementById("backToLibrary").click();return true;');
const layoutDoc = await send('DOM.getDocument', { depth: 0 }, page);
const layoutInput = await send('DOM.querySelector', { nodeId: layoutDoc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: layoutInput.nodeId, files: [path.join(ROOT, 'reader/pdf-samples/layout.pdf')] }, page);
await pageEval(page, 'document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
await until(() => pageEval(page, 'return document.querySelector(".pdf-blocks")?.textContent.includes("版式译文")'));
before = hits.requests;
await chooseMode('pdf-layout');
const layoutPlaced = await until(() => pageEval(page, 'return document.querySelectorAll(".pdf-layout-translation").length===2'));
check('双列版式预览把短译文放回文字框', !!layoutPlaced, await pageEval(page, 'return document.querySelector(".pdf-layout-notice")?.textContent'));
const preserved = await pageEval(page, 'const a=document.querySelector(".pdf-page > canvas"),b=document.querySelector(".pdf-layout-view canvas");if(!a||!b)return null;const sample=c=>Array.from(c.getContext("2d").getImageData(Math.floor(c.width*.15),Math.floor(c.height*.5),1,1).data);return {left:sample(a),right:sample(b),bounds:Array.from(document.querySelectorAll(".pdf-layout-translation")).every(t=>t.scrollWidth<=t.clientWidth+1&&t.scrollHeight<=t.clientHeight+1)}');
check('原页插图区域逐像素保留，译文没有溢出文字框', preserved && JSON.stringify(preserved.left)===JSON.stringify(preserved.right) && preserved.bounds, JSON.stringify(preserved));
check('版式与文字双列共用翻译缓存', hits.requests===before);
check('完整译文可展开查看，预览限制明确显示', await pageEval(page, 'return !!document.querySelector(".pdf-layout-text summary") && document.querySelector(".pdf-layout-notice").textContent.includes("复杂背景")'));
check('版式提示与完整译文入口在原页上方', await pageEval(page, 'const p=document.querySelector(".pdf-page"),n=p.querySelector(".pdf-layout-notice"),d=p.querySelector(".pdf-layout-text"),v=p.querySelector(".pdf-layout-view"),c=p.querySelector(":scope > canvas");return n.getBoundingClientRect().bottom<=d.getBoundingClientRect().top+1 && d.getBoundingClientRect().bottom<=Math.min(v.getBoundingClientRect().top,c.getBoundingClientRect().top)+1 && n.textContent.startsWith("版式预览：已替换 2 处。")'),
  await pageEval(page, 'return document.querySelector(".pdf-layout-notice").textContent'));
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page);
fs.writeFileSync(path.join(profile, 'pdf-layout.png'), Buffer.from(shot.data, 'base64'));
console.log('    版式预览截图：' + path.join(profile, 'pdf-layout.png'));
holdRequests = true;
await chooseTarget('fr', 'pdf-layout');
await until(() => held.length > 0, 10000);
check('版式切语言保留双列并立即移除旧语言覆盖层', await pageEval(page, 'return document.getElementById("modeSelect").value==="pdf-layout" && !document.querySelector(".pdf-layout-translation")'));
check('新译文到达前提示本页译文尚未生成', await pageEval(page, 'return document.querySelector(".pdf-layout-notice")?.textContent.includes("本页译文尚未生成")'),
  await pageEval(page, 'return document.querySelector(".pdf-layout-notice")?.textContent'));
holdRequests = false; for (const reply of held.splice(0)) reply();
check('版式预览按新目标语言重新翻译', !!await until(() => pageEval(page, 'return document.querySelectorAll(".pdf-layout-translation").length===2 && document.querySelector(".pdf-layout-translation").textContent==="Traduction"')));
before = hits.requests;
await chooseTarget('zh-CN', 'pdf-layout');
await until(() => pageEval(page, 'return document.querySelector(".pdf-layout-translation")?.textContent==="版式译文"'));
await idle();
check('版式切回原语言复用缓存', hits.requests === before);
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false }, page);
await sleep(500);
check('窗口变窄后版式文字重新适配、不溢出', await pageEval(page, 'return document.querySelectorAll(".pdf-layout-translation").length===2 && Array.from(document.querySelectorAll(".pdf-layout-translation")).every(t=>t.scrollWidth<=t.clientWidth+1&&t.scrollHeight<=t.clientHeight+1)'));
await chooseMode('pdf-parallel');
check('可切回文字双列且没有残留版式画布', await pageEval(page, 'return !document.querySelector(".pdf-layout-view,.pdf-layout-text") && !!document.querySelector(".pdf-page > .pdf-blocks")'));
await chooseMode('pdf-layout');
await until(() => pageEval(page, 'return document.querySelectorAll(".pdf-layout-translation").length===2'));
await pageEval(page, 'window.__layoutCanvases=Array.from(document.querySelectorAll("canvas"));document.getElementById("backToLibrary").click();return true;');
check('关书释放原页和译文页画布', await pageEval(page, 'return window.__layoutCanvases.length===2 && window.__layoutCanvases.every(c=>c.width===0)'));

async function openLayoutSample(filename, sourceText) {
  await pageEval(page, 'document.getElementById("backToLibrary").click();return true;');
  const { root } = await send('DOM.getDocument', { depth: 0 }, page);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' }, page);
  await send('DOM.setFileInputFiles', { nodeId, files: [path.join(ROOT, 'reader/pdf-samples', filename)] }, page);
  await pageEval(page, 'document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
  await until(() => pageEval(page, 'return document.querySelector(".pdf-page[data-page=\"1\"] .pdf-blocks")?.textContent.includes(' + JSON.stringify(sourceText) + ')'));
  await chooseMode('pdf-layout');
}

function layoutState(n) {
  return pageEval(page, `
    const view = document.querySelector('.pdf-page[data-page="${n}"] .pdf-layout-view');
    if (!view) return null;
    const v = view.getBoundingClientRect();
    return { skips: view.dataset.layoutSkips, width: v.width, boxes: Array.from(view.querySelectorAll('.pdf-layout-translation'), (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el).transform;
      const matrix = new DOMMatrix(style === 'none' ? undefined : style);
      const degrees = Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
      return { text: el.textContent, page: el.matches('.pdf-layout-toc') ? el.lastElementChild.textContent : null,
        angle: (degrees + 360) % 360, x: (r.x - v.x) / v.width, y: (r.y - v.y) / v.height,
        inside: r.left >= v.left - 1 && r.top >= v.top - 1 && r.right <= v.right + 1 && r.bottom <= v.bottom + 1,
        fits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1 };
    }) };
  `);
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);
await openLayoutSample('layout-mixed.pdf', 'Horizontal layout caption');
const mixed = await until(async () => {
  const result = await layoutState(1);
  return result?.boxes.some((box) => box.text === '横排译文') && result;
});
check('混排页横排和两种直角旋转都能覆盖', !!mixed && mixed.boxes.length === 3
  && mixed.boxes.every((box) => box.inside && box.fits
    && box.angle === { 横排译文: 0, 向上译文: 270, 向下译文: 90 }[box.text]), JSON.stringify(mixed));
check('斜排和放不下的直角文字保留原样并分类计数', !!mixed
  && /position:1,background:0,fit:1/.test(mixed.skips), mixed?.skips);
const mixedNotice = await pageEval(page, `
  const p = document.querySelector('.pdf-page[data-page="1"]');
  return { notice: p.querySelector('.pdf-layout-notice').textContent, summary: p.querySelector('.pdf-layout-text summary').textContent,
    tagged: Array.from(p.querySelectorAll('.pdf-layout-text .pdf-block[data-layout-skip]'), (b) => [b.querySelector('.pdf-src').textContent, b.dataset.layoutSkip]) };`);
check('页面提示写明已替换、保留原文的数量与原因', mixedNotice.notice.startsWith('版式预览：已替换 3 处，2 处保留原文（无法定位或与其他文字重叠 1 处、译文放不下 1 处）。')
  && mixedNotice.summary === '查看本页完整译文（含未放入版式的 2 处）', JSON.stringify(mixedNotice));
check('完整译文里标出未放入版式的段落及原因', JSON.stringify(mixedNotice.tagged.sort()) === JSON.stringify([['Diagonal note', 'position'], ['Short side', 'fit']]), JSON.stringify(mixedNotice.tagged));
await send('Emulation.setDeviceMetricsOverride', { width: 1140, height: 900, deviceScaleFactor: 1, mobile: false }, page);
const resized = await until(async () => {
  const result = await layoutState(1);
  return result?.boxes.length === 3 && result.width < (mixed?.width || 0) - 20 && result;
}, 5000);
check('缩窄窗口后旋转覆盖层仍贴合原页坐标', !!resized && resized.boxes.every((box) => {
  const original = mixed.boxes.find((entry) => entry.text === box.text);
  return box.inside && box.fits && box.angle === original.angle && Math.abs(box.x - original.x) < 0.005
    && Math.abs(box.y - original.y) < 0.005;
}), JSON.stringify(resized));

await pageEval(page, 'document.querySelector(\'.pdf-page[data-page="2"]\').scrollIntoView();return true;');
const turned = await until(async () => {
  const result = await layoutState(2);
  return result?.boxes.length && result;
});
check('/Rotate 90 只应用一次，与文字旋转分别合成', !!turned && turned.boxes.length === 2
  && turned.boxes.every((box) => box.inside && box.fits && box.angle === { 随页面转正: 0, 随页面旋转: 90 }[box.text]), JSON.stringify(turned));
await pageEval(page, 'document.querySelector(\'.pdf-page[data-page="3"]\').scrollIntoView();return true;');
const collision = await until(async () => {
  const result = await layoutState(3);
  return result?.skips.includes('untranslated:0') && result;
});
check('旋转覆盖层与原字外框碰撞时保留两块原文', !!collision && !collision.boxes.length
  && collision.skips.includes('position:2'), JSON.stringify(collision));

const beforeToc = hits.sent.length;
await openLayoutSample('layout-toc.pdf', 'COASTAL WATERS');
const tocPreview = await until(async () => {
  const result = await layoutState(1);
  return result?.boxes.some((box) => box.page) && result;
});
const tocBoxes = tocPreview?.boxes.filter((box) => box.page) || [];
check('混排目录的译文、章号和右侧页码按行对应', JSON.stringify(tocBoxes.map(({ text, page }) => [text, page]))
  === JSON.stringify([['04 沿海水域 111', '111'], ['05 天气形态 119', '119'], ['06 我们能做什么 127', '127']])
  && tocBoxes.every((box) => box.inside && box.fits), JSON.stringify(tocPreview));
const tocSent = hits.sent.slice(beforeToc).map((entry) => JSON.parse(entry)[3]);
check('目录章号与页码不发送给翻译服务', ['COASTAL WATERS', 'WEATHER PATTERNS', 'WHAT CAN WE DO?'].every((title) => tocSent.includes(title))
  && !tocSent.some((source) => /\d/.test(source)), JSON.stringify(tocSent));

const beforeFigure = hits.sent.length;
await openLayoutSample('layout-figure.pdf', 'Figure 3.');
const figure = await until(async () => {
  const result = await layoutState(1);
  return result?.skips.includes('untranslated:0') && result;
});
const figureTexts = (figure?.boxes || []).map((box) => box.text + '@' + box.angle).sort();
check('图片多的页面：图注、短正文、竖排署名和色带栏目名进入版式', JSON.stringify(figureTexts) === JSON.stringify(['大部分渔获在开市前售出，其余晾在岸边架子上。@0', '图 3：黎明时渔船返港。@0', '摄影：安娜@270', '海岸生活@270'].sort())
  && figure.boxes.every((box) => box.inside && box.fits), JSON.stringify(figure));
const figureNotice = await pageEval(page, 'const p=document.querySelector(\'.pdf-page[data-page="1"]\');return {notice:p.querySelector(".pdf-layout-notice").textContent,tagged:Array.from(p.querySelectorAll(".pdf-block[data-layout-skip]"),b=>b.querySelector(".pdf-src").textContent+":"+b.dataset.layoutSkip)}');
check('压在照片上的标签保留原文并注明背景原因', /background:1/.test(figure?.skips || '') && JSON.stringify(figureNotice.tagged) === '["Harbour:background"]'
  && figureNotice.notice.startsWith('版式预览：已替换 4 处，1 处保留原文（背景不是纯色 1 处）。'), JSON.stringify(figureNotice));
const setPdfUiLang = (lang) => pageEval(page, "return chrome.storage.local.get('config').then((r) => chrome.storage.local.set({ config: Object.assign({}, r.config, { uiLang: " + JSON.stringify(lang) + " }) })).then(() => true)");
await setPdfUiLang('en');
const englishLayout = await until(() => pageEval(page, `
  const p = document.querySelector('.pdf-page[data-page="1"]');
  const notice = p.querySelector('.pdf-layout-notice').textContent;
  if (!notice.startsWith('Layout preview')) return null;
  const tagged = p.querySelector('.pdf-block[data-layout-skip]');
  return { notice, label: p.querySelector('.pdf-page-label').textContent, summary: p.querySelector('.pdf-layout-text summary').textContent,
    reason: getComputedStyle(tagged, '::before').content, overlay: Array.from(p.querySelectorAll('.pdf-layout-translation'), (el) => el.textContent).sort(),
    source: tagged.querySelector('.pdf-src').textContent };`));
check('英文界面：PDF 页标签、版式提示、完整译文入口和原因标注都是英文', !!englishLayout
  && englishLayout.notice.startsWith('Layout preview: 4 replaced; 1 kept in the original (background is not a solid colour: 1).')
  && englishLayout.label === 'Page 1 / 1' && englishLayout.summary === 'Show the full translation of this page (including 1 not placed in the layout)'
  && englishLayout.reason === '"Not in the layout: background is not a solid colour"', JSON.stringify(englishLayout));
check('英文界面不改写版式译文和原文', !!englishLayout && englishLayout.source === 'Harbour'
  && JSON.stringify(englishLayout.overlay) === JSON.stringify(['大部分渔获在开市前售出，其余晾在岸边架子上。', '图 3：黎明时渔船返港。', '摄影：安娜', '海岸生活'].sort()), JSON.stringify(englishLayout?.overlay));
await setPdfUiLang('zh');
check('切回中文后 PDF 提示恢复中文', !!await until(() => pageEval(page, 'return document.querySelector(\'.pdf-page[data-page="1"] .pdf-layout-notice\').textContent.startsWith("版式预览：已替换 4 处")')));
check('图片页的页码不送翻', !hits.sent.slice(beforeFigure).some((entry) => /^\d+$/.test(JSON.parse(entry)[3])), JSON.stringify(hits.sent.slice(beforeFigure).map((entry) => JSON.parse(entry)[3])));

// QA E3: actual reader imports a 15000 x 15000 page book and rasterizes it safely.
await pageEval(page, 'document.getElementById("backToLibrary").click();return true;');
const hugeDoc = await send('DOM.getDocument', { depth: 0, pierce: true }, page);
const hugeInput = await send('DOM.querySelector', { nodeId: hugeDoc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: hugeInput.nodeId, files: [path.join(ROOT, 'reader/pdf-samples/huge.pdf')] }, page);
await pageEval(page, 'document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
await until(() => pageEval(page, 'return !document.getElementById("readerView").hidden && document.querySelectorAll(".pdf-page").length===12 && !!document.querySelector("canvas")'));
await chooseMode('pdf-layout');
let maxRaster = 0;
let hugeRendered = 0;
for (let n = 1; n <= 12; n++) {
  await pageEval(page, `const p=document.querySelector('.pdf-page[data-page="${n}"]');p.scrollIntoView();window.dispatchEvent(new Event("scroll"));return true;`);
  if (await until(() => pageEval(page, `const c=document.querySelector('.pdf-page[data-page="${n}"] canvas');return !!c && c.width>0`), 10000)) hugeRendered++;
  await sleep(300);
  if (!await pageEval(page, `const p=document.querySelector('.pdf-page[data-page="${n}"]');return !!p.querySelector(':scope > canvas')?.width && !!p.querySelector('.pdf-layout-view canvas')?.width`)) maxRaster=Infinity;
  const pixels = await pageEval(page, 'return Array.from(document.querySelectorAll("canvas"),c=>({pixels:c.width*c.height,dimension:Math.max(c.width,c.height)}))');
  maxRaster = Math.max(maxRaster, pixels.reduce((sum,c)=>sum+c.pixels,0));
  if (pixels.some(c=>c.pixels>4194304 || c.dimension>8192)) maxRaster=Infinity;
}
check('QA E3：超大 PDF 单页、全部画布和最大边长均受限', hugeRendered===12 && maxRaster>0 && maxRaster<=16777216, JSON.stringify({maxRaster, hugeRendered}));
check('超大页提示降低预览分辨率', await pageEval(page, 'return document.querySelector(".pdf-page").textContent.includes("降低预览分辨率")'));
await pageEval(page, 'window.__releasedCanvases=Array.from(document.querySelectorAll("canvas"));document.getElementById("backToLibrary").click();return true;');
check('关闭 PDF 后释放全部画布像素', await pageEval(page, 'return window.__releasedCanvases.every(c=>c.width===0 && c.height===0)'));

// 损坏 PDF：放在最后，导入失败会回到书库
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
const browserExited = browser.exitCode !== null || browser.signalCode !== null ? Promise.resolve() : new Promise((resolve) => browser.once('exit', resolve));
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
await Promise.race([browserExited, sleep(5000)]);
removeProfile();
process.exit(failed ? 1 : 0);
