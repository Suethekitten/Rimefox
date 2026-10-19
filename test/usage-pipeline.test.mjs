// 用量诊断的管线测试：假 chrome + 假 fetch，验证请求数 / 缓存 / 拆批 / usage 汇总。
// 运行：node test/usage-pipeline.test.mjs
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

function makeArea() {
  const data = new Map();
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => { if (data.has(k)) out[k] = data.get(k); });
        return out;
      }
      return {};
    },
    async set(obj) { Object.keys(obj || {}).forEach((k) => data.set(k, obj[k])); },
    async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k)); },
    async setAccessLevel() { return Promise.resolve(); },
    async getBytesInUse() { return 0; }
  };
}
const localArea = makeArea();
const sessionArea = makeArea();
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

let mode = 'normal';
let calls = [];
globalThis.fetch = async function (url, init) {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push(texts.slice());
  if (mode === 'half' && texts.length === 1 && texts[0] === 'Alpha one.') {
    return new Response('bad request', { status: 400, headers: { 'content-type': 'text/plain' } });
  }
  const out = (mode === 'mismatch' || mode === 'half') && texts.length > 1
    ? texts.slice(0, 1).map((one) => 'T:' + one)
    : texts.map((one) => 'T:' + one);
  const json = {
    choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }]
  };
  if (mode !== 'nousage') {
    json.usage = { prompt_tokens: 10 * texts.length, completion_tokens: 5 * texts.length };
  }
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

const baseConfig = {
  _v: 99,
  currentProvider: 'deepseek',
  providerConfig: {
    deepseek: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'sk-test', model: 'fake' }
  },
  targetLang: 'ja',
  batchSize: 8,
  maxCharsPerBatch: 3000,
  debug: true,
  privacyEnabled: false
};
async function setConfig(patch) {
  await localArea.set({ config: { ...baseConfig, ...patch } });
}
function send(msg) {
  return new Promise((resolve) => {
    listener(msg, { url: 'https://example.com/' }, resolve);
  });
}
async function translate(texts) {
  return send({ type: 'translate', texts: texts, target: 'ja', style: 'plain' });
}
async function stats() {
  const out = await send({ type: 'usage:stats' });
  assert.equal(out.ok, true, out.error);
  return out.stats;
}
async function resetStats() {
  const out = await send({ type: 'usage:reset' });
  assert.equal(out.ok, true, out.error);
}

await import('../background.js');

console.log('\n[用量诊断管线]');

await setConfig({ debug: true });
await resetStats();
calls = [];
mode = 'normal';
let res = await translate(['Hello A.', 'World B.']);
t('正常批次：1 次 HTTP、2 条 usage、输入/输出 token 汇总', async () => {
  assert.deepEqual(res.results, ['T:Hello A.', 'T:World B.']);
});
let s = await stats();
t('统计：requests=1、responses=1、input=20、output=10、cacheMisses=2', () => {
  assert.equal(s.requests, 1);
  assert.equal(s.responses, 1);
  assert.equal(s.usageResponses, 1);
  assert.equal(s.inputTokens, 20);
  assert.equal(s.outputTokens, 10);
  assert.equal(s.cacheMisses, 2);
  assert.equal(s.cacheHits, 0);
});

calls = [];
res = await translate(['Hello A.', 'World B.']);
s = await stats();
t('热缓存：不再发 HTTP，cacheHits 增加', async () => {
  assert.deepEqual(res.results, ['T:Hello A.', 'T:World B.']);
  assert.equal(calls.length, 0);
  assert.equal(s.requests, 1);
  assert.equal(s.cacheHits, 2);
});

await resetStats();
calls = [];
mode = 'mismatch';
res = await translate(['Alpha one.', 'Beta two.']);
s = await stats();
t('条数不匹配：1 次失败响应 + 2 个半批 = 3 次 HTTP、1 次拆批', () => {
  assert.deepEqual(res.results, ['T:Alpha one.', 'T:Beta two.']);
  assert.equal(calls.length, 3);
  assert.equal(s.requests, 3);
  assert.equal(s.responses, 3);
  assert.equal(s.splits, 1);
  assert.equal(s.discarded, 1);
  assert.equal(s.inputTokens, 40);
  assert.equal(s.outputTokens, 20);
});

await resetStats();
calls = [];
mode = 'half';
res = await translate(['Alpha one.', 'Beta two.']);
s = await stats();
t('拆批一半失败：保留另一半结果，只把失败的一半标 null', async () => {
  assert.deepEqual(res.results, [null, 'T:Beta two.']);
  assert.equal(res.failed, 1);
  assert.equal(calls.length, 3);
  assert.equal(s.requests, 3);
  assert.equal(s.splits, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.discarded, 1);
});
calls = [];
res = await translate(['Beta two.']);
t('失败一半的成功结果仍写入缓存', () => {
  assert.deepEqual(res.results, ['T:Beta two.']);
  assert.equal(calls.length, 0);
});

await resetStats();
mode = 'nousage';
res = await translate(['No usage.']);
s = await stats();
t('服务商不返回 usage：标记 unknown，不编造 token', () => {
  assert.deepEqual(res.results, ['T:No usage.']);
  assert.equal(s.requests, 1);
  assert.equal(s.usageResponses, 0);
  assert.equal(s.unknownUsageResponses, 1);
  assert.equal(s.inputTokens, 0);
});

await setConfig({ debug: false });
const denied = await send({ type: 'usage:stats' });
t('调试关闭时拒绝返回统计', () => {
  assert.equal(denied.ok, false);
  assert.match(denied.error, /调试/);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);