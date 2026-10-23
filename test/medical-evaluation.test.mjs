// mock：检查离线评测方法与构造输出；不生成真实模型结论。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { evaluateCorpus } from '../tools/evaluate-medical.mjs';
const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/medical-quality-samples.json', import.meta.url), 'utf8'));
const result = evaluateCorpus(corpus);
assert.equal(result.method, 'mock');
assert.ok(result.provenance.includes('不证明'));
assert.equal(result.summary.medical.deterministicFlagged, 0);
assert.ok(result.summary.general.deterministicFlagged > 0);
assert.ok(result.summary.general.semanticFlagged > 0);
assert.ok(result.summary.general.exactTermMatches < result.summary.medical.exactTermMatches);
assert.throws(() => evaluateCorpus({ ...corpus, method: 'live' }), /model\/date\/provenance/);
assert.equal(evaluateCorpus({ ...corpus, method: 'live', model: 'recorded-model', date: '2026-10-23', provenance: '测试已保存输出的元数据门槛；未调用模型。' }).method, 'live');
console.log('✓ medical mock evaluation provenance, metrics, and live metadata gate passed');
