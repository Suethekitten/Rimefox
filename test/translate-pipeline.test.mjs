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
let lastSystem = '';
globalThis.fetch = async function (url, init) {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push(texts.slice());
  lastSystem = String((body.messages[0] && body.messages[0].content) || '');
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

// 旧版本留下的坏缓存：译文里是多转义的字面 \n（升级前就存在 session 区里，还是旧的整层一个键的格式）
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
  // 缓存现在分段存：dt.cache.v1.s.index 是段号清单，dt.cache.v1.s.<段号> 是 [键, 译文] 列表
  const index = (await sessionArea.get('dt.cache.v1.s.index'))['dt.cache.v1.s.index'] || [];
  const parts = await sessionArea.get(index.map((id) => 'dt.cache.v1.s.' + id));
  const stored = Object.values(parts).flat();
  assert.equal((await sessionArea.get('dt.cache.v1'))['dt.cache.v1'], undefined, '旧格式的整层键应已迁移删掉');
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

// 内容脚本 190s 超时后会重发同一批，几个框架也可能同时翻同一段：后台这段还在翻时，不能再付一次钱
function gatedFetch(respond) {
  let open;
  const gate = new Promise((r) => {
    open = r;
  });
  const real = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    await gate;
    return respond(url, init, real);
  };
  return {
    open,
    restore() {
      globalThis.fetch = real;
    }
  };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

await t('同一段文字已经在翻：重发 / 别的框架同时请求时不再发一次，等那边的结果', async () => {
  calls = [];
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const gate = gatedFetch((url, init, real) => real(url, init));
  try {
    const first = translate(['等待中的段落〔7〕']);
    await tick();
    const second = translate(['等待中的段落〔7〕', '另一段〔7〕']);
    await tick();
    gate.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.results[0], 'T:等待中的段落〔7〕');
    assert.deepEqual(b.results, ['T:等待中的段落〔7〕', 'T:另一段〔7〕']);
    const sentTwice = calls.filter((texts) => texts.includes('等待中的段落〔7〕')).length;
    assert.equal(sentTwice, 1, '同一段只能请求一次，实际 ' + sentTwice + ' 次');
  } finally {
    gate.restore();
  }
});

await t('在途的那次失败：等着它的请求拿到同一个失败原因，之后还能重新请求', async () => {
  calls = [];
  const gate = gatedFetch(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
  try {
    const first = translate(['失败的段落〔8〕']);
    await tick();
    const second = translate(['失败的段落〔8〕']);
    await tick();
    gate.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
    assert.deepEqual(b.results, [null]);
    assert.match(b.error, /API Key/, '应带上真正的失败原因：' + b.error);
  } finally {
    gate.restore();
  }
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const again = await translate(['失败的段落〔8〕']);
  assert.equal(again.results[0], 'T:失败的段落〔8〕', '失败后不能一直挂在「在途」上');
});

// 缓存键里的术语只算这段原文命中的：加 / 改一条术语只让用到它的段落重翻，不是全站缓存失效
async function setGlossary(glossary) {
  const { config } = await localArea.get('config');
  await localArea.set({ config: { ...config, glossary } });
}

await t('加一条不相干的术语：没用到它的段落照常命中缓存；改了命中术语的译法，只有那一段重翻', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  await setGlossary([{ source: 'Rimefox', target: '凛狐' }]);
  const withTerm = 'Rimefox is a translator 〔9〕';
  const plain = 'A plain sentence 〔9〕';
  calls = [];
  await translate([withTerm, plain]);
  assert.equal(calls.length, 1);

  calls = [];
  await setGlossary([{ source: 'Rimefox', target: '凛狐' }, { source: 'Gemini', target: '双子座' }]);
  const again = await translate([withTerm, plain]);
  assert.equal(calls.length, 0, '加的术语这两段都没用到：不该重翻');
  assert.equal(again.cached, 2);

  calls = [];
  await setGlossary([{ source: 'Rimefox', target: '凛狐 Rimefox' }, { source: 'Gemini', target: '双子座' }]);
  const changed = await translate([withTerm, plain]);
  assert.deepEqual(calls, [[withTerm]], '只有用到改动那条术语的段落重翻');
  assert.equal(changed.cached, 1);
  await setGlossary([]);
});

// 划词气泡「加入术语表」：内容脚本只能经这个路由写术语表
async function storedGlossary() {
  const { config } = await localArea.get('config');
  return (config && config.glossary) || [];
}

await t('glossary:add：新增一条写进配置', async () => {
  await setGlossary([]);
  const res = await send({ type: 'glossary:add', source: 'Rimefox', target: '凛狐' });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'added');
  const list = await storedGlossary();
  assert.deepEqual(list, [{ source: 'Rimefox', target: '凛狐' }]);
});

await t('glossary:add：同名同译法不重复写', async () => {
  const again = await send({ type: 'glossary:add', source: 'rimefox', target: '凛狐' });
  assert.equal(again.action, 'same');
  assert.equal((await storedGlossary()).length, 1, '不能写成两条');
});

await t('glossary:add：同名不同译法先回 conflict，不确认就不写', async () => {
  const res = await send({ type: 'glossary:add', source: 'Rimefox', target: '霜狐' });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'conflict');
  assert.equal(res.current, '凛狐');
  assert.deepEqual(await storedGlossary(), [{ source: 'Rimefox', target: '凛狐' }]);
});

await t('glossary:add：带 overwrite 才换译法', async () => {
  const res = await send({ type: 'glossary:add', source: 'Rimefox', target: '霜狐', overwrite: true });
  assert.equal(res.action, 'updated');
  assert.deepEqual(await storedGlossary(), [{ source: 'Rimefox', target: '霜狐' }]);
});

await t('glossary:add：超长 / 空 / 非字符串一律拒绝，配置不变', async () => {
  const before = await storedGlossary();
  const long = 'x'.repeat(201);
  assert.equal((await send({ type: 'glossary:add', source: long, target: '长' })).error, 'too_long');
  assert.equal((await send({ type: 'glossary:add', source: 'ok', target: long })).error, 'too_long');
  assert.equal((await send({ type: 'glossary:add', source: '   ', target: '空原文' })).error, 'bad_value');
  assert.equal((await send({ type: 'glossary:add', source: 12, target: '数字' })).error, 'bad_value');
  assert.equal((await send({ type: 'glossary:add' })).error, 'bad_value');
  assert.deepEqual(await storedGlossary(), before);
});

await t('glossary:add：满 ' + 500 + ' 条时返回 full，不静默丢掉新条目', async () => {
  const full = Array.from({ length: 500 }, (_, i) => ({ source: 'term' + i, target: '术语' + i }));
  await setGlossary(full);
  const res = await send({ type: 'glossary:add', source: 'brand new', target: '全新' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'full');
  assert.equal(res.max, 500);
  assert.equal((await storedGlossary()).length, 500);
  await setGlossary([]);
});

// 收录进来的术语要真的进提示词，不然「再翻用新译法」只是缓存没命中而已
await t('命中术语时提示词带上对照行，没命中的批次不带', async () => {
  await setGlossary([{ source: 'Rimefox', target: '凛狐' }]);
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  await translate(['Rimefox starts this line 〔10〕']);
  assert.match(lastSystem, /Rimefox → 凛狐/, '命中的批次要注入术语');
  await translate(['A line without any term 〔10b〕']);
  assert.doesNotMatch(lastSystem, /Rimefox → 凛狐/, '没命中就不该多出术语段');
  await setGlossary([]);
});

// 输入框翻译（0.9.0）：目标语言 'auto' 跟随页面，且不读不写缓存
await t('noCache：输入框翻译不读也不写缓存', async () => {
  await setGlossary([]);
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'Draft line 〔11〕';
  calls = [];
  const first = await send({ type: 'translate', texts: [src], target: 'auto', pageLang: 'en', noCache: true });
  assert.equal(first.ok, true);
  assert.equal(first.results[0], 'T:' + src);
  assert.equal(first.cached, 0);
  assert.equal(calls.length, 1);

  calls = [];
  const second = await send({ type: 'translate', texts: [src], target: 'auto', pageLang: 'en', noCache: true });
  assert.equal(calls.length, 1, '不读缓存：第二次照常请求');
  assert.equal(second.cached, 0);

  // 不写缓存：等落盘（LIMITS.flushMs = 2500）后，存储里不该有这条草稿
  await new Promise((r) => setTimeout(r, 2700));
  const index = (await sessionArea.get('dt.cache.v1.s.index'))['dt.cache.v1.s.index'] || [];
  const parts = await sessionArea.get(index.map((id) => 'dt.cache.v1.s.' + id));
  const stored = Object.values(parts).flat();
  const key = makeKey({ ...scope, target: 'en' }, src);
  assert.equal(stored.find((pair) => pair[0] === key), undefined, '输入框的草稿不该进缓存');
});


// ---------------- 0.9.1 结构化对齐（align） ----------------
await t('align：结构化 parts → 结果仍是整段译文，alignments 走旁路缓存', async () => {
  await setGlossary([]);
  reply = (texts) => JSON.stringify(texts.map((one) => ({ parts: [{ n: 1, t: 'One:' + one }, { n: 1, t: 'Two:' + one }] })));
  calls = [];
  const src = 'Aligned source twelve';
  const first = await send({ type: 'translate', texts: [src], target: 'en', align: true });
  assert.equal(first.ok, true);
  assert.equal(first.results[0], 'One:' + src + ' Two:' + src);
  assert.deepEqual(first.alignments[0], [{ n: 1, t: 'One:' + src }, { n: 1, t: 'Two:' + src }]);
  assert.equal(calls.length, 1);
  assert.ok(lastSystem.includes('"parts"'), 'align 请求应使用结构化输出提示词');

  calls = [];
  const again = await send({ type: 'translate', texts: [src], target: 'en', align: true });
  assert.equal(calls.length, 0, '同一原文不该再发一次请求');
  assert.equal(again.cached, 1);
  assert.deepEqual(again.alignments[0], first.alignments[0], '缓存命中时对齐也要一起回来');
});

await t('align：模型不遵守格式 → 照常显示字符串译文，alignments 为 null', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  calls = [];
  const src = 'Plain fallback sentence';
  const res = await send({ type: 'translate', texts: [src], target: 'en', align: true });
  assert.equal(res.ok, true);
  assert.equal(res.results[0], 'T:' + src);
  assert.equal(res.alignments[0], null);
});

await t('align：旧缓存（没有对齐）照常命中，不因为要悬停而重翻', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'Legacy cached sentence thirteen';
  calls = [];
  await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 1);
  calls = [];
  const res = await send({ type: 'translate', texts: [src], target: 'en', align: true });
  assert.equal(calls.length, 0);
  assert.equal(res.cached, 1);
  assert.equal(res.results[0], 'T:' + src);
  assert.equal(res.alignments[0], null, '旧缓存没有对齐信息 → 悬停降级');
});

await t('align：parts 不合法但带 translation 字段 → 退回普通解析并保留译文', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => ({ translation: 'Wrap:' + one, parts: [{ n: 0, t: 'bad' }] })));
  const src = 'Malformed parts sentence';
  const res = await send({ type: 'translate', texts: [src], target: 'en', align: true });
  assert.equal(res.ok, true);
  assert.equal(res.results[0], 'Wrap:' + src);
  assert.equal(res.alignments[0], null);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
