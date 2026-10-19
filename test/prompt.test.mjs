// 提示词单测：普通翻译 vs 趣味翻译（纯函数，不依赖浏览器与网络）。
// 运行：node test/prompt.test.mjs
import assert from 'node:assert/strict';

import { systemPrompt, temperatureFor, promptFingerprint } from '../lib/prompt.js';
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

t('猫娘：不是只加句尾喵，要求混用自称 / 语气词并限制频率', () => {
  const p = systemPrompt('zh-CN', 'catgirl');
  assert.ok(p.includes('本喵'));
  assert.ok(p.includes('不要每句都加'));
  assert.ok(p.includes('最多 1–2 次'));
  assert.ok(p.includes('傲娇'));
  assert.ok(p.includes('不增不减'));
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

t('要求保留段落里的分行（内容脚本按行写回页面）', () => {
  ['plain', 'classical', 'catgirl'].forEach((style) => {
    const p = systemPrompt('zh-CN', style);
    assert.ok(p.includes('换行符 \\n 是原文的分行'), style + ' 缺少分行规则');
    assert.ok(p.includes('行数与原文一致'));
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

t('术语表：没有命中就不加术语段', () => {
  const text = systemPrompt('zh-CN', 'plain', []);
  assert.equal(text.includes('术语对照'), false);
});

t('术语表：命中时把译法写进提示词，并点明短文本也适用', () => {
  const text = systemPrompt('zh-CN', 'plain', [{ source: 'Emails', target: '邮箱（测试）' }]);
  assert.match(text, /术语对照/);
  assert.match(text, /Emails → 邮箱（测试）/);
  assert.match(text, /标题、按钮、导航等短文本同样适用/);
});

t('自定义提示词：追加在末尾，并重申格式/条数/语言不变', () => {
  const custom = '产品名统一译作「凛狐」；代码注释保持原文。';
  const text = systemPrompt('zh-CN', 'plain', [], custom);
  assert.ok(text.includes(custom));
  assert.ok(text.includes('不得改变输出 JSON 数组的格式、元素数量或目标语言'));
  assert.ok(text.trim().endsWith(custom));
});

t('自定义提示词：空或纯空白不追加', () => {
  const base = systemPrompt('zh-CN', 'plain', []);
  assert.equal(systemPrompt('zh-CN', 'plain', [], ''), base);
  assert.equal(systemPrompt('zh-CN', 'plain', [], '   '), base);
});

t('promptFingerprint：空为 none，去空白后稳定，改内容变化', () => {
  assert.equal(promptFingerprint(''), 'none');
  assert.equal(promptFingerprint('  '), 'none');
  assert.equal(promptFingerprint(' 术语统一 '), promptFingerprint('术语统一'));
  assert.notEqual(promptFingerprint('术语统一'), promptFingerprint('术语不统一'));
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
