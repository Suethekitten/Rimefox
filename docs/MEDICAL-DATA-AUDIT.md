# 医学专业模式 — 数据来源审计

> 审计日期：2026-10-23。运行时词库见 [lib/medical/data/en-zh-CN.js](../lib/medical/data/en-zh-CN.js)；
> 来源元数据见 [lib/medical/sources.js](../lib/medical/sources.js)。本文只记录医学模式的数据事实。

## 结论

核心记录保留在随包词库中；当前条目及有效匹配方向用 `node test/medical.test.mjs` 或 `medicalStats()` 查看。审计保留的上游来源构成为：

- 44 条来自 MIT 的 `qitong/medical-literature-translation` 词表（17 统计 / 11 肿瘤 / 20 妇科肿瘤中的可用条目）。
- 56 条用 Wikidata 的 P486（MeSH descriptor ID）锁定概念、取中文标签并人工规范化；不是 MeSH 官方中文词表。
- **AIX-Text/TerminologyDataset 没有打包**：数据集卡声称 MIT，但仓库没有 LICENSE 文件，内容可追溯到第三方索引 / 标准，质量也不达标。
- MeSH、HPO、UMLS 都没有打包数据文件；MeSH 只作为 P486 概念 ID 的交叉引用。

词库是**小型、开发期核对的核心集**，不是“完整医学词典”或医学专家认证词库。含义存疑的上游条目保留溯源记录但隔离自动匹配，见下文质量门槛。未命中时由模型结合上下文翻译；医学规则仍然生效。

## 1. qitong/medical-literature-translation

| 项 | 值 |
|---|---|
| 类型 | GitHub 仓库 / Claude Skill，**不是 Hugging Face 数据集** |
| URL | <https://github.com/qitong/medical-literature-translation> |
| 版本 | `11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176`（2026-08-27） |
| 许可证 | MIT，LICENSE 存在，Copyright (c) 2026 Qitong Hu |
| 实际使用 | `references/glossary.md` 的术语；`references/translation-conventions.md` 的规则提炼 |
| 打包术语 | **44 条**；3 条多译法（recurrence / relapse、endometrial cancer / carcinoma、cytoreductive surgery / debulking）+ 1 条 DNT 未纳入 |
| 方向 | 词表声明中英双向；本项目只把 44 条标记为可反向 zh→en |
| 许可要求 | 随包保留 MIT 许可与版权；不声称作者背书。见 [licenses/qitong-medical-literature-MIT.txt](../licenses/qitong-medical-literature-MIT.txt) |

## 2. Wikidata / MeSH concept IDs

| 项 | 值 |
|---|---|
| Wikidata URL | <https://www.wikidata.org/> |
| 许可 | 主命名空间结构化数据 CC0 1.0；标签和 P486 语句属于主命名空间 |
| P486 | MeSH descriptor ID：<https://www.wikidata.org/wiki/Property:P486> |
| 查询日期 | 2026-10-23 |
| 实际使用 | **56 条**常见医学概念的 QID + P486；中文标签取自 Wikidata 后人工简繁 / 术语规范化 |
| 质量 caveat | Wikidata 中文标签是社区数据，不是术语在线 / CMeSH / MeSH 官方中文词表；每条都只选含义明确的概念，未把缩写或同形词直接当术语 |
| 示例 | Q12152/P486:D009203 → myocardial infarction → 心肌梗死；Q12192/D011014 → pneumonia → 肺炎 |
| 未使用 | 没有批量抓取 Wikidata，没有在用户翻译时联网查询；数据在开发期离线生成 |

### 手工排除的高歧义候选

没有把以下英文单词作为单条自动术语注入：`lead`、`culture`、`lesion`、`positive`、`negative`、`significant`、`control`、`stroke`、`safety`。
`OR` / `HR` / `RR` / `CI` 也不作为独立术语条目；只保留完整术语，缩写交给上下文和规则处理。

## 3. AIX-Text/TerminologyDataset — 未纳入

| 项 | 值 |
|---|---|
| URL | <https://huggingface.co/datasets/AIX-Text/TerminologyDataset> |
| 版本 | 仓库 `f9437406a5a1ecbd1ef6890f7053dd33e36516e9`；Medical.csv `d99f910570c06ded19481b390faf0876337420b6` |
| 声称许可 | 数据集卡 / README front matter 声称 MIT |
| 实际许可 | **没有 LICENSE 文件**；README 说“see the LICENSE file for details”，但仓库没有 |
| 大小 | Medical.csv 110,656 B；3,005 数据行 |
| 质量 | 1,205 行重复；1,872 唯一对；约 880 行是书索引碎片（`in elbow region`、`for pelvis`、尾部 `and`）；24 个源词有冲突译法；PDF 连字/弯引号；`ABCDEFW acronym → ABCDEFW缩略语` 等垃圾行 |
| 其他领域 | Railway.csv 10,253 行，列顺序与 Medical 相反，约 70% 的 Merged 文件是铁路术语 |
| 结论 | **不打包、不再分发**；只作为候选审计。需要上游书面来源与有效许可证才可重新评估 |

## 4. 标准术语来源的许可与语言边界

以下结论于文首日期联网核对官方资料；未下载、复制或打包这些受单独条款约束的数据库。

| 来源 | 语言 / 适用性 | 再分发与本项目决策 |
|---|---|---|
| MeSH | 英文生物医学主题索引；不是现成英中临床词典。MTMS 翻译文件不受基础 MeSH 条款覆盖。 | NLM 免费提供基础数据，但要求注明来源、非背书、保持当前版本或明确版本/非最新声明；只保留原有 Wikidata P486 交叉引用，不打包 MeSH 数据或中文翻译。见 [NLM MeSH 条款](https://www.nlm.nih.gov/databases/download/terms_and_conditions_mesh.html)。 |
| MedDRA | ICH/MSSO 维护的药物监管/药物警戒多语种术语，包含中文；适用范围与一般临床词典不同。 | 组织年度订阅不授予公开再分发/再许可权。MSSO 的 [2026-05-20 数据共享声明](https://files.meddra.org/www/Website%20Files/Welcome%20Pages/001418%20Statement%20on%20MedDRA%20Data%20Sharing.pdf) 明确限制向未订阅方分发及在开放源码/公开数据集 AI 环境暴露内容。本项目未纳入任何 MedDRA 条目。 |
| SNOMED CT | 国际版主要为英文；SNOMED International 另维护西班牙语，其他会员翻译由对应 NRC 管理，不能推断存在可公开捆绑的完整中文版本。见 [官方翻译说明](https://www.implementation.snomed.org/member-translations)。 | 使用和分发受 Affiliate License / 地域 / 部署方式约束，会员地区免费不等于开放许可；非会员地区可能收费，网页/浏览器部署另需核实。[获取与许可](https://www.snomed.org/get-snomed)、[NLM 许可说明](https://www.nlm.nih.gov/healthit/snomedct/snomed_licensing.html)。未纳入。 |
| RxNorm | NLM 的规范药名、成分、强度与剂型体系；英文、美国药品为主，不假设存在官方中文映射。见 [RxNorm Overview](https://www.nlm.nih.gov/research/umls/rxnorm/overview.html)。 | 完整下载要求 UMLS 许可与 UTS 账号；NLM 不收 RxNorm 许可费，但其中专有来源可能要求额外许可。可浏览 RXNORM 数据不等于可打包所有来源。[NLM FAQ](https://www.nlm.nih.gov/research/umls/rxnorm/faq.html)。未纳入。 |
| HPO / UMLS | HPO 与翻译、UMLS 与各源词表需要分别核对；不能把可检索视为开放再分发。 | 本轮未纳入。 |

这些来源的名称只出现在审计元数据中，不会在用户翻译时联网查询。Wikidata 社区中文标签仍然不是 MeSH、CMeSH、MedDRA 或 SNOMED CT 的官方中文标准。

## 5. 质量门槛与测试

- 词库 schema v2：所有条目有稳定 `id`、条目 `version`、`source`、`target`、`sourceLang`、`targetLang`、`domain: medical`、`subdomain`、`sourceId`、`status`、`reverse`、`aliases`、`contextHint`。`id` 不随数组排序变化；语义、别名或方向改变时更新条目版本和词库版本。
- `aliases` 只容纳已审核的同义/拼写变体；缩写字段不自动变成匹配关键词。当前只加英式拼写 `randomised controlled trial` 与 `tumour mutational burden`，没有增加未经审校的医学概念数量。别名命中输出规范术语，别名被用户术语覆盖时整条内置术语让位。
- `contextHint` 保存人工适用说明，隔离条目记录了原因；不会把关键词命中当作消歧或语义理解。`subdomain` 是原有学科标签的结构化迁移，不由模型猜测。
- `lib/medical/schema.js` 的 `auditMedicalTerms()` 离线检查必填字段、稳定身份重复、方向重复、审校状态和别名结构。
- 只接受 `status: reviewed`（Wikidata 标签的开发期规范化）或 `reviewed-upstream`（MIT 词表的来源流程）。这些标签不表示医学专家认证，本轮没有临床专家审校。
- 复核现有词条的方向、重复、来源身份与已排除歧义词；保留核心集。`hazard ratio` 的“风险比”、`relative risk` 的“相对危险度”等仍依赖上下文，`multivariate analysis` 的上游“多因素分析”用法可能与 `multivariable analysis` 混同；保留可追溯原记录并设置 `matchEnabled: false`，在专业审校前从自动注入和反向匹配隔离，未凭自动规则重新赋予官方标准译名。当前数据不应被当作完整或权威医学标准。
- 去重按英文源词小写；同一源词只保留一个方向明确的条目。
- 词库不进入 `config.glossary`，不占用户 500 条上限，不参与 CSV 导出。
- 只有目标语言为 `en` 或 `zh-CN / zh-Hans / zh` 时匹配术语；其他语言只加医学规则，不假装有完整双语词典。
- 高歧义词不自动替换；缩写不单独强制映射。
- 数据版本变化时必须更新 `MEDICAL_LEXICON_VERSION`，医学模式缓存会按新版本失效；普通模式缓存不受影响。

## 6. 重新审计步骤

1. 核对 `lib/medical/sources.js` 的 URL、版本、许可证、日期。
2. 任何新增来源先记录到本文与 `sources.js`，再改 `en-zh-CN.js`。
3. 运行 `node test/medical.test.mjs` 和 `node test/professional-validation.test.mjs`（schema、数据、方向、别名、用户优先级、指纹与校验边界）；`node tools/evaluate-medical.mjs` 只评估自拟模拟样本。
4. 若使用 MeSH 数据本身，补 NLM 署名 / 版本 / 非背书声明；若使用 CMeSH / 术语在线，先确认其再分发条款。
