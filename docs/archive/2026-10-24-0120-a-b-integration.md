# 0.12.0 A+B 本地合并与联合验收报告

> 已归档，2026-10-24。记录 Agent A（行内格式保真）与 Agent B（自定义语言 / 趣味风格 / AI 精翻）直接合并到本地 `main` 的结果。当前技术契约见 [HANDOFF](../../HANDOFF.md) 与 [翻译引擎](../TRANSLATION-ENGINE-HANDOFF.md)；用户可见变更见 [CHANGELOG](../../CHANGELOG.md)。本报告不替代独立 QA。

## 1. 合并前状态

- 本地 `main` 与 `origin/main` 都在 `a909ec551f3642c76fd47b5b0e000ee12ceb4864`（0.11.7，tag `v0.11.7`），无分叉、无未推送提交。
- A：`feat/0.12.0-inline-fidelity`，`51588f03220da57ffd4c2f79df7ea1b386191960`。工作树 `edge-bilingual` 原样保留，未切换、未修改。
- B：`feature/language-style-context`，`3fd7d87cd047d67240c1015a09b00bcb2e888f96`。工作树 `_worktrees/rimfox-language-style-context` 原样保留，未切换、未修改。
- 合并前备份引用：`backup/pre-0120-final-merge` → `a909ec5`，未推送。
- 操作工作树：`_worktrees/rimfox-main-0120-merge`，检出本地 `main`。没有创建 integration 分支。

## 2. 合并提交

| 提交 | 内容 |
|---|---|
| `9678f88` | A 的 `--no-ff` 合并提交，保留 A 的两次提交 |
| `7d12ab3` | B 的三方合并提交；解决 6 个冲突文件，并包含本报告的 P2-1 / P2-2 / P3-1 修复 |
| 本报告提交 | 最终 local `main` HEAD；提交号见 `git log -1` 与交付消息 |

A 和 B 的原分支引用未改写、未删除。没有 force push、没有覆盖未提交工作、没有丢弃 main 已有提交。

## 3. 冲突与实际解决方式

独立 QA 预测的 6 个冲突全部出现，均手工阅读双方实现后组合：

| 文件 | 解决方式 |
|---|---|
| `lib/prompt.js` | 第 9 参数统一兼容：布尔值 = A 的 `inlineMarked`；对象 = B 的 `{languageInfo, intensity, contextInstructions, inlineMarked}`。生产调用统一传对象。同时保留 `<fN>` 行内语义段、`<kN>` 保留段、自定义语言说明、趣味强度、AI 上下文和 JSON 输出协议。 |
| `background.js` | `translateBatchWithRetry(..., inlineProtocol, policy)` 同时接收两套身份；缓存 scope 组合 `inline-v1` / `lang-v1` / `style-v2` / `ai-v1` / professional / endpoint；复核同时保留行内校验与语言 / 风格身份；失败返回同时带 `inlineErrors` 和 `context`。 |
| `content/main.js` | 保留 A 的受保护 / 标题采集和 B 的正文可见性过滤；待应用目标 `targetPending` 在队列前提前返回；动态补翻消息同时带 `inlineProtocol` 和 `intensity`；上下文批次对行内单元使用可见文字，并保留医学 / AI 隐私分支。 |
| `content/dom.js` | 原子标签的目标语言统一使用 `targetCode || target`；同时保留 A 的 `inlineLabel` 和 B 的 BCP 47 code。 |
| `test/content-main.test.mjs` | A、B 的测试块全部保留；补齐被冲突分开的测试结尾，没有删除或弱化断言。 |
| `docs/archive/README.md` | A、B 两份归档报告各保留一行。 |

自动合并但人工复核过的文件：`HANDOFF.md`、`content/core.js`、`selftest/test.js`、`tools/e2e-extension.mjs`、`test/translate-pipeline.test.mjs`。两边的状态字段、测试与 E2E 段落都保留；没有用旧版 0.11.7 manifest / package / core 覆盖 0.12.0。

## 4. A / B 功能保留

A 保留：有限语义格式协议、局部格式重建、简单链接标签事务改写、保护内容空占位、严格结构校验与零写入回滚、RenderTransaction、双语 / 仅译文精确恢复、字体与方向策略、行内布局 557 断言。

B 保留：配置 v8、自定义目标语言（id / BCP 47 / 说明 / 无代码降级）、RTL、自定义语言 UI 与导入合并、趣味风格与三档强度、风格零请求生命周期、AI 精翻上下文 / 预算 / 隐私 / 缓存身份、删除在用语言 pending、标题变化 stale。

组合后：自定义语言 + 行内格式 + 趣味强度 + AI 上下文可以同时出现在同一请求；提示词仍只有一个目标语言和一套 JSON 输出规则；缓存只追加实际启用的可选段。

## 5. A 分支既有缺陷修复

| 编号 | 处理 | 证据 |
|---|---|---|
| P2-1 段内 button / label / summary 文字被清空 | `keepElOf` 把控件文字作为 `control` 原子；`hasKeepInside` 识别控件；`hideKept` 永不隐藏控件。按钮标签、节点和事件保留，译文写在控件外。 | `selftest:visual:control-label-preserved`、精确还原断言 |
| P2-2 局部装饰空壳 | 新增事务内 `hideEmptyFormatShells`：只隐藏已无文字、无子结构、非链接的原格式元素；restore 逐字恢复。不复制站点背景 / 边框，也不全局隐藏 `strong/code/sup`。 | `selftest:visual:decorated-source-empty-shell-hidden`、`translated-format-shell-kept`、精确还原断言 |
| P3-1 中文目标整段英文被缓存 | `lib/lang-guard.js` 增加对称保守守卫：CJK 目标下拉丁字母占比 ≥ 0.8、长度 ≥ 40、有句末标点才判异常；只影响缓存 / 对齐，不追加请求。短文本、品牌、缩写、代码和中英混排不判。 | `test/lang-guard.test.mjs`、`test/translate-pipeline.test.mjs` 的中文目标整段英文不写缓存、下次重新请求 |

未在本次修复的 A 方 P3：P3-2 自然语言前言剥离、P3-3 普通文本形似标记、P3-5 截断长度提示、P3-6 无链接纯数字上标原子、P3-7 e2e 默认 `--no-sandbox` 工具参数。它们不影响 P2 / P3-1 的发布阻塞判断，保留为后续保守改进；本机 E2E 使用独立 no-sandbox 包装脚本，未修改扩展权限。P3-8 空节点由 P2-2 一并处理。

## 6. 请求次数与缓存验证

合并后完整扩展 E2E（真实 Chrome + 本地假 API）：

- 总结果：221 / 221 PASS；假接口请求 99 次、送翻 218 条。
- 趣味风格：切换下拉框 0 请求；连续快速切换 5 次仍 0 请求；只有明确重译才产生请求。
- AI 精翻：只改 `document.title` 0 请求；只改章节最多只请求新章节；隐私开启时上下文整段不发送；同一次翻译不额外增加模型调用。
- 删除在用自定义语言：删除时 0 请求；旧译文保持 `yue-Hant-HK`，`targetPending=true`；明确重译后才 +1 请求并切到 zh-CN。
- 医学模式关闭后普通缓存 90 → 90 命中；重新打开 B 站评论区相同评论 213 → 213 命中。
- 自定义阿拉伯语 RTL PASS：`dir=rtl`、computed `rtl`，提示词使用 `العربية (ar)`。
- 默认缓存身份：内置语言 + plain + AI 关闭时 `inline` / `lang` / `styleVersion` / `ai` 段都不出现；旧普通键不变。只有实际启用对应功能时才追加身份，避免一次性全站失效。

## 7. 完整测试结果

| 检查 | 结果 |
|---|---|
| Node `--test test/*.test.mjs` | 40 个文件 / 101 个测试，全部通过 |
| 离线自检 `selftest/index.html` | 263 / 263 全部通过 |
| 完整扩展 E2E | 221 / 221 通过；请求 99 次 / 218 条 |
| inline-layout 三视口 / 缩放矩阵 | 每档 557 / 557，附自检 263 / 263 |
| 真实青空文库（本地假 API） | 13 / 13 PASS；29 段、双语 / 仅译文 / 恢复 / 动态补翻 |
| 真实朝鲜日报（本地假 API） | 9 / 9 PASS；字体 A/B、双语、仅译文、关闭恢复 |
| 发版说明检查 | `python3 tools/check-release-notes.py 0.12.0` 合规 |
| 打包 | 90 个运行时文件；ZIP 根有 manifest.json |
| 静态检查 | 关键 JS `node --check` 全过；`git diff --check` 干净；无密钥命中 |

测试失败到通过的证据：首次合并全量 E2E 为 219 / 221，失败为医学关闭后缓存未命中与 B 站重开缓存未命中。根因是中文目标下假接口仍只回 `译:English`，被新 P3-1 守卫正确判为错误语言而不写缓存；不是生产缓存键回归。把假接口的中文目标回复改为中文占多数后，两项恢复为命中；同时修正假接口尾部的引用断言，最终 221 / 221。

## 8. 版本与发布文档

- `manifest.json` / `content/core.js` / `package.json` 全部为 **0.12.0**。
- `CHANGELOG.md` 的 0.12.0 节为 6 条用户可感知变化，覆盖行内格式 / 链接 / 保护内容 / 自定义语言 / 趣味风格 / AI 精翻。
- `README.md` 增加自定义目标语言、AI 精翻和有限行内保真说明。
- `docs/ROADMAP.md` 增加 0.11.7 / 0.12.0 完成项与 0.12.0 当前状态。
- `HANDOFF.md` 配置版本改为 v8，更新已知问题、缓存身份和本版技术记录。
- `docs/TRANSLATION-ENGINE-HANDOFF.md` 记录合并后的可选缓存身份。
- 版本未提前升到 0.13.0；未创建 Release，未改商店材料。

## 9. 尚未解决的限制

- 未调用用户真实付费模型；真实模型对 `<fN>` / `<kN>` 的遵守率、语义格式对应质量和 Token 成本仍需付费抽样。
- 只验证 Chrome 156；Edge 未跑。
- A 方 P3-2 / P3-3 / P3-5 / P3-6 / P3-7 未修；P2-2 采用“隐藏空壳”而非复制站点装饰，译文不会获得原背景 / 边框，但不会留下可见空块。
- 行内格式仍是有限保真：复杂链接、分行失配、无法可靠映射时保留原文；不保证所有出版社的未知结构。
- E2E 假接口的中文目标回复已改为中文占多数，以符合 P3-1 守卫；这只改变测试夹具，不改变生产回包逻辑。
- 真实青空文库 / 朝鲜日报使用本地假 API，不能证明真实模型译文质量。
- 两个原 QA 克隆（`edge-bilingual-qa-0120`、`edge-bilingual-qa-features`）保持只读，未修改。

## 10. Git 状态

- 本地 `main`：A 合并 + B 合并 + 本报告提交；工作树干净。
- `origin/main` 仍为 `a909ec5`；本地 main 未推送。
- `backup/pre-0120-final-merge` 保留；A/B 原分支保留；QA 克隆保留。
- 没有 integration 分支，没有 force push。

## 11. 独立 QA 交接条件

满足：A+B 已实际合入本地 main；冲突全部手工解决；P2-1 / P2-2 / P3-1 已修并有回归；本地全量 Node、自检、扩展 E2E、inline-layout、真实网页检查通过；版本与 Release 文档正确；工作树干净。

下一步由独立 QA 在隔离环境对最终 local main 重跑完整联合回归。**在用户明确“可以推送”之前不执行 git push。**
