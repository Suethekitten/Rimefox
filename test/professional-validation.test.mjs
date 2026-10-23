// local：纯规则测试。构造错误不代表真实模型的错误分布或医学质量改善。
import assert from 'node:assert/strict';
import { validateMedical } from '../lib/professional/profiles/medical/validators.js';
import { validateTranslation, needsStrictReview, validationPolicyFingerprint, normalizeReviewLimit } from '../lib/professional/validation.js';

const codes = (a, b, context) => validateMedical(a, b, context).issues.map((x) => x.code);
const medical = { validate: validateMedical };
const cases = [
  ['数值正确仍提示比较组归属边界', '39 patients (24.2%) versus 10 patients (6.2%).', '39例患者（24.2%）与10例患者（6.2%）。', 'review'],
  ['数值成组换序不虚报确定性错误', '39 patients (24.2%) versus 10 patients (6.2%).', '10例患者（6.2%）与39例患者（24.2%）。', 'review'],
  ['全角千分位单位等价', '1,234 patients received 5 mg/kg.', '１ ２３４例患者接受５毫克/千克。', 'pass'],
  ['p值及CI格式等价', 'p < .05; 95% CI, 0.5-1.2.', 'p＜0.05；95%置信区间为0.5～1.2。', 'pass'],
  ['负数和科学计数法等价', '-0.5 and 1e3.', '-0.5 和 1000。', 'pass'],
  ['正确的否定', 'No significant difference was found.', '未发现显著差异。', 'pass'],
  ['数字错改', '39 patients (24.2%) versus 10 patients (6.2%).', '39例患者（24.2%）与10例患者（16.2%）。', 'error'],
  ['人数百分比错配', '39 patients (24.2%) versus 10 patients (6.2%).', '39例患者（6.2%）与10例患者（24.2%）。', 'error'],
  ['数字不变但剂量单位错配', '5 mg and 10 g.', '5克和10毫克。', 'error'],
  ['运算符变化', 'p < 0.05.', 'p > 0.05。', 'error'],
  ['CI端点倒序', '95% CI, 0.5-1.2.', '95%置信区间为1.2～0.5。', 'error'],
  ['试验编号改变', 'Trial NCT12345678.', '试验NCT12345679。', 'error'],
  ['DOI正确保留', 'DOI 10.1000/test.123.', 'DOI 10.1000/test.123。', 'pass'],
  ['引用和隐私标记原样', '39 patients<k1>9–11</k1> __PII_EMAIL_1__', '39例患者<k1>9–11</k1> __PII_EMAIL_1__', 'pass'],
  ['标记内容被改', '39 patients<k1>9–11</k1>', '39例患者<k1>9–12</k1>', 'error'],
  ['基因符号被改', 'The BRCA1 gene.', 'BRCA2基因。', 'error'],
  ['否定遗漏只标疑似', 'No evidence of infection.', '存在感染证据。', 'review'],
  ['因果强化只标疑似', 'Exposure was associated with mortality.', '暴露导致死亡。', 'review'],
  ['讨论因果仍不能强化相关性', 'Exposure was associated with mortality; causality remains uncertain.', '暴露导致死亡；因果关系仍不确定。', 'review'],
  ['不确定性遗漏', 'The treatment might reduce mortality.', '该治疗降低死亡率。', 'review'],
  ['条件遗漏', 'If confirmed, treatment should start.', '应开始治疗。', 'review'],
  ['统计结论强化', 'No significant difference was found.', '没有差异。', 'review'],
  ['风险方向反转', 'The risk was reduced.', '风险增加。', 'review'],
  ['对应无法确定', 'Group A 10 and group B 20, respectively.', 'A组20，B组10，分别对应。', 'review'],
  ['文字数词无法判定', 'Four patients received 5 mg.', '4例患者接受5毫克。', 'review']
];
for (const [name, source, target, expected] of cases) {
  assert.equal(validateMedical(source, target).status, expected, name + ': ' + JSON.stringify(validateMedical(source, target)));
}
assert.ok(codes(cases[6][1], cases[6][2]).includes('PERCENT_MISMATCH'));
assert.ok(codes('If untreated, risk may increase.', '风险增加。').includes('CONDITION_RISK'));
assert.equal(validateMedical('5 mg', '').status, 'error');
assert.equal(validateMedical('10 mg', '10mg').status, 'pass', '正文数值紧贴单位仍可识别');
assert.equal(validateMedical('95% CI 0.5-1.2', '95%置信区间介于0.5与1.2之间').status, 'review', '未覆盖CI句式不虚报错误或已验证');
assert.equal(validateMedical('95% confidence interval: 0.5 to 1.2', '95%置信区间为0.5～1.2').status, 'pass');
assert.equal(validateMedical('95% CI between 0.5 and 1.2', '95%置信区间介于0.5与1.2之间').status, 'review', '双方无法解析CI不能误报已验证');
assert.equal(validateMedical('39 patients (24.2%)', '39例患者，占24.2%').status, 'review', '未覆盖人数百分比句式需要审查');
assert.equal(validateMedical('Treatment group 39 patients (24.2%) versus control group 10 patients (6.2%).', '试验组10例患者（6.2%），对照组39例患者（24.2%）。').status, 'review', '相同局部数值不能证明组别归属');
assert.equal(validateMedical('The mutation was possible.', 'La mutation était possible.').status, 'pass', '不对其他语言套中文规则');
for (const [source, translation, target] of [
  ['No evidence of infection.', '感染の証拠はない。', 'ja'],
  ['No evidence of infection.', '感染の証拠はない。', undefined],
  ['No evidence of infection.', '感染所見なし。', 'ja'],
  ['No evidence of infection.', '감염의 증거가 없다.', 'ko'],
  ['No evidence of infection.', '感染 증거가 없다.', undefined],
  ['感染の証拠はない。', 'There is no evidence of infection.', 'en']
]) {
  const result = validateMedical(source, translation, target ? { target } : {});
  assert.equal(result.issues.some((x) => x.kind === 'semantic' && x.severity === 'high'), false, '假名/韩文或明确非中英目标不能触发高风险语义复核');
}
assert.ok(codes('No evidence of infection.', '存在感染证据。', { target: 'zh-CN' }).includes('NEGATION_RISK'));
assert.ok(codes('未发现感染证据。', 'Evidence of infection was found.', { target: 'en' }).includes('NEGATION_RISK'));
assert.ok(codes('No evidence of infection.', '存在感染证据。').includes('NEGATION_RISK'), '未传target的旧直接接口保留中英推断');
assert.ok(codes('5 mg', '10 mg', { target: 'ja' }).includes('DOSE_UNIT_MISMATCH'), '非中英目标仍执行与语言无关的确定性检查');
assert.ok(codes('The ABCD1 variant.', '该变异。', { protectedSymbols: ['ABCD1'] }).includes('MEDICAL_SYMBOL_MISMATCH'));

const skipped = validateTranslation(medical, '5 mg', '10 mg', { quality: 'fast' });
assert.equal(skipped.checked, false);
assert.deepEqual(skipped.issues, []);
const balanced = validateTranslation(medical, '5 mg', '10 mg', { options: { quality: 'balanced' } });
assert.equal(balanced.status, 'error');
assert.ok(needsStrictReview(balanced));
assert.ok(needsStrictReview(validateMedical('No evidence.', '证据。')));
assert.equal(needsStrictReview(validateMedical('Group A 10 and B 20, respectively.', 'A组10，B组20，分别对应。')), false);
assert.equal(validateTranslation({ validate() { throw new Error('private details'); } }, 'x', 'y').status, 'review');
assert.equal(validateTranslation({ validate() { return {}; } }, 'x', 'y').checked, false);
const incomplete = validateTranslation({ validate() { return { status: 'pass', issues: [], checked: false }; } }, 'x', 'y');
assert.equal(incomplete.checked, false);
assert.equal(incomplete.status, 'review');
assert.ok(incomplete.issues.some((x) => x.code === 'VALIDATION_INCOMPLETE' && x.severity === 'medium'));
const incompleteError = validateTranslation({ validate() { return { status: 'error', issues: [{ code: 'PARTIAL_ERROR', severity: 'high', kind: 'deterministic' }], checked: false }; } }, 'x', 'y');
assert.equal(incompleteError.status, 'error', '未完成的检查不能抹掉已发现的错误');
assert.equal(incompleteError.checked, false);
assert.ok(incompleteError.issues.some((x) => x.code === 'PARTIAL_ERROR'));
assert.equal(validateTranslation(null, 'x', 'y').checked, false);
assert.equal(normalizeReviewLimit(Infinity), 1);
assert.equal(normalizeReviewLimit(99), 3);
assert.equal(normalizeReviewLimit(-1), 0);
assert.equal(normalizeReviewLimit(2.9), 2);
assert.equal(validationPolicyFingerprint({ quality: 'strict' }), validationPolicyFingerprint({ quality: 'strict', maxReviewRequests: 'invalid' }));
assert.notEqual(validationPolicyFingerprint({ quality: 'strict', maxReviewRequests: 1 }), validationPolicyFingerprint({ quality: 'strict', maxReviewRequests: 2 }));
assert.equal(validationPolicyFingerprint({ quality: 'balanced', maxReviewRequests: 1 }), validationPolicyFingerprint({ quality: 'balanced', maxReviewRequests: 3 }));

// 已知漏报：复杂否定范围、治疗组名称交换、同义符号与医学诊断仍需人工审查。
assert.equal(validateMedical('Not all patients improved.', '所有患者均未改善。').status, 'pass', '否定作用域不是关键字规则能验证的');
assert.equal(validateMedical('The diagnosis was pneumonia.', '诊断为心肌梗死。').status, 'pass', '当前检查器不具备医学事实语义理解');
console.log('✓ professional validation local cases passed; known false-negative boundaries asserted');
