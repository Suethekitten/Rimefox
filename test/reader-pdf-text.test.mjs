// PDF 文本层 → 段落块 的单测：纯函数，不依赖 pdf.js / 浏览器。
// 运行：node test/reader-pdf-text.test.mjs
import assert from 'node:assert/strict';

import { itemsToLines, dropMargins, orderColumns, groupParagraphs, pageBlocks, parsePrintedToc, findRepeatedBandTexts, isFormulaOnly, isComplexPage, PDF_LONG_BLOCK_LIMIT, stripFootnoteMarkers, stripLatexArtifacts } from '../lib/reader/pdf-text.js';
import { splitLongText } from '../lib/reader/pdf-translate.js';

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
function item(str, x, y, width) {
  return { str: str, transform: [1, 0, 0, 1, x, y], width: width == null ? str.length * 5 : width };
}

console.log('\n[reader/pdf-text]');

t('同一行的片段按 x 拼接，空隙大时补空格', function () {
  const lines = itemsToLines([
    item('Hello', 10, 700, 26),
    item('world', 45, 700, 26)
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello world');
});

t('不同 y 分成不同行，并保持内容流顺序', function () {
  const lines = itemsToLines([item('second', 10, 600), item('first', 10, 700)]);
  assert.deepEqual(lines.map((line) => line.text), ['second', 'first']);
});

t('上下边距内的页眉页脚被丢掉', function () {
  const lines = itemsToLines([
    item('Header DOI', 10, 820),
    item('Body line', 10, 700),
    item('Page 3', 10, 20)
  ]);
  const kept = dropMargins(lines, 842);
  assert.deepEqual(kept.map((line) => line.text), ['Body line']);
});

t('双栏按「先左后右」排序，单栏保持原顺序', function () {
  const two = itemsToLines([
    item('L1', 50, 700), item('R1', 320, 700),
    item('L2', 50, 686), item('R2', 320, 686)
  ]);
  assert.deepEqual(orderColumns(two, 595).map((line) => line.text), ['L1', 'L2', 'R1', 'R2']);
  const one = itemsToLines([item('A', 50, 700), item('B', 50, 686)]);
  assert.deepEqual(orderColumns(one, 595).map((line) => line.text), ['A', 'B']);
});

t('行距超过阈值断段；行尾连字符拼回单词', function () {
  const lines = itemsToLines([
    item('This is the first line of the para-', 10, 700),
    item('graph that continues.', 10, 686),
    item('A new paragraph starts here.', 10, 650)
  ]);
  const blocks = groupParagraphs(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'This is the first line of the paragraph that continues.');
  assert.equal(blocks[1].text, 'A new paragraph starts here.');
});

t('侧栏与正文分开，不会被合并成一段', function () {
  const items = [
    item('Body line one continues', 50, 700, 220),
    item('Body line two continues', 50, 686, 220),
    item('Sidebar one', 380, 700, 100),
    item('Sidebar two', 380, 686, 100)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((block) => block.text), [
    'Body line one continues Body line two continues',
    'Sidebar one Sidebar two'
  ]);
});

t('pageBlocks：页眉 + 双栏 + 段落 一次跑通', function () {
  const items = [
    item('Journal Header 2026', 10, 820),
    item('Left one is a sentence.', 50, 700),
    item('Left two continues it.', 50, 686),
    item('Right one is another column.', 320, 700),
    item('Right two continues that.', 320, 686)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((block) => block.text), [
    'Left one is a sentence. Left two continues it.',
    'Right one is another column. Right two continues that.'
  ]);
});

t('印刷版目录：标题与页码水平错位也能配对', function () {
  const items = [
    { str: 'PACIFIC REGION', transform: [1, 0, 0, 1, 185, 458], width: 100 },
    { str: '11', transform: [1, 0, 0, 1, 550, 459], width: 12 },
    { str: 'Tides / Wave Formation', transform: [1, 0, 0, 1, 185, 355], width: 150 },
    { str: '15', transform: [1, 0, 0, 1, 550, 356], width: 12 },
    { str: 'Momotombo volcano crater before the', transform: [1, 0, 0, 1, 185, 300], width: 220 },
    { str: '2015', transform: [1, 0, 0, 1, 550, 301], width: 20 }
  ];
  const entries = parsePrintedToc(items, { maxPage: 165 });
  assert.deepEqual(entries, [
    { title: 'PACIFIC REGION', page: 11 },
    { title: 'Tides / Wave Formation', page: 15 }
  ]);
});

t('跨页页眉页脚：整行重复被识别并过滤，正文里的单字不受影响', function () {
  const pages = [1, 2, 3].map((i) => ({
    height: 842,
    items: [
      { str: 'Journal of Testing 2026', transform: [1, 0, 0, 1, 40, 810] },
      { str: 'Year', transform: [1, 0, 0, 1, 40, 800] },
      { str: 'Body text line ' + i, transform: [1, 0, 0, 1, 50, 400] }
    ]
  }));
  const repeats = findRepeatedBandTexts(pages);
  assert.deepEqual(repeats, ['Journal of Testing #']);
  const blocks = pageBlocks({ items: pages[0].items }, { width: 595, height: 842 }, { dropTexts: repeats });
  assert.deepEqual(blocks.map((b) => b.text), ['Body text line 1']);
});

t('栏目横幅与标题同行时只去掉前缀', function () {
  const blocks = pageBlocks({
    items: [
      { str: 'OPEN', transform: [1, 0, 0, 1, 40, 780] },
      { str: 'Single dose creatine improves', transform: [1, 0, 0, 1, 90, 780] },
      { str: 'Body line', transform: [1, 0, 0, 1, 50, 400] }
    ]
  }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((b) => b.text), ['Single dose creatine improves', 'Body line']);
});

t('项目符号另起一段', function () {
  const items = [
    item('Reviewers:', 50, 700),
    item('• Alice - University A, reviewer', 50, 686),
    item('• Bob - University B, reviewer', 50, 672)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((b) => b.text), [
    'Reviewers:',
    '• Alice - University A, reviewer',
    '• Bob - University B, reviewer'
  ]);
});

t('LaTeX base64 垃圾从文本里剔除，公式位置留占位', function () {
  const items = [
    item('<latexitsha1_base64="AbC+/==">', 50, 700, 200),
    item('</latexit>', 250, 700, 50),
    item('1. Local Feature CNN', 50, 686, 150)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((b) => b.text), ['[公式] 1. Local Feature CNN']);
  assert.equal(stripLatexArtifacts('x ' + 'A'.repeat(80) + ' y'), 'x [公式] y');
});

t('超长块按句末标点切开', function () {
  const text = ('句子。'.repeat(400));
  const parts = splitLongText(text, 500);
  assert.ok(parts.length > 2);
  assert.ok(parts.every((part) => part.length <= 500));
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => part.endsWith('。')));
});

t('跨栏标题下的 4 栏按列顺序输出，不被标题粘成一片', function () {
  const items = [{ str: 'A Very Wide Title Across Columns', transform: [1, 0, 0, 1, 54, 900], width: 500, height: 30 }];
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      items.push({ str: 'C' + c + 'L' + r, transform: [1, 0, 0, 1, 54 + c * 174, 700 - r * 14], width: 100, height: 12 });
    }
  }
  const blocks = pageBlocks({ items: items }, { width: 792, height: 1080 });
  assert.deepEqual(blocks.map((block) => block.text), [
    'A Very Wide Title Across Columns',
    'C0L0 C0L1 C0L2 C0L3',
    'C1L0 C1L1 C1L2 C1L3',
    'C2L0 C2L1 C2L2 C2L3',
    'C3L0 C3L1 C3L2 C3L3'
  ]);
});

t('左右栏间距只有 12pt 时也不会被拼成一句', function () {
  const items = [];
  for (let r = 0; r < 6; r += 1) {
    items.push(item('Left line ' + r + ' continues the sentence.', 50, 700 - r * 14, 166));
    items.push(item('Right line ' + r + ' is separate.', 228, 700 - r * 14, 162));
  }
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].text.startsWith('Left line 0'));
  assert.ok(!blocks[0].text.includes('Right'));
  assert.ok(blocks[1].text.startsWith('Right line 0'));
});

t('同一栏内被 justified 间隙拆开的碎片会拼回一行', function () {
  const items = [
    { str: 'submerged', transform: [1, 0, 0, 1, 54, 700], width: 55.992, height: 12 },
    { str: 'natural', transform: [1, 0, 0, 1, 121.992, 700], width: 37.3, height: 12 },
    { str: 'heritage.', transform: [1, 0, 0, 1, 171.337, 700], width: 44.664, height: 12 }
  ];
  for (let r = 1; r < 6; r += 1) items.push(item('continuation ' + r, 54, 700 - r * 14, 162));
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.ok(blocks[0].text.startsWith('submerged natural heritage.'));
});

t('表格按单元格拆开，正文不跨过表格合并', function () {
  const items = [
    item('Table 1: results', 50, 760, 100),
    item('Name', 50, 700, 30), item('Qty', 200, 700, 20), item('Price', 350, 700, 30),
    item('Alice', 50, 680, 30), item('2', 200, 680, 5), item('10.00', 350, 680, 30),
    item('Bob', 50, 660, 20), item('5', 200, 660, 5), item('25.00', 350, 660, 30),
    item('After the table, body text resumes.', 50, 600, 200),
    item('A footnote marker[1] stays out of the sentence.', 50, 560, 250)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.deepEqual(blocks.filter((block) => block.kind === 'table-cell').map((block) => block.text), [
    'Name', 'Qty', 'Price', 'Alice', '2', '10.00', 'Bob', '5', '25.00'
  ]);
  assert.deepEqual(blocks.filter((block) => block.kind !== 'table-cell').map((block) => block.text), [
    'Table 1: results',
    'After the table, body text resumes.',
    'A footnote marker stays out of the sentence.'
  ]);
});

t('只有公式占位的块标记为不翻译', function () {
  const blocks = pageBlocks({
    items: [
      { str: '<latexitsha1_base64="AbC+/==">', transform: [1, 0, 0, 1, 50, 700], width: 200, height: 12 },
      item('Body text follows after the formula.', 50, 640, 200)
    ]
  }, { width: 595, height: 842 });
  assert.equal(blocks[0].text, '[公式]');
  assert.equal(blocks[0].noTranslate, true);
  assert.equal(blocks[1].noTranslate, false);
  assert.equal(isFormulaOnly('[公式]'), true);
  assert.equal(isFormulaOnly('[公式] 正文'), false);
});

t('脚注标记与 Unicode 上标从正文剥离', function () {
  assert.equal(stripFootnoteMarkers('Text[1] more[2,3].'), 'Text more.');
  assert.equal(stripFootnoteMarkers('结论¹ 很重要。'), '结论 很重要。');
  const blocks = pageBlocks({
    items: [item('A sentence with a marker[4].', 50, 700, 200)]
  }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((block) => block.text), ['A sentence with a marker.']);
});

t('长块阈值集中管理，默认值与阅读器提示共用', function () {
  assert.equal(splitLongText('a'.repeat(PDF_LONG_BLOCK_LIMIT)).length, 1);
  assert.ok(splitLongText('句子。'.repeat(Math.ceil(PDF_LONG_BLOCK_LIMIT / 3) + 1)).length > 1);
});

t('印刷版目录页保持「标题 + 页码」成对，不被当成双栏', function () {
  const items = Array.from({ length: 6 }, (_, i) => item(
    'Chapter ' + (i + 1) + ' ......... ' + ((i + 1) * 5),
    50,
    760 - i * 14,
    300
  ));
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.equal(blocks.length, 6);
  assert.ok(blocks[0].text.startsWith('Chapter 1'));
  assert.ok(blocks[0].text.endsWith('5'));
  assert.ok(blocks[5].text.startsWith('Chapter 6'));
  assert.ok(blocks[5].text.endsWith('30'));
});

t('目录标题换行并回同一条，页码仍留在条目末尾', function () {
  const items = [
    item('Water Resources Planning and Management:', 50, 760, 220),
    item('An Overview ......... 1', 50, 746, 220),
    item('1.1 Introduction ......... 1', 50, 732, 220),
    item('1.2 Planning and Management Issues: Some Case', 50, 718, 300),
    item('Studies ......... 2', 50, 704, 200),
    item('1.3 Why Plan ......... 3', 50, 690, 200),
    item('1.4 Conclusion ......... 4', 50, 676, 200)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.deepEqual(blocks.map((block) => block.text), [
    'Water Resources Planning and Management: An Overview......... 1',
    '1.1 Introduction......... 1',
    '1.2 Planning and Management Issues: Some Case Studies......... 2',
    '1.3 Why Plan......... 3',
    '1.4 Conclusion......... 4'
  ]);
});

t('目录页左侧章编号不会被粘到 Contents 上', function () {
  const items = [
    item('Contents', 150, 760, 80),
    item('1', 150, 746, 5),
    item('Water Resources Planning and Management:', 170, 746, 260),
    item('An Overview ......... 1', 170, 732, 240),
    item('1.1 Introduction ......... 1', 170, 718, 240),
    item('1.2 Planning ......... 2', 170, 704, 240),
    item('1.3 Why Plan ......... 3', 170, 690, 240),
    item('1.4 Conclusion ......... 4', 170, 676, 240)
  ];
  const blocks = pageBlocks({ items: items }, { width: 595, height: 842 });
  assert.equal(blocks[0].text, 'Contents');
  assert.equal(blocks[1].text, '1 Water Resources Planning and Management: An Overview......... 1');
  assert.ok(blocks.slice(2).every((block) => !block.text.startsWith('Contents')));
});

t('复杂页检测覆盖「块太大」和「碎块太多」两种情况', function () {
  assert.equal(isComplexPage([{ text: 'x'.repeat(PDF_LONG_BLOCK_LIMIT + 1) }]), true);
  assert.equal(isComplexPage(Array.from({ length: 40 }, () => ({ text: 'short' }))), true);
  assert.equal(isComplexPage(Array.from({ length: 40 }, () => ({ text: 'short', kind: 'toc' }))), false);
  assert.equal(isComplexPage(Array.from({ length: 40 }, () => ({ text: 'short', kind: 'table-cell' }))), false);
  assert.equal(isComplexPage([{ text: 'A normal paragraph.' }]), false);
});
// ---- 0.16 QA：文本层静默丢正文（H1–H22）的回归
const it = (str, x, y, size = 10, width) => ({ str, transform: [size, 0, 0, size, x, y], width: width == null ? str.length * size * 0.5 : width, height: size });
const A4 = { width: 595, height: 842 };
const textsOf = (blocks) => blocks.map((b) => b.text);

t('H1 跨页页眉只在上下边带里删除，页面中部以页眉开头的正文保留', function () {
  const pages = [1, 2, 3, 4].map((p) => ({ height: 842, items: [it('Smith et al.', 72, 800, 9), it('Table ' + p, 72, 760), it('Body text of page ' + p + ' goes here.', 72, 500)] }));
  const dropTexts = findRepeatedBandTexts(pages);
  const out = textsOf(pageBlocks({ items: [it('Smith et al.', 72, 800, 9), it('Table 3 shows that the treated group improved by twelve points,', 72, 500), it('while the control group stayed flat.', 72, 488), it('Smith et al. (2019) reported the same effect in adults.', 72, 460)] }, A4, { dropTexts }));
  assert.ok(out.join(' ').includes('Table 3 shows'));
  assert.ok(out.join(' ').includes('Smith et al. (2019)'));
  assert.ok(!out.includes('Smith et al.'));
});

t('H1 每页开头相同的正文不会被学成页眉（只看最外侧几行）', function () {
  const pages = [1, 2, 3].map((p) => ({ height: 842, items: [it('Journal of Testing ' + p, 72, 812, 8), ...['First body line', 'Second body line', 'Third body line', 'Fourth body line'].map((s, i) => it(s + ' repeated on every page.', 72, 780 - i * 14))] }));
  assert.deepEqual(findRepeatedBandTexts(pages), ['Journal of Testing #', 'First body line repeated on every page.', 'Second body line repeated on every page.']);
});

t('H2 单栏页的居中标题 / 作者行不生成假栏，段尾不被挪到页末', function () {
  const out = textsOf(pageBlocks({ items: [it('Robust Estimation Of Layout Order', 250, 760, 14), it('Alice Author, Bob Writer', 260, 740), it('The first paragraph runs across the full text width of this page and', 72, 700), it('ends here.', 72, 688), it('The second paragraph also runs across the full text width of the page', 72, 664), it('and ends here too.', 72, 652)] }, A4));
  assert.equal(out[0], 'Robust Estimation Of Layout Order');
  assert.ok(out.some((s) => s.endsWith('and ends here.')));
  assert.ok(out[out.length - 1].endsWith('and ends here too.'));
});

t('H3/H4 上下标保留在正文里并保持一行', function () {
  const a = textsOf(pageBlocks({ items: [it('The 21', 72, 700, 12, 33), it('st', 105, 704, 8, 7), it(' century: 10', 112, 700, 12, 60), it('6', 172, 704, 8, 4), it(' users, 25 km', 176, 700, 12, 70), it('2', 246, 704, 8, 4), it('.', 250, 700, 12, 3), it('Water is H', 72, 680, 12, 58), it('2', 130, 676, 7, 4), it('O.', 134, 680, 12, 12)] }, A4));
  assert.deepEqual(a, ['The 21st century: 10⁶ users, 25 km². Water is H₂O.']);
  const b = textsOf(pageBlocks({ items: [it('The rate was 10', 72, 700, 11, 75), it('-3', 147, 704.4, 9.2, 8), it(' s', 155, 700, 11, 8), it('-1', 163, 704.4, 9.2, 8), it(' and x', 171, 700, 11, 28), it('2', 199, 704.4, 9.2, 5), it(' grew.', 204, 700, 11, 30), it('Next line of the same paragraph continues normally here.', 72, 686, 11)] }, A4));
  assert.deepEqual(b, ['The rate was 10⁻³ s⁻¹ and x² grew. Next line of the same paragraph continues normally here.']);
});

t('H5/H6 单位、指数、同位素、区间、下标不是脚注；真正的引用仍剥离', function () {
  assert.equal(stripFootnoteMarkers('The flat is 50 m², 10⁶ cells, E = mc², the ¹⁴C isotope, Ca²⁺ ions.'), 'The flat is 50 m², 10⁶ cells, E = mc², the ¹⁴C isotope, Ca²⁺ ions.');
  assert.equal(stripFootnoteMarkers('Inputs are scaled to [0, 1]; the code reads a[0] and b[10]; kernel [3, 3].'), 'Inputs are scaled to [0, 1]; the code reads a[0] and b[10]; kernel [3, 3].');
  assert.equal(stripFootnoteMarkers('The effect¹² was large [4, 5]. As shown.³'), 'The effect was large. As shown.');
});

t('H7/H11 正文里的 open / Letter / Article / Vol. 2 / 第2期 不被当横幅或卷期行', function () {
  const out = textsOf(pageBlocks({ items: [it('To finish the setup, download the archive and then', 72, 700), it('open the settings panel and choose Extensions from the list.', 72, 688), it('Letter grades are assigned at the end of the term.', 72, 664), it('Vol. 2 of the series covers the medieval period.', 72, 760), it('第2期工程计划于2025年完工，总投资约三亿元。', 72, 740, 12)] }, A4)).join(' ');
  assert.ok(/then open the settings/.test(out));
  assert.ok(/Letter grades/.test(out));
  assert.ok(/Vol\. 2 of the series/.test(out));
  assert.ok(out.includes('第2期工程'));
  const header = textsOf(pageBlocks({ items: [it('Vol. 12, No. 3', 72, 820, 8), it('第 12 卷 第 3 期', 300, 810, 8), it('OPEN', 40, 780), it('Body line here.', 72, 400)] }, A4));
  assert.deepEqual(header, ['Body line here.']);
});

t('H8 窄页边距的首末行正文保留，页码和小字页眉仍去掉', function () {
  const items = [];
  for (let i = 0; i < 6; i += 1) items.push(it('Body line ' + (i + 1) + ' of a page with 0.5 inch margins.', 36, 797 - i * 150, 11));
  const out = textsOf(pageBlocks({ items }, A4)).join(' ');
  assert.ok(out.includes('Body line 1') && out.includes('Body line 6'));
  const noise = textsOf(pageBlocks({ items: [it('Journal header in small print', 72, 825, 7), it('A body paragraph line.', 72, 700, 11), it('Another body line.', 72, 686, 11), it('12', 290, 20, 11)] }, A4));
  assert.deepEqual(noise, ['A body paragraph line. Another body line.']);
});

t('H9 数学「. . .」双栏页不是目录', function () {
  const L = ['Let x1, . . . , xn be samples', 'and y1, . . . , yn their labels.', 'For i = 1, . . . , n define', 'weights w1, . . . , wk and', 'sum r1 + . . . + rn as risk.', 'This is the usual objective.'];
  const R = ['Assumption 1 bounds moments,', 'which holds in practice.', 'Assumption 2 is a margin', 'condition near the boundary.', 'Both give the optimal rate', 'shown in Section 4.'];
  const blocks = pageBlocks({ items: [...L.map((s, i) => it(s, 50, 700 - i * 12)), ...R.map((s, i) => it(s, 310, 700 - i * 12))] }, A4);
  assert.ok(blocks.every((b) => b.kind !== 'toc'));
  assert.equal(blocks.length, 2);
  assert.ok(blocks[1].text.startsWith('Assumption 1'));
});

t('H10/H19/H20 1.5 倍行距不一行一段；中文折行不插空格；复合词保留连字符', function () {
  const out = textsOf(pageBlocks({ items: [it('本文采用一点五倍行距排版，这是学位论文最常见的格式要求，句子会跨行继', 72, 700, 12), it('续，翻译单元必须保持完整。', 72, 676.6, 12), it('Double-spaced manuscripts put 24 pt between baselines, so this', 72, 600, 12), it('sentence is split into two translation units.', 72, 576, 12)] }, A4));
  assert.equal(out.length, 2);
  assert.ok(out[0].includes('跨行继续'));
  assert.deepEqual(textsOf(pageBlocks({ items: [it('The method is well-', 72, 700), it('known and self-', 72, 688), it('supervised. A hyphen-', 72, 676), it('ated word.', 72, 664)] }, A4)), ['The method is well-known and self-supervised. A hyphenated word.']);
});

t('短段落居多的页面按段间距分段，不并成整页一段（0.17.1 第四幕第 2 页）', function () {
  // 实测间距序列：行内 18.1pt × 10，段间 34.8pt × 16；中位数落在段间距上时整页曾合成 1 段。
  const gaps = [18.1, 34.8, 18.1, 34.8, 18.1, 34.8, 18.1, 34.8, 18.1, 34.8, 34.8, 18.1, 18.1, 34.8, 34.8, 34.8, 34.8, 18.1, 34.8, 18.1, 18.1, 34.8, 34.8, 34.8, 34.8, 18.1];
  let y = 780;
  const lines = [{ text: '“夏弥、明非、子航！”', y, x0: 36, x1: 550, size: 11.14 }];
  gaps.forEach((gap, i) => { y -= gap; lines.push({ text: '第' + (i + 2) + '行文字。', y, x0: 36, x1: 550, size: 11.14 }); });
  const blocks = groupParagraphs(lines);
  assert.equal(blocks.length, gaps.filter((g) => g > 30).length + 1);
  // 少数几处紧密行距（同字号的两行标题）不会让 1.5 倍行距正文一行一段：结果与原中位数规则相同
  const mostlyNormal = [{ text: '标题', y: 700, x0: 72, x1: 300, size: 12 }, { text: '副标题', y: 690, x0: 72, x1: 300, size: 12 }];
  for (let i = 0; i < 8; i += 1) mostlyNormal.push({ text: '一点五倍行距的正文第' + i + '行', y: 666 - i * 23.4, x0: 72, x1: 500, size: 12 });
  assert.equal(groupParagraphs(mostlyNormal).length, 1);
});

t('H12 十六进制哈希和 DNA 序列不当成 base64 公式', function () {
  assert.equal(stripLatexArtifacts('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  assert.equal(stripLatexArtifacts('ATGGCTAGCTAGGCTTACGATCGATCGGCTAGCTAGCTTAGGCTAGCATCGATCGATGCTAGCTAG'), 'ATGGCTAGCTAGGCTTACGATCGATCGGCTAGCTAGCTTAGGCTAGCATCGATCGATGCTAGCTAG');
  assert.equal(stripLatexArtifacts('x AAAB7HicbVBNS8NAEJ3Ur1q/oh69BIvgqSQi6LHoxWMF+wFtKJvtpl262ZZAAAB7HicbVBNS8NAEJ y'), 'x [公式] y');
});

t('H14 双栏页底部的跨栏图注留在最后', function () {
  const items = [];
  for (let i = 0; i < 6; i += 1) items.push(it('Left column sentence ' + (i + 1) + ' goes on.', 50, 760 - i * 12));
  for (let i = 0; i < 6; i += 1) items.push(it('Right column sentence ' + (i + 1) + ' goes on.', 310, 760 - i * 12));
  items.push(it('Figure 4: full-width caption printed at the BOTTOM of the page under both columns.', 50, 300));
  const out = textsOf(pageBlocks({ items }, A4));
  assert.ok(out[0].startsWith('Left column'));
  assert.ok(out[out.length - 1].startsWith('Figure 4'));
});

t('H16/H17 假粗体去重；首字下沉拼回；单字中文标题保留', function () {
  assert.deepEqual(textsOf(pageBlocks({ items: [it('Chapter Summary', 72, 700, 14), it('Chapter Summary', 72.3, 700, 14)] }, A4)), ['Chapter Summary']);
  const out = textsOf(pageBlocks({ items: [it('T', 72, 676, 36, 22), it('he history of the valley begins long before', 98, 700), it('the first settlers arrived in the region.', 98, 688), it('序', 280, 600, 20), it('本书的写作始于十年前的一次旅行。', 72, 560, 12)] }, A4));
  assert.ok(out[0].startsWith('The history'));
  assert.ok(out.includes('序'));
});

t('H21 目录标题去掉点线，以数字结尾的标题保留', function () {
  const items = [it('1 Introduction', 72, 700, 11), it('. . . . . . . . . . . . . . .', 160, 700, 11), it('1', 520, 700, 11), it('2 Migrating to Windows 10', 72, 682, 11), it('15', 520, 682, 11), it('3 Python 3', 72, 664, 11), it('29', 520, 664, 11), it('4 Results', 72, 646, 11), it('43', 520, 646, 11)];
  assert.deepEqual(parsePrintedToc(items, { maxPage: 300, pageWidth: 595 }), [{ title: '1 Introduction', page: 1 }, { title: '2 Migrating to Windows 10', page: 15 }, { title: '3 Python 3', page: 29 }, { title: '4 Results', page: 43 }]);
});

t('H22 长文本硬切不拆代理对', function () {
  const parts = splitLongText('A'.repeat(1499) + '😀' + 'B'.repeat(200));
  assert.ok(!/[\uD800-\uDBFF]$/.test(parts[0]));
  assert.equal(parts.join(''), 'A'.repeat(1499) + '😀' + 'B'.repeat(200));
});

console.log('\n' + pass + ' 通过 / ' + (pass + fail) + ' 总数');
if (fail) process.exit(1);
