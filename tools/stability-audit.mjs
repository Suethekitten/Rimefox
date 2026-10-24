#!/usr/bin/env node
// 真实 Chrome 稳定性 / 性能基准（0.9.2 审计）。
// 直接在页面里加载 content/core.js + units.js + dom.js + hover.js，用确定性样本测
// collect / inject / restore / 动态重扫 / 内存；不经过 MV3 后台和真实 API。
// 用法：node tools/stability-audit.mjs [--json path] [--ref <git-commit>]
// --ref freezes only source scripts in a temporary directory; the same current benchmark runs against both revisions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.RIMEFOX_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const at = argv.indexOf('--json');
const outFile = at >= 0 && argv[at + 1] ? argv[at + 1] : path.join(ROOT, 'docs/verification/stability-audit.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-stability-'));
const refAt = argv.indexOf('--ref');
const ref = refAt >= 0 ? argv[refAt + 1] : '';
if (refAt >= 0 && !ref) throw new Error('--ref requires a Git revision');
function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
const revisionResult = git(['rev-parse', '--verify', (ref || 'HEAD') + '^{commit}']);
if (revisionResult.status !== 0) throw new Error('Cannot resolve benchmark revision: ' + (ref || 'HEAD'));
const revision = revisionResult.stdout.trim();
const snapshot = path.join(profile, 'sources');
const sourceFiles = {};
fs.mkdirSync(path.join(snapshot, 'tools'), { recursive: true });
for (const file of ['content/core.js', 'content/units.js', 'content/dom.js', 'content/hover.js', 'lib/inline-protocol.js']) {
  const source = ref ? git(['show', revision + ':' + file]) : { status: 0, stdout: fs.readFileSync(path.join(ROOT, file), 'utf8') };
  if (source.status !== 0 && file !== 'lib/inline-protocol.js') throw new Error('Missing baseline source: ' + file);
  const text = source.status === 0 ? source.stdout : '// This revision predates the shared inline protocol.\n';
  const destination = path.join(snapshot, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
  sourceFiles[file] = createHash('sha256').update(text).digest('hex');
}
const benchSource = fs.readFileSync(path.join(ROOT, 'tools/stability-bench.html'));
const bench = path.join(snapshot, 'tools/stability-bench.html');
fs.writeFileSync(bench, benchSource);
const version = spawnSync(CHROME, ['--version'], { encoding: 'utf8' }).stdout.trim();
const run = spawnSync(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
  '--allow-file-access-from-files', '--enable-precise-memory-info', '--js-flags=--expose-gc',
  '--virtual-time-budget=180000', '--user-data-dir=' + path.join(profile, 'profile'), '--dump-dom', 'file://' + bench
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
  revision,
  source: ref ? 'frozen-git-revision' : 'working-tree-snapshot',
  sourceFiles,
  benchmarkSha256: createHash('sha256').update(benchSource).digest('hex'),
  benchmark: 'Current tools/stability-bench.html for both working-tree and --ref runs',
  note: 'Direct page harness; content scripts loaded as page scripts. Does not cover MV3 messages/API.'
};
const warnings = [];
if (data.networkAttempts !== 0) warnings.push('unexpected script network attempts: ' + data.networkAttempts);
data.scenarios.forEach((s) => {
  if (s.collectMs > 500) warnings.push(s.name + ' collect ' + s.collectMs + 'ms > 500ms');
  else if (s.collectMs > 100) warnings.push(s.name + ' collect ' + s.collectMs + 'ms > 100ms');
  if (s.recollectMs > 500) warnings.push(s.name + ' recollect ' + s.recollectMs + 'ms > 500ms');
  if (!s.restoreOk) warnings.push(s.name + ' restore mismatch');
  if (!s.injectOk) warnings.push(s.name + ' injection refused');
});
(data.longTasks || []).forEach((ms) => { if (ms > 500) warnings.push('longtask ' + ms + 'ms'); });
data.warnings = warnings;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify({ environment: data.environment, scenarios: data.scenarios, dynamic: data.dynamic, cycles: data.cycles, longTasks: data.longTasks, networkAttempts: data.networkAttempts, cache: data.cache, warnings }, null, 2));
console.log('written: ' + outFile);
if (warnings.length) process.exitCode = 2;
