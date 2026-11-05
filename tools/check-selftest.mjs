// Real browser selftest in both accessibility modes, independent of runner OS preferences.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const browser = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const FLAGS = ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-features=OptimizationHints,OptimizationGuideModelDownloading',
  '--remote-debugging-port=0'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, profile, launchError, stderrTail = '';
const running = () => !!child && child.exitCode === null && child.signalCode === null;
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    try { const value = await fn(); if (value) return value; } catch (err) { if (err.fatal) throw err; last = err; }
    await sleep(100);
  }
  throw new Error('Selftest timed out' + (last ? ': ' + last.message : ''));
}
let ws, sequence = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate(session, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-selftest-'));
  launchError = undefined; stderrTail = '';
  child = spawn(browser, [...FLAGS, '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', (err) => { launchError = err; });
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });
}
async function stop() {
  if (!child) return;
  const exited = new Promise((resolve) => { if (!running()) resolve(); else child.once('exit', resolve); });
  // Graceful close first: on Windows, killing only the parent can leave renderers holding the profile.
  if (ws?.readyState === WebSocket.OPEN) send('Browser.close').catch(() => {});
  await Promise.race([exited, sleep(5000)]);
  if (running()) { child.kill(); await Promise.race([exited, sleep(2000)]); }
  if (running()) child.kill('SIGKILL');
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Selftest browser closed')); }
  pending.clear();
  ws?.close(); ws = undefined;
  // A browser process can briefly retain files on Windows; cleanup must not hide results.
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
// A cold first launch on a fresh CI runner can be slow; retry once with a new profile and show why it failed.
async function startBrowser() {
  for (let attempt = 1; ; attempt++) {
    launch();
    try {
      return await until(() => {
        if (!running()) throw Object.assign(new Error('Browser exited early: ' + (child.exitCode ?? child.signalCode)), { fatal: true });
        return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      }, 60000);
    } catch (err) {
      console.error('Browser launch attempt ' + attempt + ' failed: ' + err.message + (stderrTail ? '\n--- browser stderr (tail) ---\n' + stderrTail : ''));
      await stop();
      if (attempt >= 2) throw err;
    }
  }
}
try {
  const port = await startBrowser();
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  console.log(version.Browser + ' · isolated selftest');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  };
  for (const motion of ['no-preference', 'reduce']) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] }, sessionId);
    await send('Page.navigate', { url: new URL('../selftest/index.html', import.meta.url).href }, sessionId);
    const summary = await until(() => evaluate(sessionId, '(()=>{const s=document.getElementById("summary");return s && /全部通过|存在失败项/.test(s.textContent) ? {text:s.textContent,ok:s.className==="pass",reduced:matchMedia("(prefers-reduced-motion:reduce)").matches}:null})()'));
    console.log(motion + ': ' + summary.text);
    if (summary.reduced !== (motion === 'reduce')) throw new Error('Motion emulation was not applied');
    if (!summary.ok) {
      console.error(await evaluate(sessionId, 'Array.from(document.querySelectorAll("#list li")).filter(li=>li.querySelector(".no")).map(li=>li.textContent)'));
      throw new Error('Offline selftest failed: ' + motion);
    }
    await send('Target.closeTarget', { targetId });
  }
} finally {
  await stop();
}
