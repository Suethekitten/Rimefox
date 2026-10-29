// 字幕费用边界回归（V8）：真实 background.js + 假 fetch / 假存储。
// 目标：伪造的 cid / id_str / cacheScope 既不能让同一段字幕重复计费，也不能无限拉高请求数。
// 运行：node test/subtitle-budget-pipeline.test.mjs
import assert from 'node:assert/strict';

import { makeArea } from './_fake-storage.mjs';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

const localArea = makeArea({ clone: true });
const sessionArea = makeArea({ clone: true });
let listener = null;
globalThis.chrome = {
  storage: { local: localArea, session: sessionArea, onChanged: { addListener() {} } },
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    lastError: undefined,
    sendMessage: async () => ({ ok: true }),
    openOptionsPage() {}
  },
  tabs: { onRemoved: { addListener() {} }, sendMessage: async () => {}, query: async () => [] },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} }, removeAll(cb) { if (cb) cb(); }, create() {} },
  scripting: { executeScript: async () => [], insertCSS: async () => {} }
};

let calls = [];
globalThis.fetch = async function (url, init) {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push(texts.slice());
  const json = { choices: [{ message: { content: JSON.stringify(texts.map((one) => 'T:' + one)) }, finish_reason: 'stop' }] };
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

await localArea.set({
  config: {
    _v: 99,
    currentProvider: 'deepseek',
    providerConfig: { deepseek: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'sk-test', model: 'fake' } },
    targetLang: 'en',
    batchSize: 8,
    maxCharsPerBatch: 3000,
    privacyEnabled: false
  }
});

await import('../background.js');

const PAGE = 'https://www.bilibili.com/video/BV1xx411c7mD';
function sendSub(texts, cacheScope, tabId, url, target) {
  return new Promise((resolve) => {
    listener(
      { type: 'translate', texts, target: target || 'en', style: 'plain', cacheScope: cacheScope },
      { url: url || PAGE, tab: { id: tabId } },
      resolve
    );
  });
}

console.log('\n[字幕费用边界：身份重放 / 预算]');

await t('伪造的 cid 换了 cacheScope：同一段字幕只请求一次', async function () {
  calls = [];
  const text = '同一句字幕文本，只应该付费一次。';
  const first = await sendSub([text], 'bilibili|BV1xx411c7mD:1001|en-id:en-US|en-US', 7);
  const second = await sendSub([text], 'bilibili|BV1xx411c7mD:2002|en-id:en-US|en-US', 7);
  const third = await sendSub([text], 'bilibili|BV1xx411c7mD:3003|zh-id:zh-CN|zh-CN', 7);
  assert.equal(calls.length, 1, '同一段文字不应该因为换了 cid / id_str 再发请求');
  assert.equal(first.results[0], 'T:' + text);
  assert.equal(second.results[0], 'T:' + text);
  assert.equal(third.results[0], 'T:' + text);
});

await t('同一段文字换了源语言轨道：共用译文，仍然只请求一次', async function () {
  calls = [];
  const text = 'Yes.';
  const en = await sendSub([text], 'bilibili|BV1xx411c7mD:1|en-id:en-US|en-US', 12);
  const ja = await sendSub([text], 'bilibili|BV1xx411c7mD:1|ja-id:ja-JP|ja-JP', 12);
  assert.equal(calls.length, 1);
  assert.equal(en.results[0], 'T:Yes.');
  assert.equal(ja.results[0], 'T:Yes.');
});

await t('YouTube 不跟着改契约：不同视频的同文仍各翻一次', async function () {
  calls = [];
  const text = 'Shared line on YouTube.';
  await sendSub([text], 'youtube|abc|en:manual|en', 13, 'https://www.youtube.com/watch?v=abc');
  await sendSub([text], 'youtube|def|en:manual|en', 13, 'https://www.youtube.com/watch?v=def');
  assert.equal(calls.length, 2);
});

await t('换目标语言是新的计费身份：同文本不跨配置复用', async function () {
  calls = [];
  const text = 'Configuration is part of the identity.';
  await sendSub([text], 'bilibili|BV1xx411c7mD:1|en-id:en-US|en-US', 14, PAGE, 'en');
  await sendSub([text], 'bilibili|BV1xx411c7mD:1|en-id:en-US|en-US', 14, PAGE, 'zh-CN');
  assert.equal(calls.length, 2);
});

await t('轮换身份 + 新文本：请求数被后台预算卡住，且返回可识别的 errorCode', async function () {
  calls = [];
  let last = null;
  for (let i = 0; i < 100; i += 1) {
    last = await sendSub(['伪造字幕 ' + i], 'bilibili|BV1xx411c7mD:' + (9000 + i) + '|id-' + i + ':en-US|en-US', 8);
  }
  assert.equal(calls.length, 89, '窗口上限 90 次 HTTP；每笔先预留 2 次，所以最后一笔要 2 次余量');
  assert.equal(last.errorCode, 'subtitle_budget');
  assert.match(String(last.error), /上限/);
});

await t('预算按标签页隔离：换一个标签页仍是完整额度（跨标签页总量另算）', async function () {
  calls = [];
  const res = await sendSub(['另一个标签页的字幕'], 'bilibili|BV1xx411c7mD:1|en-id:en-US|en-US', 9);
  assert.equal(calls.length, 1);
  assert.equal(res.errorCode, '');
  assert.equal(res.results[0], 'T:另一个标签页的字幕');
});

await t('账本写进 session（总量 + 窗口），service worker 被回收后限额不会从零开始', async function () {
  await new Promise((r) => setTimeout(r, 20));
  const got = await sessionArea.get('subtitle-budget:8');
  const state = got['subtitle-budget:8'];
  assert.equal(state.requests, 89);
  assert.ok(state.chars > 0);
  assert.ok(Array.isArray(state.win) && state.win.length > 0);
  const globalGot = await sessionArea.get('subtitle-budget:global');
  assert.ok(globalGot['subtitle-budget:global'].requests >= 89);
});

await t('页面伪造的超长 / 非法 cacheScope 不当作字幕请求，也不进预算', async function () {
  calls = [];
  const res = await sendSub(['普通文本'], 'x'.repeat(400), 10);
  assert.notEqual(res.errorCode, 'subtitle_budget');
  const got = await sessionArea.get('subtitle-budget:10');
  assert.equal(Object.keys(got).length, 0);
});

console.log('\n' + pass + ' 通过 / ' + (pass + fail) + ' 总数');
if (fail) process.exit(1);
