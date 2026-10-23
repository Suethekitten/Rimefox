# 医学专业翻译模式

> 面向医学专业学生、科研人员、临床工作者和生命科学读者的**全局翻译模式**。
> 数据来源审计见 [MEDICAL-DATA-AUDIT.md](MEDICAL-DATA-AUDIT.md)；架构 / 消息协议见 [../HANDOFF.md](../HANDOFF.md)。

## 1. 边界

医学模式是**翻译提示词层**的专业模式，不是诊断系统、医疗器械或临床决策工具。它：

- 在现有普通 / 双语对照、仅译文、悬停、划词、输入框、YouTube 字幕管线之上，追加医学翻译约束和已审核术语；
- 不新增 API 请求、不新增服务商、不新增权限、不联网查询术语；
- 不会把整份词库塞进提示词，只注入本批真正命中的术语；
- 默认关闭；开启后是**全局配置**，跨站点、跨标签页生效；整页、划词、输入框、弹窗随手翻译和 YouTube 字幕都读同一份配置（输入框仍保持 noCache）。
- 开关变更会让已翻译页面按新配置重建；不会把普通译文和医学译文混在同一页。

未覆盖的术语不会假装存在：词库只收经过审核的核心概念，其余交给模型结合上下文翻译。医学规则仍然生效。

## 2. 界面与交互

### 设置页

- 位置：「翻译」页 → 「专业翻译」卡片 → 「医学专业模式」开关（<code>#medicalMode</code>）。
- 默认关闭；与设置页其他开关一样，点「保存」后写入 <code>config.medicalMode</code>。
- 导入 / 导出配置会保留该布尔值；旧配置没有这个字段时由 <code>mergeConfig(DEFAULTS, stored)</code> 补 <code>false</code>，不需要迁移版本。

### 弹窗

- 控制区中「医学专业模式」独占一行，复用现有 <code>switch switch-sm</code> 几何，不改变液态玻璃工具坞的尺寸 / 对齐。
- 开关直接保存全局配置；设置页、弹窗、网页悬浮入口读到的是同一份配置。
- 中英文界面文案在 <code>lib/i18n.js</code> 中维护。

### 已翻译页面

<code>content/main.js</code> 记录当前页面**实际用于翻译的医学模式**（<code>DT.state.renderedMedical</code>）。配置广播到达时：

- 只比较「当前已渲染译文用的模式」与「新配置」，不一致才 <code>startOver()</code>；首次加载不会因为默认值多重建一次；
- 翻译中切换会先 <code>cancelRun()</code>，作废在途请求，避免普通译文和医学译文混在同一页；
- 模式切换与「双语 / 仅译文」显示方式无关；两种显示方式共用同一套提示词和缓存隔离。

## 3. 词库

### 规模与来源

当前捆绑 **100 条**核心医学概念（<code>lib/medical/data/en-zh-CN.js</code>，词库版本 <code>MEDICAL_LEXICON_VERSION = '1'</code>）：

| 来源 | 条数 | 许可 | 方向 | 说明 |
|---|---:|---|---|---|
| <code>qitong/medical-literature-translation</code> | 44 | MIT | en↔zh | 统计 / 肿瘤 / 妇科肿瘤词表；44 条可用条目，3 条多译法 + 1 条 DNT 未纳入 |
| Wikidata 标签 + P486 (MeSH ID) | 56 | CC0 1.0 | en→zh | 常见疾病、药物、遗传、临床研究概念；中文标签人工规范化 |
| AIX-Text/TerminologyDataset | 0 | 声称 MIT，但仓库无 LICENSE | — | **未打包**；质量与上游来源不达标，只作为审计对象 |
| MeSH / HPO / UMLS | 0 | 各自条款 | — | 只使用 P486 ID 作为概念交叉引用，不打包数据文件 |

每条术语包含：<code>source</code>、<code>target</code>、<code>sourceLang</code>、<code>targetLang</code>、<code>domain</code>、<code>sourceId</code>、<code>status</code>、<code>reverse</code>，可选 <code>abbreviation</code>。

- <code>status</code> 只允许 <code>reviewed</code>（Wikidata 人工规范化）或 <code>reviewed-upstream</code>（MIT 词表）。
- <code>reverse: true</code> 只给 MIT 声明双向的词表；Wikidata 不自动反转。
- 不收录高歧义单字 / 缩写：<code>lead</code>、<code>culture</code>、<code>lesion</code>、<code>positive</code>、<code>negative</code>、<code>significant</code>、<code>control</code>、<code>stroke</code>、<code>safety</code>；<code>OR</code> / <code>HR</code> / <code>RR</code> / <code>CI</code> 不作为独立术语。
- 用户自定义术语永远优先：同一源词被用户术语覆盖时，医学词条不注入、也不进医学缓存指纹。

许可证、版权、版本、排除理由和重新审计步骤见 [MEDICAL-DATA-AUDIT.md](MEDICAL-DATA-AUDIT.md) 与 [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。

### 匹配

<code>lib/medical/terminology.js</code>：

- 英文术语按词边界匹配，支持常见单复数（<code>trial/trials</code>、<code>diagnosis/diagnoses</code> 等）；中文按子串匹配。
- 长术语优先：<code>epithelial ovarian cancer</code> 命中时不再让 <code>ovarian cancer</code> 重复占额度。
- 目标语言：
  - <code>zh-CN</code> / <code>zh-Hans</code> / <code>zh</code> → en→zh，最多注入 12 条；
  - <code>en</code> → zh→en，只使用 MIT 双向条目；
  - 其他目标语言 → **不注入术语**，只保留医学规则，不伪造完整双语词典。
- 术语预算：用户术语最多 20 条；医学术语填充剩余额度，自身上限 12 条。用户命中多时医学词条自动让位。

## 4. 提示词

<code>lib/prompt.js</code> 的 <code>systemPrompt(..., medical)</code> 在保留标记之后、术语表之前插入：

1. <code>【医学专业翻译要求】</code>（<code>lib/medical/profile.js</code>）：术语规范、相关≠因果、统计量区分、否定 / 条件 / 可能性 / 证据等级、剂量 / 单位 / 数值 / p 值 / CI / 基因符号 / 引用标记、不得增删临床结论、不改变目标语言和 JSON 协议。
2. 本批命中的医学术语（最多 12 条；用户术语在后面的术语表里，更靠近末尾，优先级更高）。
3. 用户术语表（原有逻辑）。
4. 用户自定义提示词（原有逻辑，仍在最后）。

医学模式**不是** <code>STYLES</code> 条目：它不替换「已经是目标语言」规则，不会把中文医学页面重新翻译；趣味风格可以叠加，但提示词明确「风格只影响非专业措辞，医学事实 / 数字 / 统计 / 否定 / 不确定性 / 因果 / 剂量 / 风险以准确性优先」。

关闭医学模式时不向提示词 push 任何行，普通提示词保持逐字不变（有单测锁定）。

### 为什么是静态 import

MV3 的 <code>ServiceWorkerGlobalScope</code> 按 HTML 规范**禁止 <code>import()</code>**（实际 Chrome 会抛 <code>TypeError: import() is disallowed on ServiceWorkerGlobalScope</code>）。因此 <code>background.js</code> 直接静态 import <code>lib/medical/terminology.js</code>：

- 词库约 28KB / 100 条，随 service worker 启动加载一次；
- 关闭医学模式时只是不参与匹配，不增加请求，也不会把词库放进提示词；
- 不依赖网络或第三方 CDN，不需要新增权限。

## 5. 缓存

<code>lib/cache.js</code> 的 <code>makeKey(scope, text)</code> 在 <code>prompt</code> 之后追加一个可选的 <code>medical</code> 段：

<pre><code>if (s.prompt) parts.push(s.prompt);
if (s.medical) parts.push(s.medical);</code></pre>

- **关闭医学模式**：不追加，旧普通缓存键逐字不变；不 bump <code>SCHEMA</code>、不清缓存。
- **开启医学模式**：<code>medical</code> = <code>m&lt;profileVersion&gt;:&lt;lexiconVersion&gt;:&lt;命中术语指纹 | none&gt;</code>，或目标语言不支持术语时 <code>...:rules</code>。
- 只把**本段原文真正命中的医学术语**放进指纹；改一条医学词只让含该词的段落失效。
- 用户术语的命中指纹仍在 <code>glossary</code> 段；用户覆盖医学词会同时改变两段。
- <code>alignCache</code> 与 <code>inflight</code> 复用同一个 key，自动隔离。
- 普通 / 医学译文互不串用；词库或规则版本变化只让医学 key 失效。

## 6. 测试

<pre><code>for f in test/*.test.mjs; do node "$f" || exit 1; done
node tools/e2e-extension.mjs --browser /path/to/chrome-wrapper
node tools/e2e-extension.mjs --medical-only --browser /path/to/chrome-wrapper</code></pre>

覆盖：

- <code>test/medical.test.mjs</code>：100 条数据完整性、来源 / 许可、方向、单复数、长术语、用户优先级、其他语言、缩写不误匹配、指纹、提示词、缓存键、默认值。
- <code>test/translate-pipeline.test.mjs</code>：真实 <code>background.js</code> + 假 fetch：医学模式只发一次请求、系统提示词含规则 / 术语、普通 / 医学缓存隔离、关闭后普通缓存仍命中、用户术语覆盖。
- <code>test/content-main.test.mjs</code>：配置广播触发整页重建；模式未变不重复重建。
- <code>tools/e2e-extension.mjs</code>：设置页 / 弹窗开关、真实 Chrome 中的重建、医学请求、缓存命中；<code>--medical-only</code> 可单独跑。
- 既有测试继续覆盖普通模式、<code>align</code>、保留标记、隐私、悬停、字幕、Shadow DOM 等；医学模式关闭时不应出现任何提示词差异。

**未验证**：真实付费模型上的医学译文质量 / 术语遵守率；本轮只用假接口验证请求与提示词结构。不能把「离线测试通过」当成临床准确性证明。

## 7. 性能

以当前版本测量（具体数字会随提示词和词库版本变化）：

- 普通系统提示词约 0.9KB；加医学规则约 1.6KB；再加最多 12 条术语约 2.2KB。只有命中术语的批次才增加术语段。
- 词库 JS 文件约 28KB；不进入提示词、不进入缓存内容、不进入网络请求。
- 请求数不增加：术语匹配和提示词拼装都在原有的一次 <code>translateBatchWithRetry</code> 内完成。
- 目标语言不支持英汉术语时只增加规则段，不做无效匹配。

## 8. 已知限制

- 不是完整医学词典，覆盖率有限；未命中的术语依赖模型上下文。
- Wikidata 中文标签是社区数据，不是 MeSH / 术语在线 / CMeSH 官方中文词表；不能把当前词条当作临床标准。
- AIX-Text 数据集未纳入；若未来要扩充，必须先解决许可证与上游来源问题。
- 只对 <code>en</code> / <code>zh-CN</code> / <code>zh-Hans</code> / <code>zh</code> 做术语匹配；其他语言只有规则。
- 全局开关，没有按站点 / 按段落开关；切换会让当前页整页重建并重新请求未缓存的段落。
- 未做真实模型质量验收；正式发版前建议在获得授权的真实 API 上抽样对比普通 / 医学模式。
- 趣味风格 + 医学模式的最终效果依赖模型是否遵守「准确性优先」；提示词已明确，但不能保证所有弱模型。

## 9. 维护

新增 / 修改术语：

1. 先更新 [MEDICAL-DATA-AUDIT.md](MEDICAL-DATA-AUDIT.md) 和 <code>lib/medical/sources.js</code>（来源、版本、许可、日期）。
2. 改 <code>lib/medical/data/en-zh-CN.js</code>，只收方向明确、人工审核的条目；不要塞机器批量翻译。
3. 如果语义或方向改变，更新 <code>MEDICAL_LEXICON_VERSION</code>；缓存只失效医学 key。
4. 运行全部 Node 单测和 <code>--medical-only</code> E2E；真实页面再验证设置页、弹窗和普通文章页。
5. 版本号、CHANGELOG、推送仍按 [AGENTS.md](../AGENTS.md) 的发布流程，不在本文档里定版本。
