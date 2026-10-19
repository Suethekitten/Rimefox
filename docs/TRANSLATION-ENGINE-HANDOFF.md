# 翻译引擎技术交接

> 给接手翻译引擎的 Agent / 协作者。读完 [AGENTS.md](../AGENTS.md)、[HANDOFF.md](../HANDOFF.md) 和本文，就能直接继续，不需要重新调查整条管线。
> 项目全局交接（架构总览、消息协议、发版流程、踩过的坑）在 HANDOFF.md；本文只管**翻译引擎**：从网页上收集文字到译文写回、还原的整条链路，以及接下来往哪走。
> 最近更新：0.8.9（基于 v0.8.8 `77479ca`；第 2 节仍是 0.8.7 的引擎改动，0.8.9 的改动摘要在第 0 节，细节见 HANDOFF §14）。

---

## 0. 一页结论

- Rimefox 的定位是**轻量、快速、低成本**的网页翻译：一个翻译单元 = 网页上的一个段落 / 元素，批量发给用户自己的 API，结果按条写回原位。不做全书预扫描、梗概、人物分析、额外的审校调用。
- 0.8.7 修了 Pixiv 中译英偶发的字面 `\n`：根因在**模型回包**（多转义一层换行），被**解析层**原样放过、被**缓存**固化；DOM 层只是如实显示。修复在解析之后、写缓存之前，以及读缓存之后（旧坏数据当场修好）。
- 同时做了几项低风险的引擎内部优化（解析容错、写入前校验、长段落无损切分、按目标语言拼接），全部有离线测试；**没有**用真实模型验证译文质量，不能说「翻译质量提升了」。
- 0.8.9（代码审查修复）：`parseArray` 按括号配对逐个找最外层数组，夹在正文里的纯数字数组（引注 `[1]`）不当答案；单条拆句按文字拼回（中日文不加字、其它加空格）；后台同一缓存键在途去重（`inflight`）；缓存分段落盘（只写脏段）；简繁区分（`DT.chineseScript`）；服务端 400 拒绝过的思考参数按 协议 + 地址 + 模型 记住不再发。都有离线测试，同样没有用真实模型验证质量。
- 轻量上下文、稳定映射、术语一致性、可恢复翻译只做了调研和设计，**没有实现**，见第 3 节。

---

## 1. 当前架构

### 1.1 一次翻译的完整流程

```
content script（网页里，classic script，ES5）                          service worker（background.js，ESM）
──────────────────────────────────────────                        ────────────────────────────────────
dom.js   DT.collectAll(accept)
         walk() 切分：容器下钻 / 段落整体；单元 = { el, text, own? }
         text = DT.unitText(el)：<br> 和 white-space:pre-* 的 \n 记成换行，行内折叠空白
main.js  accept()：skipText / looksLikeTarget（简繁按 DT.chineseScript 区分）/ settled / churn / 懒翻译距离 / 失败退避
         DT.splitLong(text, maxUnitChars=1200) → parts + parts.seps
         （每段都是原文原样子串；seps 记切点原有的分隔：'\n'、'\n\n'、' '、''）
         takeBatch()：按离屏幕距离排序，屏幕内 ≤3 条 / ≤500 字
         DT.send({ type:'translate', texts, target, style }) ───────►  handleTranslate(msg, sender)
                                                                       ├ 缓存查找：makeKey(scope, text)
                                                                       │   scope = 目标语言 / 风格 / 服务商:模型 / 域名 / 术语指纹 / 自定义提示词指纹
                                                                       │   命中 → normalizeTranslationBreaks + leaksWrapper（旧坏数据修好 / 当作未命中）
                                                                       ├ 同批重复文本合并（groups）
                                                                       ├ 在途去重：同一缓存键已有请求在翻 → 等它的 { value, error }（0.8.9）
                                                                       ├ 可选：本地脱敏 maskTexts（映射只在内存）
                                                                       ├ 切批（batchSize / maxCharsPerBatch）+ 并发闸门
                                                                       ├ translateBatchWithRetry：systemPrompt + JSON.stringify(texts)
                                                                       │   → provider.chat → parseArray(raw, n)
                                                                       │   条数不对 → 对半拆，拆到单条；一半失败保留另一半
                                                                       │   429 / 5xx / 网络 → 重试 3 次
                                                                       ├ 每条：restoreText（脱敏）→ normalizeTranslationBreaks
                                                                       │   → leaksWrapper（拦 → null）→ isRunaway（拦 → ''）→ cache.set
         ◄──────────────────────────────────────────────────────────── { ok, results: (string|''|null)[], cached, failed, error }
main.js  slots[k] = 结果；全部到齐 → DT.joinSlots(slots, DT.translationSeps(seps, target))
         DT.sourceChanged(unit)：等译文期间原文被网站改了 → 放弃这次注入
         近似重复闸门 isNearDuplicate → 跳过
dom.js   DT.inject(el, text, lang)
         ├ 双语：译文节点追加到源元素内部末尾（有换行加 .dt-lines）
         └ 替换（仅译文 / 控件 / 导航 / 定位元素）：injectOnly
             多行单元 → injectLines：第 i 行译文写回第 i 行，行数不符时顺序填、收起多余 <br>
             单行单元 → 整段写进第一个文本节点（含首字下沉拆分）
             记录 DT.replaced：{ el, nodes:[{node, value, wrote}], collapsed, src, lines, aligned }
hover.js 悬停对照：段落 → 行 → 句子三级，只认靠得住的一层（DT.replacedOf / matchDual / matchReplaced）
还原     DT.restore()：只还原「仍是我们写入的值」的文本节点，去掉译文节点和标记
         DT.releaseReplaced() / DT.refreshStale()：网站改写了内容 → 放回待翻译，不拿旧原文覆盖
```

### 1.2 模块职责

| 模块 | 负责 | 关键接口 |
|---|---|---|
| `content/core.js` | 文本工具、调度纯函数 | `normalizeText` / `normalizeLines` / `splitLines` / `splitLong` / `joinSlots` / `translationSeps` / `isNearDuplicate` / `batchLimits` / `nextRetry` |
| `content/dom.js` | 切分、注入、还原、诊断 | `collectAll` / `unitText` / `inject` / `replacedOf` / `sourceChanged` / `restore` / `releaseReplaced` / `refreshStale` / `areaOf` |
| `content/main.js` | 调度：收集 → 切段 → 取批 → 发送 → 拼回 → 注入；观察器、退避、看门狗 | `translatePage` 内部；`DT.control` |
| `content/hover.js` | 悬停对照、原文气泡 | `sentencesOf` / `linesOf` / `alignSentence` / `matchDual` / `matchReplaced` / `tipPreview` |
| `background.js` | 翻译中枢：缓存、合并、脱敏、切批、并发、重试、拆批、写入前校验 | `handleTranslate` / `translateBatchWithRetry` |
| `lib/prompt.js` | 系统提示词（纯函数） | `systemPrompt(target, style, glossaryHits, customPrompt, privacyMasked)` |
| `lib/parse.js` | 回包解析与校验（纯函数） | `parseArray` / `parseArrayFromReasoning` / `isRunaway` / `normalizeTranslationBreaks` / `leaksWrapper` / `escapeRawControls` / `stripTrailingCommas` |
| `lib/cache.js` | 三层缓存（内存 / storage.session / storage.local） | `makeKey` / `get` / `set` / `remove` / `clear` |
| `lib/usage.js` | 调试用量统计（只记数字） | `createUsageStats` |

### 1.3 不能随意改的接口（改了要同时改两端和测试）

- 消息 `translate`：入参 `{ texts: string[], target, style }`；返回 `results[i]` 为**字符串 = 译文**、`'' = 无需翻译`、`null = 失败`（内容侧按失败退避重试）。三种值的语义不能混。
- `results` 与 `texts` **按下标一一对应**：后台的合并、拆批、脱敏、校验都不能改变条数或顺序。
- 缓存键 `makeKey(scope, text)`：`SCHEMA` 改了等于清空所有用户缓存，**不要为提示词措辞的改动升级 SCHEMA**；能在读出时修好的就在读出时修（0.8.7 的做法）。
- `DT.splitLong` 返回数组 + `seps`；`DT.joinSlots(slots, seps)`；内容侧拼回前必须过 `DT.translationSeps(seps, target)`。
- `DT.replaced` 条目结构（`src` / `lines` / `aligned` / `collapsed`）：悬停和还原都依赖它。
- 送翻文本里的 `\n` 只代表「原文分行」：来自 `<br>` 或 `white-space: pre-*`。不要往送翻文本里塞别的标记。

---

## 2. 0.8.7 已完成

### 2.1 Pixiv 中译英字面 `\n`（必须修复项）

**真实原因**（用真实 background.js + 构造回包复现，见 `test/translate-pipeline.test.mjs`；又用真实扩展在真实 Pixiv 页面复现）：

1. 内容侧把多行段落（Pixiv 一个 `<p>` 里 span + `<br>`）记成带真换行的文本，`JSON.stringify` 后发给模型的是 `"…\n…"`。
2. 模型偶尔把换行**多转义一层**，回包是 `["…\\n…"]`。`JSON.parse` 之后译文里是「反斜杠 + n」两个字符。同类情况：单条请求直接回纯文本 `…\n…`、或回一个多转义的 JSON 字符串。0.8.4 的提示词写的是「换行符 \n」，可能促使模型把它当正文字符输出。
3. 解析层原样放过；**缓存把坏译文存下来**，之后命中仍是字面 `\n`。
4. DOM 层不是成因：内容侧只按真换行分行，字面 `\n` 原样显示；仅译文模式下行数对不上，整段落进第一行——就是用户看到的样子。

**修复**（解析之后、写缓存之前 + 读缓存之后，DOM 层没改）：

| 文件 | 改动 |
|---|---|
| `lib/parse.js` | 新增 `normalizeTranslationBreaks(source, translated)`：原文有任何反斜杠（代码 / 正则 / Windows 路径 / 转义说明）→ 原样；原文有分行 → 字面 `\n` 换成真换行后非空行数与原文一致才换；否则只有当每一处字面 `\n` 都是「句末标点 / 引号 / 中日韩字后面、紧跟新一句」或在首尾时才清掉（中日文之间不加字，其它换成空格），有一处像说明文字（`"\n"`、`` `\n` ``、后接小写字母 / 数字、`C:\new`）就整段不动。幂等。 |
| `background.js` | 每条译文：脱敏还原 → `normalizeTranslationBreaks` → `leaksWrapper` → `isRunaway` → 写缓存。缓存命中：同样规范化，改了就写回（修复旧坏数据，不清空缓存）；残留 JSON 包装的旧值删掉当作未命中。 |
| `lib/prompt.js` | 分行规则改成明确的 JSON 约束：「换行同样只写成 JSON 标准的 \n，不要写成 \\n，也不要把反斜杠和字母 n 当作正文」；条数 / 语言 / 防注入规则不变。提示词措辞不进缓存键，不会让旧缓存失效。 |
| `lib/cache.js` | 新增 `remove(key)`（内存层、磁盘层都删，照常延迟落盘）。 |

### 2.2 解析与写入前校验（参考 Agent Book Translate 的 json_healer / qa、Wenyi 的修复原则）

修补只做**确定性**的事（Wenyi：只去掉围栏或增删边界分隔符，不补造内容）：

- `stripTrailingCommas`：`["a","b",]` 去掉多余逗号。0.8.6 会解析失败 → 多条批量对半拆，至少多 2 次请求。
- 解析起点换下一个 `[`：说明文字里带方括号（`Here are the [2] results: [...]`）时找到真正的数组。
- 元素被包成对象（`[{"translation": "…"}]`）：只认 `translation` / `translated_text` / `translatedText` / `text` 之一，恰好一个才取；其它结构整批失败。0.8.6 会把 **`[object Object]`** 插进网页。
- 单条纯文本回包不再剥掉英文对白首尾的引号（0.8.6 会把 `"What are you doing?" she asked.` 的引号剥掉）。
- 看起来是没解析成功的 JSON 数组（以 `[` 开头、或某行是 `"…",`）不再按行拆成译文。
- `leaksWrapper(source, output)`：译文里残留 `{"translation":`、`"translations": [`、`[object Object]`、本扩展提示词原句，而原文里没有 → 这一条按失败（`null`），不插进网页、不进缓存（ABT 在写入 EPUB 前做同样的拦截）。

### 2.3 长段落无损切分（参考 Wenyi `split_long_segments`）

- 问题（0.8.6 及以前，只影响超过 `maxUnitChars`=1200 字的单行段落）：行内切句先吃掉标点后的空白、再用空格拼回去，**发给模型的原文被改了**：`3.5` → `3. 5`、`example.com` → `example. com`、`10:30` → `10: 30`，中文「你好。」后被插空格。
- 现在：切点只在句末之后（中日文句末标点直接切；西文 `. ! ? ; :` 后面要有空白才算句末，紧跟的引号括号算前一句），每一段都是原文原样子串，`seps` 记切点处原来有没有空白；拼回原文逐字一致。
- 拼回**译文**时用 `DT.translationSeps(seps, target)`：换行原样；行内切点中 / 日目标不加空格、其它语言加一个空格（原文有没有空白不能照搬：中文译成英文句间要空格）。
- 影响：只有 >1200 字的段落发出去的原文变了，这些段落第一次会缓存未命中重翻；其它缓存不受影响。

### 2.4 测试与验证（实际跑过的）

| 项 | 结果 |
|---|---|
| Node 测试 | 20 个文件、302 条全部通过（0.8.6 基线 19 / 280）。新增 `test/translate-pipeline.test.mjs` 7 条；`parse` 18 → 32；`cache` 13 → 14；`prompt` 断言改为新措辞 |
| 新测试能抓到旧问题 | `translate-pipeline` 在 0.8.6 代码上 6 / 7 失败（唯一通过的是「代码里的 \n 原样保留」，0.8.6 本来就不动它） |
| 浏览器离线自检 | 135 / 135（新增 Pixiv 中译英夹具 `tpl-pixiv-zh`：双语 / 仅译文 / 还原、合法字面 `\n` 不被拆行、长段落无损切分、按目标语言拼接） |
| 真实页面 + 真实扩展 | Chrome 155 用 CDP `Extensions.loadUnpacked` 加载扩展，接一个本地假 OpenAI 接口（故意多转义换行），翻译 Pixiv 中文小说 29416270 成英文：0.8.6 那段五行诗显示成一行、夹着 4 个字面 `\n`；0.8.7 分五行、无字面 `\n`，还原逐字一致、无残留标记 |
| 请求 / Token | 同一页面两个版本各跑 2–3 次：请求数在两个版本内部都有波动（0.8.6：51 / 56 / 62；0.8.7：56 / 57 / 61），送出的条数 330–337、字符约 13.1–13.2k，没有可归因于本次改动的增加。能确定修补的格式问题（结尾逗号、对象包装）从「至少 3 次请求」降到 1 次（管线测试） |
| 兼容性差分 | GitHub / OWID / Aeon：0.8.6 与 0.8.7 的单元文本、双语 / 仅译文后页头导航高度、还原结果完全一致 |

**没有验证的**：真实模型的回包（没有用任何 API Key，所有模型输出都是构造的）；R-18 测试页 29390937（需要登录）；Edge；YouTube 真实播放器（字幕走同一个 translate 路由，Node 字幕会话测试通过）。

---

## 3. 尚未完成的方向（只做了调研 / 设计）

每一项都写了：状态、收益、成本、依赖、风险、下一步最小任务。**动手前先确认不增加请求次数、不让 Prompt 无上限变长、不破坏缓存按原文命中的假设。**

### 3.1 轻量上下文（下一句原文作只读参考）

- 状态：只设计，未实现。
- 参考：Wenyi `pipeline/context.py`（RollingContext：最近 N 条**译文**作 Prompt 后缀）与 `docs/zh/pipeline.md`「全书理解与上下文」：每批**最多多带一条后文原文**，只读、不计入编号输入输出、不新增调用。Agent Book Translate `src/agent/prompt.rs` 定义了 `previous_context` / `next_context`，但 `src/core/engine.rs` 第 147–153 行构造 `PromptContext` 时这些字段全是空串——**它的上下文只有设计没有实现**，不能当作已验证的方案照搬。
- 收益（预期，未验证）：小说跨段的代词、称谓、未完句（Pixiv 一段话被 `<p>` 拆开时）衔接更好。
- 成本：每批 +1 段原文（建议上限 200 字）；Prompt 变长约 5–15%。不加请求。
- 依赖：`content/main.js` 的 `takeBatch()`（知道批内单元在文档里的位置）、消息 `translate` 加一个可选字段（如 `context: { next: string }`）、`lib/prompt.js` 加一段「参考，不翻译、不计入条数」、`background.js` 透传。
- 风险：① **缓存语义**：缓存键只含原文，带上下文的译文会被不同上下文复用——可接受（上下文只是参考），但要写进测试说明；② 模型把参考段也翻了导致条数不对 → 触发拆批，反而多请求；③ 屏幕内小批次（≤3 条）占比上升。
- 下一步最小任务：在 `content/core.js` 加纯函数 `DT.nextContextOf(queue, batchUis, maxChars)`（返回批内最后一个单元在文档顺序上的下一条未在本批的原文，截断到 maxChars），只写自检，不接线；再用 usage 诊断在 3 个页面上量 Prompt 长度变化，确认 <15% 再接线，接线时默认只对 `area === 'content'` 且目标为长段落的批次启用。

### 3.2 段落稳定映射（片段身份）

- 状态：0.8.4 起已有「行」级映射（`DT.replaced` 的 `lines` / `aligned`），0.8.7 起长段落切分记录了 `seps`；没有片段 ID。
- 参考：Wenyi `ingest/segmenter.py` 的 `cont=True` 续段（没有独立锚点、写回时并回原元素）、`pipeline/translation_batch.py` 的 `BatchPlan`（冻结一批的来源位置）。
- 收益：长段落被拆成多片时，悬停原文可以精确到「片」；失败重试只重发失败的片（现在整段的所有片都在 `slots` 里，一片失败整段等下一轮）。
- 成本：低（纯内容侧数据结构）；不加请求。
- 风险：`slots` 局部重试要改 `main.js` 的退避记账（按单元记），容易引入重复注入。
- 下一步最小任务：给 `splitLong` 的返回加 `offsets`（每片在原文中的起止），写自检验证 `text.slice(offsets[i]) === parts[i]`；悬停先不用。

### 3.3 低成本质量检查

- 状态：已有 `isRunaway`（译文过长）、`isNearDuplicate`（近似原文）、`leaksWrapper`（0.8.7）。
- 参考：Agent Book Translate `src/core/qa.rs`（JSON 包装泄漏扫描、抽样空内容检查）。
- 可加（都应是纯函数 + 只判失败、不改写）：译文语言检测（目标中文却返回原文语言 → 记为「与原文相同」而不是成功）；括号 / 引号配对数量与原文差异过大；数字丢失（原文里的数字在译文里找不到）。
- 成本：零请求；误判会让正常译文被丢弃 → 每条规则都要有「原文里本来就有就不拦」的豁免和测试。
- 下一步最小任务：`lib/parse.js` 加 `missingNumbers(source, output)` 只做统计，接到 `lib/usage.js` 的诊断计数里观察一段时间，**先不拦截**。

### 3.4 术语一致性

- 状态：已有用户术语表（`lib/glossary.js`，命中才注入、进缓存指纹）。
- 参考：Wenyi `glossary/extractor.py`（从已完成的原文 / 译文里抽人物、地名并更新术语库）。
- 收益：同一篇小说里人名译法统一。
- 成本：Wenyi 的做法要额外模型调用 —— **不符合 Rimefox 的低成本定位**。可行的轻量版：不调模型，只在同一页面内记录「原文专有名词 → 第一次出现时的译法」（需要可靠的对齐，目前没有）。
- 下一步最小任务：只调研，不实现；先确认用户是否需要「页面内临时术语表」这种功能（会有界面变化，不属于内部优化）。

### 3.5 可恢复翻译 / 长文检查点

- 状态：没有。现有三层缓存已经起到「同一段不重翻」的作用。
- 参考：Agent Book Translate `src/db/checkpoint.rs`（SQLite 按章节 + 片序号记进度）、`src/core/progress.rs`。
- 判断：网页翻译的单位是段落，缓存就是检查点；SQLite / 任务系统对浏览器扩展过重。只有将来做 EPUB / PDF（长文档、整本）时才需要真正的检查点。
- 下一步最小任务：无（留给 PDF / EPUB 立项时一起设计）。

---

## 4. 外部项目引用清单

两个项目均为 **MIT 许可**。下表路径相对各自仓库根目录，已于 2026-10-19 按下列提交核对存在。

- **Wenyi**：<https://github.com/BigDawnGhost/wenyi>，MIT，Copyright (c) 2026 BigDawnGhost；核对提交 `8afda90db03dda869aeb1df04f8da395c66615ed`
- **Agent Book Translate**：<https://github.com/Xuepoo/agent-book-translate>，MIT，Copyright (c) 2026 Xuepoo Foter；核对提交 `ff375e8e3fbd99c06b54711619696d1eb1f461a6`

| 目标 | 参考项目 | 参考源码（相对该仓库） | Rimefox 对应模块 | 本仓库状态 |
|---|---|---|---|---|
| 长段切分 | Wenyi | `packages/core/wenyi_core/ingest/segmenter.py`（`split_long_segments`、`_split_text`） | `content/core.js` `splitLong` / `splitSentences` | 0.8.7 已借鉴思路（在句末之后切、不增删字、记分隔） |
| 批次与对齐 | Wenyi | `packages/core/wenyi_core/pipeline/translation_batch.py`、`packages/core/wenyi_core/agents/translator.py` | `background.js` `translateBatchWithRetry` | 已有等价做法（条数不对 → 拆批到单条），未改 |
| 上下文管理 | Wenyi | `packages/core/wenyi_core/pipeline/context.py`、`docs/zh/pipeline.md`「全书理解与上下文」 | `content/main.js` 取批 + `lib/prompt.js` | 只设计（3.1） |
| 修复原则 | Wenyi | `docs/zh/pipeline.md`「Agent Review」（只接受去掉围栏 / 增删边界分隔符的修复） | `lib/parse.js` | 0.8.7 采用该原则 |
| HTML 保真 | Wenyi | `packages/core/wenyi_core/assemble/html_inline.py`（`_append_text_with_breaks` 等） | `content/dom.js` `injectLines` | 思路一致（译文换行 → 真换行 / `<br>`），未移植 |
| 术语抽取 | Wenyi | `packages/core/wenyi_core/glossary/extractor.py` | `lib/glossary.js` | 只调研（3.4） |
| JSON 容错 | Agent Book Translate | `src/agent/json_healer.rs`、`src/agent/client.rs`（`parse_translation_content`、`pick_translation_candidate`） | `lib/parse.js` `parseArray` | 0.8.7 借鉴思路；没有采用它「任意字符串字段兜底」和「补右括号」（会补造 / 误取内容） |
| 输出校验 | Agent Book Translate | `src/core/qa.rs`（`LEAKAGE_PATTERNS`）、`src/core/engine.rs`（写入前拦截） | `lib/parse.js` `leaksWrapper` + `background.js` | 0.8.7 借鉴思路 |
| Prompt 上下文结构 | Agent Book Translate | `src/agent/prompt.rs`（`PromptContext`） | `lib/prompt.js` | 只调研；注意 `src/core/engine.rs` 147–153 行实际传空 |
| 检查点设计 | Agent Book Translate | `src/db/checkpoint.rs`、`src/core/progress.rs` | 未来长文缓存 | 只调研（3.5） |
| 结构提取 | Agent Book Translate | `src/core/parser.rs`（`extract_text_chunks`） | `content/dom.js` `walk` | 只调研（EPUB 用，网页不适用） |

---

## 5. 第三方代码合规

- **参考设计，未移植第三方源码。** 0.8.7 的 `normalizeTranslationBreaks`、`stripTrailingCommas`、`findJsonArray`、`itemText`、`leaksWrapper`、`splitSentences` 都是按 Rimefox 的需求用 JavaScript 新写的；没有复制、翻译或改编两个项目的代码。
- 0.8.9 的 `findJsonArrays` / `matchBracket` / `joinPieces`、简繁对照字表、`lib/engines/model-list.js` 同样是新写的，没有参考第三方源码。
- `leaksWrapper` 的拦截模式里有 `{"translation":` 这类通用 JSON 片段，和 ABT 的 `LEAKAGE_PATTERNS` 思路相同；这些是普通字符串，不构成代码移植。
- 因此本次**不需要**更新 `THIRD-PARTY-NOTICES.md` / `licenses/`。以后如果真的移植了代码（哪怕是改写成 JS 的算法实现），必须：在 `THIRD-PARTY-NOTICES.md` 加条目、把对应项目的 LICENSE 原文放进 `licenses/`（参考已有的 `licenses/oneaifw-MIT.txt`）、并在移植的文件头注明来源与提交号。`tools/package-store.mjs` 会把 `licenses/` 打进安装包。

---

## 6. 建议的工作顺序

> 研究和开发方向，不代表某个版本必须实现；版本安排以 [ROADMAP.md](ROADMAP.md) 为准。

1. **近期**：继续稳网页翻译——换行与结构映射（真实模型下观察 `normalizeTranslationBreaks` 的命中情况：在 `lib/usage.js` 加一个「规范化次数」计数，只在 debug 时可见）；Pixiv 振假名 `<rt>` 混进原文的问题（见 HANDOFF 已知问题）。
2. **中期**：在不增加请求次数的前提下验证轻量上下文（3.1）对小说翻译的作用：先量 Prompt 长度，再小范围接线，再找真实页面对比（需要用户同意的少量真实 API 调用）。
3. **之后**：术语一致性（3.4）、缓存与格式保真（行内标签保真，ROADMAP P1-2）。
4. **长期**：为 PDF、EPUB、多平台字幕提供可复用的核心（分段、对齐、校验、检查点）——那时再考虑检查点（3.5）和片段身份（3.2）。

---

## 7. 测试与验收指南

### 7.1 离线

```bash
node --test test/*.test.mjs        # 全部 Node 测试（CI 发版前跑同一条，按退出码判定）
node test/parse.test.mjs           # 解析 / 换行规范化 / 写入前校验（纯函数）
node test/translate-pipeline.test.mjs  # 真实 background.js + 假 fetch：换行、旧缓存修复、包装拦截、请求次数
```

浏览器离线自检：`selftest/index.html`（无头 Chrome：`google-chrome --headless=new --allow-file-access-from-files --virtual-time-budget=5000 --dump-dom file://$PWD/selftest/index.html`），应 **135 / 135**。翻译引擎相关的用例：「小说」「Pixiv 中译英」「长段落切分」「译文拼接分隔」「悬停匹配」「悬停对照」开头的各条。

### 7.2 真实页面（每次动 dom.js / main.js / parse.js / background.js 后至少过一遍）

| 场景 | 看什么 |
|---|---|
| Pixiv 小说（全年龄，如 29392114 日文、29416270 中文） | 仅译文逐行、双语分行、无字面 `\n`、悬停原文对应行、还原逐字一致、SPA 翻页后不串 |
| Aeon 长文 | 大标题 / 首字下沉 / 仅译文首字拆分；长原文气泡展开后能滚动 |
| OWID 文章 | 行内脚注 / 链接段落整段一个单元；logo `Our World<br>in Data` 两行 |
| GitHub 仓库页 | 顶栏 / 按钮原地替换不撑高；隐藏对话框不进单元 |
| YouTube | 字幕双语、切语言再切回、换视频、CC 开关（见 docs/YOUTUBE.md） |

**不用真实 Key 也能做的端到端验证**（0.8.7 用过的方法）：Chrome 带 `--enable-unsafe-extension-debugging --remote-debugging-port=…` 启动，CDP 调 `Extensions.loadUnpacked` 加载工作树；在 service worker 里 `chrome.storage.local.set({config: …})`，把 `providerConfig.__custom__.baseUrl` 指到本地一个假的 OpenAI 兼容接口（`POST /v1/chat/completions` 返回 `{choices:[{message:{content:'["…"]'}}]}`，可故意返回坏格式）；再从 service worker `chrome.tabs.sendMessage(tabId, {type:'dt:toggle'})` 开始翻译，用 CDP 读页面 DOM。品牌版 Chrome 137+ 不认 `--load-extension`，必须用这个 CDP 方法。

### 7.3 已覆盖 / 未覆盖

- 已覆盖：标准 / 多转义 / 裸换行 / 纯文本 / 对象包装 / 结尾逗号回包；中英日小说对白；代码、正则、Windows 路径、Markdown 代码、转义说明里的合法 `\n`；双语与仅译文；旧缓存命中修复；还原；重复翻译不重复注入（0.8.4 用例）。
- 未覆盖：真实模型输出（需要 Key，需先征得用户同意并说明费用）；Edge；Firefox（不支持）；竖排阅读（Pixiv 縦書き）；`<rt>` 振假名。

---

## 8. 接手指南

**先读**：`AGENTS.md`（提交与发版规矩）→ `HANDOFF.md` §4–§6（架构、注入算法、踩过的坑）→ 本文 §1–§3。

**先跑**：

```bash
git status -sb && git log --oneline -5
node --test test/*.test.mjs                 # 应全部通过
# 自检页 135/135（命令见 7.1）
```

**当前待办**（按顺序）：

1. `lib/usage.js` 加「换行规范化次数 / 写入前拦截次数」诊断计数（debug 才可见），用来观察真实模型下这两条规则的触发频率（即下面的「第一个小任务」）。
2. 3.1 的最小任务：`DT.nextContextOf` 纯函数 + 自检，**不接线**。
3. HANDOFF 已知问题 11：振假名 `<rt>` 混进原文，先在真实 Pixiv 页面确认再修（`content/dom.js` 的 `tokensOf` 跳过 RT / RP，注意仅译文写回时 ruby 结构）。

**不要重复实现**（已经有了）：

- 长段落切分与分隔记录（`splitLong` / `seps` / `translationSeps` / `joinSlots`）
- 多行单元按行写回、行数不符的收起（`injectLines`）、原位还原（`DT.restore` / `releaseReplaced`）
- 条数不对的拆批与部分成功保留（`translateBatchWithRetry`）
- JSON 容错（围栏、说明文字、裸控制字符、结尾逗号、对象元素）与写入前拦截
- 换行规范化与旧缓存修复（`normalizeTranslationBreaks`）
- 三层缓存与 `remove`、按域名 / 模型 / 术语 / 自定义提示词隔离

**第一个小任务（建议）**：给 `lib/usage.js` 加两个计数器 `breaksNormalized` / `wrapperRejected`，在 `background.js` 的 `normalizeTranslationBreaks` 改了值、`leaksWrapper` 拦截时各 +1；在 `test/usage-pipeline.test.mjs` 加一条断言（构造一条多转义回包 → `breaksNormalized === 1`）。不改界面、不改默认值，只在设置页开了「输出调试日志」后通过 `usage:stats` 看得到。
