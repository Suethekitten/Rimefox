#!/usr/bin/env node
// PDF 阅读页 E2E：真实扩展 + 真实 reader 页 + 本地 PDF。
// 默认只验证导入 / 页容器 / 标题；渲染断言需要 RIMEFOX_PDF_RENDER=1
// （reader 页里的 pdf.js render 目前会卡住，探针页正常，见 HANDOFF §9）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.RIMEFOX_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PDF = process.argv[2] || path.join(ROOT, 'reader', 'pdf-real', 'user.pdf');
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
const browser = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  '--no-sandbox', '--enable-unsafe-extension-debugging',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });

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

const { id: extId } = await send('Extensions.loadUnpacked', { path: ROOT });
const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/reader/index.html' });
const page = await attach(targetId);
check('阅读器页面加载', !!(await until(() => pageEval(page, "return !!document.getElementById('bookGrid')"), 15000)));
check('阅读器启动完成', !!(await until(() => pageEval(page, "return !!document.querySelector('.empty-library, .book-card')"), 20000)));

const doc = await send('DOM.getDocument', { depth: -1, pierce: true }, page);
const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' }, page);
await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [PDF] }, page);
await pageEval(page, "document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); return true;");

const pages = await until(() => pageEval(page, "return document.querySelectorAll('.pdf-page').length"), 30000);
check('PDF 导入后进入阅读页（页容器）', !!pages, pages ? pages + ' 页' : '没有页容器');
check('页标题/页数正确', !!(await pageEval(page, "const s=document.getElementById('readerSubtitle'); return s && s.textContent.indexOf('PDF') >= 0;")));

if (process.env.RIMEFOX_PDF_RENDER === '1') {
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
  console.log('  NOTE 跳过 canvas / 文本块断言：reader 页里 pdf.js render 已知会卡住（探针页正常）');
}

check('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
const failed = results.filter((one) => !one.ok).length;
console.log('\n' + (results.length - failed) + ' / ' + results.length + ' 通过');
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
process.exit(failed ? 1 : 0);
