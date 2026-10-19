#!/usr/bin/env node
// 真实浏览器端到端检查：真实 Chrome（或 Edge）+ 加载工作树里的扩展 + 本地假 OpenAI 兼容接口，不需要 API Key。
//   node tools/e2e-extension.mjs                                  普通文章页 / 划词 / 仅译文 / 还原 / 配置广播 / 简繁 / 缓存落盘 / 设置页
//   node tools/e2e-extension.mjs --youtube <视频地址>              再加 YouTube 真实页面的双语字幕（需要能上 YouTube，视频要有人工字幕）
//   --browser <可执行文件>（或环境变量 RIMEFOX_BROWSER）换浏览器，比如 Edge；--headed 显示窗口；--keep 保留临时用户目录；
//   --verbose 打印扩展的调试日志、YouTube 的字幕请求和广告开始 / 结束（排查用）；--youtube-only 跳过文章页和设置页
// 品牌版 Chrome 137+ 不认 --load-extension：带 --enable-unsafe-extension-debugging 启动，再用 CDP 的 Extensions.loadUnpacked 加载。
// 全部通过时退出码 0；结果另存在临时目录的 result.json。Node 22+（用内置 WebSocket），不依赖 npm 包。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const DEFAULT_BROWSER = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform];
const BROWSER = option('--browser') || process.env.RIMEFOX_BROWSER || DEFAULT_BROWSER;
const YOUTUBE = option('--youtube');
const VERBOSE = flag('--verbose');
const t0 = Date.now();
const verbose = (...args) => VERBOSE && console.log('    · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's', ...args);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const DEBUG_PORT = 19300 + Math.floor(Math.random() * 500);
const ORIGIN = 'http://127.0.0.1:' + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 反复试 fn 直到返回真值；超时返回 null（中途抛错当作还没好）
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      /* 还没好 */
    }
    await sleep(step);
  }
  return null;
}

// ---------------- 假接口 + 测试页 ----------------
// 模型：每条译文 = '译:' + 原文（目标是繁體中文时 '繁:'）；单条带 CITE 回纯文本「巴黎是首都[1]。」，带 SPLIT 回拆开的两句。
// 带 reasoning_effort 的请求回 400（OpenAI 官方非推理模型就是这样），用来看扩展会不会记住、不再发
const stats = { requests: 0, texts: 0, withEffort: 0, lateRejected: 0, firstOk: 0, aligned: 0, sent: [], lastSystem: '', lastAlignedSystem: '' };
const PAGES = {
  '/page.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Article</title></head><body>
<h1>Rimefox release test page</h1>
<p id="p1">This is the first paragraph of the article with enough words to translate.</p>
<p id="p2">Hello <span class="notranslate">Rimefox</span> world</p>
<p id="p3">The second normal paragraph talks about translation quality and speed.</p>
<iframe id="f" src="/frame.html" width="420" height="120"></iframe>
</body></html>`,
  '/frame.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
<p id="fp">Text inside the embedded frame should stay original after reload.</p></body></html>`,
  '/simp.html': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>简体</title></head><body>
<p id="s1">这是一个完整的中文句子，用于测试简繁转换的效果。</p>
<p id="s2">我们发现这个问题以后，马上开始处理相关的工作。</p>
</body></html>`,
  '/aozora.html': `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Aozora</title></head><body>
<div id="mt" class="main_text" style="width:640px;font:16px/2 serif">ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。<br><br>広い門の下には、この男のほかに誰もいない。ただ、所々丹塗りの剥げた、大きな円柱に、蟋蟀が一匹とまっている。<br><br>羅生門が、朱雀大路にある以上は、この男のほかにも、雨やみをする市女笠や揉烏帽子が、もう二三人はありそうなものである。</div>
</body></html>`,
  '/pixiv.html': `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Pixiv</title></head><body>
<div id="novel" style="white-space:pre-wrap;width:640px;font:16px/2 serif"><p id="np1"><span>「今日は何の日？」</span><br><span>「ポッキーの日だ。」</span></p><p id="np2">彼は<ruby>羅生門<rt>らしょうもん</rt></ruby>の下で、雨やみを待っていた。</p><p id="np3">静かな夜だった。</p></div>
</body></html>`,
  '/input.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inputs</title></head><body>
<p id="hint">Text box translation fixture.</p>
<textarea id="ta" rows="3">Hello draft line</textarea>
<input id="tx" type="text" value="Another draft">
<input id="rx" type="text" value="Controlled input">
<div id="ce" contenteditable="true">Editable rich text</div>
<input id="pw" type="password" value="secret">
<script>
  // 模拟 React 受控输入框：state 只认 input 事件（没收到事件就当没改），并写回 data-state 供检查
  (function () {
    var rx = document.getElementById('rx');
    var state = rx.value;
    rx.addEventListener('input', function () {
      state = rx.value;
      rx.setAttribute('data-state', state);
    });
    rx.setAttribute('data-state', state);
  })();
</script>
</body></html>`
};

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (req.method === 'GET' && PAGES[route]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[route]);
    return;
  }
  if (req.method === 'POST' && route === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const headers = { 'content-type': 'application/json' };
      stats.lastSystem = String((body.messages && body.messages[0] && body.messages[0].content) || '');
      if (body.reasoning_effort !== undefined) {
        stats.withEffort += 1;
        // 已经有请求去掉参数重发成功过（后台一定收到过 400）之后还带着参数来：记忆没生效
        if (stats.firstOk) stats.lateRejected += 1;
        res.writeHead(400, headers);
        res.end('{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}');
        return;
      }
      const texts = JSON.parse(body.messages[1].content);
      stats.requests += 1;
      stats.texts += texts.length;
      stats.sent.push(...texts);
      if (!stats.firstOk) stats.firstOk = Date.now();
      let content;
      const wantsAlign = body.messages[0].content.includes('"parts"');
      if (wantsAlign) {
        stats.aligned += 1;
        stats.lastAlignedSystem = String(body.messages[0].content || '');
      }
      const aligned = (text, prefix) => {
        // 和内容脚本同一套简单切句：句末标点后断开；每句一个 n=1 的片段
        const sents = String(text)
          .split(/(?<=[。！？…])|(?<=[.!?])\s+/)
          .map((one) => one.trim())
          .filter(Boolean);
        return { parts: (sents.length ? sents : [String(text)]).map((one) => ({ n: 1, t: prefix + one })) };
      };
      if (texts.length === 1 && texts[0].includes('CITE')) content = '巴黎是首都[1]。';
      else if (texts.length === 1 && texts[0].includes('SPLIT')) content = '["Hello.","How are you?"]';
      else {
        const hant = body.messages[0].content.includes('目标语言（繁體中文）');
        const prefix = hant ? '繁:' : '译:';
        content = JSON.stringify(texts.map((t) => (wantsAlign ? aligned(t, prefix) : prefix + t)));
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------------- 浏览器 + CDP ----------------
const profile = path.join(WORK, 'profile');
const browser = spawn(BROWSER, [
  ...(flag('--headed') ? [] : ['--headless=new']),
  '--enable-unsafe-extension-debugging',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--remote-allow-origins=*',
  '--user-data-dir=' + profile,
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
], { stdio: 'ignore' });

const version = await until(async () => {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
  return r.ok ? r.json() : null;
}, 20000);
if (!version) throw new Error('浏览器没有起来：' + BROWSER);
console.log(version.Browser + ' · 扩展目录 ' + ROOT + ' · 假接口 ' + ORIGIN);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
const contexts = []; // 各标签页里的执行环境：内容脚本跑在扩展的隔离环境里
const timedtext = new Map(); // YouTube 字幕请求：requestId → { v, mime }，跟踪它的响应
const captionResponses = []; // 加载完的字幕回包：{ v, mime, bytes }
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message + ' ' + (m.error.data || '')));
    else p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.executionContextCreated') contexts.push({ session: m.sessionId, ctx: m.params.context });
  if (VERBOSE && m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
    if (text.indexOf('[凛狐') === 0) verbose(text.slice(0, 200));
  }
  if (m.method === 'Network.requestWillBeSent' && /\/api\/timedtext/.test(m.params.request.url)) {
    const q = new URL(m.params.request.url).searchParams;
    timedtext.set(m.params.requestId, { v: q.get('v'), mime: '' });
    const init = m.params.initiator || {};
    const frame = init.stack && init.stack.callFrames && init.stack.callFrames[0];
    if (VERBOSE) verbose('字幕请求 v=' + q.get('v') + ' lang=' + q.get('lang') + ' kind=' + (q.get('kind') || '-') + ' fmt=' + q.get('fmt') + ' type=' + m.params.type +
      ' 发起=' + init.type + (frame ? ' ' + (frame.functionName || '?') + ' @ ' + String(frame.url).split('/').pop() : '') + ' frame=' + String(m.params.frameId).slice(0, 8));
  }
  if (timedtext.has(m.params && m.params.requestId)) {
    const req = timedtext.get(m.params.requestId);
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      req.mime = r.mimeType;
      verbose('  字幕响应 ' + r.status + ' ' + r.mimeType + (r.fromServiceWorker ? ' 来自 Service Worker' : '') + (r.fromDiskCache ? ' 来自磁盘缓存' : ''));
    }
    if (m.method === 'Network.loadingFinished') {
      captionResponses.push({ v: req.v, mime: req.mime, bytes: m.params.encodedDataLength });
      verbose('  字幕加载完成 ' + m.params.encodedDataLength + ' 字节');
    }
    if (m.method === 'Network.loadingFailed') verbose('  字幕加载失败 ' + m.params.errorText + (m.params.canceled ? '（被取消）' : ''));
  }
  // 只记扩展自己的异常：YouTube 这类网页自己的报错不算
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const where = d.url || (d.stackTrace && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || '';
    if (!where || where.startsWith('chrome-extension://') || where.startsWith(ORIGIN)) {
      exceptions.push(((d.exception && d.exception.description) || d.text) + ' @ ' + where);
    }
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}

const { id: extId } = await send('Extensions.loadUnpacked', { path: ROOT });
const swTarget = await until(async () => {
  const { targetInfos } = await send('Target.getTargets');
  return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + extId));
});
if (!swTarget) throw new Error('找不到扩展的 service worker');
const sw = await attach(swTarget.targetId);
const swEval = (code) => evaluate(sw, '(async () => {' + code + '})()');
const readConfig = () => swEval("return (await chrome.storage.local.get('config')).config;");
const patchConfig = (patch) =>
  swEval("const c = (await chrome.storage.local.get('config')).config; Object.assign(c, " + JSON.stringify(patch) + '); await chrome.storage.local.set({ config: c }); return true;');

await swEval(
  'await chrome.storage.local.set({ config: ' +
    JSON.stringify({
      _v: 6,
      currentProvider: '__custom__',
      customProviders: [{ id: '__custom__', name: 'Fake' }, { id: 'custom:2', name: 'Two' }],
      providerConfig: {
        __custom__: { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-test', model: 'fake' },
        'custom:2': { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-two-secret', model: 'fake2' }
      },
      targetLang: 'zh-CN',
      mode: 'dual',
      lazy: false,
      thinkingMode: 'off',
      hoverCompare: true
    }) +
    ' }); return true;'
);

// 新开一个标签页，等内容脚本起来（它会在 <html> 上写 data-dt）
async function openTab(url, before) {
  const { targetId } = await send('Target.createTarget', { url: before ? 'about:blank' : url });
  const s = await attach(targetId);
  if (before) {
    await before(s);
    await send('Page.navigate', { url }, s);
  }
  await until(() => evaluate(s, "['off', 'on'].indexOf(document.documentElement.getAttribute('data-dt')) >= 0"), 30000);
  const tabId = await swEval('const t = await chrome.tabs.query({}); return t.filter((x) => x.url === ' + JSON.stringify(url) + ').map((x) => x.id).pop();');
  return { s, targetId, tabId };
}
const tabMsg = (tabId, msg) => swEval('return await chrome.tabs.sendMessage(' + tabId + ', ' + JSON.stringify(msg) + ', { frameId: 0 });');
const settled = (tab) =>
  until(async () => {
    const st = await tabMsg(tab.tabId, { type: 'dt:status' });
    return st && !st.busy && st;
  });
const pageEval = (tab, code) => evaluate(tab.s, '(() => {' + code + '})()');
// 在这个标签页顶层框架的内容脚本环境（扩展的隔离环境）里求值
async function contentEval(tab, expression) {
  const mine = contexts.filter((c) => c.session === tab.s && c.ctx.auxData && c.ctx.auxData.type === 'isolated' && c.ctx.origin === 'chrome-extension://' + extId);
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const top = await send('Runtime.evaluate', { contextId: mine[i].ctx.id, expression: 'window.top === window && !!window.__DT', returnByValue: true }, tab.s).catch(() => null);
    if (!top || !top.result || top.result.value !== true) continue;
    const r = await send('Runtime.evaluate', { contextId: mine[i].ctx.id, expression, awaitPromise: true, returnByValue: true }, tab.s);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  throw new Error('找不到内容脚本的执行环境');
}

// ---------------- 普通文章页 ----------------
async function articleChecks() {
  console.log('\n[普通文章页]');
  const a = await openTab(ORIGIN + '/page.html');
  await tabMsg(a.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(a, "return document.querySelectorAll('[data-dt-target]').length >= 3"));
  await settled(a);
  const dual = await pageEval(a, `return {
    p1: (document.querySelector('#p1 [data-dt-target]') || {}).textContent || '',
    brand: document.querySelector('#p2 .notranslate').textContent
  }`);
  check('双语：段落追加译文', dual.p1.startsWith('译:This is the first'), dual.p1);
  check('双语：notranslate 原样', dual.brand === 'Rimefox', dual.brand);

  // 刷新：主框架按标签页记忆恢复，iframe 不自己开始翻译
  await evaluate(a.s, 'location.reload(); true');
  await sleep(500);
  await until(() => pageEval(a, "return document.querySelectorAll('#p1 [data-dt-target]').length === 1"));
  await sleep(2500);
  const reloaded = await pageEval(a, `return {
    main: document.querySelectorAll('[data-dt-target]').length,
    frame: document.getElementById('f').contentDocument.querySelectorAll('[data-dt-target]').length
  }`);
  check('刷新后主框架自动恢复翻译', reloaded.main >= 3, reloaded.main);
  check('刷新后 iframe 没有自己开始翻译', reloaded.frame === 0, reloaded.frame);

  await tabMsg(a.tabId, { type: 'dt:setMode', mode: 'translation' });
  await until(() => pageEval(a, "return document.querySelectorAll('[data-dt-replaced]').length >= 3"));
  await settled(a);
  const only = await pageEval(a, `return { p2: document.getElementById('p2').textContent, brand: document.querySelector('#p2 .notranslate').textContent, p1: document.getElementById('p1').textContent }`);
  check('仅译文：段落原地替换', only.p1.startsWith('译:'), only.p1);
  check('仅译文：notranslate 的品牌名还在', only.brand === 'Rimefox' && only.p2.includes('译:'), only.p2);

  const bubble = (needle) =>
    until(() => pageEval(a, 'return Array.from(document.querySelectorAll(\'[data-dt-ui]\')).map((n) => n.textContent).find((t) => t.includes(' + JSON.stringify(needle) + ')) || ""'));
  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'Paris CITE is the capital.' });
  const cite = await bubble('巴黎');
  check('划词：纯文本回复里的引注 [1] 不会顶替译文', cite && cite.includes('巴黎是首都[1]。'), cite);
  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'SPLIT this into sentences please.' });
  const split = await bubble('Hello.');
  check('划词：拆成几句时句间有空格', split && split.includes('Hello. How are you?'), split);

  // 划词气泡「加入术语表」：两栏表单 → 后台 glossary:add → 配置；同名原文换了译法先问是否覆盖
  console.log('\n[加入术语表]');
  const cfgOf = () => swEval("return (await chrome.storage.local.get('config')).config;");
  const termOf = async (target) => {
    const cfg = await cfgOf();
    const list = cfg && Array.isArray(cfg.glossary) ? cfg.glossary : [];
    return list.find((one) => one.source === 'Rebranded term' && one.target === target) || null;
  };
  const fillTermForm = (target) =>
    pageEval(
      a,
      `const bubble = Array.from(document.querySelectorAll('[data-dt-ui]')).find((n) => n.textContent.includes('Glossary term goes here.'));
      if (!bubble) return 'no-bubble';
      const add = bubble.querySelector('span[aria-label="加入术语表"]');
      if (!add) return 'no-button';
      add.click();
      const inputs = Array.from(bubble.querySelectorAll('input'));
      if (inputs.length < 2) return 'no-form';
      inputs[0].value = 'Rebranded term';
      inputs[1].value = ` + JSON.stringify(target) + `;
      const save = Array.from(bubble.querySelectorAll('button')).find((n) => n.textContent === '保存');
      if (!save) return 'no-save';
      save.click();
      return 'clicked';`
    );

  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'Glossary term goes here.' });
  await bubble('译:Glossary term goes here.');
  const firstTry = await fillTermForm('凛狐术语');
  const stored = await until(() => termOf('凛狐术语'), 8000);
  check('收录：原文和译法都能改，改完写进配置', firstTry === 'clicked' && !!stored, firstTry + ' / ' + JSON.stringify(stored));

  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'Glossary term goes here.' });
  await bubble('译:Glossary term goes here.');
  const secondTry = await fillTermForm('另一个译法');
  const asked = await until(
    () =>
      pageEval(
        a,
        `const bubble = Array.from(document.querySelectorAll('[data-dt-ui]')).find((n) => n.textContent.includes('已有译法'));
        if (!bubble) return '';
        const ow = Array.from(bubble.querySelectorAll('button')).find((n) => n.textContent === '覆盖');
        return ow && ow.style.display !== 'none' ? 'asked' : '';`
      ),
    8000
  );
  check('同名原文不同译法：先问一句，没确认就不改', secondTry === 'clicked' && asked === 'asked', secondTry + ' / ' + asked);
  const notYet = await termOf('另一个译法');
  check('没点「覆盖」之前旧译法还在', !notYet && !!(await termOf('凛狐术语')), JSON.stringify(notYet));

  const confirmed = await pageEval(
    a,
    `const bubble = Array.from(document.querySelectorAll('[data-dt-ui]')).find((n) => n.textContent.includes('已有译法'));
    if (!bubble) return 'no-bubble';
    const ow = Array.from(bubble.querySelectorAll('button')).find((n) => n.textContent === '覆盖');
    if (!ow) return 'no-overwrite';
    ow.click();
    return 'clicked';`
  );
  const replaced = await until(() => termOf('另一个译法'), 8000);
  check('点「覆盖」后换成新译法', confirmed === 'clicked' && !!replaced && !(await termOf('凛狐术语')), confirmed + ' / ' + JSON.stringify(replaced));

  // 后面的设置页用例假设术语表是空的（它要验证「导入配置带着术语表一起进来」）：把这段留下的条目清掉
  await patchConfig({ glossary: [] });

  await tabMsg(a.tabId, { type: 'dt:toggle' });
  await sleep(600);
  const restored = await pageEval(a, `return { p1: document.getElementById('p1').textContent, p2: document.getElementById('p2').textContent, left: document.querySelectorAll('[data-dt-target],[data-dt-src],[data-dt-collapsed]').length }`);
  check(
    '还原：原文逐字恢复、没有残留标记',
    restored.p1 === 'This is the first paragraph of the article with enough words to translate.' && restored.p2 === 'Hello Rimefox world' && restored.left === 0,
    JSON.stringify(restored)
  );

  console.log('\n[缓存落盘]');
  await sleep(3200); // LIMITS.flushMs = 2500
  const keys = await swEval('return { s: Object.keys(await chrome.storage.session.get(null)), l: Object.keys(await chrome.storage.local.get(null)) };');
  check('session 区是分段格式', keys.s.includes('dt.cache.v1.s.index') && keys.s.some((k) => /^dt\.cache\.v1\.s\.\d+$/.test(k)) && !keys.s.includes('dt.cache.v1'), keys.s.filter((k) => k.startsWith('dt.cache')).join(','));
  check('local 区是分段格式', keys.l.includes('dt.cache.v1.l.index') && !keys.l.includes('dt.cache.v1'), keys.l.filter((k) => k.startsWith('dt.cache')).join(','));

  console.log('\n[配置广播]');
  const b = await openTab(ORIGIN + '/page.html?b');
  await tabMsg(b.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(b, "return document.querySelectorAll('[data-dt-target]').length >= 3"));
  await settled(b);
  await patchConfig({ mode: 'translation' });
  await until(() => pageEval(b, "return document.documentElement.getAttribute('data-dt-mode') === 'translation' && document.querySelectorAll('[data-dt-replaced]').length >= 3"));
  await settled(b);
  const mixed = await pageEval(b, `return { mode: document.documentElement.getAttribute('data-dt-mode'), appended: document.querySelectorAll('[data-dt-target]').length, replaced: document.querySelectorAll('[data-dt-replaced]').length }`);
  check('别处改成仅译文：本页整页重建，不再混着追加的译文', mixed.mode === 'translation' && mixed.appended === 0 && mixed.replaced >= 3, JSON.stringify(mixed));
  await tabMsg(b.tabId, { type: 'dt:toggle' });

  console.log('\n[简繁]');
  await patchConfig({ targetLang: 'zh-TW', mode: 'dual' });
  await sleep(500);
  const c = await openTab(ORIGIN + '/simp.html');
  await tabMsg(c.tabId, { type: 'dt:toggle' });
  const hant = await until(() => pageEval(c, "const n = document.querySelector('#s1 [data-dt-target]'); return n ? n.textContent : ''"), 10000);
  check('简体页面选繁體中文：照常送翻并插入译文', hant && hant.startsWith('繁:'), hant || '没有译文');
  await tabMsg(c.tabId, { type: 'dt:toggle' });
  await patchConfig({ targetLang: 'zh-CN' });

  console.log('\n[思考参数]');
  check('reasoning_effort 被拒绝过之后不再发（首批并发的那几个除外）', stats.lateRejected === 0 && stats.withEffort < stats.requests, 'withEffort=' + stats.withEffort + ' late=' + stats.lateRejected + ' requests=' + stats.requests);
}

// ---------------- 设置页 ----------------

// ---------------- 0.9.1 段落单元 / Ruby / 悬停 ----------------
async function paragraphChecks() {
  console.log('\n[段落单元 / Ruby]');

  // 青空文库式：一个容器里连续 <br> 分段
  const a = await openTab(ORIGIN + '/aozora.html');
  const before = await pageEval(a, "return document.getElementById('mt').innerHTML");
  await tabMsg(a.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(a, "return document.querySelectorAll('#mt [data-dt-target]').length === 3"), 20000);
  await settled(a);
  check('青空文库：3 个段落各有一个译文节点', !!ready, ready);

  const layout = await pageEval(a, "return Array.from(document.getElementById('mt').childNodes).map(function (n) {\n    if (n.nodeType === 3) return n.nodeValue.trim() ? 'T' : '';\n    if (n.tagName === 'BR') return 'BR';\n    if (n.hasAttribute('data-dt-target')) return n.textContent.indexOf('译:') === 0 ? 'TGT' : 'TGT:' + n.textContent.slice(0, 12);\n    return 'X';\n  }).filter(Boolean)");
  const seqOk = JSON.stringify(layout) === JSON.stringify(['T', 'TGT', 'BR', 'BR', 'T', 'TGT', 'BR', 'BR', 'T', 'TGT']);
  check('青空文库：译文跟在各自段落后面，不堆到页面末尾', seqOk, JSON.stringify(layout));

  const recollect = await contentEval(a, "window.__DT.collect(document.getElementById('mt')).length");
  check('青空文库：已翻译段落不会被重复收集', recollect === 0, recollect);

  const hover = await contentEval(a, "(function () {\n    var t = document.querySelectorAll('#mt [data-dt-target]')[1];\n    if (!t || !t.firstChild) return { error: 'no-target' };\n    var r = document.createRange();\n    r.setStart(t.firstChild, 1);\n    r.setEnd(t.firstChild, Math.min(4, t.firstChild.nodeValue.length));\n    var rect = r.getBoundingClientRect();\n    window.__DT.hover.updateAt(rect.left + 1, rect.top + 1, t.firstChild);\n    var src = CSS.highlights.get('dt-hover-src');\n    var tgt = CSS.highlights.get('dt-hover-target');\n    var tip = document.querySelector('.dt-hover-tip');\n    return {\n      src: src ? Array.from(src).map(function (x) { return x.toString(); }).join('|') : '',\n      tgt: tgt ? Array.from(tgt).map(function (x) { return x.toString(); }).join('|') : '',\n      tip: tip && !tip.hidden ? tip.innerText : ''\n    };\n  })()");
  const alignInfo = await contentEval(a, "(function () {\n    var t = document.querySelectorAll('#mt [data-dt-target]')[1];\n    var u = window.__DT.unitOfNode(t.firstChild);\n    return { align: !!(u && u.align), want: !!(u && u.wantAlign), sentences: u ? u.sentences.length : -1, ali: u && u.ali ? u.ali.length : -1, first: u && u.ali ? u.ali[0] : null };\n  })()");
  check('青空文库·对齐：结构化 parts 通过校验（句级映射可用）', alignInfo && alignInfo.align, JSON.stringify(alignInfo));
  check('青空文库·请求：align 模式提示词确实发给模型', stats.aligned > 0, 'aligned=' + stats.aligned);
  check('青空文库·悬停：译文上只高亮这一句并显示对应原文', !!hover && hover.tgt && hover.tip && hover.src, JSON.stringify(hover));

  await tabMsg(a.tabId, { type: 'dt:toggle' });
  const after = await pageEval(a, "return document.getElementById('mt').innerHTML");
  check('青空文库：关闭翻译后原文逐字恢复', after === before, after === before ? '' : (after || '').slice(0, 120));

  // Pixiv 式：pre-wrap 容器 + span/<br> 对白 + Ruby
  const b = await openTab(ORIGIN + '/pixiv.html');
  const pixivBefore = await pageEval(b, "return document.getElementById('novel').innerHTML");
  await tabMsg(b.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(b, "return document.querySelectorAll('#novel [data-dt-target]').length >= 3"), 20000);
  await settled(b);

  await tabMsg(b.tabId, { type: 'dt:setMode', mode: 'translation' });
  const rubyReady = await until(() => pageEval(b, "return document.querySelectorAll('#np2 [data-dt-rt-hidden]').length === 1"), 20000);
  await settled(b);
  const ruby = await pageEval(b, "return (function () {\n    var p = document.getElementById('np2');\n    var rt = p.querySelector('rt');\n    return {\n      hidden: !!rt && getComputedStyle(rt).display === 'none',\n      text: p.innerText,\n      rubyText: p.querySelector('ruby') ? p.querySelector('ruby').textContent : '',\n      target: (p.querySelector('[data-dt-target]') || {}).textContent || ''\n    };\n  })()");
  check('Pixiv·仅译文：Ruby 注音被隐藏，译文不写进 ruby', !!rubyReady && ruby.hidden && !/らしょうもん|あめ/.test(ruby.text) && ruby.rubyText.indexOf('译:') < 0, JSON.stringify(ruby));
  check('Pixiv·仅译文：译文显示在段落位置', ruby.target.startsWith('译:') && ruby.text.indexOf('译:') >= 0, JSON.stringify(ruby));

  await tabMsg(b.tabId, { type: 'dt:toggle' });
  const pixivAfter = await pageEval(b, "return document.getElementById('novel').innerHTML");
  check('Pixiv：关闭翻译后 Ruby / 结构逐字恢复', pixivAfter === pixivBefore, pixivAfter === pixivBefore ? '' : (pixivAfter || '').slice(0, 160));
}

async function optionsChecks() {
  console.log('\n[设置页]');
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/options/index.html' });
  const o = await attach(targetId);
  await until(() => evaluate(o, "!!document.getElementById('provider') && document.getElementById('provider').options.length > 3"));
  await sleep(800);
  await evaluate(o, "(() => { const sel = document.getElementById('provider'); sel.value = 'custom:2'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()");
  await sleep(300);
  await evaluate(o, "document.getElementById('deleteProvider').click(); true");
  await sleep(300);
  // 下拉框就是「当前服务商」：删完页面会切回 DeepSeek（没有 Key）。像用户一样选回原来的再保存，
  // 否则后面的检查都没有可用的 Key（字幕运行时没 Key 就不接管）
  await evaluate(o, "(() => { const sel = document.getElementById('provider'); sel.value = '__custom__'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()");
  await sleep(300);
  await evaluate(o, "document.getElementById('save').click(); true");
  await sleep(1200);
  const afterDelete = await readConfig();
  check('删除后当前服务商仍是原来那个（有 Key）', afterDelete.currentProvider === '__custom__', afterDelete.currentProvider);
  check(
    '删除自定义服务商：槽位连同 Key 一起删掉',
    !afterDelete.providerConfig['custom:2'] && !JSON.stringify(afterDelete).includes('sk-two-secret') && !afterDelete.customProviders.some((p) => p.id === 'custom:2'),
    Object.keys(afterDelete.providerConfig).join(',')
  );

  const importFile = path.join(WORK, 'import.json');
  fs.writeFileSync(importFile, JSON.stringify({ app: 'rimefox', schema: 1, config: { targetLang: 'zh-CN', theme: 'underline', mode: 'dual', glossary: [{ source: 'Rimefox', target: '凛狐' }] } }));
  const { root } = await send('DOM.getDocument', {}, o);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importFile' }, o);
  await send('DOM.setFileInputFiles', { files: [importFile], nodeId }, o);
  const imported = await until(async () => {
    const cfg = await readConfig();
    return cfg.glossary && cfg.glossary.length ? cfg : null;
  }, 8000);
  check('导入配置：术语表一起导入', imported && imported.glossary[0].target === '凛狐', await evaluate(o, "document.getElementById('cfgResult').textContent"));
  check('导入后本机服务商的 Key 还在', imported && imported.providerConfig.__custom__ && imported.providerConfig.__custom__.apiKey === 'sk-test', imported && Object.keys(imported.providerConfig).join(','));
  await evaluate(o, "document.getElementById('refreshCache') && document.getElementById('refreshCache').click(); true");
  await sleep(800);
  const cacheText = await evaluate(o, "(document.getElementById('cacheStats') || {}).textContent || ''");
  check('缓存统计能读出', /\d+ 条/.test(cacheText) && !/读取失败/.test(cacheText), cacheText.slice(0, 120));
  // 后面的检查不要带着这张术语表跑
  await patchConfig({ glossary: [] });
}

// ---------------- YouTube 真实页面 ----------------
// 静音播放、打开 CC，并切到英文字幕轨：YouTube 会按网络所在地区 / 界面语言自动选字幕（比如中文），
// 字幕本来就是目标语言（简体中文）时扩展按设计不接管，所以固定拿英文字幕翻成中文（最常见的用法）
async function playWithEnglishCaptions(s) {
  await evaluate(s, `(() => { const v = document.querySelector('.html5-video-player video'); v.muted = true; v.play().catch(() => {}); return true; })()`);
  await until(() => evaluate(s, "!!document.querySelector('.ytp-subtitles-button')"), 15000);
  await evaluate(s, `(() => {
    const b = document.querySelector('.ytp-subtitles-button');
    if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
    document.getElementById('movie_player').setOption('captions', 'track', { languageCode: 'en' });
    return true;
  })()`);
  const track = () => evaluate(s, "((document.getElementById('movie_player').getOption('captions', 'track') || {}).languageCode || '')");
  return (await until(async () => ((await track()) === 'en' ? 'en' : ''), 10000)) || track();
}

// 需要能访问 YouTube，视频要有人工字幕。字幕地址带播放器生成的令牌，只能等播放器自己请求、由钩子转给扩展
// 等双语字幕叠层出现（第二行是假接口给的「译:…」）。中途遇到广告（播放器带 ad-showing）：
// 能跳过就点跳过，跳不过就等它播完，播完重新切到英文字幕；顺带记下播广告时叠层有没有显示出来
async function waitForBilingual(s, ms) {
  let sawAd = false;
  let adOverlay = false;
  let afterAd = false;
  let lastAd = null;
  const shown = await until(async () => {
    const st = await evaluate(s, `(() => {
      const p = document.getElementById('movie_player');
      const ad = !!p && p.classList.contains('ad-showing');
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
      if (ad && skip) skip.click();
      const o = document.querySelector('.rimefox-subs');
      const on = !!o && o.style.display !== 'none';
      return { ad, on, orig: on && o.children[0] ? o.children[0].textContent : '', trans: on && o.children[1] ? o.children[1].textContent : '' };
    })()`);
    if (st.ad !== lastAd) {
      verbose(st.ad ? '广告开始' : '广告结束 / 正片');
      lastAd = st.ad;
    }
    if (st.ad) {
      sawAd = true;
      if (st.on) adOverlay = true;
      return null;
    }
    if (sawAd && !afterAd) {
      afterAd = true;
      await playWithEnglishCaptions(s);
    }
    return st.trans.indexOf('译:') === 0 ? st : null;
  }, ms, 500);
  return { shown, sawAd, adOverlay };
}

async function youtubeChecks(url) {
  console.log('\n[YouTube 字幕]');
  await patchConfig({ subtitleTranslate: true, targetLang: 'zh-CN', debug: VERBOSE });
  // 无头 Chrome 的 UA 带 HeadlessChrome，YouTube 可能不给正常播放器：换成普通 Chrome 的 UA
  const ua = version['User-Agent'].replace('HeadlessChrome', 'Chrome');
  const yt = await openTab(url, async (s) => {
    await send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en' }, s);
    await send('Network.enable', {}, s); // 看 YouTube 给的字幕回包是不是空的
    if (VERBOSE) {
      // 页面主环境的字幕钩子和内容脚本之间的每一条消息（字幕回包 / 重放请求）
      await send('Page.enable', {}, s);
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: "addEventListener('message', (e) => { const d = e.data; if (d && (d.source === 'rimefox-yt' || d.source === 'rimefox-ext')) console.log('[凛狐·e2e] 消息 ' + d.source + ' ' + d.type + (d.replay ? ' replay' : '') + (d.url ? ' v=' + new URL(d.url).searchParams.get('v') : '') + (d.body ? ' ' + d.body.length + ' 字' : '')); });"
      }, s);
    }
  });
  const player = await until(() => evaluate(yt.s, "!!document.querySelector('.html5-video-player video')"), 30000);
  check('打开视频页：播放器加载出来', player, url);
  if (!player) return;
  const sentBefore = stats.texts;
  const track = await playWithEnglishCaptions(yt.s);
  check('切到英文字幕轨', track === 'en', track || '没有英文字幕轨');
  // YouTube 偶尔给字幕请求回 200 + 空内容（text/html，几十字节；字幕地址的 PO 令牌没通过，无头浏览器时有发生）：
  // 原生字幕那次也是空的，扩展没东西可翻。这种情况刷新重试，最多 3 次；拿到过正常的 json 回包还没出双语字幕才算扩展的问题
  const vid = new URL(url).searchParams.get('v');
  let first = null;
  let emptyOnly = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const mark = captionResponses.length;
    first = await waitForBilingual(yt.s, 120000);
    if (first.shown) break;
    const got = captionResponses.slice(mark).filter((r) => r.v === vid);
    emptyOnly = got.length > 0 && got.every((r) => r.mime !== 'application/json' || r.bytes < 200);
    if (!emptyOnly) break;
    console.log('    （第 ' + attempt + ' 次打开 YouTube 回了空字幕，刷新重试）');
    await evaluate(yt.s, 'location.reload(); true');
    await sleep(1500);
    await until(() => evaluate(yt.s, "!!document.querySelector('.html5-video-player video')"), 30000);
    await playWithEnglishCaptions(yt.s);
  }
  const overlay = first.shown;
  check(
    '打开 CC：双语字幕叠层出现（原文 + 译文）',
    overlay && overlay.orig && overlay.trans === '译:' + overlay.orig,
    overlay ? overlay.orig + ' / ' + overlay.trans : emptyOnly ? '3 次打开 YouTube 都回了空字幕（不是扩展的问题，换个时间或加 --headed 重跑）' : '2 分钟内没有出现带译文的字幕'
  );
  const hidden = await evaluate(yt.s, "!!document.querySelector('.html5-video-player.rimefox-subs-on')");
  check('接管期间原生字幕被收起（不两套叠在一起）', hidden, hidden);
  const sentFirst = stats.texts - sentBefore;
  check('字幕按批送翻（第一次打开会请求）', sentFirst > 0, '送翻 ' + sentFirst + ' 条');
  if (!overlay) return;

  // 字幕译文进了缓存：在页面的内容脚本里把刚才显示的那句再送翻一次，后台应直接从缓存给、不发请求。
  // （不用刷新页面验证：刷新后常有跳不过的贴片广告，一等就是几分钟）
  await sleep(3200); // 等缓存落盘
  const before = stats.texts;
  const again = await contentEval(yt, 'window.__DT.send(' + JSON.stringify({ type: 'translate', texts: [overlay.orig], target: 'zh-CN', style: 'plain' }) + ')');
  check(
    '字幕译文进了缓存：同一句再送翻直接命中、不发请求',
    again && again.ok && again.cached === 1 && again.results[0] === overlay.trans && stats.texts === before,
    JSON.stringify({ cached: again && again.cached, result: again && again.results && again.results[0], newRequests: stats.texts - before })
  );
  const keys = await swEval('return Object.keys(await chrome.storage.session.get(null)).filter((k) => k.indexOf(\'dt.cache\') === 0);');
  check('字幕译文落盘到分段缓存', keys.includes('dt.cache.v1.s.index'), keys.join(','));

  // 刷新后常有贴片广告：播广告时不能把正片字幕叠在广告上（遇到广告才算覆盖到）
  await evaluate(yt.s, 'location.reload(); true');
  await sleep(1500);
  await until(() => evaluate(yt.s, "!!document.querySelector('.html5-video-player video')"), 30000);
  await playWithEnglishCaptions(yt.s);
  const second = await waitForBilingual(yt.s, 90000);
  const sawAd = first.sawAd || second.sawAd;
  check('播广告时没有把正片字幕叠在广告上', !(first.adOverlay || second.adOverlay), sawAd ? '中途播了广告' : '这次没遇到广告，没覆盖到');
  await patchConfig({ subtitleTranslate: false });
}

// ---------------- 自检页 ----------------
// AGENTS.md 要求改 dom.js 前后「selftest/index.html 全部通过」。这里顺手跑一遍，
// 发版前不用再手动打开 chrome-extension://<id>/selftest/index.html
async function selftestChecks() {
  console.log('\n[自检页]');
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/selftest/index.html' });
  const s = await attach(targetId);
  // Runtime.evaluate 里不能直接写 return：整段包成 IIFE（2026-10 踩过：表达式非法，被 until 吞掉 90 秒）
  const summary = await until(
    () =>
      evaluate(
        s,
        "(() => { const n = document.getElementById('summary'); return n && n.textContent.indexOf('运行中') < 0 ? n.textContent.trim() : ''; })()"
      ),
    90000
  );
  const failed = await evaluate(
    s,
    "Array.from(document.querySelectorAll('#list li')).filter((li) => li.querySelector('.no')).map((li) => li.textContent.replace(/\\s+/g, ' ').slice(0, 180))"
  );
  check('自检页全部通过', !!summary && summary.indexOf('全部通过') >= 0, summary || '没等到结果');
  check('自检页没有失败项', Array.isArray(failed) && failed.length === 0, (failed || []).slice(0, 5).join(' | '));
  try {
    await send('Target.closeTarget', { targetId });
  } catch (err) {
    /* 已经关了 */
  }
}

let crashed = null;
// ---------------- 输入框翻译 ----------------
// 真实按键（CDP）走一遍：textarea / 只翻选区 / Ctrl+Z / 受控输入框 / contenteditable / 密码框 / 不写缓存
async function inputChecks() {
  console.log('\n[输入框翻译]');
  const tab = await openTab(ORIGIN + '/input.html');
  const pressAltI = async () => {
    const base = { modifiers: 1, key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, tab.s);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.s);
  };
  const valueOf = (id) => pageEval(tab, 'return document.getElementById(' + JSON.stringify(id) + ').value');
  const waitValue = (id, prefix) =>
    until(
      () =>
        pageEval(
          tab,
          'const v = document.getElementById(' + JSON.stringify(id) + ').value; return v.indexOf(' + JSON.stringify(prefix) + ') === 0 ? v : "";'
        ),
      20000
    );
  const setBox = (id, value, start, end) =>
    pageEval(
      tab,
      'const el = document.getElementById(' + JSON.stringify(id) + '); el.value = ' + JSON.stringify(value) +
        '; el.focus(); el.setSelectionRange(' + start + ', ' + end + '); return true;'
    );

  // 1) textarea 整个框：Alt+I 翻完原地写回；目标语言跟随页面（<html lang="en"> → 提示词里是 English）
  await pageEval(tab, "document.getElementById('ta').focus(); return true");
  await pressAltI();
  const whole = await waitValue('ta', '译:');
  check('textarea：按 Alt+I 翻整个框并原地写回', whole === '译:Hello draft line', whole || '没有写回');
  check(
    '目标语言跟随页面：<html lang="en"> → 提示词里是 English',
    /English/.test(stats.lastSystem),
    (stats.lastSystem.match(/目标语言（[^）]*）/) || [''])[0]
  );

  // 2) 撤销：写入走 execCommand，Ctrl+Z 能回到原文
  const undone = await pageEval(tab, "document.getElementById('ta').focus(); document.execCommand('undo'); return document.getElementById('ta').value;");
  check('撤销：Ctrl+Z 回到原文', undone === 'Hello draft line', undone);

  // 3) 有选区只翻选区
  await setBox('ta', 'One two three', 4, 7);
  await pressAltI();
  const onlySel = await waitValue('ta', 'One 译:');
  check('有选区只翻选区，别的文字不动', onlySel === 'One 译:two three', onlySel || '没有写回');

  // 4) 不写缓存：同一段重置后再翻，还是要发一次新请求（输入框里是草稿）
  await setBox('ta', 'Cache me not', 12, 12);
  await pressAltI();
  await waitValue('ta', '译:Cache me not');
  const afterFirst = stats.texts;
  await setBox('ta', 'Cache me not', 12, 12);
  await pressAltI();
  await waitValue('ta', '译:Cache me not');
  check('输入框翻译不进缓存：同一段再翻仍是一次新请求', stats.texts > afterFirst, '第一次后 ' + afterFirst + ' → 第二次后 ' + stats.texts);

  // 5) 模拟 React 受控输入框：必须收到 input 事件，state 跟着变
  await pageEval(tab, "document.getElementById('rx').focus(); return true");
  await pressAltI();
  const controlled = await until(
    () =>
      pageEval(
        tab,
        "const el = document.getElementById('rx'); return el.getAttribute('data-state') === '译:Controlled input' ? el.value : '';"
      ),
    20000
  );
  check('受控输入框：收到 input 事件，state 跟着变', controlled === '译:Controlled input', controlled || '受控输入框没收到改动');

  // 6) contenteditable 富文本：整段选中后按快捷键
  await pageEval(
    tab,
    "const ce = document.getElementById('ce'); ce.focus(); const r = document.createRange(); r.selectNodeContents(ce); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;"
  );
  await pressAltI();
  const rich = await until(
    () => pageEval(tab, "const el = document.getElementById('ce'); return el.textContent.indexOf('译:') === 0 ? el.textContent : '';"),
    20000
  );
  check('contenteditable：整段替换成译文', rich === '译:Editable rich text', rich || '富文本没被替换');

  // 7) 密码框一律不碰
  await pageEval(tab, "document.getElementById('pw').focus(); return true");
  await pressAltI();
  await sleep(800);
  const pw = await valueOf('pw');
  check('密码框不翻译', pw === 'secret', pw);
}

// ---------------- 0.9.3 悬浮入口拖拽 ----------------
async function dockChecks() {
  console.log('\n[悬浮入口拖拽]');
  await patchConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'right', dockPos: null });
  const d = await openTab(ORIGIN + '/page.html?dock');
  await until(() => pageEval(d, "return !!document.getElementById('dt-dock')"));
  await sleep(400);
  const rectOf = () =>
    pageEval(d, `const h = document.getElementById('dt-dock'); const r = h.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), vw: innerWidth, side: h.getAttribute('data-side') }`);
  async function dragTo(tx, ty) {
    const r = await rectOf();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height - 20; // 小球在 dock 底部
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse' }, d.s);
    for (let i = 1; i <= 6; i += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + ((tx - sx) * i) / 6, y: sy + ((ty - sy) * i) / 6, button: 'left', pointerType: 'mouse' }, d.s);
      await sleep(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, pointerType: 'mouse' }, d.s);
    await sleep(400);
  }
  await dragTo(24, 320);
  const r1 = await rectOf();
  check('拖到左边缘松手：吸附到左边、side 翻转', r1.left === 0 && r1.side === 'left', JSON.stringify(r1));
  await evaluate(d.s, 'location.reload(); true');
  await until(() => pageEval(d, "return !!document.getElementById('dt-dock')"));
  await sleep(400);
  const r2 = await rectOf();
  check('位置写进配置：刷新页面后仍贴左边', r2.left === 0 && r2.side === 'left', JSON.stringify(r2));
  await dragTo(Math.round(r2.vw / 2), 240);
  const r3 = await rectOf();
  check('页面中间松手：自由悬浮、不贴任何边', r3.left > 80 && r3.left < r3.vw - 80, JSON.stringify(r3));
  await patchConfig({ dockEnabled: false, dockPos: null });
  await sleep(300);
}

try {
  if (!flag('--youtube-only')) {
    await articleChecks();
    await paragraphChecks();
    await dockChecks();
    await optionsChecks();
    await selftestChecks();
    await inputChecks();
  }
  if (YOUTUBE) await youtubeChecks(YOUTUBE);
} catch (err) {
  crashed = err;
  check('检查脚本本身跑完', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
}

console.log('\n[异常]');
check('扩展页面 / 测试页 / service worker 没有抛出未捕获异常', exceptions.length === 0, exceptions.slice(0, 5).join(' | '));

console.log('\n假接口：请求 ' + stats.requests + ' 次、送翻 ' + stats.texts + ' 条、带 reasoning_effort 被拒 ' + stats.withEffort + ' 次');
const failed = results.filter((r) => !r.ok);
console.log((results.length - failed.length) + ' / ' + results.length + ' 通过');
fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify({ browser: version.Browser, results, stats: { ...stats, sent: stats.sent.length }, exceptions }, null, 2));
console.log('结果：' + path.join(WORK, 'result.json'));

try {
  await send('Browser.close');
} catch (err) {
  /* 已经关了 */
}
browser.kill();
server.close();
if (!flag('--keep')) {
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed.length || crashed ? 1 : 0);
