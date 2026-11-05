#!/usr/bin/env node
// OCR 本地组件的参考 / 假宿主：实现 docs/OCR-INTERFACE.md §3 的 v1 协议，不做真实识别。
// 用途：①给正式组件开发者看帧格式与消息形状；②单测与将来的真实扩展 E2E。
//
//   node tools/ocr-mock-host/host.mjs                    作为宿主运行（由浏览器启动，stdin/stdout 走 Native Messaging 帧）
//   node tools/ocr-mock-host/host.mjs --setup <扩展ID>   生成本机宿主清单与启动脚本到 tools/ocr-mock-host/.local/，并打印安装位置
//
// 环境变量 OCR_MOCK_MODE 控制假状态：
//   ready（默认）        system 与 paddle 都就绪
//   system-only          只有 system 就绪，paddle 报 engine_missing
//   paddle-model-missing paddle 报 model_missing
//   gpu-fallback         paddle 识别时报告 GPU 失败已回退 CPU
//   protocol2            只声明协议 2（扩展应判定为 incompatible）
//   slow                 每次识别等待 OCR_MOCK_DELAY_MS（默认 3000）毫秒，用于取消测试
import { endianness } from 'node:os';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.rimefox.ocr';
const LE = endianness() === 'LE';

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  LE ? head.writeUInt32LE(body.length, 0) : head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// 增量解帧：喂入任意切分的 Buffer，回调每条完整消息。
export function createFrameReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      onMessage(JSON.parse(body));
    }
  };
}

export function helloResponse(id, mode) {
  const paddleStatus = mode === 'system-only' ? 'engine_missing' : mode === 'paddle-model-missing' ? 'model_missing' : 'ready';
  return {
    v: 1, id, type: 'hello',
    component: { version: '0.0.0-mock', platform: process.platform, protocols: mode === 'protocol2' ? [2] : [1] },
    backends: [
      { id: 'system', status: 'ready', name: 'Mock System OCR', version: '1', languages: ['zh-Hans', 'zh-Hant', 'en'] },
      { id: 'paddle', status: paddleStatus, name: 'Mock PaddleOCR', version: '0', model: 'mock-model', devices: ['gpu', 'cpu'],
        languages: ['zh-Hans', 'zh-Hant', 'en'], downloadBytes: 0, diskBytes: 0 }
    ]
  };
}

export function recognizeResponse(msg, mode) {
  const img = msg.image || {};
  const w = Number(img.width) || 1;
  const h = Number(img.height) || 1;
  if (msg.backend === 'paddle' && mode === 'system-only') {
    return { v: 1, id: msg.id, type: 'result', ok: false, error: { code: 'engine_missing', message: 'PaddleOCR engine pack not installed' } };
  }
  return {
    v: 1, id: msg.id, type: 'result', ok: true,
    backend: msg.backend,
    engine: { name: msg.backend === 'paddle' ? 'Mock PaddleOCR' : 'Mock System OCR', version: '0', model: 'mock-model', device: msg.backend === 'paddle' ? 'cpu' : '' },
    fallback: mode === 'gpu-fallback' && msg.backend === 'paddle' ? 'gpu_failed' : undefined,
    durationMs: 1,
    lines: [
      { text: '模拟识别第一行', confidence: 0.99, box: [Math.round(w * 0.1), Math.round(h * 0.1), Math.round(w * 0.8), Math.round(h * 0.05)] },
      { text: 'Mock OCR line two', confidence: 0.95, box: [Math.round(w * 0.1), Math.round(h * 0.2), Math.round(w * 0.6), Math.round(h * 0.05)] }
    ]
  };
}

function runHost() {
  const mode = process.env.OCR_MOCK_MODE || 'ready';
  const delay = Number(process.env.OCR_MOCK_DELAY_MS) || 3000;
  const cancelled = new Set();
  const send = (obj) => process.stdout.write(encodeFrame(obj));
  process.stdin.on('data', createFrameReader((msg) => {
    if (!msg || msg.v !== 1) {
      send({ v: 1, id: String((msg && msg.id) || 'r0'), type: 'result', ok: false, error: { code: 'unsupported_protocol', message: 'expected v1' } });
      return;
    }
    if (msg.type === 'hello') send(helloResponse(msg.id, mode));
    else if (msg.type === 'cancel') {
      cancelled.add(msg.target);
      send({ v: 1, id: msg.target, type: 'result', ok: false, error: { code: 'cancelled', message: 'cancelled' } });
    } else if (msg.type === 'recognize') {
      const reply = () => { if (!cancelled.delete(msg.id)) send(recognizeResponse(msg, mode)); };
      if (mode === 'slow') setTimeout(reply, delay); else reply();
    } else {
      send({ v: 1, id: String(msg.id || 'r0'), type: 'result', ok: false, error: { code: 'bad_request', message: 'unknown type' } });
    }
  }));
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('[ocr-mock-host] started, mode=' + mode + '\n'); // stderr 只用于调试；stdout 只能写协议帧
}

function setup(extensionId) {
  if (!/^[a-p]{32}$/.test(String(extensionId || ''))) {
    console.error('用法：node tools/ocr-mock-host/host.mjs --setup <32 位扩展 ID>（chrome://extensions 里复制）');
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, '.local');
  mkdirSync(out, { recursive: true });
  // 浏览器启动宿主时 PATH 很短，不能依赖 `env node`：启动脚本写死当前 Node 的绝对路径。
  const launcher = join(out, process.platform === 'win32' ? 'host.bat' : 'host.sh');
  if (process.platform === 'win32') writeFileSync(launcher, '@echo off\r\n"' + process.execPath + '" "' + join(here, 'host.mjs') + '" %*\r\n');
  else {
    writeFileSync(launcher, '#!/bin/sh\nexec "' + process.execPath + '" "' + join(here, 'host.mjs') + '" "$@"\n');
    chmodSync(launcher, 0o755);
  }
  const manifest = { name: HOST_NAME, description: 'Rimefox OCR mock host (development only)', path: launcher, type: 'stdio', allowed_origins: ['chrome-extension://' + extensionId + '/'] };
  const file = join(out, HOST_NAME + '.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  console.log('已生成：\n  ' + file + '\n  ' + launcher + '\n');
  console.log('把宿主清单放到浏览器读取的位置（只用于开发机）：');
  console.log('  macOS Chrome: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/' + HOST_NAME + '.json');
  console.log('  macOS Edge:   ~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/' + HOST_NAME + '.json');
  console.log('  Windows:      reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME + '" /ve /t REG_SZ /d "' + file + '" /f');
  console.log('                （Edge 用 HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\…）');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv[2] === '--setup') setup(process.argv[3]);
  else runHost();
}
