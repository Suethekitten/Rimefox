# 上架材料验证记录

日期：2026-10-18。输入为用户提供的 Rimefox-v0.6.2.zip。

| 检查 | 结果 |
|---|---|
| 指定初始文件 | 已读 AGENTS.md、HANDOFF.md、PRIVACY.md、manifest.json、README.md；附件缺 package.ps1 与 .github/workflows/release.yml，无法审计原打包/CI |
| git status -sb && git log --oneline -5 | 已执行，fatal: not a git repository；附件无 .git，无法确认原仓库 main/远端/未推送记录，未创建替代历史、未本地提交 |
| 原有 Node 测试 | 完整执行 for f in test/*.test.mjs; do node "$f" || exit 1; done，原有 9 个测试文件共 160 条通过 |
| 新增打包测试 | 同一循环执行 test/package-store.test.mjs 通过；验证白名单、嵌套排除、跨工作目录、逐文件解压比对、可重复输出、版本不一致/图标缺失拒绝及失败不覆盖已有包 |
| ZIP 独立验证 | unzip -t 与 Python zipfile.testzip 均通过，41 个文件，manifest 在根目录，无开发目录 |
| manifest 检查 | 移除 tabs，通用内容脚本有 3 条 exclude_matches；其余内容脚本与版本不变 |
| 版本/CHANGELOG | 与输入逐项比较：manifest 与 DT.VERSION 保持 0.6.2；CHANGELOG 字节完全一致 |
| 浏览器 selftest | 未通过运行验证：Playwright 可用，但环境缺 Chrome/Chromium 可执行文件，启动失败。附件 HANDOFF 没有可用的无头命令。需在原电脑打开 selftest/index.html，确认 88/88 |
| 扩展权限、真实页面/API | 未验证，需原电脑检查取消 tabs 后的快捷键/广播/补注入、排除域名、划词、设置、YouTube。无真实 Key，未调用收费接口 |
| Git diff 检查与提交 | 原仓库不可用；提供补丁及独立修改文件，不宣称原仓库 clean 或 commit 已完成 |
| 发布与 Demo | 未 push、未改版本、未改 CHANGELOG、未注册/登录账号、未上传、未提交审核、未实现 Demo |

源码变更仅为 manifest.json、PRIVACY.md，以及新增 tools/package-store.mjs、test/package-store.test.mjs、docs/privacy.en.md、docs/STORE.md、docs/STORE-VALIDATION.md。docs/STORE.md 说明真实支持链接、公开政策、审核访问路径与素材仍待人工补充。

补丁仅相对于上传快照，不能直接覆盖电脑上可能更新的源码。请先 git apply --check，审阅并解决差异，跑 Node 与浏览器自检后以本人 GitHub noreply 身份做本地提交，再停下来决定下一步。任何推送均另行授权。

## 0.7.1 许可文件补充验证

- 商店包已包含 LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt
- 构建命令：`node tools/package-store.mjs`
- 验证命令：`unzip -l dist/Rimefox-v0.7.1-store.zip`、`unzip -t dist/Rimefox-v0.7.1-store.zip`
- 测试：`node test/package-store.test.mjs`
- 结果：53 个文件、248,250 B；ZIP 根目录含 manifest.json、LICENSE、THIRD-PARTY-NOTICES.md，`licenses/oneaifw-MIT.txt` 位于 licenses/ 下；`unzip -t` 无错误；打包测试 PASS；全套 14 个 Node 测试文件通过；自检 96 / 96。

## 0.7.2 上架前审计验证

- 审计对象：`main` @ `5eaa5c1`（Rimefox 0.7.2）
- 构建命令：`node tools/package-store.mjs`
- 验证命令：`unzip -l`、`unzip -t`、`node test/package-store.test.mjs`、Chrome `--pack-extension`
- 结果：`dist/Rimefox-v0.7.2-store.zip` 53 个文件、248,692 B；manifest.json 在根目录；LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt 齐全；`unzip -t` 无错误；打包测试 PASS；14 个 Node 测试文件全部通过；自检 98 / 98；Chrome 打包校验成功（CRX3）
- 未上传、未提交审核、未注册账号、未付款；详见 [../STORE-READINESS.md](../STORE-READINESS.md)

## 0.8.0 首次安装欢迎页验证

- 审计对象：`main`（Rimefox 0.8.0）
- 构建命令：`node tools/package-store.mjs`
- 验证命令：`unzip -l`、`unzip -t`、`node test/package-store.test.mjs`、Chrome `--pack-extension`
- 结果：`dist/Rimefox-v0.8.0-store.zip` 57 个文件、270,824 B；manifest.json 在根目录；`welcome/index.html`、`welcome/welcome.css`、`welcome/welcome.js`、`lib/welcome.js` 均在包内；LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt 齐全；`unzip -t` 无错误；打包测试 PASS；15 个 Node 测试文件全部通过；自检 98 / 98（本次实际运行；未改内容脚本）；Chrome 打包校验成功（CRX3）
- 欢迎页检查：无头 Chrome 在 1440px 桌面与 390px 窄屏、中文 / English、浅色 / 深色下截图检查；CDP 注入 chrome API 模拟验证语言 / 主题持久化、设置按钮和版本号显示；页面无远程 JS/CSS/字体，无内联事件，未新增权限
- 未实机验证：本机 Chrome 155 headless 不加载 `--load-extension`（最小扩展同样不加载），因此 Chrome / Edge 首次安装自动打开、更新 / 重启不打开、商店包安装后的真实扩展进程未实机验证；安装判定由 `test/welcome.test.mjs` 的纯函数测试覆盖
- 未上传、未提交审核、未注册账号、未付款、未推送；详见 [../STORE-READINESS.md](../STORE-READINESS.md)

## 0.8.1 Aeon 中文排版修复验证

- 审计对象：`main`（Rimefox 0.8.1）
- 构建命令：`node tools/package-store.mjs`
- 验证命令：`unzip -l`、`unzip -t`、`node test/package-store.test.mjs`、Chrome `--pack-extension`
- 结果：`dist/Rimefox-v0.8.1-store.zip` 57 个文件、272,900 B；manifest.json 在根目录；`welcome/`、`lib/welcome.js`、`content/core.js`、`content/dom.js`、`content/main.js`、`content/styles/inject.css` 均在包内；LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt 齐全；`unzip -t` 无错误；打包测试 PASS；15 个 Node 测试文件全部通过；自检 104 / 104（新增 Aeon 大标题 / 首字下沉 / 紧行高 / 引用富文本 / 窄容器 6 条）；Chrome 打包校验成功（CRX3）
- 真实浏览器检查：本机 Chrome 通过 CDP `Extensions.loadUnpacked` 加载当前仓库，配合本地 OpenAI 兼容假接口打开 Aeon 文章。修复前 `data-dt=null`、H1 `72/72`；修复后 `data-dt=on`、H1 `57.6/72`、正文 `22/30.8`，不刷新缩到 390px 时 H1 `33.6/42`、正文 `18/25.2`，回到 1440px 恢复；原站 dropcap 71.5px 保留，译文首字 22px。普通文章 1440/390 回归无重叠。
- 未验证 / 限制：翻译内容来自本地假接口，不是真实服务商；未验证 Edge 和真实 API Key；行内链接 / 粗体 / 斜体的译文仍是纯文本（原有已知限制）；仅译文模式的大标题仍沿用站点字号。极长标题翻译仍可能撑高 Aeon 英雄区。
- 0.8.1 已推送并发布为 GitHub Release `v0.8.1`；未上传商店、未提交审核、未注册账号、未付款；详见 [../STORE-READINESS.md](../STORE-READINESS.md)

## 0.8.2 仅译文首字下沉修复验证

- 审计对象：`main`（Rimefox 0.8.2）
- 构建命令：`node tools/package-store.mjs`
- 验证命令：`unzip -l`、`unzip -t`、`node test/package-store.test.mjs`、Chrome `--pack-extension`
- 结果：`dist/Rimefox-v0.8.2-store.zip` 57 个文件、273,626 B；manifest.json 在根目录；`welcome/`、`lib/welcome.js`、`content/core.js`、`content/dom.js`、`content/main.js`、`content/styles/inject.css` 均在包内；LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt 齐全；`unzip -t` 无错误；打包测试 PASS；15 个 Node 测试文件全部通过；自检 105 / 105（新增“仅译文 + 首字下沉”回归）；Chrome 打包校验成功（CRX3）
- 仅译文模式真实浏览器检查：Aeon 的 `.ld-dropcap` 段落修复前整个段落译文（385 字）被写进下沉字母 `<span>`；修复后下沉节点只保留译文首字（1 字），其余进入正文文本节点，正文恢复正常段落。0.8.1 的大标题缩放、`data-dt` hydration 补回、首字下沉归一化均保持。
- 未验证 / 限制：翻译内容来自本地假接口，不是真实服务商；未验证 Edge 和真实 API Key；行内链接 / 粗体 / 斜体的译文仍是纯文本（原有已知限制）；仅译文模式的大标题仍沿用站点字号。
- 本验证在推送前完成；未上传商店、未提交审核、未注册账号、未付款；详见 [../STORE-READINESS.md](../STORE-READINESS.md)

## 0.8.3 悬浮入口切换服务商验证

- 审计对象：`main`（Rimefox 0.8.3）
- 构建命令：`node tools/package-store.mjs`
- 验证命令：`unzip -l`、`unzip -t`、`node test/package-store.test.mjs`、Chrome `--pack-extension`
- 结果：`dist/Rimefox-v0.8.3-store.zip` 57 个文件、275,405 B；manifest.json 在根目录；LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt 齐全；`unzip -t` 无错误；打包测试 PASS；15 个 Node 测试文件全部通过；自检 106 / 106；Chrome 打包校验成功（CRX3）
- 商店截图：新增 5 张 1280×800（整页双语浅/深、划词、隐私设置、术语表），见 [screenshots/](screenshots/)；使用真实扩展界面 + 本地演示页与本地测试接口的示例译文，未使用真实 API Key
- 未验证 / 限制：没有用真实 API Key 跑端到端；未上传商店、未提交审核、未注册账号、未付款；详见 [../STORE-READINESS.md](../STORE-READINESS.md)
