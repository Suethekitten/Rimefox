// 引擎层单测：纯函数（请求构造 / 回包解析 / 错误映射），不依赖浏览器与网络。
// 运行：node test/engines.test.mjs
import assert from 'node:assert/strict';

import * as openai from '../lib/engines/openai.js';
import * as anthropic from '../lib/engines/anthropic.js';
import * as gemini from '../lib/engines/gemini.js';
import { engineOf, engineList } from '../lib/provider.js';

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    fail += 1;
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message));
  }
}

function json(body) {
  return JSON.parse(body);
}

// ---------------- OpenAI 兼容 ----------------
console.log('\n[OpenAI 兼容]');

t('baseUrl 以 /v1 结尾时补 /chat/completions', () => {
  assert.equal(openai.endpointOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
});

t('直接粘完整地址不会重复拼接', () => {
  const url = 'https://api.siliconflow.cn/v1/chat/completions';
  assert.equal(openai.endpointOf(url), url);
});

t('末尾多余斜杠会被清掉', () => {
  assert.equal(openai.endpointOf('https://a.com/v1///'), 'https://a.com/v1/chat/completions');
});

t('鉴权头是 Bearer', () => {
  const req = openai.buildRequest({ baseUrl: 'https://a.com/v1', apiKey: 'sk-1', model: 'm' }, { messages: [], temperature: 0.2, maxTokens: 100 });
  assert.equal(req.headers.Authorization, 'Bearer sk-1');
  assert.equal(req.headers['Content-Type'], 'application/json');
});

t('请求体带 stream:false 与 max_tokens', () => {
  const req = openai.buildRequest({ baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' }, { messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, maxTokens: 512 });
  const body = json(req.body);
  assert.equal(body.model, 'm');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.messages[0].content, 'hi');
});

t('解析 choices[0].message.content', () => {
  const r = openai.parseResponse({ choices: [{ message: { content: '你好' } }] });
  assert.equal(r.text, '你好');
  assert.equal(r.reasoning, false);
});

t('content 是数组时拼接文本片段', () => {
  const r = openai.parseResponse({ choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }] });
  assert.equal(r.text, '甲乙');
});

t('识别推理模型标记', () => {
  const r = openai.parseResponse({ choices: [{ message: { content: 'x', reasoning_content: '...' } }] });
  assert.equal(r.reasoning, true);
});

t('401 错误映射为 Key 相关文案', () => {
  const e = openai.parseError(401, JSON.stringify({ error: { message: 'bad key' } }));
  assert.match(e.message, /Key/);
  assert.equal(e.status, 401);
});

t('模型列表三种形态都能解析', () => {
  assert.deepEqual(openai.parseModels({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(openai.parseModels({ models: [{ name: 'c' }] }), ['c']);
  assert.deepEqual(openai.parseModels(['d', 'd']), ['d']);
});

// ---------------- Anthropic ----------------
console.log('\n[Anthropic]');

t('endpoint 拼接为 /messages', () => {
  assert.equal(anthropic.endpointOf('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
});

t('完整 /messages 地址不会重复拼接', () => {
  const url = 'https://api.anthropic.com/v1/messages';
  assert.equal(anthropic.endpointOf(url), url);
});

t('system 被提到顶层，不留在 messages 里', () => {
  const req = anthropic.buildRequest(
    { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'claude' },
    { messages: [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, { role: 'user', content: 'U' }], temperature: 0.2, maxTokens: 100 }
  );
  const body = json(req.body);
  assert.equal(body.system, 'S1\n\nS2');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
});

t('temperature 超过 1 会被夹到 1', () => {
  const req = anthropic.buildRequest({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm' }, { messages: [], temperature: 1.5, maxTokens: 10 });
  assert.equal(json(req.body).temperature, 1);
});

t('temperature 为负会夹到 0', () => {
  const req = anthropic.buildRequest({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm' }, { messages: [], temperature: -1, maxTokens: 10 });
  assert.equal(json(req.body).temperature, 0);
});

t('max_tokens 必填，缺省给 2048', () => {
  const req = anthropic.buildRequest({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm' }, { messages: [] });
  assert.equal(json(req.body).max_tokens, 2048);
});

t('鉴权头与浏览器直连头齐全', () => {
  const req = anthropic.buildRequest({ baseUrl: 'https://a.com', apiKey: 'sk', model: 'm' }, { messages: [] });
  assert.equal(req.headers['x-api-key'], 'sk');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(req.headers.Authorization, undefined);
});

t('多个 text 块拼接', () => {
  const r = anthropic.parseResponse({ content: [{ type: 'text', text: '甲' }, { type: 'thinking', thinking: '...' }, { type: 'text', text: '乙' }] });
  assert.equal(r.text, '甲乙');
  assert.equal(r.reasoning, true);
});

t('529 映射为服务过载', () => {
  const e = anthropic.parseError(529, '');
  assert.match(e.message, /过载/);
});

// ---------------- Gemini ----------------
console.log('\n[Gemini]');

t('URL 带模型名与 :generateContent', () => {
  const url = gemini.endpointOf({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
});

t('模型名带 models/ 前缀会被去掉', () => {
  const url = gemini.endpointOf({ baseUrl: 'https://g/v1beta', model: 'models/gemini-x' });
  assert.match(url, /\/models\/gemini-x:generateContent$/);
});

t('请求体使用 contents/parts 与 generationConfig', () => {
  const req = gemini.buildRequest({ baseUrl: 'https://g/v1beta', apiKey: 'k', model: 'm' }, { messages: [{ role: 'user', content: 'hi' }], temperature: 0.4, maxTokens: 256 });
  const body = json(req.body);
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[0].parts[0].text, 'hi');
  assert.equal(body.generationConfig.temperature, 0.4);
  assert.equal(body.generationConfig.maxOutputTokens, 256);
});

t('system 进 systemInstruction，没有就不带该字段', () => {
  const withSystem = json(gemini.buildRequest({ baseUrl: 'https://g', apiKey: 'k', model: 'm' }, { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] }).body);
  assert.equal(withSystem.systemInstruction.parts[0].text, 'S');
  assert.equal(withSystem.contents.length, 1);

  const without = json(gemini.buildRequest({ baseUrl: 'https://g', apiKey: 'k', model: 'm' }, { messages: [{ role: 'user', content: 'U' }] }).body);
  assert.equal(without.systemInstruction, undefined);
});

t('鉴权头是 x-goog-api-key', () => {
  const req = gemini.buildRequest({ baseUrl: 'https://g', apiKey: 'gk', model: 'm' }, { messages: [] });
  assert.equal(req.headers['x-goog-api-key'], 'gk');
  assert.equal(req.headers.Authorization, undefined);
});

t('多个 parts 拼接', () => {
  const r = gemini.parseResponse({ candidates: [{ content: { parts: [{ text: '甲' }, { text: '乙' }] } }] });
  assert.equal(r.text, '甲乙');
});

t('安全策略拦截给出明确错误', () => {
  const r = gemini.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.match(r.error, /安全策略/);
});

t('输出被截断时给出明确错误', () => {
  const r = gemini.parseResponse({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
  assert.match(r.error, /截断/);
});

t('地区限制使用确认过的文案', () => {
  const e = gemini.parseError(400, JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } }));
  assert.equal(e.message, '当前网络所在地区不被 Gemini 支持 —— 请使用代理或换用其它引擎');
});

t('模型列表只保留能对话的，并去掉 models/ 前缀', () => {
  const list = gemini.parseModels({
    models: [
      { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent', 'countTokens'] }
    ]
  });
  assert.deepEqual(list, ['gemini-a', 'gemini-b']);
});

// ---------------- 分发 ----------------
console.log('\n[分发]');

t('按 engine 取到对应实现', () => {
  assert.equal(engineOf('anthropic').id, 'anthropic');
  assert.equal(engineOf('gemini').id, 'gemini');
});

t('未知 engine 回退到 OpenAI 兼容', () => {
  assert.equal(engineOf('nope').id, 'openai');
  assert.equal(engineOf(undefined).id, 'openai');
});

t('engineList 暴露三个引擎', () => {
  const ids = engineList().map((e) => e.id);
  assert.deepEqual(ids, ['openai', 'anthropic', 'gemini']);
});

// ---------------- 思考模式 ----------------
console.log('\n[思考模式]');

t('OpenAI：off 时发送 reasoning_effort=none', () => {
  const req = openai.buildRequest(
    { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' },
    { messages: [], temperature: 0.2, maxTokens: 10, thinking: { mode: 'off', extra: {} } }
  );
  assert.equal(json(req.body).reasoning_effort, 'none');
});

t('OpenAI：custom 会把自定义 JSON 合并进请求体', () => {
  const req = openai.buildRequest(
    { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' },
    { messages: [], thinking: { mode: 'custom', extra: { enable_thinking: false } } }
  );
  assert.equal(json(req.body).enable_thinking, false);
});

t('Anthropic：off 时不带 thinking 字段', () => {
  const req = anthropic.buildRequest(
    { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' },
    { messages: [], thinking: { mode: 'off', extra: {} } }
  );
  assert.equal(json(req.body).thinking, undefined);
});

t('Anthropic：custom 可开启扩展思考', () => {
  const req = anthropic.buildRequest(
    { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' },
    { messages: [], thinking: { mode: 'custom', extra: { thinking: { type: 'enabled', budget_tokens: 1024 } } } }
  );
  assert.equal(json(req.body).thinking.budget_tokens, 1024);
});

t('Gemini：off 时 thinkingBudget=0', () => {
  const req = gemini.buildRequest(
    { baseUrl: 'https://g/v1beta', apiKey: 'k', model: 'm' },
    { messages: [], thinking: { mode: 'off', extra: {} } }
  );
  assert.equal(json(req.body).generationConfig.thinkingConfig.thinkingBudget, 0);
});

t('Gemini：custom 的 generationConfig 会合并进去', () => {
  const req = gemini.buildRequest(
    { baseUrl: 'https://g/v1beta', apiKey: 'k', model: 'm' },
    { messages: [], temperature: 0.5, thinking: { mode: 'custom', extra: { generationConfig: { thinkingConfig: { thinkingBudget: 128 } } } } }
  );
  const body = json(req.body);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 128);
  assert.equal(body.generationConfig.temperature, 0.5); // 原有字段不能被覆盖掉
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
