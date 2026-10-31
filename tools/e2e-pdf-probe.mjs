#!/usr/bin/env node
// PDF 探针运行器：加载工作树扩展，在真实扩展页里跑 pdf.js，读取 window.__probe。
// 用法：node tools/e2e-pdf-probe.mjs [chromePath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((one) => !one.startsWith('--'));
const LEGACY = process.argv.includes('--legacy-load'); // Chrome <126 没有 Extensions.loadUnpacked
const CHROME = args[0] || process.env.RIMEFOX_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 20200 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-pdf-probe-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--enable-unsafe-extension-debugging',
  ...(LEGACY ? ['--load-extension=' + ROOT, '--disable-extensions-except=' + ROOT] : []),
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
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}
async function until(fn, ms = 30000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (err) { /* wait */ }
    await sleep(step);
  }
  return null;
}

let extId = '';
if (!LEGACY) {
  ({ id: extId } = await send('Extensions.loadUnpacked', { path: ROOT }));
} else {
  // Chrome <126 没有 Extensions.loadUnpacked：用 --load-extension 启动后，
  // 从 service worker 的 URL 里取扩展 ID（114 实测可用，启动约 2–4 秒）。
  const untilExt = Date.now() + 20000;
  while (Date.now() < untilExt && !extId) {
    const { targetInfos } = await send('Target.getTargets');
    const hit = targetInfos.find((one) => one.type === 'service_worker' && one.url.startsWith('chrome-extension://'));
    if (hit) extId = new URL(hit.url).hostname;
    else await sleep(200);
  }
  if (!extId) throw new Error('extension id not found');
}
console.log('extension', extId);

// 扩展刚加载时第一次 createTarget 会撞上启动竞态：先用一页热身，不计入结果。
{
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/reader/pdf-probe.html?sample=scan' });
  const session = await attach(targetId);
  await until(async () => {
    const out = await send('Runtime.evaluate', { expression: 'window.__probe', returnByValue: true }, session);
    const value = out.result && out.result.value;
    return value && (value.ok || value.error) ? value : null;
  }, 30000);
  await send('Target.closeTarget', { targetId });
}
const cases = [
  { sample: 'single' },
  { sample: 'single', preload: 1 },
  { sample: 'single', preload: 2 },
  { sample: 'single', preload: 3 },
  { sample: 'single', preload: 4 },
  { sample: 'single', preload: 5 },
  { sample: 'columns' },
  { sample: 'scan' },
  { sample: 'cjk' },
  { sample: 'cjk', nocmap: true },
  { sample: 'plos', dir: 'real' },
  { sample: 'elife', dir: 'real' },
  { sample: 'user', dir: 'real' }
];
// 本地真实 PDF 用例（reader/pdf-real/cases.json，目录已 gitignore）
const extraCases = path.join(ROOT, 'reader', 'pdf-real', 'cases.json');
if (fs.existsSync(extraCases)) {
  for (const one of JSON.parse(fs.readFileSync(extraCases, 'utf8'))) cases.push({ ...one, dir: 'real' });
}
const results = [];
for (const item of cases) {
  const url = 'chrome-extension://' + extId + '/reader/pdf-probe.html?sample=' + item.sample + (item.dir ? '&dir=' + item.dir : '') + (item.page ? '&page=' + item.page : '') + (item.loadPages ? '&loadPages=' + item.loadPages : '') + (item.nocmap ? '&nocmap=1' : '');
  const { targetId } = await send('Target.createTarget', { url: url });
  const session = await attach(targetId);
  const probe = await until(async () => {
    const out = await send('Runtime.evaluate', { expression: 'window.__probe', returnByValue: true }, session);
    const value = out.result && out.result.value;
    return value && (value.ok || value.error) ? value : null;
  }, 30000);
  results.push(probe || { sample: item.sample, ok: false, error: 'timeout' });
  await send('Target.closeTarget', { targetId });
}

for (const result of results) console.log(JSON.stringify(result));
const failed = results.filter((result) => !result.ok).length;
console.log(failed ? 'FAILED ' + failed : 'ALL OK');
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
process.exit(failed ? 1 : 0);
