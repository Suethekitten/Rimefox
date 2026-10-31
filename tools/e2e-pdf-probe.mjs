#!/usr/bin/env node
// PDF 探针运行器：加载工作树扩展，在真实扩展页里跑 pdf.js，读取 window.__probe。
// 用法：node tools/e2e-pdf-probe.mjs [chromePath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.argv[2] || process.env.RIMEFOX_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 20200 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-pdf-probe-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--enable-unsafe-extension-debugging',
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

const { id: extId } = await send('Extensions.loadUnpacked', { path: ROOT });
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
const samples = ['single', 'columns', 'scan'];
const results = [];
for (const sample of samples) {
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/reader/pdf-probe.html?sample=' + sample });
  const session = await attach(targetId);
  const probe = await until(async () => {
    const out = await send('Runtime.evaluate', { expression: 'window.__probe', returnByValue: true }, session);
    const value = out.result && out.result.value;
    return value && (value.ok || value.error) ? value : null;
  }, 30000);
  results.push(probe || { sample: sample, ok: false, error: 'timeout' });
  await send('Target.closeTarget', { targetId });
}

for (const result of results) console.log(JSON.stringify(result));
const failed = results.filter((result) => !result.ok).length;
console.log(failed ? 'FAILED ' + failed : 'ALL OK');
try { browser.kill('SIGKILL'); } catch (err) { /* ignore */ }
process.exit(failed ? 1 : 0);
