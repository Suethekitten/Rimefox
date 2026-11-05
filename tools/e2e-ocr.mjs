#!/usr/bin/env node
// OCR 端到端：真实 Chrome + 打开 OCR 开关的扩展临时副本 + Native Messaging 宿主 + 假翻译 API。
// 不改仓库文件：扩展复制到临时目录后改 lib/ocr/feature.js 与 manifest 权限；宿主清单写进临时 Chrome 用户目录。
//
//   node tools/e2e-ocr.mjs
//
// 阶段 A：可选权限未授予 → 设置页「未配置OCR」、阅读器页内提示与「前往设置」。
// 阶段 B：参考宿主（tools/ocr-mock-host）→ 设置页状态、逐页识别、译文、缓存复用、流式 / 搜索、取消与错误提示。
// 阶段 C：macOS 且已构建 native/ocr-host/macos/build/rimefox-ocr-host 时，切到真实 Vision 连接器识别样本 PDF。
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

const REAL_HOST = path.join(ROOT, 'native', 'ocr-host', 'macos', 'build', 'rimefox-ocr-host');
const PORT = 21200 + Math.floor(Math.random() * 300);
const HEADED = process.env.RIMEFOX_HEADED === '1';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-ocr-e2e-'));
const profile = path.join(work, 'profile');
const hostLog = path.join(work, 'host.log');
const modeFile = path.join(work, 'mock-mode');
const useReal = path.join(work, 'use-real-host');
fs.mkdirSync(profile);
// 样本 PDF 同样复制到临时目录，Chrome 只读临时目录里的文件（理由见下方宿主启动脚本的注释）。
const SCAN_PDF = path.join(work, 'ocr-scan.pdf');
const TEXT_PDF = path.join(work, 'single.pdf');
fs.copyFileSync(path.join(ROOT, 'reader', 'pdf-samples', 'ocr-scan.pdf'), SCAN_PDF);
fs.copyFileSync(path.join(ROOT, 'reader', 'pdf-samples', 'single.pdf'), TEXT_PDF);

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
function hostMessages(type) {
  try {
    return fs.readFileSync(hostLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => !type || m.type === type);
  } catch (err) { return []; }
}

// ---------- 扩展副本 ----------
function makeCopy(name, manifestPatch) {
  const dir = path.join(work, name);
  for (const item of ['manifest.json', 'background.js', 'lib', 'content', 'options', 'popup', 'reader', 'welcome', 'icons', '_locales']) {
    const src = path.join(ROOT, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, item), { recursive: true, filter: (p) => !p.includes(path.join('reader', 'pdf-real')) });
  }
  const feature = path.join(dir, 'lib', 'ocr', 'feature.js');
  fs.writeFileSync(feature, fs.readFileSync(feature, 'utf8').replace('OCR_UI_ENABLED = false', 'OCR_UI_ENABLED = true'));
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifestPatch(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return dir;
}
const extA = makeCopy('ext-optional', (m) => { m.optional_permissions = ['nativeMessaging']; });
const extB = makeCopy('ext-granted', (m) => { m.permissions = m.permissions.concat('nativeMessaging'); });

// ---------- 宿主启动脚本（mock / 真实连接器二选一）----------
// Chrome 启动的宿主不能直接指向仓库：仓库常放在 ~/Documents 下，macOS 会对「浏览器拉起的程序读取文稿目录」
// 反复弹出访问授权（未签名的开发版二进制每次重建都算新程序）。所以宿主二进制与参考宿主脚本都先复制到临时目录。
const hostDir = path.join(work, 'host');
fs.mkdirSync(hostDir);
const mockHost = path.join(hostDir, 'host.mjs');
fs.copyFileSync(path.join(ROOT, 'tools', 'ocr-mock-host', 'host.mjs'), mockHost);
const realHostCopy = path.join(hostDir, 'rimefox-ocr-host');
if (fs.existsSync(REAL_HOST)) { fs.copyFileSync(REAL_HOST, realHostCopy); fs.chmodSync(realHostCopy, 0o755); }
const launcher = path.join(work, 'host.sh');
fs.writeFileSync(launcher, [
  '#!/bin/sh',
  'cd "' + hostDir + '"',
  'if [ -f "' + useReal + '" ]; then exec "' + realHostCopy + '" "$@"; fi',
  'export OCR_MOCK_LOG="' + hostLog + '" OCR_MOCK_MODE_FILE="' + modeFile + '" OCR_MOCK_DELAY_MS=4000',
  'exec "' + process.execPath + '" "' + mockHost + '" "$@"',
  ''
].join('\n'));
fs.chmodSync(launcher, 0o755);
function writeHostManifest(ids) {
  const dir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'com.rimefox.ocr.json'), JSON.stringify({
    name: 'com.rimefox.ocr', description: 'Rimefox OCR E2E host', path: launcher, type: 'stdio',
    allowed_origins: ids.map((id) => 'chrome-extension://' + id + '/')
  }, null, 2));
}

// ---------- 假翻译 API ----------
const API_PORT = 19100 + Math.floor(Math.random() * 300);
const api = { requests: 0, texts: [] };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const texts = JSON.parse(body.messages[1].content);
      api.requests += 1;
      api.texts.push(...texts);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((t, i) => '译:OCR 文字的中文译文第' + api.requests + '批第' + i + '段。')) }, finish_reason: 'stop' }] }));
    } catch (err) {
      res.writeHead(400);
      res.end('{}');
    }
  });
});
await new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', resolve));

// ---------- Chrome + CDP ----------
const browser = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  '--no-sandbox', '--enable-unsafe-extension-debugging',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
const cleanup = () => {
  try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (err) { /* ignore */ }
};
process.on('exit', cleanup);
process.on('SIGTERM', () => process.exit(143));

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  try { version = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (err) { await sleep(150); }
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
async function open(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  return { sessionId, targetId };
}
async function pageEval(tab, code) {
  const out = await send('Runtime.evaluate', { expression: '(async () => {' + code + '})()', awaitPromise: true, returnByValue: true }, tab.sessionId);
  if (out.exceptionDetails) throw new Error((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text);
  return out.result.value;
}
async function importFile(tab, file) {
  const doc = await send('DOM.getDocument', { depth: 0, pierce: true }, tab.sessionId);
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' }, tab.sessionId);
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] }, tab.sessionId);
  await pageEval(tab, "document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");
}
async function seedConfig(extId, patch) {
  const tab = await open('chrome-extension://' + extId + '/options/index.html');
  await until(() => pageEval(tab, "return !!document.getElementById('save')"), 15000);
  // 等首次运行的默认配置写完，再覆盖成测试配置（见 HANDOFF §7.1e）
  await until(() => pageEval(tab, 'return chrome.storage.local.get("config").then((r) => !!r.config)'), 15000);
  await pageEval(tab, 'return import("/lib/config.js").then((m) => m.saveConfig(' + JSON.stringify(patch) + ')).then(() => true)');
  await send('Target.closeTarget', { targetId: tab.targetId });
}
async function openReader(extId) {
  const tab = await open('chrome-extension://' + extId + '/reader/index.html');
  await until(() => pageEval(tab, "return !!document.querySelector('.empty-library, .book-card')"), 20000);
  await send('Page.bringToFront', {}, tab.sessionId).catch(() => {});
  return tab;
}
const pageNotice = (tab, n) => pageEval(tab, 'const b=document.querySelector(\'.pdf-page[data-page="' + n + '"] .pdf-ocr-notice\'); return b ? { status: b.dataset.ocrStatus, text: b.textContent } : null;');
const pageOcrText = (tab, n) => pageEval(tab, 'const p=document.querySelector(\'.pdf-page[data-page="' + n + '"] .pdf-blocks[data-ocr="1"]\'); return p ? p.textContent : "";');

const fakeApi = {
  currentProvider: '__custom__', customProviders: [{ id: '__custom__', name: 'Fake' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'sk-test', model: 'fake' } },
  targetLang: 'zh-CN', mode: 'dual', thinkingMode: 'off'
};

const { id: idA } = await send('Extensions.loadUnpacked', { path: extA });
const { id: idB } = await send('Extensions.loadUnpacked', { path: extB });
writeHostManifest([idA, idB]);
console.log('A=' + idA + ' B=' + idB + ' work=' + work);

// ================= 阶段 A：未授权 =================
console.log('\n[A] 可选权限未授予');
{
  const opt = await open('chrome-extension://' + idA + '/options/index.html');
  const banner = await until(() => pageEval(opt, "const b=document.getElementById('ocrStatus'); return b && !b.hidden && b.dataset.ocrStatus ? { s: b.dataset.ocrStatus, t: document.getElementById('ocrStatusTitle').textContent, d: document.getElementById('ocrStatusDetail').textContent } : null"), 15000);
  check('设置页显示 OCR 区块与导航', await pageEval(opt, "return !document.getElementById('sec-ocr').hidden && !document.getElementById('navOcr').hidden"));
  check('自动选择 + 未授权 → 未配置OCR', banner && banner.s === 'not_configured' && banner.t === '未配置OCR', JSON.stringify(banner));
  check('详情说明需要授权', banner && /需要授权/.test(banner.d));
  check('显示「授权连接」按钮', await pageEval(opt, "return !document.getElementById('ocrGrant').hidden"));
  check('不显示「安装说明」（缺的是授权，不是组件）', await pageEval(opt, "return document.getElementById('ocrInstall').hidden"));
  await pageEval(opt, "const s=document.getElementById('ocrEngine'); s.value='off'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  check('切到关闭：显示 OCR 已关闭', await until(() => pageEval(opt, "return document.getElementById('ocrStatus').dataset.ocrStatus === 'disabled' && document.getElementById('ocrStatusTitle').textContent === 'OCR 已关闭'"), 3000));
  check('关闭时不显示授权按钮', await pageEval(opt, "return document.getElementById('ocrGrant').hidden"));
  await pageEval(opt, "const s=document.getElementById('ocrEngine'); s.value='auto'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  await pageEval(opt, "document.getElementById('uiLang').value='en'; document.getElementById('uiLang').dispatchEvent(new Event('change',{bubbles:true})); return true;");
  const en = await until(() => pageEval(opt, "return document.getElementById('ocrStatusTitle').textContent"), 3000);
  check('英文界面状态文案', en === 'No OCR configured', en);
  await send('Target.closeTarget', { targetId: opt.targetId });

  await seedConfig(idA, fakeApi);
  const reader = await openReader(idA);
  await importFile(reader, SCAN_PDF);
  const notice = await until(() => pageNotice(reader, 1), 30000);
  check('阅读器扫描页显示用户指定提示', notice && notice.status === 'not_configured' && notice.text.startsWith('未配置OCR，请前往设置配置'), JSON.stringify(notice));
  const before = (await send('Target.getTargets')).targetInfos.filter((t) => t.url.includes(idA + '/options/index.html#sec-ocr')).length;
  await pageEval(reader, 'document.querySelector(\'.pdf-page[data-page="1"] .pdf-ocr-action\').click(); return true;');
  const opened = await until(async () => (await send('Target.getTargets')).targetInfos.filter((t) => t.url.includes(idA + '/options/index.html#sec-ocr')).length > before, 8000);
  check('「前往设置」打开设置页 OCR 区块', !!opened);
  check('未授权时没有启动本地宿主', hostMessages().length === 0, hostMessages().length + ' 条');
  check('零文本页没有发翻译请求', api.requests === 0, api.requests + ' 次');
  await send('Target.closeTarget', { targetId: reader.targetId });
}

// ================= 阶段 B：参考宿主 =================
console.log('\n[B] 参考宿主');
fs.writeFileSync(modeFile, 'ready');
{
  const opt = await open('chrome-extension://' + idB + '/options/index.html');
  const ready = await until(() => pageEval(opt, "const b=document.getElementById('ocrStatus'); return b && b.dataset.ocrStatus === 'ready' ? document.getElementById('ocrStatusTitle').textContent : ''"), 20000);
  check('设置页：自动选择就绪并说明使用的后端', /^自动选择：系统 OCR.*已就绪$/.test(ready || ''), ready);
  const info = await pageEval(opt, "return document.getElementById('ocrComponentInfo').textContent");
  check('设置页显示组件版本', /0\.0\.0-mock/.test(info), info);
  check('就绪时不显示授权 / 安装按钮', await pageEval(opt, "return document.getElementById('ocrGrant').hidden && document.getElementById('ocrInstall').hidden"));
  fs.writeFileSync(modeFile, 'system-only');
  await pageEval(opt, "document.getElementById('ocrRecheck').click(); return true;");
  await sleep(600);
  await pageEval(opt, "const s=document.getElementById('ocrEngine'); s.value='paddle'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  const paddle = await until(() => pageEval(opt, "const b=document.getElementById('ocrStatus'); return b.dataset.ocrStatus === 'engine_missing' ? document.getElementById('ocrStatusTitle').textContent : ''"), 8000);
  check('选 PaddleOCR 且引擎包未装 → 所选引擎尚未安装', paddle === '所选引擎尚未安装', paddle);
  check('缺引擎包时显示「安装说明」', await pageEval(opt, "return !document.getElementById('ocrInstall').hidden"));
  await pageEval(opt, "document.getElementById('ocrInstall').click(); return true;");
  const dialog = await until(() => pageEval(opt, "const d=document.getElementById('ocrInstallDialog'); return d.open ? { title: document.getElementById('ocrInstallTitle').textContent, platform: document.getElementById('ocrInstallPlatform').textContent, note: document.getElementById('ocrInstallNote').textContent, disabled: document.getElementById('ocrInstallDownload').disabled } : null"), 3000);
  check('安装说明弹窗：PaddleOCR、当前平台、未发布时禁用下载', dialog && dialog.title === '安装本地 PaddleOCR' && !!dialog.platform && dialog.disabled && /尚未发布/.test(dialog.note), JSON.stringify(dialog));
  await pageEval(opt, "document.getElementById('ocrInstallDialog').close('cancel'); return true;");
  // 保存选择，验证随设置页「保存」写入配置
  await until(() => pageEval(opt, "return !document.getElementById('save').disabled"), 5000);
  await pageEval(opt, "document.getElementById('save').click(); return true;");
  const saved = await until(() => pageEval(opt, 'return chrome.storage.local.get("config").then((r) => r.config && r.config.ocrEngine === "paddle")'), 5000);
  check('OCR 选择随「保存」写入配置', !!saved);
  await pageEval(opt, "const s=document.getElementById('ocrEngine'); s.value='auto'; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  await until(() => pageEval(opt, "return !document.getElementById('save').disabled"), 5000);
  await pageEval(opt, "document.getElementById('save').click(); return true;");
  check('切回自动选择并保存', !!(await until(() => pageEval(opt, 'return chrome.storage.local.get("config").then((r) => r.config && r.config.ocrEngine === "auto")'), 5000)));
  await send('Target.closeTarget', { targetId: opt.targetId });
  fs.writeFileSync(modeFile, 'ready');

  await seedConfig(idB, fakeApi);
  const reader = await openReader(idB);
  const recognizedBefore = hostMessages('recognize').length;
  await importFile(reader, SCAN_PDF);
  const text1 = await until(() => pageOcrText(reader, 1), 30000);
  check('第 1 页 OCR 文字进入文本块', /模拟识别第一行/.test(text1 || ''), (text1 || '').slice(0, 40));
  if (!text1) {
    console.log('    诊断 status=', JSON.stringify(await pageEval(reader, 'return chrome.runtime.sendMessage({ type: "ocr:status" })')).slice(0, 400));
    console.log('    诊断 page1=', await pageEval(reader, 'const p=document.querySelector(\'.pdf-page[data-page="1"]\'); return p ? p.innerText.slice(0, 200) : "none"'));
    console.log('    诊断 host=', JSON.stringify(hostMessages().slice(-5)));
  }
  const label = await pageEval(reader, 'return document.querySelector(\'.pdf-page[data-page="1"] .pdf-page-label\').textContent');
  check('页标签提示 OCR 文字可能有误', /OCR 识别/.test(label), label);
  check('没有残留「没有可提取的文字」提示', await pageEval(reader, 'return !document.querySelector(\'.pdf-page[data-page="1"] .pdf-empty-text\')'));
  await pageEval(reader, 'document.querySelector(\'.pdf-page[data-page="2"]\').scrollIntoView(); return true;');
  const text2 = await until(() => pageOcrText(reader, 2), 30000);
  check('滚到第 2 页后识别第 2 页', /模拟识别第一行/.test(text2 || ''));
  const recognized = hostMessages('recognize').length - recognizedBefore;
  check('两页各识别一次', recognized === 2, recognized + ' 次');

  // 搜索使用 OCR 文字
  await pageEval(reader, "document.getElementById('pdfSearchInput').value='模拟识别'; document.getElementById('pdfSearchGo').click(); return true;");
  const hitsCount = await until(() => pageEval(reader, "return document.querySelectorAll('.pdf-search-hit').length"), 8000);
  check('全文搜索能搜到 OCR 文字', hitsCount >= 2, hitsCount + ' 处');

  // 流式双语：OCR 文字显示在流式视图并送翻（PDF 译文只在流式视图显示）
  await pageEval(reader, "window.scrollTo(0, 0); const m=document.getElementById('modeSelect'); m.value='flow-bilingual'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  const flow = await until(() => pageEval(reader, "const b=document.querySelector('#pdfFlow .pdf-flow-page[data-page=\"1\"] .pdf-block .pdf-src'); return b ? b.textContent : ''"), 10000);
  check('流式视图显示 OCR 文字', /模拟识别第一行/.test(flow || ''), (flow || '').slice(0, 30));
  const trans = await until(() => pageEval(reader, "const t=document.querySelector('#pdfFlow .pdf-flow-page[data-page=\"1\"] .pdf-trans'); return t ? t.textContent : ''"), 20000);
  check('OCR 文字送翻并显示译文', /^译:OCR/.test(trans || ''), trans);
  check('送翻内容是识别出的文字', api.texts.some((t) => /模拟识别第一行/.test(t)), api.texts.slice(0, 2).join(' | '));
  check('流式视图没有重复识别', hostMessages('recognize').length - recognizedBefore === 2);
  await pageEval(reader, "const m=document.getElementById('modeSelect'); m.value='pdf-original'; m.dispatchEvent(new Event('change',{bubbles:true})); return true;");
  await sleep(800);

  // 重新打开：OCR 结果从本地缓存读取，不再调用宿主
  const beforeReopen = hostMessages('recognize').length;
  await send('Page.reload', {}, reader.sessionId);
  await until(() => pageEval(reader, 'return !!document.querySelector(".book-card .reader-button")'), 15000);
  await pageEval(reader, 'document.querySelector(".book-card .reader-button").click(); return true;');
  const cachedText = await until(() => pageOcrText(reader, 1), 20000);
  check('重开书后显示缓存的 OCR 文字', /模拟识别第一行/.test(cachedText || ''));
  await sleep(800);
  check('重开书不重复识别', hostMessages('recognize').length === beforeReopen, (hostMessages('recognize').length - beforeReopen) + ' 次');

  // 文字型 PDF 不触发 OCR
  const beforeText = hostMessages('recognize').length;
  await pageEval(reader, "document.getElementById('backToLibrary').click(); return true;");
  await until(() => pageEval(reader, "return !!document.querySelector('.book-card')"), 10000);
  await importFile(reader, TEXT_PDF);
  await until(() => pageEval(reader, "return document.querySelectorAll('.pdf-page .pdf-block').length"), 20000);
  await sleep(800);
  check('文字型 PDF 不调用 OCR', hostMessages('recognize').length === beforeText);

  // 取消：识别进行中关闭书，宿主收到 cancel，结果不写回
  fs.writeFileSync(modeFile, 'slow');
  await pageEval(reader, "document.getElementById('backToLibrary').click(); return true;");
  await until(() => pageEval(reader, "return !!document.querySelector('.book-card')"), 10000);
  // 换一份内容不同的副本，避开已有缓存
  const scanCopy = path.join(work, 'scan-copy.pdf');
  fs.writeFileSync(scanCopy, Buffer.concat([fs.readFileSync(SCAN_PDF), Buffer.from('\n%copy\n')]));
  const slowBefore = hostMessages('recognize').length;
  await importFile(reader, scanCopy);
  await until(() => hostMessages('recognize').length > slowBefore, 15000);
  await until(() => pageEval(reader, "return !!document.querySelector('.pdf-ocr-progress')"), 5000);
  check('识别中显示进度提示', await pageEval(reader, "return !!document.querySelector('.pdf-ocr-progress')"));
  await pageEval(reader, "document.getElementById('backToLibrary').click(); return true;");
  const cancelled = await until(() => hostMessages('cancel').length > 0, 5000);
  check('关闭书时向宿主发送取消', !!cancelled);
  await sleep(4500);
  check('取消后没有异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

  // 识别错误：引擎缺模型 → 页内提示，不送翻
  fs.writeFileSync(modeFile, 'ready');
  await seedConfig(idB, { ocrEngine: 'paddle' });
  fs.writeFileSync(modeFile, 'paddle-model-missing');
  // 组件状态变了（这里是模拟模型被删）：设置页「重新检测」刷新后台的检测缓存
  {
    const opt = await open('chrome-extension://' + idB + '/options/index.html');
    await until(() => pageEval(opt, "return !!document.getElementById('ocrRecheck')"), 10000);
    await pageEval(opt, "document.getElementById('ocrRecheck').click(); return true;");
    await until(() => pageEval(opt, "return document.getElementById('ocrStatus').dataset.ocrStatus === 'model_missing'"), 8000);
    await send('Target.closeTarget', { targetId: opt.targetId });
  }
  await send('Page.reload', {}, reader.sessionId);
  await until(() => pageEval(reader, "return document.querySelectorAll('.book-card .reader-button').length >= 1"), 15000);
  const scanCopy2 = path.join(work, 'scan-copy-2.pdf');
  fs.writeFileSync(scanCopy2, Buffer.concat([fs.readFileSync(SCAN_PDF), Buffer.from('\n%copy2\n')]));
  const apiBefore = api.requests;
  await importFile(reader, scanCopy2);
  // 服务缓存 30 秒内的检测结果：等过期或靠配置变化触发的重新检测
  const missing = await until(() => pageNotice(reader, 1), 40000);
  check('引擎缺模型：页内提示缺模型并引导去设置', missing && missing.status === 'model_missing' && /缺少模型/.test(missing.text), JSON.stringify(missing));
  check('缺模型时不送翻', api.requests === apiBefore);
  await send('Target.closeTarget', { targetId: reader.targetId });
  fs.writeFileSync(modeFile, 'ready');
  await seedConfig(idB, { ocrEngine: 'auto' });
}

// ================= 阶段 C：真实 macOS 连接器 =================
if (process.platform === 'darwin' && fs.existsSync(REAL_HOST)) {
  console.log('\n[C] 真实 macOS Vision 连接器');
  fs.writeFileSync(useReal, '1');
  // 让 mock 宿主收到下一条消息就退出：连接断开后，下一次检测经启动脚本连到真实连接器
  fs.writeFileSync(modeFile, 'exit');
  const opt = await open('chrome-extension://' + idB + '/options/index.html');
  await until(() => pageEval(opt, "return !!document.getElementById('ocrRecheck')"), 10000);
  // 第一次检测让 mock 宿主退出（报检测失败），之后再点「重新检测」才连到真实连接器
  const ready = await until(async () => {
    const got = await pageEval(opt, "const b=document.getElementById('ocrStatus'); return b && b.dataset.ocrStatus === 'ready' && /0\\.1\\./.test(document.getElementById('ocrComponentInfo').textContent) ? { t: document.getElementById('ocrStatusTitle').textContent, d: document.getElementById('ocrStatusDetail').textContent, i: document.getElementById('ocrComponentInfo').textContent } : null");
    if (!got) await pageEval(opt, "document.getElementById('ocrRecheck').click(); return true;");
    return got;
  }, 40000, 1500);
  check('设置页：macOS 文本识别就绪', ready && /macOS 文本识别/.test(ready.t), JSON.stringify(ready));
  if (!ready) {
    console.log('    诊断 banner=', JSON.stringify(await pageEval(opt, "const b=document.getElementById('ocrStatus'); return { s: b.dataset.ocrStatus, t: document.getElementById('ocrStatusTitle').textContent, i: document.getElementById('ocrComponentInfo').textContent }")));
    console.log('    诊断 status=', JSON.stringify(await pageEval(opt, 'return chrome.runtime.sendMessage({ type: "ocr:status", refresh: true })')).slice(0, 300));
    console.log('    诊断 host=', JSON.stringify(hostMessages().slice(-4)));
  }
  check('设置页列出实际可识别语言', ready && /中文/.test(ready.d), ready && ready.d);
  check('设置页显示真实组件版本', ready && /0\.1\.0/.test(ready.i), ready && ready.i);
  await send('Target.closeTarget', { targetId: opt.targetId });
  const reader = await openReader(idB);
  const scanCopy3 = path.join(work, 'scan-copy-3.pdf');
  fs.writeFileSync(scanCopy3, Buffer.concat([fs.readFileSync(SCAN_PDF), Buffer.from('\n%copy3\n')]));
  await importFile(reader, scanCopy3);
  const text = await until(() => pageOcrText(reader, 1), 60000);
  check('真实识别：标题', /凛狐扫描页识别测试/.test(text || ''), (text || '').slice(0, 60));
  check('真实识别：英文行', /Rimefox OCR sample page 2026/.test(text || ''));
  const blocks = await pageEval(reader, 'return Array.from(document.querySelectorAll(\'.pdf-page[data-page="1"] .pdf-block .pdf-src\')).map((b) => b.textContent)');
  console.log('    块：' + JSON.stringify(blocks));
  check('真实识别：标题单独成块', blocks[0] === '凛狐扫描页识别测试', blocks[0]);
  check('真实识别：中英文段落不混在一起', blocks.length >= 3 && !blocks.some((b) => /测试/.test(b) && /Rimefox/.test(b)), blocks.length + ' 块');
  await send('Target.closeTarget', { targetId: reader.targetId });
} else {
  console.log('\n[C] 跳过：需要 macOS 并先运行 native/ocr-host/macos/build.sh');
}

check('全程无未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
const passed = results.filter((r) => r.ok).length;
console.log('\n' + passed + ' / ' + results.length + ' 通过');
server.close();
ws.close();
process.exit(passed === results.length ? 0 : 1);
