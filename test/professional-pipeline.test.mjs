// Real background/router/provider code with a fake paid service. This is a mock model test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArea } from './_fake-storage.mjs';

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
  _v: 7, currentProvider: '__custom__',
  customProviders: [{ id: '__custom__', name: 'Mock custom API' }],
  providerConfig: { __custom__: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'mock-only', model: 'fake' } },
  targetLang: 'zh-CN', professionalProfile: 'medical', professionalOptions: { quality: 'balanced', subdomain: 'auto', maxReviewRequests: 1 },
  thinkingMode: 'auto', batchSize: 1, concurrency: 3
} });
let calls = [];
let respond = inputs => inputs.map(() => '39例患者（24.2%）与10例患者（16.2%）。');
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const inputs = JSON.parse(body.messages[1].content);
  const review = typeof inputs[0] === 'object';
  calls.push({ url, body, inputs, review });
  const value = respond(inputs, review);
  if (value === 'HTTP500') return new Response('review failed', { status: 500 });
  if (value === 'LENGTH_EMPTY') return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  return Response.json({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }] });
};
await import('../background.js');
const { saveConfig } = await import('../lib/config.js');
const send = (texts, extra = {}) => new Promise(resolve => listener({ type: 'translate', target: 'zh-CN', texts, ...extra }, { url: 'https://paper.example/article' }, resolve));
const src = suffix => '39 patients (24.2%) versus 10 patients (6.2%). ' + suffix;
const correct = '39例患者（24.2%）与10例患者（6.2%）。';

test('balanced reports constructed number errors with one request and preserves the model text', async () => {
  calls = [];
  const result = await send([src('balanced')]);
  assert.equal(calls.length, 1);
  assert.match(result.results[0], /16\.2%/);
  assert.equal(result.validations[0].status, 'error');
  assert.ok(result.validations[0].issues.some(x => x.code === 'PERCENT_MISMATCH'));
  const again = await send([src('balanced')]);
  assert.equal(calls.length, 1);
  assert.equal(again.cached, 1);
  assert.equal(again.validations[0].status, 'error');
});

test('fast skips local validation and quality strategy isolates caches', async () => {
  await saveConfig({ professionalOptions: { quality: 'fast' } });
  calls = [];
  const result = await send([src('balanced')]);
  assert.equal(calls.length, 1);
  assert.equal(result.validations[0].checked, false);
  assert.match(calls[0].body.messages[0].content, /医学专业翻译要求/);
});

test('strict only reviews high risk, shares a hard cap across concurrent batches and clears stale alignments', async () => {
  await saveConfig({ professionalOptions: { quality: 'strict', maxReviewRequests: 1 } });
  respond = (inputs, review) => review ? [correct] : inputs.map(() => ({ parts: [{ n: 1, t: '39例患者（24.2%）与10例患者（16.2%）。' }] }));
  calls = [];
  const result = await send([src('strict-A'), src('strict-B'), src('strict-C')], { align: true });
  assert.equal(calls.filter(x => !x.review).length, 3);
  assert.equal(calls.filter(x => x.review).length, 1);
  assert.equal(result.results.filter(x => x === correct).length, 1);
  const accepted = result.validations.findIndex(x => x.review?.accepted);
  assert.ok(accepted >= 0);
  assert.equal(result.validations[accepted].review.expertReviewed, false);
  assert.equal(result.alignments[accepted], null);
  calls = [];
  await send([src('strict-A'), src('strict-B'), src('strict-C')]);
  assert.equal(calls.length, 0, 'an unresolved cached warning must not trigger another paid review');
});

test('strict review errors and empty length stops cannot trigger hidden provider retries', async () => {
  for (const failure of ['HTTP500', 'LENGTH_EMPTY']) {
    respond = (inputs, review) => review ? failure : inputs.map(() => '39例患者（24.2%）与10例患者（16.2%）。');
    calls = [];
    const result = await send([src(failure)]);
    assert.equal(calls.length, 2);
    assert.equal(calls.filter(x => x.review).length, 1);
    assert.match(result.results[0], /16\.2%/);
    assert.equal(result.validations[0].review.reason, 'failed');
  }
});

test('strict zero budget and correct output never add a review call', async () => {
  await saveConfig({ professionalOptions: { quality: 'strict', maxReviewRequests: 0 } });
  respond = inputs => inputs.map(() => '39例患者（24.2%）与10例患者（16.2%）。');
  calls = [];
  const capped = await send([src('zero-budget')]);
  assert.equal(calls.length, 1);
  assert.equal(capped.validations[0].review.reason, 'request-limit');
  await saveConfig({ professionalOptions: { maxReviewRequests: 3 } });
  respond = inputs => inputs.map(() => correct);
  calls = [];
  await send([src('correct')]);
  assert.equal(calls.length, 1);
});

test('strict reviewer preserves privacy and cannot leak title metadata or accept missing placeholders', async () => {
  await saveConfig({ privacyEnabled: true, professionalOptions: { quality: 'strict', maxReviewRequests: 1 } });
  respond = (inputs, review) => {
    if (review) return [correct + ' ' + (inputs[0].source.match(/__PII_EMAIL_ADDRESS_\d+__/) || [''])[0]];
    return inputs.map(x => '39例患者（24.2%）与10例患者（16.2%）。 ' + (x.match(/__PII_EMAIL_ADDRESS_\d+__/) || [''])[0]);
  };
  calls = [];
  const result = await send([src('privacy') + ' contact@example.org'], { documentContext: { title: 'secret-title@example.org' } });
  assert.equal(calls.length, 2, JSON.stringify({ result, inputs: calls.map(x => x.inputs) }));
  assert.match(result.results[0], /contact@example.org/);
  assert.ok(calls.every(x => !JSON.stringify(x.body).includes('contact@example.org') && !JSON.stringify(x.body).includes('secret-title')));
  respond = (inputs, review) => review ? [correct] : inputs.map(x => '39例患者（24.2%）与10例患者（16.2%）。 ' + x.match(/__PII_EMAIL_ADDRESS_\d+__/)[0]);
  const rejected = await send([src('privacy-missing') + ' second@example.org']);
  assert.match(rejected.results[0], /second@example.org/);
  assert.match(rejected.results[0], /16\.2%/);
  assert.equal(rejected.validations[0].review.reason, 'failed');
  await saveConfig({ privacyEnabled: false });
});

test('document context changes invalidate only the professional scope; batches receive relevant abbreviations', async () => {
  await saveConfig({ professionalOptions: { quality: 'balanced' } });
  respond = inputs => inputs.map(() => '无进展生存期延长。');
  calls = [];
  const text = 'PFS improved. context-test';
  await send([text], { documentContext: { title: 'Trial A', abbreviations: { PFS: 'progression-free survival', OS: 'overall survival' } } });
  assert.match(calls[0].body.messages[0].content, /progression-free survival/);
  assert.ok(!calls[0].body.messages[0].content.includes('overall survival'));
  await send([text], { documentContext: { title: 'Trial A', abbreviations: { PFS: 'progression-free survival', OS: 'another definition' } } });
  assert.equal(calls.length, 1);
  await send([text], { documentContext: { title: 'Trial B', abbreviations: { PFS: 'patient functional score' } } });
  assert.equal(calls.length, 2);
  await saveConfig({ professionalProfile: 'general' });
  calls = [];
  await send([text], { documentContext: { title: 'Trial A' } });
  assert.ok(!calls[0].body.messages[0].content.includes('医学专业翻译要求'));
  await send([text], { documentContext: { title: 'Trial B' } });
  assert.equal(calls.length, 1);
});
