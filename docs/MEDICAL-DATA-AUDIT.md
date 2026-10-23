# 医学专业模式 — 数据来源审计

> 审计日期：2026-10-23。运行时词库见 [lib/medical/data/en-zh-CN.js](../lib/medical/data/en-zh-CN.js)；
> 来源元数据见 [lib/medical/sources.js](../lib/medical/sources.js)。本文只记录医学模式的数据事实。

## 结论

本轮**实际打包 100 条医学概念**：

- 44 条来自 MIT 的 `qitong/medical-literature-translation` 词表（17 统计 / 11 肿瘤 / 20 妇科肿瘤中的可用条目）。
- 56 条用 Wikidata 的 P486（MeSH descriptor ID）锁定概念、取中文标签并人工规范化；不是 MeSH 官方中文词表。
- **AIX-Text/TerminologyDataset 没有打包**：数据集卡声称 MIT，但仓库没有 LICENSE 文件，内容可追溯到第三方索引 / 标准，质量也不达标。
- MeSH、HPO、UMLS 都没有打包数据文件；MeSH 只作为 P486 概念 ID 的交叉引用。

词库是**小型、人工审核的核心集**，不是“完整医学词典”。未命中时由普通模型结合上下文翻译；医学规则仍然生效。

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

## 4. MeSH / HPO / UMLS

- **MeSH**：<https://www.nlm.nih.gov/databases/download/mesh.html>。2026 RDF 约 30,512 个 TopicalDescriptor、约 324k SCR、402 个地理描述符；英文为主，中文需另找 CMeSH / 术语在线。NLM 条款要求署名 “Courtesy of the National Library of Medicine”、不得暗示背书；如直接再分发数据需保持当前版本或明确声明不是最新。**本轮只使用 P486 ID，没有打包 MeSH 数据。**
- **HPO**：本轮未使用；如未来使用，必须单独审计 HPO / hpo-translations 的许可。
- **UMLS**：本轮未使用；UMLS 有独立许可与源词表条款，不能因为可检索就整体打包。

## 5. 质量门槛与测试

- 所有打包条目必须有 `source`、`target`、`sourceLang`、`targetLang`、`domain`、`sourceId`、`status`。
- 只接受 `status: reviewed`（Wikidata 人工规范化）或 `reviewed-upstream`（MIT 词表）。
- 去重按英文源词小写；同一源词只保留一个方向明确的条目。
- 词库不进入 `config.glossary`，不占用户 500 条上限，不参与 CSV 导出。
- 只有目标语言为 `en` 或 `zh-CN / zh-Hans / zh` 时匹配术语；其他语言只加医学规则，不假装有完整双语词典。
- 高歧义词不自动替换；缩写不单独强制映射。
- 数据版本变化时必须更新 `MEDICAL_LEXICON_VERSION`，医学模式缓存会按新版本失效；普通模式缓存不受影响。

## 6. 重新审计步骤

1. 核对 `lib/medical/sources.js` 的 URL、版本、许可证、日期。
2. 任何新增来源先记录到本文与 `sources.js`，再改 `en-zh-CN.js`。
3. 运行 `node test/medical.test.mjs`（数据完整性、方向、重复、来源、匹配、用户优先级、指纹）。
4. 若使用 MeSH 数据本身，补 NLM 署名 / 版本 / 非背书声明；若使用 CMeSH / 术语在线，先确认其再分发条款。
