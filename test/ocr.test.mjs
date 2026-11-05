// OCR 接口骨架：协议校验、状态判定、Native 来源（假端口 + 真参考宿主进程）、服务队列 / 取消、缓存键、配置。
// 运行：node test/ocr.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  OCR_PROTOCOL_VERSION, OcrError, buildRecognize, buildHello, parseHostMessage, normalizeOcrImage, splitDataUrl, OCR_LIMITS
} from '../lib/ocr/protocol.js';
import { OCR_STATUS, resolveOcr, backendStatesFromSources, ocrNotice, normalizeOcrChoice } from '../lib/ocr/status.js';
import { createNativeOcrSource, mapNativeError } from '../lib/ocr/native-source.js';
import { createOcrService } from '../lib/ocr/service.js';
import { ocrCacheKey, ocrParamsFingerprint } from '../lib/ocr/cache-key.js';
import { OCR_UI_ENABLED, systemOcrPreviewChoice, verifiedOcrRelease } from '../lib/ocr/feature.js';
import { encodeFrame, createFrameReader, HOST_NAME } from '../tools/ocr-mock-host/host.mjs';
import { OCR_NATIVE_HOST } from '../lib/ocr/protocol.js';

const PNG = { mime: 'image/png', data: 'iVBORw0KGgo=', width: 10, height: 20 };

// ---------------- 协议 ----------------
test('协议：识别请求校验图像与参数', () => {
  const msg = buildRecognize({ id: 'r1', backend: 'paddle', image: PNG, languages: ['zh-Hant', 'bad lang', 'zh-Hant', 'en'], device: 'gpu' });
  assert.equal(msg.v, OCR_PROTOCOL_VERSION);
  assert.deepEqual(msg.languages, ['zh-Hant', 'en']);
  assert.equal(msg.options.device, 'gpu');
  assert.equal(buildRecognize({ id: 'r2', backend: 'system', image: PNG, device: 'tpu' }).options.device, 'auto');
  assert.throws(() => normalizeOcrImage({ ...PNG, mime: 'image/gif' }), (e) => e.code === 'bad_request');
  assert.throws(() => normalizeOcrImage({ ...PNG, data: 'not base64!' }), (e) => e.code === 'bad_request');
  assert.throws(() => normalizeOcrImage({ ...PNG, width: 0 }), (e) => e.code === 'bad_request');
  assert.throws(() => normalizeOcrImage({ ...PNG, height: OCR_LIMITS.imageMaxSide + 1 }), (e) => e.code === 'bad_request');
  assert.throws(() => buildRecognize({ id: 'r3', backend: '../x', image: PNG }), (e) => e.code === 'bad_request');
  assert.deepEqual(splitDataUrl('data:image/png;base64,AAAA'), { mime: 'image/png', data: 'AAAA' });
  assert.throws(() => splitDataUrl('data:text/html;base64,AAAA'), OcrError);
  assert.equal(buildHello({ id: 'r9', clientVersion: '0.16.4' }).client.version, '0.16.4');
});

test('协议：解析宿主消息并收紧字段', () => {
  const hello = parseHostMessage({
    v: 1, id: 'r1', type: 'hello', component: { version: '1.0.0', protocols: [1, '2'] },
    backends: [{ id: 'system', status: 'ready', languages: ['zh-Hans', 7] }, { id: 'paddle', status: 'weird', devices: ['gpu', 'npu', 'gpu'] }, { id: 'BAD ID' }]
  });
  assert.deepEqual(hello.component.protocols, [1]);
  assert.equal(hello.backends.length, 2);
  assert.deepEqual(hello.backends[0].languages, ['zh-Hans']);
  assert.equal(hello.backends[1].status, 'unsupported');
  assert.deepEqual(hello.backends[1].devices, ['gpu']);

  const ok = parseHostMessage({ v: 1, id: 'r2', type: 'result', ok: true, backend: 'paddle', engine: { device: 'gpu' }, fallback: 'gpu_failed', durationMs: 12.6,
    lines: [{ text: '甲', confidence: 1.5, box: [1, 2, 3, 4] }, { text: '乙', box: [1, -2, 3, 4] }] });
  assert.equal(ok.lines[0].confidence, 1);
  assert.equal(ok.lines[1].confidence, null);
  assert.equal(ok.lines[1].box, null);
  assert.equal(ok.fallback, 'gpu_failed');
  assert.equal(ok.durationMs, 13);

  const err = parseHostMessage({ v: 1, id: 'r3', type: 'result', ok: false, error: { code: 'rm -rf', message: 'x' } });
  assert.equal(err.error.code, 'internal');
  assert.throws(() => parseHostMessage({ v: 2, id: 'r4', type: 'hello' }), (e) => e.code === 'unsupported_protocol');
  assert.throws(() => parseHostMessage({ v: 1, id: 'r5', type: 'result', ok: true, lines: [{ text: 5 }] }), (e) => e.code === 'bad_response');
  assert.throws(() => parseHostMessage({ v: 1, id: 'r6', type: 'result', ok: true, lines: new Array(OCR_LIMITS.maxLines + 1).fill({ text: 'a' }) }), (e) => e.code === 'bad_response');
});

test('协议：宿主名在扩展与参考宿主之间一致', () => {
  assert.equal(OCR_NATIVE_HOST, HOST_NAME);
  assert.match(OCR_NATIVE_HOST, /^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
});

// ---------------- 状态 ----------------
const B = (id, status) => ({ id, status });

test('状态：自动选择优先系统 OCR，其次 PaddleOCR', () => {
  assert.deepEqual(resolveOcr('auto', [B('system', 'ready'), B('paddle', 'ready')]), { choice: 'auto', status: 'ready', backend: 'system', reason: '' });
  assert.equal(resolveOcr('auto', [B('system', 'unsupported'), B('paddle', 'ready')]).backend, 'paddle');
  const none = resolveOcr('auto', [B('system', 'component_missing'), B('paddle', 'component_missing')]);
  assert.equal(none.status, OCR_STATUS.NOT_CONFIGURED);
  assert.equal(none.reason, 'component_missing');
  assert.equal(resolveOcr('auto', [B('system', 'permission_needed'), B('paddle', 'permission_needed')]).status, 'not_configured');
  assert.equal(resolveOcr('auto', [B('system', 'unsupported'), B('paddle', 'model_missing')]).reason, 'model_missing');
  // 装过组件但不兼容：不能笼统报未配置
  assert.equal(resolveOcr('auto', [B('system', 'incompatible'), B('paddle', 'incompatible')]).status, 'incompatible');
});

test('状态：指定引擎与关闭', () => {
  assert.equal(resolveOcr('off', [B('system', 'ready')]).status, 'disabled');
  assert.equal(resolveOcr('paddle', [B('system', 'ready'), B('paddle', 'engine_missing')]).status, 'engine_missing');
  assert.equal(resolveOcr('system', [B('system', 'permission_needed')]).status, 'permission_needed');
  assert.equal(resolveOcr('system', []).status, 'unsupported');
  assert.equal(resolveOcr('paddle', [B('paddle', 'ready')]).backend, 'paddle');
  assert.equal(normalizeOcrChoice('tesseract'), 'auto');
});

test('状态：来源连接失败折算到其名下后端', () => {
  const list = backendStatesFromSources([
    { id: 'native', status: 'component_missing', provides: ['system', 'paddle'] },
    { id: 'wasm', status: 'ok', provides: ['wasm-tesseract'], backends: [{ id: 'wasm-tesseract', status: 'ready' }] }
  ]);
  assert.deepEqual(list.map((b) => [b.id, b.status]), [['system', 'component_missing'], ['paddle', 'component_missing'], ['wasm-tesseract', 'ready']]);
  // 新来源的后端排在自动顺序之后，仍可被自动选中
  assert.equal(resolveOcr('auto', list).backend, 'wasm-tesseract');
  const partial = backendStatesFromSources([{ id: 'native', status: 'ok', provides: ['system', 'paddle'], backends: [{ id: 'system', status: 'ready' }] }]);
  assert.equal(partial.find((b) => b.id === 'paddle').status, 'engine_missing');
});

test('状态：提示文案（未配置为用户指定原文）', () => {
  assert.deepEqual(ocrNotice('not_configured', 'zh'), { kind: 'prompt', text: '未配置OCR，请前往设置配置', action: 'open-settings' });
  assert.equal(ocrNotice('not_configured', 'en').text, 'No OCR configured. Please configure OCR in Settings.');
  assert.equal(ocrNotice('ready', 'zh').kind, 'none');
  assert.deepEqual(ocrNotice('disabled', 'zh'), { kind: 'info', text: 'OCR 已关闭', action: null });
  assert.equal(ocrNotice('error', 'zh').action, 'retry');
  assert.equal(ocrNotice('component_missing', 'zh').action, 'open-settings');
  assert.notEqual(ocrNotice('component_missing', 'zh').text, ocrNotice('not_configured', 'zh').text);
});

// ---------------- Native 来源（假端口） ----------------
function fakePort(onPost) {
  const msgL = [];
  const discL = [];
  const port = {
    sent: [],
    postMessage(m) { port.sent.push(m); if (onPost) onPost(m, port); },
    onMessage: { addListener: (fn) => msgL.push(fn) },
    onDisconnect: { addListener: (fn) => discL.push(fn) },
    disconnect() { port.closed = true; },
    reply(m) { for (const fn of msgL) fn(m); },
    drop() { for (const fn of discL) fn(); }
  };
  return port;
}

const HELLO = (id, extra) => ({ v: 1, id, type: 'hello', component: { version: '1.0.0', protocols: [1] },
  backends: [{ id: 'system', status: 'ready' }, { id: 'paddle', status: 'ready', devices: ['gpu', 'cpu'] }], ...extra });

function autoHost(behavior = {}) {
  return (m, port) => queueMicrotask(() => {
    if (m.type === 'hello') port.reply(behavior.hello ? behavior.hello(m) : HELLO(m.id));
    else if (m.type === 'recognize' && !behavior.silent) port.reply({ v: 1, id: m.id, type: 'result', ok: true, backend: m.backend, engine: { name: 'x' }, lines: [{ text: 'hi' }] });
  });
}

test('Native：未授权时报 permission_needed，不尝试连接', async () => {
  let connects = 0;
  const src = createNativeOcrSource({ hasPermission: async () => false, connect: () => { connects += 1; return fakePort(); } });
  const res = await src.detect();
  assert.equal(res.status, 'permission_needed');
  assert.equal(connects, 0);
});

test('Native：握手、识别与空闲断开', async () => {
  const timers = [];
  const port = fakePort(autoHost());
  const src = createNativeOcrSource({
    hasPermission: async () => true, connect: () => port, clientVersion: '9.9.9',
    timers: { set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clear: (t) => { t.cleared = true; } }
  });
  const det = await src.detect();
  assert.equal(det.status, 'ok');
  assert.equal(det.backends.length, 2);
  assert.equal(port.sent[0].client.version, '9.9.9');
  const out = await src.recognize({ backend: 'paddle', image: PNG, languages: ['zh-Hans'] });
  assert.equal(out.lines[0].text, 'hi');
  // 第二次 detect 复用握手，不重发 hello
  await src.detect();
  assert.equal(port.sent.filter((m) => m.type === 'hello').length, 1);
  // 空闲计时器触发后断开
  const idle = timers.filter((t) => t.ms === 60000 && !t.cleared).pop();
  idle.fn();
  assert.equal(port.closed, true);
  assert.equal(src.connected, false);
});

test('Native：宿主不存在 / 被禁止 / 协议不兼容', async () => {
  assert.equal(mapNativeError('Specified native messaging host not found.'), 'component_missing');
  assert.equal(mapNativeError('Access to the specified native messaging host is forbidden.'), 'incompatible');
  assert.equal(mapNativeError('Native host has exited.'), 'error');

  let port;
  const missing = createNativeOcrSource({
    hasPermission: async () => true,
    lastError: () => 'Specified native messaging host not found.',
    connect: () => { port = fakePort((m, p) => queueMicrotask(() => p.drop())); return port; }
  });
  assert.equal((await missing.detect()).status, 'component_missing');

  const old = createNativeOcrSource({ hasPermission: async () => true, connect: () => fakePort(autoHost({ hello: (m) => HELLO(m.id, { component: { protocols: [2] } }) })) });
  assert.equal((await old.detect()).status, 'incompatible');

  const v2 = createNativeOcrSource({ hasPermission: async () => true, connect: () => fakePort((m, p) => queueMicrotask(() => p.reply({ v: 2, id: m.id, type: 'hello' }))) });
  assert.equal((await v2.detect()).status, 'incompatible');
});

test('Native：取消立即返回，晚归结果被丢弃', async () => {
  const port = fakePort(autoHost({ silent: true }));
  const src = createNativeOcrSource({ hasPermission: async () => true, connect: () => port });
  await src.detect();
  const ac = new AbortController();
  const job = src.recognize({ backend: 'system', image: PNG, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 0));
  const req = port.sent.find((m) => m.type === 'recognize');
  ac.abort();
  await assert.rejects(job, (e) => e.code === 'cancelled');
  assert.equal(port.sent.at(-1).type, 'cancel');
  assert.equal(port.sent.at(-1).target, req.id);
  // 晚归响应不抛错、不影响后续
  port.reply({ v: 1, id: req.id, type: 'result', ok: true, backend: 'system', lines: [] });
  assert.equal(src.pendingCount, 0);
});

test('Native：断开时在途任务失败，下一次重新连接', async () => {
  let n = 0;
  let current;
  const src = createNativeOcrSource({
    hasPermission: async () => true,
    lastError: () => 'Native host has exited.',
    connect: () => { n += 1; current = fakePort(autoHost({ silent: true })); return current; }
  });
  await src.detect();
  const job = src.recognize({ backend: 'system', image: PNG });
  await new Promise((r) => setTimeout(r, 0));
  current.drop();
  await assert.rejects(job, (e) => e.code === 'error');
  await src.detect();
  assert.equal(n, 2);
});

test('Native：识别超时', async () => {
  const timers = [];
  const src = createNativeOcrSource({
    hasPermission: async () => true, connect: () => fakePort(autoHost({ silent: true })), requestTimeoutMs: 5,
    timers: { set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clear: (t) => { t.cleared = true; } }
  });
  await src.detect();
  const job = src.recognize({ backend: 'system', image: PNG });
  await new Promise((r) => setTimeout(r, 0));
  timers.find((t) => t.ms === 5 && !t.cleared).fn();
  await assert.rejects(job, (e) => e.code === 'error' && /超时/.test(e.message));
});

// ---------------- 服务 ----------------
function fakeSource(id, provides, backends, opts = {}) {
  return {
    id, provides, detects: 0, calls: [],
    async detect() { this.detects += 1; return opts.status && opts.status !== 'ok' ? { id, provides, status: opts.status, backends: [] } : { id, provides, status: 'ok', backends: backends() }; },
    async recognize(args) {
      this.calls.push(args);
      if (opts.recognize) return opts.recognize(args);
      return { backend: args.backend, lines: [{ text: id }] };
    }
  };
}

test('服务：状态快照、缓存与刷新', async () => {
  let t = 0;
  const src = fakeSource('native', ['system', 'paddle'], () => [B('system', 'unsupported'), B('paddle', 'ready')]);
  const svc = createOcrService({ sources: [src], getChoice: async () => 'auto', now: () => t, ttlMs: 1000 });
  const snap = await svc.status();
  assert.equal(snap.status, 'ready');
  assert.equal(snap.backend, 'paddle');
  assert.equal(snap.sources[0].status, 'ok');
  await svc.status();
  assert.equal(src.detects, 1);
  t = 2000;
  await svc.status();
  assert.equal(src.detects, 2);
  await svc.status({ refresh: true });
  assert.equal(src.detects, 3);
});

test('服务：未就绪时识别直接抛状态码，不调用来源', async () => {
  const src = fakeSource('native', ['system', 'paddle'], () => [], { status: 'component_missing' });
  const svc = createOcrService({ sources: [src], getChoice: async () => 'auto' });
  await assert.rejects(svc.recognize({ image: PNG }), (e) => e.code === 'not_configured');
  const off = createOcrService({ sources: [src], getChoice: async () => 'off' });
  await assert.rejects(off.recognize({ image: PNG }), (e) => e.code === 'disabled');
  assert.equal(src.calls.length, 0);
});

test('服务：识别串行执行，可按 jobId 取消排队中的任务', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let active = 0;
  let maxActive = 0;
  const src = fakeSource('native', ['system', 'paddle'], () => [B('system', 'ready')], {
    recognize: async (args) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      if (args.signal.aborted) throw new OcrError('cancelled', '已取消');
      return { backend: args.backend, lines: [] };
    }
  });
  const svc = createOcrService({ sources: [src], getChoice: async () => 'system' });
  const a = svc.recognize({ image: PNG, jobId: 'p1' });
  const b = svc.recognize({ image: PNG, jobId: 'p2' });
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(svc.recognize({ image: PNG, jobId: 'p1' }), (e) => e.code === 'bad_request');
  assert.equal(svc.cancel('p2'), true);
  assert.equal(svc.cancel('nope'), false);
  release();
  assert.equal((await a).backend, 'system');
  await assert.rejects(b, (e) => e.code === 'cancelled');
  assert.equal(maxActive, 1);
  assert.equal(src.calls.length, 1);
});

test('服务：引擎状态变化后作废检测缓存', async () => {
  let state = 'ready';
  const src = fakeSource('native', ['system', 'paddle'], () => [B('paddle', state)], {
    recognize: async () => { state = 'model_missing'; throw new OcrError('model_missing', 'gone'); }
  });
  const svc = createOcrService({ sources: [src], getChoice: async () => 'paddle', ttlMs: 1e9 });
  await assert.rejects(svc.recognize({ image: PNG }), (e) => e.code === 'model_missing');
  assert.equal((await svc.status()).status, 'model_missing');
});

// ---------------- 缓存键 ----------------
test('缓存键：不含翻译配置，参数顺序无关，引擎版本参与', () => {
  const base = { bookId: 'b1', page: 3, backend: 'paddle', engine: { name: 'PaddleOCR', version: '3.0', model: 'v5' }, params: { languages: ['zh-Hant', 'en'], scale: 2 } };
  const k = ocrCacheKey(base);
  assert.match(k, /^ocr-v2\|b1\|page:3\|paddle\|PaddleOCR@3\.0\|v5\|[0-9a-f]{8}$/);
  assert.equal(ocrCacheKey({ ...base, params: { scale: 2, languages: ['en', 'zh-Hant'] } }), k);
  assert.notEqual(ocrCacheKey({ ...base, engine: { ...base.engine, version: '3.1' } }), k);
  assert.notEqual(ocrParamsFingerprint({ scale: 2 }), ocrParamsFingerprint({ scale: 3 }));
  assert.throws(() => ocrCacheKey({ ...base, page: 0 }), TypeError);
});

test('预览策略：开放系统 OCR，不选择未来后端，不显示不可核实的下载', () => {
  assert.equal(OCR_UI_ENABLED, true);
  for (const value of ['auto', 'paddle', 'system', 'unknown']) assert.equal(systemOcrPreviewChoice(value), 'system');
  assert.equal(systemOcrPreviewChoice('off'), 'off');
  assert.equal(verifiedOcrRelease({ connector: 'https://example.com/fake.exe', sha256: 'a'.repeat(64) }), null);
  assert.equal(verifiedOcrRelease({ connector: 'https://github.com/Suethekitten/Rimefox/releases/download/test/file.zip' }), null);
});

// ---------------- 配置 ----------------
test('配置：ocrEngine 默认自动，非法值回退，导入只收合法值', async () => {
  const { DEFAULTS, mergeConfig, pickImportedConfig } = await import('../lib/config.js');
  assert.equal(DEFAULTS.ocrEngine, 'auto');
  assert.equal(mergeConfig(DEFAULTS, { ocrEngine: 'paddle' }).ocrEngine, 'paddle');
  assert.equal(mergeConfig(DEFAULTS, { ocrEngine: 'cloud' }).ocrEngine, 'auto');
  assert.equal(mergeConfig({ ...DEFAULTS, ocrEngine: 'off' }, {}).ocrEngine, 'off');
  const ok = pickImportedConfig({ app: 'rimefox', schema: 1, config: { ocrEngine: 'system', mode: 'dual', uiLang: 'zh', theme: 'underline' } });
  assert.equal(ok.config.ocrEngine, 'system');
  const bad = pickImportedConfig({ app: 'rimefox', schema: 1, config: { ocrEngine: 'cloud', mode: 'dual', uiLang: 'zh', theme: 'underline' } });
  assert.equal(bad.config.ocrEngine, undefined);
  assert.ok(bad.rejected.includes('ocrEngine'));
});

// ---------------- 参考宿主（真实子进程 + 帧编解码） ----------------
function processPort(mode) {
  const file = fileURLToPath(new URL('../tools/ocr-mock-host/host.mjs', import.meta.url));
  const child = spawn(process.execPath, [file], { env: { ...process.env, OCR_MOCK_MODE: mode, OCR_MOCK_DELAY_MS: '200' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const msgL = [];
  const discL = [];
  // Cancellation can leave a final frame buffered when dispose() deliberately kills
  // the child. Chrome Port has no asynchronous EPIPE event; model that closed pipe.
  child.stdin.on('error', (error) => {
    if (child.killed && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;
    throw error;
  });
  child.stdout.on('data', createFrameReader((m) => { for (const fn of msgL) fn(m); }));
  child.on('exit', () => { for (const fn of discL) fn(); });
  const sent = [];
  return {
    child,
    sent,
    postMessage: (m) => { sent.push(m.type); child.stdin.write(encodeFrame(m)); },
    onMessage: { addListener: (fn) => msgL.push(fn) },
    onDisconnect: { addListener: (fn) => discL.push(fn) },
    disconnect: () => child.kill()
  };
}

test('参考宿主：帧编解码可处理任意切分', () => {
  const got = [];
  const read = createFrameReader((m) => got.push(m));
  const bytes = Buffer.concat([encodeFrame({ a: '甲' }), encodeFrame({ b: 2 })]);
  for (let i = 0; i < bytes.length; i += 3) read(bytes.subarray(i, i + 3));
  assert.deepEqual(got, [{ a: '甲' }, { b: 2 }]);
});

test('参考宿主：经服务完成检测与识别（system-only 模式）', async () => {
  let port;
  const src = createNativeOcrSource({ hasPermission: async () => true, connect: () => (port = processPort('system-only')) });
  const svc = createOcrService({ sources: [src], getChoice: async () => 'auto' });
  try {
    const snap = await svc.status();
    assert.equal(snap.backend, 'system');
    assert.equal(snap.backends.find((b) => b.id === 'paddle').status, 'engine_missing');
    const res = await svc.recognize({ image: PNG, languages: ['zh-Hans'] });
    assert.equal(res.lines[0].text, '模拟识别第一行');
    assert.deepEqual(res.lines[0].box, [1, 2, 8, 1]);
  } finally {
    svc.dispose();
    port.child.kill();
  }
});

test('参考宿主：慢识别可取消，协议 2 判为不兼容', async () => {
  let port;
  const src = createNativeOcrSource({ hasPermission: async () => true, connect: () => (port = processPort('slow')) });
  const svc = createOcrService({ sources: [src], getChoice: async () => 'paddle' });
  try {
    const job = svc.recognize({ image: PNG, jobId: 'page-1' });
    // 等识别请求真正发给宿主再取消：Windows 上启动子进程 + 握手可能远超几十毫秒（CI 上曾因此失败）
    for (let i = 0; i < 200 && !(port && port.sent.includes('recognize')); i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.ok(port && port.sent.includes('recognize'), '识别请求应已发出');
    assert.equal(svc.cancel('page-1'), true);
    await assert.rejects(job, (e) => e.code === 'cancelled');
  } finally {
    svc.dispose();
    port.child.kill();
  }
  let port2;
  const old = createNativeOcrSource({ hasPermission: async () => true, connect: () => (port2 = processPort('protocol2')) });
  try {
    assert.equal((await old.detect()).status, 'incompatible');
  } finally {
    old.dispose();
    if (port2) port2.child.kill();
  }
});

// ---------------- 行 → 文本块 ----------------
test('版面：同段续行合并，段距 / 字号变化处分段', async () => {
  const { linesToBlocks, joinOcrText } = await import('../lib/ocr/layout.js');
  assert.equal(joinOcrText('扫描图像只在', '本机识别'), '扫描图像只在本机识别');
  assert.equal(joinOcrText('Local recog-', 'nition keeps'), 'Local recognition keeps');
  assert.equal(joinOcrText('Hello', 'World'), 'Hello World');
  assert.equal(joinOcrText('中文', 'English'), '中文English');
  const blocks = linesToBlocks([
    { text: '标题很大', box: [80, 40, 400, 60], confidence: 1 },
    { text: '第一段第一行', box: [80, 130, 600, 30], confidence: 0.9 },
    { text: '第一段第二行', box: [80, 165, 580, 30], confidence: 0.7 },
    { text: '第二段与上一段隔开', box: [80, 260, 600, 30] },
    { text: '   ', box: [80, 300, 10, 30] },
    { text: 'no box line' }
  ]);
  assert.deepEqual(blocks.map((b) => b.text), ['标题很大', '第一段第一行第一段第二行', '第二段与上一段隔开', 'no box line']);
  assert.equal(blocks[1].lines, 2);
  assert.equal(blocks[1].confidence, 0.8);
  assert.equal(blocks[2].confidence, null);
  assert.deepEqual(linesToBlocks([]), []);
  assert.deepEqual(linesToBlocks(null), []);
});

test('版面：左缘差太大不合并，超长段落按上限切开', async () => {
  const { linesToBlocks } = await import('../lib/ocr/layout.js');
  const cols = linesToBlocks([
    { text: '左栏', box: [50, 100, 200, 30] },
    { text: '右栏', box: [400, 135, 200, 30] }
  ]);
  assert.equal(cols.length, 2);
  const long = Array.from({ length: 120 }, (_, i) => ({ text: '这是一行很长的测试文字用于触发段落长度上限', box: [50, 100 + i * 34, 600, 30] }));
  const out = linesToBlocks(long);
  assert.ok(out.length >= 2);
  assert.ok(out.every((b) => b.text.length <= 1800));
});

test('版面：句末标点 + 右缘短于段宽时分段', async () => {
  const { linesToBlocks } = await import('../lib/ocr/layout.js');
  const out = linesToBlocks([
    { text: '这是第一段的第一行文字比较长', box: [80, 100, 700, 50] },
    { text: '第一段到这里结束。', box: [80, 180, 400, 50] },
    { text: '第二段从这里开始，同样的行距', box: [80, 260, 700, 50] },
    { text: 'Rimefox sample page', box: [80, 340, 500, 50] },
    { text: 'continues here.', box: [80, 420, 300, 50] }
  ]);
  assert.deepEqual(out.map((b) => b.text), ['这是第一段的第一行文字比较长第一段到这里结束。', '第二段从这里开始，同样的行距Rimefox sample page continues here.']);
});

test('版面：文本块保留行框，换算成版式预览坐标后贴合原框', async () => {
  const { linesToBlocks, ocrLayoutLines } = await import('../lib/ocr/layout.js');
  const { layoutRect } = await import('../lib/reader/pdf-layout.js');
  const blocks = linesToBlocks([
    { text: '第一段第一行', box: [90, 300, 1200, 60] },
    { text: '第一段第二行', box: [90, 370, 1100, 60] },
    { text: '没有识别框的一行' }
  ]);
  assert.deepEqual(blocks[0].boxes, [[90, 300, 1200, 60], [90, 370, 1100, 60]]);
  assert.equal(blocks[1].boxes, null);
  // 识别图像按 3 倍渲染：视口 595 × 842 对应 1785 × 2526 像素。
  const viewport = { width: 595, height: 842 };
  const lines = ocrLayoutLines(blocks[0].boxes, 3, viewport.height);
  const rect = layoutRect({ text: blocks[0].text, layoutLines: lines }, viewport);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(rect.x, 30 - 1.5) && near(rect.y, 100 - 1.5), JSON.stringify(rect));
  assert.ok(near(rect.width, 400 + 3) && near(rect.height, (430 - 300) / 3 + 3), JSON.stringify(rect));
  assert.ok(near(rect.fontSize, 20 / 1.25));
  assert.equal(ocrLayoutLines(null, 3, 842), null);
  assert.equal(ocrLayoutLines([[0, 0, 0, 10]], 3, 842), null);
  assert.equal(ocrLayoutLines([[0, 0, 10, 10]], 0, 842), null);
});

// ---------------- 回归：2026-11-05 修复的两个问题 ----------------
test('回归：后端自报的语言不再被截成 8 种（请求语言仍限 8 种）', () => {
  const langs = ['en-US', 'fr-FR', 'it-IT', 'de-DE', 'es-ES', 'pt-BR', 'zh-Hans', 'zh-Hant', 'yue-Hans', 'ko-KR', 'ja-JP', 'ru-RU'];
  const hello = parseHostMessage({ v: 1, id: 'r1', type: 'hello', component: { protocols: [1] }, backends: [{ id: 'system', status: 'ready', languages: langs }] });
  assert.deepEqual(hello.backends[0].languages, langs);
  assert.ok(hello.backends[0].languages.includes('zh-Hant'));
  const req = buildRecognize({ id: 'r2', backend: 'system', image: PNG, languages: langs });
  assert.equal(req.languages.length, OCR_LIMITS.maxLanguages);
});

test('回归：检测缓存过期后重新握手，不沿用连接里的旧 hello', async () => {
  let t = 0;
  let paddle = 'engine_missing';
  const port = fakePort((m, p) => queueMicrotask(() => {
    if (m.type === 'hello') p.reply(HELLO(m.id, { backends: [{ id: 'system', status: 'ready' }, { id: 'paddle', status: paddle }] }));
  }));
  const src = createNativeOcrSource({ hasPermission: async () => true, connect: () => port });
  const svc = createOcrService({ sources: [src], getChoice: async () => 'paddle', now: () => t, ttlMs: 1000 });
  assert.equal((await svc.status()).status, 'engine_missing');
  paddle = 'ready'; // 用户装好了引擎包，连接没断
  t = 500;
  assert.equal((await svc.status()).status, 'engine_missing', '缓存期内沿用检测结果');
  t = 2000;
  assert.equal((await svc.status()).status, 'ready', '过期后应重新握手拿到新状态');
  assert.equal(port.sent.filter((m) => m.type === 'hello').length, 2);
  src.dispose();
});

test('服务：组件检测期间到达的取消同样生效（0.16.5 后修复）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const src = fakeSource('native', ['system', 'paddle'], () => [B('system', 'ready')]);
  const slowDetect = src.detect.bind(src);
  src.detect = async (opts) => { await gate; return slowDetect(opts); };
  const svc = createOcrService({ sources: [src], getChoice: async () => 'system' });
  const job = svc.recognize({ image: PNG, jobId: 'early' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(svc.cancel('early'), true, '检测还没完成时也能找到任务');
  release();
  await assert.rejects(job, (e) => e.code === 'cancelled');
  assert.equal(src.calls.length, 0, '取消后不再调用来源识别');
  assert.equal(svc.cancel('early'), false, '任务结束后从表里移除');
});
