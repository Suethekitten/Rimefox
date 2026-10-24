import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { INLINE_VERSION, inspectInline } from '../lib/inline.js';
import { systemPrompt } from '../lib/prompt.js';

test('one implementation runs as both a classic content script and an ESM dependency', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../lib/inline-protocol.js', import.meta.url), 'utf8'), context);
  assert.equal(INLINE_VERSION, 'v1');
  const cases = [
    ['Hello <f1>beautiful</f1> world.', '你好，<f1>美丽的</f1>世界。'],
    ['<k1></k1> <f1>hello</f1>', '<k1></k1> 你好'],
    ['<f1>first</f1> <f2>second</f2>', '<f2>第二</f2> <f1>第一</f1>'],
    ['<f1>first</f1>', '<f2>第一</f2>'],
    ['<k1>brand</k1>', '<k1>品牌</k1>']
  ];
  for (const args of cases) {
    assert.deepEqual(JSON.parse(JSON.stringify(context.__RimefoxInline.inspect(...args))), inspectInline(...args));
  }
});

test('semantic ranges use visible stripped coordinates and preserve canonical k markers', () => {
  const result = inspectInline('Hello <f1>beautiful</f1> <k1>Rimefox</k1>.', '你好，<f1>美丽的</f1><k1>Rimefox</k1>。');
  assert.equal(result.ok, true);
  assert.equal(result.clean, '你好，美丽的<k1>Rimefox</k1>。');
  assert.equal(result.text, '你好，美丽的Rimefox。');
  assert.equal(result.stripped, '你好，美丽的。');
  assert.deepEqual(result.ranges, [{ id: 1, start: 3, end: 6, parent: null }]);
  assert.deepEqual(result.atoms, [{ id: 1, text: 'Rimefox', start: 6, end: 13, at: 6 }]);
});

test('empty protected atoms and translated labels retain separate semantics', () => {
  const source = 'Read <k1><f1>documentation</f1></k1> for <k2></k2>.';
  const result = inspectInline(source, '请为<k2></k2>阅读<k1><f1>文档</f1></k1>。');
  assert.equal(result.ok, true);
  assert.deepEqual(result.atoms.map(x => [x.id, x.text]), [[2, ''], [1, '文档']]);
  assert.deepEqual(result.ranges, [{ id: 1, start: 4, end: 4, parent: 'k1' }]);
  assert.equal(result.stripped, '请为阅读。');
  assert.equal(inspectInline(source, '请为<k2>secret</k2>阅读<k1><f1>文档</f1></k1>。').reason, 'changed-atom');
});

test('complete semantic subtrees may reorder while preserving every parent relationship', () => {
  const source = '<f1>first <f2>nested</f2></f1> and <f3>second</f3><k1>[1]</k1>';
  assert.equal(inspectInline(source, '<k1>[1]</k1><f3>第二</f3>和<f1>第一<f2>嵌套</f2></f1>').ok, true);
  assert.equal(inspectInline(source, '<f2>第一<f1>嵌套</f1></f2>和<f3>第二</f3><k1>[1]</k1>').reason, 'changed-parent');
});

test('missing, duplicate, forged, crossing and escaped markers fail closed', () => {
  const source = 'A <f1>bold</f1> <f2>italic</f2> <k1>[8]</k1>.';
  const failures = [
    ['<f1>粗</f1><k1>[8]</k1>', 'missing-marker'],
    ['<f1>粗</f1><f1>重</f1><f2>斜</f2><k1>[8]</k1>', 'duplicate-marker'],
    ['<f1>粗</f1><f2>斜</f2><k8>[8]</k8>', 'unknown-marker'],
    ['<f1>粗<f2>斜</f1></f2><k1>[8]</k1>', 'marker-nesting'],
    ['<f1>粗</f1><f2>斜</f2>', 'missing-marker'],
    ['<f1>粗</f1><f2>斜</f2><k1>[9]</k1>', 'changed-atom'],
    ['<f1>粗</f1><f2>斜</f2><k1/>', 'malformed-marker'],
    ['<f1>粗</f1><f2>斜</f2><K1>[8]</K1>', 'malformed-marker'],
    ['&lt;f1&gt;粗&lt;/f1&gt;<k1>[8]</k1>', 'escaped-marker'],
    ['<f1></f1><f2>斜</f2><k1>[8]</k1>', 'empty-format']
  ];
  for (const [target, reason] of failures) {
    const result = inspectInline(source, target);
    assert.equal(result.ok, false, target);
    assert.equal(result.reason, reason, target);
    assert.equal(result.text, '', 'a failed parse must not expose a partly accepted translation');
  }
});

test('immutable atom bytes outside an explicit label f cannot change or reorder', () => {
  const source = '<k1>See <f1>documentation</f1> now</k1>';
  assert.equal(inspectInline(source, '<k1>See <f1>文档</f1> now</k1>').ok, true);
  assert.equal(inspectInline(source, '<k1>Read <f1>文档</f1> now</k1>').reason, 'changed-atom');
  assert.equal(inspectInline(source, '<k1><f1>文档</f1></k1>').reason, 'changed-atom');
});

test('omitting every f permits uncached plain fallback only with complete compatible k atoms', () => {
  const source = '<f1>Read</f1> <k1><f2>documentation</f2></k1> for <k2></k2>.';
  const result = inspectInline(source, '请为<k2></k2>阅读<k1>文档</k1>。');
  assert.equal(result.ok, true);
  assert.equal(result.formatMissing, true);
  assert.deepEqual(result.ranges, []);
  assert.equal(result.atoms.find(x => x.id === 1).text, '文档');
  assert.equal(inspectInline(source, '阅读文档。').ok, false);
  assert.equal(inspectInline('<k1>prefix <f1>label</f1></k1>', '<k1>文档</k1>').reason, 'missing-atom-format');
});

test('model invented HTML is rejected while source literal HTML remains inert text', () => {
  const result = inspectInline('A <f1>word</f1>', '<script>alert(1)</script> <f1>文字</f1>');
  assert.equal(result.reason, 'markup-leak');
  const literal = inspectInline('Explain <b> and <script> <f1>tags</f1>', '解释 <b> 和 <script> <f1>标签</f1>');
  assert.equal(literal.ok, true);
  assert.equal(literal.text, '解释 <b> 和 <script> 标签');
  for (const markup of ['<fABC>', '<k>', '<fABC', '&lt;k', '<b>bold</b>', '< fABC >']) {
    assert.equal(inspectInline('A <f1>word</f1>', markup + ' <f1>文字</f1>').ok, false, markup);
  }
  assert.equal(inspectInline('<f1>unclosed', '<f1>文字</f1>').reason, 'source-unclosed-marker');
  assert.equal(inspectInline('<f1>x</f1>', '<f0001>字</f0001>').reason, 'malformed-marker');
});

test('inline prompt is opt in, keeps one target language and describes the sole mutable atom exception', () => {
  const old = systemPrompt('en', 'plain', [], '', false, false, true);
  assert.equal(systemPrompt('en', 'plain', [], '', false, false, true, null, false), old);
  const prompt = systemPrompt('en', 'plain', [], '', false, false, true, null, true);
  assert.equal(prompt.split('\n')[1], '唯一目标语言：English (en)。');
  assert.match(prompt, /JSON 字符串数组/);
  assert.match(prompt, /这是唯一例外/);
  assert.match(prompt, /空标记必须保持为空/);
  assert.match(prompt, /不得交叉嵌套/);
});
