#!/usr/bin/env node
// 生成 Edge 商店截图（1280×800，真实扩展 + 本地假接口，不需要 API Key）：
//   node tools/screenshot-en.mjs            英文商店：英文界面 + 日文文章→英文译文，输出 docs/screenshots/en/
//   node tools/screenshot-en.mjs --lang zh  中文商店：中文界面 + 英文文章→中文译文，输出 docs/screenshots/
//   --browser <msedge.exe>  --out <目录>  --keep（保留临时用户目录）
// 脚本用独立的临时用户配置，启动时自己写好界面语言 / 目标语言，不需要手动改设置页。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const ROOT = argv.includes('--root')
  ? path.resolve(argv[argv.indexOf('--root') + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const flag = (name) => argv.includes(name);
const DEFAULT_BROWSER = {
  darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  linux: 'microsoft-edge',
  win32: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
}[process.platform];
const BROWSER = option('--browser') || process.env.RIMEFOX_BROWSER || DEFAULT_BROWSER;

const LANG = option('--lang') === 'zh' ? 'zh' : 'en';
const ZH = LANG === 'zh';
const OUT = path.resolve(
  option('--out') || (ZH ? path.join(ROOT, 'docs', 'screenshots') : path.join(ROOT, 'docs', 'screenshots', 'en'))
);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-shot-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const DEBUG_PORT = 19900 + Math.floor(Math.random() * 400);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const W = 1280;
const H = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      /* 还没好 */
    }
    await sleep(step);
  }
  return null;
}

// ---------------- 示例译文（假接口只认识这些句子） ----------------
const MAP_EN = [
  ['フィールドノート', 'FIELD NOTES · 5 MIN READ'],
  ['ゆっくりとした朝のための手引き', 'A Field Guide to Slow Mornings'],
  ['一日の最初の一時間', 'Why the first hour of the day deserves a little more attention.'],
  ['マラ・エリソン', 'By Mara Ellison · March 12, 2026'],
  ['目を覚ました時点', 'Most of us wake up already behind.'],
  ['ゆっくりした朝とは', 'A slow morning is not about doing less. It is about choosing what deserves your attention before the world starts asking for it.'],
  ['朝の光は', 'Morning light slowly washes away the tiredness of yesterday.'],
  ['最初の一時間だけは', 'That is why the first hour of the day deserves to stay undisturbed.'],
  ['関連記事', 'RELATED'],
  ['目的地のない散歩', 'A walk without a destination'],
  ['静かに、意図して', 'Quietly, deliberately'],
  ['雨の日の読書', 'Reading on a rainy day']
];
const MAP_ZH = [
  ['FIELD NOTES', '田野笔记 · 阅读 5 分钟'],
  ['A Field Guide to Slow Mornings', '慢早晨的田野指南'],
  ['Why the first hour', '为什么一天里的第一个小时，值得多一点关注。'],
  ['By Mara Ellison', '作者：玛拉·埃里森 · 2026 年 3 月 12 日'],
  ['Most of us wake up', '我们中的大多数人，一醒来就已经落后了。'],
  ['A slow morning is not about', '慢早晨并不是少做一点事，而是在世界开始向你索取之前，先选择什么值得你的注意力。'],
  ['Morning light slowly', '晨光一点点洗去昨日的疲惫。'],
  ['That is why the first hour', '正因如此，第一个小时才值得不被打扰。'],
  ['RELATED', '相关阅读'],
  ['A walk without a destination', '没有目的地的散步'],
  ['Quietly, deliberately', '安静地留意'],
  ['Reading on a rainy day', '雨天的阅读'],
  ['Essays', '随笔'],
  ['Notes', '笔记'],
  ['About', '关于']
];
const MAP = ZH ? MAP_ZH : MAP_EN;
function translate(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  for (const [from, to] of MAP) if (s.includes(from)) return to;
  return s;
}

// ---------------- 演示页：英文站点外壳 + 日文正文（英文商店）/ 英文正文（中文商店） ----------------
function demo(dark) {
  const bg = dark ? '#14161a' : '#f7f5f1';
  const fg = dark ? '#e9e7e2' : '#1b1b1b';
  const muted = dark ? '#9aa0a6' : '#6b6b6b';
  const line = dark ? '#2a2d33' : '#ded9cf';
  return `<!doctype html><html lang="${ZH ? 'en' : 'ja'}"><head><meta charset="utf-8">
<title>Northwind Journal</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${bg};color:${fg};font:16px/1.6 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  .wrap{max-width:1160px;margin:0 auto;padding:0 32px}
  header{border-bottom:1px solid ${line};padding:22px 0;display:flex;align-items:center;justify-content:space-between}
  .brand{font:700 17px/1 Georgia,"Times New Roman",serif;letter-spacing:.14em}
  nav a{color:${muted};text-decoration:none;margin-left:26px;font-size:14px}
  main{display:grid;grid-template-columns:1fr 300px;gap:64px;padding:44px 0 60px}
  .kicker{color:${muted};font-size:12px;letter-spacing:.18em;text-transform:uppercase;margin:0 0 14px}
  h1{font:700 46px/1.18 Georgia,"Times New Roman",serif;margin:0 0 18px;letter-spacing:-.01em}
  .deck{font-size:19px;line-height:1.55;color:${muted};margin:0 0 22px}
  .byline{font-size:13px;color:${muted};margin:0 0 26px}
  hr{border:0;border-top:1px solid ${line};margin:0 0 26px}
  article p{font-size:18px;line-height:1.95;margin:0 0 22px}
  aside{border-left:1px solid ${line};padding-left:32px;align-self:start}
  aside h2{font-size:12px;letter-spacing:.18em;color:${muted};margin:0 0 16px;font-weight:600}
  aside a{display:block;color:${fg};text-decoration:none;font-size:15px;margin:0 0 14px}
  footer{border-top:1px solid ${line};color:${muted};font-size:12px;padding:18px 0 40px}
</style></head><body>
<div class="wrap">
  <header>
    <div class="brand">NORTHWIND JOURNAL</div>
    <nav><a href="#">Essays</a><a href="#">Notes</a><a href="#">About</a></nav>
  </header>
  <main>
    <article>
      <p class="kicker">${ZH ? 'FIELD NOTES · 5 MIN READ' : 'フィールドノート・読了 5 分'}</p>
      <h1>${ZH ? 'A Field Guide to Slow Mornings' : 'ゆっくりとした朝のための手引き'}</h1>
      <p class="deck">${ZH ? 'Why the first hour of the day deserves a little more attention.' : '一日の最初の一時間は、もう少しだけ注意を向ける価値がある。'}</p>
      <p class="byline">${ZH ? 'By Mara Ellison · March 12, 2026' : 'マラ・エリソン・2026年3月12日'}</p>
      <hr>
      ${
        ZH
          ? `<p>Most of us wake up already behind.</p>
      <p>A slow morning is not about doing less. It is about choosing what deserves your attention before the world starts asking for it.</p>
      <p>Morning light slowly washes away the tiredness of yesterday.</p>
      <p>That is why the first hour of the day deserves to stay undisturbed.</p>`
          : `<p>私たちの多くは、目を覚ました時点ですでに出遅れている。</p>
      <p>ゆっくりした朝とは、何かを減らすことではなく、世界が注意を求め始める前に何に時間を使うかを見極めることだ。</p>
      <p>朝の光は、昨日の疲れを少しずつ洗い流してくれる。</p>
      <p>だからこそ、最初の一時間だけは、誰にも邪魔されずに過ごしたい。</p>`
      }
    </article>
    <aside>
      <h2>${ZH ? 'RELATED' : '関連記事'}</h2>
      <a href="#">${ZH ? 'A walk without a destination' : '目的地のない散歩'}</a>
      <a href="#">${ZH ? 'Quietly, deliberately' : '静かに、意図して'}</a>
      <a href="#">${ZH ? 'Reading on a rainy day' : '雨の日の読書'}</a>
    </aside>
  </main>
  <footer>Northwind Journal — a demo page served locally for extension screenshots.</footer>
</div></body></html>`;
}

const PAGES = { '/demo-light.html': demo(false), '/demo-dark.html': demo(true) };
const sent = new Set();

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
      let texts = [];
      try {
        const body = JSON.parse(raw);
        texts = JSON.parse(body.messages[1].content);
      } catch (err) {
        texts = [];
      }
      texts.forEach((t) => sent.add(String(t).slice(0, 60)));
      const content = JSON.stringify(texts.map(translate));
      res.writeHead(200, { 'content-type': 'application/json' });
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
  '--headless=new',
  '--enable-unsafe-extension-debugging',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--remote-allow-origins=*',
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank'
], { stdio: 'ignore' });

const version = await until(async () => {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
  return r.ok ? r.json() : null;
}, 20000);
if (!version) throw new Error('浏览器没有起来：' + BROWSER);
console.log(version.Browser + ' · 语言 ' + LANG + ' · 输出 ' + OUT);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message + ' ' + (m.error.data || '')));
    else p.resolve(m.result);
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

// 用扩展自己的设置页当「后台控制台」：service worker 可能处于停止状态，在那里求值会拿不到 chrome.*。
// 设置页是扩展页面，chrome.storage / chrome.tabs 都能用，也更稳定。
const optUrl = 'chrome-extension://' + extId + '/options/index.html';
const { targetId: optTarget } = await send('Target.createTarget', { url: optUrl });
const ext = await attach(optTarget);
await until(() => evaluate(ext, "!!document.getElementById('provider')"), 20000);
const extEval = (code) => evaluate(ext, '(async () => {' + code + '})()');

await extEval(
  'await chrome.storage.local.set({ config: ' +
    JSON.stringify({
      _v: 6,
      currentProvider: '__custom__',
      customProviders: [{ id: '__custom__', name: 'Demo' }],
      providerConfig: { __custom__: { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-demo', model: 'demo' } },
      uiLang: ZH ? 'zh' : 'en',
      targetLang: ZH ? 'zh-CN' : 'en',
      mode: 'dual',
      lazy: false,
      thinkingMode: 'off',
      hoverCompare: true,
      glossary: ZH
        ? [{ source: 'Battle Pass', target: '战斗通行证' }, { source: 'Demon Lord', target: '魔王' }]
        : [{ source: '魔王', target: 'Demon Lord' }, { source: '北風', target: 'north wind' }]
    }) +
    ' }); return true;'
);

// 配置写完后重载设置页，让它按 uiLang 重新渲染
await send('Page.reload', {}, ext);
await until(() => evaluate(ext, "!!document.getElementById('provider') && document.getElementById('provider').options.length > 1"), 20000);
await sleep(1200);

async function openTab(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const s = await attach(targetId);
  await until(() => evaluate(s, "['off', 'on'].indexOf(document.documentElement.getAttribute('data-dt')) >= 0"), 30000);
  const tabId = await extEval('const t = await chrome.tabs.query({}); return t.filter((x) => x.url === ' + JSON.stringify(url) + ').map((x) => x.id).pop();');
  return { s, targetId, tabId };
}
const tabMsg = (tabId, msg) => extEval('return await chrome.tabs.sendMessage(' + tabId + ', ' + JSON.stringify(msg) + ', { frameId: 0 });');
const settled = (tab) =>
  until(async () => {
    const st = await tabMsg(tab.tabId, { type: 'dt:status' });
    return st && !st.busy && st;
  });
const pageEval = (tab, code) => evaluate(tab.s, '(() => {' + code + '})()');

async function capture(tab, file) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, tab.s);
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, tab.s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('  ✓ ' + path.relative(ROOT, file));
}

const NAME = ZH
  ? {
      light: 'store-01-fullpage-light.png',
      dark: 'store-02-fullpage-dark.png',
      privacy: 'store-03-options-privacy.png',
      glossary: 'store-04-options-glossary.png',
      selection: 'store-05-selection.png'
    }
  : {
      light: 'en-01-fullpage-light.png',
      dark: 'en-02-fullpage-dark.png',
      privacy: 'en-04-options-privacy.png',
      glossary: 'en-05-options-glossary.png',
      selection: 'en-03-selection.png'
    };

// 1-2. 整页双语（浅色 / 深色）
for (const [route, name] of [['/demo-light.html', NAME.light], ['/demo-dark.html', NAME.dark]]) {
  const tab = await openTab(ORIGIN + route);
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(tab, "return document.querySelectorAll('[data-dt-target]').length >= 6"), 40000);
  await settled(tab);
  await sleep(3200); // 等“已翻译 N 段”的 toast 自己消失，别把它拍进商店图
  await pageEval(tab, 'window.scrollTo(0,0); return true');
  await sleep(600);
  await capture(tab, path.join(OUT, name));
}

// 3. 划词气泡
{
  const tab = await openTab(ORIGIN + '/demo-light.html');
  const pick = ZH ? 'Morning light slowly' : '朝の光は';
  const text = ZH ? 'Morning light slowly washes away the tiredness of yesterday.' : '朝の光は、昨日の疲れを少しずつ洗い流してくれる。';
  const expect = ZH ? '晨光一点点' : 'Morning light';
  await pageEval(
    tab,
    "const p = Array.prototype.find.call(document.querySelectorAll('article p'), (n) => n.textContent.indexOf(" + JSON.stringify(pick) + ') === 0);' +
      ' if (!p) return "no-paragraph";' +
      ' const r = document.createRange(); r.selectNodeContents(p);' +
      ' const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);' +
      ' p.scrollIntoView({block: "center"}); return p.textContent.slice(0, 12);'
  );
  await sleep(300);
  await tabMsg(tab.tabId, { type: 'dt:translateSelection', text });
  await until(() => pageEval(tab, "return !!Array.prototype.find.call(document.querySelectorAll('[data-dt-ui]'), (n) => n.textContent.indexOf(" + JSON.stringify(expect) + ') >= 0)'), 15000);
  await sleep(500);
  await capture(tab, path.join(OUT, NAME.selection));
}

// 4-5. 设置页（复用一开始打开的设置页，已按 uiLang 重载）
{
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, ext);
  await sleep(500);
  const scrollTo = (selector, offset) =>
    evaluate(
      ext,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return -1; const y = el.getBoundingClientRect().top + window.scrollY - ${offset}; window.scrollTo(0, Math.max(0, y)); return window.scrollY; })()`
    );
  const clickNav = (href) =>
    evaluate(ext, `(() => { const a = document.querySelector('a.nav-item[href="${href}"]'); if (!a) return false; a.click(); return true; })()`);
  await clickNav('#sec-privacy');
  await sleep(900);
  // 和中文那组保持一致：总开关打开、存一次，底部显示“已保存”
  await evaluate(ext, "(() => { const s = document.getElementById('privacyEnabled'); if (s && !s.checked) s.click(); return true; })()");
  await sleep(500);
  await evaluate(ext, "(() => { const b = document.getElementById('save'); if (b) b.click(); return true; })()");
  await sleep(1400);
  await capture({ s: ext }, path.join(OUT, NAME.privacy));
  await clickNav('#sec-translate');
  await sleep(900);
  await scrollTo('#glossaryList', 340);
  await sleep(600);
  await capture({ s: ext }, path.join(OUT, NAME.glossary));
}

console.log('\n假接口收到的文本：');
for (const t of sent) console.log('  · ' + t);

try {
  await send('Browser.close');
} catch (err) {
  /* 已关闭 */
}
browser.kill();
server.close();
await sleep(400);
if (!flag('--keep')) fs.rmSync(WORK, { recursive: true, force: true });
process.exit(0);
