// 本机 OCR 连接器的真实识别（不经浏览器）：按平台找已构建的二进制，找不到就跳过。
//   macOS：sh native/ocr-host/macos/build.sh        → native/ocr-host/macos/build/rimefox-ocr-host
//   Windows：见 native/ocr-host/WINDOWS-HANDOFF.md   → native/ocr-host/windows/build/rimefox-ocr-host.exe
// 运行：node test/ocr-native-host.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

import { createNativeOcrSource } from '../lib/ocr/native-source.js';
import { createOcrService } from '../lib/ocr/service.js';
import { linesToBlocks } from '../lib/ocr/layout.js';
import { encodeFrame, createFrameReader } from '../tools/ocr-mock-host/host.mjs';

const BINARIES = {
  darwin: '../native/ocr-host/macos/build/rimefox-ocr-host',
  win32: '../native/ocr-host/windows/build/rimefox-ocr-host.exe'
};
const BIN = process.env.RIMEFOX_OCR_HOST || (BINARIES[process.platform] ? fileURLToPath(new URL(BINARIES[process.platform], import.meta.url)) : '');
if (process.env.RIMEFOX_REQUIRE_NATIVE === '1' && (!BIN || !fs.existsSync(BIN))) throw new Error('Required native OCR connector was not built');
const FIXTURE = fileURLToPath(new URL('./fixtures/ocr-sample.png', import.meta.url));
const skip = !BIN ? '当前平台没有连接器' : !fs.existsSync(BIN) ? '未构建：' + BIN : false;

function hostPort() {
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const ml = [];
  const dl = [];
  child.stdout.on('data', createFrameReader((m) => ml.forEach((fn) => fn(m))));
  child.on('exit', () => dl.forEach((fn) => fn()));
  return {
    child,
    postMessage: (m) => child.stdin.write(encodeFrame(m)),
    onMessage: { addListener: (fn) => ml.push(fn) },
    onDisconnect: { addListener: (fn) => dl.push(fn) },
    disconnect: () => child.kill()
  };
}

function pngImage(file) {
  const png = fs.readFileSync(file);
  return { mime: 'image/png', data: png.toString('base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('本机连接器：握手报告系统 OCR 就绪、PaddleOCR 未安装，并识别夹具文字', { skip, timeout: 120000 }, async () => {
  let port;
  const svc = createOcrService({
    sources: [createNativeOcrSource({ hasPermission: async () => true, connect: () => (port = hostPort()), clientVersion: 'test' })],
    getChoice: async () => 'auto'
  });
  try {
    const snap = await svc.status();
    assert.equal(snap.status, 'ready');
    assert.equal(snap.backend, 'system');
    const system = snap.backends.find((b) => b.id === 'system');
    // macOS 报 zh-Hans；Windows 按已装语言包报 zh-Hans-CN / zh-CN 等，缺中文语言包时这里会失败并提示去装
    assert.ok(system.languages.some((tag) => /^zh/i.test(tag)), '应支持中文识别（Windows 需安装中文 OCR 语言包）：' + system.languages.join(','));
    assert.equal(snap.backends.find((b) => b.id === 'paddle').status, 'engine_missing');
    assert.equal(snap.sources[0].component.protocols[0], 1);

    const res = await svc.recognize({ image: pngImage(FIXTURE), jobId: 'fixture' });
    const text = res.lines.map((l) => l.text).join('\n');
    assert.equal(res.engine.device, '', '系统 API 没有提供实际硬件证据，不应冒报 CPU / GPU');
    assert.match(text, /凛狐扫描页识别测试/);
    assert.match(text, /Rimefox OCR sample page 2026/);
    assert.match(text, /扫描图像只在本机识别/);
    if (process.platform === 'win32') assert.doesNotMatch(text, /[\u3400-\u9fff][ \t]+[\u3400-\u9fff]/, '中文字符之间不应残留空格');
    assert.ok(res.lines.every((l) => Array.isArray(l.box)), '每行都应有坐标');
    // 第一行在最上方
    assert.ok(res.lines[0].box[1] < res.lines[res.lines.length - 1].box[1]);
    assert.ok(linesToBlocks(res.lines).length >= 3);

    await assert.rejects(svc.recognize({ image: { ...pngImage(FIXTURE), data: 'AAAA' } }), (e) => e.code === 'bad_request');
  } finally {
    svc.dispose();
    if (port) port.child.kill();
  }
});

// Windows-specific regressions exercise the actual executable, not a reimplementation.
const windowsSkip = skip || (process.platform !== 'win32' && 'Windows connector only');
function reply(port, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host reply timed out: ' + message.id)), 15000);
    port.onMessage.addListener((m) => {
      if (m.id === message.id) { clearTimeout(timer); resolve(m); }
    });
    port.postMessage(message);
  });
}
function blankPng(width, height) {
  function chunk(type, data) {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('本机连接器：拒绝伪造尺寸、错误 MIME、坏字段与不可用语言，拒绝后仍可继续握手', { skip }, async () => {
  const port = hostPort();
  const base = { v: 1, type: 'recognize', backend: 'system', image: pngImage(FIXTURE) };
  try {
    const cases = [
      [{ ...base, image: { ...base.image, width: base.image.width + 1 } }, 'bad_request'],
      [{ ...base, image: { ...base.image, mime: 'image/jpeg' } }, 'bad_request'],
      [{ ...base, image: { ...base.image, width: '100' } }, 'bad_request'],
      [{ ...base, image: { ...base.image, width: true } }, 'bad_request'],
      [{ ...base, languages: ['zzz'] }, 'language_unavailable'],
      [{ ...base, languages: 'en' }, 'bad_request'],
      [{ ...base, v: '1' }, 'unsupported_protocol'],
      [{ ...base, v: true }, 'unsupported_protocol']
    ];
    for (let i = 0; i < cases.length; i++) {
      const [request, expected] = cases[i];
      const result = await reply(port, { ...request, id: 'invalid_' + i });
      assert.equal(result.error?.code, expected, JSON.stringify(result));
    }
    const hello = await reply(port, { v: 1, id: 'recovered', type: 'hello' });
    assert.equal(hello.type, 'hello');
    const installed = hello.backends.find((b) => b.id === 'system').languages;
    if (!installed.some((l) => /hant|zh-(tw|hk|mo)/i.test(l))) {
      const result = await reply(port, { ...base, id: 'hant', languages: ['zh-Hant'] });
      assert.equal(result.error?.code, 'language_unavailable', '不可把繁体请求误配到简体模型');
    }
    const hans = await reply(port, { ...base, id: 'hans', languages: ['zh-Hans'] });
    assert.equal(hans.ok, true);
    if (process.platform === 'win32') assert.match(hans.engine.model, /zh/i);
    else assert.equal(hans.engine.name, 'Apple Vision');
  } finally { port.child.kill(); }
});

test('Windows：超过系统 OCR 单边上限的图像自动缩小，不崩溃', { skip: windowsSkip }, async () => {
  const port = hostPort();
  try {
    const result = await reply(port, { v: 1, id: 'large', type: 'recognize', backend: 'system',
      image: { mime: 'image/png', width: 8192, height: 128, data: blankPng(8192, 128) } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.lines, []);
  } finally { port.child.kill(); }
});

test('本机连接器：分片帧与排队任务取消，取消后可继续识别', { skip }, async () => {
  const port = hostPort();
  const got = [];
  port.onMessage.addListener((m) => got.push(m));
  const request = { v: 1, type: 'recognize', backend: 'system', image: pngImage(FIXTURE) };
  try {
    const batch = Buffer.concat([
      encodeFrame({ ...request, id: 'first' }),
      encodeFrame({ ...request, id: 'queued' }),
      encodeFrame({ v: 1, id: 'cancel', type: 'cancel', target: 'queued' })
    ]);
    port.child.stdin.write(batch.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 20));
    port.child.stdin.write(batch.subarray(2));
    for (let i = 0; i < 200 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.find((m) => m.id === 'queued')?.error?.code, 'cancelled');
    assert.equal(got.find((m) => m.id === 'first')?.ok, true);
    const next = await reply(port, { ...request, id: 'next' });
    assert.equal(next.ok, true);
  } finally { port.child.kill(); }
});

test('本机连接器：协议版本不对时回 unsupported_protocol，未装的 PaddleOCR 回 engine_missing', { skip, timeout: 60000 }, async () => {
  const port = hostPort();
  const got = [];
  port.onMessage.addListener((m) => got.push(m));
  try {
    port.postMessage({ v: 2, id: 'r1', type: 'hello' });
    port.postMessage({ v: 1, id: 'r2', type: 'recognize', backend: 'paddle', image: pngImage(FIXTURE) });
    for (let i = 0; i < 100 && got.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.find((m) => m.id === 'r1').error.code, 'unsupported_protocol');
    assert.equal(got.find((m) => m.id === 'r2').error.code, 'engine_missing');
  } finally {
    port.child.kill();
  }
});

// 倾斜扫描：整页逆时针约 1.5°，长行左端低、右端高。识别框必须是原图坐标下盖住整行墨迹的外接矩形，
// 不能是去倾斜坐标系里的水平带（0.17.2 修 Windows 的 TextAngle 换算；macOS Vision 实测本来就覆盖）。
// 夹具与墨迹四角由 native/ocr-host/macos/Tools/render-sample.swift --tilt 1.5 --json 生成；只用英文，
// Windows CI 只装英文 OCR 也能跑：node --test --test-name-pattern=倾斜 test/ocr-native-host.test.mjs
test('本机连接器：倾斜扫描的识别框在原图坐标里盖住整行墨迹', { skip, timeout: 120000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/ocr-tilted.png', import.meta.url));
  const expected = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/ocr-tilted.json', import.meta.url)), 'utf8'));
  const port = hostPort();
  try {
    const res = await reply(port, { v: 1, id: 't1', type: 'recognize', backend: 'system', image: pngImage(file), languages: ['en'] });
    assert.equal(res.ok, true, JSON.stringify(res.error || {}));
    const TOLERANCE = 3;
    for (const line of expected.lines) {
      const first = line.text.split(' ')[0];
      const hit = res.lines.find((l) => l.text.replace(/\s+/g, ' ').startsWith(first));
      assert.ok(hit, '应识别出以「' + first + '」开头的行：' + res.lines.map((l) => l.text).join(' | '));
      const [x, y, w, h] = hit.box;
      for (const [cx, cy] of line.corners) {
        const outside = Math.max(x - cx, cx - (x + w), y - cy, cy - (y + h), 0);
        assert.ok(outside <= TOLERANCE, '「' + first + '」行的墨迹角 (' + cx + ', ' + cy + ') 超出识别框 ' + outside.toFixed(1) + ' px，框 ' + JSON.stringify(hit.box));
      }
      // 框也不能大得离谱（例如整页框）：高度不超过墨迹带的 2 倍
      const inkTop = Math.min(...line.corners.map((c) => c[1])), inkBottom = Math.max(...line.corners.map((c) => c[1]));
      assert.ok(h <= (inkBottom - inkTop) * 2 + 10, '「' + first + '」行的框过高：' + h);
    }
  } finally {
    port.child.kill();
  }
});
