> **已归档** —— 这是一次性记录（0.9.2 稳定性 / 性能 / 恶性 Bug 审计），不是「现在怎么做」。
> 内容反映归档当时的状态，可能已经过期。现状见 [STORE](../STORE.md)、[ROADMAP](../ROADMAP.md)、[HANDOFF](../../HANDOFF.md)。

# Rimefox 0.9.2 稳定性 / 性能 / 恶性 Bug 审计

- 审计基线 commit：`1081411`（0.9.1 已发布，0.9.2 修复分支 `fix/0.9.2-aozora-regression`）
- 审计修复 commit：`26bd85d`（本分支；未推送）
- 审计日期：2026-10-19
- 审计范围：`content/core.js`、`units.js`、`dom.js`、`main.js`、`hover.js`、`appearance.js`、`selection.js`、`input.js`、`subtitles.js`、`dock.js`、`background.js`、`lib/cache.js`、`lib/parse.js`、`lib/provider.js`、`manifest.json`、现有 Node / 自检 / E2E 架构
- 基线测试：Node `21/21`、离线自检 `157/157`、普通 E2E `44/44`、真实青空文库 `13/13`
- 审计后测试：Node `21/21`、离线自检 `159/159`、普通 E2E `44/44`、真实青空文库 `13/13`、稳定性基准见 `docs/verification/stability-audit.json`

## 结论

这次审计确认并修复了一个足以让浏览器主线程卡住一分多钟的注入热点，以及多个会在长文 / 无限滚动 / 动态页面中放大的 O(n²) 路径、无限状态表和过期 DOM 引用。修复后没有发现新的 P0；仍有一个**高负载初始扫描**警告（3000 段、18.8 万字，单次 388ms）和若干未完成的压力验证（见“剩余风险”）。

**建议：不因未解决的 P0 阻止 0.9.2；可以带警告发布。** 发布前仍需按 HANDOFF 流程由维护者确认，并保留真实长篇页面的回归截图。

## 发现与修复

| 等级 | 问题 | 触发条件 | 后果 | 状态 |
|---|---|---|---|---|
| P1（已复现） | 注入时反复读取实时 `CSSStyleDeclaration` | 同一容器 3000 段，逐段注入译文 | 每次插入后读样式触发整块重算，**3000 段注入 115.9 秒** | 已修：样式快照 + 同步批次缓存，20.4ms |
| P1（源码确认） | `cleanupDuplicateTargets` 对每个新增译文做 `querySelectorAll(':scope > [data-dt-target]')` | 大批译文插入，MutationObserver 逐条回调 | O(n²) 观察器回调，长文翻译越翻越慢 | 已修：`data-dt-unit` 登记表，克隆判断 O(1) |
| P1（源码确认） | `DT.tx` 局部撤销后仍保留已完成的 op | 模式切换 / 站点改写 / 悬停释放 | 每个 op 持有已恢复或脱离页面的节点，长时间运行内存只增不减 | 已修：op 标记 `done`、周期性压缩、restore 跳过 |
| P1（源码确认） | 脱离页面的 `rendered` 记录不释放 | 无限滚动、SPA 重建、节点被站点删除 | 元素已删除，记录仍持有 unit / node / ops | 已修：`DT.pruneDetached()` 在每轮翻译前清理 |
| P1（源码确认） | `findRenderedFor` 线性扫描同容器全部记录 | 一个容器几千段 | 每段收集 O(U²) | 已修：index / sig / 文本节点三套索引 |
| P1（源码确认） | Ruby 每段 `querySelectorAll('ruby')` + Range 相交 | 长文 + 每段 Ruby | O(段落 × Ruby) | 已修：按文档顺序一次分配；全渲染时懒执行 |
| P1（源码确认） | `fillSnapshot` 每个字符都线性查重 | 单段大量行内节点 | O(字符 × 节点) | 已修：`Set` 去重 |
| P1（源码确认） | `MAX_UNITS` 只在 walk 入口检查 | 一个容器切出上万段 | 单次收集可远超上限 | 已修：段循环、`collectAll` 全局都生效 |
| P1（已复现） | 多段落共用元素时状态按 `el` 记录 | 一段失败 / 抖动，同容器其它段 | 退避互相覆盖、churn 一起停 | 已修：按段序号隔离；新增回归测试 |
| P1（已复现） | 已翻译容器每次增量重扫仍跑 textMap / 布局 | 长文翻译完成后滚动 / 动态重扫 | 3000 段重扫 1.5 秒 | 已修：源文本签名 + 全渲染早退，5.7ms |
| P2 | iframe 也装观察器 / 快捷键 / 定时器 | 广告、评论嵌入页 | 每个子框架空转 | 已修：加载配置后顶层判断，iframe 提前返回 |
| P2 | 每次 mousemove 同步做 caret + 文本映射 | 长段落 / 大量 Ruby | 主线程被高频事件占满 | 已修：requestAnimationFrame 节流，保留 `flushMove()` 测试入口 |
| P2 | 增量防抖每次变动重置 600ms | 聊天 / 论坛持续更新 | 永远等不到翻译 | 已修：首次变动定截止时间，只提前不推迟 |
| P2 | 每批重排都重新量所有段首矩形 | 滚动中的长文 | 数千次 Range / 布局读取 | 已修：本轮缓存 + 滚动失效 |
| P2 | `collectRoots` 用 `some(contains)` 过滤嵌套根 | 站点规则匹配很多节点 | O(n²) | 已修：祖先集合遍历 |

## 性能对照（真实 Chrome，直接页面基准）

工具：`node tools/stability-audit.mjs`；Chromium 版本和机器信息记录在 JSON 的 `environment`。这是**真实 Chrome 的 DOM 引擎**，但内容脚本以页面脚本方式加载，不覆盖 MV3 消息 / 后台 / 真实 API 链路。

| 场景 | 规模 | 收集 | 注入 | 重扫 | 恢复 |
|---|---|---:|---:|---:|---|
| 单段纯文本 | 1 万字 | 7.3ms | 1.0ms | 0.2ms | 通过 |
| 单段纯文本 | 10 万字 | 21.8ms | 3.0ms | 1.3ms | 通过 |
| 单段纯文本 | 50 万字 | 80.9ms | 11.5ms | 4.1ms | 通过 |
| 1000 段 + Ruby | 6.2 万字 | 63.8ms | 7.7ms | 2.5ms | 通过 |
| 3000 段 + Ruby | 18.8 万字 | 379.9ms | 21.6ms | 6.4ms | 通过 |
| 10000 节点嵌套 | 1000 行 | 45.2ms | 225.6ms | 34.8ms | 通过 |

- 修复前同一 3000 段注入：**115867.4ms**；修复后 **21.6ms**（约 5,400 倍）。
- 修复前 3000 段重扫：**1784ms / 1570ms**；修复后 **6.4ms**。
- 动态页面 20 轮（每轮加 20 段再删）：405.5ms，恢复通过，GC 后堆 2.1MB。
- 10 轮 × 500 段注入 / 恢复：43.4ms，GC 后堆 2.9MB（短周期未看到单调增长；不等于 15 分钟证明）。
- `longtask` 观察器没有记录到 >500ms 的任务；直接基准的同步时间本身已作为主线程阻塞上界。

## 真实扩展 / Mock API 验收

- 普通 E2E：44/44；Mock API 14 次请求、21 条文本；异常页 / service worker 无未捕获异常。
- 真实青空文库：13/13；29 段双语、仅译文首段 y≈30、可见 `rt=0`、关闭逐字恢复；
- 真实页面动态新增段落、模式切换、悬停对照均通过。
- 未做 429 / 500 / 超时 / 空结果 / 格式错误的**真实扩展压力**；这些只做了源码路径审计（重试最多 3 次，格式不匹配才二分拆批，失败按段退避；没有发现无限循环）。

## 剩余风险

1. **3000 段初始收集 388ms / 10000 节点注入 223ms**：高于 100ms 调查线，仍可能造成一次明显卡顿。当前没有做分时 textMap 或段落窗口化；需要产品层决定是否把超长页拆成多轮收集。
2. **没有 15–30 分钟连续运行 / CDP Heap Snapshot**：只有 20 轮动态 + 10 轮注入/恢复，`performance.memory` 在 `gc()` 后读取。不能宣称“长时间无泄漏”。
3. **没有真实 429 / 500 / 无网络 / service worker 被杀压力**；需要 Mock API 故障注入再补。
4. **真实模型 API / 竖排 / Edge / Pixiv / GitHub / YouTube 未验证**；本报告不覆盖这些站点。
5. **Shadow DOM 不遍历**（原有边界）；如果站点把正文放在 shadow root，本版本不会翻译。
6. `content/subtitles.js` 每 200ms 的 `setInterval` 在 YouTube 页面生命周期内常驻；当前 tick 很轻，但未做长时间观察。

## 测试入口

```
# 现有基线
node --test test/*.test.mjs
node tools/e2e-extension.mjs
node tools/e2e-extension.mjs --aozora-live

# 新增长文本 / DOM / 动态 / 内存基准（真实 Chrome；直接页面）
node tools/stability-audit.mjs

# 离线自检
# 按 HANDOFF §7 的无头 Chrome 命令打开 selftest/index.html
```

`stability-audit.mjs` 退出码 2 表示有超过审计警戒线的场景；这些是调查信号，不直接等于发布阻断。
