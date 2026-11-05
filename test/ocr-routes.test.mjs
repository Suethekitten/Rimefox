// OCR 后台路由：只给可信扩展页；未授予 nativeMessaging 时按「未配置 / 需要授权」返回，不尝试连接本机程序。
// 运行：node test/ocr-routes.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArea } from './_fake-storage.mjs';

const local = makeArea({ clone: true });
const session = makeArea({ clone: true });
let listener;
let granted = false;
let connects = 0;
globalThis.chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  runtime: {
    id: 'ocrtestid',
    getURL: (p) => 'chrome-extension://ocrtestid/' + p,
    getManifest: () => ({ version: '0.0.0-test' }),
    onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }
  },
  permissions: {
    contains: async () => granted,
    onAdded: { addListener() {} }, onRemoved: { addListener() {} }
  },
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} } }
};
await import('../background.js');
const { saveConfig } = await import('../lib/config.js');

const trusted = { id: 'ocrtestid', url: 'chrome-extension://ocrtestid/reader/index.html' };
const page = { url: 'https://article.invalid/' };
const send = (msg, sender) => new Promise((resolve) => listener(msg, sender, resolve));

test('网页内容脚本不能调用 OCR 路由', async () => {
  for (const type of ['ocr:status', 'ocr:recognize', 'ocr:cancel']) {
    const res = await send({ type }, page);
    assert.equal(res.ok, false, type);
  }
});

test('预览版：旧自动 / Paddle 偏好均只解析系统 OCR，未授权时不连接', async () => {
  const auto = await send({ type: 'ocr:status' }, trusted);
  assert.equal(auto.ok, true);
  assert.equal(auto.ocr.choice, 'system');
  assert.equal(auto.ocr.status, 'permission_needed');
  assert.equal(auto.ocr.reason, 'permission_needed');
  await saveConfig({ ocrEngine: 'paddle' });
  const explicit = await send({ type: 'ocr:status' }, trusted);
  assert.equal(explicit.ocr.choice, 'system');
  assert.equal(explicit.ocr.status, 'permission_needed');
  const rec = await send({ type: 'ocr:recognize', image: { mime: 'image/png', data: 'iVBORw0KGgo=', width: 1, height: 1 } }, trusted);
  assert.deepEqual([rec.ok, rec.errorCode], [false, 'permission_needed']);
  assert.equal(connects, 0);
});

test('已授权但浏览器未提供 connectNative：同样报需要授权；坏请求报 bad_request', async () => {
  granted = true;
  const res = await send({ type: 'ocr:status', refresh: true }, trusted);
  assert.equal(res.ocr.status, 'permission_needed');
  const bad = await send({ type: 'ocr:recognize', image: { mime: 'image/gif', data: '', width: 1, height: 1 } }, trusted);
  assert.deepEqual([bad.ok, bad.errorCode], [false, 'bad_request']);
  const cancel = await send({ type: 'ocr:cancel', jobId: 'none' }, trusted);
  assert.deepEqual([cancel.ok, cancel.cancelled], [true, false]);
});
