import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, mergeConfig } from '../lib/config.js';
import { pdfCacheIdentity } from '../lib/reader/pdf-cache.js';
import { PdfTranslator } from '../lib/reader/pdf-translate.js';

const base = mergeConfig(DEFAULTS, {
  currentProvider: '__custom__', customProviders: [{ id: '__custom__', name: 'Fake' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: 'https://fake.invalid/v1', model: 'fake', apiKey: 'mock-only' } }
});
const page = { pageNo: 1, blocks: [{ text: 'The same paragraph is translated in different languages.' }] };
const args = { bookId: 'test-book', page, target: 'zh-CN', config: base };

function fixture(reply) {
  const rows = new Map();
  const calls = [];
  const cache = { get: async (key) => rows.get(key), put: async (row) => rows.set(row.key, structuredClone(row)) };
  globalThis.chrome = { runtime: { lastError: null, sendMessage(message, done) {
    calls.push(message);
    Promise.resolve(reply ? reply(message) : { ok: true, results: message.texts.map(() => message.target === 'fr' ? 'Traduction française.' : '中文译文。') }).then(done);
  } } };
  return { rows, calls, cache, translator: new PdfTranslator({ cache }) };
}

test('PDF cache isolates target language and restores the matching cache on switching back', async () => {
  const f = fixture();
  assert.deepEqual(await f.translator.translatePage(args), ['中文译文。']);
  assert.deepEqual(await f.translator.translatePage({ ...args, target: 'fr' }), ['Traduction française.']);
  assert.deepEqual(await new PdfTranslator({ cache: f.cache }).translatePage(args), ['中文译文。']);
  assert.deepEqual(f.calls.map((call) => call.target), ['zh-CN', 'fr']);
  assert.ok([...f.rows.keys()].every((key) => key.startsWith('pdf-v2|')));
  assert.ok(!JSON.stringify([...f.rows.values()]).includes('mock-only'));
});

test('effective configuration changes invalidate PDF cache; UI changes and Key replacement do not', async () => {
  const original = await pdfCacheIdentity(base, 'zh-CN');
  const variants = [
    { providerConfig: { __custom__: { engine: 'anthropic' } } },
    { providerConfig: { __custom__: { baseUrl: 'https://second.invalid/v1' } } },
    { providerConfig: { __custom__: { model: 'other' } } },
    { customPrompt: 'Use formal wording.' },
    { glossary: [{ source: 'paragraph', target: '段落', note: '语境说明' }] },
    { professionalProfile: 'medical' },
    { professionalOptions: { quality: 'strict' } },
    { privacyEnabled: true }, { aiContextEnabled: true }, { temperature: 0.7 },
    { thinkingMode: 'custom', thinkingExtra: '{"seed": 42}' }
  ];
  for (const patch of variants) {
    assert.notEqual(await pdfCacheIdentity(mergeConfig(base, patch), 'zh-CN'), original, JSON.stringify(patch));
  }
  for (const patch of [{ uiTheme: 'dark' }, { mode: 'translation' }, { targetLang: 'fr' },
    { providerConfig: { __custom__: { apiKey: 'replacement', baseUrl: '  https://fake.invalid/v1///  ' } } }]) {
    assert.equal(await pdfCacheIdentity(mergeConfig(base, patch), 'zh-CN'), original);
  }
  assert.notEqual(await pdfCacheIdentity(base, 'zh-CN', 'catgirl'), original);
  const custom = mergeConfig(base, { customLanguages: [{ id: 'cl_test', name: 'Test language', code: 'fr-CA', note: 'Formal' }] });
  assert.notEqual(await pdfCacheIdentity(custom, 'cl_test'), await pdfCacheIdentity(mergeConfig(custom, { customLanguages: [{ ...custom.customLanguages[0], note: 'Casual' }] }), 'cl_test'));
});

test('PDF does not reuse legacy or mismatched source records, even with a matching key', async () => {
  const f = fixture();
  let legacyHash = 0x811c9dc5;
  for (const char of page.blocks[0].text) legacyHash = Math.imul(legacyHash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  f.rows.set('pdf|test-book|page:1|0|' + legacyHash.toString(16).padStart(8, '0'), { translated: '旧译文' });
  await f.translator.translatePage(args);
  const key = [...f.rows.keys()].find((value) => value.startsWith('pdf-v2|'));
  f.rows.set(key, { ...f.rows.get(key), source: 'different source', translated: '错误缓存' });
  assert.deepEqual(await f.translator.translatePage(args), ['中文译文。']);
  assert.equal(f.calls.length, 2);
});

test('stopping while reading cache prevents sending or returning stale text', async () => {
  const f = fixture();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.cache.get = async () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const task = f.translator.translatePage(args);
  await started;
  f.translator.stop();
  release({ translated: '过期译文' });
  assert.equal(await task, null);
  assert.equal(f.calls.length, 0);
});

test('a paused PDF translator does not send a frontend translation message', async () => {
  const f = fixture();
  assert.equal(await f.translator.translatePage({ ...args, config: { ...base, authPaused: true } }), null);
  assert.equal(f.calls.length, 0);
});

test('stopped HTTP responses neither return to the view nor populate PDF cache', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = fixture(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
  const task = f.translator.translatePage(args);
  await started;
  f.translator.stop();
  release({ ok: true, results: ['旧任务译文。'] });
  assert.equal(await task, null);
  assert.equal(f.rows.size, 0);
});

test('a missing long-block slice cannot become a successful cached paragraph', async () => {
  const f = fixture((message) => ({ ok: true, results: message.texts.map((_, i) => i === 0 ? '第一片译文。' : null) }));
  const longPage = { pageNo: 1, blocks: [{ text: 'An example sentence. '.repeat(120) }] };
  assert.deepEqual(await f.translator.translatePage({ ...args, page: longPage }), ['']);
  assert.equal(f.rows.size, 0);
});

test('a failed PDF page request rejects and writes no cache', async () => {
  const f = fixture(() => ({ ok: false, error: '网络失败' }));
  await assert.rejects(() => f.translator.translatePage(args), /网络失败/);
  assert.equal(f.rows.size, 0);
});

test('formula-only blocks are not sent to the translation API', async () => {
  const f = fixture();
  const formulaPage = {
    pageNo: 1,
    blocks: [
      { text: '[公式]', noTranslate: true, kind: 'formula' },
      { text: 'Body text follows the formula.' }
    ]
  };
  const out = await f.translator.translatePage({ ...args, page: formulaPage });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].texts, ['Body text follows the formula.']);
  assert.deepEqual(out, ['', '中文译文。']);
});

test('a failed second batch keeps and caches the paid first batch; retry only sends the rest (QA G4)', async () => {
  let call = 0;
  const f = fixture((message) => {
    call += 1;
    if (call === 2) return { ok: false, error: '第二批失败' };
    return { ok: true, results: message.texts.map((t) => '译:' + t.slice(0, 12)) };
  });
  const blocks = Array.from({ length: 30 }, (_, i) => ({ text: 'Block number ' + i + ' has a sentence of plain body text in it.' }));
  const bigPage = { pageNo: 3, blocks };
  const err = await f.translator.translatePage({ ...args, page: bigPage }).catch((e) => e);
  assert.match(err.message, /第二批失败/);
  const first = f.calls[0].texts.length;
  assert.ok(first > 0 && first < blocks.length);
  assert.equal(err.partial.filter(Boolean).length, first);
  assert.equal(f.rows.size, first);
  const sentBefore = f.calls.length;
  const out = await f.translator.translatePage({ ...args, page: bigPage });
  assert.ok(out.every(Boolean));
  const resent = f.calls.slice(sentBefore).flatMap((m) => m.texts);
  assert.equal(resent.length, blocks.length - first);
});
