# Chrome Web Store 上架前审计（Rimefox 0.8.5）

审计日期：2026-10-19
审计对象：`main`（Rimefox **0.8.5**，在 0.8.3 审计基础上复核悬停气泡、三处快捷开关、YouTube 字幕稳定性与仅调试用量统计）
审计范围：manifest、权限、内容脚本、后台数据流、欢迎页、悬停对照、字幕运行时、隐私政策、商店包、测试、公开链接、Chrome Web Store 现行政策。

## 结论摘要

代码与商店包已经达到「可以上传」的合规状态；**当前还不能直接提交审核**，差的是非代码事项：确认截图样张、开发者账号、审核专用 API Key、控制台 listing / 隐私问卷，以及上传商店包。0.8.5 已发布 GitHub Release，商店包尚未上传。

本轮在 0.8.3 的基础上，加入悬停气泡尺寸/层级/展开、Dock / Popup / Options 三处 `hoverCompare` 开关、YouTube 字幕目标语言与视频切换稳定性，以及仅 `debug` 可见的本地用量计数；没有修改权限、API Key 存储、请求接收方或服务商协议，没有上传、没有提交审核、没有注册账号或付款。版本号与 CHANGELOG 已按仓库规范更新到 0.8.5。

---

## 一、已经完成

| 项目 | 结果与证据 |
|---|---|
| Git 状态 | 0.8.5 已推送并发布为 GitHub Release `v0.8.5`（发布提交 `938f1bf`，Actions 成功）；本轮商店文档同步为独立提交（不改 manifest，不触发 Release） |
| 版本一致 | `manifest.json`、`content/core.js` 的 `DT.VERSION`、`package.json` 均为 0.8.5 |
| Manifest V3 | `manifest_version: 3`；service worker 为 ESM；无 `update_url`、无自定义 CSP、无 `externally_connectable`、无 `optional_permissions` |
| 权限清单 | `storage`、`activeTab`、`scripting`、`contextMenus`、`host_permissions: <all_urls>`；未申请 `tabs` / `webRequest` / `cookies` / `history` / `downloads` 等 |
| 内容脚本 | 通用脚本 `<all_urls>` + 3 条 `exclude_matches`（Chrome Web Store 新旧域名、Google Accounts）；`all_frames: true`；YouTube 专用脚本仅匹配 3 个 YouTube 域名，其中字幕 hook 为 `world: MAIN` |
| 图标 | 16 / 32 / 48 / 128 / 256 PNG 均存在，打包脚本校验尺寸与 PNG 头 |
| 最低版本 | `minimum_chrome_version: 114`；`documentPictureInPicture`（116+）有特性检测并回退，不阻塞 114 |
| 单一用途 | 翻译网页 / 选中文字 / 弹窗文字 / YouTube 字幕；悬停对照、术语表、提示词、显示选项与可选隐私脱敏都服务这一用途 |
| 远程代码 | 未发现 `eval` / `new Function` / `importScripts` / 远程 `<script src>`；API 返回只按 JSON / 文本解析，不执行。所有 JS/CSS 随包交付 |
| API Key | 仅存 `chrome.storage.local`；`setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`；`config:get` 剥离 Key，内容脚本只拿 `hasKey`；诊断信息不含 Key |
| 数据流 | 待翻文本 / 选中文字 / 弹窗输入 / 字幕 / 提示词 / 命中术语只发往用户配置的接口；作者无服务器、无分析、无遥测、无第三方 SDK。0.8.5 的悬停开关、字幕修复与用量计数没有新增接收方或网络请求 |
| 缓存 | 会话缓存 `chrome.storage.session`；磁盘缓存仅短文本（≤160 字符，512 KB）并按域名 / 模型隔离；设置页可清空 |
| 隐私政策 | 已把版本号（0.8.5）、更新日期、接收方、HTTP 明文风险、Limited Use 声明、公开 Issues 联系方式写入 [PRIVACY.md](PRIVACY.md) 与 [docs/privacy.en.md](docs/privacy.en.md) |
| README | 未改「不含任何第三方产品代码」相关声明；MIT 复用内容见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| 商店文档 | [docs/STORE.md](docs/STORE.md) 已按 0.8.5 更新：真实链接、listing 文案、隐私问卷建议、权限说明、审核员步骤、素材与人工待办 |
| 历史记录 | [docs/STORE-VALIDATION.md](docs/STORE-VALIDATION.md) 追加 0.8.5 验证结果，旧记录未改 |
| 商店包 | `dist/Rimefox-v0.8.5-store.zip`，58 个文件，290,557 B；manifest.json 在 ZIP 根目录；含欢迎页、LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt |
| 欢迎页 | `welcome/index.html` + `welcome.css` + `welcome.js` 与 `lib/welcome.js` 已入包；无远程 JS / CSS / 字体 / 图片，无内联事件，无新增权限；首次安装自动打开，更新 / 重启不打开 |
| 悬停气泡 | 0.8.5：长段落 / 行级 / 段落级原文气泡有宽度 420px、高度 40vh / 340px 上限；默认 180 字符节选，支持展开 / 收起 / 关闭 / Escape，鼠标可移入滚动；短句仍是轻量提示 |
| 悬停层级 | 0.8.5：段落级标「段落级对应 / 原文节选」，行级标「行级对应」；没有重新启用按长度比例猜句子，可靠结构不足时仍整段回退 |
| 悬停开关 | 0.8.5：Dock 新增带 `aria-pressed` 的按钮，Popup 新增紧凑 switch；Options 复用原 `hoverCompare`。内容脚本只能通过后台 `hover:set` 修改严格布尔值，三处经 storage 广播同步，不改译文、缓存或触发 API |
| 悬停清理 | 0.8.5：配置变化、还原原文、切换双语 / 仅译文时主动清除 CSS Custom Highlight、`data-dt-hover`、气泡、文本表缓存和旧 Range |
| YouTube 字幕 | 0.8.5：目标语言切换、快速切视频、播放器 DOM 重建时用会话代际隔离旧请求；关闭 CC / 字幕翻译恢复原生字幕；无新增权限或接口 |
| 用量统计 | 0.8.5：仅 `debug` 开启时聚合 HTTP 次数、usage token、缓存、重试、拆批、失败与 finish_reason；只存数字，不存正文 / Key / Prompt / 原始响应，不新增请求 |
| 包内排除 | 无 `test/`、`selftest/`、`docs/`、`.github/`、`tools/`、`node_modules/`、`.DS_Store`、source / preview 图标；无 `sk-` / `AIza` / 私钥块等明显密钥 |
| 公开链接 | <https://github.com/Suethekitten/Rimefox>、`/issues`、`/blob/main/PRIVACY.md`、`/releases/tag/v0.8.5` 均返回 200 |
| 发布流程 | `.github/workflows/release.yml` 仅在 `manifest.json` / workflow 变更时触发；0.8.5 Release 成功，生成整仓发布包，不是商店包 |

### 测试结果

| 检查 | 命令 | 结果 |
|---|---|---|
| Node 单测 | `for f in test/*.test.mjs; do node "$f" || exit 1; done` | **19 个文件全部通过**（含 hover-config 6 条、字幕 A–J 10 条、usage 6 条、usage-pipeline 8 条） |
| 离线自检 | 无头 Chrome 打开 `selftest/index.html` | **129 / 129 通过**（新增长段落气泡、配置清理、Dock 中英文状态） |
| 商店包构建 | `node tools/package-store.mjs` | 58 个文件，290,557 B |
| ZIP 完整性 | `unzip -t dist/Rimefox-v0.8.5-store.zip` | 无错误；manifest.json 在根目录 |
| Chrome 校验 | `chrome --pack-extension=<解包目录>` | 成功生成 CRX3 |
| 打包测试 | `node test/package-store.test.mjs` | PASS |
| 浏览器同步 | Chrome for Testing 155 + 本地页面 | Dock → Popup → Options 双向切换，`aria-pressed`、switch 与 storage 一致；页面未发起翻译请求 |
| Markdown 链接 | 仓库内相对链接检查 | 56 个链接，0 失效 |
| 密钥扫描 | 对解包后的商店包做正则扫描 | 未发现明显密钥 |

### 链接检查

检查范围：README、PRIVACY、HANDOFF、THIRD-PARTY-NOTICES、本报告、docs/ 下 10 个 Markdown（含 screenshots/README.md、TOKEN-AUDIT.md）与 SECURITY.md，共 56 个相对链接；0 个失效。外部公开链接已用 HTTP 状态核对，见上表。

---

## 二、必须修复（提交审核前必须完成）

这些不是代码缺陷，但不完成就不能提交：

1. **截图确认**：5 张 1280×800 样张仍在 [docs/screenshots/](docs/screenshots/)（真实扩展界面 + 本地测试接口的示例译文，0.8.3 时生成）；需维护者确认采用，或用真实 API Key 按 [说明](docs/screenshots/README.md) 重拍；0.8.5 的悬停气泡未新增截图。
2. **开发者账号**：注册 Chrome Web Store 开发者、完成身份验证与 2FA、支付一次性费用；没有账号无法上传。
3. **审核专用 API Key**：扩展是 BYOK，没有 Key 审核员无法验证真实翻译。需准备限额、可撤销的测试 Key，只通过控制台私密审核说明提供，不能写进仓库、包或公开 Issue。
4. **控制台字段**：单一用途、权限理由、listing 文案、Privacy practices 数据类别与认证、隐私政策 URL、支持 URL 必须按 [docs/STORE.md](docs/STORE.md) 的建议填写。
5. **上传商店包**：使用 `dist/Rimefox-v0.8.5-store.zip`，不要上传 GitHub Release 的 `Rimefox-v0.8.5.zip`。

---

## 三、建议改进

- **长期降低 host 权限**：评估 `optional_host_permissions`（按需申请站点访问），但会改变首次使用体验，本轮不做。
- **隐私政策独立页面**：当前用 GitHub `blob` 页面，公开且可用；部署静态页面更像正式政策，也避免 GitHub 页面样式干扰。
- **仓库 About / Topics**：About 描述仍是旧文案（未提隐私、字幕、术语表），Topics 为空；属于可发现性优化，不影响审核。
- **审核 Demo**：可做一个不调用 API、明确标注「预置译文」的 demo，降低审核门槛；不能替代真实 API 验证。
- **CI 增加商店包检查**：把 `node tools/package-store.mjs` + `unzip -t` 加入 CI，防止再次漏许可文件。
- **YouTube 非官方功能**：持续关注可用性；描述中不要承诺「保证全部字幕可用」。
- **设置页增加隐私政策入口**：可选，方便用户直接查看政策。

---

## 四、需要人工操作

| 事项 | 负责人 | 说明 |
|---|---|---|
| 开发者账号注册 / 付费 / 2FA | 维护者 | 本任务未注册、未付款 |
| 确认截图样张 / 做 440×280 宣传图 | 维护者 | 样张仍是 0.8.3 版本；采用前确认是否用真实 API 重拍，并隐藏 Key、个人页面与账号信息 |
| 准备审核专用 API Key | 维护者 | 限额、可撤销；只放控制台私密说明 |
| 填写 listing 与 Privacy practices | 维护者 | 可按 docs/STORE.md 直接粘贴 |
| 商店文档同步提交 | 维护者 | 本轮 0.8.5 商店文档独立提交；不改 manifest，不触发 Release |
| 上传商店包并提交审核 | 维护者 | 不得由本任务执行 |

---

## 五、未验证项

- 没有用真实 API Key 跑端到端翻译；没有在真实 GitHub / Pixiv / Aeon / OWID 页面重跑 0.8.5 悬停回归。
- 0.8.5 浏览器同步测试使用本地页面与本地扩展包，不是商店审核环境；未测试 Edge。
- 截图使用本地演示页与本地测试接口的示例译文，未使用真实 API Key 或真实服务商输出；未制作 440×280 宣传图。
- 没有上传 Chrome Web Store，因此没有真实审核结果。
- 没有验证 Chrome Web Store 后台对简介字符数、分类和数据类别的最终呈现；以提交时表单为准。

---

## 六、最终回答：当前版本可以提交审核吗？

**还不能。** 代码、权限、隐私政策文案和商店包已经准备好，测试与打包验证通过；但仍缺：

1. 确认 5 张截图样张（已生成）或按说明用真实 API 重拍；
2. 开发者账号（注册、付费、2FA）；
3. 审核专用 API Key；
4. 控制台 listing / 隐私问卷填写；
5. 上传 `Rimefox-v0.8.5-store.zip` 并提交审核。

完成这 5 项后，当前版本即可提交审核；不需要再改代码。
