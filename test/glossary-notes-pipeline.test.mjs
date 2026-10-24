// Real background + storage + provider, fake model only. Expected translations are
// authored fixtures, not evidence that a paid model can disambiguate these words.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { makeArea } from './_fake-storage.mjs';
const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/glossary-context-samples.json', import.meta.url), 'utf8'));
const local = makeArea({ clone: true });
const session = makeArea({ clone: true });
let listener;
globalThis.chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  runtime: { onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => ({}), openOptionsPage() {} },
  tabs: { onRemoved: { addListener() {} }, sendMessage: async () => {}, query: async () => [] },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} }, removeAll(fn) { if (fn) fn(); }, create() {} },
  scripting: { executeScript: async () => [], insertCSS: async () => {} }
};
await local.set({ config: {
  _v: 7, currentProvider: 'deepseek', providerConfig: { deepseek: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'mock-key', model: 'fake' } },
  targetLang: 'zh-CN', professionalProfile: 'general', professionalOptions: { quality: 'balanced', maxReviewRequests: 1 }, thinkingMode: 'auto', glossary: []
} });
let calls = [];
let respond = texts => texts.map(() => '模拟译文。');
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const texts = JSON.parse(body.messages[1].content);
  calls.push({ body, texts });
  return Response.json({ choices: [{ message: { content: JSON.stringify(respond(texts, body.messages[0].content)) }, finish_reason: 'stop' }] });
};
await import('../background.js');
const { saveConfig, getConfig, pickImportedConfig } = await import('../lib/config.js');
const { mergeGlossaryEntries } = await import('../lib/glossary.js');
const send = (type, extra = {}) => new Promise(resolve => listener({ type, ...extra }, { url: 'https://notes.example/article' }, resolve));
const translate = (texts, extra) => send('translate', { texts, target: 'zh-CN', ...extra });

test('notes are present in the original request and cannot add a second request', async () => {
  assert.equal(corpus.method, 'mock');
  await saveConfig({ glossary: corpus.terms });
  const contexts = corpus.terms.flatMap(term => term.contexts);
  respond = texts => texts.map(text => contexts.find(context => context.text === text).expected);
  calls = [];
  const result = await translate(contexts.map(context => context.text));
  assert.equal(calls.length, 1);
  assert.deepEqual(result.results, contexts.map(context => context.expected));
  for (const term of corpus.terms) {
    const dataLine = calls[0].body.messages[0].content.split('\n').find(line => line.startsWith('[{"source"'));
    assert.equal(JSON.parse(dataLine).find(one => one.source === term.source).note, term.note);
  }
  assert.match(calls[0].body.messages[0].content, /唯一目标语言：简体中文/);
});

test('note edits invalidate matching text only; category and unrelated edits keep caches', async () => {
  const term = { source: 'response', target: '治疗反应', note: 'initial context' };
  await saveConfig({ glossary: [term] });
  respond = texts => texts.map(() => '缓存测试译文。');
  const texts = ['A response in a unique cache experiment.', 'A quiet afternoon in a unique cache experiment.'];
  calls = [];
  await translate(texts);
  assert.equal(calls.length, 1);
  await saveConfig({ glossary: [{ ...term, note: 'new context' }] });
  await translate(texts);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].texts, [texts[0]]);
  await saveConfig({ glossary: [{ ...term, category: 'other', note: 'new context' }, { source: 'cell', target: '细胞', note: 'unused context' }] });
  const cached = await translate(texts);
  assert.equal(cached.cached, 2);
  assert.equal(calls.length, 2);
});

test('one-click add/overwrite and medical exclusion retain contextual user priority', async () => {
  const term = { source: 'odds ratio', target: '用户译法', category: '医学', note: '仅统计语境适用。' };
  await saveConfig({ professionalProfile: 'medical', glossary: [term] });
  const conflict = await send('glossary:add', { source: term.source, target: '用户新译法' });
  assert.equal(conflict.action, 'conflict');
  const overwritten = await send('glossary:add', { source: term.source, target: '用户新译法', overwrite: true });
  assert.equal(overwritten.action, 'updated');
  assert.deepEqual((await getConfig()).glossary[0], { ...term, target: '用户新译法' });
  calls = [];
  await translate(['The odds ratio was discussed in a unique experiment.']);
  assert.equal(calls.length, 1);
  const system = calls[0].body.messages[0].content;
  assert.match(system, /用户新译法/);
  assert.ok(!system.includes('odds ratio → 比值比'));
  assert.match(system, /医学专业翻译要求/);
});

test('storage rejects oversized notes atomically; old config and cached data survive', async () => {
  await session.set({ 'notes-test-cache-sentinel': 'preserved' });
  const before = (await local.get('config')).config;
  await assert.rejects(saveConfig({ glossary: [{ source: 'bad', target: '错误', note: '中'.repeat(501) }], providerConfig: { deepseek: { apiKey: 'should-not-write' } } }), /超过 500/);
  assert.deepEqual((await local.get('config')).config, before);
  assert.equal((await session.get('notes-test-cache-sentinel'))['notes-test-cache-sentinel'], 'preserved');
  const note = before.glossary[0].note;
  const parsed = pickImportedConfig({ app: 'rimefox', schema: 1, config: { targetLang: 'zh-CN', mode: 'dual', theme: 'underline', glossary: [{ source: 'odds ratio', target: '更新首选译法' }] } });
  await saveConfig({ ...parsed.config, glossary: mergeGlossaryEntries(before.glossary, parsed.config.glossary, { replace: true, noteUpdates: parsed.glossaryNoteUpdates }) });
  assert.equal((await getConfig()).glossary[0].note, note);
  const exported = JSON.parse(JSON.stringify({ app: 'rimefox', schema: 1, config: await getConfig() }));
  assert.equal(pickImportedConfig(exported).config.glossary[0].note, note);
  await saveConfig({ glossary: [{ source: 'odds ratio', target: '更新首选译法', note: '' }] });
  assert.equal((await getConfig()).glossary[0].note, undefined);
});
