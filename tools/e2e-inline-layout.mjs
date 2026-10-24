#!/usr/bin/env node
// Real headless Chrome DOM/layout checks. Local fixtures only; no model, package dependency, or article network request.
// node tools/e2e-inline-layout.mjs [--browser /path/to/chrome] [--baseline-dom /tmp/dom-before.js]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const BROWSER = option('--browser') || process.env.RIMEFOX_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const baseline = option('--baseline-dom');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-inline-layout-'));
const html = fs.readFileSync(path.join(ROOT, 'selftest/index.html'), 'utf8');
const template = /<template id="tpl-inline-layout">([\s\S]*?)<\/template>/.exec(html);
if (!template) throw new Error('Missing inline layout fixture');
const fidelityHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/inline-fidelity.html'), 'utf8');
const fidelityStyle = /<style>([\s\S]*?)<\/style>/.exec(fidelityHtml);
const fidelityMain = /<main id="inline-fidelity-fixture">([\s\S]*?)<\/main>/.exec(fidelityHtml);
if (!fidelityStyle || !fidelityMain) throw new Error('Missing inline fidelity fixture');
const page = (old) => '<!doctype html><html lang="en"><meta charset="utf-8"><title>Local inline layout fixture</title><style>body{margin:24px}.fx-inline-layout{max-width:100%}</style><body>' +
  '<template id="tpl-inline-layout">' + template[1] + '</template>' +
  '<template id="tpl-inline-fidelity"><style>' + fidelityStyle[1] + '</style><main id="inline-fidelity-fixture">' + fidelityMain[1] + '</main></template>' +
  '<script src="/lib/inline-protocol.js"></script><script src="/content/core.js"></script><script src="/content/units.js"></script><script src="' + (old ? '/baseline-dom.js' : '/content/dom.js') + '"></script><script src="/content/direction.js"></script><script src="/selftest/inline-layout.js"></script><script src="/selftest/inline-fidelity.js"></script></body></html>';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/layout' || url.pathname === '/baseline') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(url.pathname === '/baseline'));
    return;
  }
  const file = url.pathname === '/baseline-dom.js' && baseline ? path.resolve(baseline) : path.resolve(ROOT, '.' + url.pathname);
  if ((!file.startsWith(ROOT + path.sep) && file !== path.resolve(baseline || ROOT)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const debugPort = 20000 + Math.floor(Math.random() * 10000);
const chrome = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--remote-allow-origins=*', '--user-data-dir=' + path.join(work, 'profile'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (_) { /* Browser starts asynchronously. */ }
    await sleep(100);
  }
  throw new Error('Timed out waiting for browser or page');
}
let ws;
let id = 0;
const pending = new Map();
const report = { browser: '', baseline: null, scenarios: [], selftest: null };
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const call = ++id;
    const timer = setTimeout(() => { pending.delete(call); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(call, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: call, method, params, sessionId }));
  });
}
async function evaluate(session, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function open(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await until(() => evaluate(sessionId, 'document.readyState === "complete" && location.pathname === ' + JSON.stringify(new URL(url).pathname)));
  return { targetId, sessionId };
}
try {
  const version = await until(async () => {
    const response = await fetch('http://127.0.0.1:' + debugPort + '/json/version');
    return response.ok ? response.json() : null;
  });
  report.browser = version.Browser;
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  };
  if (baseline) {
    const tab = await open(origin + '/baseline');
    report.baseline = await evaluate(tab.sessionId, 'runInlineLayoutChecks()');
    const failed = report.baseline.checks.filter((item) => !item.ok);
    console.log('BASELINE ' + failed.length + ' failing layout assertions; evidence saved with final report.');
    if (!failed.some((item) => item.name === 'sup:outside-citation-context') || !failed.some((item) => item.name === 'css-relative:body-font')) throw new Error('The supplied baseline did not reproduce the expected structural/font failures');
    await send('Target.closeTarget', { targetId: tab.targetId });
  }
  for (const scenario of [
    { width: 1000, height: 900, zoom: 1, deviceScale: 1, pageScale: 1 },
    { width: 390, height: 850, zoom: 1.25, deviceScale: 1.25, pageScale: 1 },
    { width: 1280, height: 900, zoom: 1.75, deviceScale: 1.5, pageScale: 1.25 }
  ]) {
    const tab = await open(origin + '/layout');
    await send('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: scenario.deviceScale, mobile: false }, tab.sessionId);
    await send('Emulation.setPageScaleFactor', { pageScaleFactor: scenario.pageScale }, tab.sessionId);
    await evaluate(tab.sessionId, 'document.documentElement.style.zoom=' + scenario.zoom);
    const result = await evaluate(tab.sessionId, 'runInlineLayoutChecks({long:true})');
    const fidelity = await evaluate(tab.sessionId, 'runInlineFidelityChecks()');
    result.checks = result.checks.concat(fidelity.checks);
    result.fidelity = { evidence: fidelity.evidence, metrics: fidelity.metrics };
    const failed = result.checks.filter((item) => !item.ok);
    report.scenarios.push({ ...scenario, ...result });
    console.log((failed.length ? 'FAIL ' : 'PASS ') + scenario.width + 'px / CSS zoom ' + scenario.zoom + ' / device scale ' + scenario.deviceScale + ' / page scale ' + scenario.pageScale + ': ' + (result.checks.length - failed.length) + '/' + result.checks.length);
    for (const failure of failed) console.log('  ' + failure.name + ': ' + failure.detail);
    await send('Target.closeTarget', { targetId: tab.targetId });
  }
  const selftest = await open(origin + '/selftest/index.html');
  report.selftest = await until(() => evaluate(selftest.sessionId, '(function(){var s=document.getElementById("summary");return s && /全部通过|存在失败项/.test(s.textContent) ? {text:s.textContent,ok:s.className==="pass"}:null;})()'), 40000);
  console.log((report.selftest.ok ? 'PASS ' : 'FAIL ') + 'full offline selftest (Science / Nature / PMC / YouTube mentions included): ' + report.selftest.text);
  const failures = report.scenarios.flatMap((scenario) => scenario.checks.filter((item) => !item.ok));
  if (failures.length || !report.selftest.ok) process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2));
  console.log('Report: ' + path.join(work, 'result.json'));
  if (ws) { try { await send('Browser.close'); } catch (_) { /* Browser may already have exited. */ } ws.close(); }
  chrome.kill();
  await new Promise((resolve) => server.close(resolve));
}
