import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileRegistry, generalProfile, professionalRegistry } from '../lib/professional/registry.js';
import { createProfessionalEngine } from '../lib/professional/engine.js';
import { normalizeDocumentContext, contextForTexts } from '../lib/professional/context.js';
import { systemPrompt } from '../lib/prompt.js';
import { makeKey } from '../lib/cache.js';
import { reviewHighRisk } from '../lib/professional/review.js';

test('registry supports a second functional test profile without changes to the core', () => {
  const legal = {
    ...generalProfile, id: 'test-legal', name: 'Test legal', version: '2', termLimit: 1,
    buildInstructions: () => 'Preserve legal obligations.',
    matchTerms: (texts, target) => target === 'zh-CN' && texts.some(x => x.includes('contract')) ? [{ source: 'contract', target: '合同' }] : [],
    formatTerms: hits => hits.map(x => x.source + ' → ' + x.target).join('\n'),
    getFingerprint: () => 'legal-v2',
    validate: () => ({ checked: true, status: 'review', issues: [{ code: 'test-risk', kind: 'semantic', severity: 'medium' }] })
  };
  const registry = createProfileRegistry([generalProfile, legal]);
  const engine = createProfessionalEngine({ professionalProfile: 'test-legal' }, { registry, target: 'zh-CN', style: 'plain' });
  assert.equal(engine.profile.id, 'test-legal');
  assert.match(engine.prompt(['contract'], []).instructions, /obligations/);
  assert.equal(engine.prompt(['contract'], []).hits[0].target, '合同');
  assert.match(systemPrompt('zh-CN', 'plain', [], '', false, false, false, engine.prompt(['contract'], [])), /contract → 合同/);
  assert.equal(engine.validate('contract', '合同').status, 'review');
  assert.match(engine.fingerprint('contract'), /test-legal/);
  assert.throws(() => registry.register(legal), /Duplicate/);
  assert.throws(() => registry.register({ id: 'broken' }), /Invalid/);
  assert.deepEqual(professionalRegistry.list().map(x => x.id), ['general', 'medical']);
});

test('general mode preserves prompts and old cache keys byte for byte', () => {
  const engine = createProfessionalEngine({ professionalProfile: 'general' }, { target: 'zh-CN', documentContext: { title: 'trial' } });
  assert.equal(engine.prompt(['Hello'], []), null);
  assert.equal(engine.fingerprint('Hello'), '');
  assert.equal(engine.validate('Hello', '你好'), null);
  assert.equal(systemPrompt('zh-CN', 'plain'), systemPrompt('zh-CN', 'plain', undefined, undefined, undefined, undefined, undefined, engine.prompt(['Hello'], [])));
  assert.equal(makeKey({ target: 'zh-CN' }, 'Hello'), makeKey({ target: 'zh-CN', professional: engine.fingerprint('Hello') }, 'Hello'));
});

test('medical adapter keeps user terms ahead of built-in terms and changes only professional cache identity', () => {
  const request = { target: 'zh-CN', style: 'plain', excludeSources: new Set(['odds ratio']) };
  const engine = createProfessionalEngine({ medicalMode: true }, request);
  const spec = engine.prompt(['The odds ratio and confidence interval were reported.'], [{ source: 'odds ratio', target: '用户译法' }]);
  assert.ok(!spec.hits.some(x => x.source === 'odds ratio'));
  assert.ok(spec.hits.some(x => x.source === 'confidence interval'));
  const prompt = systemPrompt('zh-CN', 'plain', [{ source: 'odds ratio', target: '用户译法' }], '', false, true, false, spec);
  assert.match(prompt, /医学专业翻译要求/);
  assert.match(prompt, /唯一目标语言：简体中文/);
  assert.ok(prompt.indexOf('医学专业术语') < prompt.indexOf('用户译法'));
  assert.notEqual(makeKey({ target: 'zh-CN' }, 'trial'), makeKey({ target: 'zh-CN', professional: engine.fingerprint('trial') }, 'trial'));
});

test('context is bounded, explicit, relevant to the batch and isolated across papers', () => {
  const context = { title: 'Oncology trial', headings: ['Methods', 'Methods'], abbreviations: { PFS: 'progression-free survival', OS: 'overall survival', hr: 'heart rate' } };
  const normalized = normalizeDocumentContext(context);
  assert.deepEqual(normalized.headings, ['Methods']);
  assert.equal(normalized.abbreviations.hr, undefined);
  assert.deepEqual(contextForTexts(context, ['PFS improved.']).abbreviations, { PFS: 'progression-free survival' });
  assert.equal(contextForTexts(context, ['APFSS unrelated.']).abbreviations, undefined);
  const build = doc => createProfessionalEngine({ medicalMode: true }, { target: 'zh-CN', documentContext: doc });
  assert.notEqual(build(context).fingerprint('PFS improved.'), build({ ...context, abbreviations: { PFS: 'patient functional score' } }).fingerprint('PFS improved.'));
  assert.equal(build(context).fingerprint('PFS improved.'), build({ ...context, abbreviations: { ...context.abbreviations, OS: 'other definition' } }).fingerprint('PFS improved.'));
  assert.notEqual(build(context).fingerprint('PFS improved.'), build({ title: 'Another paper' }).fingerprint('PFS improved.'));
  assert.equal(build({}).prompt(['PFS improved.'], []).contextInstructions, '');
  const huge = normalizeDocumentContext({ title: 'x'.repeat(10000), headings: Array(100).fill('h'.repeat(1000)) });
  assert.equal(huge.title.length, 200);
  assert.ok(JSON.stringify(huge).length < 1000);
});

test('quality strategy, subdomain and matched terms participate in the fingerprint', () => {
  const build = options => createProfessionalEngine({ medicalMode: true, professionalOptions: options }, { target: 'zh-CN' });
  assert.notEqual(build({ quality: 'fast' }).fingerprint('trial'), build({ quality: 'balanced' }).fingerprint('trial'));
  assert.notEqual(build({ quality: 'strict', maxReviewRequests: 0 }).fingerprint('trial'), build({ quality: 'strict', maxReviewRequests: 1 }).fingerprint('trial'));
  assert.notEqual(build({ quality: 'balanced', subdomain: 'oncology' }).fingerprint('trial'), build({ quality: 'balanced', subdomain: 'auto' }).fingerprint('trial'));
  const covered = createProfessionalEngine({ medicalMode: true }, { target: 'zh-CN', excludeSources: [] });
  const overridden = createProfessionalEngine({ medicalMode: true }, { target: 'zh-CN', excludeSources: ['odds ratio'] });
  assert.notEqual(covered.fingerprint('odds ratio'), overridden.fingerprint('odds ratio'));
  assert.equal(covered.fingerprint('unrelated'), overridden.fingerprint('unrelated'));
});

test('privacy mode does not add an unmasked metadata channel', () => {
  const engine = createProfessionalEngine({ medicalMode: true, privacyEnabled: true }, { target: 'zh-CN', documentContext: { title: 'secret@example.com', abbreviations: { OS: 'overall survival' } } });
  const prompt = engine.prompt(['OS improved'], []);
  assert.equal(prompt.contextInstructions, '');
  assert.ok(!engine.fingerprint('OS improved').includes('secret'));
});

test('a future profession can carry bounded custom context without editing the core schema', () => {
  const legal = {
    ...generalProfile, id: 'test-jurisdiction', name: 'Legal',
    buildContext: data => ({ jurisdiction: data.jurisdiction, documentType: 'contract', attributes: data.attributes }),
    buildInstructions: context => 'Jurisdiction ' + context.jurisdiction,
    getFingerprint: context => context.context.jurisdiction
  };
  const registry = createProfileRegistry([generalProfile, legal]);
  const build = jurisdiction => createProfessionalEngine({ professionalProfile: legal.id }, { registry, target: 'zh-CN', documentContext: { jurisdiction, attributes: { system: 'common law' } } });
  assert.equal(build('CA').contextFor(['contract']).jurisdiction, 'CA');
  assert.match(build('CA').prompt(['contract'], []).instructions, /CA/);
  assert.match(build('CA').prompt(['contract'], []).contextInstructions, /common law/);
  assert.notEqual(build('CA').fingerprint('contract'), build('US').fingerprint('contract'));
  assert.ok(JSON.stringify(normalizeDocumentContext({ custom: { huge: 'x'.repeat(10000) } })).length < 200);
});

test('strict review never accepts a candidate whose checker failed or did not finish', async () => {
  for (const mode of ['throw', 'unchecked']) {
    const risk = { checked: true, status: 'review', issues: [{ code: 'risk', severity: 'high', kind: 'semantic' }] };
    const profile = {
      ...generalProfile, id: 'test-checker', name: 'Checker',
      validate(source, translation) {
        if (translation === 'candidate') {
          if (mode === 'throw') throw new Error('checker failure');
          return { checked: false, status: 'pass', issues: [] };
        }
        return risk;
      }
    };
    const registry = createProfileRegistry([generalProfile, profile]);
    const engine = createProfessionalEngine({ professionalProfile: profile.id, professionalOptions: { quality: 'strict', maxReviewRequests: 1 } }, { registry, target: 'zh-CN' });
    const result = await reviewHighRisk({ engine, source: 'source', translation: 'original', report: risk, budget: { remaining: 1 }, review: async () => 'candidate', accept: () => true });
    assert.equal(result.translation, 'original');
    assert.equal(result.report.review.accepted, false);
  }
});
