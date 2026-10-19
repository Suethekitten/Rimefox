// 请求门面单测：思考模式把 content 吃空时的处理（用假 fetch，不发真实请求）。
// 运行：node test/provider.test.mjs
import assert from 'node:assert/strict';

import { chat, isLengthStop } from '../lib/provider.js';

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

// 假接口：按顺序吐出给定的回包，记下每次请求体
function mockFetch(replies) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return bodies;
}

function reply(content, finishReason, reasoning) {
  return { choices: [{ finish_reason: finishReason, message: { content, reasoning_content: reasoning || '' } }] };
}

const base = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: '["Hello"]' }]
};

console.log('\n[思考模式与空 content]');

await t('finish_reason 的几种截断叫法都认', () => {
  assert.ok(isLengthStop('length') && isLengthStop('max_tokens') && isLengthStop('MAX_TOKENS'));
  assert.ok(!isLengthStop('stop') && !isLengthStop(''));
});

await t('content 为空 + finish_reason=length：关掉思考重试一次，拿到译文', async () => {
  const bodies = mockFetch([reply('', 'length', '想了很久……'), reply('["你好"]', 'stop')]);
  const meta = {};
  const out = await chat({ ...base, thinkingMode: 'auto', meta });
  assert.equal(out, '["你好"]');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].thinking, undefined, '第一次按用户设置（自动）不发思考参数');
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' }, '重试时要用 DeepSeek 的关闭参数');
  assert.equal(meta.finishReason, 'stop');
  assert.equal(meta.contentLength, '["你好"]'.length);
});

await t('content 为空 + finish_reason=stop：不重试，报错带 finish_reason / 长度和思考过程', async () => {
  const bodies = mockFetch([reply('', 'stop', '答案是 ["你好"]')]);
  let err = null;
  try {
    await chat({ ...base, thinkingMode: 'auto' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '应当抛错');
  assert.equal(bodies.length, 1);
  assert.equal(err.code, 'empty_content');
  assert.match(err.message, /finish_reason=stop/);
  assert.match(err.message, /content 0 字/);
  assert.equal(err.reasoningText, '答案是 ["你好"]');
  assert.ok(!/choices/.test(err.message + err.detail), '错误信息里不该再是一段原始 JSON');
});

await t('已经关了思考还被截断：不再重试，直接报 finish_reason=length', async () => {
  const bodies = mockFetch([reply('', 'length', '')]);
  let err = null;
  try {
    await chat({ ...base, thinkingMode: 'off' });
  } catch (e) {
    err = e;
  }
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.match(err && err.message, /finish_reason=length/);
});

await t('正常返回：不受影响，只请求一次', async () => {
  const bodies = mockFetch([reply('["你好"]', 'stop')]);
  assert.equal(await chat({ ...base, thinkingMode: 'off' }), '["你好"]');
  assert.equal(bodies.length, 1);
});

console.log('\n[服务端不认思考参数]');

await t('400 拒绝 reasoning_effort：去掉重试；之后同一地址 + 模型直接不发，不再每批多吃一个 400', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning_effort) {
      return new Response('{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}', { status: 400 });
    }
    return new Response(JSON.stringify(reply('["你好"]', 'stop')), { status: 200 });
  };
  const opts = { ...base, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', thinkingMode: 'off' };
  assert.equal(await chat(opts), '["你好"]');
  assert.equal(bodies.length, 2, '第一次：被拒绝后去掉参数重发');
  assert.equal(await chat(opts), '["你好"]');
  assert.equal(bodies.length, 3, '第二次应该只请求一次');
  assert.equal(bodies[2].reasoning_effort, undefined);
  await chat({ ...opts, model: 'o4-mini' });
  assert.equal(bodies[3].reasoning_effort, 'none', '换了模型要重新试');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
