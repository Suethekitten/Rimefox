// 用量统计与 usage 提取单测：不依赖浏览器 / 网络（provider 用假 fetch）。
// 运行：node test/usage.test.mjs
import assert from 'node:assert/strict';

import { createUsageStats } from '../lib/usage.js';
import { parseResponse as parseOpenAI } from '../lib/engines/openai.js';
import { parseResponse as parseAnthropic } from '../lib/engines/anthropic.js';
import { parseResponse as parseGemini } from '../lib/engines/gemini.js';
import { chat } from '../lib/provider.js';

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
function ta(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass += 1; console.log('  ✓ ' + name); })
    .catch(function (err) { fail += 1; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); });
}

console.log('\n[usage 提取]');

t('OpenAI 兼容：prompt/completion/reasoning/cache', () => {
  const out = parseOpenAI({
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 7 },
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 80
    }
  });
  assert.deepEqual(out.usage, { input: 120, output: 30, reasoning: 7, cacheRead: 40, cacheWrite: 80 });
});

t('Anthropic：input/output/cache', () => {
  const out = parseAnthropic({
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 90, output_tokens: 12, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 }
  });
  assert.deepEqual(out.usage, { input: 90, output: 12, reasoning: null, cacheRead: 70, cacheWrite: 20 });
});

t('Gemini：prompt/candidates/thoughts/cached', () => {
  const out = parseGemini({
    candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9, thoughtsTokenCount: 4, cachedContentTokenCount: 30 }
  });
  assert.deepEqual(out.usage, { input: 50, output: 9, reasoning: 4, cacheRead: 30, cacheWrite: null });
});

t('没有 usage 时返回 null，不编造 token', () => {
  assert.equal(parseOpenAI({ choices: [{ message: { content: 'hi' } }] }).usage, null);
  assert.equal(parseAnthropic({ content: [{ type: 'text', text: 'hi' }] }).usage, null);
  assert.equal(parseGemini({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }).usage, null);
});

console.log('\n[统计聚合]');

t('请求 / 响应 / token / 未知 usage / 缓存 / 重试 / 拆批 / 丢弃 / 失败', () => {
  const s = createUsageStats();
  s.request(2);
  s.response({ input: 100, output: 20, reasoning: 5, cacheRead: 30 });
  s.response(null); // 服务商没给 usage
  s.response({ input: 10 }); // 部分字段
  s.response({}); // 完全未知
  s.cacheHit();
  s.cacheMiss(3);
  s.retry();
  s.split();
  s.discard();
  s.failure();
  s.finish('stop');
  s.finish('length');
  s.finish('stop');
  assert.deepEqual(s.snapshot(), {
    requests: 2,
    responses: 4,
    usageResponses: 2,
    unknownUsageResponses: 2,
    inputTokens: 110,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    cacheHits: 1,
    cacheMisses: 3,
    retries: 1,
    splits: 1,
    discarded: 1,
    failed: 1,
    finishReasons: { stop: 2, length: 1 }
  });
  s.reset();
  assert.equal(s.snapshot().requests, 0);
  assert.deepEqual(s.snapshot().finishReasons, {});
});

console.log('\n[provider 元数据]');

await ta('chat 记录 HTTP 次数与每次响应 usage（含 content 为空触发的思考重试）', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function () {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 11, completion_tokens: 0 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '["译文"]' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const meta = {};
    const text = await chat({
      meta: meta,
      engine: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: '["a"]' }],
      thinkingMode: 'auto',
      maxTokens: 100
    });
    assert.equal(text, '["译文"]');
    assert.equal(meta.http, 2, '两次 HTTP（第一次被 length 截断后重试）');
    assert.equal(meta.usages.length, 2, '两次响应都要记录 usage');
    assert.equal(meta.usages[0].input, 11);
    assert.equal(meta.usages[1].output, 5);
    assert.equal(meta.usages[1].reasoning, 2);
  } finally {
    globalThis.fetch = original;
  }
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);