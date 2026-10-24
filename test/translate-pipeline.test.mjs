// 翻译管线回归（0.8.7）：真实 background.js + 假 fetch / 假存储，验证模型回包 → 解析 → 换行规范化 → 写入前校验 → 缓存。
// 重点是 Pixiv 中译英偶发的字面 \n：新请求、旧缓存命中都不能再把反斜杠 + n 送到网页上。
// 运行：node test/translate-pipeline.test.mjs
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


const BS = '\\';
const HOST = 'www.pixiv.net';
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

// 假模型：reply(texts) 返回 content 原文（字符串）；每次请求记一笔
let reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
let calls = [];
let lastSystem = '';
let lastBody = null;
globalThis.fetch = async function (url, init) {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push(texts.slice());
  lastBody = body;
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
  endpoint: '["openai","https://fake.local/v1"]',
  host: HOST,
  glossary: glossaryFingerprint(normalizeGlossary([])),
  prompt: promptFingerprint('')
};

// 旧版本留下的坏缓存：译文里是多转义的字面 \n（升级前就存在 session 区里，还是旧的整层一个键的格式）
const LEGACY_SRC = '「你在做什么？」她问。\n「我在等人。」〔旧缓存〕';
const LEGACY_BAD = '"What are you doing?" she asked.' + BS + 'n"I\'m waiting for someone."';
const LEAKY_SRC = '「走吧。」〔旧缓存 2〕';
// 0.9.6：缓存键标记 en、内容却是整段中文（0.9.5 align 提示词的中文示例带偏模型后留下的）
const BAD_EN_SRC = 'ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。';
const BAD_EN_VALUE =
  '某日傍晚，一个下人正在罗生门下避雨。宽广的门下，除了这个男人以外，一个人也没有，只有一只蟋蟀停在斑驳的朱漆大圆柱上。';
// 同一目标语言下正常的英文缓存：不能被上面的定向失效连累
const GOOD_EN_SRC = 'Aligned English cache source fifteen';
const GOOD_EN_VALUE = 'The cached English translation is still valid, and it should stay.';
// 文献引用改成保留区之前，旧版本把引用编号压平进译文写进了缓存（缓存键是送翻文本，没有 <kN> 标记）
const CITE_FLAT_SRC = 'Variants associated with common complex human diseases1,2. 〔cite〕';
const CITE_FLAT_VALUE = 'Variants linked to common complex human diseases1,2 (old flattened cache).';
await sessionArea.set({
  'dt.cache.v1': {
    entries: [
      [makeKey(scope, LEGACY_SRC), LEGACY_BAD],
      [makeKey(scope, LEAKY_SRC), '{"translation": "Let\'s go."}'],
      [makeKey(scope, BAD_EN_SRC), BAD_EN_VALUE],
      [makeKey(scope, GOOD_EN_SRC), GOOD_EN_VALUE],
      [makeKey(scope, CITE_FLAT_SRC), CITE_FLAT_VALUE]
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

// 段落里的 notranslate（内容脚本用 <kN> 包住送来）：带标记的批次提示词要说明「原样照抄」，其它批次不加
await t('保留标记：带 <k1> 的批次提示词加说明，回包原样带标记交回内容脚本', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => one.replace('Install', 'Installiere')));
  const res = await translate(['Install <k1>Rimefox</k1> from the store 〔keep〕']);
  assert.match(lastSystem, /保留标记（必须原样保留）/, '带标记的批次要有保留说明');
  assert.equal(res.results[0], 'Installiere <k1>Rimefox</k1> from the store 〔keep〕');
  await translate(['A line without keep marks 〔keep b〕']);
  assert.doesNotMatch(lastSystem, /保留标记/, '没有标记就不该多出保留说明');
});

// 文献引用（Nature 上标）：带 <kN> 标记的送翻文本和旧版本压平的原文是两个缓存键。
// 旧的压平译文不会被带标记的段落命中，也不需要清空缓存 —— 旧条目原样留着，随容量淘汰
await t('文献引用：带标记的段落不命中旧的压平缓存，旧条目不被清空', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => one.replace('Variants associated with', 'Variants linked to')));
  const marked = 'Variants associated with common complex human diseases<k1>1,2</k1>. 〔cite〕';
  calls = [];
  const fresh = await translate([marked]);
  assert.equal(calls.length, 1, '带标记的文本要真的去问模型，不能拿旧的压平译文');
  assert.equal(fresh.cached, 0);
  assert.equal(fresh.results[0], 'Variants linked to common complex human diseases<k1>1,2</k1>. 〔cite〕');
  assert.match(lastSystem, /文献引用编号/, '带标记的批次提示词要提到引用编号');
  calls = [];
  const old = await translate([CITE_FLAT_SRC]);
  assert.equal(calls.length, 0, '旧条目还在：没有被全局清空');
  assert.equal(old.results[0], CITE_FLAT_VALUE);
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

// ---------------- 0.9.6 目标语言：普通 / align 共用一套，缓存不能把中文当英文 ----------------
const JP_LONG =
  'ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。広い門の下には、この男のほかに誰もいない。';
const ZH_LONG =
  '某日傍晚，一个下人正在罗生门下避雨。宽广的门下，除了这个男人以外，一个人也没有，只有一只蟋蟀停在斑驳的朱漆大圆柱上。';
const EN_LONG =
  'It was an evening in late autumn. A lowly servant was waiting for the rain to stop under the Rashomon gate. Nobody else was there.';

// 受控假模型：系统提示词里明确写了「唯一目标语言：English (en)」才回英文，
// 否则回中文 —— 这正是 0.9.5 的 align 提示词（没写目标语言、示例还是中文）会诱导出的行为。
// 提示词以后如果把这条约束改掉，下面的用例会重新变红。
function englishAwareReply(texts) {
  const explicit = /唯一目标语言：English \(en\)/.test(lastSystem);
  const aligned = /"parts"/.test(lastSystem);
  const value = explicit ? 'This is the English translation.' : ZH_LONG;
  return JSON.stringify(texts.map(() => (aligned ? { parts: [{ n: 1, t: value }] } : value)));
}

await t('align：提示词明确 English (en)，假模型才回英文；结构化 parts 正常解析', async () => {
  await setGlossary([]);
  reply = englishAwareReply;
  calls = [];
  const res = await send({ type: 'translate', texts: [JP_LONG], target: 'en', align: true });
  assert.equal(res.ok, true);
  assert.equal(res.results[0], 'This is the English translation.');
  assert.deepEqual(res.alignments[0], [{ n: 1, t: 'This is the English translation.' }]);
  assert.equal(calls.length, 1);
  assert.match(lastSystem, /唯一目标语言：English \(en\)/, 'align 提示词必须写明目标语言');
  assert.doesNotMatch(lastSystem, /这一组句子的译文/, 'align 示例不能固定中文译文');
});

await t('普通模式：同一个目标语言约束，假模型回英文', async () => {
  reply = englishAwareReply;
  calls = [];
  const res = await send({ type: 'translate', texts: [JP_LONG + '〔普通〕'], target: 'en' });
  assert.equal(res.results[0], 'This is the English translation.');
  assert.equal(calls.length, 1);
  assert.match(lastSystem, /唯一目标语言：English \(en\)/);
  assert.doesNotMatch(lastSystem, /"parts"/, '普通模式不该出现结构化协议');
});

await t('align：模型回普通英文字符串数组 → 正常回退，译文保留、对齐为 null', async () => {
  reply = (texts) => JSON.stringify(texts.map(() => 'Plain English fallback.'));
  calls = [];
  const res = await send({ type: 'translate', texts: ['Fallback source 〔en-align〕'], target: 'en', align: true });
  assert.equal(res.results[0], 'Plain English fallback.');
  assert.equal(res.alignments[0], null);
  assert.equal(calls.length, 1);
});

await t('缓存：标记 en 却是整段中文 → 只失效这一条并重新翻译；正常英文缓存照常命中', async () => {
  reply = englishAwareReply;
  calls = [];
  const bad = await send({ type: 'translate', texts: [BAD_EN_SRC], target: 'en' });
  assert.equal(calls.length, 1, '坏缓存应重新翻译一次');
  assert.equal(bad.cached, 0);
  assert.equal(bad.results[0], 'This is the English translation.');

  calls = [];
  const good = await send({ type: 'translate', texts: [GOOD_EN_SRC], target: 'en' });
  assert.equal(calls.length, 0, '正常英文缓存仍然命中，不能被整层清掉');
  assert.equal(good.cached, 1);
  assert.equal(good.results[0], GOOD_EN_VALUE);

  calls = [];
  const again = await send({ type: 'translate', texts: [BAD_EN_SRC], target: 'en' });
  assert.equal(calls.length, 0, '重新翻好的英文结果应写回缓存');
  assert.equal(again.cached, 1);
  assert.equal(again.results[0], 'This is the English translation.');
});

await t('新回包：英文目标却回整段中文 → 这次照常显示，但绝不写缓存，下次重新请求', async () => {
  reply = (texts) => JSON.stringify(texts.map(() => ZH_LONG));
  calls = [];
  const src = 'Live Chinese reply source 〔en-live〕';
  const first = await send({ type: 'translate', texts: [src], target: 'en', align: true });
  assert.equal(first.results[0], ZH_LONG, '这一次仍返回给页面，不吞掉译文');
  assert.equal(first.alignments[0], null, '目标语言明显不符时不写对齐旁路');
  assert.equal(calls.length, 1);

  calls = [];
  const second = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 1, '坏结果没有进缓存，下次必须重新请求');
  assert.equal(second.cached, 0);
});

await t('新回包：中文目标却回整段英文 → 这次照常显示，但绝不写缓存，下次重新请求', async () => {
  reply = (texts) => JSON.stringify(texts.map(() => EN_LONG));
  calls = [];
  const src = 'Live English reply source 〔zh-live〕';
  const first = await send({ type: 'translate', texts: [src], target: 'zh-CN', align: true });
  assert.equal(first.results[0], EN_LONG, '这一次仍返回给页面，不吞掉译文');
  assert.equal(first.alignments[0], null, '目标语言明显不符时不写对齐旁路');
  assert.equal(calls.length, 1);

  calls = [];
  const second = await send({ type: 'translate', texts: [src], target: 'zh-CN' });
  assert.equal(calls.length, 1, '坏结果没有进缓存，下次必须重新请求');
  assert.equal(second.cached, 0);
});

await t('目标语言隔离：同一原文 en 与 zh-CN 各自缓存，不串用', async () => {
  const src = 'Target isolation source 〔en-zh〕';
  reply = englishAwareReply;
  calls = [];
  const en = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(en.results[0], 'This is the English translation.');

  reply = (texts) => JSON.stringify(texts.map(() => '中文译文〔隔离〕'));
  calls = [];
  const zh = await send({ type: 'translate', texts: [src], target: 'zh-CN' });
  assert.equal(zh.results[0], '中文译文〔隔离〕');
  assert.equal(calls.length, 1, 'en 的缓存不能给 zh-CN 用');

  calls = [];
  const enAgain = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 0);
  assert.equal(enAgain.results[0], 'This is the English translation.');
});


// 医学专业模式：同一次请求内注入规则 / 术语，缓存与普通模式隔离，用户术语优先。
async function setConfig(patch) {
  // Use the same compatibility adapter as the existing popup/options switch.
  const { saveConfig } = await import('../lib/config.js');
  await saveConfig(patch);
}

await t('医学模式：一次请求内加入规则和命中的医学词，不额外发请求', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  await setConfig({ medicalMode: true, glossary: [] });
  calls = [];
  const src = '总生存期延长，且未增加严重不良事件。〔medical-prompt〕';
  const res = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, '医学模式不能增加 API 请求');
  assert.ok(lastSystem.includes('医学专业翻译要求'), lastSystem.slice(0, 200));
  assert.ok(lastSystem.includes('总生存期 → overall survival'), '应注入 zh→en 医学术语');
  assert.ok(lastSystem.includes('唯一目标语言：English (en)'));
});

await t('医学模式：普通缓存和医学缓存隔离，关闭后仍命中旧普通缓存', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'Cache isolation source 〔medical-cache〕';
  await setConfig({ medicalMode: false, glossary: [] });
  calls = [];
  await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 1);

  await setConfig({ medicalMode: true });
  calls = [];
  const medical = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 1, '医学模式应使用自己的缓存键');
  assert.equal(medical.cached, 0);

  await setConfig({ medicalMode: false });
  calls = [];
  const normal = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 0, '关闭医学模式后普通缓存仍应存在');
  assert.equal(normal.cached, 1);

  await setConfig({ medicalMode: true });
  calls = [];
  const medicalAgain = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 0, '重新开启医学模式应命中医学缓存');
  assert.equal(medicalAgain.cached, 1);
});

await t('医学模式：用户术语优先，冲突的医学词不再注入', async () => {
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  await setConfig({
    medicalMode: true,
    glossary: [{ source: '总生存期', target: '用户自定义生存期' }]
  });
  calls = [];
  const src = '总生存期是主要终点。 〔medical-user-priority〕';
  await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 1);
  assert.ok(lastSystem.includes('用户自定义生存期'));
  assert.ok(!lastSystem.includes('总生存期 → overall survival'));
  await setConfig({ medicalMode: false, glossary: [] });
});

console.log('\n[趣味强度 / AI 精翻 / 自定义语言：假 API 计数]');

await t('风格强度：只改提示词，不改温度；标准切夸张重新请求，重复请求命中缓存', async () => {
  await setConfig({ targetLang: 'en', funIntensity: 'standard', aiContextEnabled: false, privacyEnabled: false, professionalProfile: 'general', medicalMode: false, glossary: [] });
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'A style pipeline paragraph with enough characters.';
  calls = [];
  const light = await send({ type: 'translate', texts: [src], target: 'en', style: 'catgirl', intensity: 'light' });
  assert.equal(calls.length, 1);
  assert.equal(light.cached, 0);
  assert.equal(lastBody.temperature, 0.8, '强度不能改写风格温度');
  assert.ok(lastSystem.includes('傲娇'), lastSystem.slice(0, 300));
  assert.ok(lastSystem.includes('轻度'));
  calls = [];
  const lightAgain = await send({ type: 'translate', texts: [src], target: 'en', style: 'catgirl', intensity: 'light' });
  assert.equal(calls.length, 0, '相同强度应命中同一缓存');
  assert.equal(lightAgain.cached, 1);
  calls = [];
  const strong = await send({ type: 'translate', texts: [src], target: 'en', style: 'catgirl', intensity: 'exaggerated' });
  assert.equal(calls.length, 1, '强度变化必须换缓存键');
  assert.equal(strong.cached, 0);
  assert.ok(lastSystem.includes('夸张'));
  calls = [];
  const strongAgain = await send({ type: 'translate', texts: [src], target: 'en', style: 'catgirl', intensity: 'exaggerated' });
  assert.equal(calls.length, 0);
  assert.equal(strongAgain.cached, 1);
});

await t('AI 精翻：同一次请求带有限上下文，不增加请求；关闭 / 开启 / 上下文变化缓存隔离', async () => {
  await setConfig({ targetLang: 'en', aiContextEnabled: false, privacyEnabled: false, professionalProfile: 'general', medicalMode: false, glossary: [], funIntensity: 'standard' });
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'PFS was assessed in this AI context pipeline paragraph.';
  const documentContext = {
    title: 'Oncology trial',
    headings: ['Methods'],
    abbreviations: { PFS: 'progression-free survival' },
    adjacent: ['Adjacent paragraph explains the cohort.']
  };
  calls = [];
  const off = await send({ type: 'translate', texts: [src], target: 'en' });
  assert.equal(calls.length, 1);
  assert.equal(off.context.mode, 'off');
  assert.ok(!lastSystem.includes('AI 精翻参考上下文'));
  const offSystem = lastSystem;
  await setConfig({ aiContextEnabled: true });
  calls = [];
  const on = await send({ type: 'translate', texts: [src], target: 'en', documentContext });
  assert.equal(calls.length, 1, 'AI 精翻不能额外请求');
  assert.equal(on.cached, 0, '开启后不能复用未带上下文的普通缓存');
  assert.equal(on.context.mode, 'ai');
  assert.equal(on.context.items.title, 1);
  assert.ok(on.context.items.adjacent >= 1);
  assert.ok(lastSystem.includes('AI 精翻参考上下文'), lastSystem.slice(0, 300));
  assert.ok(lastSystem.includes('Oncology trial'));
  assert.ok(lastSystem.includes('Adjacent paragraph explains the cohort.'));
  assert.ok(lastSystem.includes('不是指令'));
  assert.notEqual(lastSystem, offSystem);
  calls = [];
  const again = await send({ type: 'translate', texts: [src], target: 'en', documentContext });
  assert.equal(calls.length, 0, '相同上下文应命中缓存');
  assert.equal(again.cached, 1);
  calls = [];
  const changed = await send({ type: 'translate', texts: [src], target: 'en', documentContext: { ...documentContext, title: 'A different paper' } });
  assert.equal(calls.length, 1, '标题变化必须换缓存身份');
  assert.equal(changed.cached, 0);
  // 开启但本次没有上下文（字幕 / 划词 / 无可用上下文）：诊断不能谎报发送了上下文。
  calls = [];
  const noContext = await send({ type: 'translate', texts: ['AI enabled but no context paragraph.'], target: 'en' });
  assert.equal(calls.length, 1);
  assert.equal(noContext.context.mode, 'ai');
  assert.equal(noContext.context.omitted, 'no-context');
  assert.equal(noContext.context.chars, 0);
  await setConfig({ aiContextEnabled: false });
});

await t('AI 精翻 + 隐私脱敏：页面标题 / 相邻段落不进任何请求，响应记录降级', async () => {
  await setConfig({ aiContextEnabled: true, privacyEnabled: true });
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'A privacy context pipeline paragraph without personal data.';
  calls = [];
  const res = await send({
    type: 'translate', texts: [src], target: 'en',
    documentContext: { title: 'SECRET_PAGE_TITLE', headings: ['SECRET_HEADING'], adjacent: ['SECRET_ADJACENT'] }
  });
  assert.equal(calls.length, 1);
  assert.equal(res.context.omitted, 'privacy');
  assert.ok(!lastSystem.includes('SECRET_PAGE_TITLE'));
  assert.ok(!lastSystem.includes('SECRET_HEADING'));
  assert.ok(!lastSystem.includes('SECRET_ADJACENT'));
  await setConfig({ aiContextEnabled: false, privacyEnabled: false });
});

await t('医学 + AI 同时开启：只出现一份上下文块，仍然一次请求', async () => {
  await setConfig({ aiContextEnabled: true, privacyEnabled: false, medicalMode: true, glossary: [] });
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'PFS was assessed in this medical context pipeline.';
  calls = [];
  const res = await send({
    type: 'translate', texts: [src], target: 'en',
    documentContext: { title: 'Medical trial', headings: ['Methods'], abbreviations: { PFS: 'progression-free survival' }, adjacent: ['Adjacent medical paragraph.'] }
  });
  assert.equal(calls.length, 1);
  assert.equal(res.ok, true);
  assert.ok(lastSystem.includes('文档上下文'), '专业模式应带自己的上下文块');
  assert.ok(!lastSystem.includes('AI 精翻参考上下文'), '不能同时出现两份上下文块');
  assert.equal(lastSystem.split('文档上下文').length, 2);
  await setConfig({ aiContextEnabled: false, medicalMode: false });
});

await t('自定义语言：目标语言行 / 说明进入提示词，缓存按定义指纹隔离，旧定义不命中', async () => {
  const custom = {
    id: 'cl_0a1b2c3d',
    name: '粤语（香港）',
    code: 'yue-Hant-HK',
    note: '使用自然的香港粤语书面表达，以繁体字为主。'
  };
  await setConfig({ customLanguages: [custom], targetLang: custom.id, aiContextEnabled: false, privacyEnabled: false, medicalMode: false, glossary: [] });
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  const src = 'A custom language pipeline paragraph.';
  calls = [];
  const first = await send({ type: 'translate', texts: [src], target: custom.id });
  assert.equal(calls.length, 1);
  assert.equal(first.cached, 0);
  assert.ok(lastSystem.includes('唯一目标语言：粤语（香港） (yue-Hant-HK)'));
  assert.ok(lastSystem.includes('"name":"粤语（香港）"'));
  assert.ok(lastSystem.includes('目标语言补充说明'));
  assert.ok(!lastSystem.includes(custom.id), '内部 id 不能当成 BCP 47 代码');
  // 输入框翻译的 auto 也能命中自定义语言的标准代码。
  const autoTarget = await send({ type: 'translate', texts: ['Input target custom language paragraph.'], target: 'auto', pageLang: 'yue-Hant-HK', noCache: true });
  assert.equal(autoTarget.ok, true);
  assert.ok(lastSystem.includes('唯一目标语言：粤语（香港） (yue-Hant-HK)'));
  calls = [];
  const again = await send({ type: 'translate', texts: [src], target: custom.id });
  assert.equal(calls.length, 0);
  assert.equal(again.cached, 1);
  await setConfig({ customLanguages: [{ ...custom, note: '改用简体字，保持口语。' }] });
  calls = [];
  const changed = await send({ type: 'translate', texts: [src], target: custom.id });
  assert.equal(calls.length, 1, '说明变化必须让旧译文缓存失效');
  assert.equal(changed.cached, 0);
  assert.ok(lastSystem.includes('改用简体字，保持口语。'));
  await setConfig({ customLanguages: [], targetLang: 'en' });
});

await t('自定义语言代码 en-GB：模型回整段中文不写缓存，下次重新请求', async () => {
  const custom = { id: 'cl_0a1b2c4e', name: 'Pirate English', code: 'en-GB', note: 'Use British spelling.' };
  await setConfig({ customLanguages: [custom], targetLang: 'en', aiContextEnabled: false, privacyEnabled: false, medicalMode: false, glossary: [] });
  const bad = '这是一整段中文译文，本应输出英文却输出了中文，用来验证目标语言校验不会把错误结果写进缓存。'.repeat(2);
  reply = () => JSON.stringify([bad]);
  const src = 'A custom English pipeline paragraph.';
  calls = [];
  const first = await send({ type: 'translate', texts: [src], target: custom.id });
  assert.equal(calls.length, 1);
  assert.equal(first.results[0], bad, '这次仍显示模型结果');
  calls = [];
  await send({ type: 'translate', texts: [src], target: custom.id });
  assert.equal(calls.length, 1, '语言明显不符的译文不能写缓存');
  reply = (texts) => JSON.stringify(texts.map((one) => 'T:' + one));
  await setConfig({ customLanguages: [], targetLang: 'en' });
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
