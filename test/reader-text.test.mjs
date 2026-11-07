import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTextDocument, decodeText, textFormat, isChapterHeading, TEXT_LIMITS } from '../lib/reader/text.js';
const bytes = text => new TextEncoder().encode(text);
test('TXT preserves literal HTML, paragraphs and line breaks; section IDs survive reopening', () => {
  const input = bytes('First line\r\nSecond line\r\n\r\n<script>alert(1)</script> & more');
  const doc = parseTextDocument(input, { name: 'example.TXT' });
  assert.equal(doc.format, 'txt');
  assert.equal(doc.metadata.title, 'example');
  assert.match(doc.sections[0].load().html, /First line<br\/>Second line/);
  assert.match(doc.sections[0].load().html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
  assert.deepEqual(doc.sections.map(s => s.id), parseTextDocument(input, { name: 'other.txt' }).sections.map(s => s.id));
  assert.equal(textFormat('FILE.MARKDOWN'), 'markdown');
  assert.equal(textFormat('debug.log'), 'txt');
  assert.equal(textFormat('evil.exe'), '');
});
test('UTF-8, UTF-16 BOM and GB18030 decode; empty, binary and oversized files are rejected', () => {
  assert.equal(decodeText(bytes('\ufeff你好')), '你好');
  assert.equal(decodeText(Uint8Array.of(0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59)), '你好');
  assert.equal(decodeText(Uint8Array.of(0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d)), '你好');
  assert.equal(decodeText(Uint8Array.of(0xc4, 0xe3, 0xba, 0xc3)), '你好');
  assert.throws(() => parseTextDocument(bytes(' \n')), e => e.code === 'empty_text');
  assert.throws(() => decodeText(Uint8Array.of(0, 1, 2)), e => e.code === 'invalid_text');
  assert.throws(() => decodeText(new Uint8Array(TEXT_LIMITS.bytes + 1)), e => e.code === 'too_large');
});
test('Markdown renders common blocks, escapes raw HTML, disables remote images and unsafe links', () => {
  const doc = parseTextDocument(bytes('# Example\n\nA **bold** and *italic* paragraph with `code`.\n\n- Item one\n- Item two\n\n> A quote\n\n```js\n<script>bad()</script>\n```\n\n![image](https://example.com/pixel.png)\n\n[unsafe](javascript:alert)\n\n<script>bad()</script>\n\n## Next\n\n[Back](#example)'), { name: 'sample.md' });
  const html = doc.sections.map(s => s.load().html).join('');
  assert.equal(doc.metadata.title, 'Example');
  for (const tag of ['h1', 'strong', 'em', 'code', 'ul', 'li', 'blockquote', 'pre', 'h2']) assert.ok(html.includes('<' + tag), tag);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(doc.resolveHref('#example', doc.sections[1].href).sectionId, doc.sections[0].id);
  assert.equal(doc.toc[1].title, 'Next');
});
test('Long TXT is split into bounded chapters without dropping its content', () => {
  const input = 'a'.repeat(100000);
  const doc = parseTextDocument(bytes(input));
  assert.ok(doc.sections.length > 1);
  const text = doc.sections.map(s => s.load().html.replace(/<[^>]*>/g, '')).join('');
  assert.equal(text, input);
  assert.ok(doc.sections.every(s => s.load().html.length < TEXT_LIMITS.sectionChars + 100));
});

test('Markdown tables remain structured and repeated Unicode heading anchors are unambiguous', () => {
  const doc = parseTextDocument(bytes('# 中文标题\n\n| Item | Value |\n| --- | ---: |\n| **Bold** | `safe` |\n\n# 中文标题\n\nNext'), { name: 'table.md' });
  assert.match(doc.sections[0].load().html, /<table><thead><tr><th>Item<\/th>/);
  assert.match(doc.sections[0].load().html, /<td><strong>Bold<\/strong><\/td><td><code>safe<\/code><\/td>/);
  assert.equal(doc.resolveHref('#' + encodeURIComponent('中文标题-1'), doc.sections[0].href).sectionId, doc.sections[1].id);
  assert.throws(() => parseTextDocument(bytes('line\n'.repeat(TEXT_LIMITS.lines + 1))), e => e.code === 'too_large');
});

test('TXT novels get one section and one TOC entry per chapter heading', () => {
  const input = '书名：示例\n作者：某人\n\n第一卷 风起\n　　开头的一段。\n第一章 初见\n　　他说：“第一章就讲过了。”\n　　第二回合开始\n第二章：重逢\n　　正文。\n\n番外1 后日谈\n　　尾声的话。';
  const doc = parseTextDocument(bytes(input), { name: '示例.txt' });
  assert.deepEqual(doc.toc.map(item => item.title), ['示例', '第一卷 风起', '第一章 初见', '第二章：重逢', '番外1 后日谈']);
  assert.equal(doc.sections.length, 5);
  assert.match(doc.sections[2].load().html, /^<html><body><h2 id="chapter-2">第一章 初见<\/h2><p>　　他说：“第一章就讲过了。”<br\/>　　第二回合开始<\/p>/);
  const target = doc.resolveHref(doc.toc[3].href, doc.sections[0].href);
  assert.equal(target.sectionId, doc.sections[3].id);
  assert.equal(target.fragment, 'chapter-3');
  const text = doc.sections.map(s => s.load().html.replace(/<br\/>/g, '\n').replace(/<[^>]*>/g, '')).join('');
  for (const line of input.split('\n').filter(Boolean)) assert.ok(text.includes(line), line);
});

test('TXT chapter detection stays off for prose look-alikes and a single heading', () => {
  for (const line of ['第一章', '第十二回 宝玉挨打', '第3节：方法', '卷二 江湖', '楔子', '序章 雨夜', '番外二', 'Chapter 12: The Return', 'CHAPTER IV', 'Part II', 'Prologue']) assert.ok(isChapterHeading(line), line);
  for (const line of ['第一章就讲过了。', '第二回合开始', '第一节课结束了', '前言不搭后语', '他翻到了第三章，', 'Chapters are hard', 'Party time', '第一章' + '很'.repeat(60)]) assert.ok(!isChapterHeading(line), line);
  const single = parseTextDocument(bytes('第一章 只有一处\n正文'), { name: 'one.txt' });
  assert.equal(single.sections.length, 1);
  assert.doesNotMatch(single.sections[0].load().html, /<h2/);
  const escaped = parseTextDocument(bytes('第一章 <b>x</b>\n正文\n第二章 & y\n正文'), { name: 'esc.txt' });
  assert.match(escaped.sections[0].load().html, /<h2 id="chapter-1">第一章 &lt;b&gt;x&lt;\/b&gt;<\/h2>/);
  assert.equal(escaped.toc[1].title, '第二章 & y');
});
