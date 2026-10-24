# Professional Translation Engine v2

> 运行时专业策略的唯一说明。数据与许可事实见 [MEDICAL-DATA-AUDIT.md](MEDICAL-DATA-AUDIT.md)，DOM 事务与安全渲染见 [TRANSLATION-ENGINE-HANDOFF.md](TRANSLATION-ENGINE-HANDOFF.md)。本地实施与验收记录见 [开发报告](archive/2026-10-23-professional-engine-v2.md)。

## 架构与边界

专业引擎只处理翻译要求、术语、文档上下文、质量检查和缓存身份。它不操作网页 DOM，不选择另一套模型，不新增权限或运行时术语查询。整页、弹窗、划词、输入框和字幕继续通过同一个 `translate` 后台路由和用户已有的提供商/API。正文双语、仅译文、悬停、引用和 Ruby 继续由通用 DOM 引擎处理。

| 模块 | 职责 |
|---|---|
| `lib/professional/registry.js` | 静态注册通用和医学配置；校验接口与重复 ID |
| `lib/professional/engine.js` | 每个 translate 消息建立专业策略；组合提示词、逐条缓存指纹和本地校验 |
| `lib/professional/terminology.js` | 专业术语预算与用户术语优先级 |
| `lib/professional/context.js` | 不可信页面元数据规范化、批次裁剪、上下文提示与指纹 |
| `lib/professional/validation.js` | 质量等级、校验器调用、异常报告与策略版本 |
| `lib/professional/review.js` | 严格复核的共享预算与候选译文接纳规则，不自行联网 |
| `lib/professional/profiles/medical/index.js` | 现有 `lib/medical/` 的适配器，连接规则、术语和医学校验器 |
| `lib/professional/profiles/medical/validators.js` | 医学确定性检查与保守的语义风险线索 |
| `background.js` | 沿用批处理、脱敏、闸门、重试和缓存；负责有限的额外复核请求 |

配置包接口是同步纯函数：

```js
{
  id, version, name, supportedDirections,
  termLimit,
  buildInstructions(context),
  matchTerms(texts, target, {limit, excludeSources}),
  formatTerms(hits), // 可选；缺省使用 source → target
  buildContext(documentContext),
  validate(source, translation, context),
  getFingerprint({text, target, excludeSources, context, options})
}
```

`supportedDirections` 描述已审核的术语方向，具体匹配由配置包负责；医学对其他目标语言仍提供准确性规则，但不注入不存在的双语词表。通用配置不追加专业提示词、专业上下文或专业缓存段。

新增专业时，实现独立纯模块并在 Registry 用静态 import 注册，不必修改后台翻译核心、提示词核心或 DOM 引擎。先在独立 Registry 中测试，再明确决定是否加入界面及配置白名单。`test/professional-engine.test.mjs` 的测试专用法律配置演示了真实规则、术语、缓存身份和校验接入；产品没有空的法律/金融按钮。

所有生产配置使用静态 import，兼容 MV3 Service Worker；不使用动态 import、CDN、eval 或远程加载专业包。原 `medicalPrompt`、`matchMedicalTerms`、`medicalFingerprintFor` 等兼容接口保留。

## 配置和升级

```js
professionalProfile: 'general', // 当前界面仅 general / medical
professionalOptions: {
  quality: 'balanced', // fast / balanced / strict
  subdomain: 'auto',
  maxReviewRequests: 1 // 0–3，每个 translate 消息所有内部批次共享
},
medicalMode: false // 与主字段同步的旧版兼容别名
```

配置结构迁移到 v7，扩展版本不随此变更。旧 `medicalMode:true` 迁移为医学；无医学配置的用户保持通用。新 profile 显式提供时优先；旧弹窗只调用 `saveConfig({medicalMode:...})` 仍能开关。部分质量选项保存会保留未改的子选项。

迁移使用原来的读写、备份及深合并机制，保留提供商、自定义 API、Key、用户术语、显示偏好与缓存。导入导出支持两套字段；无效专业 ID 不进入界面或 Registry。设置页保留医学开关，新增质量等级、费用提示与复核次数。`subdomain:auto` 不等于已经做了语义领域识别：当前网页采集主要提供标题、章节与显式缩写；明确传入的子领域才追加相应规则。

专业策略变化会作废在途旧结果，撤销现有渲染并按新策略重建；比较的是页面实际使用的策略。显示模式仍独立。

## 医学规则和术语

医学 v2 规则按忠实性、证据、不确定性、临床研究/统计、剂量药理、病理解剖/分子符号分层维护。共同规则组合一次，只有明确子领域才追加对应短规则。重点区分相关与因果、发病与患病、死亡与患病、事件与反应、统计与临床意义、RR/OR/HR、敏感度与特异度、疑似/确诊/可能/很可能、may/might/should/must，以及“无显著差异”与“无差异”。不增加临床结论或治疗建议，不换算剂量、不舍入数值。

词库保留可追溯的来源记录，schema 增加稳定 ID、版本、子领域、别名和上下文说明；含义存疑条目可用 `matchEnabled:false` 隔离。数据审计、有效覆盖、双向许可与排除理由以 [数据审计](MEDICAL-DATA-AUDIT.md) 为准。未以机器批量翻译扩充词数，未打包受限的 MedDRA、SNOMED CT 或其他数据库。当前中文译名不能声称为 MeSH 官方中文标准。

术语在本地按方向匹配，长词优先、避免重叠；英文有边界及受控单复数/拼写别名。用户术语优先于内置词；专业词只填充用户术语剩下的提示预算。只注入本批实际命中的条目。中文反向只使用明确许可且审核支持反向的词，不能自动反转整个词表；歧义缩写不作为强制替换词。匹配提示不是语义理解，也不会直接替换网页文字。

用户词条可提供可选语境说明；其数据、提示词和缓存兼容规则见 [术语表帮助](GLOSSARY.md)。有说明也保留用户优先级与同源内置词排除，适用条件由模型结合已提供的上下文判断。

## 文档上下文

`content/main.js` 在本地采集当前论文容器中的标题、有限的 h1–h3、当前批次和紧邻块中可靠的 `long name (ABC)` 定义。候选长名需与缩写字符对应；冲突定义被丢弃，多个 article 混批时不混用它们的章节/缩写。不保存跨论文缩写字典，不发送正文全文。

后台再次规范化为可选的 `title/headings/abbreviations/documentType/subdomain`，限制长度和数量。只保留当前批次实际出现的缩写，逐段缓存指纹也只包含该段相关定义。上下文以“仅供消歧的数据”进入提示词，不执行网页中的指令，不允许据此增补事实。启用隐私脱敏时不发送页面元数据，避免标题/章节绕过脱敏；原文和候选译文的复核同样先脱敏并 fail-closed 恢复。

标题/章节变化及页面路由生命周期会重建相应翻译上下文。未明确识别的类型/专业/缩写留空，不能把启发式猜测当成可靠定义。复杂缩写、相隔较远的定义及全文级消歧尚未覆盖。

## 质量策略和费用

| 等级 | 行为 | 额外模型请求 |
|---|---|---|
| 快速 `fast` | 专业规则、命中术语、相关上下文；不运行本地校验 | 无 |
| 标准 `balanced`（默认） | 快速基础上本地确定性检查与可疑语义线索 | 无 |
| 严格 `strict`（默认关闭） | 仅对本地检测到 high 风险的片段定向复核 | 最多配置的次数 |

返回值新增与 `results` 同下标的 `validations`；原字符串/空串/null 协议不变：

```js
{
  status: 'pass' | 'review' | 'error',
  checked: true | false,
  quality, version,
  issues: [{code, severity: 'high'|'medium'|'low', kind: 'deterministic'|'semantic', message}],
  review: {attempted, accepted, reason, expertReviewed: false} // 发生或被限额时可选
}
```

`pass` 只表示没有触发有限规则，`checked:false` 不代表已验证。确定性高风险差异为 `error`；语义线索与无法判断的对应关系为 `review`。校验器异常也报告审查，不能冒充通过。标准模式不自动纠正医学事实，保留模型译文并报告疑点。页面状态/弹窗显示待核对段落，诊断保留当前策略与提示。

确定性检查包括数值多重集合（不依出现顺序）、百分比、p 值与运算符、CI 端点、剂量与单位、可解析的人数/百分比局部对应、研究标识符、引用/隐私占位标记、受控的医学符号。考虑全角、范围、千分位及常见等价表示。表达无法解析或组别归属不能可靠验证时仅要求审查；保留相同数值集合不能证明两组归属正确。

语义检查关注部分否定/条件/不确定性遗漏、因果强化、统计结论强化、风险方向颠倒，仅作为线索。复杂否定作用域、诊断名误译、结论增删及未知语言仍可能漏检；测试明确记录这些边界。

严格模式预算在发送前同步扣减，同一 translate 消息的并发内部批次共享，不因拆批重置。一次复核只允许一次 HTTP，不触发提供商内部思考参数回退、空输出重试或递归复核。0 次关闭额外复核；整页可能发送多个 translate 消息，所以此限额不是整页总费用上限。

复核使用当前服务商/API和目标语言，只发送高风险片段及候选译文。无响应、无改善、格式错误、语言错误、引用标记错误或隐私恢复失败时保留原译文并保留风险。仅当候选通过现有内容护栏、没有新的高风险确定性差异且本地风险减少时接纳；替换后丢弃旧句子对齐偏移。模型意见不是医学专家审核，也不能保证消除未被规则覆盖的错误。

缓存命中会重新运行本地检查，不再次支付复核费用；未解决的风险也不会在每次补扫中无限复核。按需重新请求须由用户明确重译/绕过缓存或更改策略。

## 缓存与兼容性

三层缓存继续存字符串，不更改 `SCHEMA`，不全局清理。通用模式键与旧版逐字相同。专业键额外包含配置 ID/版本、词库版本、该段有效命中术语、相关文档上下文、质量检查版本/等级/严格预算与子领域。用户术语指纹仍单独存在；添加无关术语不使无关段落失效。在途去重、句子对齐旁路使用同一键。旧医学条目不会充当 v2 已检查译文，保留在缓存中随容量自然淘汰；关闭专业模式仍可命中原通用缓存。

## 验证和维护

```bash
node --test test/*.test.mjs
for f in test/*.test.mjs; do node "$f" || exit 1; done
node tools/evaluate-medical.mjs
node tools/evaluate-medical.mjs --input /path/to/saved-results.json
node tools/e2e-extension.mjs
node tools/e2e-inline-layout.mjs
```

离线自检命令见 [HANDOFF §7](../HANDOFF.md#7-调试手册)。所有浏览器自动化使用本地 fixture、无头 Chrome 和假接口。医学样本是明确标记 `mock` 的自拟论文风格片段；术语精确命中数/规则风险数只用于检查评测工具，不证明真实模式提升。真实模型输出需记录 model/date/provenance，脚本仅读取已保存结果，不自动调用 API。没有真实付费模型或专家对照的证据，不能宣称临床准确率提升。

新增专业或规则时补 Registry、方向、用户优先、提示词、指纹、正确/错误样本与失败降级测试；同步维护版本和数据来源。修改 DOM 必须独立跑自检和布局回归。发布权限继续按 [AGENTS.md](../AGENTS.md)，本任务不修改扩展版本或发布。
