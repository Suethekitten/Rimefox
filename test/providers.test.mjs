// 提供商模板的完整性 + 关闭思考参数映射
// 运行：node test/providers.test.mjs
import assert from 'node:assert/strict';

import { PROVIDERS, CUSTOM_PROVIDER_ID, findProviderByBaseUrl, providerById } from '../lib/providers.js';
import { ENGINE_IDS } from '../lib/config.js';

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

console.log('\n[模板完整性]');

t('id 唯一', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

t('协议都在支持列表里', () => {
  PROVIDERS.forEach((p) => {
    assert.ok(ENGINE_IDS.indexOf(p.engine) >= 0, p.id + ' 的 engine 非法：' + p.engine);
  });
});

t('地址都是 http(s) 或 localhost', () => {
  PROVIDERS.forEach((p) => {
    assert.match(p.baseUrl, /^https?:\/\//, p.id + ' 地址不合法');
  });
});

t('每家都有名称与申请链接字段', () => {
  PROVIDERS.forEach((p) => {
    assert.ok(p.name, p.id + ' 缺 name');
    assert.equal(typeof p.keyUrl, 'string');
  });
});

t('自定义哨兵不在列表里', () => {
  assert.equal(providerById(CUSTOM_PROVIDER_ID), null);
});

console.log('\n[按地址反查]');

t('能认出各家地址（忽略末尾斜杠与大小写）', () => {
  PROVIDERS.forEach((p) => {
    const hit = findProviderByBaseUrl(p.baseUrl + '///');
    assert.ok(hit && hit.id === p.id, p.id + ' 反查失败');
  });
});

t('陌生地址返回 null', () => {
  assert.equal(findProviderByBaseUrl('https://example.com/v1'), null);
  assert.equal(findProviderByBaseUrl(''), null);
});

console.log('\n[关闭思考参数]');

t('DeepSeek / GLM / Kimi 用 thinking.type', () => {
  ['deepseek', 'zhipu', 'moonshot'].forEach((id) => {
    const p = providerById(id);
    assert.equal(p.thinkingOff.thinking.type, 'disabled', id);
  });
});

t('千问与硅基流动用 enable_thinking', () => {
  ['dashscope', 'siliconflow'].forEach((id) => {
    assert.equal(providerById(id).thinkingOff.enable_thinking, false, id);
  });
});

t('OpenRouter 用统一的 reasoning.enabled', () => {
  assert.equal(providerById('openrouter').thinkingOff.reasoning.enabled, false);
});

t('Anthropic 用 thinking.type', () => {
  assert.equal(providerById('anthropic').thinkingOff.thinking.type, 'disabled');
});

t('Gemini 由引擎按模型名决定，模板不硬编码', () => {
  assert.equal(providerById('gemini').thinkingOff, null);
});

t('本地部署不发送任何关闭参数', () => {
  assert.equal(providerById('ollama').thinkingOff, null);
  assert.equal(providerById('lmstudio').thinkingOff, null);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
