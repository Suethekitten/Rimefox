// Real browser selftest in both accessibility modes, independent of runner OS preferences.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const browser = process.env.RIMEFOX_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-selftest-'));
const child = spawn(browser, ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let launchError;
child.on('error', (err) => { launchError = err; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    try { const value = await fn(); if (value) return value; } catch (err) { last = err; }
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
try {
  const port = await until(() => fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0], 20000);
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
  const running = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise((resolve) => { if (!running()) resolve(); else child.once('exit', resolve); });
  // Graceful close first: on Windows, killing only the parent can leave renderers holding the profile.
  if (ws?.readyState === WebSocket.OPEN) send('Browser.close').catch(() => {});
  await Promise.race([exited, sleep(5000)]);
  if (running()) { child.kill(); await Promise.race([exited, sleep(2000)]); }
  if (running()) child.kill('SIGKILL');
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Selftest browser closed')); }
  pending.clear();
  ws?.close();
  // A browser process can briefly retain files on Windows; cleanup must not hide results.
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
