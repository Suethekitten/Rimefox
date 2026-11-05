// 真实 Chrome + 假 API：会话 / 设备密钥、升级选择、401 暂停、20 标签广播与完整重启。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from '../lib/vendor/fflate.browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = process.env.RIMEFOX_EXTENSION || ROOT;
const BROWSER = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-session-e2e-'));
const profile = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const errors = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await sleep(100); }
  return null;
}
let requests = 0;
let holdNext = false;
const held = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/article')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang="en"><body><main><h1>Session test ' + req.url.replace(/[^a-z0-9]/gi, '') + '</h1><p>This article contains a unique paragraph for checking translation credentials and browser sessions. ' + req.url.replace(/[^a-z0-9]/gi, '') + '.</p></main></body></html>');
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"fake"}]}'); return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests += 1;
      if (holdNext) { holdNext = false; held.push(() => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid API key"}}'); }); return; }
      if (req.headers.authorization === 'Bearer mock-bad') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"invalid API key"}}'); return; }
      const body = JSON.parse(raw);
      const texts = JSON.parse(body.messages.at(-1).content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map(() => '这是用于会话密钥与浏览器回归验证的中文译文。')) }, finish_reason: 'stop' }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;
let untrustedRequests = 0;
const untrustedServer = http.createServer((req, res) => { untrustedRequests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"fake"}]}'); });
await new Promise((resolve) => untrustedServer.listen(0, '127.0.0.1', resolve));
const UNTRUSTED = 'http://127.0.0.1:' + untrustedServer.address().port;
let browser;
let ws;
let seq = 0;
let options;
let extId;
let contexts = new Map();
let versions = new Map();
const pending = new Map();
process.on('exit', () => { try { browser?.kill('SIGKILL'); } catch {} });
process.on('SIGTERM', () => process.exit(143));
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(sessionId, code, contextId) {
  const response = await send('Runtime.evaluate', { expression: '(() => {' + code + '})()', awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  return sessionId;
}
async function open(url) {
  const { targetId } = await send('Target.createTarget', { url });
  return { targetId, session: await attach(targetId) };
}
async function start() {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  browser = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const port = await until(() => fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  if (!port) throw new Error('Chrome did not start');
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  seq = 0; pending.clear(); contexts = new Map(); versions = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const job = pending.get(message.id); pending.delete(message.id);
      if (message.error) job.reject(new Error(JSON.stringify(message.error))); else job.resolve(message.result);
    }
    if (message.method === 'Runtime.executionContextCreated') {
      const list = contexts.get(message.sessionId) || [];
      list.push(message.params.context); contexts.set(message.sessionId, list);
    }
    if (message.method === 'ServiceWorker.workerVersionUpdated') for (const item of message.params.versions) versions.set(item.versionId, item);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, message.sessionId).catch(() => {});
  };
  const loaded = await send('Extensions.loadUnpacked', { path: EXTENSION });
  extId = loaded.id;
  console.log(version.Browser + ' · ' + extId + ' · ' + EXTENSION);
  options = (await open('chrome-extension://' + extId + '/options/index.html')).session;
  if (!await until(() => evaluate(options, 'return !!document.querySelector("#provider option") && !!document.getElementById("rememberKey") && document.getElementById("saveState").textContent.includes("所有更改已保存")'))) throw new Error('Options did not load');
  const debug = await evaluate(options, 'return chrome.runtime.sendMessage({type:"config:trustedGet"}).then(v=>({ok:v.ok,error:v.error}))');
  if (!debug.ok) throw new Error('Config initialization: ' + debug.error);
  await sleep(300);
}
async function close() {
  const done = new Promise((resolve) => browser.once('exit', resolve));
  send('Browser.close').catch(() => {});
  await Promise.race([done, sleep(5000)]);
  if (browser.exitCode === null) browser.kill('SIGTERM');
  try { ws.close(); } catch {}
}
const cfg = async () => (await evaluate(options, 'return chrome.runtime.sendMessage({type:"config:trustedGet"})')).config;
const save = (patch) => evaluate(options, 'return import("/lib/config.js").then(m=>m.saveConfig(' + JSON.stringify(patch) + '))');
async function keyForm(key, remember = false) {
  await evaluate(options, 'const values={baseUrl:' + JSON.stringify(ORIGIN + '/v1') + ',apiKey:' + JSON.stringify(key) + ',model:"fake"}; for(const [id,value] of Object.entries(values)){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event("input",{bubbles:true}));} const r=document.getElementById("rememberKey");r.checked=' + remember + ';r.dispatchEvent(new Event("change",{bubbles:true}));return true;');
  if (!await until(() => evaluate(options, 'return !document.getElementById("save").disabled'))) throw new Error('Form did not become dirty');
  await evaluate(options, 'document.getElementById("save").click();return true;');
  if (!await until(async () => { const c = await cfg(); return c.providerConfig[c.currentProvider]?.apiKey === key && c.providerConfig[c.currentProvider]?.keyStorage === (remember ? 'local' : 'session'); })) throw new Error('Key form did not save');
  await sleep(300);
}
async function world(session) {
  return until(async () => {
    for (const context of contexts.get(session) || []) {
      if (context.auxData?.isDefault) continue;
      try { if (await evaluate(session, 'return !!window.__DT?.state?.config', context.id)) return context.id; } catch {}
    }
    return null;
  });
}
async function translation(text) {
  return evaluate(options, 'return chrome.runtime.sendMessage({type:"translate",target:"zh-CN",noCache:true,texts:[' + JSON.stringify(text) + ']})');
}

try {
  await start();
  if (process.argv.includes('--reload-only')) {
    await keyForm('mock-reload');
  } else {
  await keyForm('mock-session');
  await evaluate(options, 'const e=document.getElementById("baseUrl");e.value=' + JSON.stringify(UNTRUSTED + '/v1') + ';e.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("refreshModels").click();return true;');
  await sleep(1200);
  check('QA F9：新地址未保存时自动和手动模型刷新均不发送旧 Key', untrustedRequests === 0 && await evaluate(options, 'return document.getElementById("modelHint").textContent.includes("接口地址已更改")'));
  await evaluate(options, 'const e=document.getElementById("baseUrl");e.value=' + JSON.stringify(ORIGIN + '/v1') + ';e.dispatchEvent(new Event("input",{bubbles:true}));return true;');
  let c = await cfg();
  check('新 Key 默认 session，设备记忆开关默认关闭', c.providerConfig[c.currentProvider].keyStorage === 'session' && !(await evaluate(options, 'return document.getElementById("rememberKey").checked')));
  check('浏览器 local 数据不含会话 Key', !(await evaluate(options, 'return chrome.storage.local.get(null).then(v=>JSON.stringify(v))')).includes('mock-session'));
  const publicResult = await evaluate(options, 'return chrome.runtime.sendMessage({type:"config:get"})');
  check('公开配置只有 hasKey 与修订号、不含 Key', publicResult.config.hasKey && !JSON.stringify(publicResult).includes('mock-session'));
  const secondOptions = await open('chrome-extension://' + extId + '/options/index.html');
  // saveState 的默认 HTML 已写着「已保存」；必须等真实配置填入，不能在 init 之前输入。
  if (!await until(() => evaluate(secondOptions.session, 'return document.getElementById("apiKey")?.value === "mock-session" && document.getElementById("model")?.value === "fake" && document.getElementById("saveState")?.textContent.includes("所有更改已保存")'))) throw new Error('Second options did not initialize');
  await evaluate(options, 'const e=document.getElementById("customPrompt");e.value="Use clear wording.";e.dispatchEvent(new Event("input",{bubbles:true}));return true;');
  await evaluate(secondOptions.session, 'const e=document.getElementById("model");e.value="fake-two";e.dispatchEvent(new Event("input",{bubbles:true}));return true;');
  if (!await until(() => evaluate(options, 'return !document.getElementById("save").disabled'))) throw new Error('First form did not become dirty');
  if (!await until(() => evaluate(secondOptions.session, 'return !document.getElementById("save").disabled'))) throw new Error('Second form did not become dirty');
  await Promise.all([evaluate(options, 'document.getElementById("save").click();return true;'), evaluate(secondOptions.session, 'document.getElementById("save").click();return true;')]);
  await until(async () => { const value = await cfg(); return value.customPrompt === 'Use clear wording.' && value.providerConfig.deepseek.model === 'fake-two'; });
  c = await cfg();
  check('两个设置窗口并发保存不覆盖彼此的独立修改', c.customPrompt === 'Use clear wording.' && c.providerConfig.deepseek.model === 'fake-two', JSON.stringify({ prompt: c.customPrompt, model: c.providerConfig.deepseek.model }));
  await send('Target.closeTarget', { targetId: secondOptions.targetId });
  await save({ customPrompt: '', providerConfig: { deepseek: { model: 'fake' } } });
  await save({ concurrency: 1, translateOnLoad: false });

  const pages = [];
  for (let i = 0; i < 20; i += 1) {
    const page = await open(ORIGIN + '/article?id=' + i);
    page.context = await world(page.session);
    if (!page.context) throw new Error('Content script not available');
    await evaluate(page.session, 'window.__configReads=0;const original=window.__DT.send;window.__DT.send=function(m,t){if(m.type==="config:get")window.__configReads++;return original(m,t)};return true;', page.context);
    pages.push(page);
  }
  const denied = await evaluate(pages[0].session, 'return chrome.runtime.sendMessage({type:"config:trustedGet"})', pages[0].context);
  check('真实网页内容脚本不能读取可信配置 / Key', denied.ok === false && !JSON.stringify(denied).includes('mock-session'));
  await sleep(400);
  for (const page of pages) await evaluate(page.session, 'window.__configReads=0;return true;', page.context);
  const beforeBroadcast = requests;
  await Promise.all([save({ uiTheme: 'dark' }), save({ disableShadow: true }), save({ reduceTransparency: true })]);
  await until(async () => (await Promise.all(pages.map((page) => evaluate(page.session, 'return window.__configReads', page.context)))).every((n) => n >= 1));
  const reads = await Promise.all(pages.map((page) => evaluate(page.session, 'return window.__configReads', page.context)));
  check('20 标签突发保存合并广播，每页最多重拉一次且没有翻译请求', reads.every((n) => n === 1) && requests === beforeBroadcast, JSON.stringify(reads));
  const fingerprint = (await evaluate(options, 'return chrome.runtime.sendMessage({type:"config:get"})')).fingerprint;
  await evaluate(options, 'return chrome.tabs.query({}).then(tabs=>Promise.all(tabs.filter(t=>t.url?.startsWith(' + JSON.stringify(ORIGIN) + ')).map(t=>chrome.tabs.sendMessage(t.id,{type:"dt:configChanged",fingerprint:' + JSON.stringify(fingerprint) + '}).catch(()=>{}))))');
  await sleep(300);
  check('相同指纹通知不再重拉配置', (await Promise.all(pages.map((page) => evaluate(page.session, 'return window.__configReads', page.context)))).every((n, i) => n === reads[i]));

  await keyForm('mock-bad');
  const before401 = requests;
  const failed = await translation('A rejected authentication request.');
  check('真实 API 401 写入全局暂停', failed.errorCode === 'auth_paused' && (await cfg()).authPaused && requests === before401 + 1);
  await until(() => evaluate(options, 'return document.getElementById("authStatus").textContent.includes("暂停")'));
  const popup = await open('chrome-extension://' + extId + '/popup/index.html');
  await until(() => evaluate(popup.session, 'return document.getElementById("statusTitle")?.textContent.includes("暂停")'));
  const settingsStatus = await evaluate(options, 'return document.getElementById("authStatus").textContent');
  const popupStatus = await evaluate(popup.session, 'return document.getElementById("statusTitle").textContent');
  check('设置页与弹窗显示暂停状态', settingsStatus.includes('暂停') && popupStatus.includes('暂停'), JSON.stringify({ settingsStatus, popupStatus }));
  const beforeBlocked = requests;
  await until(async () => (await Promise.all(pages.map((page) => evaluate(page.session, 'return !!window.__DT.state.config.authPaused', page.context)))).every(Boolean));
  for (const page of pages) await evaluate(page.session, 'window.__translationMessages=0;const old=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=function(m,...rest){if(m.type==="translate")window.__translationMessages++;return old(m,...rest)};return true;', page.context);
  await Promise.all(pages.map((page) => evaluate(page.session, 'return window.__DT.send({type:"translate",target:"zh-CN",texts:["Blocked by frontend"]})', page.context)));
  await translation('Blocked at background entry.');
  const webTest = await evaluate(pages[0].session, 'return chrome.runtime.sendMessage({type:"test"})', pages[0].context);
  await sleep(300);
  const outgoing = await Promise.all(pages.map((page) => evaluate(page.session, 'return window.__translationMessages', page.context)));
  check('20 标签前端与后台入口暂停后零新增 HTTP', requests === beforeBlocked && outgoing.every((n) => n === 0) && webTest.ok === false);

  // 阅读器同样使用全局暂停，原文阅读仍可用。
  const reader = await open('chrome-extension://' + extId + '/reader/index.html');
  await until(() => evaluate(reader.session, 'return !!document.querySelector(".empty-library, .book-card")'));
  let doc = await send('DOM.getDocument', { depth: 0 }, reader.session);
  let input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' }, reader.session);
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path.join(ROOT, 'reader/pdf-samples/reader.pdf')] }, reader.session);
  await send('Page.bringToFront', {}, reader.session);
  await evaluate(reader.session, 'document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
  await until(() => evaluate(reader.session, 'return document.querySelectorAll(".pdf-page").length > 0'));
  await evaluate(reader.session, 'const s=document.getElementById("modeSelect");s.value="flow-bilingual";s.dispatchEvent(new Event("change",{bubbles:true}));return true;');
  await sleep(500);
  check('PDF 暂停期间可读原文、翻译入口禁用且没有请求', requests === beforeBlocked && await evaluate(reader.session, 'return document.querySelectorAll(".pdf-page").length > 0 && document.getElementById("translateChapter").disabled'));
  const epub = path.join(WORK, 'session.epub');
  fs.writeFileSync(epub, Buffer.from(zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    'book.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Session Book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'),
    'chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Session Chapter</h1><p>A paragraph that must not be translated while authentication is paused.</p></body></html>')
  })));
  await evaluate(reader.session, 'document.getElementById("backToLibrary").click();return true;');
  await sleep(150);
  doc = await send('DOM.getDocument', { depth: 0 }, reader.session);
  input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' }, reader.session);
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [epub] }, reader.session);
  await evaluate(reader.session, 'document.getElementById("fileInput").dispatchEvent(new Event("change",{bubbles:true}));return true;');
  await until(() => evaluate(reader.session, 'return Array.from(document.querySelectorAll(".book-card")).some(n=>n.textContent.includes("Session Book"))'));
  await evaluate(reader.session, 'Array.from(document.querySelectorAll(".book-card")).find(n=>n.textContent.includes("Session Book")).querySelector(".reader-button").click();return true;');
  await until(() => evaluate(reader.session, 'return document.getElementById("bookContent").textContent.includes("must not be translated")'));
  await evaluate(reader.session, 'const s=document.getElementById("modeSelect");s.value="bilingual";s.dispatchEvent(new Event("change",{bubbles:true}));return true;');
  await sleep(400);
  check('EPUB 暂停期间可读原文、没有翻译 HTTP', requests === beforeBlocked && await evaluate(reader.session, 'return document.getElementById("translateChapter").disabled'));
  await send('Target.closeTarget', { targetId: reader.targetId });

  await keyForm('mock-recovered');
  check('更正密钥后恢复翻译', !(await cfg()).authPaused && (await translation('Recovered translation request.')).ok);
  holdNext = true;
  await evaluate(options, 'window.__oldAuth=chrome.runtime.sendMessage({type:"translate",noCache:true,target:"zh-CN",texts:["Old credential request"]});return true;');
  if (!await until(() => held.length > 0)) throw new Error('Expected a held request');
  await keyForm('mock-newer');
  for (const release of held.splice(0)) release();
  const late = await evaluate(options, 'return window.__oldAuth');
  check('旧密钥的晚归 401 不会暂停新配置', late.errorCode === 'credentials_changed' && !(await cfg()).authPaused);

  await send('ServiceWorker.enable', {}, options);
  const worker = await until(() => [...versions.values()].find((v) => v.scriptURL?.startsWith('chrome-extension://' + extId + '/') && v.runningStatus === 'running'));
  if (!worker) throw new Error('Service worker version not found');
  await send('ServiceWorker.stopWorker', { versionId: worker.versionId }, options);
  await until(() => versions.get(worker.versionId)?.runningStatus === 'stopped');
  check('单独停止 / 唤醒 service worker 后会话 Key 仍保留', (await cfg()).providerConfig.deepseek.apiKey === 'mock-newer');
  // 暂停状态也必须跨 worker 重启。
  await keyForm('mock-bad'); await translation('Pause before worker restart.');
  const runningWorker = await until(() => [...versions.values()].find((v) => v.scriptURL?.startsWith('chrome-extension://' + extId + '/') && v.runningStatus === 'running'));
  await send('ServiceWorker.stopWorker', { versionId: runningWorker.versionId }, options);
  await sleep(100);
  const pausedCount = requests;
  check('worker 重启后全局暂停仍在，后续翻译零 HTTP', (await cfg()).authPaused && (await translation('Still blocked after worker restart.')).errorCode === 'auth_paused' && requests === pausedCount);

  await keyForm('mock-session-restart');
  await close(); await start();
  c = await cfg();
  check('完整重启浏览器后会话 Key 消失，界面提示重新配置', !c.providerConfig.deepseek.apiKey && !(await evaluate(options, 'return document.getElementById("apiKey").value')));
  await keyForm('mock-device', true);
  await close(); await start();
  c = await cfg();
  check('设备记忆 Key 在完整浏览器重启后保留', c.providerConfig.deepseek.apiKey === 'mock-device' && await evaluate(options, 'return document.getElementById("rememberKey").checked'));
  check('设备 Key 只在扩展源凭据库中、local 中不存在', !(await evaluate(options, 'return chrome.storage.local.get(null).then(v=>JSON.stringify(v))')).includes('mock-device') && await evaluate(options, 'return new Promise((resolve,reject)=>{const r=indexedDB.open("rimefox-credentials",1);r.onsuccess=()=>{const db=r.result;const q=db.transaction("vault").objectStore("vault").get("device");q.onsuccess=()=>{db.close();resolve(JSON.stringify(q.result).includes("mock-device"))};q.onerror=()=>reject(q.error)};r.onerror=()=>reject(r.error)})'));
  const exposurePage = await open(ORIGIN + '/article?startup-window');
  const exposureWorld = await world(exposurePage.session);
  // Deliberately simulate the pre-restriction window in an isolated disposable profile.
  await evaluate(options, 'return chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_AND_UNTRUSTED_CONTEXTS"})');
  const exposure = await evaluate(exposurePage.session, 'return Promise.all([chrome.storage.local.get(null),indexedDB.databases()]).then(([local,dbs])=>({leaked:JSON.stringify(local).includes("mock-device"),vault:dbs.some(d=>d.name==="rimefox-credentials")}))', exposureWorld);
  await evaluate(options, 'return chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})');
  check('QA F1：即使模拟启动前 local 可读，网页也拿不到设备 Key 或扩展源数据库', !exposure.leaked && !exposure.vault);
  await keyForm('mock-device', false);
  check('取消设备记忆后 local 中清除 Key', !(await evaluate(options, 'return chrome.storage.local.get(null).then(v=>JSON.stringify(v))')).includes('mock-device'));
  await close(); await start();
  check('改回 session 后再次完整重启不恢复旧 Key', !(await cfg()).providerConfig.deepseek.apiKey);

  const legacy = { _v: 8, currentProvider: 'deepseek', providerConfig: { deepseek: { engine: 'openai', baseUrl: ORIGIN + '/v1', model: 'fake', apiKey: 'mock-legacy' } } };
  await evaluate(options, 'return chrome.storage.local.set({config:' + JSON.stringify(legacy) + ',config_backup_v3:' + JSON.stringify(legacy) + '})');
  await send('Page.reload', {}, options);
  await until(() => evaluate(options, 'return document.getElementById("keyMigration") && !document.getElementById("keyMigration").hidden'));
  check('旧版本 Key 保持设备记忆并显示一次迁移选择', (await cfg()).providerConfig.deepseek.apiKey === 'mock-legacy' && (await cfg()).keyMigrationPending);
  await evaluate(options, 'document.getElementById("migrateSession").click();return true;');
  await until(async () => !(await cfg()).keyMigrationPending);
  check('确认迁移后当前配置与旧备份都不留 Key', (await cfg()).providerConfig.deepseek.keyStorage === 'session' && !(await evaluate(options, 'return chrome.storage.local.get(null).then(v=>JSON.stringify(v))')).includes('mock-legacy'));
  await send('Page.reload', {}, options);
  await until(() => evaluate(options, 'return document.getElementById("apiKey")?.value === "mock-legacy"'));
  check('迁移选择不重复出现，Key 在本次会话可用', !(await cfg()).keyMigrationPending && await evaluate(options, 'return document.getElementById("keyMigration").hidden'));
  await save({ targetLang: 'fr' });
  await evaluate(options, 'document.getElementById("restoreMigration").click();return true;');
  const recovered = await until(async () => { const c=await cfg(); return c.targetLang === 'zh-CN' && c.providerConfig.deepseek.apiKey === 'mock-legacy'; });
  check('设置页实际恢复升级前设置，同一接口保留当前 Key', !!recovered);
  }
  if (process.env.RIMEFOX_TEST_BROWSER === 'edge') {
    // Edge's manager UI differs; exercise the same runtime lifecycle without Chrome selectors.
    await evaluate(options, 'setTimeout(()=>chrome.runtime.reload(),0);return true;');
  } else {
  // 使用扩展管理页真实的开发者模式 / 重载控件；CDP 临时加载不等于已启用开发者模式。
  const manager = await open('chrome://extensions/');
  const allElements = 'function all(root){const out=[];for(const e of root.querySelectorAll("*")){out.push(e);if(e.shadowRoot)out.push(...all(e.shadowRoot));}return out;}';
  if (!await until(() => evaluate(manager.session, allElements + 'return all(document).some(e=>e.localName==="extensions-item" && e.id===' + JSON.stringify(extId) + ')'))) throw new Error('Extension card unavailable');
  const controls = await evaluate(manager.session, allElements + 'return all(document).filter(e=>/devmode|reload/i.test(e.id)).map(e=>({tag:e.localName,id:e.id,checked:e.checked,title:e.title}));');
  console.log('Extension reload controls', controls);
  await evaluate(manager.session, allElements + 'const toggle=all(document).find(e=>e.id==="devMode" && e.localName==="cr-toggle");if(toggle && !toggle.checked)toggle.click();return true;');
  await sleep(200);
  const clicked = await evaluate(manager.session, allElements + 'const card=all(document).find(e=>e.localName==="extensions-item" && e.id===' + JSON.stringify(extId) + ');const button=card && all(card.shadowRoot).find(e=>/reload/i.test(e.id) && /button/.test(e.localName));if(!button || !button.getBoundingClientRect().width)return false;button.click();return true;');
  if (!clicked) throw new Error('Visible extension reload control unavailable');
  }
  await sleep(600);
  options = (await open('chrome-extension://' + extId + '/options/index.html')).session;
  if (!await until(() => evaluate(options, 'return !!chrome.runtime?.id && document.getElementById("saveState")?.textContent.includes("所有更改已保存")'), 5000)) {
    console.log('Reload diagnostic', await evaluate(options, 'return {url:location.href,title:document.title,body:document.body?.innerText.slice(0,400),runtime:!!globalThis.chrome?.runtime}'));
    throw new Error('Reloaded options did not initialize');
  }
  check('重新加载扩展后可打开新入口，并提示重新填写会话 Key', !(await cfg()).providerConfig.deepseek.apiKey && await evaluate(options, 'return !!document.getElementById("rememberKey") && !document.getElementById("apiKey").value'));
  check('扩展页面与内容脚本没有未捕获异常', errors.length === 0, errors.join(' | '));
} finally {
  try { await close(); } catch {}
  server.close();
  untrustedServer.close();
  fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify({ results, errors }, null, 2));
}
const failed = results.filter((item) => !item.ok).length;
console.log('\n' + (results.length - failed) + ' / ' + results.length + ' 通过');
console.log('结果：' + path.join(WORK, 'result.json'));
process.exit(failed ? 1 : 0);
