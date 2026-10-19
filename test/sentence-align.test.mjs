// 悬停对照的断句与本地句子对齐（content/units.js）：在 Node 里直接跑内容脚本的纯函数。
//   - 断句：缩写 / 首字母 / 编号 / 小写续接不断，脚注号归前一句，中西混排的半角问号也断
//   - 本地对齐：38 段人工对照语料（中英日法，含合并 / 拆分 / 调换语序 / 引注），每个句界都要对；
//     调换语序的段落必须整段一组（宁可高亮两句，也不配错）
// 运行：node test/sentence-align.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const ctx = { window: { __DT: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('content/units.js', root), 'utf8'), ctx, { filename: 'content/units.js' });
const U = ctx.window.__DT.units;
const corpus = JSON.parse(fs.readFileSync(new URL('test/fixtures/sentence-align-corpus.json', root), 'utf8'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.log('  ✗ ' + name + '\n    ' + String(err && err.message).split('\n').join('\n    '));
  }
}

// vm 里建的数组原型不同，deepStrictEqual 会因原型不同判不等：先过一遍 JSON
const plain = (value) => JSON.parse(JSON.stringify(value));
const sents = (text) => plain(U.sentencesOf(text).map((r) => text.slice(r[0], r[1])));
const shape = (src, tgt) => {
  const a = U.alignLocal(src, null, tgt);
  return a ? plain(a.parts.map((p) => [p.srcTo - p.srcFrom, p.tgtCount])) : null;
};

test('断句：缩写、首字母、编号、小写续接都不断', () => {
  assert.deepEqual(sents('Mr. Smith met Dr. Jones at 5 p.m. on Monday. They left.'), ['Mr. Smith met Dr. Jones at 5 p.m. on Monday.', 'They left.']);
  assert.deepEqual(sents('They talked about the economy, e.g. inflation. Smith et al. (2020) agree.'), ['They talked about the economy, e.g. inflation.', 'Smith et al. (2020) agree.']);
  assert.deepEqual(sents('See Fig. 3 here. I said no. Then I left.'), ['See Fig. 3 here.', 'I said no.', 'Then I left.']);
  assert.deepEqual(sents('J. K. Rowling wrote it. "Really?" she asked.'), ['J. K. Rowling wrote it.', '"Really?" she asked.']);
  assert.deepEqual(sents('1. Introduction'), ['1. Introduction']);
  assert.deepEqual(sents('Wait... then he came. Wait... Then he came.'), ['Wait... then he came.', 'Wait...', 'Then he came.']);
  assert.deepEqual(sents('It was 3.5 in 2019. 2020 was worse. Node.js is great.'), ['It was 3.5 in 2019.', '2020 was worse.', 'Node.js is great.']);
});

test('断句：紧跟句末的脚注号归前一句', () => {
  assert.deepEqual(sents('they were at home.11 Since then, it grew.'), ['they were at home.11', 'Since then, it grew.']);
  assert.deepEqual(sents('Growth was strong.[12] Poverty fell.¹³ It ended.'), ['Growth was strong.[12]', 'Poverty fell.¹³', 'It ended.']);
  assert.deepEqual(sents('2023年增长放缓。[4] 然而通胀仍高。'), ['2023年增长放缓。[4]', '然而通胀仍高。']);
  // 版本号 / 小数不是脚注
  assert.deepEqual(sents('Use v2.11 now. It works.'), ['Use v2.11 now.', 'It works.']);
});

test('断句：中日文与引号规则不变', () => {
  assert.deepEqual(sents('他来了。她走了！真的吗？'), ['他来了。', '她走了！', '真的吗？']);
  assert.deepEqual(sents('「じゃーん。今日は何の日？」「ポッキーの日。」と岩崎が言った。'), ['「じゃーん。今日は何の日？」', '「ポッキーの日。」と岩崎が言った。']);
  assert.deepEqual(sents('“好的。”他说。“走吧！”'), ['“好的。”他说。', '“走吧！”']);
  assert.deepEqual(sents('真的吗?我不知道。'), ['真的吗?', '我不知道。']);
});

test('本地对齐：人工语料的每个句界都对（' + corpus.cases.length + ' 段）', () => {
  const bad = [];
  corpus.cases.forEach((c, i) => {
    const got = shape(c.src, c.tgt);
    if (c.gold === 'any') {
      if (!got) bad.push('#' + i + ' 返回 null');
      return;
    }
    const want = c.gold === 'merge' ? [[U.sentencesOf(c.src).length, U.sentencesOf(c.tgt).length]] : c.gold;
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push('#' + i + ' ' + JSON.stringify(got) + ' ≠ ' + JSON.stringify(want) + '  ' + c.src.slice(0, 40));
  });
  assert.equal(bad.length, 0, bad.join('\n'));
});

test('本地对齐：译文偏移逐字对得上，行界一定是组界', () => {
  const src = 'One. Two.\nThree.';
  const tgt = '一。二。\n三。';
  const a = U.alignLocal(src, null, tgt);
  assert.deepEqual(plain(a.parts.map((p) => tgt.slice(p.tgtFrom, p.tgtTo))), plain(a.parts.map((p) => p.text)));
  assert.deepEqual(plain(a.parts.map((p) => p.text)), ['一。', '二。', '三。']);
  const lines = U.alignLocal('A short line.\nAnother line that is quite a bit longer than the first one.', null, '短行。\n另一行。');
  assert.deepEqual(plain(lines.parts.map((p) => [p.srcFrom, p.srcTo])), [[0, 1], [1, 2]]);
});

test('本地对齐：算不了时返回 null（交给行级 / 段落级），一边只有一句时整段一组', () => {
  assert.equal(U.alignLocal('', null, '译文。'), null);
  assert.deepEqual(shape('One. Two. Three.', '一二三。'), [[3, 1]]);
  // 8 句对 2 句：超过 3 倍，没有可行路径
  let long = '';
  for (let i = 1; i <= 8; i += 1) long += 'Sentence number ' + i + ' is here. ';
  assert.equal(U.alignLocal(long, null, '第一段。\n第二段。'), null);
});

console.log('\n' + (failed ? '✗' : '✓') + ' ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
