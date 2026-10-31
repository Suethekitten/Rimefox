// Real router/config/cache with in-memory storage and a fake API; no paid requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArea } from './_fake-storage.mjs';

const local = makeArea({ clone: true });
const session = makeArea({ clone: true });
let listener;
globalThis.chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  runtime: { onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} } }
};
const slot = { engine: 'openai', baseUrl: 'https://api-a.invalid/v1', apiKey: 'mock-only', model: 'same-model' };
await local.set({ config: {
  _v: 7, currentProvider: '__custom__', customProviders: [{ id: '__custom__', name: 'Mock API' }],
  providerConfig: { __custom__: slot }, thinkingMode: 'auto', targetLang: 'zh-CN'
} });
let calls = [];
let hold = false;
let releases = [];
globalThis.fetch = async (url, init) => {
  const engine = init.headers['x-api-key'] ? 'anthropic' : 'openai';
  const body = JSON.parse(init.body);
  const inputs = JSON.parse(body.messages[body.messages.length - 1].content);
  calls.push({ url, engine });
  if (hold) await new Promise(resolve => releases.push(resolve));
  const text = JSON.stringify(inputs.map(() => (url.includes('api-a') ? '甲' : '乙') + engine + '接口译文'));
  return Response.json(engine === 'anthropic'
    ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
    : { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
};
await import('../background.js');
const { getConfig, saveConfig } = await import('../lib/config.js');
const cache = await import('../lib/cache.js');
const send = msg => new Promise(resolve => listener(msg, { url: 'https://article.invalid/review' }, resolve));
const add = (source, target, overwrite = false) => send({ type: 'glossary:add', source, target, overwrite });
const translate = text => send({ type: 'translate', target: 'zh-CN', texts: [text] });
const setSlot = patch => saveConfig({ providerConfig: { __custom__: patch } });

test('concurrent additions preserve both entries and unrelated settings', async () => {
  const before = await getConfig();
  const results = await Promise.all([add('alpha', '甲'), add('beta', '乙')]);
  assert.deepEqual(results.map(x => x.action), ['added', 'added']);
  const after = await getConfig();
  assert.deepEqual(after.glossary.map(x => x.source), ['alpha', 'beta']);
  assert.deepEqual(after.providerConfig, before.providerConfig);
});

test('concurrent conflicting additions require confirmation against the latest entry', async () => {
  await saveConfig({ glossary: [] });
  const results = await Promise.all([add('same term', '甲'), add('same term', '乙')]);
  assert.deepEqual(results.map(x => x.action), ['added', 'conflict']);
  assert.equal(results[1].current, '甲');
  assert.deepEqual((await getConfig()).glossary, [{ source: 'same term', target: '甲' }]);
});

test('concurrent overwrites preserve both updates, notes and categories', async () => {
  const entries = ['alpha', 'beta'].map(source => ({ source, target: '旧', category: '分类', note: '语境说明' }));
  await saveConfig({ glossary: entries });
  const results = await Promise.all([add('alpha', '甲', true), add('beta', '乙', true)]);
  assert.deepEqual(results.map(x => x.action), ['updated', 'updated']);
  assert.deepEqual((await getConfig()).glossary, entries.map((x, i) => ({ ...x, target: i ? '乙' : '甲' })));
});

test('concurrent additions at the limit cannot silently replace a successful addition', async () => {
  await saveConfig({ glossary: Array.from({ length: 499 }, (_, i) => ({ source: 'term ' + i, target: '词' + i })) });
  const results = await Promise.all([add('last slot', '最后'), add('overflow', '溢出')]);
  assert.equal(results[0].action, 'added');
  assert.equal(results[1].error, 'full');
  const rows = (await getConfig()).glossary;
  assert.equal(rows.length, 500);
  assert.equal(rows[499].source, 'last slot');
});

test('an invalid queued update rejects atomically without blocking subsequent saves', async () => {
  const before = await getConfig();
  await assert.rejects(saveConfig(() => ({ glossary: [{ source: 'bad', target: '坏', note: '中'.repeat(501) }] })), /超过 500/);
  assert.deepEqual(await getConfig(), before);
  await saveConfig({ glossary: [] });
  assert.equal((await add('after failure', '恢复')).action, 'added');
});

test('changing endpoints isolates caches, normalizes trailing slashes and preserves each endpoint cache', async () => {
  await saveConfig({ glossary: [] });
  calls = [];
  const first = await translate('Endpoint identity');
  await setSlot({ baseUrl: 'https://api-b.invalid/v1' });
  const second = await translate('Endpoint identity');
  assert.deepEqual(first.results, ['甲openai接口译文']);
  assert.deepEqual(second.results, ['乙openai接口译文']);
  assert.equal(calls.length, 2);
  await setSlot({ baseUrl: '  https://api-b.invalid/v1///  ' });
  assert.equal((await translate('Endpoint identity')).cached, 1);
  await setSlot(slot);
  assert.deepEqual((await translate('Endpoint identity')).results, first.results);
  assert.equal(calls.length, 2);
});

test('changing protocols at the same address and model does not reuse the former protocol cache', async () => {
  calls = [];
  const first = await translate('Protocol identity');
  await setSlot({ engine: 'anthropic' });
  const second = await translate('Protocol identity');
  assert.deepEqual(first.results, ['甲openai接口译文']);
  assert.deepEqual(second.results, ['甲anthropic接口译文']);
  assert.deepEqual(calls.map(x => x.engine), ['openai', 'anthropic']);
  await setSlot(slot);
});

test('unscoped legacy cache entries are retained but cannot be attributed to the current endpoint', async () => {
  calls = [];
  const text = 'Unscoped legacy';
  const oldKey = cache.makeKey({ target: 'zh-CN', model: '__custom__:same-model', host: 'article.invalid' }, text);
  cache.set(oldKey, '不能确认来源的旧译文');
  assert.deepEqual((await translate(text)).results, ['甲openai接口译文']);
  assert.equal(calls.length, 1);
  assert.equal(cache.get(oldKey), '不能确认来源的旧译文');
});

test('a new endpoint cannot join the old endpoint request while it is in flight', async () => {
  calls = [];
  releases = [];
  hold = true;
  const waitCalls = async count => {
    for (let i = 0; i < 100 && calls.length < count; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  };
  const requests = [];
  let observed;
  try {
    requests.push(translate('In-flight identity'));
    await waitCalls(1);
    await setSlot({ baseUrl: 'https://api-b.invalid/v1' });
    requests.push(translate('In-flight identity'));
    await waitCalls(2);
    observed = calls.length;
  } finally {
    hold = false;
    releases.forEach(resolve => resolve());
  }
  const results = await Promise.all(requests);
  assert.equal(observed, 2);
  assert.deepEqual(results.map(x => x.results[0]), ['甲openai接口译文', '乙openai接口译文']);
});


test('subtitle:fetch only accepts allow-listed CDN URLs from Bilibili video pages', async () => {
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    const res = new Response(JSON.stringify({ body: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    // 模拟签名地址 302 到白名单外：跟随之后仍要按最终 URL 拒绝（V14）
    if (String(url).indexOf('redirect-evil') >= 0) {
      Object.defineProperty(res, 'url', { value: 'https://evil.example/x' });
    }
    return res;
  };
  const sendFrom = (pageUrl, msg) => new Promise(resolve => listener(msg, { url: pageUrl }, resolve));
  try {
    const allowed = await sendFrom('https://www.bilibili.com/zh-Hans/video/BV1xx411c7mD', {
      type: 'subtitle:fetch', url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/demo?auth_key=fake'
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.text, '{"body":[]}');
    assert.equal(seen.init.credentials, 'omit');
    assert.equal(seen.init.redirect, 'follow');
    const redirectedAway = await sendFrom('https://www.bilibili.com/video/BV1xx411c7mD', {
      type: 'subtitle:fetch', url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/redirect-evil?auth_key=fake'
    });
    assert.equal(redirectedAway.ok, false);
    assert.equal(redirectedAway.error, 'bad_redirect');
    const rejectedUrl = await sendFrom('https://www.bilibili.com/video/BV1xx411c7mD', {
      type: 'subtitle:fetch', url: 'https://evil.example/subtitle.json'
    });
    assert.equal(rejectedUrl.ok, false);
    const rejectedOrigin = await sendFrom('https://example.com/article', {
      type: 'subtitle:fetch', url: 'https://i0.hdslb.com/bfs/subtitle/demo.json'
    });
    assert.equal(rejectedOrigin.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
