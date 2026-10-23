// 离线样本评测。默认是模拟输出；--input 只读取已获授权、已保存的输出，不调用API。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateMedical } from '../lib/professional/profiles/medical/validators.js';
import { matchMedicalTerms } from '../lib/medical/terminology.js';

export function evaluateCorpus(corpus) {
  if (!corpus || !['local', 'mock', 'live'].includes(corpus.method) || !Array.isArray(corpus.samples)) throw new Error('需要 method: local/mock/live 和 samples 数组');
  if (corpus.method === 'live' && (!corpus.model || !corpus.date || !corpus.provenance)) throw new Error('真实模型样本必须记录 model/date/provenance；此脚本不会生成真实模型结果');
  const summary = {};
  const details = [];
  for (const mode of ['general', 'medical']) {
    let expectedTerms = 0;
    let exactTermMatches = 0;
    let deterministicFlagged = 0;
    let semanticFlagged = 0;
    for (const sample of corpus.samples) {
      if (typeof sample.source !== 'string' || typeof sample[mode] !== 'string') throw new Error('样本需要 source/general/medical 字符串');
      const result = validateMedical(sample.source, sample[mode], { subdomain: sample.subdomain });
      const terms = matchMedicalTerms([sample.source], 'zh-CN', 12);
      expectedTerms += terms.length;
      exactTermMatches += terms.filter((term) => sample[mode].includes(term.target)).length;
      if (result.issues.some((issue) => issue.kind === 'deterministic')) deterministicFlagged += 1;
      if (result.issues.some((issue) => issue.kind === 'semantic')) semanticFlagged += 1;
      details.push({ id: sample.id, mode, status: result.status, codes: result.issues.map((issue) => issue.code) });
    }
    summary[mode] = { samples: corpus.samples.length, expectedTerms, exactTermMatches, deterministicFlagged, semanticFlagged };
  }
  return {
    method: corpus.method,
    provenance: corpus.provenance || '',
    limitation: '精确术语命中不等于译法唯一正确；规则未命中不等于医学语义正确。mock/local差异不证明真实模型或专业模式质量提升。',
    summary,
    details
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--input');
  if (at >= 0 && !process.argv[at + 1]) throw new Error('--input 需要文件路径');
  const inputPath = at >= 0 ? path.resolve(process.argv[at + 1]) : fileURLToPath(new URL('../test/fixtures/medical-quality-samples.json', import.meta.url));
  const result = evaluateCorpus(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
}
