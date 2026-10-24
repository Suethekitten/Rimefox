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
  glossaryFingerprint,
  createHitFingerprint,
  upsertGlossaryEntry
} from '../lib/glossary.js';
import { STARTER } from '../lib/glossary-sample.js';

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

t('normalizeGlossary：保留分类；分类为空时不写这个键', () => {
  const out = normalizeGlossary([
    { source: 'Battle Pass', target: '战令', category: ' 战争雷霆 ' },
    { source: 'Profile', target: '资料', category: '' }
  ]);
  assert.deepEqual(out, [
    { source: 'Battle Pass', target: '战令', category: '战争雷霆' },
    { source: 'Profile', target: '资料' }
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

t('parseGlossaryCsv：表头明确指定说明列，缺列跳过', () => {
  const text = 'source,target,category,note\nCamouflage,涂装,战争雷霆,涂装样式\nOnlySource\n';
  assert.deepEqual(parseGlossaryCsv(text), [{ source: 'Camouflage', target: '涂装', category: '战争雷霆', note: '涂装样式' }]);
});

t('toGlossaryCsv：往返一致，含逗号的单元格加引号', () => {
  const list = [
    { source: 'Hello, world', target: '你好，世界' },
    { source: 'say "hi"', target: '说“嗨”' }
  ];
  const csv = toGlossaryCsv(list);
  assert.match(csv, /^source,target,category,note\n/);
  assert.match(csv, /"Hello, world",你好，世界/);
  assert.deepEqual(parseGlossaryCsv(csv), list);
});

t('toGlossaryCsv：分类列往返一致', () => {
  const list = [{ source: 'Battle Pass', target: '战令', category: '战争雷霆' }];
  const csv = toGlossaryCsv(list);
  assert.match(csv, /Battle Pass,战令,战争雷霆/);
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

t('glossaryFingerprint：分类只是 UI 元数据，不进指纹', () => {
  const a = [{ source: 'A', target: '甲', category: '分类一' }];
  const b = [{ source: 'A', target: '甲', category: '分类二' }];
  assert.equal(glossaryFingerprint(a), glossaryFingerprint(b));
});

t('示例数据：109 条，全部带分类', () => {
  assert.equal(STARTER.length, 109);
  assert.ok(STARTER.every((one) => one.category), '有示例条目没带分类');
});

t('createHitFingerprint：只算这段原文命中的术语，加一条不相干的术语不影响别的段落', () => {
  const base = [{ source: 'Rimefox', target: '凛狐' }, { source: 'cache', target: '缓存' }];
  const a = createHitFingerprint(base);
  const b = createHitFingerprint(base.concat({ source: 'glossary', target: '术语表' }));
  const hit = 'Rimefox keeps a cache of translations.';
  const plain = 'Nothing special here.';
  assert.equal(a(plain), 'none', '没命中任何术语');
  assert.equal(b(plain), 'none', '加了不相干的术语，没命中的段落指纹不变');
  assert.equal(a(hit), b(hit), '加的术语这段没用到：指纹不变');
  assert.notEqual(b('The glossary is new.'), 'none');
  const c = createHitFingerprint([{ source: 'Rimefox', target: '凛狐 Rimefox' }, base[1]]);
  assert.notEqual(c(hit), a(hit), '命中的术语改了译法：指纹要变');
  assert.equal(c('Only cache here.'), a('Only cache here.'), '没命中改动那条的段落不受影响');
  assert.equal(createHitFingerprint([])('anything'), 'none');
});

t('createHitFingerprint：和整张表的指纹同一种算法（命中的就是整张表时两者相同）', () => {
  const list = [{ source: 'Rimefox', target: '凛狐' }];
  assert.equal(createHitFingerprint(list)('Rimefox'), glossaryFingerprint(list));
  assert.equal(createHitFingerprint(list)('rimefox is lower case'), glossaryFingerprint(list), '匹配不分大小写，和提示词注入一致');
});

t('upsertGlossaryEntry：新增一条，不改原数组', () => {
  const before = [{ source: 'Rimefox', target: '凛狐' }];
  const res = upsertGlossaryEntry(before, { source: 'cache', target: '缓存' });
  assert.equal(res.action, 'added');
  assert.equal(res.list.length, 2);
  assert.equal(before.length, 1, '不能就地改调用方的数组');
  assert.deepEqual(res.list[1], { source: 'cache', target: '缓存' });
});

t('upsertGlossaryEntry：原文和译法都已存在时什么都不做', () => {
  const list = [{ source: 'cache', target: '缓存' }];
  const res = upsertGlossaryEntry(list, { source: 'Cache', target: '缓存' });
  assert.equal(res.action, 'same');
  assert.equal(res.list.length, 1);
});

t('upsertGlossaryEntry：同名不同译法先报冲突，不覆盖', () => {
  const list = [{ source: 'cache', target: '缓存' }];
  const res = upsertGlossaryEntry(list, { source: 'cache', target: '快取' });
  assert.equal(res.action, 'conflict');
  assert.equal(res.current, '缓存', '把现有译法带回去给气泡问用户');
  assert.deepEqual(res.list, list, '没确认就不写');
});

t('upsertGlossaryEntry：确认覆盖后换译法，分类和位置保留', () => {
  const list = [{ source: 'cache', target: '缓存', category: '技术' }, { source: 'dock', target: '悬浮入口' }];
  const res = upsertGlossaryEntry(list, { source: 'Cache', target: '快取' }, { overwrite: true });
  assert.equal(res.action, 'updated');
  assert.deepEqual(res.list[0], { source: 'cache', target: '快取', category: '技术' }, '原文用旧的写法，分类不丢');
  assert.equal(res.list[1].source, 'dock');
});

t('upsertGlossaryEntry：原文和译法都按术语表规则清洗（空白折成一个、去首尾）', () => {
  const res = upsertGlossaryEntry([], { source: '  Battle   Pass ', target: ' 战令\n' });
  assert.equal(res.action, 'added');
  assert.deepEqual(res.list[0], { source: 'Battle Pass', target: '战令' });
});

t('upsertGlossaryEntry：空原文 / 空译法 / 非字符串都算无效，一个字都不写', () => {
  assert.equal(upsertGlossaryEntry([], { source: '', target: '甲' }).action, 'invalid');
  assert.equal(upsertGlossaryEntry([], { source: '甲', target: '   ' }).action, 'invalid');
  assert.equal(upsertGlossaryEntry([], null).action, 'invalid');
  assert.equal(upsertGlossaryEntry([], { source: 12, target: null }).action, 'invalid');
});

t('upsertGlossaryEntry：到 ' + GLOSSARY_MAX + ' 条后不再新增，改已有条目仍然可以', () => {
  const full = Array.from({ length: GLOSSARY_MAX }, (_, i) => ({ source: 't' + i, target: 't' + i }));
  const res = upsertGlossaryEntry(full, { source: 'new', target: '新' });
  assert.equal(res.action, 'full');
  assert.equal(res.list.length, GLOSSARY_MAX);
  const edit = upsertGlossaryEntry(full, { source: 't7', target: '七' }, { overwrite: true });
  assert.equal(edit.action, 'updated', '满表也该能修已有条目的译法');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
