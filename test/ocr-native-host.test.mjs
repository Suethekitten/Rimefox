// 本机 OCR 连接器的真实识别（不经浏览器）：按平台找已构建的二进制，找不到就跳过。
//   macOS：sh native/ocr-host/macos/build.sh        → native/ocr-host/macos/build/rimefox-ocr-host
//   Windows：见 native/ocr-host/WINDOWS-HANDOFF.md   → native/ocr-host/windows/build/rimefox-ocr-host.exe
// 运行：node test/ocr-native-host.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createNativeOcrSource } from '../lib/ocr/native-source.js';
import { createOcrService } from '../lib/ocr/service.js';
import { linesToBlocks } from '../lib/ocr/layout.js';
import { encodeFrame, createFrameReader } from '../tools/ocr-mock-host/host.mjs';

const BINARIES = {
  darwin: '../native/ocr-host/macos/build/rimefox-ocr-host',
  win32: '../native/ocr-host/windows/build/rimefox-ocr-host.exe'
};
const BIN = BINARIES[process.platform] ? fileURLToPath(new URL(BINARIES[process.platform], import.meta.url)) : '';
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
    assert.match(text, /凛狐扫描页识别测试/);
    assert.match(text, /Rimefox OCR sample page 2026/);
    assert.match(text, /扫描图像只在本机识别/);
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
