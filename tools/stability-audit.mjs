#!/usr/bin/env node
// 真实 Chrome 稳定性 / 性能基准（0.9.2 审计）。
// 直接在页面里加载 content/core.js + units.js + dom.js + hover.js，用确定性样本测
// collect / inject / restore / 动态重扫 / 内存；不经过 MV3 后台和真实 API。
// 用法：node tools/stability-audit.mjs [--json path]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.RIMEFOX_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const at = argv.indexOf('--json');
const outFile = at >= 0 && argv[at + 1] ? argv[at + 1] : path.join(ROOT, 'docs/verification/stability-audit.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-stability-'));
const bench = path.join(ROOT, 'tools/stability-bench.html');
const version = spawnSync(CHROME, ['--version'], { encoding: 'utf8' }).stdout.trim();
const run = spawnSync(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
  '--allow-file-access-from-files', '--enable-precise-memory-info', '--js-flags=--expose-gc',
  '--virtual-time-budget=180000', '--user-data-dir=' + profile, '--dump-dom', 'file://' + bench
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(run.stdout || '');
if (!m) {
  console.error('benchmark failed: no result');
  console.error((run.stderr || '').slice(-2000));
  process.exit(1);
}
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
let data;
try { data = JSON.parse(decode(m[1])); } catch (err) { console.error('parse failed: ' + err.message); process.exit(1); }
data.environment = {
  date: new Date().toISOString(),
  chrome: version,
  chromePath: CHROME,
  platform: process.platform + ' ' + process.arch,
  note: 'Direct page harness; content scripts loaded as page scripts. Does not cover MV3 messages/API.'
};
const warnings = [];
data.scenarios.forEach((s) => {
  if (s.collectMs > 500) warnings.push(s.name + ' collect ' + s.collectMs + 'ms > 500ms');
  else if (s.collectMs > 100) warnings.push(s.name + ' collect ' + s.collectMs + 'ms > 100ms');
  if (s.recollectMs > 500) warnings.push(s.name + ' recollect ' + s.recollectMs + 'ms > 500ms');
  if (!s.restoreOk) warnings.push(s.name + ' restore mismatch');
});
(data.longTasks || []).forEach((ms) => { if (ms > 500) warnings.push('longtask ' + ms + 'ms'); });
data.warnings = warnings;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify({ environment: data.environment, scenarios: data.scenarios, dynamic: data.dynamic, cycles: data.cycles, longTasks: data.longTasks, warnings }, null, 2));
console.log('written: ' + outFile);
if (warnings.length) process.exitCode = 2;
