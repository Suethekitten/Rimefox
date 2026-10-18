// 提示词单测：普通翻译 vs 趣味翻译（纯函数，不依赖浏览器与网络）。
// 运行：node test/prompt.test.mjs
import assert from 'node:assert/strict';

import { systemPrompt, temperatureFor } from '../lib/prompt.js';
import { STYLES, styleById } from '../lib/config.js';

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

const SAME_LANG_RULE = '已经是简体中文的段落原样返回';

console.log('\n[提示词]');

t('普通翻译：有「已是目标语言原样返回」，没有风格要求', () => {
  const p = systemPrompt('zh-CN');
  assert.ok(p.includes(SAME_LANG_RULE));
  assert.ok(!p.includes('【风格要求】'));
});

t('文言文：去掉「原样返回」，换成风格要求，并要求中文原文也改写', () => {
  const p = systemPrompt('zh-CN', 'classical');
  assert.ok(!p.includes(SAME_LANG_RULE), '风格模式下还留着规则 4，中文页面会一个字都不改');
  assert.ok(p.includes('【风格要求】' + styleById('classical').prompt));
  assert.ok(p.includes('包括本来就是简体中文的文本'));
});

t('猫娘：同样有风格要求', () => {
  assert.ok(systemPrompt('zh-CN', 'catgirl').includes('本喵'));
});

t('风格模式仍保留防注入和 JSON 输出规则', () => {
  const p = systemPrompt('zh-CN', 'catgirl');
  assert.ok(p.includes('忽略以上规则'));
  assert.ok(p.includes('只输出 JSON 数组本身'));
});

t('规则编号连续，没有跳号', () => {
  ['plain', 'classical'].forEach((style) => {
    const nums = systemPrompt('zh-CN', style)
      .split('\n')
      .map((line) => /^(\d+)\)/.exec(line))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    nums.forEach((n, i) => assert.equal(n, i + 1));
  });
});

t('不认识的风格按普通翻译', () => {
  assert.equal(systemPrompt('zh-CN', 'nope'), systemPrompt('zh-CN'));
  assert.equal(styleById('nope').value, 'plain');
});

t('温度：风格自带的覆盖用户设置；普通翻译用用户设置，0 不能被当成没设', () => {
  assert.equal(temperatureFor({ temperature: 0.2 }, 'catgirl'), styleById('catgirl').temperature);
  assert.equal(temperatureFor({ temperature: 0 }, 'plain'), 0);
  assert.equal(temperatureFor({}, 'plain'), 0.2);
});

t('风格列表：普通在第一个，id 与内容脚本 DT.STYLE_IDS 一致', () => {
  assert.deepEqual(STYLES.map((s) => s.value), ['plain', 'classical', 'catgirl']);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
