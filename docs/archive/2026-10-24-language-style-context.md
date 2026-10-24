# 自定义目标语言、趣味风格与 AI 精翻（开发报告）

> **已归档**：这是一次性开发记录，不是当前操作手册。配置项、消息协议与发布流程的权威说明在 [HANDOFF](../../HANDOFF.md) 和 [AGENTS](../../AGENTS.md)；隐私边界见 [PRIVACY](../../PRIVACY.md)。本分支基于 **0.11.7**（origin/main `a909ec5`），没有修改扩展版本号，也没有合并 0.12.0 的 DOM 保真工作。

## 1. 基线与工作树

| 项 | 值 |
|---|---|
| 基线 | `origin/main` @ `a909ec5`（release: 0.11.7） |
| 分支 | `feature/language-style-context` |
| 工作树 | `/Users/apxs/Documents/Claude-workspace/_worktrees/rimfox-language-style-context` |
| 版本号 | `manifest.json` / `content/core.js` / `package.json` 均保持 `0.11.7` |
| 配置版本 | `CONFIG_VERSION = 8`（只新增字段；不清缓存、不覆盖旧值） |
| 本地提交 | `a229900`（功能实现与测试）+ `de0d544`（配置版本文档同步）；未 push |
| 隔离 | 未修改 `edge-bilingual` 的 0.12.0 工作树、未 push、未创建 Release、未合并 |

开发前基线：Node 测试全绿、离线自检全部通过。开发完成后同一套检查见 §7；本轮新增了自检用例。

## 2. 功能与实现

### A. 自定义目标语言

- 内置 `LANGUAGES` 不变；用户语言独立存 `customLanguages: [{id, name, code?, note?}]`。
- `id` 是稳定内部身份（`cl_…`），不是 BCP 47；有标准代码时另存规范化的 `code`。
- `lib/config.js` 新增：
  - `canonicalLanguageTag()`：只接受可被 `Intl.getCanonicalLocales` 规范化的标签；拒绝 `x-…` 私有标签、`und`、超长和乱写。
  - `normalizeCustomLanguages()` / `customLanguageError()`：名称 40、代码 35、说明 300 字符上限，最多 20 种；清洗控制字符和 `<>`，去重名称 / 代码 / id，拒绝与内置语言重名或重码。
  - `languageInfoFor()` / `languageOptions()`：统一提供 `label / code / detect / script / cjk`；内置与自定义在 Popup、Options 使用同一份显示名。
  - `normalizeTargetLang()` / `normalizeInputTarget()`：删除正在使用的语言时回退到 `zh-CN` / `auto`，不留空值或无效值。
  - `customLanguageFingerprint()`：名称 / 代码 / 说明进入缓存身份；内置语言不追加，旧缓存键逐字不变。
  - `resolveInputTarget(pref, pageLang, customLanguages)`：支持自定义 id、标准代码和页面语言。
  - `pickImportedConfig(raw, {currentLanguages})`：严格校验不可信导入；语言按 id 合并，本机独有语言不被一次导入清掉。
- 内容侧：
  - `config:get` 下发 `activeLanguage` 与 `languages`；内容脚本把内部 id 与 BCP 47 code 分开。
  - `looksLikeTarget` / `isMostlyTargetLanguage` 只在高置信度 `detect`（zh / ja / ko / en）时跳过；`yue`、`lzh`、`wuu` 和未知代码一律 `none`，宁可多翻。
  - `translationSeps` 对自定义 CJK 语言不加空格；没有代码的虚构语言保留原文切点的空白形态。
  - 方向 / 字体 / `lang` 属性只使用有效 code；没有 code 时不伪造标签。中文系自定义语言按 script 子标签选择繁 / 简字体档案。
  - 自定义语言的代码变化会触发重建（方向 / 字体变了）；只改名称 / 说明不立即重发请求，下一次明确翻译或重译时使用新定义（缓存指纹已变）。
- UI：设置页新增自定义语言管理（新增 / 编辑 / 删除 / 展示），随全局「保存」落盘；导入导出沿用配置 JSON；删除正在使用的语言会明确提示回退。用户名称 / 说明用 `textContent` 展示，并标记 `data-i18n-skip`，不会被界面词典改写。

### B. 趣味模式不再误触翻译

- 内容脚本状态拆成：
  - `style`：当前页面**实际生效**的风格；
  - `selectedStyle`：用户在下拉框里**选中但尚未应用**的风格。
- `dt:setStyle` 现在只更新 `selectedStyle`：不翻译、不重翻、不取消在途请求、不清缓存、不打开翻译、不写配置。
- `enable()`（明确开始翻译）和 `dt:retranslate`（明确重翻）才把 `selectedStyle` 复制到 `style`，并按当时配置快照强度。
- 翻译中的动态补翻、懒翻译和字幕继续使用 `style`，不会因为弹窗里的待应用选择突然换文风。
- Popup 显示 `selectedStyle`；关闭再打开仍从内容脚本状态读回。原下拉框保留，没有新增确认按钮或弹窗，只在 tooltip 里说明「下次翻译 / 重译生效」。
- 单页生命周期：还原（关闭翻译）会重置已应用和待应用风格；页面重载重置；切换标签页互不影响。规则已写进测试与 HANDOFF 消息协议。

### C. 傲娇猫娘

- 保留内部 id `catgirl`，显示名改为「傲娇猫娘」；不创建重复模式。
- 提示词升级为有独立性格的角色表达：允许有限的文学化、口语化、角色化改写、少量自称 / 撒娇 / 傲娇转折 / 轻微吐槽；要求不要机械地每句加「喵」，不要套固定模板，非中文目标语言使用当地对应口吻。
- 内容边界写进提示词：数字、日期、剂量、引用、价格、代码、URL、专有名词、研究结果和客观事实不得捏造或替换；医疗 / 法律 / 金融 / 严重安全警告采用保守表达；新闻 / 学术正文保持事实关系、否定、因果和证据强弱；不得色情低俗。
- 风格提示词版本 `STYLE_PROMPT_VERSION = 2`；旧的猫娘 / 文言文译文的缓存键不含该版本，不会被新角色复用（旧条目随容量自然淘汰，不清全站缓存）。

### D. 趣味风格强度

- 配置 `funIntensity: light | standard | exaggerated`，默认 `standard`。
- 强度只在提示词层实现（风格本体 + 强度说明），不靠 temperature；风格自带 temperature 仍按原值（猫娘 0.8，文言文 0.5），不支持 temperature 的提供商不受影响。
- 只对非 `plain` 风格生效；普通翻译即使配置夸张强度，提示词也逐字不变（有 golden 测试）。
- 设置页新增三段式强度控件；保存不会立即重译。内容脚本在明确开始 / 重翻时快照强度，动态补翻沿用该快照，避免同页两种强度。
- 缓存身份加入 `styleFingerprint(style, intensity)`；普通风格不追加，旧普通缓存键不变。

### E. AI 精翻（可选）

- 配置 `aiContextEnabled`，默认关闭；设置页明确提示会发送有限上下文、可能增加输入 Token，但默认不额外发起复核请求，也不会自动开启严格质量复核。
- 复用现有 `lib/professional/context.js` 规范化与 `content/main.js` 的文档上下文采集，新增：
  - `lib/ai-context.js`：预算裁剪、提示词、指纹、统计；上限 1600 字符（JSON），超限先丢相邻段落，再丢缩写 / 章节。
  - 同文章容器内、批次外、可见的相邻正文块；过滤导航、侧栏、表单、可编辑草稿、广告 / 评论容器、隐藏内容、嵌套 article；最多 4 段 / 900 字符；批次里已有的段落不重复。
  - 标题 / 章节 / 缩写 / 相邻段落都作为「不可信参考数据」用 JSON 编码进入提示词，并明确不得执行、不得据此增补事实、不得改变目标语言 / 输出格式 / 条数 / 保留标记。
- 上下文并入**同一次正常翻译请求**，不额外调用模型；医学 + AI 同时开启时只出现一份上下文块（专业 profile 自己带的那份）。
- 隐私脱敏开启时，整段上下文（含标题 / 章节 / 相邻段落）都不发送，因为无法保证这些内容也完成同样的脱敏；响应记录 `context.omitted = 'privacy'`。诊断只记录模式 / 字符数 / 条数，不记录上下文正文。
- 缓存身份：
  - 关闭：不追加任何段，继续复用 0.11.7 普通缓存；
  - 开启：追加 `ai-v1:on:<上下文指纹>`，不会误用未带上下文的普通条目；
  - 上下文只按本次实际参与翻译的内容计算；状态 / 标题 / 相邻段落变化会换键，无关页面变化不会让整页一起失效。
- 设置页保存开关 / 强度不会重启正在进行的整页翻译；已完成的译文也不会因为刚勾选 AI 精翻就立即重发。

## 3. 主要修改文件

- 配置 / 提示词 / 缓存：`lib/config.js`、`lib/prompt.js`、`lib/cache.js`、`lib/ai-context.js`（新增）、`lib/professional/context.js`。
- 后台：`background.js`（语言 / 风格 / 强度 / AI 上下文身份、隐私门、响应状态）。
- 内容脚本：`content/core.js`、`content/main.js`、`content/direction.js`、`content/dom.js`、`content/subtitles.js`、`content/selection.js`、`content/pip.js`。
- 界面：`options/index.html`、`options/options.js`、`options/options.css`、`options/ui.js`、`popup/index.html`、`popup/popup.js`、`lib/i18n.js`。
- 测试 / 自检：`test/config.test.mjs`、`test/prompt.test.mjs`、`test/i18n.test.mjs`、`test/content-main.test.mjs`、`test/translate-pipeline.test.mjs`、`test/language-context.test.mjs`（新增）、`selftest/test.js`、`tools/e2e-extension.mjs`。
- 文档：`HANDOFF.md`、`PRIVACY.md`、`docs/privacy.en.md`、本文件与 `docs/archive/README.md`。

## 4. 兼容性与配置迁移

- 配置版本 8 只新增字段：`customLanguages`、`funIntensity`、`aiContextEnabled`；旧配置、术语表、服务商、Key、医学模式、质量等级都保留。
- 迁移前仍按原机制保留 `config_backup_v3`；不无条件清缓存，不覆盖已有设置。
- 内置语言 / 普通风格 / AI 关闭时缓存键逐字不变（有 literal 测试）。
- 自定义语言的名称 / 代码 / 说明、风格强度、AI 开关与上下文只影响实际相关条目的缓存身份。
- 删除正在使用的自定义语言回退到简体中文 / 跟随页面语言；弹窗停留在旧列表时会拒绝无效目标。
- 导入导出包含 `customLanguages`；导入逐条校验，坏条目报告但不落盘；按 id 合并，本机独有语言保留。
- 「恢复默认」只重置翻译 / 显示设置，不清空用户自定义语言。

## 5. Token 成本

- AI 精翻默认关闭：请求构造、费用、性能与 0.11.7 相同。
- AI 精翻开启：上下文最多 1600 个 JSON 字符（外加固定说明），只并入原有翻译请求；不增加模型调用轮次。长文章按批次发送局部上下文，不反复发送全文；同一批次里已有的段落不重复注入。实际 Token 取决于提供商分词和文章内容，没有用真实付费 API 做成本 A/B。
- 趣味强度：不增加请求；只有用户点击翻译 / 重译才按新强度请求一次。切换下拉框本身零请求。
- 自定义语言说明：仅在作为目标语言时随提示词发送，最长 300 字符。

## 6. 隐私与安全

- 上下文来自用户访问的网页，按不可信输入处理：数据段 + 防注入规则；不执行网页里的指令。
- 隐私脱敏开启时上下文整体丢弃（fail-closed），并记录降级；不把上下文、页面标题或正文写入普通诊断日志。
- 不新增作者服务器、云端上下文数据库或默认遥测。
- 自定义语言名称 / 说明是用户数据：展示用 `textContent`，提示词用 JSON 编码，且被 `data-i18n-skip` 排除在界面词典翻译之外。
- 诊断新增的 `experience` 只含风格 id、强度、上下文模式 / 字符数，不含正文。

## 7. 验证与证据

### 7.1 命令与结果

```bash
for f in test/*.test.mjs; do node "$f" || exit 1; done  # test/*.test.mjs 全绿
node test/language-context.test.mjs
node test/content-main.test.mjs
node test/translate-pipeline.test.mjs
# 离线自检（无头 Chrome，见 HANDOFF §7）全部通过
node tools/e2e-extension.mjs --browser <chrome-nosandbox-wrapper>  # 216 / 216
node tools/e2e-inline-layout.mjs                                     # 3 组视口 254 / 254 + 自检 260 / 260
```

- 既有输入框异步写回、术语并发收录、接口缓存隔离测试全部保留并通过；没有删除旧测试或把断言改成恒真。
- 新增自检覆盖：自定义语言高置信度才跳过、CJK 自定义语言分隔符、方向 / 字体使用 BCP 47 code 且内部 id 不进 `lang`。

### 7.2 三项指定证据

**第一，切换趣味模式时翻译请求数为零。**
`test/content-main.test.mjs` 的「趣味风格：选中但不应用 / 零请求」：
- 未翻译时 `dt:setStyle`：`translate` 消息数不变、无 `resume:set`、无重建；
- 已翻译页面 `dt:setStyle`：请求数仍为 1（只保留首次翻译），`style` 仍为 `plain`，`selectedStyle` 变为 `catgirl`；
- 翻译进行中 `dt:setStyle`：旧请求未取消，旧结果仍注入；
- 只有 `dt:retranslate` 后才出现第 2 次请求，且带 `style=catgirl, intensity=exaggerated`。

**第二，AI 精翻开启后向现有请求提供相关上下文，但默认不增加额外模型调用。**
`test/translate-pipeline.test.mjs` 的「AI 精翻：同一次请求带有限上下文，不增加请求」：
- 关闭时 1 次请求，`context.mode = off`；
- 开启后同一段文本 `calls.length === 1`，提示词包含 `AI 精翻参考上下文`、标题、相邻段落和防注入说明；
- 相同上下文第二次命中缓存（0 次请求），标题变化才重新请求；
- 隐私开启时同一测试断言 `context.omitted = privacy`，标题 / 章节 / 相邻段落都不在任何请求里；
- 医学 + AI 同时开启仍只有 1 次请求，且只有一份上下文块。

**第三，自定义语言完整经过设置、存储、请求、缓存和页面翻译流程。**
- 纯函数：`test/language-context.test.mjs` 覆盖清洗 / 校验 / 去重 / 上限 / 删除回退 / 导入导出 / 目标解析 / 指纹。
- 内容脚本：`test/content-main.test.mjs` 覆盖 `config:get -> activeLanguage`、`dt:setTarget` 回退、代码变化重建、名称 / 说明变化不立即重发。
- 后台真实管线：`test/translate-pipeline.test.mjs` 以自定义 id 发请求，断言目标语言行包含「粤语（香港） (yue-Hant-HK)」、说明 JSON 进入提示词、内部 `cl_` id 不出现在提示词、说明变化后缓存失效、输入框 `auto` 能按页面语言命中自定义语言。
- 完整扩展 E2E 在真实 Chrome 156 + 本地假 API 下通过（216 / 216）。此前「CDP 在 loadUnpacked 后关闭」是本机 Chrome sandbox 初始化问题；用只加 `--no-sandbox` 的浏览器包装脚本后稳定可跑。没有降低扩展自身权限或安全性。
- E2E 覆盖：自定义语言 UI 新增 / 保存 / 选择 / 弹窗同步 / 重开持久化 / 编辑 / 删除回退；自定义阿拉伯语 RTL；趣味风格切换与连续 5 次切换零请求；删除在用语言零请求与 pending 状态；AI 精翻上下文隔离、标题变化零请求、隐私 fail-closed。

### 7.3 QA 复测修复（本轮）

| 问题 | 修复前证据 | 修复后行为 / 证据 |
|---|---|---|
| AI 精翻改标题导致整页重翻 | QA 4 段文章改 document.title 额外 +4 次请求 | 改 title 0 次请求；只标记 `contextStale`；E2E「只改 document.title」PASS |
| 改 h2 导致整页重翻 | QA 改 h2 产生额外请求 | 只翻新章节本身（E2E 新 sent 仅 `Changed section heading`），已译正文不再请求；E2E PASS |
| 删除在用自定义语言立即重译 | QA 删除后 +2 次请求 | 删除后 0 次请求；`target=旧语言`、`configTarget=zh-CN`、`targetPending=true`；旧译文 lang 保持 `yue-Hant-HK`；动态补翻暂停；明确重译后才 +1 次并使用 zh-CN；E2E PASS |
| 英→阿 RTL E2E 红 1 | QA 200/201，直接注入 `targetLang:'ar'` 被归一化 | 改为正式注册自定义阿拉伯语后再设目标；E2E 216/216，RTL 与提示词 `العربية (ar)` 均 PASS |
| `adjacent` 重复标题 | QA 发现相邻上下文把标题当正文 | `collectAdjacentContext` 跳过 H1–H6；内容测试断言章节标题不在 adjacent |
| `contextStatus` 延迟一拍 | QA 状态要等下一次请求 | 配置广播时立即更新 mode / pending / privacy；内容测试覆盖开 / 关 |
| 无代码语言产生空 `data-dt-lang=""` | QA 观察到空属性 | `makeNode` 只在有 code 时写属性；自检覆盖无代码语言节点 |
| 交接报告测试文件数错误 | QA 指出写成 73，实际以 `test/*.test.mjs` 文件数为准 | 报告改为命令式说明，不再写会过期的数量 |
| 趣味 / AI 只有 Node 测试 | QA 指出浏览器覆盖不足 | E2E 新增：风格零请求 / 连续 5 次零请求、翻译中切风格不取消、删除语言零请求、AI 标题变化零请求、AI 隐私隔离、自定义阿语 RTL |

修复过程中先跑了一次旧 E2E（213 / 215，失败项正是上述 AI 标题两断言），修正后完整 E2E 为 216 / 216；失败到成功的日志保留在本机临时目录，不写入 QA 克隆。

## 8. 已知限制

- 无法高置信度识别 `yue` / `lzh` / `wuu` 等中文系语言与普通话的差异，因此这些自定义语言不会触发「已是目标语言」跳过；会多翻，但避免漏翻。
- 没有标准代码的自定义语言没有可靠的 RTL / 字体 / 语言标签信息：按 LTR、无字体适配、保留原文切点空白处理；需要方向或字体时请填写有效 BCP 47 代码。
- 自定义语言代码变化会整页重建（方向 / 字体变了）；只改名称 / 说明不立即重译，旧译文保留到下一次明确重译。
- 趣味风格是单页一次性状态：还原或重载后回到普通；弹窗关闭再打开会保留当前页的待应用选择。
- AI 上下文的可见性 / 正文归属是启发式：Shadow DOM、iframe、`<details>` 隐藏内容、懒加载评论可能漏过滤或漏采集；不发送整页全文。
- AI 上下文按批次参与缓存身份；同一段落在不同批次组合下可能得到不同缓存键，命中率会低于无上下文模式，这是为了避免「同一个键、不同提示词」。
- 医学模式在隐私脱敏开启时保持 0.11.7 的消息形态；后台专业引擎仍会把标题 / 章节上下文置空。AI 精翻在隐私开启时整体不发送上下文，也不采集快照或因标题变化触发重建。
- AI 精翻只改标题 / 章节时不再整页重译：只把旧上下文标记过期，用户明确重译后使用新上下文。医学专业模式仍保留原有「上下文变化后重建」行为。
- `targetLang:'ar'` 直接写入配置不是 0.11.7 的公开契约（旧导入白名单也只接受内置语言）；支持的路径是注册自定义阿拉伯语再选它。E2E 已改为走公开接口，没有放宽语言验证。
- 未使用真实付费 API 做质量或成本 A/B；不能用假模型结果宣称译文质量提升。需要验证时按相同模型 / 服务商 / 文章 / 参数做人工 A/B。
- 浏览器 e2e 受本机 Chrome 156 CDP 行为限制，见 §7.2。

## 9. 独立复核

两轮 read-only 独立复核（配置 / UI / 自定义语言；内容脚本 / 风格 / AI 上下文）没有发现阻断项或高风险问题。已修复的实质问题：

- `dt:setTarget` 先重新读取配置，再用最新的 `languages` 更新 `langInfo / targetCode / renderedLangSig` 后重建；避免第一轮用旧 code 渲染、广播到达后再整页重建一次。
- 语言元数据只在 `info.value === 当前 target` 时生效（`DT.targetInfo()`），防止弹窗切换与广播之间的窗口误用旧语言。
- AI 精翻 + 隐私开启时不再采集上下文快照，也不因标题 / 章节变化触发重建。
- 缓存命中时的目标语言校验改用 `languageInfo.code || target`。
- 字幕轨道身份加入 `targetCode`；编辑自定义语言代码会失效旧字幕译文。
- 字体启发式只对中文系语言应用繁 / 简 / 地区标签，`en-HK`、`ko-CN`、`ja-SG` 不会被误配成中文字体。
- 动态重建的设置页标签 / 按钮使用 `t()`；自定义语言名称 / 说明继续 `data-i18n-skip`。
- 自定义语言的名称 / 代码 / 说明整组声明为用户数据，其中出现的指令不得执行。
- 导入时若语言因重名或数量上限被丢弃，导入结果会明确报告数量。
- 诊断在 AI 开启但本次没有上下文时报告 `omitted: 'no-context'`，不再虚报字符数。

交接报告此前把 Node 测试数写成「73 个测试文件」；实际数量以 `test/*.test.mjs` 文件和命令输出为准，现已改为命令式说明，不再写会过期的数量。

复核同时确认：只改了 `test/config.test.mjs` 的配置版本期望（7→8），没有删除或弱化既有测试；`manifest.json` / `package.json` / `DT.VERSION` 仍为 0.11.7；diff 中没有密钥或无关文件。修复后再次请两位复核者只看剩余 blocker/high，均回复「no remaining blocker/high」。

## 10. 集成建议

- 本分支不占用 0.12.0 版本号，也未修改版本号；合并前先对照当时最新 `origin/main` 重新跑 Node、自检和浏览器 e2e。
- 与 0.12.0 的 DOM 保真工作集成时，重点回归 `content/dom.js` 的字体 key、`content/main.js` 的上下文采集与注入路径；两边都可能改这些文件。
- 在用户明确批准前不 push、不 merge、不 rebase 另一个 Agent 的分支、不创建 Release、不提审。
