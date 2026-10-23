# Professional Translation Engine v2 与 JAMA 修复开发报告

> 已归档的本地实施和验收记录，日期：2026-10-23。当前实现规范以 [专业引擎文档](../PROFESSIONAL-TRANSLATION.md)、[数据审计](../MEDICAL-DATA-AUDIT.md) 和 [DOM 引擎文档](../TRANSLATION-ENGINE-HANDOFF.md) 为准。机器可读的精简证据见 [evidence.json](2026-10-23-professional-engine-v2-evidence.json)。

## 交付状态

已在本地分支 `codex/professional-engine-v2` 实现、集成并完成离线和无头 Chrome 验证，等待用户验收。基线为 `9bdb0fb7780603d5c0cfaf8069c9fce7004db142`；执行前工作树干净，`git log --oneline -5` 已检查，`git ls-remote origin HEAD refs/heads/main` 核对远端与本地一致。

扩展版本仍为 0.11.3。没有修改 manifest/package/core 的版本号，没有推送、创建 Release、提交商店审核或调用真实付费模型。所有代码改动保留在本地工作树供审阅。配置数据结构独立迁移为 v7。

## 专业引擎实现

建立静态 Professional Profile Registry，正式注册 `general` 和 `medical`。医学通过适配器复用 `lib/medical/`，未重写已有提供商或另建模型调用管线。后台只通过 profile 的规则、术语、上下文、校验和指纹接口工作；专业模块不操作 DOM。

新专业实现独立包后，在 Registry 静态 import 并注册即可接入核心；界面是否暴露仍需另行产品决策。测试专用法律配置实际提供规则、合同术语和校验，另有 CA/US 司法管辖上下文测试，证明专有字段可进入提示词并隔离缓存，无须修改后台核心。MV3 模块图全部为静态 import。

保留旧医学开关，迁移时 `medicalMode:true` 继续启用医学；旧弹窗仅保存布尔值也可切换新主字段。配置导入/导出、API Key、自定义服务商、用户术语、缓存和个人设置保留。设置页新增快速/标准/严格质量和 0–3 次复核上限；默认标准，严格默认关闭。

普通、双语、仅译文、悬停、划词、输入框、字幕、批处理和并发闸门沿用原架构。标题/章节与实际渲染策略变化会作废旧在途结果并重建，避免混合两种策略。

## 医学规则、术语与上下文

规则升级为可维护的忠实性、证据、统计、剂量和医学符号层；明确相关≠因果、发病≠患病、不良事件≠药物不良反应、统计≠临床意义、无显著差异≠无差异，以及模态、概率、否定和证据强弱。可靠子领域才追加对应短规则，继续使用用户原来的 API。

词库保留原有 100 条来源记录，新增稳定 `id/version/subdomain/aliases/contextHint`；本轮没有为数量加入机器翻译数据。审计发现 `multivariate analysis → 多因素分析` 有混同 multivariable 的风险，保留来源记录并用 `matchEnabled:false` 隔离；有效英中方向为 99 条、可反向为 43 条。英式拼写别名受控增加，用户术语仍优先，长词优先且只注入本批命中词；不将整表反转。

MeSH、MedDRA、SNOMED CT、RxNorm 的官方许可、语言覆盖和再分发条件已联网核实并更新审计。没有复制这些受限或需另行许可的数据；社区中文标签不声称为官方 MeSH 中文标准。许可细节与官方链接统一保存在数据审计和来源元数据中。

页面本地只读有限的标题、章节、当前批次及相邻块，保守识别显式长名 `(ABC)`，冲突定义和跨论文混批被丢弃。后台再次限制上下文大小，只保留当前文本出现的缩写。上下文不含整篇论文，也不保存跨论文的缩写表。隐私保护开启时不发送标题/章节元数据，复核的原文和候选同样脱敏并严格恢复。

## 质量检查、费用与缓存

标准模式新增本地数值多重集合、百分比、p 值、CI、剂量单位、人数/比例局部对应、研究编号、引用/隐私标记和部分医学符号检查；不以数字顺序变化判错。语义规则只报告可疑线索，标准模式不自动改写医学事实。

相同数值集合或相同人数/比例配对不能证明实验组归属正确：只要组别对应无法可靠判断就标记 `review`。复杂数词或未覆盖表达也不冒充验证通过。校验器异常或显式未完成检查会保留 `checked:false` 并报告审查；严格复核不能接纳这种候选。日/韩目标不套用中文语义字符串规则。

严格模式仅复核 high 风险片段。每个 `translate` 消息的所有内部并发批次共用 0–3 次预算，发送前扣减；提供商内部回退/重试在该复核调用中被禁用，每次最多一个 HTTP 请求，失败不递归复核。整页可能包含多个消息，所以这是每消息预算，不能当成整页总费率上限。设置页明确提示额外 Token/API 费用和模型复核不等于专家审核。

复核失败、无改善、输出不合法、保护标记变化或隐私恢复失败时保留原译文及风险。只有候选完成本地检查、没有高风险确定性差异且风险减少时才接纳；接纳后清除旧对齐偏移。弹窗和诊断可查看待核对段落。

缓存仍是字符串和原三层机制，不清空任何缓存。通用模式键逐字不变；专业段包含 profile/术语/校验版本、该段命中词、相关上下文和质量策略。新增无关词不影响无关段落；旧医学缓存不被冒充为 v2 已验证结果。缓存命中重新本地检查，不再次付费复核，避免同一疑点在补扫中循环收费。

## JAMA 上标污染：已复现的原因与修复

没有反复访问或抓取真实 JAMA 页面；按要求仅用等价结构验证。证据能确认本地对应触发路径，真实页面最终由用户验收。

旧引用组识别不支持 `/` 分隔；隐藏的辅助标签还会让整个上标的 `textContent` 不像编号。外层 `<sup>` 或 CSS 包装因此退为内层 `<a>` 原子。旧 `safeSlot()` 只跨出链接，仍停在上标内部；随后正文作为新文本节点写入该上标，继承字号和垂直位置。共享上标中的引用还可能被拆开，使中文进入编号与分隔符之间。

| 等价夹具 | 修改前正文落点与样式 | 修改后 |
|---|---|---|
| 普通 sup / 共享引用组 / 隐藏辅助标签 | 中文父级 SUP；20px 正文变 16.6667px，Range 高 24px | 中文父级 P；20px，Range 高 28px |
| CSS super / relative / transform | 中文父级上标包装；字号 13px，Range 高 18px | 中文父级 P；20px，Range 高 28px |

修复增加可见引用文本识别和 `/` 分隔支持，尽量把 9–11、12–17、13/14 作为整个原子保留；在清空原文前，统一规划跨出 A、SUP/SUB、引用包装及 CSS 特殊排版链的安全落点。pre-wrap 新换行与引用使用相同安全边界。包装样式单次 memo，换行锚点线性规划，避免新增重复平方遍历。

没有用 `font-size/vertical-align !important` 覆盖，也没有 `innerHTML` 重建段落。原引用及分隔符原地保留，所有文字和节点修改仍进 RenderTransaction。断言覆盖字号/基线探针、Range 几何、中文跨行、href/id/ARIA、点击监听器、节点身份、引用顺序、逐节点还原、模式切换、重译和 SPA 更新。普通小字号、普通链接、Science、Nature、PMC 和 YouTube @用户名的回归同时通过。

## 测试结果

| 检查 | 结果 |
|---|---|
| 修改前原仓库 Node 基线 | 全通过 |
| `node --test test/*.test.mjs` | 47 个 runner 汇总项通过，0 失败；包含旧式测试文件及新增 Node test 项 |
| `for f in test/*.test.mjs; do node "$f" || exit 1; done` | 全文件通过，退出码 0 |
| 离线 `selftest/index.html` | 247 / 247 |
| `node tools/e2e-extension.mjs` | 真实扩展 + 本地假 API，139 / 139；含配置质量选择/保存、医学开关、缓存、划词、输入框、悬停与 Shadow DOM |
| `node tools/e2e-inline-layout.mjs` | 三组视口/缩放矩阵均 254 / 254，附完整自检通过 |
| 同一布局夹具加载旧 HEAD DOM | 46 条断言失败，成功复现 SUP/CSS 上标污染 |
| `node tools/evaluate-medical.mjs` | 输出标明 `method:mock` 的可复核结果，无 API 调用 |
| 最终管线/提示词/用量复查、语法与 `git diff --check` | 通过 |

布局矩阵为 1000px/100%/DPR1；390px/CSS125%/DPR1.25；1280px/CSS175%/DPR1.5/pageScale125%。这是 headless 中的 CSS、设备尺度与页面尺度模拟，不替代真实浏览器/操作系统缩放的人工验收。

本地规则测试包含正确和故意错误译文，并明确断言复杂否定、诊断错译等漏报边界。后台 mock 测试使用真实消息路由/提供商代码和假服务，覆盖限额、并发、复核失败不重试、隐私、对齐失效、上下文和缓存隔离。

自拟论文风格 mock 样本的两列输出均为人工构造：一般列术语精确命中 9/10、确定性/语义风险片段 2/3；医学列 10/10、0/0。这些数字只证明评测工具能识别已设置的差异，**不能证明真实模型在医学模式下质量提升**。真实模型测试未执行。工具支持读取已保存的真实输出，要求模型、日期与来源元数据，不自动联网调用。

## 已确认限制与用户验收

- 没有真实模型对照或医学专家审校，不能将规则通过/模型复核当作医学准确性证明。
- 术语为小型审核核心集，本轮没有安全依据扩成大型官方中文数据库；隔离了一个可疑原词。
- 语义检查主要覆盖部分英中/中英线索，复杂否定作用域、全文结论增删、诊断错译仍可能漏检；其他语言的语义检查不伪装成已有能力。
- 缩写定义依赖当前批次或邻近上下文，长距离定义、复杂缩写和完整文档分类尚不支持；`auto` 不意味着已完成领域语义分类。
- 真实 JAMA、Science、Nature、PMC 页面与真实 YouTube 字幕来源均未在本次联网人工验收；它们的离线结构/运行时测试通过。
- 严格模式的预算按消息而非整页计算；使用真实 API 前请保留费用提示并从少量片段抽样。

用户重新加载本地扩展后，建议在 JAMA 指定页面核对 9–11、12–17、13/14、21 附近正文：仅译文/双语/悬停、点击引用、关闭还原、重译及页面缩放。再抽查 Science/Nature/PMC 和 YouTube 字幕；有授权的真实模型对照应保存原文、模型信息、两种模式输出并人工复核术语、数值和结论强弱。

## 修改文件

以下为本任务的源代码、测试与文档改动；实际差异以本地 Git 工作树为准。

- [HANDOFF.md](../../HANDOFF.md)
- [background.js](../../background.js)
- [content/dom.js](../../content/dom.js)
- [content/main.js](../../content/main.js)
- [docs/MEDICAL-DATA-AUDIT.md](../../docs/MEDICAL-DATA-AUDIT.md)
- [docs/PROFESSIONAL-TRANSLATION.md](../../docs/PROFESSIONAL-TRANSLATION.md)
- [docs/TRANSLATION-ENGINE-HANDOFF.md](../../docs/TRANSLATION-ENGINE-HANDOFF.md)
- [docs/archive/2026-10-23-professional-engine-v2-evidence.json](../../docs/archive/2026-10-23-professional-engine-v2-evidence.json)
- [docs/archive/2026-10-23-professional-engine-v2.md](../../docs/archive/2026-10-23-professional-engine-v2.md)
- [docs/archive/README.md](../../docs/archive/README.md)
- [lib/cache.js](../../lib/cache.js)
- [lib/config.js](../../lib/config.js)
- [lib/i18n.js](../../lib/i18n.js)
- [lib/medical/data/en-zh-CN.js](../../lib/medical/data/en-zh-CN.js)
- [lib/medical/profile.js](../../lib/medical/profile.js)
- [lib/medical/schema.js](../../lib/medical/schema.js)
- [lib/medical/sources.js](../../lib/medical/sources.js)
- [lib/medical/terminology.js](../../lib/medical/terminology.js)
- [lib/professional/context.js](../../lib/professional/context.js)
- [lib/professional/engine.js](../../lib/professional/engine.js)
- [lib/professional/profiles/medical/index.js](../../lib/professional/profiles/medical/index.js)
- [lib/professional/profiles/medical/validators.js](../../lib/professional/profiles/medical/validators.js)
- [lib/professional/registry.js](../../lib/professional/registry.js)
- [lib/professional/review.js](../../lib/professional/review.js)
- [lib/professional/terminology.js](../../lib/professional/terminology.js)
- [lib/professional/validation.js](../../lib/professional/validation.js)
- [lib/prompt.js](../../lib/prompt.js)
- [lib/provider.js](../../lib/provider.js)
- [options/index.html](../../options/index.html)
- [options/options.js](../../options/options.js)
- [popup/popup.js](../../popup/popup.js)
- [selftest/index.html](../../selftest/index.html)
- [selftest/inline-layout.js](../../selftest/inline-layout.js)
- [selftest/test.js](../../selftest/test.js)
- [test/config.test.mjs](../../test/config.test.mjs)
- [test/content-main.test.mjs](../../test/content-main.test.mjs)
- [test/fixtures/medical-quality-samples.json](../../test/fixtures/medical-quality-samples.json)
- [test/i18n.test.mjs](../../test/i18n.test.mjs)
- [test/medical-evaluation.test.mjs](../../test/medical-evaluation.test.mjs)
- [test/medical.test.mjs](../../test/medical.test.mjs)
- [test/professional-config-storage.test.mjs](../../test/professional-config-storage.test.mjs)
- [test/professional-engine.test.mjs](../../test/professional-engine.test.mjs)
- [test/professional-pipeline.test.mjs](../../test/professional-pipeline.test.mjs)
- [test/professional-validation.test.mjs](../../test/professional-validation.test.mjs)
- [test/translate-pipeline.test.mjs](../../test/translate-pipeline.test.mjs)
- [tools/e2e-extension.mjs](../../tools/e2e-extension.mjs)
- [tools/e2e-inline-layout.mjs](../../tools/e2e-inline-layout.mjs)
- [tools/evaluate-medical.mjs](../../tools/evaluate-medical.mjs)
