// PDF 文本层 → 段落块 的单测：纯函数，不依赖 pdf.js / 浏览器。
// 运行：node test/reader-pdf-text.test.mjs
import assert from 'node:assert/strict';

import { itemsToLines, dropMargins, orderColumns, groupParagraphs, pageBlocks, parsePrintedToc } from '../lib/reader/pdf-text.js';

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

t('不同 y 分成不同行，从上到下', function () {
  const lines = itemsToLines([item('second', 10, 600), item('first', 10, 700)]);
  assert.deepEqual(lines.map((line) => line.text), ['first', 'second']);
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

console.log('\n' + pass + ' 通过 / ' + (pass + fail) + ' 总数');
if (fail) process.exit(1);
