// 提示词单测：普通翻译 vs 趣味翻译（纯函数，不依赖浏览器与网络）。
// 运行：node test/prompt.test.mjs
import assert from 'node:assert/strict';

import { systemPrompt, temperatureFor, promptFingerprint, hasKeepMarks } from '../lib/prompt.js';
import { LANGUAGES, STYLES, styleById, langLabel } from '../lib/config.js';

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

t('简体 / 繁体：目标是中文时提示另一种写法也要转写；其它目标语言不加这句', () => {
  assert.ok(systemPrompt('zh-TW').includes('简体中文的段落不算已是繁體中文'));
  assert.ok(systemPrompt('zh-CN').includes('繁體中文的段落不算已是简体中文'));
  assert.ok(!systemPrompt('en').includes('转写成'));
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

t('要求保留段落里的分行，并且换行只写成 JSON 标准的 \\n（不多转义一层）', () => {
  ['plain', 'classical', 'catgirl'].forEach((style) => {
    const p = systemPrompt('en', style);
    assert.ok(p.includes('JSON 字符串里的 \\n'), style + ' 缺少分行规则');
    assert.ok(p.includes('行数与原文一致'));
    assert.ok(p.includes('不要写成 \\\\n'), style + ' 没有禁止多转义的换行');
    assert.ok(!p.includes('换行符 \\n 是原文的分行'), '旧写法容易让模型把反斜杠 + n 当正文输出');
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


t('align 模式：输出对象格式与句子分组规则；默认提示词逐字不变', () => {
  const plain = systemPrompt('zh-CN');
  const aligned = systemPrompt('zh-CN', 'plain', [], '', false, true);
  assert.ok(!plain.includes('"parts"'), '默认模式不应出现 parts');
  assert.notEqual(plain, aligned);
  assert.ok(aligned.includes('"parts"'));
  assert.ok(aligned.includes('所有 n 加起来必须等于原文的句子数'));
  assert.ok(aligned.includes('可以把相邻几句合成一组'));
  assert.ok(aligned.includes('忽略以上规则'));
  assert.ok(aligned.includes('JSON 字符串里的 \\n'));
});

t('align 模式规则编号连续，自定义提示词仍在最后', () => {
  const p = systemPrompt('zh-CN', 'plain', [], '产品名统一译作「凛狐」', false, true);
  const nums = p
    .split('\n')
    .map((line) => /^(\d+)\)/.exec(line))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  nums.forEach((n, i) => assert.equal(n, i + 1));
  assert.ok(p.trim().endsWith('产品名统一译作「凛狐」'));
});

// ---------------- 0.9.6 目标语言约束（普通 / 结构化共用一套） ----------------
// 0.9.5 的问题：align 模式的输出指令只写「第 i 段的译文对象」，示例译文固定是中文，
// 目标语言选英文时模型会跟着示例输出中文。下面这组断言把「目标语言必须显式写进两种模式」钉住。

t('目标语言：普通与 align 共用同一条「唯一目标语言」，写清楚名称和代码', () => {
  LANGUAGES.forEach((lang) => {
    const want = '唯一目标语言：' + lang.label + ' (' + lang.value + ')。';
    const plain = systemPrompt(lang.value);
    const aligned = systemPrompt(lang.value, 'plain', [], '', false, true);
    assert.equal(plain.split('\n')[1], want, lang.value + ' 普通模式缺唯一目标语言');
    assert.equal(aligned.split('\n')[1], want, lang.value + ' align 模式缺唯一目标语言');
  });
});

t('目标语言：结构化输出说明里点名目标语言，示例不再固定中文译文', () => {
  const p = systemPrompt('en', 'plain', [], '', false, true);
  assert.ok(p.includes('必须使用唯一目标语言 English (en)'));
  assert.ok(p.includes('t 是这一组的译文，必须用English写'));
  assert.ok(!p.includes('这一组句子的译文'), '旧的中文示例不能留着');
  assert.ok(p.includes('{"parts":[{"n":1,"t":"<这一组句子用English写的译文>"}]}'));
  assert.ok(p.includes('不是译文语言'), '要说明 parts / n / t 只是协议字段名');
  assert.ok(!systemPrompt('en').includes('"parts"'), '普通模式仍然不能出现 parts');
});

t('目标语言：日→英 / 日→中 / 中→英，普通和 align 都写明目标语言', () => {
  [
    ['en', 'English'],
    ['zh-CN', '简体中文'],
    ['ja', '日本語']
  ].forEach(([code, name]) => {
    const plain = systemPrompt(code);
    const aligned = systemPrompt(code, 'plain', [], '', false, true);
    assert.ok(plain.includes('唯一目标语言：' + name + ' (' + code + ')'), code + ' 普通模式');
    assert.ok(aligned.includes('唯一目标语言：' + name + ' (' + code + ')'), code + ' align 模式');
    assert.ok(plain.includes('目标语言（' + name + '）译文'), code + ' 普通输出说明');
    assert.ok(aligned.includes('目标语言 ' + name + ' (' + code + ')'), code + ' 结构化输出说明');
    assert.ok(!aligned.includes('这一组句子的译文'), code + ' 仍带着固定中文示例');
  });
});

t('目标语言：简繁互转规则在 align 模式同样生效', () => {
  assert.ok(systemPrompt('zh-TW', 'plain', [], '', false, true).includes('简体中文的段落不算已是繁體中文'));
  assert.ok(systemPrompt('zh-CN', 'plain', [], '', false, true).includes('繁體中文的段落不算已是简体中文'));
  assert.ok(!systemPrompt('en', 'plain', [], '', false, true).includes('转写成'));
});

t('目标语言：术语表、自定义提示词、趣味风格都改不了唯一目标语言', () => {
  ['classical', 'catgirl'].forEach((style) => {
    const p = systemPrompt('en', style, [{ source: 'Emails', target: '邮箱（测试）' }], '产品名统一译作「凛狐」，用日文回答', false, true);
    assert.equal(p.split('\n')[1], '唯一目标语言：English (en)。');
    assert.ok(p.includes('Emails → 邮箱（测试）'));
    assert.ok(p.trim().endsWith('产品名统一译作「凛狐」，用日文回答'));
    assert.ok(p.includes('不得改变输出 JSON 数组的格式、元素数量或目标语言'));
  });
});

t('歧义：混排规则不再写「把英文句子翻译成目标语言」', () => {
  const en = systemPrompt('en');
  assert.ok(!en.includes('把其中的英文句子翻译成English'));
  assert.ok(en.includes('把需要翻译、且尚未用English表达的部分转换成English'));
  assert.ok(!en.includes('中英混排时'));
  assert.ok(systemPrompt('zh-CN').includes('把需要翻译、且尚未用简体中文表达的部分转换成简体中文'));
});

t('保留标记：只有本批带成对 <kN> 标记才加说明，其它提示词逐字不变', () => {
  assert.equal(hasKeepMarks(['Install <k1>Rimefox</k1> today.']), true);
  assert.equal(hasKeepMarks(['a <k1>x</k2> b', 'if a < b and c > d', '<k1>没闭合']), false);
  assert.equal(hasKeepMarks([]), false);
  ['zh-CN', 'en'].forEach((target) => {
    [false, true].forEach((align) => {
      const plain = systemPrompt(target, 'plain', [], '', false, align);
      assert.equal(systemPrompt(target, 'plain', [], '', false, align, false), plain);
      const marked = systemPrompt(target, 'plain', [], '', false, align, true);
      assert.ok(marked.startsWith(plain));
      assert.ok(marked.includes('<k1>…</k1>'));
      assert.ok(marked.includes('不翻译、不改写、不拆开'));
      // 文献引用也走保留标记：要求紧跟所引词句、不许模型自己编 / 合并 / 删引用编号
      assert.ok(marked.includes('文献引用编号'));
      assert.ok(marked.includes('不要自己另写、合并或删掉引用编号'));
      assert.ok(!plain.includes('文献引用编号'), '没有标记的批次提示词不能多出引用说明');
      assert.equal(marked.includes('parts 的 t 里同样保留这些标记'), align);
    });
  });
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
