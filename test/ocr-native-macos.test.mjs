// macOS 连接器（native/ocr-host/macos）的真实识别：只在 macOS 上、且已运行 build.sh 生成二进制时执行，否则跳过。
// 运行：sh native/ocr-host/macos/build.sh && node test/ocr-native-macos.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createNativeOcrSource } from '../lib/ocr/native-source.js';
import { createOcrService } from '../lib/ocr/service.js';
import { linesToBlocks } from '../lib/ocr/layout.js';
import { encodeFrame, createFrameReader } from '../tools/ocr-mock-host/host.mjs';

const BIN = fileURLToPath(new URL('../native/ocr-host/macos/build/rimefox-ocr-host', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/ocr-sample.png', import.meta.url));
const skip = process.platform !== 'darwin' ? '仅 macOS' : !fs.existsSync(BIN) ? '未构建：先运行 native/ocr-host/macos/build.sh' : false;

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

test('macOS 连接器：握手报告系统 OCR 就绪、PaddleOCR 未安装，并识别夹具文字', { skip, timeout: 120000 }, async () => {
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
    assert.ok(system.languages.includes('zh-Hans'), '应支持简体中文');
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

test('macOS 连接器：协议版本不对时回 unsupported_protocol，未知后端回 engine_missing', { skip, timeout: 60000 }, async () => {
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
