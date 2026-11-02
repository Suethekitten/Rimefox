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
console.log('\n' + pass + ' 通过 / ' + (pass + fail) + ' 总数');
if (fail) process.exit(1);
