# 2026-10-20 文档去重与代码去重（交接记录）

> **已归档** —— 这是一次性记录（2026-10-20 做的一次结构性整理），不是「现在怎么做」。
> 现状以 [ROADMAP](../ROADMAP.md)、[HANDOFF](../../HANDOFF.md)、[STORE](../STORE.md) 为准。
> 写这份的原因：让之后接手的 agent（包括不在同一台机器上的）能知道这一天动了什么、为什么动、什么故意没动。

## 一页结论

| 项 | 结果 |
|---|---|
| 版本 | **仍然是 0.9.8，没有升号**（纯文档 / 纯重构，按 ROADMAP §5.1 不升） |
| 文档 | 23 份 → **16 份在册** + 6 份归档（另加 1 份归档索引） |
| 代码 | `applyUiTheme` 两处合一；三个 pipeline 测试的假 `chrome.storage` 合一；新增 1 个主题单测 |
| 验证 | `node --test test/*.test.mjs` **25/25 全绿**；Markdown 相对链接 **105 条、0 失效** |
| 没做 | CDP 驱动抽取（`tools/lib/cdp.mjs`）——当次环境跑不起真实浏览器，方案留在本文末 |

## 为什么动

当时的状态是：同一个事实有 2–4 个主人，而且已经开始互相矛盾。三个实例：

1. **自检用例条数**有三个版本：HANDOFF §7.1 说 211、§11 说 201、ROADMAP §6 说 163，实测 213。
2. **PDF 是否进 0.10.0**：ROADMAP §4 说要同版并行，HANDOFF §10 说「单独立项，别混进这个仓库」。
3. **商店材料四份**：`STORE.md`（通用 + Chrome）、`EDGE-STORE.md`（Edge 差异）、`STORE-READINESS.md`（0.8.5 的审计快照）、`STORE-VALIDATION.md`（验证流水）。后两份是历史，却和现状并列；0.8.5 的审计还写着「还差 5 项」，到 0.9.8 读起来仍然像现状。

## 文档：谁去了哪里

| 原来 | 现在 | 为什么 |
|---|---|---|
| `STORE-READINESS.md`（根目录，125 行） | [STORE-READINESS.md](STORE-READINESS.md)（归档） | 0.8.5 的快照，不是现状；其中的「差 5 项」已概括进 STORE.md「当前状态」 |
| `docs/STORE-VALIDATION.md`（86 行） | [STORE-VALIDATION.md](STORE-VALIDATION.md)（归档） | 每次发版的验证流水，历史记录 |
| `docs/STABILITY-AUDIT-0.9.2.md`（86 行） | [STABILITY-AUDIT-0.9.2.md](STABILITY-AUDIT-0.9.2.md)（归档） | 一次性审计 |
| `docs/TOKEN-AUDIT.md`（100 行） | [TOKEN-AUDIT.md](TOKEN-AUDIT.md)（归档） | 一次性审计 |
| `docs/AIFW-PRIVACY-EVAL.md`（357 行） | [AIFW-PRIVACY-EVAL.md](AIFW-PRIVACY-EVAL.md)（归档） | 评估已完成，结论早已落进 `lib/privacy.js` |
| `docs/aegis/plans/2026-10-19-dom-translation-units.md`（157 行） | [2026-10-19-dom-translation-units-plan.md](2026-10-19-dom-translation-units-plan.md)（归档） | 0.9.1 已发布，计划作废 |
| `docs/EDGE-STORE.md`（280 行） | [STORE-EDGE.md](../STORE-EDGE.md) | 与 STORE.md 职责重叠，改成「只写 Edge 差异」，文件名对齐 |
| `docs/DESIGN.md`（228 行） | 已删除，内容并入别处（见下节） | 讲的是 0.2 时代的切分模型，真实实现早已是 `units.js` / `dom.js` |

## DESIGN.md 的 228 行去哪了（重要：没有内容凭空消失）

| DESIGN.md 的段落 | 现在的归属 |
|---|---|
| §1 整体结构 | [HANDOFF](../../HANDOFF.md) §3 目录与职责、§4 运行时架构 |
| §2 切分模型（单元定义 / 下钻 / 长文本拆分） | [HANDOFF](../../HANDOFF.md) §5.1、[TRANSLATION-ENGINE-HANDOFF](../TRANSLATION-ENGINE-HANDOFF.md) §2 |
| §3 注入策略（追加 / 原地替换 / `textOf` 排除自己） | [HANDOFF](../../HANDOFF.md) §5.2、§5.3 |
| §4 生命周期与动态内容 | [HANDOFF](../../HANDOFF.md) §5、[TRANSLATION-ENGINE-HANDOFF](../TRANSLATION-ENGINE-HANDOFF.md) §5 |
| §5 可靠性与并发 | [HANDOFF](../../HANDOFF.md) §4、[TRANSLATION-ENGINE-HANDOFF](../TRANSLATION-ENGINE-HANDOFF.md) §6 |
| §6 状态与标记 | [HANDOFF](../../HANDOFF.md) §12 代码约定（`data-dt-*`） |
| §7 已知取舍（含「原因」列） | [ROADMAP](../ROADMAP.md) §7 已知限制（保留了「为什么这样」这一列） |
| §8 改代码前的检查 | [ROADMAP](../ROADMAP.md) §6、[HANDOFF](../../HANDOFF.md) §12 |

## 现在的单一主人（改文档前先看这张表）

| 事实 | 主人 |
|---|---|
| 版本号规则、发版说明、提交与推送 | [AGENTS.md](../../AGENTS.md) |
| 接下来做什么、优先级、版本安排、用户向限制 | [docs/ROADMAP.md](../ROADMAP.md) |
| 架构、消息协议、踩坑、调试、配置项、技术向已知问题、发版技术命令 | [HANDOFF.md](../../HANDOFF.md) |
| 翻译引擎实现（单元模型 / 渲染 / 句子对齐） | [docs/TRANSLATION-ENGINE-HANDOFF.md](../TRANSLATION-ENGINE-HANDOFF.md) |
| 上架材料 | [docs/STORE.md](../STORE.md)（通用 + Chrome）、[docs/STORE-EDGE.md](../STORE-EDGE.md)（Edge 差异） |
| 隐私 | [PRIVACY.md](../../PRIVACY.md)、[docs/privacy.en.md](../privacy.en.md) |
| 每版用户可见变更 | [CHANGELOG.md](../../CHANGELOG.md) |

这张表同时写进了 [AGENTS.md](../../AGENTS.md)「文档」一节，以后加文档先对照它。

## 代码：合了什么

| 重复 | 证据 | 处理 |
|---|---|---|
| `applyUiTheme` | `options/options.js` 与 `popup/popup.js` 里 20 行**逐字相同**（连注释） | 移到 `lib/ui-appearance.js` 导出，两处改成 `import`；新增 `test/ui-theme.test.mjs` 锁行为（深 / 浅 / auto、`localStorage` 被禁用仍上色） |
| 假 `chrome.storage` | `test/privacy-pipeline`、`translate-pipeline`、`usage-pipeline` 各一份，已经**悄悄分成三版**（深拷贝 / 默认值 / 是否暴露 data 都不同） | 抽到 `test/_fake-storage.mjs`，用 `clone` / `withDefaults` / `exposeData` 三个选项**原样保留**各自行为 |

## 有意保留的「重复」（别以为漏了）

- `content/dock.js` 与 `content/hover.js` 都有 `showTip` / `hideTip`：**同名不同义**（悬浮球提示 vs 长文原文气泡），合并会把两件事捏成一件。
- `lib/engines/{openai,gemini,anthropic}.js` 的 6 个同名导出（`endpointOf` / `buildRequest` / `usageOf` / `parseResponse` / `parseError` / `parseModels`）：这是**接口契约**，本来就该同名。
- **跨 `content/` 与 `lib/` 的纯函数必然有两份**：`content/` 是 ES5 全局脚本（零构建），`lib/` 是 ESM。`NO_SPACE`（中日韩拼接）和 CJK 判定就各有一份。这条已经是结构性的，删不掉——所以 AGENTS.md 立了规矩：允许两份，但必须有差分测试，否则不许新增第二份。

## 没做的：CDP 驱动抽取

`tools/e2e-extension.mjs`（1270 行）与 `tools/screenshot-store.mjs`（391 行）共享 19 个符号（`until` / `attach` / `openTab` / `tabMsg` / `evaluate` / 一整套 Chrome 启动参数等）。合并价值最高，但**当次环境跑不起来真实浏览器**：Chrome 能启动、能加载 localhost 页面，可 CDP `Extensions.loadUnpacked` 之后再不回包（另有 tmpdir、crashpad 只读限制与 Chrome 15x 需要 `--enable-unsafe-extension-debugging` 的差异）。`tools/` 是唯一的真实浏览器验证通路，改完没法跑就等于没验证，所以宁可不改。

下次做的话现成方案：

1. 新建 `tools/lib/cdp.mjs`，导出 `sleep` / `until` / `cli(argv, toolUrl, defaultBrowserByPlatform)` / `launchBrowser({browser, debugPort, profile, headless, extraFlags})` / `connect(wsUrl, {onEvent})`。
2. `connect` 必须保留 `onEvent` 钩子：`e2e-extension.mjs` 的 `ws.onmessage` 还要收异常、console、`Network.requestWillBeSent`（字幕请求），不能塞进公共层。
3. 默认超时不一样：`screenshot-store` 的 `until` 默认 20000ms，`e2e-extension` 是 15000ms，用一个本地别名包一层保住原行为。
4. 验收：改前改后各跑一次 `node tools/e2e-extension.mjs`，对比结果条数与 `PASS` 全绿。

## 验证记录（当次）

```bash
node --test test/*.test.mjs      # 25 个文件全绿（原 24 + 新增 ui-theme）
```

- Markdown 相对链接：105 条，0 失效（脚本扫全部 `.md`，跳过 http / 锚点）
- 没有跑真实浏览器 e2e：原因见上节
- 没有升版本号、没有改 CHANGELOG（纯重构不发版）

## 当时留下的待决定（记录，不是待办）

1. **PDF 是否进 0.10.0** —— 已记进 [ROADMAP §9](../ROADMAP.md)；没拍板前按「0.10.0 只做 P1-2 行内标签保真」推进。
2. **是否上架** —— STORE.md「当前状态」写着：仍未上传、未提交审核、未注册开发者账号。这是所有版本号之前的闸门。

## 给异地 agent 的四条注意

1. **别在文档里写会过期的数字**（用例条数、文件个数、行数）。写命令，让读者看输出。当次删掉了 24 处这种数字。
2. **一个事实只写一遍**，其它位置只放链接。合并完就删掉副本，历史在 git 里。
3. **一次性记录放 `docs/archive/`**，并在该目录 `README.md` 登记一行；仓库其余文档只写现状。
4. **跨 `content/` 与 `lib/` 的纯函数**允许两份，但必须在 `test/` 里有差分测试（同一组输入喂两个实现、断言输出一致），否则不许新增第二份。
