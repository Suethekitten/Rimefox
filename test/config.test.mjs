// 配置层单测：v4→v5 迁移、按服务商的 Key 隔离、深合并、导入校验。
// 运行：node test/config.test.mjs
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  CONFIG_VERSION,
  migrateConfig,
  mergeConfig,
  activeConfig,
  slotFor,
  pickImportedConfig,
  providerChoices,
  mergeCustomProviderLists,
  resolveInputTarget,
  LANGUAGES
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
  assert.equal(CONFIG_VERSION, 6);
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

t('dockPos：合并时清洗成 {x,y} 或 null，坏数据不落盘（0.9.3）', () => {
  assert.deepEqual(mergeConfig({}, { dockPos: { x: 1.4, y: '2' } }).dockPos, { x: 1, y: 2 });
  assert.equal(mergeConfig({}, { dockPos: { x: 'a', y: 2 } }).dockPos, null);
  assert.equal(mergeConfig({}, { dockPos: 'right' }).dockPos, null);
  assert.deepEqual(mergeConfig({ dockPos: { x: 3, y: 4 } }, {}).dockPos, { x: 3, y: 4 });
  assert.equal(mergeConfig({ dockPos: { x: 3, y: 4 } }, { dockPos: null }).dockPos, null);
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

// ---------------- 自定义服务商（可命名、可多个） ----------------
console.log('\n[自定义服务商]');

t('v5 配置里的 __custom__ 槽会自动补进列表', () => {
  const next = migrateConfig({
    _v: 5,
    currentProvider: '__custom__',
    providerConfig: { __custom__: { engine: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk-r', model: 'm' } }
  });
  assert.equal(next.customProviders.length, 1);
  assert.equal(next.customProviders[0].id, '__custom__');
  assert.equal(next.customProviders[0].name, '自定义 1');
});

t('v6 已命名的列表原样保留', () => {
  const next = migrateConfig({
    _v: 6,
    providerConfig: { 'custom:2': { engine: 'openai', baseUrl: 'https://a/v1', apiKey: 'k' } },
    customProviders: [{ id: 'custom:2', name: '我的中转 A' }]
  });
  assert.equal(next.customProviders[0].name, '我的中转 A');
});

t('自定义 id 被认作合法服务商', () => {
  assert.equal(slotFor({}, 'custom:2').provider, 'custom:2');
  assert.equal(slotFor({}, '__custom__').provider, '__custom__');
});

t('导入带自定义服务商的配置', () => {
  const { config } = pickImportedConfig(
    envelope({
      currentProvider: 'custom:2',
      customProviders: [{ id: 'custom:2', name: '我的中转 A' }],
      providerConfig: { 'custom:2': { engine: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk-r' } },
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8
    })
  );
  assert.equal(config.currentProvider, 'custom:2');
  assert.equal(config.customProviders[0].name, '我的中转 A');
  assert.equal(config.providerConfig['custom:2'].apiKey, 'sk-r');
});

t('非法自定义 id 会被拒绝', () => {
  const { rejected } = pickImportedConfig(
    envelope({
      customProviders: [{ id: 'evil/id', name: 'x' }],
      targetLang: 'zh-CN',
      theme: 'underline',
      batchSize: 8
    })
  );
  assert.ok(rejected.indexOf('customProviders') >= 0);
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

t('uiTheme 只接受 auto / light / dark', () => {
  const ok = pickImportedConfig(
    envelope({ uiTheme: 'dark', targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  ).config;
  assert.equal(ok.uiTheme, 'dark');
  const { rejected } = pickImportedConfig(
    envelope({ uiTheme: 'sepia', targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  );
  assert.ok(rejected.indexOf('uiTheme') >= 0);
});

t('uiLang 只接受 zh / en', () => {
  const ok = pickImportedConfig(
    envelope({ uiLang: 'en', targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  ).config;
  assert.equal(ok.uiLang, 'en');
  const { rejected } = pickImportedConfig(
    envelope({ uiLang: 'fr', targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  );
  assert.ok(rejected.indexOf('uiLang') >= 0);
});

t('customPrompt 超过 2000 字被拒绝，正常长度保留', () => {
  const ok = pickImportedConfig(
    envelope({ customPrompt: '术语统一', targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  ).config;
  assert.equal(ok.customPrompt, '术语统一');
  const { rejected } = pickImportedConfig(
    envelope({ customPrompt: 'x'.repeat(2001), targetLang: 'zh-CN', theme: 'underline', batchSize: 8 })
  );
  assert.ok(rejected.indexOf('customPrompt') >= 0);
});

t('格式不对的外部 JSON 仍被拒绝', () => {
  assert.throws(() => pickImportedConfig({ theme: 'system' }), /rimefox/);
});

// ---------------- 服务商切换列表 ----------------
console.log('\n[服务商切换列表]');

t('providerChoices：只列配置过的槽位，标出当前与是否有 Key', () => {
  const list = providerChoices(twoProviders);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'deepseek');
  assert.equal(list[0].current, true);
  assert.equal(list[0].hasKey, true);
  assert.equal(list[1].id, 'siliconflow');
  assert.equal(list[1].current, false);
});

t('providerChoices：没有 Key 的排在后面，且不泄露 Key 本身', () => {
  const cfg = {
    currentProvider: 'siliconflow',
    providerConfig: {
      deepseek: { apiKey: '', model: 'deepseek-chat' },
      siliconflow: { apiKey: 'sk-sf', model: 'qwen' }
    }
  };
  const list = providerChoices(cfg);
  assert.equal(list[0].id, 'siliconflow');
  assert.equal(list[1].hasKey, false);
  assert.equal(JSON.stringify(list).includes('sk-sf'), false);
});

t('providerChoices：自定义服务商用保存的名字', () => {
  const cfg = {
    currentProvider: 'custom:2',
    customProviders: [{ id: 'custom:2', name: '我的中转' }],
    providerConfig: { 'custom:2': { apiKey: 'k', model: 'm' } }
  };
  const list = providerChoices(cfg);
  assert.equal(list[0].name, '我的中转');
  assert.equal(list[0].current, true);
});

t('导入术语表：导出文件里的 glossary 清洗后导入，坏格式计入 rejected', () => {
  const { config } = pickImportedConfig(
    envelope({
      targetLang: 'zh-CN',
      theme: 'underline',
      glossary: [{ source: 'Rimefox', target: '凛狐', category: '品牌' }, { source: '', target: '空' }, { source: 'rimefox', target: '重复' }]
    })
  );
  assert.deepEqual(config.glossary, [{ source: 'Rimefox', target: '凛狐', category: '品牌' }]);
  const bad = pickImportedConfig(envelope({ targetLang: 'zh-CN', theme: 'underline', mode: 'dual', glossary: 'Rimefox,凛狐' }));
  assert.ok(bad.rejected.indexOf('glossary') >= 0);
  assert.equal(bad.config.glossary, undefined);
  const empty = pickImportedConfig(envelope({ targetLang: 'zh-CN', theme: 'underline', mode: 'dual', glossary: [] }));
  assert.equal(empty.config.glossary, undefined, '空术语表不覆盖本机已有的');
});

// ---------------- 删除自定义服务商 ----------------
console.log('\n[删除自定义服务商]');

const withCustom = {
  currentProvider: 'deepseek',
  providerConfig: {
    deepseek: { engine: 'openai', apiKey: 'sk-ds', model: 'deepseek-chat' },
    'custom:2': { engine: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk-secret', model: 'm' }
  },
  customProviders: [{ id: 'custom:2', name: '我的中转' }]
};

t('列表里删掉的自定义服务商：保存后槽位连同 Key 一起删掉', () => {
  const patch = { providerConfig: { deepseek: { apiKey: 'sk-ds' } }, customProviders: [] };
  const next = mergeConfig(withCustom, patch);
  assert.deepEqual(Object.keys(next.providerConfig), ['deepseek']);
  assert.equal(JSON.stringify(next).includes('sk-secret'), false);
});

t('patch 不带列表（弹窗 / 后台只改一两项）时不动自定义槽位', () => {
  const next = mergeConfig(withCustom, { mode: 'translation' });
  assert.equal(next.providerConfig['custom:2'].apiKey, 'sk-secret');
});

t('providerChoices：不在列表里的自定义槽位（老版本删除留下的）不再出现', () => {
  const orphan = { ...withCustom, customProviders: [] };
  const ids = providerChoices(orphan).map((p) => p.id);
  assert.deepEqual(ids, ['deepseek']);
});

t('导入老格式迁移出来的 __custom__ 槽位会补进列表，不会被当成已删除', () => {
  const { config } = pickImportedConfig(
    envelope({
      engine: 'openai',
      engineConfig: { openai: { baseUrl: 'https://relay.example/v1', apiKey: 'sk-x', model: 'm' } },
      targetLang: 'zh-CN',
      theme: 'underline'
    })
  );
  assert.ok(config.providerConfig.__custom__);
  assert.deepEqual(config.customProviders.map((p) => p.id), ['__custom__']);
  const next = mergeConfig(withCustom, { ...config, customProviders: mergeCustomProviderLists(withCustom.customProviders, config.customProviders) });
  assert.equal(next.providerConfig.__custom__.apiKey, 'sk-x');
  assert.equal(next.providerConfig['custom:2'].apiKey, 'sk-secret', '本机已有的自定义服务商不被导入删掉');
});

t('mergeCustomProviderLists：补进新的，同 id 用文件里的名字', () => {
  const out = mergeCustomProviderLists(
    [{ id: 'custom:2', name: '旧名' }, { id: 'custom:3', name: '本机' }],
    [{ id: 'custom:2', name: '新名' }, { id: 'custom:4', name: '文件' }]
  );
  assert.deepEqual(out, [
    { id: 'custom:2', name: '新名' },
    { id: 'custom:3', name: '本机' },
    { id: 'custom:4', name: '文件' }
  ]);
});

// ---------------- 输入框翻译的目标语言 ----------------
console.log('\n[输入框翻译：目标语言]');

t('auto：跟随页面语言，认得的大小写都能对上', () => {
  assert.equal(resolveInputTarget('auto', 'zh-CN'), 'zh-CN');
  assert.equal(resolveInputTarget('auto', 'en-US'), 'en');
  assert.equal(resolveInputTarget('auto', 'JA'), 'ja');
  assert.equal(resolveInputTarget('', 'fr'), 'fr');
  assert.equal(resolveInputTarget(undefined, 'zh-TW'), 'zh-TW');
});

t('auto：页面只写语言、不写地区时按语言段匹配', () => {
  assert.equal(resolveInputTarget('auto', 'zh'), 'zh-CN', 'zh 落到简体（LANGUAGES 里第一个中文）');
  assert.equal(resolveInputTarget('auto', 'pt'), 'pt');
});

t('auto：认不出来（空 / 不支持 / 乱写）用英文', () => {
  assert.equal(resolveInputTarget('auto', ''), 'en');
  assert.equal(resolveInputTarget('auto', null), 'en');
  assert.equal(resolveInputTarget('auto', 'xx'), 'en');
  assert.equal(resolveInputTarget('auto', 'klingon-1'), 'en');
});

t('显式设置优先于页面语言；不认识的设置退回跟随页面', () => {
  assert.equal(resolveInputTarget('ja', 'zh-CN'), 'ja', '设置里选的语言优先');
  assert.equal(resolveInputTarget('FR', 'zh-CN'), 'fr', '大小写不敏感，统一成表里的写法');
  assert.equal(resolveInputTarget('xx', 'ko'), 'ko', '不认识的设置不算数，退回跟随页面');
});

t('默认值：inputHotkey=alt+i、inputTargetLang=auto，且能通过导入校验', () => {
  assert.equal(DEFAULTS.inputHotkey, 'alt+i');
  assert.equal(DEFAULTS.inputTargetLang, 'auto');
  const ok = pickImportedConfig(envelope({ targetLang: 'zh-CN', theme: 'underline', inputHotkey: 'ctrl+shift+i', inputTargetLang: 'de' }));
  assert.equal(ok.rejected.indexOf('inputHotkey'), -1);
  assert.equal(ok.rejected.indexOf('inputTargetLang'), -1);
  assert.equal(ok.config.inputTargetLang, 'de');
  // 多带一项合法配置：命中过少会被当作「不是凛狐的文件」直接抛错，测不到这两项
  const bad = pickImportedConfig(
    envelope({ targetLang: 'zh-CN', theme: 'underline', batchSize: 8, inputHotkey: 'i', inputTargetLang: 'xx' })
  );
  assert.ok(bad.rejected.indexOf('inputHotkey') >= 0);
  assert.ok(bad.rejected.indexOf('inputTargetLang') >= 0);
});

t('LANGUAGES 里 zh-CN / zh-TW 都在（简繁区分）', () => {
  const values = LANGUAGES.map((one) => one.value);
  assert.ok(values.includes('zh-CN') && values.includes('zh-TW'));
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
