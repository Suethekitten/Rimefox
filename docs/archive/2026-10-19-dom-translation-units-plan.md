> **已归档** —— 这是一次性记录（0.9.1 DOM 翻译单元重构实施计划（已发布，计划作废）），不是「现在怎么做」。
> 内容反映归档当时的状态，可能已经过期。现状见 [STORE](../STORE.md)、[ROADMAP](../ROADMAP.md)、[HANDOFF](../../HANDOFF.md)。

# 0.9.1 DOM 翻译单元架构重构 — 实施计划

日期：2026-10-19
分支：`feat/0.9.1-dom-translation-units`
基线：`5ef5653`（0.9.0），工作树干净，Node 21 个测试文件全过，自检页 141/141。

## 1. 目标与验收

把「找文字 → 拼文本 → 追加/替换」的松散流程改成五层分离的统一模型：
DOM 结构 → 视觉段落（ParagraphUnit）→ 语义句子（SentenceUnit）→
API 请求分片（splitLong）→ 渲染（RenderTransaction）。

必须同时满足（详见任务书 §14）：

- 青空文库式 `段1<br><br>段2<br><br>段3` 双语逐段对应，译文跟在各自段落后面；
- 仅译文模式 Ruby：不残留假名、不把整句中文写进 `ruby/rb/rt/rp`、可完整恢复；
- 悬停消费同一份结构化映射；只有可靠映射才做句级高亮，否则降级到行 / 段并标明；
- 模式切换、关闭、重译、SPA、动态更新、重复注入都能安全恢复，旧请求不污染新内容；
- 普通网页、导航、按钮、字幕、输入框翻译无重大回归；
- 零构建，不引入依赖。

## 2. 现状与根因

见开发报告 §2。关键结论：

1. `walk()` 的单元 = 一个元素，元素内有 `<br><br>` 也只是「一个多行单元」；
2. 双语注入 = `sourceEl.appendChild()`，所以同一容器内所有译文都堆在容器末尾；
3. 仅译文注入按整个元素的行分组，Ruby 的 `<rt>` 被跳过但没参与显隐；整段译文可能落进 `<ruby>`；
4. 悬停靠「两边句数相同 + 句界相对位置 ≤0.25」猜句子，属于任务书禁止的比例猜测；
5. 还原/替换记录分散在 `DT.replaced`、`data-dt-src`、`data-dt-collapsed`，没有统一事务和代际。

## 3. 目标架构

### 3.1 数据模型（content/units.js + dom.js）

- `ParagraphUnit`：`{ id, el, text, mode:'whole'|'part', index, anchor:{parent,before}|null,
  nodes:[{node,start,end,textStart,textEnd}], brs, map:{text,map}, sig, area, generation }`
- `SentenceUnit`：`{ index, start, end, text }`（段落内偏移，来自 `units.sentencesOf`）
- `Alignment`：`{ reliable:true, parts:[{ n, srcFrom, srcTo, tgtFrom, tgtEnd, text }] }`；
  只由模型结构化结果 `parts:[{n,t}]` 生成，校验 `sum(n) === 源句数` 且每段 n≥1；
  校验失败 → `null`（段落级对应），绝不按长度猜。
- `RenderTransaction`：`DT.tx` 操作日志，op = `insert | text | attr | collapse | split`，
  每条记 `unitId / generation / before / after`；`DT.restore()` 逆序回放，只回放仍是自己写入的值。

### 3.2 段落识别

- 文本映射由 token 流构建：真实字符、`<br>` 换行、`pre-*` 的 `\n` 换行、折叠空白；
- 空行（规范化后的 `\n\n`）= 段落边界；单个 `\n` = 同一段内的行；
- 块级元素仍按 `shouldDescend` 下钻，每个块一个或多个 ParagraphUnit；
- 每个 ParagraphUnit 的插入锚点：单元在容器中间时插在分隔空行**之前**；
  最后一个段落 / 独占元素的段落追加在元素内部末尾（沿用 0.9.0 的布局策略）；
- 多个段落共用一个容器时，不写 `data-dt-src`（会误伤兄弟段落），用 `node → unit` WeakMap +
  已渲染记录去重；独占元素的单元继续保留 `data-dt-src`，兼容诊断与旧逻辑。

### 3.3 渲染事务

- 双语：`parent.insertBefore(翻译节点, anchor.before)`，或 `el.appendChild`；
- 仅译文（普通段落）：把本段落的文本节点按行写回；`<br>` 不够时折叠并记录；
- 仅译文（含 Ruby 的段落）：清空本段落文本节点 + 记录并隐藏关联 `rt/rp` +
  在锚点插入独立译文节点；绝不写进 `ruby/rb/rt/rp`；
- 所有写入都进事务，`DT.restore` / `releaseReplaced` / `refreshStale` 只从事务和当前记录工作。

### 3.4 句子对齐（不增加请求）

- `translate` 消息新增可选 `align: true`（只有整页翻译发）；提示词要求每条返回
  `{"parts":[{"n":1,"t":"..."}]}`，`n` = 该片段覆盖的源句数；
- 后台解析成 `results[i]`（拼好的整段译文，消息契约不变）+ `alignments[i]`（可选）；
- 缓存键 / 存储格式不变：缓存仍只存字符串；对齐结果放 service worker 内存旁路表，
  重启后丢失 → 悬停自动降级为行 / 段落级。旧缓存命中没有对齐 → 同样降级，不重翻；
- 模型不遵守格式 → 解析层退回普通字符串数组，页面照常显示，只是没有句级映射。

### 3.5 悬停

- `hover.unitOf(node)` 用 dom.js 的 WeakMap（原文/译文/换行节点 → unit），不再独立解析；
- 有 `unit.align`：句级高亮 + 双语气泡（原文句 ↔ 译文句）；
- 没有对齐：行数两边都来自真实结构且相同 → 行级；否则段落级，气泡标明范围；
- 删除 `sentencesAgree` 的句界比例推断，不再用长度比例猜句子；
- 继续用 CSS Custom Highlight API，复用 `hoverCompare` 设置。

### 3.6 生命周期与代际

- `DT.generation`：`cancelRun/restore/startOver/disable` 时 +1；unit 记录创建时代际，
  `DT.inject` 拒绝过期代际；main.js 的 `runId` 继续负责调度层；
- MutationObserver 忽略 `data-dt-target` / `data-dt-ui` / `DT.isOwnWrite`；
- `refreshStale` 按段落签名撤销单个段落，不再整元素清空；
- 节点断开 / 被站点重建：事务回放时跳过失效节点，释放记录。

## 4. 兼容边界

- `DT.inject(el, text, lang, own)` 旧签名保留（元素 → 临时 whole unit），自检旧用例可继续跑；
- `DT.unitText` / `textOf` / `DT.splitLong` / `seps` / `joinSlots` / `DT.replacedOf` 语义保留；
- `translate` 消息的 `results` 仍是 `string | '' | null`、按下标一一对应；
- 缓存 `SCHEMA` 不升级、存储仍是字符串；对齐是可选旁路；
- 提示词只在 `align` 时变化，划词 / 输入框 / 字幕的提示词逐字不变；
- `DT.areaOf` 的区域判定与注入策略（控件 / 定位 / 导航）保持。

## 5. 退役

- 退役：`walk()` 的「一个元素 = 一个单元」；`injectDual` 无条件 `appendChild`；
  `hover.sentencesAgree` / 句界漂移猜测；分散的 `DT.replaced` 单一数组作为唯一真相
  （保留为兼容视图，真相改为事务 + 单元记录）。
- 保留：`appendChild` 作为「独占元素」的锚点实现；`injectOnly` 的单行替换语义。

## 6. TDD Route

`TDD Route: off`（Aegis 默认）。决策：`skipped`（用户未要求 strict TDD）。
验证姿态：先补真实 DOM 夹具与断言，再改实现；每个阶段跑自检页 + 相关 Node 测试，
最后跑真实 Chrome E2E。新增行为均先写会失败的断言（分段数量、锚点顺序、Ruby 显隐、
对齐降级），但不强制 RED/GREEN 仪式。

## 7. 任务

1. **units.js**：text map、段落切分、句子切分、对齐校验/映射、签名；自检纯函数用例。
2. **dom.js 采集**：ParagraphUnit；共用容器的独立锚点；Ruby 关联；registry + WeakMap；去重。
3. **dom.js 渲染/还原**：RenderTransaction；双语/仅译文两条路径；Ruby 安全替换；
   release/refresh/restore；generation。
4. **对齐链路**：prompt（align）、parse（parseAlignedArray）、background（旁路表、alignments）、
   main.js（发送 align、校验 sum(n)、传给 inject）。
5. **hover.js**：消费 unit/align；双语气泡；行/段落降级；删除比例猜测。
6. **测试**：自检页面段/Ruby/对齐/生命周期；Node prompt/parse/pipeline；E2E 两个小说夹具。
7. **文档与版本**：TRANSLATION-ENGINE-HANDOFF、HANDOFF §14、CHANGELOG、三处 0.9.1。

## 8. 验证

```bash
node --test test/*.test.mjs
# 自检页（本机 headless Chrome 需要 --no-sandbox）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --user-data-dir=/tmp/chrome-selftest --allow-file-access-from-files \
  --virtual-time-budget=15000 --dump-dom "file://$PWD/selftest/index.html"
node tools/e2e-extension.mjs
```

E2E 至少新增：青空文库《罗生门》结构与 Pixiv 小说结构两个 fixture，检查 DOM 顺序、
可见文本、Ruby 显隐、悬停高亮 / 气泡、还原逐字一致。

## 9. 风险

- 结构化对齐改变模型输出格式 → 弱模型不遵守；已有 `parseArray` 兜底 + 段落级降级。
- 仅译文 Ruby 用「清空 + 独立容器」而非原地写基字 → 局部布局可能变化；以正确性优先，
  文字方向 / 竖排等特殊情况记录为未验证。
- 段落切分更细 → 单元数量和请求数可能略增；`splitLong` 与批次上限不变，
  实测对比请求数 / 字符数，若明显增加则只对「>=2 个空行段落」启用。
- 共用容器不写 `data-dt-src` → 旧诊断字段减少；`DT.diagnose` 改为输出 paragraph 信息。

## 10. 回滚

所有改动在独立分支；未改缓存 schema、未改配置结构。回滚 = `git revert` 本分支提交，
用户缓存与设置不受影响。
> **实施后调整（2026-10-19）**：
> 1) `pre-*` 单个文本节点内部的空行**不拆段**（合并成一个单元），避免引入 `splitText` 和跨段落偏移重映射；
>    段落拆分只依赖结构性分隔 `<br>`，青空文库 / Pixiv 的主场景已覆盖。行级悬停仍可用。
> 2) RenderTransaction 最终只保留 `insert / text / attr / style` 四种 op；没有 splitText。
> 3) 对齐结果不写缓存：`alignments` 走 service worker 内存旁路表，缓存仍是字符串，旧缓存降级为行 / 段落级。
> 4) 实施顺序按阶段 A→F 完成；最终测试为 Node 21 个文件、自检 151 / 151、真实 Chrome E2E 44 / 44。


