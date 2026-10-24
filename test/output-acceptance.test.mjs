// 模型回包验收回归：语言错误 / 空正文 / 行内标记损坏 / 正确译文与缓存。
// 运行：node test/output-acceptance.test.mjs
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
let calls = [];
let reply = (texts) => JSON.stringify(texts.map(() => '中文默认译文。'));

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

globalThis.fetch = async function (url, init) {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push(texts.slice());
  const json = { choices: [{ message: { content: reply(texts) }, finish_reason: 'stop' }] };
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};

await localArea.set({
  config: {
    _v: 99,
    currentProvider: '__custom__',
    providerConfig: { __custom__: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'sk-test', model: 'fake' } },
    targetLang: 'zh-CN',
    batchSize: 8,
    maxCharsPerBatch: 3000,
    privacyEnabled: false,
    skipSameLang: false
  }
});
await import('../background.js');

function send(msg) {
  return new Promise((resolve) => listener(msg, { url: 'https://example.test/article' }, resolve));
}
function translate(texts, extra) {
  return send({ type: 'translate', texts, target: 'zh-CN', style: 'plain', ...(extra || {}) });
}

const AR = 'تشمل أبرز تطبيقات الذكاء الاصطناعي محرّكات البحث المتقدمة على الويب، وروبوتات المحادثة، والمساعدات الافتراضية، والمركبات ذاتية القيادة، وتوليد المحتوى.';
const EN = 'High-profile applications of AI include advanced web search engines, chatbots, virtual assistants, autonomous vehicles and content generation.';
const ZH = '人工智能的高关注度应用包括高级网页搜索引擎、聊天机器人、虚拟助手、自动驾驶汽车和内容生成。';
const EMPTY = 'This is a substantial source paragraph that should never be accepted as an empty translation.';

await t('正确中文：非空结果，写入缓存；第二次命中缓存且不增加请求', async () => {
  reply = () => JSON.stringify([ZH]);
  calls = [];
  const first = await translate([ZH + '〔proper〕']);
  assert.equal(first.results[0], ZH);
  assert.equal(first.outputErrors[0], null);
  assert.equal(calls.length, 1);
  const second = await translate([ZH + '〔proper〕']);
  assert.equal(second.results[0], ZH);
  assert.equal(second.cached, 1);
  assert.equal(calls.length, 1, '正确结果必须可命中缓存');
});

await t('阿拉伯语原文回显：不接受为翻译成功、不写缓存', async () => {
  reply = () => JSON.stringify([AR]);
  calls = [];
  const first = await translate([AR + '〔ar-echo〕']);
  assert.equal(first.results[0], null, '阿拉伯语原文回显不能直接当译文');
  assert.equal(first.outputErrors[0], 'wrong-language');
  assert.equal(calls.length, 1);
  const second = await translate([AR + '〔ar-echo〕']);
  assert.equal(second.results[0], null);
  assert.equal(second.cached || 0, 0);
  assert.equal(calls.length, 2, '坏结果不能污染缓存；用户重译才会再请求');
});

await t('英文原文回显：不接受为翻译成功、不写缓存', async () => {
  reply = () => JSON.stringify([EN]);
  calls = [];
  const first = await translate([EN + ' 〔en-echo〕']);
  assert.equal(first.results[0], null);
  assert.equal(first.outputErrors[0], 'wrong-language');
  const second = await translate([EN + ' 〔en-echo〕']);
  assert.equal(second.results[0], null);
  assert.equal(second.cached || 0, 0);
  assert.equal(calls.length, 2);
});

await t('正文空回包：模型失败，不是 skipped；不写缓存', async () => {
  reply = () => JSON.stringify(['']);
  calls = [];
  const first = await translate([EMPTY + ' 〔empty〕']);
  assert.equal(first.results[0], null);
  assert.equal(first.outputErrors[0], 'empty-output');
  const second = await translate([EMPTY + ' 〔empty〕']);
  assert.equal(second.results[0], null);
  assert.equal(second.cached || 0, 0);
  assert.equal(calls.length, 2);
});

await t('短英文拒绝 / 回显：即使不足 40 字母也不能缓存或注入', async () => {
  reply = () => JSON.stringify(['Sorry, I cannot help with that.']);
  calls = [];
  const src = 'This is a substantial source paragraph that the model must translate into Chinese.';
  const first = await translate([src + ' 〔short-refusal〕']);
  assert.equal(first.results[0], null);
  assert.equal(first.outputErrors[0], 'wrong-language');
  calls = [];
  const second = await translate([src + ' 〔short-refusal〕']);
  assert.equal(second.cached || 0, 0);
  assert.equal(calls.length, 1);
});

await t('截断的 JSON 数组：按解析失败处理，不当纯文本缓存', async () => {
  reply = () => '["这是一段未完成的译文';
  calls = [];
  const src = 'A substantial source paragraph for the truncated JSON regression.';
  const first = await translate([src + ' 〔truncated〕']);
  assert.equal(first.results[0], null);
  assert.equal(first.cached || 0, 0);
  const second = await translate([src + ' 〔truncated〕']);
  assert.equal(second.results[0], null);
  assert.equal(second.cached || 0, 0);
});

await t('短标签空回包：仍按无需翻译处理，不算模型失败', async () => {
  reply = () => JSON.stringify(['']);
  const res = await translate(['EN']);
  assert.equal(res.results[0], '');
  assert.equal(res.outputErrors[0], null);
});

await t('部分行内格式缺失：安全拒绝，不写缓存；全部缺失可安全降级且不写缓存', async () => {
  const source = 'Read <f1>alpha</f1> and <f2>beta</f2> now.';
  reply = () => JSON.stringify(['阅读 <f1>甲</f1>。']);
  calls = [];
  const partial = await translate([source + '〔partial〕'], { inlineProtocol: 'v1' });
  assert.equal(partial.results[0], null);
  assert.equal(partial.inlineErrors[0], 'missing-marker');
  assert.equal(partial.outputErrors[0], null);
  const again = await translate([source + '〔partial〕'], { inlineProtocol: 'v1' });
  assert.equal(again.results[0], null);
  assert.equal(again.cached || 0, 0);
  assert.equal(calls.length, 2);

  reply = () => JSON.stringify(['阅读甲和乙。']);
  calls = [];
  const allMissing = await translate([source + '〔all-missing〕'], { inlineProtocol: 'v1' });
  assert.equal(allMissing.results[0], '阅读甲和乙。');
  assert.equal(allMissing.outputErrors[0], null);
  const allMissingAgain = await translate([source + '〔all-missing〕'], { inlineProtocol: 'v1' });
  assert.equal(allMissingAgain.cached || 0, 0, 'formatMissing 只能显示，不能进缓存');
  assert.equal(calls.length, 2);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
