#!/usr/bin/env node
// Recorded QA responses + real extension, isolated Chrome profile and local fake API.
// CDP setup follows tools/e2e-extension.mjs and the independent QA driver.
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
const EXTENSION = path.resolve(option('--extension') || ROOT);
const FIXTURES = path.join(ROOT, 'test/fixtures/link-order');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-link-order-'));
const output = option('--out') ? path.resolve(option('--out')) : path.join(work, 'evidence');
fs.mkdirSync(output, { recursive: true });
const requests = [];
let replies = {};
const report = { extensionPath: EXTENSION, extensionId: '', browser: '', fixtures: 'test/fixtures/link-order', checks: [], scenarios: [], direct: null, exceptions: [] };
const check = (name, ok, detail = '') => report.checks.push({ name, ok: !!ok, detail });
const compact = (text) => String(text).replace(/\s+/g, '');
const visible = (text) => String(text).replace(/<\/?[fk]\d+>/g, '');
function fallback(text) {
  return String(text).replace(/<k\d+>[\s\S]*?<\/k\d+>|[A-Za-z]{3,}|[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]+/g, (part) => {
    if (!part.startsWith('<k')) return '中文';
    return part.replace(/(<f\d+>)([\s\S]*?)(<\/f\d+>)/g, (_, a, t, b) => a + t.replace(/[A-Za-z]{3,}|[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]+/g, '中文') + b);
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/v1/chat/completions') {
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      let parsed, inputs;
      try {
        parsed = JSON.parse(body);
        const user = (parsed.messages || []).find((m) => m.role === 'user')?.content || '';
        inputs = JSON.parse(/\[[\s\S]*\]/.exec(user)?.[0] || '[]');
      } catch (err) { res.writeHead(400, headers); res.end(JSON.stringify({ error: { message: err.message } })); return; }
      const outputs = inputs.map((text) => Object.hasOwn(replies, text) ? replies[text] : fallback(text));
      requests.push({ model: parsed.model, inputs, outputs });
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(outputs) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
    return;
  }
  let file;
  if (url.pathname.startsWith('/pages/')) file = path.resolve(FIXTURES, '.' + url.pathname);
  else file = path.resolve(ROOT, '.' + url.pathname);
  if ((!file.startsWith(ROOT + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = path.join(work, 'profile');
const chrome = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--disable-crash-reporter', '--disable-gpu', '--disable-background-networking', '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (err) { last = err; }
    await sleep(100);
  }
  throw new Error('Timed out: ' + label + (last ? ' (' + last.message + ')' : ''));
}
let ws, seq = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate(session, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId).catch(() => null);
  return sessionId;
}
let sw;
const swEval = (code) => evaluate(sw, '(async () => {' + code + '})()');
const message = (tabId, msg) => swEval('return await chrome.tabs.sendMessage(' + tabId + ', ' + JSON.stringify(msg) + ', {frameId:0});');
async function idle(tabId) {
  return until(async () => {
    const st = await message(tabId, { type: 'dt:status' });
    return st && !st.busy ? st : null;
  }, 'translation idle');
}
const SNAPSHOT = `(function () {
  var source = window.__linkOrderSource, p = source.el;
  var target = p.querySelector('[data-dt-target]');
  var active = target || p;
  function attrs(a) { return Array.prototype.map.call(a.attributes, function (v) { return [v.name,v.value]; }); }
  function links(root) { return Array.prototype.map.call(root.querySelectorAll('a'), function(a) { return {href:a.getAttribute('href'),label:a.textContent,rects:a.getClientRects().length}; }); }
  return { text:active.textContent, html:p.outerHTML, sameSource:p.outerHTML===source.html,
    sourceNodesSame:source.nodes.every(function(n,i){return n===source.currentNodes()[i];}) && source.nodes.length===source.currentNodes().length,
    originalLinks:source.links.map(function(a){return {same:Array.prototype.indexOf.call(source.el.querySelectorAll('a'),a)>=0,connected:a.isConnected,attrs:attrs(a),href:a.getAttribute('href'),label:a.textContent};}),
    sourceAttrs:source.attrs, links:links(active), targets:p.querySelectorAll('[data-dt-target]').length,
    residue:p.querySelectorAll('[data-dt-format],[data-dt-dir],[data-dt-font]').length,
    toast:Array.prototype.map.call(document.querySelectorAll('[data-dt-ui]'),function(n){return n.textContent;}).join(' '),
    clicks:window.__linkOrderClicks||0 };
})()`;
async function snapshot(session) { return evaluate(session, SNAPSHOT); }
async function screenshot(session, name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
  const namePath = path.join(output, name + '.png');
  fs.writeFileSync(namePath, Buffer.from(shot.data, 'base64'));
  return namePath;
}
function responseParts(record) {
  return requests.slice(record.startRequest).flatMap((r) => r.inputs.map((text, i) => ({ text, value: r.outputs[i] }))).filter((part) => Object.hasOwn(record.replies, part.text));
}
function validateVisible(name, snap, parts, sourceLinks, mode) {
  const expected = compact(parts.map((p) => visible(p.value)).join(''));
  check(name + ':exact-visible-order', compact(snap.text) === expected, { actual: snap.text, expected });
  const wanted = [];
  for (const part of parts) {
    for (const match of part.value.matchAll(/<k(\d+)>([\s\S]*?)<\/k\1>/g)) wanted.push({ href: sourceLinks[Number(match[1]) - 1].href, label: visible(match[2]) });
  }
  check(name + ':text-href-correspondence', JSON.stringify(snap.links.map(({ href, label }) => ({ href, label }))) === JSON.stringify(wanted), { actual: snap.links, expected: wanted, mode });
}
try {
  const port = await until(() => {
    const file = path.join(profile, 'DevToolsActivePort');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[0] : null;
  }, 'Chrome random debugging port');
  const version = await until(async () => { const res = await fetch('http://127.0.0.1:' + port + '/json/version'); return res.ok ? res.json() : null; }, 'Chrome');
  report.browser = version.Browser;
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') report.exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    const call = pending.get(msg.id);
    if (!call) return;
    clearTimeout(call.timer); pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message)); else call.resolve(msg.result);
  };
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXTENSION });
  report.extensionId = extId;
  const swTarget = await until(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://' + extId));
  }, 'extension service worker');
  sw = await attach(swTarget.targetId);
  for (const scenario of [
    { name: 'en-control', page: 'wiki-ai-p1-events.html', reply: 'order-control.json', mode: 'translation' },
    { name: 'en-control-dual', page: 'wiki-ai-p1-events.html', reply: 'order-control.json', mode: 'dual' },
    { name: 'en-reorder', page: 'wiki-ai-p1-events.html', reply: 'order-reorder.json', mode: 'translation', reorder: true, switchMode: true },
    { name: 'en-tail', page: 'wiki-ai-p1-events.html', reply: 'order-tail.json', mode: 'translation', warning: true },
    { name: 'en-tail-dual', page: 'wiki-ai-p1-events.html', reply: 'order-tail.json', mode: 'dual', warning: true },
    { name: 'en-missing-one', page: 'wiki-ai-p1-events.html', reply: 'order-missingOne.json', mode: 'translation', fail: 'invalid-inline' },
    { name: 'en-missing-one-dual', page: 'wiki-ai-p1-events.html', reply: 'order-missingOne.json', mode: 'dual', fail: 'invalid-inline' },
    { name: 'en-reorder-dual', page: 'wiki-ai-p1-events.html', reply: 'order-reorder.json', mode: 'dual' },
    { name: 'ar-control', page: 'wiki-ar-p1.html', reply: 'ar-control.json', mode: 'translation' },
    { name: 'ar-control-dual', page: 'wiki-ar-p1.html', reply: 'ar-control.json', mode: 'dual' },
    { name: 'ar-reorder', page: 'wiki-ar-p1.html', reply: 'ar-reorder.json', mode: 'translation', fail: 'unsupported-inline-order', switchMode: true },
    { name: 'ar-reorder-dual', page: 'wiki-ar-p1.html', reply: 'ar-reorder.json', mode: 'dual' }
  ]) {
    replies = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'replies', scenario.reply), 'utf8')).exact;
    const record = { ...scenario, replies, startRequest: requests.length };
    const cfg = { _v: 8, currentProvider: '__custom__', customProviders: [{ id: '__custom__', name: 'Local recorded QA' }], providerConfig: { __custom__: { engine: 'openai', baseUrl: origin + '/v1', apiKey: 'sk-local-fake', model: 'recorded-' + scenario.name } }, targetLang: 'zh-CN', mode: scenario.mode, lazy: false, thinkingMode: 'off', hoverCompare: true, batchSize: 8, maxCharsPerBatch: 2000, concurrency: 1 };
    await swEval('await chrome.storage.local.set({config:' + JSON.stringify(cfg) + '});return true;');
    const url = origin + '/pages/' + scenario.page + '?case=' + scenario.name;
    const { targetId } = await send('Target.createTarget', { url });
    const session = await attach(targetId);
    await until(() => evaluate(session, 'document.readyState === "complete" && document.documentElement.hasAttribute("data-dt")'), 'content script ' + scenario.name);
    await evaluate(session, `(function(){
      var el=document.getElementById(${JSON.stringify(scenario.name.startsWith('ar-') ? 'mwBg' : 'mwDQ')});
      function nodes(){var w=document.createTreeWalker(el,NodeFilter.SHOW_ALL),out=[];for(var n=w.nextNode();n;n=w.nextNode())out.push(n);return out;}
      var links=Array.prototype.slice.call(el.querySelectorAll('a'));
      window.__linkOrderSource={el:el,html:el.outerHTML,nodes:nodes(),currentNodes:nodes,links:links,attrs:links.map(function(a){return Array.prototype.map.call(a.attributes,function(v){return[v.name,v.value];});})};
      window.__linkOrderClicks=0;links.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();window.__linkOrderClicks+=1;});});return true;
    })()`);
    const tabId = await swEval('return (await chrome.tabs.query({})).find(t=>t.url===' + JSON.stringify(url) + ').id;');
    const before = await snapshot(session);
    await message(tabId, { type: 'dt:toggle' });
    await sleep(200);
    record.status = await idle(tabId);
    record.initial = await snapshot(session);
    record.diagnose = await message(tabId, { type: 'dt:diagnose' });
    record.screenshot = await screenshot(session, scenario.name);
    record.requests = requests.length - record.startRequest;
    const parts = responseParts(record);
    check(scenario.name + ':recorded-response-used', parts.length === Object.keys(replies).length, parts.map((part) => part.text.slice(0, 50)));
    check(scenario.name + ':original-link-identity-and-attributes', record.initial.originalLinks.every((a, i) => a.same && a.connected && JSON.stringify(a.attrs) === JSON.stringify(before.sourceAttrs[i])));
    if (scenario.fail) {
      check(scenario.name + ':explicit-render-failure', record.status.renderFailed === 1 && String(record.status.lastRenderError || '').includes(scenario.fail), record.status);
      check(scenario.name + ':not-counted-as-translated', record.status.translated === 2, record.status);
      check(scenario.name + ':whole-paragraph-unmodified', record.initial.sameSource && record.initial.sourceNodesSame && record.initial.targets === 0 && record.initial.residue === 0, record.initial.html);
      if (scenario.fail === 'invalid-inline') check(scenario.name + ':missing-marker-still-rejected', /missing-marker/.test(record.status.lastRenderError), record.status);
      if (scenario.fail === 'unsupported-inline-order') {
        check(scenario.name + ':accurate-warning-state', record.status.inlineOrderFailed === 1 && record.status.qualityWarnings === 1 && record.status.failed === 0 && record.status.skipped === 0 && record.status.safeDegraded === 0, record.status);
        check(scenario.name + ':user-visible-reason', /链接顺序无法安全重排.*保留原文.*双语|link order.*original.*bilingual/i.test(record.initial.toast), record.initial.toast);
        check(scenario.name + ':diagnostic-render-not-provider-failure', record.diagnose.failures?.recentFailures?.some((item) => item.kind === 'render' && item.code === 'unsupported-inline-order' && item.reason === 'nonmonotonic-atom-order'), record.diagnose.failures);
      }
    } else if (scenario.reorder) {
      check(scenario.name + ':reordered-success', record.status.translated === 3 && record.status.renderFailed === 0 && record.status.inlineReordered === 1 && record.status.inlineOrderFailed === 0 && record.status.safeDegraded === 0, record.status);
      validateVisible(scenario.name, record.initial, parts, before.links, scenario.mode);
    } else {
      check(scenario.name + ':normal-success', record.status.translated === 3 && !record.status.renderFailed, record.status);
      validateVisible(scenario.name, record.initial, parts, before.links, scenario.mode);
      if (scenario.warning) check(scenario.name + ':model-placement-warning', record.status.qualityWarnings === 1 && record.status.inlinePlacementWarnings === 1 && record.status.inlineOrderFailed === 0 && record.status.safeDegraded === 0, record.status);
    }
    if (scenario.name === 'en-reorder' && scenario.fail) {
      await swEval('await chrome.tabs.update(' + tabId + ',{active:true});return true;');
      const popup = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/index.html', background: true });
      const popSession = await attach(popup.targetId);
      record.popup = await until(async () => {
        const text = await evaluate(popSession, "document.getElementById('stat') && document.getElementById('stat').textContent");
        return text || null;
      }, 'popup status');
      record.popupScreenshot = await screenshot(popSession, scenario.name + '-popup');
      check(scenario.name + ':popup-no-stale-order-error', !/链接顺序.*保留原文|link order.*kept original/i.test(record.popup), record.popup);
      await send('Target.closeTarget', { targetId: popup.targetId });
    }
    const noRetryCount = requests.length;
    await evaluate(session, "window.__linkOrderSource.el.dispatchEvent(new MouseEvent('click',{bubbles:true}));var scan=document.createElement('span');document.body.appendChild(scan);scan.remove();true");
    await sleep(900);
    check(scenario.name + ':no-automatic-paid-retry', requests.length === noRetryCount);
    if (scenario.switchMode) {
      const count = requests.length;
      await message(tabId, { type: 'dt:setMode', mode: 'dual' });
      await sleep(200);
      record.dualStatus = await idle(tabId);
      record.dual = await snapshot(session);
      record.dualScreenshot = await screenshot(session, scenario.name + '-switched-dual');
      if (scenario.reorder) {
        check(scenario.name + ':dual-reuses-valid-cache', requests.length === count && record.dualStatus.translated === 3 && record.dualStatus.renderFailed === 0, record.dualStatus);
        validateVisible(scenario.name + ':switched-dual', record.dual, parts, before.links, 'dual');
        await message(tabId, { type: 'dt:setMode', mode: 'translation' });
        await sleep(200);
        record.backStatus = await idle(tabId);
        check(scenario.name + ':translation-switch-reordered-cache', requests.length === count && record.backStatus.translated === 3 && record.backStatus.renderFailed === 0, record.backStatus);
        await message(tabId, { type: 'dt:retranslate' });
        await sleep(200);
        record.againStatus = await idle(tabId);
        check(scenario.name + ':explicit-retranslate-reordered-cache', requests.length === count && record.againStatus.translated === 3 && record.againStatus.renderFailed === 0, record.againStatus);
      } else {
        check(scenario.name + ':dual-reuses-valid-cache', requests.length === count && record.dualStatus.translated === 3 && !record.dualStatus.renderFailed, record.dualStatus);
        validateVisible(scenario.name + ':switched-dual', record.dual, parts, before.links, 'dual');
        await message(tabId, { type: 'dt:setMode', mode: 'translation' });
        await sleep(200);
        record.backStatus = await idle(tabId);
        check(scenario.name + ':translation-switch-safe-cached-failure', requests.length === count && record.backStatus.renderFailed === 1 && (await snapshot(session)).sameSource, record.backStatus);
        await message(tabId, { type: 'dt:retranslate' });
        await sleep(200);
        record.againStatus = await idle(tabId);
        check(scenario.name + ':explicit-retranslate-cache-no-retry', requests.length === count && record.againStatus.renderFailed === 1 && (await snapshot(session)).sameSource, record.againStatus);
      }
    }
    await evaluate(session, "window.__linkOrderSource.links.forEach(function(a){a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});true");
    check(scenario.name + ':original-listeners-still-active', (await snapshot(session)).clicks === before.links.length);
    await message(tabId, { type: 'dt:toggle' });
    await idle(tabId);
    record.restored = await snapshot(session);
    check(scenario.name + ':exact-restore-original-node-tree', record.restored.sameSource && record.restored.sourceNodesSame && record.restored.residue === 0 && record.restored.targets === 0, record.restored.html);
    // A framework may replace an untranslated failed paragraph. The new source must be eligible.
    if (scenario.name === 'en-reorder') {
      const count = requests.length;
      if (scenario.reorder) {
        // Translation is off at this point. Replace the source while off, then turn it on;
        // the new source must be collected and translated without an old order failure.
        await evaluate(session, "var updated=document.createElement('p');updated.id='mwDQ';updated.textContent='A dynamic framework replaced this paragraph with a new explanation.';window.__linkOrderSource.el.replaceWith(updated);window.__linkOrderNewParagraph=updated;true");
        await message(tabId, { type: 'dt:toggle' });
      } else {
        await message(tabId, { type: 'dt:toggle' });
        await sleep(200);
        const beforeReplace = await idle(tabId);
        check(scenario.name + ':dynamic-failure-precondition-cache', beforeReplace.inlineOrderFailed === 1 && requests.length === count, beforeReplace);
        await evaluate(session, "var updated=document.createElement('p');updated.id='mwDQ';updated.textContent='A dynamic framework replaced this paragraph with a new explanation.';window.__linkOrderSource.el.replaceWith(updated);window.__linkOrderNewParagraph=updated;true");
      }
      record.dynamicStatus = await until(async () => {
        const state = await message(tabId, { type: 'dt:status' });
        return !state.busy && state.translated === 3 && requests.length > count ? state : null;
      }, 'framework replacement translates');
      check(scenario.name + ':dynamic-new-source-can-translate', requests.length === count + 1 && record.dynamicStatus.translated === 3, record.dynamicStatus);
      check(scenario.name + ':removed-failure-state-pruned', !record.dynamicStatus.renderFailed && !record.dynamicStatus.inlineOrderFailed && !record.dynamicStatus.qualityWarnings && !record.dynamicStatus.lastRenderError, record.dynamicStatus);
      const afterReplaceCount = requests.length;
      await evaluate(session, "window.__linkOrderNewParagraph.dispatchEvent(new MouseEvent('click',{bubbles:true}));true");
      await sleep(900);
      check(scenario.name + ':dynamic-no-extra-retry', requests.length === afterReplaceCount);
      await message(tabId, { type: 'dt:toggle' });
      await idle(tabId);
      check(scenario.name + ':restore-preserves-framework-update', await evaluate(session, "document.getElementById('mwDQ')===window.__linkOrderNewParagraph && document.getElementById('mwDQ').textContent==='A dynamic framework replaced this paragraph with a new explanation.' && !window.__linkOrderSource.el.isConnected"));
    }
    record.allRequests = requests.slice(record.startRequest);
    delete record.replies;
    report.scenarios.push(record);
    fs.writeFileSync(path.join(output, scenario.name + '.json'), JSON.stringify(record, null, 2));
    console.log(scenario.name + ': ' + report.checks.filter((item) => item.name.startsWith(scenario.name + ':') && !item.ok).length + ' failing checks');
    await send('Target.closeTarget', { targetId });
  }
  const directTab = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/selftest/index.html' });
  const directSession = await attach(directTab.targetId);
  await until(() => evaluate(directSession, 'document.readyState === "complete" && typeof window.runLinkOrderChecks === "function" && /pass|fail/.test(document.getElementById("summary").className)'), 'direct renderer suite');
  report.direct = await evaluate(directSession, 'window.runLinkOrderChecks()');
  for (const item of report.direct.checks) check('direct:' + item.name, item.ok, item.detail);
  await send('Target.closeTarget', { targetId: directTab.targetId });
  check('no-browser-exceptions', report.exceptions.length === 0, report.exceptions);
} catch (err) {
  check('runner-completed', false, err.stack || err.message);
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const failed of report.checks.filter((item) => !item.ok)) console.error('FAIL ' + failed.name + ': ' + JSON.stringify(failed.detail));
  const passed = report.checks.filter((item) => item.ok).length;
  console.log(passed + '/' + report.checks.length + ' checks; evidence: ' + output);
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  server.close();
  // Keep the evidence directory when it is inside the temporary work directory.
  fs.rmSync(profile, { recursive: true, force: true });
  process.exitCode = passed === report.checks.length && report.checks.length ? 0 : 1;
}
