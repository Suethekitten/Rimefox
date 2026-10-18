# 给 AI agent 和协作者的约定

动手前先读 [HANDOFF.md](HANDOFF.md)：架构、消息协议、踩过的坑、调试方法、发版流程都在里面。下面是每次都要遵守的几条。

## 改代码

- 改 `content/dom.js` 前后都要跑离线自检 `selftest/index.html`（必须全部通过）；改 `lib/` 跑 `test/*.test.mjs`
- 版本号两处同步：`manifest.json` 的 `version` 和 `content/core.js` 的 `DT.VERSION`，CI 会校验
- 内容脚本用 ES5 风格；译文只用 `textContent` 写入，不用 `innerHTML`；其余约定见 HANDOFF「代码约定」
- 提交用 GitHub 的 noreply 邮箱（`<ID>+<用户名>@users.noreply.github.com`），不要把个人邮箱写进提交记录

## 提交与推送

本地可以分多个小 commit，但**一个任务或一版功能没做完、没测完之前不要推**。推送只做一次：

1. 功能 / 修复全部写完，工作树没有未提交的改动；同一功能的 fixup 可以在推送前 squash，但不要把中间状态推上去
2. 跑完 HANDOFF §7 的离线检查：
   - `for f in test/*.test.mjs; do node "$f" || exit 1; done`，全绿
   - `selftest/index.html` 全部通过（按 HANDOFF §7 的无头 Chrome 命令）
   - 如果发版：`python3 tools/check-release-notes.py <版本号>`
   - 改设置页 / 字幕 / 划词：在真实页面各过一遍（设置页、YouTube 字幕、普通文章页）
3. `git fetch origin && git rebase origin/main`，确认没有落后；远端有新提交就 rebase，不要 force push
4. `git diff --check`、`git log origin/main..HEAD` 自审：没有密钥、没有无关文件、没有覆盖别人的改动
5. 以上都过，**一次 `git push origin main` 推完所有本地 commit**。不要边做边推，也不要推完再补一串小修

测试失败、有未解释的 diff、或手动检查没做：不推，先修。大改动开分支，验证完再合回 main 推一次。
推 main 且改了 `manifest.json` 会触发 Release，推送前确认版本号和 CHANGELOG 是最终版，不要把未完成的版本号推上去。
不要用 `git push --mirror`（本地有 `refs/stash`），也不要在没有明确要求时 force push。

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
