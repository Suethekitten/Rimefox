// 界面语言单测：静态文案映射（纯函数，不依赖浏览器）。
// 运行：node test/i18n.test.mjs
import assert from 'node:assert/strict';

import { translateText, t as translateFor, applyI18n, UI_LANGS } from '../lib/i18n.js';

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

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
