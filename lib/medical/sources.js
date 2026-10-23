// 医学词库来源审计（运行时只读；不上传、不联网）
// 每个实际纳入的术语都在 data/en-zh-CN.js 的 sourceId 里指向这里的 id。
export const MEDICAL_SOURCES = [
  {
    id: 'qitong-medical-literature',
    name: 'medical-literature-translation (Qitong Hu)',
    url: 'https://github.com/qitong/medical-literature-translation',
    version: '11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176 (2026-08-27)',
    retrieved: '2026-10-23',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Qitong Hu',
    included: true,
    terms: 44,
    usage: 'references/glossary.md 的英文/中文术语，按 MIT 改编为 en-zh-CN.js；保留原词表的中英双向标记。references/translation-conventions.md 只提炼为医学翻译规则。',
    requirements: '随包保留 MIT 许可与版权；不声称作者为 Rimefox 背书。'
  },
  {
    id: 'wikidata',
    name: 'Wikidata labels + MeSH concept IDs',
    url: 'https://www.wikidata.org/',
    version: 'Wikidata live query 2026-10-23; each row stores QID and P486 MeSH ID',
    retrieved: '2026-10-23',
    license: 'CC0 1.0 (structured data)',
    included: true,
    terms: 56,
    usage: '用 P486 (MeSH ID) 锁定医学概念，取 Wikidata 中文标签；对简繁、括号限定词和个别不标准标签做人工规范化。只保留含义明确的概念。',
    requirements: 'CC0 不要求署名，但本项目和本文档保留来源与 QID/P486；中文标签不是 MeSH 官方中文词表。'
  },
  {
    id: 'aix-text-terminology',
    name: 'AIX-Text/TerminologyDataset — Medical.csv',
    url: 'https://huggingface.co/datasets/AIX-Text/TerminologyDataset',
    version: 'repo commit f9437406a5a1ecbd1ef6890f7053dd33e36516e9; Medical.csv commit d99f910570c06ded19481b390faf0876337420b6; 3005 data rows; 110656 bytes',
    retrieved: '2026-10-23',
    license: 'Dataset card says MIT, but no LICENSE file was present in the repo at audit time',
    included: false,
    terms: 0,
    usage: '只作为候选/对照，不打包。样本存在明显的术语拼接和机器翻译（例如 ABCDEFW acronym → ABCDEFW缩略语），且上游中文来源未说明。',
    requirements: '在补齐可核验的许可证文件与上游来源前不得再分发。'
  },
  {
    id: 'mesh',
    name: 'MeSH (Medical Subject Headings), NLM',
    url: 'https://www.nlm.nih.gov/databases/download/mesh.html',
    version: 'reference only; no MeSH data files bundled',
    retrieved: '2026-10-23',
    license: 'NLM Terms and Conditions for MeSH; attribution / no endorsement requirements apply',
    included: false,
    terms: 0,
    usage: '仅使用 P486 指向的 MeSH 概念 ID 做概念锁定；没有把 MeSH 英文词表或第三方中文翻译打包。',
    requirements: '如未来直接使用 MeSH 数据，必须单独核对官方条款、保留版本/署名（“Courtesy of the National Library of Medicine”）并避免暗示 NLM 背书。'
  },
  {
    id: 'hpo',
    name: 'Human Phenotype Ontology / hpo-translations',
    url: 'https://hpo.jax.org/',
    version: 'not used',
    retrieved: '2026-10-23',
    license: 'separate HPO / translation licenses; not audited for bundling',
    included: false,
    terms: 0,
    usage: '本轮未使用。',
    requirements: '未来使用前单独审计。'
  },
  {
    id: 'umls',
    name: 'UMLS',
    url: 'https://www.nlm.nih.gov/research/umls/',
    version: 'not used',
    retrieved: '2026-10-23',
    license: 'UMLS license / source vocabulary terms; not MIT-compatible by default',
    included: false,
    terms: 0,
    usage: '本轮未使用，不打包。',
    requirements: '不得因为可检索就假定可整体再分发。'
  }
];

export const MEDICAL_DATA_SUMMARY = {
  bundledTerms: 100,
  bundledSources: MEDICAL_SOURCES.filter((s) => s.included).map((s) => s.id),
  excludedSources: MEDICAL_SOURCES.filter((s) => !s.included).map((s) => s.id)
};
