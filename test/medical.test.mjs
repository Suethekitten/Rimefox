// 医学专业模式单测：数据完整性、术语匹配、用户优先级、提示词、缓存键。
// 运行：node test/medical.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEDICAL_TERMS, MEDICAL_LEXICON_VERSION, MEDICAL_TERM_SCHEMA_VERSION } from '../lib/medical/data/en-zh-CN.js';
import { auditMedicalTerms } from '../lib/medical/schema.js';
import { MEDICAL_SOURCES } from '../lib/medical/sources.js';
import {
  matchMedicalTerms,
  medicalFingerprintFor,
  medicalDirectionFor,
  medicalStats
} from '../lib/medical/terminology.js';
import { MEDICAL_PROFILE_VERSION, medicalPrompt, medicalTermPrompt } from '../lib/medical/profile.js';
import { systemPrompt } from '../lib/prompt.js';
import { makeKey } from '../lib/cache.js';
import { DEFAULTS } from '../lib/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

console.log('\n[医学词库数据]');
await t('词库是 100 条审核条目，MIT 44 + Wikidata 56', () => {
  assert.equal(MEDICAL_TERMS.length, 100);
  assert.equal(medicalStats().reviewedUpstream, 44);
  assert.equal(medicalStats().reviewed, 56);
  assert.equal(medicalStats().total, 100);
  assert.equal(MEDICAL_LEXICON_VERSION, '2');
  assert.equal(MEDICAL_PROFILE_VERSION, '2');
  assert.equal(MEDICAL_TERM_SCHEMA_VERSION, '2');
  assert.deepEqual(auditMedicalTerms(MEDICAL_TERMS), []);
});
await t('每条都有方向、领域、来源、审核状态和唯一英文源词', () => {
  const seen = new Set();
  for (const one of MEDICAL_TERMS) {
    assert.ok(one.source && one.target, 'empty term');
    assert.equal(one.sourceLang, 'en');
    assert.equal(one.targetLang, 'zh-CN');
    assert.ok(one.domain, 'missing domain: ' + one.source);
    assert.ok(one.sourceId, 'missing sourceId: ' + one.source);
    assert.ok(['reviewed', 'reviewed-upstream'].includes(one.status), 'bad status: ' + one.source);
    const key = one.source.toLowerCase();
    assert.ok(!seen.has(key), 'duplicate: ' + one.source);
    seen.add(key);
  }
});
await t('v2 schema 验证稳定身份、版本、学科及异常条目', () => {
  assert.equal(new Set(MEDICAL_TERMS.map((x) => x.id)).size, MEDICAL_TERMS.length);
  assert.ok(MEDICAL_TERMS.every((x) => x.domain === 'medical' && x.subdomain && x.version));
  assert.ok(auditMedicalTerms([{ ...MEDICAL_TERMS[0], id: '', aliases: [''] }]).some((x) => x.code === 'missing_field'));
  assert.ok(auditMedicalTerms([MEDICAL_TERMS[0], MEDICAL_TERMS[0]]).some((x) => x.code === 'duplicate_id'));
  assert.ok(auditMedicalTerms([{ ...MEDICAL_TERMS[0], status: 'unreviewed' }]).some((x) => x.code === 'unreviewed'));
  assert.ok(auditMedicalTerms([MEDICAL_TERMS[0], { ...MEDICAL_TERMS[1], aliases: [MEDICAL_TERMS[0].source] }]).some((x) => x.code === 'conflicting_match_name'));
});
await t('反向只来自 MIT 双向词表，Wikidata 不自动反转', () => {
  const reverse = MEDICAL_TERMS.filter((one) => one.reverse === true);
  assert.equal(reverse.length, 44);
  assert.ok(reverse.every((one) => one.status === 'reviewed-upstream'));
  assert.equal(medicalStats().zhToEn, 43);
  assert.equal(medicalStats().enToZh, 99);
});
await t('不把高歧义单字/缩写当自动术语', () => {
  const banned = new Set(['lead', 'culture', 'lesion', 'positive', 'negative', 'significant', 'control', 'stroke', 'safety', 'OR', 'HR', 'RR', 'CI']);
  for (const one of MEDICAL_TERMS) assert.ok(!banned.has(one.source), 'ambiguous source: ' + one.source);
});
await t('审计发现适用含义不清的旧条目保留来源但隔离自动匹配', () => {
  const term = MEDICAL_TERMS.find((x) => x.source === 'multivariate analysis');
  assert.equal(term.matchEnabled, false);
  assert.ok(term.contextHint);
  assert.equal(medicalStats().disabled, 1);
  assert.equal(matchMedicalTerms(['multivariate analysis'], 'zh-CN', 20).length, 0);
  assert.equal(matchMedicalTerms(['多因素分析'], 'en', 20).length, 0);
});
await t('数据来源审计明确包含 / 排除，MIT 许可文件存在', () => {
  const included = MEDICAL_SOURCES.filter((one) => one.included).map((one) => one.id);
  assert.deepEqual(included.sort(), ['qitong-medical-literature', 'wikidata']);
  assert.equal(MEDICAL_SOURCES.find((one) => one.id === 'qitong-medical-literature').terms, 44);
  assert.equal(MEDICAL_SOURCES.find((one) => one.id === 'wikidata').terms, 56);
  assert.ok(MEDICAL_SOURCES.some((one) => one.id === 'aix-text-terminology' && one.included === false));
  assert.ok(fs.existsSync(path.join(root, 'licenses', 'qitong-medical-literature-MIT.txt')));
});

console.log('\n[医学匹配]');
await t('审核的英式拼写别名命中规范词，用户同名覆盖仍优先', () => {
  const hits = matchMedicalTerms(['Randomised controlled trials measured tumour mutational burden.'], 'zh-CN', 20);
  assert.ok(hits.some((x) => x.source === 'randomized controlled trial' && x.id && x.subdomain && x.version));
  assert.ok(hits.some((x) => x.source === 'tumor mutational burden'));
  assert.ok(!matchMedicalTerms(['randomised controlled trial'], 'zh-CN', 20, ['randomised controlled trial']).length);
});
await t('完整术语、大小写、单复数都能命中', () => {
  for (const text of [
    'The randomized controlled trial was positive.',
    'Randomized Controlled Trials were positive.',
    'Patients with myocardial infarction were included.',
    'Patients with myocardial infarctions were included.'
  ]) {
    const hits = matchMedicalTerms([text], 'zh-CN', 20);
    assert.ok(hits.length > 0, text);
  }
});
await t('长术语优先，短术语不重复占额度', () => {
  const hits = matchMedicalTerms(['epithelial ovarian cancer and ovarian cancer'], 'zh-CN', 20);
  assert.ok(hits.some((one) => one.source === 'epithelial ovarian cancer'));
  assert.ok(!hits.some((one) => one.source === 'ovarian cancer'));
});
await t('中译英只使用 MIT 声明双向的术语', () => {
  const hits = matchMedicalTerms(['总生存期和无进展生存期'], 'en', 20);
  assert.ok(hits.some((one) => one.source === '总生存期' && one.target === 'overall survival'));
  assert.ok(hits.some((one) => one.source === '无进展生存期'));
});
await t('其他目标语言只返回规则方向，不注入英汉词条', () => {
  assert.equal(medicalDirectionFor('fr'), '');
  assert.deepEqual(matchMedicalTerms(['myocardial infarction'], 'fr', 20), []);
  assert.equal(medicalFingerprintFor('myocardial infarction', 'fr', []), 'm' + MEDICAL_PROFILE_VERSION + ':' + MEDICAL_LEXICON_VERSION + ':rules');
});
await t('用户术语可以排除同源医学词条（用户优先）', () => {
  const hits = matchMedicalTerms(['odds ratio and randomized controlled trial'], 'zh-CN', 20, [
    'randomized controlled trial'
  ]);
  assert.ok(!hits.some((one) => one.source === 'randomized controlled trial'));
  assert.ok(hits.some((one) => one.source === 'odds ratio'));
});
await t('缩写 / 普通词不会被当医学词强行匹配', () => {
  assert.deepEqual(matchMedicalTerms(['RCT OR HR RR CI'], 'zh-CN', 20), []);
  assert.deepEqual(matchMedicalTerms(['proteinase'], 'zh-CN', 20), []);
});
await t('limit 控制注入条数', () => {
  const text = 'randomized controlled trial, odds ratio, confidence interval, myocardial infarction';
  assert.equal(matchMedicalTerms([text], 'zh-CN', 2).length, 2);
});
await t('医学指纹随文本 / 用户覆盖变化，并带规则和词库版本', () => {
  const a = medicalFingerprintFor('odds ratio was 2.1', 'zh-CN', []);
  const b = medicalFingerprintFor('odds ratio was 2.1', 'zh-CN', []);
  const c = medicalFingerprintFor('no terms here', 'zh-CN', []);
  const d = medicalFingerprintFor('odds ratio was 2.1', 'zh-CN', ['odds ratio']);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.ok(a.startsWith('m' + MEDICAL_PROFILE_VERSION + ':' + MEDICAL_LEXICON_VERSION + ':'));
  assert.ok(c === 'm' + MEDICAL_PROFILE_VERSION + ':' + MEDICAL_LEXICON_VERSION + ':none');
});

console.log('\n[提示词]');
await t('医学模式关闭时提示词逐字不变', () => {
  const plain = systemPrompt('zh-CN', 'plain', [], '', false, false, false);
  const off = systemPrompt('zh-CN', 'plain', [], '', false, false, false, { enabled: false, hits: [] });
  assert.equal(off, plain);
  assert.ok(plain.indexOf('医学专业翻译要求') < 0);
});
await t('医学模式加入规则和命中的术语，且用户术语仍在最后', () => {
  const prompt = systemPrompt(
    'zh-CN', 'plain', [{ source: 'odds ratio', target: '用户比值' }], '自定义要求', false, false, false,
    { enabled: true, hits: [{ source: 'randomized controlled trial', target: '随机对照试验', abbreviation: 'RCT' }] }
  );
  assert.ok(prompt.includes('医学专业翻译要求'));
  assert.ok(prompt.includes('randomized controlled trial → 随机对照试验'));
  assert.ok(prompt.indexOf('医学专业术语') < prompt.indexOf('用户比值'));
  assert.ok(prompt.trim().endsWith('自定义要求'));
  assert.ok(prompt.startsWith('你是专业的网页文本翻译引擎'));
  assert.ok(prompt.includes('唯一目标语言：简体中文 (zh-CN)'));
});
await t('趣味风格与医学模式冲突时明确准确性优先', () => {
  const prompt = systemPrompt('zh-CN', 'classical', [], '', false, false, false, { enabled: true, hits: [] });
  assert.ok(prompt.includes('风格只能改变非专业措辞'));
  assert.ok(prompt.includes('医学事实'));
});
await t('没有命中术语时只加医学规则，不加空术语段', () => {
  const prompt = systemPrompt('zh-CN', 'plain', [], '', false, false, false, { enabled: true, hits: [] });
  assert.ok(prompt.includes('医学专业翻译要求'));
  assert.ok(!prompt.includes('医学专业术语（已审核'));
  assert.equal(medicalTermPrompt([]), '');
  assert.ok(medicalPrompt(false).includes('association'));
});

console.log('\n[缓存 / 配置]');
await t('普通缓存键保持旧格式，医学模式只在开启时追加', () => {
  const base = { target: 'zh-CN', style: 'plain', model: 'p:m', host: 'h', glossary: 'g', prompt: 'p' };
  assert.equal(makeKey(base, 'x'), 'v1|zh-CN|plain|p:m|h|g|p\nx');
  assert.equal(makeKey({ ...base, medical: '' }, 'x'), makeKey(base, 'x'));
  assert.notEqual(makeKey({ ...base, medical: 'm1:1:none' }, 'x'), makeKey(base, 'x'));
  assert.ok(makeKey({ ...base, medical: 'm1:1:abc' }, 'x').includes('|m1:1:abc\n'));
});
await t('medicalMode 默认关闭，旧配置合并后仍关闭', () => {
  assert.equal(DEFAULTS.medicalMode, false);
});

console.log('');
if (fail) {
  console.log('✗ ' + fail + ' 条失败，' + pass + ' 条通过');
  process.exit(1);
}
console.log('✓ ' + pass + ' 条全部通过');
