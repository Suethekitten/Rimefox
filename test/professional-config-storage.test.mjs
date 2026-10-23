// 真正经过存储读写的兼容迁移：旧弹窗的布尔 patch、新字段导入导出和旁路缓存保留。
import assert from 'node:assert/strict';
import { makeArea } from './_fake-storage.mjs';
import { getConfig, saveConfig, pickImportedConfig, mergeConfig, IMPORT_APP, IMPORT_SCHEMA, CONFIG_VERSION } from '../lib/config.js';

const local = makeArea({ clone: true });
globalThis.chrome = { storage: { local } };
const legacy = {
  _v: 6,
  medicalMode: true,
  currentProvider: 'custom:2',
  customProviders: [{ id: 'custom:2', name: 'Research API' }],
  providerConfig: { 'custom:2': { engine: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'test-config-key', model: 'research-model' } },
  glossary: [{ source: 'trial', target: '试验' }],
  customPrompt: 'Preserve uncertainty.',
  customCss: 'color: red;',
  targetLang: 'zh-CN',
  uiLang: 'en',
  liquidGlass: false,
  nightSites: ['example.test']
};
const cache = { test: 'existing translation cache' };
await local.set({ config: legacy, translationCache: cache });
let config = await getConfig();
assert.equal(config._v, CONFIG_VERSION);
assert.equal(config.professionalProfile, 'medical');
assert.equal(config.medicalMode, true);
assert.deepEqual(config.professionalOptions, { quality: 'balanced', subdomain: 'auto', maxReviewRequests: 1 });
assert.deepEqual(config.providerConfig, legacy.providerConfig);
assert.deepEqual(config.glossary, legacy.glossary);
for (const key of ['customPrompt', 'customCss', 'uiLang', 'liquidGlass', 'nightSites']) assert.deepEqual(config[key], legacy[key], key);
assert.deepEqual((await local.get('translationCache')).translationCache, cache);
assert.deepEqual((await local.get('config_backup_v3')).config_backup_v3, legacy);
console.log('  ✓ v6 存储迁移保留医学模式、接口、术语、个性化设置及缓存');

config = await saveConfig({ professionalProfile: 'general', medicalMode: true });
assert.equal(config.medicalMode, false);
config = await saveConfig({ medicalMode: true });
assert.equal(config.professionalProfile, 'medical');
config = await saveConfig({ medicalMode: false });
assert.equal(config.professionalProfile, 'general');
config = await saveConfig({ professionalProfile: 'medical', professionalOptions: { quality: 'strict', subdomain: 'oncology', maxReviewRequests: 3 } });
config = await saveConfig({ professionalOptions: { maxReviewRequests: 0 } });
assert.deepEqual(config.professionalOptions, { quality: 'strict', subdomain: 'oncology', maxReviewRequests: 0 });
assert.equal((await getConfig()).medicalMode, true);
assert.deepEqual((await local.get('translationCache')).translationCache, cache);
console.log('  ✓ 旧开关和新 profile 双向写回，部分质量配置保留其余选项');

const exported = JSON.parse(JSON.stringify({ app: IMPORT_APP, schema: IMPORT_SCHEMA, config }));
const imported = pickImportedConfig(exported);
assert.deepEqual(imported.rejected, []);
const restored = mergeConfig({}, imported.config);
assert.equal(restored.professionalProfile, 'medical');
assert.equal(restored.medicalMode, true);
assert.deepEqual(restored.professionalOptions, config.professionalOptions);
assert.deepEqual(restored.providerConfig, legacy.providerConfig);
assert.deepEqual(restored.glossary, legacy.glossary);
assert.equal(restored.customPrompt, legacy.customPrompt);
console.log('  ✓ 新配置导出再导入保留专业选项及用户 API/术语');

const storedBeforeRead = await local.get(null);
await getConfig();
assert.deepEqual(await local.get(null), storedBeforeRead, '已迁移配置重复读取不能重写备份或缓存');
console.log('  ✓ 迁移幂等，重复读取没有存储副作用');
