// 翻译管线回归（0.8.7）：真实 background.js + 假 fetch / 假存储，验证模型回包 → 解析 → 换行规范化 → 写入前校验 → 缓存。
// 重点是 Pixiv 中译英偶发的字面 \n：新请求、旧缓存命中都不能再把反斜杠 + n 送到网页上。
// 运行：node test/translate-pipeline.test.mjs
import assert from 'node:assert/strict';

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

function makeArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: JSON.parse(JSON.stringify(data.get(keys))) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (data.has(k)) out[k] = data.get(k);
        });
        return out;
      }
      return {};
    },
    async set(obj) {
      Object.keys(obj || {}).forEach((k) => data.set(k, JSON.parse(JSON.stringify(obj[k]))));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k));
    },
    async setAccessLevel() {},
    async getBytesInUse() {
      return 0;
    }
  };
}

const BS = '\\';
const HOST = 'www.pixiv.net';
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

// 假模型：reply(texts) 返回 content 原文（字符串）；每次请求记一笔
let reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
let calls = [];
globalThis.fetch = async function (url, init) {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push(texts.slice());
  const json = { choices: [{ message: { content: reply(texts) }, finish_reason: 'stop' }] };
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

// 只借 makeKey 算键：带查询串导入成独立的模块实例，免得提前建好 background 用的那份缓存（它在导入时就读存储）
const { makeKey } = await import('../lib/cache.js?keys-only');
const { promptFingerprint } = await import('../lib/prompt.js');
const { glossaryFingerprint, normalizeGlossary } = await import('../lib/glossary.js');
const scope = {
  target: 'en',
  style: 'plain',
  model: 'deepseek:fake',
  host: HOST,
  glossary: glossaryFingerprint(normalizeGlossary([])),
  prompt: promptFingerprint('')
};

// 旧版本留下的坏缓存：译文里是多转义的字面 \n（升级前就存在 session 区里）
const LEGACY_SRC = '「你在做什么？」她问。\n「我在等人。」〔旧缓存〕';
const LEGACY_BAD = '"What are you doing?" she asked.' + BS + 'n"I\'m waiting for someone."';
const LEAKY_SRC = '「走吧。」〔旧缓存 2〕';
await sessionArea.set({
  'dt.cache.v1': {
    entries: [
      [makeKey(scope, LEGACY_SRC), LEGACY_BAD],
      [makeKey(scope, LEAKY_SRC), '{"translation": "Let\'s go."}']
    ]
  }
});
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

function send(msg) {
  return new Promise((resolve) => {
    listener(msg, { url: 'https://' + HOST + '/novel/show.php?id=1' }, resolve);
  });
}
function translate(texts) {
  return send({ type: 'translate', texts, target: 'en', style: 'plain' });
}
const hasLiteral = (s) => typeof s === 'string' && s.includes(BS + 'n');

console.log('\n[翻译管线：换行 / 校验 / 缓存]');

await t('模型多转义一层：网页拿到真换行，缓存里存的也是修好的', async () => {
  calls = [];
  const src = '「你在做什么？」她问。\n「我在等人。」〔1〕';
  reply = () => '[' + JSON.stringify('"What are you doing?" she asked.' + BS + 'n"I\'m waiting for someone."') + ']';
  const res = await translate([src]);
  assert.equal(res.results[0], '"What are you doing?" she asked.\n"I\'m waiting for someone."');
  reply = () => '["SHOULD NOT BE USED"]';
  const again = await translate([src]);
  assert.equal(calls.length, 1, '第二次应命中缓存');
  assert.equal(again.cached, 1);
  assert.equal(again.results[0], res.results[0]);
});

await t('旧缓存里的字面 \\n：命中时就修好，不发请求，并把修好的写回存储', async () => {
  calls = [];
  const res = await translate([LEGACY_SRC]);
  assert.equal(calls.length, 0, '旧缓存可以修好，不该重翻');
  assert.equal(res.cached, 1);
  assert.equal(res.results[0], '"What are you doing?" she asked.\n"I\'m waiting for someone."');
  await new Promise((r) => setTimeout(r, 2700)); // 等缓存延迟落盘（LIMITS.flushMs = 2500）
  const stored = (await sessionArea.get('dt.cache.v1'))['dt.cache.v1'].entries;
  const row = stored.find((pair) => pair[0] === makeKey(scope, LEGACY_SRC));
  assert.ok(row && !hasLiteral(row[1]), '存储里的旧值应已修好：' + (row && row[1]));
});

await t('旧缓存里残留 JSON 包装：当作没命中，重新翻译，不把包装插进网页', async () => {
  calls = [];
  reply = (texts) => JSON.stringify(texts.map(() => '"Let\'s go."'));
  const res = await translate([LEAKY_SRC]);
  assert.equal(calls.length, 1, '坏缓存应重翻一次');
  assert.equal(res.results[0], '"Let\'s go."');
});

await t('新回包残留 JSON 包装：这一条按失败（null）处理、不进缓存，其它条照常', async () => {
  calls = [];
  reply = () => '["{\\"translation\\": \\"Hello\\"}", "World."]';
  const res = await translate(['你好〔3〕', '世界〔3〕']);
  assert.equal(res.results[0], null, '包装不能当译文');
  assert.equal(res.results[1], 'World.');
  reply = (texts) => JSON.stringify(texts.map(() => 'Hello.'));
  const again = await translate(['你好〔3〕']);
  assert.equal(calls.length, 2, '失败的那条没进缓存，下次重新请求');
  assert.equal(again.results[0], 'Hello.');
});

await t('原文是代码（带反斜杠）：译文里的字面 \\n 原样保留，进出缓存都不变', async () => {
  calls = [];
  const src = 'console.log("a' + BS + 'nb") 〔4〕';
  reply = () => '[' + JSON.stringify('console.log("a' + BS + 'nb") (4)') + ']';
  const res = await translate([src]);
  assert.equal(res.results[0], 'console.log("a' + BS + 'nb") (4)');
  const again = await translate([src]);
  assert.equal(again.results[0], res.results[0]);
  assert.equal(calls.length, 1);
});

await t('可确定的格式问题不再拆批重发：结尾逗号、对象包装都是一次请求', async () => {
  calls = [];
  reply = (texts) => '[' + texts.map((one) => JSON.stringify('T:' + one)).join(',') + ',]';
  const a = await translate(['甲〔5〕', '乙〔5〕', '丙〔5〕']);
  assert.deepEqual(a.results, ['T:甲〔5〕', 'T:乙〔5〕', 'T:丙〔5〕']);
  assert.equal(calls.length, 1, '结尾逗号：0.8.6 会解析失败、拆成 3 次以上请求');
  calls = [];
  reply = (texts) => JSON.stringify(texts.map((one) => ({ translation: 'T:' + one })));
  const b = await translate(['丁〔5〕', '戊〔5〕']);
  assert.deepEqual(b.results, ['T:丁〔5〕', 'T:戊〔5〕']);
  assert.equal(calls.length, 1);
});

await t('认不出的结构照样失败：不把对象 / 字段名插进网页', async () => {
  calls = [];
  reply = (texts) => JSON.stringify(texts.map((one) => ({ id: 1, value: 'T:' + one })));
  const res = await translate(['己〔6〕']);
  assert.notEqual(res.results[0], '[object Object]');
  assert.ok(res.results[0] === null || !/object Object|"value"/.test(res.results[0]), '不能插入结构碎片：' + res.results[0]);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
