// 真实 Chrome + 假 API：设置页保存途中的改动不被回填覆盖、保存串行；读配置丢包 / 被拒时设置页仍能初始化。
// 设置页里注入一层 chrome.runtime.sendMessage 包装（只在测试里）：config:save 照常发给后台并落盘，
// 但应答扣住，由测试决定何时放行；config:trustedGet 可以按次数「一直不回」或「没有接收端」。
// 运行：node tools/e2e-options-save.mjs（RIMEFOX_EXTENSION 指定扩展目录，RIMEFOX_TEST_UI_LANG=zh|en 指定界面语言）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = process.env.RIMEFOX_EXTENSION || ROOT;
const UI_LANG = process.env.RIMEFOX_TEST_UI_LANG;
if (UI_LANG && !['zh', 'en'].includes(UI_LANG)) throw new Error('RIMEFOX_TEST_UI_LANG must be zh or en');
const BROWSER = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-options-save-e2e-'));
const profile = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await sleep(100); }
  return null;
}

let apiRequests = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"fake"}]}'); return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      apiRequests += 1;
      const body = JSON.parse(raw);
      const texts = JSON.parse(body.messages.at(-1).content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map(() => '这是用于设置页保存测试的中文译文。')) }, finish_reason: 'stop' }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

// 注入到设置页每个新文档：选项从 sessionStorage 读（同一标签页重载后仍在）
const HOOK = `(() => {
  if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
  let opts = {};
  try { opts = JSON.parse(sessionStorage.getItem('__rimefoxE2E') || '{}'); } catch (e) {}
  const real = chrome.runtime.sendMessage.bind(chrome.runtime);
  let drop = opts.dropGets || 0;
  let refuse = opts.rejectGets || 0;
  const ctl = window.__rimefoxE2E = {
    gets: 0, saves: [], held: [], holdSave: !!opts.holdSave,
    release() { const list = this.held.splice(0); list.forEach((fn) => fn()); return list.length; }
  };
  chrome.runtime.sendMessage = function (msg) {
    const type = msg && msg.type;
    if (type === 'config:trustedGet') {
      ctl.gets += 1;
      if (drop > 0) { drop -= 1; return new Promise(() => {}); }
      if (refuse > 0) { refuse -= 1; return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')); }
    }
    if (type === 'config:save') {
      ctl.saves.push(JSON.parse(JSON.stringify(msg.patch || {})));
      if (ctl.holdSave) {
        const reply = real(msg);
        return new Promise((resolve, reject) => ctl.held.push(() => reply.then(resolve, reject)));
      }
    }
    return real.apply(null, arguments);
  };
})();`;

let browser;
let ws;
let seq = 0;
let extId;
const pending = new Map();
const pageErrors = new Map();
process.on('exit', () => { try { browser?.kill('SIGKILL'); } catch {} });
process.on('SIGTERM', () => process.exit(143));
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(sessionId, code) {
  const response = await send('Runtime.evaluate', { expression: '(() => {' + code + '})()', awaitPromise: true, returnByValue: true }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  return sessionId;
}
const optionsUrl = () => 'chrome-extension://' + extId + '/options/index.html';
const initState = (s) => evaluate(s, 'return {stage: document.documentElement.dataset.optionsInit || "", error: document.documentElement.dataset.optionsInitError || "", dirty: document.getElementById("savebar")?.dataset.dirty, gets: window.__rimefoxE2E && window.__rimefoxE2E.gets}');
const ready = async (s) => { const st = await initState(s); return st.stage === 'ready' && st.dirty === 'false'; };
// 打开设置页并装好钩子：先正常打开一次，注册新文档脚本，写好选项后重载（同源重载，钩子一定在页面脚本之前）
async function openOptions(hookOptions = {}) {
  const { targetId } = await send('Target.createTarget', { url: optionsUrl() });
  const session = await attach(targetId);
  if (!await until(() => ready(session))) throw new Error('Options did not initialize before hooking');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, session);
  await evaluate(session, 'sessionStorage.setItem("__rimefoxE2E", ' + JSON.stringify(JSON.stringify(hookOptions)) + '); window.__rimefoxBeforeReload = true; return true;');
  pageErrors.set(session, []);
  const started = Date.now();
  await send('Page.reload', {}, session);
  if (!await until(() => evaluate(session, 'return !window.__rimefoxBeforeReload && !!window.__rimefoxE2E && document.readyState === "complete"'))) throw new Error('Hooked options page did not load');
  return { targetId, session, started };
}
async function closeTarget(page) { await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {}); }
const storedConfig = (s) => evaluate(s, 'return chrome.storage.local.get("config").then((r) => r.config || {})');
const setSelect = (s, id, value) => evaluate(s, 'const e=document.getElementById(' + JSON.stringify(id) + '); e.value=' + JSON.stringify(value) + '; e.dispatchEvent(new Event("change",{bubbles:true})); return e.value;');
const setText = (s, id, value) => evaluate(s, 'const e=document.getElementById(' + JSON.stringify(id) + '); e.value=' + JSON.stringify(value) + '; e.dispatchEvent(new Event("input",{bubbles:true})); return true;');
const fieldValue = (s, id) => evaluate(s, 'return document.getElementById(' + JSON.stringify(id) + ').value');
const otherOption = (s, id) => evaluate(s, 'const e=document.getElementById(' + JSON.stringify(id) + '); return Array.from(e.options).map((o) => o.value).find((v) => v && v !== e.value) || null;');
const saveEnabled = (s) => evaluate(s, 'return !document.getElementById("save").disabled');
const savedShown = (s) => evaluate(s, 'return /已保存|Saved/.test(document.getElementById("saveResult").textContent)');
const clickSave = (s) => evaluate(s, 'document.getElementById("saveResult").textContent=""; document.getElementById("save").click(); return true;');
const hookState = (s) => evaluate(s, 'const c=window.__rimefoxE2E; return {saves: c.saves, held: c.held.length};');
const release = (s) => evaluate(s, 'return window.__rimefoxE2E.release();');
const setHold = (s, on) => evaluate(s, 'window.__rimefoxE2E.holdSave=' + !!on + '; return true;');
const formState = (s) => evaluate(s, 'return {dirty: document.getElementById("savebar").dataset.dirty, saveDisabled: document.getElementById("save").disabled, result: document.getElementById("saveResult").textContent, state: document.getElementById("saveState").textContent};');

async function start() {
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const port = await until(() => fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  if (!port) throw new Error('Chrome did not start');
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const job = pending.get(message.id); pending.delete(message.id);
      if (message.error) job.reject(new Error(JSON.stringify(message.error))); else job.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown' && pageErrors.has(message.sessionId)) {
      pageErrors.get(message.sessionId).push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, message.sessionId).catch(() => {});
  };
  const loaded = await send('Extensions.loadUnpacked', { path: EXTENSION });
  extId = loaded.id;
  console.log(version.Browser + ' · ' + extId + ' · ' + EXTENSION);
}
async function close() {
  const exited = browser.exitCode !== null || browser.signalCode !== null ? Promise.resolve() : new Promise((resolve) => browser.once('exit', resolve));
  send('Browser.close').catch(() => {});
  await Promise.race([exited, sleep(5000)]);
  if (browser.exitCode === null && browser.signalCode === null) { browser.kill('SIGKILL'); await Promise.race([exited, sleep(3000)]); }
  try { ws.close(); } catch {}
  server.close();
  try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

try {
  await start();
  // 准备：界面语言、假接口服务商（测试连接用）
  {
    const page = await openOptions();
    if (!await until(() => ready(page.session))) throw new Error('Options not ready');
    if (UI_LANG) {
      await evaluate(page.session, 'return import("/lib/config.js").then((m) => m.saveConfig({uiLang:' + JSON.stringify(UI_LANG) + '})).then(() => true)');
    }
    await setText(page.session, 'baseUrl', ORIGIN + '/v1');
    await setText(page.session, 'apiKey', 'mock-options-save');
    await setText(page.session, 'model', 'fake');
    if (!await until(() => saveEnabled(page.session), 5000)) throw new Error('Provider form did not become dirty');
    await clickSave(page.session);
    if (!await until(async () => await savedShown(page.session) && !(await saveEnabled(page.session)), 5000)) throw new Error('Provider form did not save: ' + JSON.stringify(await formState(page.session)));
    await closeTarget(page);
  }

  console.log('\n[读配置：worker 重启时第一次请求丢失 / 被拒]');
  {
    const page = await openOptions({ dropGets: 1 });
    const ok = await until(() => ready(page.session), 15000);
    const st = await initState(page.session);
    const elapsed = Date.now() - page.started;
    check('第一次 config:trustedGet 一直不回：限时后重试，设置页仍初始化完成', !!ok && st.gets >= 2, JSON.stringify({ ...st, elapsed }));
    check('初始化后表单是真实配置（不是 HTML 默认值）', (await fieldValue(page.session, 'baseUrl')) === ORIGIN + '/v1' && (await fieldValue(page.session, 'model')) === 'fake');
    check('丢包重试过程中没有未捕获异常', pageErrors.get(page.session).length === 0, pageErrors.get(page.session).join(' | '));
    await closeTarget(page);
  }
  {
    const page = await openOptions({ rejectGets: 2 });
    const ok = await until(() => ready(page.session), 15000);
    const st = await initState(page.session);
    check('前两次「没有接收端」：退避重试，第三次初始化完成', !!ok && st.gets >= 3, JSON.stringify(st));
    await closeTarget(page);
  }
  {
    const page = await openOptions({ rejectGets: 99 });
    const failed = await until(async () => { const st = await initState(page.session); return st.error ? st : null; }, 15000);
    const shown = await evaluate(page.session, 'return document.getElementById("saveResult").textContent');
    check('一直读不到配置：不会永远停在 config 阶段，记录明确错误', !!failed && failed.stage === 'config' && /无法读取扩展配置|Could not read extension settings/.test(failed.error), JSON.stringify(failed));
    check('读不到配置时页面上有可见提示', /无法读取扩展配置|Could not read extension settings/.test(shown), shown);
    await closeTarget(page);
  }

  console.log('\n[保存途中的改动]');
  {
    const page = await openOptions();
    const s = page.session;
    if (!await until(() => ready(s))) throw new Error('Options not ready');
    const before = await storedConfig(s);
    const theme = await otherOption(s, 'theme');
    const dockSide = (await fieldValue(s, 'dockSide')) === 'left' ? 'right' : 'left';
    const prompt = 'Typed while the save was still in flight.';

    await setHold(s, true);
    await setSelect(s, 'theme', theme);
    await until(() => saveEnabled(s), 5000);
    await clickSave(s);
    const sent = await until(async () => { const h = await hookState(s); return h.held === 1 ? h : null; }, 5000);
    const written = await until(async () => (await storedConfig(s)).theme === theme, 5000);
    check('第一次保存已发出并落盘，应答被扣住', !!sent && !!written && sent.saves.length === 1 && sent.saves[0].theme === theme, JSON.stringify({ sent, before: before.theme, theme }));

    // 应答回来之前：改下拉框、写文本，再点一次保存（应排队，不能拿旧基线并发再存一遍）
    await setSelect(s, 'dockSide', dockSide);
    await setText(s, 'customPrompt', prompt);
    await sleep(400); // 让 watchConfig 看到第一次保存的存储变化
    const midForm = await formState(s);
    check('保存途中别的页面提示没有误报', !/别的页面|another page|elsewhere/i.test(midForm.result), JSON.stringify(midForm));
    await clickSave(s);
    await sleep(300);
    const queued = await hookState(s);
    check('第二次点击排队：第一次应答回来前不发第二次保存', queued.saves.length === 1 && queued.held === 1, JSON.stringify(queued));

    await setHold(s, false);
    await release(s);
    const second = await until(async () => { const h = await hookState(s); return h.saves.length === 2 ? h : null; }, 5000);
    check('第二次保存按最新表单重算补丁：只含途中的改动', !!second && second.saves[1].dockSide === dockSide && second.saves[1].customPrompt === prompt && !('theme' in second.saves[1]), JSON.stringify(second && second.saves));
    const settled = await until(async () => { const f = await formState(s); return await savedShown(s) && f.dirty === 'false' ? f : null; }, 5000);
    const cfg = await storedConfig(s);
    check('两次保存走完：三处改动都已落盘、表单回到已保存', !!settled && cfg.theme === theme && cfg.dockSide === dockSide && cfg.customPrompt === prompt, JSON.stringify({ settled, theme: cfg.theme, dockSide: cfg.dockSide, prompt: cfg.customPrompt }));
    check('表单显示的值就是保存的值', (await fieldValue(s, 'theme')) === theme && (await fieldValue(s, 'dockSide')) === dockSide && (await fieldValue(s, 'customPrompt')) === prompt);

    // 原始问题：保存途中改了下拉框、之后没有再点保存 → 改动必须还在、仍是未保存、能再存
    const dockBack = dockSide === 'left' ? 'right' : 'left';
    const themeBack = before.theme && before.theme !== theme ? before.theme : await otherOption(s, 'theme');
    await setHold(s, true);
    await setSelect(s, 'theme', themeBack);
    await until(() => saveEnabled(s), 5000);
    await clickSave(s);
    await until(async () => (await hookState(s)).held === 1, 5000);
    await until(async () => (await storedConfig(s)).theme === themeBack, 5000);
    await setSelect(s, 'dockSide', dockBack);
    await sleep(400);
    await setHold(s, false);
    await release(s);
    await until(() => savedShown(s), 5000);
    await sleep(300);
    const after = await formState(s);
    check('应答回来后：途中改的下拉框没有被回填覆盖', (await fieldValue(s, 'dockSide')) === dockBack, JSON.stringify({ dockSide: await fieldValue(s, 'dockSide'), expected: dockBack }));
    check('途中的改动仍显示为未保存，保存按钮可用', after.dirty === 'true' && !after.saveDisabled && /1/.test(after.state), JSON.stringify(after));
    check('第一次保存的内容照常落盘且表单不变', (await storedConfig(s)).theme === themeBack && (await fieldValue(s, 'theme')) === themeBack);
    await clickSave(s);
    const resaved = await until(async () => (await storedConfig(s)).dockSide === dockBack && (await formState(s)).dirty === 'false', 5000);
    check('再点一次保存：途中的改动写入配置', !!resaved, JSON.stringify(await formState(s)));
    check('保存流程没有未捕获异常', pageErrors.get(s).length === 0, pageErrors.get(s).join(' | '));
    await closeTarget(page);
  }

  console.log('\n[测试连接 / 悬浮窗位置：先保存再回填的其它入口]');
  {
    const page = await openOptions();
    const s = page.session;
    if (!await until(() => ready(s))) throw new Error('Options not ready');
    const dockSide = (await fieldValue(s, 'dockSide')) === 'left' ? 'right' : 'left';
    const theme = await otherOption(s, 'theme');
    const requestsBefore = apiRequests;
    await setHold(s, true);
    await setSelect(s, 'dockSide', dockSide);
    await until(() => saveEnabled(s), 5000);
    await evaluate(s, 'document.getElementById("test").click(); return true;');
    await until(async () => (await hookState(s)).held === 1, 5000);
    await until(async () => (await storedConfig(s)).dockSide === dockSide, 5000);
    await setSelect(s, 'theme', theme);
    await setHold(s, false);
    await release(s);
    const banner = await until(() => evaluate(s, 'const n=document.getElementById("testResult"); return n.dataset.kind ? {kind:n.dataset.kind, text:n.textContent} : null;'), 15000);
    check('测试连接：先保存、再对假接口测试成功', !!banner && banner.kind !== 'bad' && apiRequests > requestsBefore, JSON.stringify({ banner, requests: apiRequests - requestsBefore }));
    check('测试连接的保存途中改的下拉框没有被覆盖、仍未保存', (await fieldValue(s, 'theme')) === theme && (await formState(s)).dirty === 'true' && (await storedConfig(s)).dockSide === dockSide, JSON.stringify({ theme: await fieldValue(s, 'theme'), expected: theme, form: await formState(s) }));

    // 悬浮窗位置恢复默认：只改 dockPos，表单里尚未保存的改动（上面的 theme）保留
    await evaluate(s, 'return import("/lib/config.js").then((m) => m.saveConfig({dockPos:{x:40,y:50}})).then(() => true)');
    await until(async () => (await storedConfig(s)).dockPos, 5000);
    await sleep(400);
    await evaluate(s, 'const b=document.getElementById("dockPosReset"); b.disabled=false; b.click(); return true;');
    const reset = await until(async () => (await storedConfig(s)).dockPos === null, 5000);
    await sleep(200);
    check('悬浮窗位置恢复默认：位置已清空，未保存的下拉框改动仍在', !!reset && (await fieldValue(s, 'theme')) === theme && (await formState(s)).dirty === 'true', JSON.stringify({ theme: await fieldValue(s, 'theme'), form: await formState(s) }));
    await clickSave(s);
    check('之后保存：改动写入配置', !!await until(async () => (await storedConfig(s)).theme === theme && (await formState(s)).dirty === 'false', 5000));
    check('其它入口没有未捕获异常', pageErrors.get(s).length === 0, pageErrors.get(s).join(' | '));
    await closeTarget(page);
  }
} catch (err) {
  check('脚本完整运行', false, err && err.stack || String(err));
} finally {
  await close();
}
const failed = results.filter((one) => !one.ok);
console.log('\n' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
