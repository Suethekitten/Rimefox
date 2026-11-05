// Settings navigation regression: real pointer hit testing and the rendered lens bounds.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-nav-'));
const port = 22500 + Math.floor(Math.random() * 300);
const executable = process.env.RIMEFOX_BROWSER || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--enable-unsafe-extension-debugging',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, failures = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' ' + JSON.stringify(detail) : '')); if (!ok) failures++; }
try {
  let version;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); break; } catch { await sleep(100); }
  }
  if (!version) throw new Error('Browser did not start');
  console.log(version.Browser);
  ws = new WebSocket(version.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let seq = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { id } = await send('Extensions.loadUnpacked', { path: root });
  console.log('Loaded ' + id + ' from ' + root);
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + id + '/options/index.html' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Page.bringToFront', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async code => {
    const r = await send('Runtime.evaluate', { expression: '(()=>{' + code + '})()', returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await evaluate('return document.getElementById("settingsNav")?.dataset.glassNav === "mounted"')) break; await sleep(100); }
  await sleep(500);
  await send('Page.bringToFront', {}, sessionId);
  const switches = await evaluate('const a=getComputedStyle(document.getElementById("rememberKey")),b=getComputedStyle(document.getElementById("hoverCompare"));return {appearance:a.appearance,width:a.width,height:a.height,referenceWidth:b.width,referenceHeight:b.height,checked:document.getElementById("rememberKey").checked};');
  check('remember-key uses the same switch as hover comparison', switches.appearance === 'none' && switches.width === switches.referenceWidth && switches.height === switches.referenceHeight, switches);
  const keyBox = await evaluate('const r=document.getElementById("rememberKey").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: keyBox.x, y: keyBox.y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: keyBox.x, y: keyBox.y, button: 'left', clickCount: 1 }, sessionId);
  check('switch remains keyboard-accessible checkbox and toggles by real click', await evaluate('const e=document.getElementById("rememberKey");return e.type==="checkbox" && e.checked') !== switches.checked);
  async function move(index) {
    const item = await evaluate('const items=[...document.querySelectorAll("#settingsNav > .nav-item")].filter(i=>i.getClientRects().length); const el=items[' + index + '], r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,label:el.textContent.trim()};');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x, y: item.y }, sessionId);
    await sleep(850);
    const bounds = await evaluate('const item=[...document.querySelectorAll("#settingsNav > .nav-item")].find(i=>i.matches(":hover"));const a=item?.getBoundingClientRect(),b=document.querySelector(".glass-nav__thumb").getBoundingClientRect();return {label:item?.textContent.trim(),delta:a?Math.abs(a.top-b.top):999,height:a?Math.abs(a.height-b.height):999};');
    return { ...bounds, expected: item.label };
  }
  for (const motion of ['no-preference', 'reduce']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, sessionId);
    const count = await evaluate('return [...document.querySelectorAll("#settingsNav > .nav-item")].filter(i=>i.getClientRects().length).length');
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(await move(i));
    check('all visible hover rows align (' + motion + ')', rows.every(r => r.label === r.expected && r.delta < 1 && r.height < 1), rows);
    const fourth = await move(3); await sleep(1200);
    const held = await evaluate('const a=[...document.querySelectorAll("#settingsNav > .nav-item")].filter(i=>i.getClientRects().length)[3].getBoundingClientRect(),b=document.querySelector(".glass-nav__thumb").getBoundingClientRect();return Math.abs(a.top-b.top);');
    check('fourth row stays aligned while pointer is stationary (' + motion + ')', held < 1, { fourth, held });
  }
  await evaluate('document.body.style.zoom="1.25";return true;'); await sleep(400);
  const zoomed = await move(3); check('fourth row at 125% zoom', zoomed.delta < 1 && zoomed.height < 1, zoomed);
  await evaluate('document.body.style.zoom="";document.getElementById("navOcr").hidden=false;return true;'); await sleep(400);
  const shown = await move(5); check('row alignment after revealing OCR', shown.delta < 1, shown);
  await evaluate('document.getElementById("navOcr").hidden=true;return true;'); await sleep(400);
  const hidden = await move(4); check('row alignment after hiding OCR', hidden.delta < 1, hidden);
  await evaluate('document.querySelectorAll("#settingsNav > .nav-item")[1].style.minHeight="65px";return true;'); await sleep(400);
  const uneven = await move(3); check('fourth row after a preceding row changes height', uneven.delta < 1, uneven);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 50 }, sessionId);
  await evaluate('Array.from(document.querySelectorAll(".nav-item")).find(a=>a.getAttribute("href")==="#sec-reading").focus();return true;');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown' }, sessionId);
  await sleep(400);
  check('keyboard navigation skips hidden OCR', await evaluate('return document.activeElement?.getAttribute("href")==="#sec-privacy"'));
  await send('Browser.close');
} finally {
  ws?.close(); browser.kill(); await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold the profile. */ }
}
process.exitCode = failures ? 1 : 0;
