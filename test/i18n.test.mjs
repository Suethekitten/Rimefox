// 界面语言单测：静态文案映射（纯函数，不依赖浏览器）。
// 运行：node test/i18n.test.mjs
import assert from 'node:assert/strict';

import { translateText, t as translateFor, applyI18n, UI_LANGS } from '../lib/i18n.js';
import { sanitizeTranslationCss, ACCENT_PRESETS } from '../lib/appearance.js';
import { normalizeSiteRules, BUILTIN_SITE_RULES } from '../lib/site-rules.js';

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

console.log('\n[界面语言]');

t('translateText：整段精确匹配，保留前后空白', () => {
  assert.equal(translateText('保存'), 'Save');
  assert.equal(translateText('  保存\n'), '  Save\n');
});

t('translateText：未知文案原样返回', () => {
  assert.equal(translateText('这不是界面文案'), '这不是界面文案');
  assert.equal(translateText(''), '');
});

t('translateText：动态状态文案按模式翻译', () => {
  assert.equal(translateText('已保存（12:34:56）'), 'Saved (12:34:56)');
  assert.equal(
    translateText('已导入 109 条（新增 109 条，点「保存」后生效）'),
    'Imported 109 term(s) (109 new); click Save to apply'
  );
  assert.equal(translateText('切换失败：network error'), 'Switch failed: network error');
  assert.equal(translateText('未开启。按 Alt + A 可直接翻译。'), 'Off. Press Alt + A to translate the page.');
  assert.equal(translateText('翻译中… 已译 42 / 118 段（36%）'), 'Translating… 42 / 118 paragraphs (36%)');
  assert.equal(translateText('已译 42 段'), '42 paragraphs translated');
  assert.equal(translateText('失败原因：'), 'Last error: ');
  assert.equal(translateText('开始翻译'), 'Translate');
});

t('核心入口文案已覆盖', () => {
  ['设置', '翻译', '术语表', '快捷键', '缓存与迁移', '高级', '保存', '放弃更改', '翻译此页', '诊断'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('语言列表：中文在前，English 在后', () => {
  assert.deepEqual(
    UI_LANGS.map((one) => one.value),
    ['zh', 'en']
  );
});

t('设置页新增文案已覆盖', () => {
  ['界面主题', '界面语言', '自定义提示词', '输出调试日志', '恢复默认'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('隐私设置文案已覆盖', () => {
  ['隐私保护', '本地脱敏', 'AI 隐私保护翻译', '邮箱地址', '电话号码', '身份证号', '银行卡号', '中文姓名'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('弹窗主题切换文案已覆盖', () => {
  ['切换到深色', '切换到浅色'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('t()：按当前界面语言输出', () => {
  assert.equal(translateFor('开始翻译'), '开始翻译');
  applyI18n(null, 'en');
  assert.equal(translateFor('开始翻译'), 'Translate');
  assert.equal(translateFor('未开启。按 Alt + A 可直接翻译。'), 'Off. Press Alt + A to translate the page.');
  applyI18n(null, 'zh');
  assert.equal(translateFor('开始翻译'), '开始翻译');
});

t('弹窗：读不到页面地址时的本地文件提示有英文', () => {
  const zh = '浏览器内置页、扩展商店页无法翻译。如果这是本地文件，请打开 chrome://extensions → 本扩展的「详细信息」→ 开启「允许访问文件网址」，然后按 ⌘R 刷新。';
  const en = translateText(zh);
  assert.notEqual(en, zh);
  assert.match(en, /local file/);
  assert.match(en, /chrome:\/\/extensions/);
});

t('外观 / 站点与兼容性：色板名和内置规则说明有英文', () => {
  ACCENT_PRESETS.forEach((one) => assert.notEqual(translateText(one.label), one.label, one.label + ' 没有英文'));
  BUILTIN_SITE_RULES.forEach((one) => assert.notEqual(translateText(one.note), one.note, one.note + ' 没有英文'));
  ['外观', '站点与兼容性', '悬浮入口', '置顶小窗', '可能降低性能', '高级参数', '搜索设置', '夜间'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('校验提示：自定义 CSS / 站点规则产生的每条错误都有英文', () => {
  const messages = [];
  ['color: red } body { x: y', 'background: url(x.png)', 'color: expression(1)', 'color: red /* x */', 'x'.repeat(2001), 'oops; 1x: 2', Array(42).fill('color: red').join(';')]
    .forEach((css) => messages.push(...sanitizeTranslationCss(css).errors));
  messages.push(...normalizeSiteRules({}).errors);
  messages.push(
    ...normalizeSiteRules([
      1,
      { matches: [] },
      { matches: ['http://bad host'], textSelectors: 'x' },
      { matches: ['a.com'], excludeSelectors: [3], mode: 'x', theme: 'nope' }
    ]).errors
  );
  messages.push(...normalizeSiteRules(Array(60).fill({ matches: ['a.com'] })).errors);
  assert.ok(messages.length >= 12, '错误样本太少：' + messages.length);
  messages.forEach((msg) => assert.notEqual(translateText(msg), msg, msg + ' 没有英文'));
});

t('校验提示：多条错误用「；」连起来时逐条翻译', () => {
  const zh = '第 1 条规则不是对象；第 2 条规则没有可用的 matches';
  assert.equal(translateText(zh), 'Rule 1 is not an object; Rule 2 has no usable matches');
  assert.equal(translateText('格式正确，共 3 条规则'), 'Looks good: 3 rule(s)');
  // 自带「；」的整句文案优先整句匹配
  assert.equal(translateText('设置在别的页面被修改过；保存时会以这里的内容为准'), 'Settings were changed on another page; saving here will overwrite them');
  // 没有一条能翻的就原样返回
  assert.equal(translateText('这不是界面文案；那也不是'), '这不是界面文案；那也不是');
});

t('设置页：缓存统计和浏览器快捷键行有英文', () => {
  assert.equal(
    translateText('本次会话：1234 条 · 793 KB（上限 8000 条 / 4.0 MB）　磁盘：321 条 · 64 KB（上限 512 KB）　命中率：63%（63 / 100）'),
    'This session: 1234 entries · 793 KB (limit 8000 entries / 4.0 MB)　Disk: 321 entries · 64 KB (limit 512 KB)　Hit rate: 63% (63 / 100)'
  );
  assert.equal(translateText('浏览器快捷键：⌥A'), 'Browser shortcut: ⌥A');
  assert.match(translateText('已获取 2 个模型。点「选择」挑一个，或直接手填；别忘了保存。'), /^Loaded 2 models\./);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
