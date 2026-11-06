// 扩展页面读写配置的传输层：限时、读配置重试、保存不重试。
// 运行：node test/config-request.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { configRequest, getConfig, saveConfig, CONFIG_READ_ATTEMPTS } from '../lib/config.js';
import { translateText } from '../lib/i18n.js';

const never = () => new Promise(() => {});
const ok = (config) => ({ ok: true, config });

// 假装在扩展页面里：getConfig / saveConfig 走 chrome.runtime.sendMessage
function asExtensionPage(sendMessage, fn) {
  const saved = { document: globalThis.document, location: globalThis.location, chrome: globalThis.chrome };
  globalThis.document = {};
  globalThis.location = { protocol: 'chrome-extension:' };
  globalThis.chrome = { runtime: { sendMessage } };
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  });
}

test('读：第一次一直不回，限时后重试第二次拿到配置', async () => {
  let calls = 0;
  const send = () => (++calls === 1 ? never() : Promise.resolve(ok({ v: 2 })));
  const started = Date.now();
  const cfg = await configRequest({ type: 'config:trustedGet' }, { send, timeoutMs: 50, attempts: 3, retryDelayMs: 1 });
  assert.deepEqual(cfg, { v: 2 });
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1000);
});

test('读：没有接收端 / 没有应答都会重试，全部失败后带次数报错', async () => {
  let calls = 0;
  const send = () => { calls++; return calls === 1 ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) : Promise.resolve(undefined); };
  await assert.rejects(
    configRequest({ type: 'config:trustedGet' }, { send, timeoutMs: 50, attempts: 3, retryDelayMs: 1 }),
    (err) => err.transport === true && err.attempts === 3 && err.code === 'no_response'
  );
  assert.equal(calls, 3);
});

test('读：sendMessage 同步抛错也算传输失败并重试', async () => {
  let calls = 0;
  const send = () => { if (++calls === 1) throw new Error('Extension context invalidated.'); return Promise.resolve(ok({ v: 1 })); };
  assert.deepEqual(await configRequest({ type: 'config:trustedGet' }, { send, timeoutMs: 50, attempts: 2, retryDelayMs: 1 }), { v: 1 });
  assert.equal(calls, 2);
});

test('后台明确返回的错误不重试', async () => {
  let calls = 0;
  const send = () => { calls++; return Promise.resolve({ ok: false, error: '此操作仅限扩展设置页' }); };
  await assert.rejects(configRequest({ type: 'config:trustedGet' }, { send, timeoutMs: 50, attempts: 3, retryDelayMs: 1 }), /此操作仅限扩展设置页/);
  assert.equal(calls, 1);
});

test('默认只发一次：超时报 timeout，不再发第二次', async () => {
  let calls = 0;
  const send = () => { calls++; return never(); };
  await assert.rejects(configRequest({ type: 'config:save', patch: { a: 1 } }, { send, timeoutMs: 30 }), (err) => err.code === 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1);
});

test('getConfig（扩展页面）：worker 重启时前两次失败，第三次拿到配置', async () => {
  let calls = 0;
  const cfg = await asExtensionPage((msg) => {
    assert.equal(msg.type, 'config:trustedGet');
    calls++;
    if (calls === 1) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    if (calls === 2) return Promise.resolve(undefined);
    return Promise.resolve(ok({ targetLang: 'en' }));
  }, () => getConfig());
  assert.deepEqual(cfg, { targetLang: 'en' });
  assert.equal(calls, 3);
});

test('getConfig（扩展页面）：一直失败时给出可翻译的明确错误', async () => {
  let calls = 0;
  await assert.rejects(
    asExtensionPage(() => { calls++; return Promise.reject(new Error('Receiving end does not exist.')); }, () => getConfig()),
    (err) => {
      assert.equal(err.message, '无法读取扩展配置：后台没有响应（已尝试 ' + CONFIG_READ_ATTEMPTS + ' 次），请刷新页面重试');
      assert.notEqual(translateText(err.message), err.message);
      return true;
    }
  );
  assert.equal(calls, CONFIG_READ_ATTEMPTS);
});

test('saveConfig（扩展页面）：传输失败不重试，同一补丁只发一次', async () => {
  const sent = [];
  await assert.rejects(
    asExtensionPage((msg) => { sent.push(msg); return Promise.reject(new Error('The message port closed before a response was received.')); }, () => saveConfig({ ocrEngine: 'off' })),
    /message port closed/
  );
  assert.deepEqual(sent, [{ type: 'config:save', patch: { ocrEngine: 'off' } }]);
  const empty = [];
  await assert.rejects(asExtensionPage((msg) => { empty.push(msg); return Promise.resolve(undefined); }, () => saveConfig({ theme: 'plain' })), /无法读取或保存扩展配置/);
  assert.equal(empty.length, 1);
});

test('保存超时的错误文案有英文', () => {
  const zh = '保存没有得到后台确认（等待超过 15 秒），设置可能没有保存；请刷新页面确认后再试';
  assert.match(translateText(zh), /^Save was not confirmed by the background within 15 s/);
});
