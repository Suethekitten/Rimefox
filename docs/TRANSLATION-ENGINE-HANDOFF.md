# 翻译引擎技术交接（0.9.2 DOM 单元模型）

> 给接手翻译引擎的 Agent / 协作者。先读 [AGENTS.md](../AGENTS.md)、[HANDOFF.md](../HANDOFF.md) 和本文。
> 本文只讲**翻译引擎**：从网页收集文字 → 段落 / 句子 → API 请求分片 → 渲染写回 → 悬停 → 还原的整条链路。
> 最近更新：0.9.6（2026-10-20）。0.9.6 统一了普通 / 结构化对齐的目标语言约束（修掉日译英变中文），新增保守的目标语言缓存校验；0.9.2 修了真实青空文库《罗生门》的分段与仅译文空白 / 注音残留；0.9.1 把「一个元素 = 一个翻译单元」的松散模型换成了
> **ParagraphUnit + SentenceUnit + Alignment + RenderTransaction**；旧文档里「所有译文 append 到元素末尾」的说法只适用于独占元素的段落。

---

## 0. 一页结论

- 一个 **TranslationUnit = 一个 ParagraphUnit（语义段落）**，不再等于一个 HTMLElement。
  同一容器里的 `段1<br><br>段2<br><br>段3` 会形成 3 个单元，各有自己的插入锚点；双语模式下译文分别跟在各自段落后面。
- 文本提取分两步：`dom.js` 按阅读顺序收集 token（文本节点 / `<br>`），
  `content/units.js` 做纯文本计算（规范化、段落、句子、对齐校验、签名）。提取与写 DOM 完全分离。
- **句子对齐两级**：整页翻译请求可带 `align: true`，模型返回
  `{"parts":[{"n":1,"t":"…"}]}`；内容侧校验 `sum(n) === 源句数` 且每个片段按顺序出现在最终译文里，通过就用它。
  没有或校验不通过（旧缓存、后台重启、模型不按格式、两边断句数不同）→ 本地对齐 `units.alignLocal`，不发请求：
  句长动态规划 + 数字 / 专名锚点 + 句末语气，对每个句界和「挪一句」的最优路径比代价，**差距不够就把相邻组合并**。
  仍不行（一段超过 80 句、一边句数超过另一边 3 倍）才退回行级 / 段落级。不用 0.9.0 的「句数相同 + 句界相对位置」。
- 所有 DOM 修改都进 **RenderTransaction**（`DT.tx`）：插入节点、改写文本、属性、行内样式、折叠换行。
  `DT.restore()` 逆序回放，只撤销「仍是我们写入的值」；站点改过的节点保持站点的新内容。
- 仅译文模式遇到 Ruby：**不把中文写进 `ruby/rb/rt/rp`**。保留原始 Ruby DOM，清空本段正文文本、
  只隐藏本段落关联的 `rt/rp`、在段落锚点插入独立译文节点；还原时文本 / 注音显隐 / 锚点一起恢复。
- **目标语言是硬约束（0.9.6）**：普通翻译和 `align` 共用同一条「唯一目标语言：Name (code)」；`align` 的
  `parts[].t` 也必须是目标语言，输出协议用占位文字而不是固定中文示例。开 / 关悬停对照只改变原文与译文的对应方式，
  不改变译文语言。
- 结构化对齐**不增加请求次数**：缓存键与三层缓存格式不变；对齐信息放在 service worker 内存旁路表。
  旧缓存命中没有模型对齐 → 悬停用本地对齐，不重翻；模型不遵守格式 → 解析层退回普通字符串数组，页面照常显示。
- **目标语言缓存校验是保守的定向失效（0.9.6）**：命中缓存或拿到新回包时，只有「目标语言是拉丁字母语系、内容却几乎
  全是中日韩正文且带句末句读、长度足够」才判异常；缓存里的异常条目只删这一条（+ 对齐旁路）重翻，新回包的异常结果
  照常显示但不写缓存，不追加请求。短文本、专名 / 术语清单、混有足够拉丁字母的内容一律放行。

---

## 1. 一次翻译的完整流程

```
content script（网页里，classic script，ES5）                          service worker（background.js，ESM）
──────────────────────────────────────────                        ────────────────────────────────────
dom.js   DT.collectAll(accept)
         walk()：容器下钻 / 段落整体 → addParagraphs()
           tokensOf / ownTokens → units.textMap(tokens)
           units.paragraphsOf() 按排版语义切段（空行 / 单 <br>+全角缩进 / 块级边界）
           每段：{ text, index, anchor, map, sentences, groups, snapshot, sig, gen }
         accept()：skipText / looksLikeTarget（简繁按 DT.chineseScript）/ settled / churn / 懒翻译 / 失败退避
main.js  DT.splitLong(text, maxUnitChars) → slots + seps（只控制请求长度，不决定页面段落）
         多句段落 → wantAlign；takeBatch 按离屏幕距离排序
         DT.send({ type:'translate', texts, target, style, align }) ─────►  handleTranslate(msg, sender)
                                                                             ├ 缓存查找 makeKey(scope, text)
                                                                             ├ 同批重复文本合并 / 在途去重
                                                                             ├ 可选本地脱敏
                                                                             ├ 切批 + 并发闸门
                                                                             ├ translateBatchWithRetry(..., align)
                                                                             │   systemPrompt(..., align)
                                                                             │   → parseAlignedArray / parseArray
                                                                             │   条数不对 → 对半拆
                                                                             ├ 每条：restoreText → normalizeTranslationBreaks
                                                                             │   → leaksWrapper / isRunaway → cache.set（仍是字符串）
                                                                             │   对齐 parts → alignCache（内存旁路，不进存储）
         ◄────────────────────────────────────────────────────────────────── { ok, results, alignments, failed, cached, error }
main.js  slots[k] / ali[k] 到齐 → DT.joinSlots → DT.units.alignmentOf(parts, text, sentenceCount)
         DT.sourceChanged(unit) / 代际检查 → DT.inject(unit, text, target, align)
dom.js   injectDual    : 创建译文节点 → insertBefore(段落分隔 <br>) / appendChild(独占元素)
         injectReplace : 单行整体替换 / 多行按行写回；只动本段落的文本节点
         injectRuby    : 清空本段正文 + 隐藏关联 rt/rp + 独立译文节点
         全部写入进 DT.tx（RenderTransaction）
hover.js unitOfNode(文本节点 / <br> / 译文节点) → unit
         unit.align（模型）→ units.alignLocal（本地）→ 两边 ≥2 行且行数相同 → 行级 → 段落级
还原     DT.restore()：逆序回放事务；releaseReplaced / refreshStale 按段落撤销
```

### 1.1 模块职责

| 模块 | 负责 | 关键接口 |
|---|---|---|
| `content/core.js` | 文本工具、请求分片、调度纯函数 | `normalizeText` / `normalizeLines` / `splitLines` / `splitLong` / `joinSlots` / `translationSeps` / `batchLimits` / `nextRetry` |
| `content/units.js` | **结构层（纯函数）**：文本映射、段落、句子、对齐校验、签名 | `DT.units.textMap` / `paragraphsOf` / `linesOf` / `sentencesOf` / `sentencesIn` / `alignmentOf` / `partAt` / `signature` |
| `content/dom.js` | DOM 采集 → ParagraphUnit；渲染事务；注入 / 还原 / 诊断 | `collectAll` / `unitText` / `inject` / `unitOfNode` / `sourceChanged` / `restore` / `releaseReplaced` / `refreshStale` / `areaOf` |
| `content/main.js` | 调度、批处理、观察器、快捷键、代际 | `DT.control`；内部 `translatePage` / `tryInject` |
| `content/hover.js` | 悬停：消费 unit / sentences / align；高亮 + 气泡 | `pairDual` / `pairReplaced` / `unitOf` / `updateAt` / `clear` |
| `background.js` | 翻译中枢：缓存、合并、脱敏、切批、重试、解析、对齐旁路 | `handleTranslate` / `translateBatchWithRetry` |
| `lib/prompt.js` | 系统提示词（纯函数）；`align` 时只改输出格式 | `systemPrompt(target, style, hits, custom, privacy, align)` |
| `lib/parse.js` | 回包解析（字符串数组 + 结构化 parts）与写入前校验 | `parseArray` / `parseAlignedArray` / `normalizeTranslationBreaks` / `leaksWrapper` / `isRunaway` |
| `lib/cache.js` | 三层缓存（内存 / storage.session / storage.local） | `makeKey` / `get` / `set` / `remove` / `clear` |

### 1.2 不能随意改的契约

- `translate` 消息：`results[i]` 仍是**字符串 = 译文**、`'' = 无需翻译`、`null = 失败`；与 `texts` 按下标一一对应。
  `alignments[i]` 是 0.9.1 新增的**可选**字段：`[{n,t}, …]` 或 `null`；没有它页面照常显示。
- 缓存键 `makeKey(scope, text)` 与 `SCHEMA` 不变；缓存值仍是字符串。对齐信息**不进缓存**，只在 service worker 内存里，重启丢失就降级。
- `DT.splitLong` 返回数组 + `seps`；`DT.joinSlots(slots, DT.translationSeps(seps, target))`。请求分片与页面段落是两件事。
- `DT.inject(unit, text, lang, align)`：unit 必须是 `collect` 返回的段落单元；旧签名 `DT.inject(el, text, lang, own)` 仍兼容（内部临时造独占单元）。
- RenderTransaction 的真相在 `DT.tx` / `rendered`；`DT.replaced` 保留为 0.9.0 兼容视图（`DT.replacedOf` 用），不要把它当唯一真相。
- 送翻文本里的 `\n` 只代表「原文分行」：来自 `<br>` 或 `white-space: pre-*`。不要塞别的标记。
- 目标语言不变量：`translate` 消息的 `target`、`systemPrompt` 的目标语言行、结构化输出里的 `parts[].t`、缓存键里的
  `target` 必须是同一个值；普通 / `align` 只能改输出格式，不能各写一套语言约束。开关悬停对照不得改变译文语言（0.9.6）。

---

## 2. 单元模型

### 2.1 ParagraphUnit（一个 TranslationUnit）

```js
{
  id: 'u12',              // 本次页面会话内稳定
  el: HTMLElement,        // 源容器（区域判定 / 距离 / 站点规则都用它）
  text: '…',              // 段落规范化文本（与送翻文本一致）
  own: false,             // 只翻元素自己的直接文本（子级都被跳过时）
  whole: false,           // true = 这个元素只有这一段（可 append 到元素末尾 / 设 data-dt-src）
  index: 1, total: 3,     // 同一容器内的段落序号
  anchor: { parent, before } | null, // 双语译文插在分隔 <br> 之前；null = append 到 el
  map: { text, chars },   // chars[i] = { node, off } / { br } / { nl, node, at } / null
  sentences: [{ index, start, end, text }], // 段落相对偏移
  groups: { filled: [...], tail: [...] },   // lineGroups 选出的本段行（仅译文按行写回）
  snapshot: [{ node, value }],              // sourceChanged 用：站点有没有改字
  sig, gen, area, ruby: [rt/rp...]
}
```

- `whole = true` 的单元继续用 `data-dt-src` / `data-dt-sig` 标记元素；多段落共用容器**不能**标 `data-dt-src`
  （会把兄弟段落一起跳过），改由 `rendered` 记录 + `findRenderedFor` 去重。
  0.9.7 的容器局部段落（`addParagraphs(..., partial)`：只覆盖容器自己的行内文字）同理，即使只有一段也不是 whole。
- 单元不会直接等于元素；一个元素可以产生多个单元。一个句子也可能跨多个行内文本节点。

### 2.2 文本映射（`DT.units.textMap`）

输入 token 流：`{ node, keep }` 文本节点、`{ br }` 换行元素。规则与 `DT.normalizeLines` 逐字一致：

1. 行内空白（空格 / tab / NBSP）折叠成一个空格；普通元素里源码的 `\n` 只是折行 → 空格；
2. `<br>` 与 `white-space: pre / pre-wrap / pre-line / break-spaces` 里的 `\n` 是硬换行；
3. 行首尾空白（含全角 `\u3000`，与 `String.trim` 一致）去掉；行内全角空格保留；
4. 连续硬换行最多保留一个空行（`\n\n`）；
5. `chars` 与 `text` 等长，真实字符映射回 `{ node, off }`，换行映射到 `{ br }` 或 `{ nl }`。

### 2.3 段落识别

- 段落边界按**原始 DOM / 排版语义**判断，不靠规范化文本里是否恰好有两个换行：
  1. 中间有空行（连续 `<br>` / `pre-*` 的连续换行）→ 新段落；
  2. 单个 `<br>` 后的新行同时满足「源码换行 + 行首全角缩进 U+3000」→ 新段落（青空文库 / 日文小说的典型结构）；
  3. 块级元素（`p` / `li` / `td` / 标题…）由 `walk` 下钻，天然分开；
  4. 其它单个 `<br>` / `pre-*` 换行只是同一段里的行（诗行、信件、地址、Pixiv 的连续对白行、源码折行）。
- **不能**简单把每个 `<br>` 都当段落：Pixiv 的每行对白都带 `　`，但没有源码换行，按行级结构保留在同一段；青空文库里「まるで<br>「おのれ…」」这种对白续行也不会被拆开。
- 字符映射 `textMap` 在规范化时**先记录**行首全角缩进和源码换行信号，再 trim；这样段落边界不会在规范化阶段丢失。
- `pre-*` 单文本节点内部的空行 / 缩进仍合并成一个单元（不引入 `splitText`），保留行级结构；悬停按行级降级。
- **巨大单元的兜底**：如果整棵子树只切出一个单元、却有 8 个以上真实 `<br>` 行且超过 800 字（说明没有任何可识别的段落签名），按行拆成可诊断的单元（`unit.fallback = 'line'`），而不是静默把整篇文章 append 成一个单元。
- 标准段落 `<p>Hello <strong>beautiful</strong> world.</p>` 是一个单元，跨 3 个文本节点；不会因为 `strong` 拆段。
- `walk` 的其他规则（flex/grid 下钻、控件容器下钻、子级全跳过时只翻 ownText、已翻译子树防线）沿用 0.9.0。

### 2.4 SentenceUnit 与 Alignment

- `sentencesIn(text, start, end)` 在段落内切句：中日文 `。！？；` 直接断；引号 / 括号内的句号不断；换行一定断。
  西文 `.!?…` 后要空白，并排除缩写（Mr. / Dr. / e.g. / i.e. / vs. / et al.；No. 5 / p. 12 / Fig. 3 只在后面跟数字时）、
  首字母（J. K. Rowling）、整句只有编号（`1. `）、后面接小写字母（`"Really?" she asked`）；
  紧跟句末的脚注号归前一句（`home.11 Since` / `home.¹¹` / `home.[11]` / `。[4]`）；半角 `?!…` 后面直接是中日韩文字也断。
  只有这一份实现（`hover.sentencesOf` 是别名）。
- 模型返回 `parts: [{n, t}]`：`n` 是这一组覆盖的源句数。内容侧 `alignmentOf(parts, result, sentenceCount)`：
  1. `n` 是 1–99 整数，`t` 非空；
  2. `sum(n) === sentenceCount`；
  3. 每个 `t` 按顺序出现在最终译文里（`indexOf`，防止模型改写片段导致高亮范围错位）。
  全部通过才返回 `{ reliable:true, parts:[{srcFrom,srcTo,tgtFrom,tgtTo,text}] }`；否则 `null`。
- 一对一 / 一对多 / 多对一 / 无法确认四种状态：`n` 直接表达分组；无法确认就是 `null`，交给本地对齐。
- 本地对齐 `alignLocal(srcText, srcSentences, tgtText)` 返回同形结果（另带 `local:true`、每组译文句数 `tgtCount`）：
  - `alignBeads` 是 Gale–Church 式动态规划：组的先验代价 1–1 为 0、1–2 / 2–1 为 2.0、2–2 为 4.0、1–3 / 3–1 为 4.5；
    句长按本段整体译文 / 原文比例归一化（中日韩字按 2.5 个西文字符），方差 8；
  - 锚点：两边段落里都出现的数字（千分位去掉）和缩写 / 混合大小写 / 带数字的西文词（GDP、iPhone、COVID-19）要落在同一组；
    三位以上数字权重 2，一两位 0.6（常是脚注号）；问句 / 感叹句对不上加 0.8；
  - 置信度：前向 + 后向两遍，对最优路径上每个句界取经过相邻点（挪一句）的最优路径，代价差 < 0.5 就合并这两组；
  - 两边真实行数相同（≥2 行）时逐行对齐，行界一定是组界。
  - 参数来自 38 段人工对照语料（中英日法，含合并 / 拆分 / 调换语序 / 引注）：句界全对，正确句界的最小差距 0.61，
    调换语序的段落整段合并。语料在 `test/fixtures/sentence-align-corpus.json`，改断句 / 参数后跑
    `node test/sentence-align.test.mjs`（CI 的 `node --test test/*.test.mjs` 也会跑）；新遇到的错配先补进语料。
- **不要**回到「两边句数相同 + 句界相对位置接近」的直接配对：0.9.0 的坑（看起来精确、实际错句）。
  句数不同时必须让动态规划决定哪几句合成一组，并且保留「两可就合并」这一步。

---

## 3. 渲染（RenderTransaction）

### 3.1 事务操作

```js
{ op:'insert', node, parent, before }       // 译文节点
{ op:'text',   node, before, after }        // 仅译文改写文本
{ op:'attr',   el, name, before, after }    // data-dt-src / data-dt-collapsed / data-dt-rt-hidden
{ op:'style',  el, prop, before, after }    // rt/rp 的 display
```

- `setText` / `setAttr` / `setStyle` / `insertNode` 是唯一写入口；所有写入同时进 `DT.tx` 和本单元的 `ops`。
- `undoOps(ops)` 逆序回放：text 只在 `nodeValue === after` 时恢复；attr 只在当前值仍是 `after` 时恢复；
  insert 只在节点仍连接时移除；style 只在仍是 `after` 时恢复，并清掉空的 `style=""`。
- `DT.restore()` 回放整条 `tx`，然后清空 `rendered` / `nodeUnit` / `elUnits` / `DT.replaced`，代际 +1，
  再兜底扫掉残留的 `data-dt-target` / `data-dt-collapsed` / `data-dt-rt-hidden` / `data-dt-src`。
- `DT.releaseReplaced()`：替换型 / Ruby 型记录，如果文本节点已不是我们写的值 → 撤销该记录的 `ops`，放回待翻译。
- `DT.refreshStale()`：双语记录，如果译文节点被删或源文本快照变了 → 撤销该段；`url change` 时调用。

### 3.2 双语

- 独占元素（`whole`）：`el.appendChild(译文节点)`，保留 0.9.0 的布局继承。
- 共用容器（`index/total`）：`parent.insertBefore(译文节点, anchor.before)`，`anchor.before` 是本段之后的分隔 `<br>`；最后一段插在尾部空行的第一个 `<br>` 之前。
  结果：P1 → 译文1 → 分隔 <br> → P2 → 译文2 …（不是所有译文堆到容器末尾）
- 译文节点始终带 `data-dt-target` / `data-dt-unit` / `data-dt-lang`；`makeNode` 负责排版继承、
  CJK 大标题、紧行高、窄容器、`dt-lines`（多行译文）。
- 带文献引用的段落：译文节点里按标记位置放引用链接的副本（可点击、无 id），不是纯文本；做法与降级见 [HANDOFF §5.2.1](../HANDOFF.md) 的「文献引用」。
- 同一个容器里多个 `[data-dt-target]` 是**正常**的。`main.js` 的 `cleanupDuplicateTargets` 只清理
  `data-dt-unit` 相同的克隆副本，不能按「同一父级只留一个」清理（0.9.1 的 E2E 抓到过这个回归）。

### 3.3 仅译文

- 单行段落：整段写进本段第一个有字的文本节点，其余本段文本节点清空；保留行首空白、首字下沉拆分。
- 多行段落：按行写回本段自己的行（`lineGroups` 选出的 `filled`），保留缩进、`<br>`、空行和行内元素。
  模型合并 / 拆分行时依次填写，多出的并进最后一行，多余的行清空并折叠它自己的换行；`aligned` 记录是否逐行对应。
- **只改本段落的行**：段落之间的空行是别人的锚点，绝不折叠。
- 混合行内内容（文献引用、图表链接、普通链接、提及、notranslate、Ruby 夹在正文里）：原子原地不动，原子外的文字清空后，译文作为新文本节点插在原子之间、永远不进链接（`injectMixed`：词级 / 句级 / 漏标记按原句恢复，`<br>` 与 pre-wrap 的 `\n` 分行逐行对齐）；Ruby 整体当原子，中文不写进 rt/rp；结构不支持或行数对不上时保持原文并写明注入结果，仅译文不降级双语。见 [HANDOFF §5.2.1](../HANDOFF.md) 的「文献引用」与「注入结果分类」。
- 普通行内链接：内容区域里只要普通文字和链接混排，链接就作为原子，中文正文写在链接外；整段链接 / 导航 / 按钮保持原行为。普通链接文字默认保留，图表 / 补充材料等可靠标签本地化。`@username` 提及链接作为保留区，用户名链接保持原样。
- **稳定正文 / 无双语回退**：仅译文下 `hasUnsafeInlineLink` 不再设置 `linkFallback='dual'`；无法安全重建时保持原文并报 `unsafe-structure`。`[8]` / `［9］` 等本地数字引用链接、上标数字链接和参考文献目标数字链接进入 `keep`，普通 “section 1” 数字锚点不误判。
- **上下文防抖**：医学文档快照从 `DT.replacedOf(el).src` 读原文，只有网站自身的标题 / 章节 mutation 才 `contextChanged`；own 译文、方向壳和移动的原文本不触发补扫 / startOver。`DT.debugStats` 记录 startOver / restore / contextChanged / incremental / injectDual / linkFallback 计数，便于本地复现，不输出正文。
- **双向排版**：`content/direction.js` 从目标 BCP 47 语言和原始 DOM 的 `dir` / computed `direction` / 文档语言判断方向。双语译文节点独立设置 `dir` / `lang` / inline direction + `unicode-bidi:isolate`；完整仅译文块用事务改父块方向，部分 / 共享容器把写入的文本节点移进 `data-dt-dir="wrap"` 隔离壳（`move` + `insert` 事务）。混合段落的每段新译文单独隔离，引用 / 链接 / Ruby 原子不改。块方向、文本节点移动、壳都由 RenderTransaction 还原；不能对 html/body/article 全局写 direction。

- **安全落点**：在清空原文之前规划引用原子边界，保留共享上标父级中的编号与分隔符。`safeSlot` 跨出链接、SUP/SUB 与已确认引用的 CSS 上标包装链；隐藏的辅助标签不混入引用组可见数字判定。译文不能留在上标、相对定位或 transform 的特殊上下文中；普通小字本身不是引用证据，不用 CSS 强制归一化掩盖结构错误。pre-wrap 新建换行也使用同一安全锚点。布局、节点身份和精确撤销回归在 `selftest/inline-layout.js`，用 `node tools/e2e-inline-layout.mjs` 执行真实无头 Chrome 的视口/缩放矩阵。
- 所有写入走事务；`DT.replaced` 兼容视图记录 `{el, nodes, collapsed, src, lines, aligned}`。

### 3.4 Ruby（仅译文模式）

- `tokensOf` / `ownTokens` 已经排除 `rt` / `rp`；段落文本只有汉字 / 假名正文。
- `rubyAnnotationsFor(el, chars, bounds, own)` 先按字符映射找基字在本段的 `<ruby>`；再按**本段的 DOM 范围**（上一段分隔 `<br>` 之后到本段分隔 `<br>` 之前）扫一遍所有 `<ruby>`。
  第二遍是必须的：青空文库有些 Ruby 的基字是 `<img class="gaiji">`（外字图片），没有任何文本字符，只靠字符映射会漏掉它们的 `rt/rp`，仅译文模式就会残留假名（真实《罗生门》里有 3 个）。
- `injectRuby`：
  1. 清空本段落的所有正文文本片段（含 ruby 基字）；
  2. 对关联的 `rt/rp`：`style.display = 'none'` + `data-dt-rt-hidden="1"`（事务记录原值）；
  3. 在段落锚点插入独立译文节点（`data-dt-target`）。
- 绝不把整句译文写进 `ruby/rb/rt/rp`。未翻译段落的 `rt` 不会被动到（不是全局隐藏所有 `<rt>`）。
- 还原：事务逆序恢复文本、`display`、属性，移除译文节点；关闭翻译 / 模式切换 / 重译都走同一条路。
- 已知取舍：纯 Ruby 段落的译文仍用独立容器，不再按基字逐词替换；Ruby 与引用 / 链接混排时 `<ruby>` 整体作为原子保留，基字本身不翻译，周围正文重建；竖排（縦書き）和特殊 ruby 布局未验证。

---

## 4. 悬停

- `DT.unitOfNode(node)`：`nodeUnit`（原文文本节点 / `<br>` / 译文节点 / 行内包裹元素）+ `elUnits`（容器兜底）。
- 对齐来源：`hover.alignOf(unit, 译文)` = 模型对齐（偏移和页面实际译文逐字对得上才用）‖ 本地对齐（按单元记住结果）。
- 双语：源文本用 `unit.map`，译文本用译文节点的简单映射。
  - 鼠标在原文 → 源句 index → `partAt` → 高亮这一组源句 + 对应译文；
  - 鼠标在译文 → `partAtTargetOffset` → 高亮这一组译文 + 源句；
  - **不弹气泡**：原文和译文都在页面上，气泡只会挡住下面的正文（0.9.1–0.9.2 弹过，0.9.3 去掉）。
- 都没有（段落太长 / 句数差太多）：两边都 ≥2 行且行数相同 → 行级；否则段落级。
- 仅译文 / Ruby：`mapFromGroups` 从本段落当前文本节点读出译文（去掉行首缩进），
  `mapFromNode` 读独立译文节点；同一套对齐规则，气泡显示原文，组跨整行 / 整段时标签写「行级对应 / 段落级对应」。
- 高亮继续用 CSS Custom Highlight API（`dt-hover-src` / `dt-hover-target`），不改页面文本节点；
  不支持时退回整段标记（仅译文另弹段落气泡）。开关复用 `hoverCompare`（Popup / Dock / Options 同步）。
- 长气泡（段落 / 行 / 超长句）支持展开、收起、内部滚动、Escape / 关闭；鼠标能从锚点移进气泡。

---

## 5. 生命周期与代际

| 场景 | 处理 |
|---|---|
| 关闭翻译 / 仅译文↔双语 / 换目标语言 / 重译 | `cancelRun` + `DT.bumpGeneration()` → `DT.restore()` 逆序回放 → 按新设置重新收集 |
| 翻译中取消、旧请求晚到 | `runId`（调度层）+ `unit.gen !== DT.generation`（DOM 层）双重拦截 |
| 站点改了某个段落 | `sourceChanged`（快照）放弃这次注入；`refreshStale` 只撤销这一段，兄弟段落不动 |
| 站点改写替换型文本 | `releaseReplaced`：仍是我们写的节点恢复原文，被站点改过的节点保持新内容 |
| 节点被删除 / 框架重建 | 事务回放跳过失效节点（`isConnected` / 值不匹配），释放记录，不强改 |
| 重复注入扩展脚本 | `core.js` / `dom.js` / `main.js` 的 ready 标志；单元记录防重复注入 |
| 扩展自身写入触发观察器 | `DT.isOwnWrite`（characterData）、`DT.isOwnNode`（childList）；只认真正写过的文本节点 |
| 克隆整块内容 | `cleanupDuplicateTargets` 只删 `data-dt-unit` 相同的副本 |
| 内存 | `tx` / `rendered` 在 restore 时清空；`nodeUnit` / `elUnits` 重建；单页单元数受 `MAX_UNITS` 限制 |
| 失败退避 / settled / churn | 按「元素 → Map(源文本签名 + 段序号)」记，不按元素；同容器一段失败 / 抖动不影响其它段 |
| 懒翻译 / 批次优先级 | `DT.rectOfUnit(unit)` 用段首文本节点矩形；不能用整个容器矩形，否则长正文所有段都被算成同一屏 |

---

## 6. 请求、缓存与性能

- `splitLong` 只负责请求长度；一个 ParagraphUnit 可以对应多个请求片段，最终仍写回该段落的唯一渲染位置。
- `align: true` 只改变**响应格式**，不增加请求；对齐旁路表以缓存键为键，最多 4000 条，SW 重启丢失只是降级。
- 同接口身份下的旧字符串译文仍可命中；模型不遵守 `parts` 时 `parseAlignedArray` 退回 `parseArray`。
- 专业模式在后台结果处理层增加可选 `validations`，不参与 DOM 注入规则。标准/快速不增加模型请求，严格模式仅有限复核高风险片段；更换译文会丢弃旧模型对齐偏移。专业缓存上下文与费用边界见 [专业引擎](PROFESSIONAL-TRANSLATION.md)。
- 脱敏 / 换行规范化改变了译文字符 → 对应当前这条的 `parts` 被丢弃（偏移不再可靠），不影响译文显示。
- 缓存键包含原文 + scope；scope 的 `endpoint` 按协议及去首尾空白、去尾斜杠的 API 地址隔离缓存、对齐旁路和在途请求。没有接口身份的旧条目不能确认来源，不再复用，但不主动清空，随容量淘汰；升级后首次翻译可能重新请求。加一条术语只让命中它的段落失效（0.9.0 起）。
- 普通 / align 共用 `systemPrompt(target, …)` 的目标语言行；`translate` 消息与缓存键里的 `target` 没有新增字段（0.9.6）。
- 语言校验（`lib/lang-guard.js`）只做单条定向失效 / 不写缓存；旧缓存命中的异常条目重翻一次，正常译文不受影响（0.9.6）。
- 段落切分更细会让**单元数**变多，但送翻文本总量不变；懒翻译、可见区优先、并发闸门、失败退避都沿用。
  `groupsForRange` 按顺序累计行数（不是每段重扫），避免大量段落的 O(n²)。

---

## 6.1 真实网页验收（0.9.2）

- 页面：<https://www.aozora.gr.jp/cards/000879/files/127_15260.html>（芥川龍之介《羅生門》，青空文库，Shift_JIS）。
- 真实结构：`<div class="main_text">` 里 40 个 `<br>`、129 个 `<ruby>`（`<rb>/<rp>/<rt>`，部分基字是 `<img class="gaiji">`），
  每个段落是「单个 `<br>` + 源码换行 + 全角缩进 `　`」，没有 `<br><br>`。
- 0.9.1（旧）：`DT.collect` 只得到 **1 个单元**（约 5000 字，ruby 81 个），双语只有 1 个译文节点、在页面 **y=738**；
  仅译文只有 1 个译文节点、y=210，前面是清空正文后留下的一串 `<br>` 空白；3 个图片基字 Ruby 的 `rt` 仍可见。
- 0.9.2（新）：`DT.collect` 得到 **29 个段落单元**（每段独立锚点），双语 **29 个译文节点**，前 8 个 y=60/232/617/…；
  仅译文首段译文 y=30，最大段间空白 30px，可见 `rt` **0**、页面无假名，关闭后 DOM **逐字恢复**；模式切换 / 动态新增段落 / 悬停均通过。
- 记录：`docs/verification/2026-10-19-aozora-roshomon/` 下的 before / dual / only / restored 截图与 `*-diagnostics.json`
  （`edge-bilingual-*` 是新版，`rimefox-old-*` 是旧版失败证据）。真实页面验收只能通过网络环境复现；CI 默认不跑，fixture 在
  `test/fixtures/aozora-roshomon.html`。

## 7. 测试

```bash
node --test test/*.test.mjs          # CI 发版前同一条
node tools/e2e-extension.mjs --aozora-live   # 真实青空文库《罗生门》验收（需要能上 aozora.gr.jp）
# 自检页（本机 headless Chrome 需要 --no-sandbox）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --user-data-dir=/tmp/chrome-selftest --allow-file-access-from-files \
  --virtual-time-budget=30000 --dump-dom "file://$PWD/selftest/index.html"   # 看 id="summary"：必须全部通过
node tools/e2e-extension.mjs         # 真实 Chrome + 假 OpenAI 接口
```

- 自检页新增：青空文库式 3 段拆分 / 锚点顺序、仅译文逐段写回与还原、Ruby（普通 / rp / rb / 多个混合）、
  Ruby 还原与未翻译 Ruby 不受影响、结构化对齐的合法 / 非法 / 一对多 / 多对一、悬停句级 / 行级 / 段落级、
  代际隔离、段落级 SPA 更新、Ruby 段落被站点改写后的释放。
- Node 新增：`parseAlignedArray`（合法 / 回退 / 非法 / 条数）、`align` 提示词与默认提示词不变、
  `translate` 路由的 `alignments` / 缓存旁路 / 旧缓存降级 / 模型不遵守格式。
- E2E 新增：`/aozora.html`（罗生门式 3 段）、`/pixiv.html`（pre-wrap 对白 + Ruby）；
  检查 DOM 顺序、悬停高亮与气泡、Ruby 显隐、关闭后逐字恢复。
- 0.9.6 新增：目标语言（日 → 英悬停开 / 关、两种模式的提示词断言、句级高亮、切回中文替换旧英文）、
  语言校验（英文目标回中文 / 正常英文 / 专名清单 / 短文本）、悬浮入口半隐藏几何（左右露半球 / 展开收起 /
  自由悬浮 / 关闭自动隐藏）；E2E 用真实鼠标验证移入展开、移开收起、从半隐藏起拖不跳位、窄视口仍露半球。

---

## 8. 接手指南

**先读**：`AGENTS.md` → `HANDOFF.md` §5–§6 → 本文 §1–§5。

**先跑**：`git status -sb && node --test test/*.test.mjs`，再跑自检页（211 / 211），再跑 E2E；能上网时加 `--aozora-live` 跑真实《罗生门》。

**不要重复实现**（已经有了）：

- ParagraphUnit 拆分、锚点、节点映射（`units.textMap` / `paragraphsOf` / `addParagraphs`）
- 句子切分与结构化对齐校验（`sentencesIn` / `alignmentOf` / `partAt` / `partAtTargetOffset`）
- 渲染事务与还原（`tx` / `undoOps` / `restore` / `releaseReplaced` / `refreshStale`）
- Ruby 关联与安全替换（`rubyAnnotationsFor` / `injectRuby`）
- 悬停的三级对应与气泡（`pairDual` / `pairReplaced`）
- 长段落切分 / 分隔拼回（`splitLong` / `seps` / `joinSlots`）
- 解析容错 / 写入前拦截 / 三层缓存 / 在途去重

**新增站点兼容的入口**：先判断是不是「段落识别 / 插入锚点 / 区域模型」的问题：

- 段落被合并 / 拆错 → `content/units.js` 的 `paragraphsOf` / `textMap`；
- 译文位置不对 → `addParagraphs` 的 anchor 计算、`injectDual`；
- 导航 / 按钮被追加撑破 → `DT.areaOf` / `isPositioned`；
- Ruby 残留 → `rubyAnnotationsFor` / `injectRuby`；
- 悬停对不上 → 先看 `unit.sentences` 断句对不对（`units.sentencesOf`），再看 `DT.hover.alignOf(unit, 译文)` 的分组；
  不要回到「句数相同 + 相对位置」的猜法，也不要去掉「两可就合并」。

**当前待办**（按顺序）：

1. 真实网站验证：青空文库（罗生门）0.9.2 已通过并记录；Pixiv 注音小说、GitHub、Aeon、OWID、YouTube 字幕仍待真实页面验证（不要只凭 fixture 宣称通过）。
2. 真实模型下观察 `align` 结构化输出的遵守率与译文质量（需要用户同意的 API 调用）；弱模型可能不遵守，降级路径已就绪。
3. 竖排 / 縦書き、`writing-mode: vertical-*` 的段落与 Ruby 布局未验证。
4. 行内格式保真（`<b>` / `<a>` 在译文里保留）仍是独立方向，不要混进单元模型。

---

## 9. 第三方代码合规

- 0.9.1 / 0.9.2 的 `textMap` / `paragraphsOf` / `alignmentOf` / RenderTransaction / `injectRuby` 都是按 Rimefox 需求新写的 JavaScript；
  没有复制、翻译或改编第三方源码。
- 0.8.7 / 0.8.9 的参考项目（Wenyi、Agent Book Translate，均 MIT）仍只是思路参考；详见 HANDOFF §13 与 `THIRD-PARTY-NOTICES.md`。
- 因此本次**不需要**更新 `THIRD-PARTY-NOTICES.md` / `licenses/`。以后真的移植代码（哪怕改写成 JS）必须补条目、放 LICENSE 原文、在文件头注明来源与提交号。
