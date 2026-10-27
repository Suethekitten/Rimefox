// Real router/config/cache/provider with a controllable local model. No paid API.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArea } from './_fake-storage.mjs';
import { createProfessionalEngine } from '../lib/professional/engine.js';

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
await local.set({ config: {
  _v: 7, currentProvider: '__custom__', customProviders: [{ id: '__custom__', name: 'Mock API' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'mock-only', model: 'fake' } },
  thinkingMode: 'auto', targetLang: 'zh-CN', professionalProfile: 'general', batchSize: 8, concurrency: 3
} });
let calls = [];
let respond = inputs => inputs.map(x => '译文：' + x);
let hold;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const inputs = JSON.parse(body.messages[1].content);
  const review = typeof inputs[0] === 'object';
  calls.push({ url, body, inputs, review });
  if (hold) await hold;
  const value = respond(inputs, review);
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] });
};
await import('../background.js');
const cache = await import('../lib/cache.js');
const { saveConfig, getConfig } = await import('../lib/config.js');
const send = (texts, extra = {}) => new Promise(resolve => listener({ type: 'translate', texts, target: 'zh-CN', inlineProtocol: 'v1', ...extra }, { url: 'https://article.invalid/read' }, resolve));
const key = (text, extra = {}) => cache.makeKey({ target: 'zh-CN', style: 'plain', model: '__custom__:fake', host: 'article.invalid', glossary: 'none', prompt: 'none:inline-v1', endpoint: '["openai","https://fake.local/v1"]', ...extra }, text);
const promptedTerms = prompt => {
  const line = prompt.split('\n').find(value => value.startsWith('[{"source"'));
  return line ? JSON.parse(line) : [];
};

test('valid marked responses preserve string arrays, disable model align and are cached', async () => {
  calls = [];
  const source = 'Hello <f1>beautiful</f1> world. first';
  respond = () => ['你好，<f1>美丽的</f1>世界。'];
  const first = await send([source], { align: true });
  assert.deepEqual(first.results, ['你好，<f1>美丽的</f1>世界。']);
  assert.deepEqual(first.alignments, [null]);
  assert.deepEqual(first.inlineErrors, [null]);
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0].inputs));
  assert.match(calls[0].body.messages[0].content, /行内语义标记/);
  const second = await send([source]);
  assert.equal(second.cached, 1);
  assert.equal(calls.length, 1);
  assert.equal(cache.get(key(source)), first.results[0]);
});

test('structural model failures do not trigger retries or cache writes and preserve unrelated rows', async () => {
  calls = [];
  const sources = ['A <f1>bold</f1> <f2>other</f2> failed', 'A <f1>word</f1> passed'];
  respond = () => ['<f1>粗</f1>', '<f1>文字</f1>通过'];
  const result = await send(sources);
  assert.deepEqual(result.results, [null, '<f1>文字</f1>通过']);
  assert.deepEqual(result.inlineErrors, ['missing-marker', null]);
  assert.equal(calls.length, 1);
  assert.equal(cache.get(key(sources[0])), undefined);
  assert.equal(cache.get(key(sources[1])), result.results[1]);
});

test('bad cached structures are deleted selectively and plain legacy identity stays separate', async () => {
  calls = [];
  const source = 'A <f1>bold</f1> <f2>other</f2> poisoned';
  const plainKey = key(source, { prompt: 'none' });
  cache.set(plainKey, '旧协议缓存');
  cache.set(key(source), '<f8>错误</f8>');
  const unrelated = 'An unrelated <f1>word</f1>';
  cache.set(key(unrelated), '无关<f1>文字</f1>');
  respond = () => ['<f1>粗</f1>和<f2>其他</f2>'];
  const result = await send([source]);
  assert.equal(calls.length, 1);
  assert.equal(result.cached, 0);
  assert.equal(cache.get(key(source)), result.results[0]);
  assert.equal(cache.get(plainKey), '旧协议缓存');
  assert.equal(cache.get(key(unrelated)), '无关<f1>文字</f1>');
});

test('complete f omission is safe plain fallback but never a persistent or memory cache hit', async () => {
  calls = [];
  const source = 'A <f1>bold</f1> fallback <k1></k1>';
  respond = () => ['纯文字回退<k1></k1>'];
  const first = await send([source]);
  assert.equal(first.results[0], '纯文字回退<k1></k1>');
  assert.equal(first.inlineErrors[0], null);
  assert.equal(cache.get(key(source)), undefined);
  await send([source]);
  assert.equal(calls.length, 2);
});

test('malformed source tokens are rejected before any external request', async () => {
  calls = [];
  const result = await send(['A <f1>unclosed']);
  assert.deepEqual(result.results, [null]);
  assert.equal(result.inlineErrors[0], 'source-unclosed-marker');
  assert.equal(calls.length, 0);
});

test('inflight deduplication propagates structural reasons to every waiter', async () => {
  calls = [];
  let release;
  hold = new Promise(resolve => { release = resolve; });
  const source = 'A <f1>bold</f1> <f2>other</f2> inflight';
  respond = () => ['<f1>粗</f1>'];
  const first = send([source]);
  for (let i = 0; i < 100 && !calls.length; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
  const second = send([source]);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  hold = null;
  const results = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  for (const result of results) {
    assert.deepEqual(result.results, [null]);
    assert.deepEqual(result.inlineErrors, ['missing-marker']);
  }
});

test('privacy masking and empty protected atoms survive together without externalizing local content', async () => {
  await saveConfig({ privacyEnabled: true });
  calls = [];
  respond = inputs => inputs.map(x => '请联系' + x.match(/__PII_EMAIL_ADDRESS_\d+__/)[0] + '<k1></k1><f1>今天</f1>。');
  const source = 'Contact hidden@example.org <k1></k1> <f1>today</f1> privacy';
  const result = await send([source]);
  assert.match(result.results[0], /hidden@example\.org/);
  assert.match(result.results[0], /<k1><\/k1>/);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls[0].body).includes('hidden@example.org'));
  await saveConfig({ privacyEnabled: false });
});

test('strict review cannot accept repaired numbers with broken semantic markers', async () => {
  await saveConfig({ professionalProfile: 'medical', professionalOptions: { quality: 'strict', maxReviewRequests: 1 } });
  calls = [];
  const source = '<f1>39 patients</f1> (24.2%) versus 10 patients (6.2%). strict-inline';
  respond = (inputs, review) => review ? ['39例患者（24.2%）与10例患者（6.2%）。'] : ['<f1>39例患者</f1>（24.2%）与10例患者（16.2%）。'];
  const result = await send([source]);
  assert.equal(calls.length, 2);
  assert.match(result.results[0], /16\.2%/);
  assert.match(result.results[0], /<f1>/);
  assert.equal(result.validations[0].review.accepted, false);
});

test('strict review accepts corrected values only with intact atom and format identities', async () => {
  calls = [];
  const source = '<f1>39 patients</f1> (24.2%) versus 10 patients (6.2%). <k1>[8]</k1> strict-accepted';
  respond = (inputs, review) => review
    ? ['<f1>39例患者</f1>（24.2%）与10例患者（6.2%）。<k1>[8]</k1>']
    : ['<f1>39例患者</f1>（24.2%）与10例患者（16.2%）。<k1>[8]</k1>'];
  const result = await send([source]);
  assert.equal(calls.length, 2);
  assert.match(result.results[0], /6\.2%/);
  assert.equal(result.validations[0].review.accepted, true);
  assert.equal(result.inlineErrors[0], null);
  calls = [];
  assert.equal((await send([source])).cached, 1);
  assert.equal(calls.length, 0, 'accepted review must reuse the existing protocol and professional cache scope');
});

test('a strict candidate that changes an immutable atom cannot replace the original translation', async () => {
  calls = [];
  const source = '<f1>39 patients</f1> (24.2%) versus 10 patients (6.2%). <k1>[8]</k1> strict-atom';
  respond = (inputs, review) => review
    ? ['<f1>39例患者</f1>（24.2%）与10例患者（6.2%）。<k1>[9]</k1>']
    : ['<f1>39例患者</f1>（24.2%）与10例患者（16.2%）。<k1>[8]</k1>'];
  const result = await send([source]);
  assert.equal(calls.length, 2);
  assert.match(result.results[0], /16\.2%/);
  assert.match(result.results[0], /<k1>\[8\]<\/k1>/);
  assert.equal(result.validations[0].review.accepted, false);
});

test('medical validation ignores f IDs and permits only the explicitly mutable link label', async () => {
  await saveConfig({ professionalOptions: { quality: 'balanced' } });
  calls = [];
  const source = '<f9>39 patients</f9> (24.2%) read <k1><f7>documentation</f7></k1>.';
  respond = () => ['<f9>39例患者</f9>（24.2%）阅读<k1><f7>文档</f7></k1>。'];
  const result = await send([source]);
  assert.equal(calls.length, 1);
  assert.equal(result.inlineErrors[0], null);
  assert.equal(result.validations[0].status, 'pass', JSON.stringify(result.validations[0]));
  await saveConfig({ professionalProfile: 'general' });
});

test('calls without explicit inline opt in retain the existing plain string path', async () => {
  calls = [];
  respond = () => ['普通译文'];
  const result = await send(['A literal <f1>example</f1>. plain'], { inlineProtocol: undefined });
  assert.deepEqual(result.results, ['普通译文']);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].body.messages[0].content.includes('行内语义标记'));
});

test('protocol cache and inflight identities retain the normalized endpoint scope', async () => {
  calls = [];
  const source = 'Endpoint <f1>identity</f1> inline';
  respond = () => ['接口<f1>身份</f1>'];
  const setUrl = baseUrl => saveConfig({ providerConfig: { __custom__: { baseUrl } } });
  await send([source]);
  await setUrl('https://other.local/v1');
  await send([source]);
  assert.equal(calls.length, 2);
  await setUrl('  https://other.local/v1///  ');
  assert.equal((await send([source])).cached, 1);
  await setUrl('https://fake.local/v1');
  assert.equal((await send([source])).cached, 1);
  assert.equal(calls.length, 2);

  calls = [];
  let release;
  hold = new Promise(resolve => { release = resolve; });
  const inFlight = source + ' in-flight';
  const first = send([inFlight]);
  for (let i = 0; i < 100 && calls.length < 1; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
  await setUrl('https://other.local/v1');
  const second = send([inFlight]);
  for (let i = 0; i < 100 && calls.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
  release();
  hold = null;
  await Promise.all([first, second]);
  assert.equal(calls.length, 2, 'a different endpoint must not join an in-flight request for the same marked text');
  await setUrl('https://fake.local/v1');
});

test('input noCache mode never persists a structurally valid marked response', async () => {
  calls = [];
  const source = 'Private <f1>draft</f1> inline noCache';
  respond = () => ['私人<f1>草稿</f1>'];
  await send([source], { noCache: true });
  assert.equal(cache.get(key(source)), undefined);
  await send([source], { noCache: true });
  assert.equal(calls.length, 2);
});

test('invented HTML and malformed protocol debris never enter the cache or retry the model', async () => {
  for (const debris of ['<b>粗体</b>', '<script>alert(1)</script>', '<fABC>', '<k>', '&lt;fABC']) {
    calls = [];
    const source = 'Do not invent <f1>markup</f1> ' + encodeURIComponent(debris);
    respond = () => [debris + '<f1>标记</f1>'];
    const result = await send([source]);
    assert.equal(result.results[0], null, debris);
    assert.equal(result.inlineErrors[0], 'markup-leak', debris);
    assert.equal(calls.length, 1, debris);
    assert.equal(cache.get(key(source)), undefined, debris);
  }
});

test('user terms and notes match across f boundaries while the API still receives original wire markers', async () => {
  await saveConfig({ glossary: [{ source: 'beautiful world', target: '美丽世界', note: '这是完整问候短语，不是分开的两个词。' }] });
  calls = [];
  const source = 'A <f1>beautiful</f1> world across-format-user-term <k1></k1>.';
  respond = () => ['一个<f1>美丽的</f1>世界<k1></k1>。'];
  const result = await send([source]);
  assert.equal(result.inlineErrors[0], null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].inputs, [source]);
  assert.deepEqual(promptedTerms(calls[0].body.messages[0].content), [{ source: 'beautiful world', preferredTarget: '美丽世界', note: '这是完整问候短语，不是分开的两个词。' }]);
  assert.match(calls[0].body.messages[0].content, /这是完整问候短语/);
  assert.match(calls[0].body.messages[0].content, /空标记必须保持为空/);
});

test('editing a cross-format term note invalidates its cache only, without invalidating unrelated formatted text', async () => {
  const term = { source: 'beautiful world', target: '美丽世界', note: '旧语境。' };
  await saveConfig({ glossary: [term] });
  calls = [];
  const sources = ['The <f1>beautiful</f1> world note-cache-inline.', 'A <f1>quiet</f1> afternoon note-cache-inline.'];
  respond = inputs => inputs.map(x => x.includes('beautiful') ? '<f1>美丽的</f1>世界。' : '一个<f1>安静的</f1>下午。');
  await send(sources);
  await saveConfig({ glossary: [{ ...term, note: '新语境。' }] });
  const second = await send(sources);
  assert.equal(calls.length, 2, 'the changed note must invalidate the cross-format term cache');
  assert.deepEqual(calls[1].inputs, [sources[0]]);
  assert.equal(second.cached, 1, 'unrelated formatted text keeps its cache');
});

test('medical terminology and its cache fingerprint use visible text across semantic boundaries', async () => {
  await saveConfig({ professionalProfile: 'medical', professionalOptions: { quality: 'balanced' }, glossary: [] });
  calls = [];
  const visible = 'The hazard ratio was discussed. medical-format-fingerprint';
  const source = 'The <f1>hazard</f1> ratio was discussed. medical-format-fingerprint';
  respond = () => ['讨论了<f1>风险</f1>比。'];
  const result = await send([source]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages[0].content, /hazard ratio → 风险比/);
  const engine = createProfessionalEngine(await getConfig(), { target: 'zh-CN', style: 'plain', excludeSources: new Set() });
  assert.equal(cache.get(key(source, { professional: engine.fingerprint(visible) })), result.results[0]);
});

test('strict review retains cross-format user terminology and notes without exposing opaque atoms', async () => {
  await saveConfig({ professionalOptions: { quality: 'strict', maxReviewRequests: 1 }, glossary: [{ source: 'hazard ratio', target: '用户风险比', note: '风险语境的首选译法。' }] });
  calls = [];
  const source = 'The <f1>hazard</f1> ratio compared 39 patients (24.2%) with 10 patients (6.2%). <k1></k1> strict-term-format';
  respond = (inputs, review) => review
    ? ['<f1>用户风险</f1>比比较了39例患者（24.2%）与10例患者（6.2%）。<k1></k1>']
    : ['<f1>用户风险</f1>比比较了39例患者（24.2%）与10例患者（16.2%）。<k1></k1>'];
  const result = await send([source]);
  assert.equal(calls.length, 2);
  assert.equal(result.validations[0].review.accepted, true);
  for (const call of calls) {
    assert.deepEqual(promptedTerms(call.body.messages[0].content), [{ source: 'hazard ratio', preferredTarget: '用户风险比', note: '风险语境的首选译法。' }]);
    assert.match(call.body.messages[0].content, /风险语境的首选译法/);
    assert.ok(!call.body.messages[0].content.includes('hazard ratio → 风险比'), 'user terminology keeps priority over the medical dictionary');
    assert.ok(JSON.stringify(call.inputs).includes('<k1></k1>'));
  }
  await saveConfig({ professionalProfile: 'general', glossary: [] });
});

test('link- and citation-dense rows are length-checked by visible text, not marker bytes', async () => {
  calls = [];
  // 0.12.3：原文去掉了 <kN> 原子再比长度，译文却带着全部标记；参考文献条目、链接列表句因此
  // 返回空串（内容侧误报 missing-marker）或被当成模型失控长文。
  const countries = ['Belgium', 'Luxembourg', 'Germany', 'Switzerland', 'Monaco', 'Italy', 'Andorra', 'Spain'];
  const zh = ['比利时', '卢森堡', '德国', '瑞士', '摩纳哥', '意大利', '安道尔', '西班牙'];
  const mark = (label, i) => `<k${i + 1}><f${i + 1}>${label}</f${i + 1}></k${i + 1}>`;
  const listSource = 'France borders ' + countries.map(mark).join(', ') + '.';
  const listOutput = '法国与' + zh.map(mark).join('、') + '接壤。';
  const refSource = '<k1><f1>↑</f1></k1> <k2><f2>"America\'s choice"</f2></k2>. <f3>Nature</f3>. <f4>455</f4> (7217): 1149. 29 October 2008. <k3><f5>Bibcode</f5></k3>:<k4><f6>2008Natur.455Q1149.</f6></k4>. <k5><f7>doi</f7></k5>:<k6><f8>10.1038/4551149a</f8></k6>.';
  const refOutput = '<k1><f1>↑</f1></k1> <k2><f2>“美国的选择”</f2></k2>。<f3>自然</f3>。<f4>455</f4> (7217): 1149。2008年10月29日。<k3><f5>文献代码</f5></k3>:<k4><f6>2008Natur.455Q1149.</f6></k4>。<k5><f7>数字对象标识符</f7></k5>:<k6><f8>10.1038/4551149a</f8></k6>。';
  respond = () => [listOutput, refOutput];
  const first = await send([listSource, refSource]);
  assert.deepEqual(first.results, [listOutput, refOutput]);
  assert.deepEqual(first.inlineErrors, [null, null]);
  assert.deepEqual(first.outputErrors, [null, null]);
  assert.equal(calls.length, 1);
  const again = await send([listSource, refSource]);
  assert.equal(again.cached, 2, 'valid dense rows are cached and survive the cache-hit length check');
  assert.equal(calls.length, 1);
});

test('a genuinely runaway marked translation is still rejected by visible length', async () => {
  calls = [];
  const source = 'The committee approved the <f1>revised</f1> budget after a short discussion today.';
  respond = () => ['委员会今天经过简短讨论批准了<f1>修订后的</f1>预算。' + '然后'.repeat(200)];
  const result = await send([source]);
  assert.deepEqual(result.results, [null]);
  assert.equal(result.outputErrors[0], 'runaway-output');
  assert.equal(cache.get(key(source)), undefined);
});
