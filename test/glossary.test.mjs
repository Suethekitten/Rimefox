// 术语表单测：CSV 解析 / 清洗 / 匹配 / 提示词片段 / 缓存指纹（纯函数，不依赖浏览器）。
// 运行：node test/glossary.test.mjs
import assert from 'node:assert/strict';

import {
  GLOSSARY_MAX,
  GLOSSARY_PROMPT_LIMIT,
  normalizeGlossary,
  parseGlossaryCsv,
  toGlossaryCsv,
  matchGlossary,
  glossaryPrompt,
  glossaryFingerprint
} from '../lib/glossary.js';

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

console.log('\n[术语表]');

t('normalizeGlossary：去空、trim、去重（大小写不敏感）', () => {
  const out = normalizeGlossary([
    { source: '  Battle Pass ', target: ' 战令 ' },
    { source: 'battle pass', target: '战令（重复）' },
    { source: '', target: '空原文' },
    { source: 'Token', target: '' },
    { source: 'Copilot', target: 'Copilot' }
  ]);
  assert.deepEqual(out, [
    { source: 'Battle Pass', target: '战令' },
    { source: 'Copilot', target: 'Copilot' }
  ]);
});

t('normalizeGlossary：条数上限 500', () => {
  const many = Array.from({ length: GLOSSARY_MAX + 20 }, (_, i) => ({ source: 'w' + i, target: 't' + i }));
  assert.equal(normalizeGlossary(many).length, GLOSSARY_MAX);
});

t('normalizeGlossary：接受 "a,b" 字符串与 [a,b] 数组', () => {
  const out = normalizeGlossary(['Public profile,公开资料', ['Social accounts', '社交账号']]);
  assert.deepEqual(out, [
    { source: 'Public profile', target: '公开资料' },
    { source: 'Social accounts', target: '社交账号' }
  ]);
});

t('parseGlossaryCsv：跳过表头、去 BOM、兼容 CRLF', () => {
  const text = '\uFEFFsource,target\r\nPublic profile,公开资料\r\n\r\nBattle Pass,战令\r\n';
  assert.deepEqual(parseGlossaryCsv(text), [
    { source: 'Public profile', target: '公开资料' },
    { source: 'Battle Pass', target: '战令' }
  ]);
});

t('parseGlossaryCsv：引号里的逗号 / 换行 / 双引号', () => {
  const text = 'source,target\n"Hello, world","你好，世界"\n"say ""hi""","说“嗨”"\n';
  assert.deepEqual(parseGlossaryCsv(text), [
    { source: 'Hello, world', target: '你好，世界' },
    { source: 'say "hi"', target: '说“嗨”' }
  ]);
});

t('parseGlossaryCsv：多余列忽略，缺列跳过', () => {
  const text = 'source,target,category,note\nCamouflage,涂装,战争雷霆,涂装样式\nOnlySource\n';
  assert.deepEqual(parseGlossaryCsv(text), [{ source: 'Camouflage', target: '涂装' }]);
});

t('toGlossaryCsv：往返一致，含逗号的单元格加引号', () => {
  const list = [
    { source: 'Hello, world', target: '你好，世界' },
    { source: 'say "hi"', target: '说“嗨”' }
  ];
  const csv = toGlossaryCsv(list);
  assert.match(csv, /^source,target\n/);
  assert.match(csv, /"Hello, world",你好，世界/);
  assert.deepEqual(parseGlossaryCsv(csv), list);
});

t('matchGlossary：英文按词边界（cat 不命中 category）', () => {
  const hits = matchGlossary([{ source: 'cat', target: '猫' }], ['category', 'a cat here']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'cat');
});

t('matchGlossary：大小写不敏感', () => {
  const hits = matchGlossary([{ source: 'Battle Pass', target: '战令' }], ['battle pass 和 BATTLE PASS']);
  assert.equal(hits.length, 1);
});

t('matchGlossary：中文按子串匹配', () => {
  const hits = matchGlossary([{ source: '战令', target: 'Battle Pass' }], ['这个战令怎么买']);
  assert.equal(hits.length, 1);
});

t('matchGlossary：按出现次数排序并受 limit 限制', () => {
  const list = [
    { source: 'Alpha', target: 'A' },
    { source: 'Beta', target: 'B' },
    { source: 'Gamma', target: 'C' }
  ];
  const hits = matchGlossary(list, ['Beta Beta Beta', 'Gamma Gamma', 'Alpha'], 2);
  assert.deepEqual(
    hits.map((h) => h.source),
    ['Beta', 'Gamma']
  );
  assert.equal(GLOSSARY_PROMPT_LIMIT, 20);
});

t('matchGlossary：没命中返回空数组', () => {
  assert.deepEqual(matchGlossary([{ source: 'Nope', target: '不' }], ['nothing here']), []);
});

t('glossaryPrompt：空命中返回空串，有命中输出对照行', () => {
  assert.equal(glossaryPrompt([]), '');
  const text = glossaryPrompt([{ source: 'Public profile', target: '公开资料' }]);
  assert.match(text, /必须使用/);
  assert.match(text, /Public profile → 公开资料/);
});

t('glossaryFingerprint：稳定，改译法后变化，清空为 none', () => {
  const a = [{ source: 'A', target: '甲' }];
  const b = [{ source: 'A', target: '乙' }];
  assert.equal(glossaryFingerprint(a), glossaryFingerprint([{ source: 'A', target: '甲' }]));
  assert.notEqual(glossaryFingerprint(a), glossaryFingerprint(b));
  assert.equal(glossaryFingerprint([]), 'none');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
