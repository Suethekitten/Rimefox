// 界面语言单测：静态文案映射（纯函数，不依赖浏览器）。
// 运行：node test/i18n.test.mjs
import assert from 'node:assert/strict';

import { translateText, UI_LANGS } from '../lib/i18n.js';

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

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
