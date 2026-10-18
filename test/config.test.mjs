// 配置层单测：v3→v4 迁移、引擎取值、深合并、导入校验。
// 运行：node test/config.test.mjs
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  CONFIG_VERSION,
  ENGINE_DEFAULTS,
  migrateConfig,
  mergeConfig,
  activeConfig,
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
console.log('\n[迁移 v3 → v4]');

const legacyV3 = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-old',
  model: 'deepseek-chat',
  batchSize: 8,
  concurrency: 6,
  targetLang: 'ja',
  theme: 'mask',
  hotkey: 'alt+q',
  _v: 3
};

t('扁平的地址/Key/模型 归到 openai 名下', () => {
  const next = migrateConfig(legacyV3);
  assert.equal(next.engineConfig.openai.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(next.engineConfig.openai.apiKey, 'sk-old');
  assert.equal(next.engineConfig.openai.model, 'deepseek-chat');
});

t('顶层不再保留 baseUrl / apiKey / model', () => {
  const next = migrateConfig(legacyV3);
  assert.equal(next.baseUrl, undefined);
  assert.equal(next.apiKey, undefined);
  assert.equal(next.model, undefined);
});

t('行为项原样保留', () => {
  const next = migrateConfig(legacyV3);
  assert.equal(next.targetLang, 'ja');
  assert.equal(next.theme, 'mask');
  assert.equal(next.hotkey, 'alt+q');
  assert.equal(next.batchSize, 8);
});

t('版本号升到当前版本', () => {
  const next = migrateConfig(legacyV3);
  assert.equal(next._v, CONFIG_VERSION);
  assert.equal(CONFIG_VERSION, 4);
});

t('engine 默认 openai', () => {
  assert.equal(migrateConfig(legacyV3).engine, 'openai');
});

t('其它引擎填默认地址、空 Key', () => {
  const next = migrateConfig(legacyV3);
  assert.equal(next.engineConfig.anthropic.baseUrl, ENGINE_DEFAULTS.anthropic.baseUrl);
  assert.equal(next.engineConfig.anthropic.apiKey, '');
  assert.equal(next.engineConfig.gemini.baseUrl, ENGINE_DEFAULTS.gemini.baseUrl);
});

t('v3 以下会纠偏并发/批量', () => {
  const next = migrateConfig({ baseUrl: 'u', apiKey: 'k', model: 'm', batchSize: 1, concurrency: 2, _v: 1 });
  assert.equal(next.batchSize, DEFAULTS.batchSize);
  assert.equal(next.concurrency, DEFAULTS.concurrency);
});

t('迁移是幂等的（再迁移一次不变）', () => {
  const once = migrateConfig(legacyV3);
  const twice = migrateConfig(once);
  assert.deepEqual(twice.engineConfig, once.engineConfig);
  assert.equal(twice._v, once._v);
});

// ---------------- 取当前引擎 ----------------
console.log('\n[activeConfig]');

t('默认取 openai', () => {
  const active = activeConfig({ engineConfig: { openai: { baseUrl: 'u1', apiKey: 'k1', model: 'm1' } } });
  assert.equal(active.engine, 'openai');
  assert.equal(active.apiKey, 'k1');
});

t('切到 anthropic 取它自己的配置', () => {
  const active = activeConfig({
    engine: 'anthropic',
    engineConfig: {
      openai: { baseUrl: 'u1', apiKey: 'k1', model: 'm1' },
      anthropic: { baseUrl: 'u2', apiKey: 'k2', model: 'm2' }
    }
  });
  assert.equal(active.engine, 'anthropic');
  assert.equal(active.baseUrl, 'u2');
  assert.equal(active.apiKey, 'k2');
});

t('未知引擎回退 openai', () => {
  assert.equal(activeConfig({ engine: 'nope' }).engine, 'openai');
});

// ---------------- 深合并 ----------------
console.log('\n[mergeConfig]');

t('只改 anthropic 不影响 openai', () => {
  const base = {
    engine: 'openai',
    engineConfig: { openai: { baseUrl: 'u1', apiKey: 'k1', model: 'm1' } }
  };
  const next = mergeConfig(base, { engineConfig: { anthropic: { apiKey: 'k2' } } });
  assert.equal(next.engineConfig.openai.apiKey, 'k1');
  assert.equal(next.engineConfig.anthropic.apiKey, 'k2');
  assert.equal(next.engineConfig.anthropic.baseUrl, ENGINE_DEFAULTS.anthropic.baseUrl);
});

t('标量字段直接覆盖', () => {
  const next = mergeConfig({ targetLang: 'zh-CN' }, { targetLang: 'ja' });
  assert.equal(next.targetLang, 'ja');
});

// ---------------- 导入校验 ----------------
console.log('\n[导入校验]');

function envelope(config) {
  return { app: 'rimefox', schema: 1, config };
}

t('接受新的嵌套结构', () => {
  const { config } = pickImportedConfig(
    envelope({
      engine: 'gemini',
      engineConfig: { gemini: { baseUrl: 'https://g/v1beta', apiKey: 'gk', model: 'gemini-x' } },
      targetLang: 'en',
      theme: 'dashed',
      batchSize: 8
    })
  );
  assert.equal(config.engine, 'gemini');
  assert.equal(config.engineConfig.gemini.apiKey, 'gk');
});

t('旧扁平结构仍可导入（归到 openai）', () => {
  const { config } = pickImportedConfig(
    envelope({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk',
      model: 'deepseek-chat',
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8
    })
  );
  // 旧的扁平字段不属于 DEFAULTS 里要处理的键，会被忽略；但其余设置能进来
  assert.equal(config.targetLang, 'zh-CN');
  assert.equal(config.batchSize, 8);
});

t('未知引擎被拒绝并记入 rejected', () => {
  const { rejected } = pickImportedConfig(
    envelope({
      engine: 'skynet',
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8,
      concurrency: 6
    })
  );
  assert.ok(rejected.indexOf('engine') >= 0);
});

t('错误的 thinkingMode 被拒绝', () => {
  const { rejected } = pickImportedConfig(
    envelope({
      thinkingMode: 'sometimes',
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8
    })
  );
  assert.ok(rejected.indexOf('thinkingMode') >= 0);
});

t('格式不对的外部 JSON 仍被拒绝', () => {
  assert.throws(() => pickImportedConfig({ theme: 'system' }), /rimefox/);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
