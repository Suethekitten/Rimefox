// 配置层单测：v4→v5 迁移、按服务商的 Key 隔离、深合并、导入校验。
// 运行：node test/config.test.mjs
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  CONFIG_VERSION,
  ENGINE_DEFAULTS,
  migrateConfig,
  mergeConfig,
  activeConfig,
  slotFor,
  pickImportedConfig
} from '../lib/config.js';

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

// ---------------- 迁移 ----------------
console.log('\n[迁移 v4 → v5：按协议 → 按服务商]');

const v4Openai = {
  _v: 4,
  engine: 'openai',
  engineConfig: {
    openai: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf', model: 'Qwen/Qwen2.5-7B' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', model: 'claude' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '', model: '' }
  },
  targetLang: 'ja',
  theme: 'mask',
  _v: 4
};

t('OpenAI 槽里的地址能识别成对应服务商', () => {
  const next = migrateConfig(v4Openai);
  assert.equal(next.providerConfig.siliconflow.apiKey, 'sk-sf');
  assert.equal(next.providerConfig.siliconflow.engine, 'openai');
});

t('Anthropic 槽迁到 anthropic 服务商', () => {
  const next = migrateConfig(v4Openai);
  assert.equal(next.providerConfig.anthropic.apiKey, 'sk-ant');
  assert.equal(next.providerConfig.anthropic.engine, 'anthropic');
});

t('当前服务商跟原来的 engine 走', () => {
  assert.equal(migrateConfig(v4Openai).currentProvider, 'siliconflow');
  assert.equal(migrateConfig({ ...v4Openai, engine: 'anthropic' }).currentProvider, 'anthropic');
});

t('旧结构字段被清掉', () => {
  const next = migrateConfig(v4Openai);
  assert.equal(next.engineConfig, undefined);
  assert.equal(next.engine, undefined);
  assert.equal(next._v, CONFIG_VERSION);
  assert.equal(CONFIG_VERSION, 5);
});

t('行为项原样保留', () => {
  const next = migrateConfig(v4Openai);
  assert.equal(next.targetLang, 'ja');
  assert.equal(next.theme, 'mask');
});

t('认不出的地址落到「自定义」', () => {
  const next = migrateConfig({
    _v: 4,
    engineConfig: { openai: { baseUrl: 'https://example.com/v1', apiKey: 'sk-x', model: 'm' } }
  });
  assert.equal(next.providerConfig.__custom__.apiKey, 'sk-x');
});

t('v3 扁平字段迁到对应服务商', () => {
  const next = migrateConfig({ _v: 3, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', model: 'deepseek-chat' });
  assert.equal(next.providerConfig.deepseek.apiKey, 'sk-ds');
  assert.equal(next.currentProvider, 'deepseek');
});

t('v3 以下会纠偏并发/批量', () => {
  const next = migrateConfig({ _v: 1, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'm', batchSize: 1, concurrency: 2 });
  assert.equal(next.batchSize, DEFAULTS.batchSize);
  assert.equal(next.concurrency, DEFAULTS.concurrency);
});

t('迁移是幂等的', () => {
  const once = migrateConfig(v4Openai);
  const twice = migrateConfig(once);
  assert.deepEqual(twice.providerConfig, once.providerConfig);
});

// ---------------- 按服务商隔离（本次修复的核心） ----------------
console.log('\n[同一协议下的 Key 隔离]');

const twoProviders = {
  currentProvider: 'deepseek',
  providerConfig: {
    deepseek: { engine: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek', model: 'deepseek-chat' },
    siliconflow: { engine: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf', model: 'qwen' }
  }
};

t('两个 OpenAI 协议的服务商各记各的 Key', () => {
  assert.equal(slotFor(twoProviders, 'deepseek').apiKey, 'sk-deepseek');
  assert.equal(slotFor(twoProviders, 'siliconflow').apiKey, 'sk-sf');
});

t('切到硅基流动不会影响 DeepSeek', () => {
  const switched = { ...twoProviders, currentProvider: 'siliconflow' };
  assert.equal(activeConfig(switched).apiKey, 'sk-sf');
  assert.equal(slotFor(switched, 'deepseek').apiKey, 'sk-deepseek');
});

t('没配置过的服务商用模板默认地址、空 Key', () => {
  const slot = slotFor({}, 'deepseek');
  assert.equal(slot.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(slot.engine, 'openai');
  assert.equal(slot.apiKey, '');
});

t('自定义服务商默认 OpenAI 协议、地址为空', () => {
  const slot = slotFor({}, '__custom__');
  assert.equal(slot.engine, 'openai');
  assert.equal(slot.baseUrl, '');
});

t('未知服务商回退到默认', () => {
  assert.equal(slotFor({}, 'nope').provider, DEFAULTS.currentProvider);
});

// ---------------- 深合并 ----------------
console.log('\n[mergeConfig]');

t('只改 siliconflow 不影响 deepseek', () => {
  const next = mergeConfig(twoProviders, { providerConfig: { siliconflow: { apiKey: 'sk-new' } } });
  assert.equal(next.providerConfig.deepseek.apiKey, 'sk-deepseek');
  assert.equal(next.providerConfig.siliconflow.apiKey, 'sk-new');
  assert.equal(next.providerConfig.siliconflow.baseUrl, 'https://api.siliconflow.cn/v1');
});

t('标量字段直接覆盖', () => {
  assert.equal(mergeConfig({ targetLang: 'zh-CN' }, { targetLang: 'ja' }).targetLang, 'ja');
});

// ---------------- 导入校验 ----------------
console.log('\n[导入校验]');

function envelope(config) {
  return { app: 'rimefox', schema: 1, config };
}

t('接受新的按服务商结构', () => {
  const { config } = pickImportedConfig(
    envelope({
      currentProvider: 'siliconflow',
      providerConfig: {
        siliconflow: { engine: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf', model: 'qwen' }
      },
      targetLang: 'en',
      theme: 'dashed',
      batchSize: 8
    })
  );
  assert.equal(config.currentProvider, 'siliconflow');
  assert.equal(config.providerConfig.siliconflow.apiKey, 'sk-sf');
});

t('兼容 v4 导入文件（engine + engineConfig）', () => {
  const { config } = pickImportedConfig(
    envelope({
      engine: 'openai',
      engineConfig: { openai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', model: 'deepseek-chat' } },
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8
    })
  );
  assert.equal(config.providerConfig.deepseek.apiKey, 'sk-ds');
  assert.equal(config.currentProvider, 'deepseek');
});

t('旧扁平结构仍可导入', () => {
  const { config } = pickImportedConfig(
    envelope({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'sk-sf',
      model: 'qwen',
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8
    })
  );
  assert.equal(config.providerConfig.siliconflow.apiKey, 'sk-sf');
});

t('未知服务商被拒绝并记入 rejected', () => {
  const { rejected } = pickImportedConfig(
    envelope({
      currentProvider: 'skynet',
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8,
      concurrency: 6
    })
  );
  assert.ok(rejected.indexOf('currentProvider') >= 0);
});

t('错误的 thinkingMode 被拒绝', () => {
  const { rejected } = pickImportedConfig(
    envelope({ thinkingMode: 'sometimes', targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  );
  assert.ok(rejected.indexOf('thinkingMode') >= 0);
});

t('格式不对的外部 JSON 仍被拒绝', () => {
  assert.throws(() => pickImportedConfig({ theme: 'system' }), /rimefox/);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
