import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArea } from './_fake-storage.mjs';
import { saveConfig, getConfig } from '../lib/config.js';
import { isKeyFailure } from '../lib/auth-state.js';

const local = makeArea({ clone: true });
const session = makeArea({ clone: true });
let listener;
globalThis.chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  runtime: { id: 'mock-extension', getURL: (p) => 'chrome-extension://mock-extension/' + p,
    onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  commands: { onCommand: { addListener() {} } }, contextMenus: { onClicked: { addListener() {} } }
};
const calls = [];
let respond;
globalThis.fetch = async (url, request) => {
  calls.push({ url, auth: request.headers.Authorization });
  if (respond) return respond(request);
  const texts = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
  return Response.json({ choices: [{ message: { content: JSON.stringify(texts.map(() => '这是正确的中文测试译文。')) }, finish_reason: 'stop' }] });
};
await saveConfig({ providerConfig: { deepseek: { engine: 'openai', baseUrl: 'https://fake.invalid/v1', model: 'fake', apiKey: 'mock-one' } }, batchSize: 1, concurrency: 1, skipSameLang: false });
await import('../background.js');
const page = { id: 'mock-extension', url: 'https://article.invalid/' };
const ui = { id: 'mock-extension', url: 'chrome-extension://mock-extension/options/index.html' };
const send = (msg, sender = page) => new Promise((resolve) => listener(msg, sender, resolve));
let n = 0;
const translate = () => send({ type: 'translate', target: 'zh-CN', texts: ['A unique translation request ' + (++n)], noCache: true });

test('trusted configuration routes reject web content and preserve concurrent UI changes', async () => {
  assert.equal((await send({ type: 'config:trustedGet' })).ok, false);
  assert.equal((await send({ type: 'config:save', patch: { uiTheme: 'dark' } })).ok, false);
  const safe = await send({ type: 'config:get' });
  assert.ok(!JSON.stringify(safe).includes('mock-one'));
  assert.equal((await send({ type: 'config:trustedGet' }, ui)).config.providerConfig.deepseek.apiKey, 'mock-one');
  await Promise.all([send({ type: 'config:save', patch: { targetLang: 'fr' } }, ui), send({ type: 'config:save', patch: { uiTheme: 'dark' } }, ui)]);
  assert.equal((await getConfig()).targetLang, 'fr');
  assert.equal((await getConfig()).uiTheme, 'dark');
});

test('401 stops queued sends and future translation requests until credentials change', async () => {
  respond = async () => Response.json({ error: { message: 'invalid API key' } }, { status: 401 });
  calls.length = 0;
  const [a, b] = await Promise.all([translate(), translate()]);
  assert.equal(a.errorCode, 'auth_paused');
  assert.equal(b.errorCode, 'auth_paused');
  assert.equal(calls.length, 1);
  assert.equal((await getConfig()).authPaused, true);
  const after = await translate();
  assert.equal(after.errorCode, 'auth_paused');
  assert.equal(calls.length, 1);
  assert.equal((await send({ type: 'test' })).ok, false, '网页不能借测试连接绕过暂停');
  assert.equal(calls.length, 1);
  respond = null;
  await saveConfig({ providerConfig: { deepseek: { apiKey: 'mock-two' } } });
  assert.equal((await translate()).ok, true);
  assert.equal(calls.length, 2);
});

test('a late 401 from replaced credentials cannot pause the new configuration', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  respond = async () => { entered(); return new Promise((resolve) => { release = () => resolve(Response.json({ error: { message: 'bad key' } }, { status: 401 })); }); };
  const old = translate();
  await started;
  await saveConfig({ providerConfig: { deepseek: { apiKey: 'mock-three' } } });
  release();
  assert.equal((await old).errorCode, 'credentials_changed');
  assert.equal((await getConfig()).authPaused, false);
  respond = null;
  assert.equal((await translate()).ok, true);
});

test('manual connection test can recover the same credentials after a transient auth failure', async () => {
  respond = async () => Response.json({ error: 'invalid key' }, { status: 401 });
  await translate();
  assert.equal((await getConfig()).authPaused, true);
  respond = null;
  assert.equal((await send({ type: 'test' }, ui)).ok, true);
  assert.equal((await getConfig()).authPaused, false);
  assert.equal((await translate()).ok, true);
});

test('ordinary permission, rate limit and network errors do not become invalid-Key pauses', async () => {
  assert.equal(isKeyFailure(403, '{"error":"permission denied"}'), false);
  assert.equal(isKeyFailure(429, 'invalid key'), false);
  assert.equal(isKeyFailure(0, 'network failed'), false);
  assert.equal(isKeyFailure(400, '{"reason":"API_KEY_INVALID"}'), true);
  assert.equal(isKeyFailure(400, '{"message":"API key not valid. Please pass a valid API key."}'), true);
  assert.equal(isKeyFailure(403, '{"message":"invalid x-api-key"}'), true);
  assert.equal(isKeyFailure(403, '{"message":"API key is expired"}'), true);
  assert.equal(isKeyFailure(403, '{"message":"API key does not have permission for this model"}'), false);
  respond = async () => Response.json({ error: { message: 'permission denied' } }, { status: 403 });
  await translate();
  assert.equal((await getConfig()).authPaused, false);
  respond = null;
  assert.equal((await translate()).ok, true);
});
