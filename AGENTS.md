# 给 AI agent 和协作者的约定

动手前先读 [HANDOFF.md](HANDOFF.md)：架构、消息协议、踩过的坑、调试方法、发版流程都在里面。下面是每次都要遵守的几条。

## 改代码

- 改 `content/dom.js` 前后都要跑离线自检 `selftest/index.html`（必须全部通过）；改 `lib/` 跑 `test/*.test.mjs`
- 版本号三处同步：`manifest.json` 的 `version`、`content/core.js` 的 `DT.VERSION`（这两处 CI 会校验）、`package.json` 的 `version`；怎么取号见下面「版本号规则」
- 内容脚本用 ES5 风格；译文只用 `textContent` 写入，不用 `innerHTML`；其余约定见 HANDOFF「代码约定」
- 跨 `content/`（ES5 全局脚本）和 `lib/`（ESM）都要用的纯函数**允许存在两份**，但必须在 `test/` 里加一条**差分测试**（同一组输入喂两个实现、断言输出一致）；没有差分测试就不许新增第二份
- 涉及下拉框、翻译生命周期、请求次数或缓存身份的改动，必须补真实 Chrome + 假 API 的 E2E；Node / 自检不能单独证明「切换不产生请求」或「旧译文仍保留」
- E2E 假接口必须按目标语言回包。新增语言校验后，先确认产品行为正确，再调整测试夹具；不要为了让缓存测试变绿而放宽生产校验
- 提交用 GitHub 的 noreply 邮箱（`<ID>+<用户名>@users.noreply.github.com`），不要把个人邮箱写进提交记录

## 提交与推送

本地可以慢慢做，分多个小 commit 都可以；**不要做一点推一点**。一个任务的**全部要求**做完、测完，先停下来问人，得到明确同意才推一次：

1. 把本次任务的全部要求做完，不只是做一个切片就交付；工作树没有未提交的改动；同一功能的 fixup 可以在推送前 squash
2. 跑完 HANDOFF §7 的离线检查：
   - `for f in test/*.test.mjs; do node "$f" || exit 1; done`，全绿
   - `selftest/index.html` 全部通过（按 HANDOFF §7 的无头 Chrome 命令）
   - 如果发版：`python3 tools/check-release-notes.py <版本号>`
   - 改设置页 / 字幕 / 划词：在真实页面各过一遍（设置页、YouTube 字幕、普通文章页）
   - 改扩展行为：确认 Chrome 实际加载的目录 / 扩展 ID，并在 `chrome://extensions` 重新加载后检查至少一个新入口；版本号相同不等于代码已更新（见 HANDOFF §7.1d）
3. `git fetch origin && git rebase origin/main`，确认没有落后；远端有新提交就 rebase，不要 force push
4. `git diff --check`、`git log origin/main..HEAD` 自审：没有密钥、没有无关文件、没有覆盖别人的改动
5. **停下来汇报并询问，不要自己 push**。汇报里写清：改了什么、跑了哪些检查、哪些没测、建议的版本号和 CHANGELOG 摘要、是否会触发 Release；然后问：
   - 「还有要继续做的吗？还是可以按 x.y.z 推送新版本了？」
6. 得到「可以推送」后才定稿版本号 / CHANGELOG（如还没定），再跑一次检查，**一次 `git push origin main`** 推完所有本地 commit。
   得到「继续做」就继续在本地改；没有回复就保持本地，不推。
7. 推送后核对 `origin/main`、Actions 和 Release 的实际结果；发布失败要如实报告，不能把「已 push」当成「已发布」。

测试失败、有未解释的 diff、或手动检查没做：不推，先修。测试通过不等于发布许可，不要把「全绿」当成「可以发」。
如果对方只想同步代码、不想发版，按对方说的保持 `manifest.json` 版本不变再推。
大改动开分支，验证完再合回 main 推一次。
推 main 且改了 `manifest.json` 会触发 Release，推送前确认版本号和 CHANGELOG 是最终版。
不要用 `git push --mirror`（本地有 `refs/stash`），也不要在没有明确要求时 force push。

## 文档

一个事实只写一遍，其它地方只放链接。改文档前先看这张表：

| 事实 | 唯一主人 |
|---|---|
| 版本号规则、发版说明、提交与推送 | 本文件 |
| 接下来做什么、优先级、版本安排、用户向已有限制 | [docs/ROADMAP.md](docs/ROADMAP.md) |
| 架构、消息协议、踩坑、调试、配置项、技术向已知问题、发版技术命令 | [HANDOFF.md](HANDOFF.md) |
| 翻译引擎实现（单元模型 / 渲染 / 句子对齐） | [docs/TRANSLATION-ENGINE-HANDOFF.md](docs/TRANSLATION-ENGINE-HANDOFF.md) |
| 上架材料 | [docs/STORE.md](docs/STORE.md)（通用 + Chrome）、[docs/STORE-EDGE.md](docs/STORE-EDGE.md)（Edge 差异） |
| 隐私 | [PRIVACY.md](PRIVACY.md)、[docs/privacy.en.md](docs/privacy.en.md) |
| 每个版本的用户可见变更 | [CHANGELOG.md](CHANGELOG.md) |

- **不要在文档里写会过期的数字**（用例条数、文件个数、行数）：写命令，让读者看输出
- 一次性记录（审计、评估、验证流水、已完成的实施计划）放 [docs/archive/](docs/archive/README.md)，并在该目录 README 登记一行；仓库其余文档只写现状
- 合并完就删掉第二份，不要留「以防万一」的副本：历史在 git 里

---
## 版本号规则

在用户明确提出发布 **1.0 正式版**之前，一律用 `0.x.y`，不要自己升到 `1.0.0`。

- 新功能、较大改动：升中间位，末位归零（`0.7.0` → `0.8.0`）
- 只修 bug、小调整：升末位（`0.7.0` → `0.7.1`）
- 中间位不封顶：`0.9.x` 之后是 **`0.10.0`**、`0.11.0`、`0.12.0`……，不是 `1.0.0`
  （Chrome 和语义化版本都按点分数字逐段比较，`0.10.0` 比 `0.9.9` 新，自动更新不受影响）
- 之后可能用到的号码：`0.7.1`（0.7.0 的修复）→ `0.8.0` → `0.9.0` → `0.10.0` → `0.11.0` → …
- `1.0.0` 只在用户要求时使用；到那时承诺配置结构稳定、迁移可回退

## 发版说明（CHANGELOG → Release 页面）

`CHANGELOG.md` 里 `## <版本号> — <标题>` 这一节会原样成为 GitHub Release 的说明，必须遵守：

1. 每版 **3–6 条**，每条以 `- ` 开头，**一句话、不超过 90 字**，**不许有子项**（不缩进、不嵌套、不写段落）
2. **只写用户会感觉到什么**（看到了什么变化、哪里更好用了、哪个问题不再出现），不写怎么实现
3. 内部重构、测试、CI、文件名、函数名一律不写进发版说明：写进 HANDOFF 的「本版技术记录」或 commit message
4. 一次发版只写这一版，不把多个版本的改动攒在一起

写完先自查，CI 发版前也会跑同一个检查，不合规就不发布：

```bash
python3 tools/check-release-notes.py <版本号>
```

示例：

```markdown
## 0.5.2 — 小修复
- 悬停对照改为逐句高亮：鼠标停在哪一句，就只高亮这一句原文和对应的译文
- YouTube 字幕双语改为默认关闭，需要时在设置页「划词与字幕」里打开
```

反例（不要这样写）：「新增 `content/hover.js`，用 CSS Custom Highlight API 实现」——这是实现细节，应写进本版技术记录。

## 本版技术记录

每次发版，把实现细节、取舍、内部重构、测试变化写进 HANDOFF.md 的「本版技术记录」一节（整节替换成这一版的内容；旧版本的记录看 git log 和 commit message）。
