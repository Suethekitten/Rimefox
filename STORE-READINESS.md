# Chrome Web Store 上架前审计（Rimefox 0.7.2）

审计日期：2026-10-18
审计对象：`main` @ `5eaa5c1`（Rimefox **0.7.2**）
审计范围：manifest、权限、内容脚本、后台数据流、隐私政策、商店包、测试、公开链接、Chrome Web Store 现行政策。

## 结论摘要

代码与商店包已经达到「可以上传」的合规状态；**当前还不能直接提交审核**，差的是非代码事项：真实截图、开发者账号、审核专用 API Key、控制台 listing / 隐私问卷，以及把本地审计修复推送上线。

本轮没有修改 manifest、权限、版本号或 CHANGELOG，没有上传、没有提交审核、没有注册账号或付款。

---

## 一、已经完成

| 项目 | 结果与证据 |
|---|---|
| Git 状态 | 审计开始时工作区干净；本地已快进到远端 `5eaa5c1`，未 reset / rebase / 覆盖提交 |
| 版本一致 | `manifest.json`、`content/core.js` 的 `DT.VERSION`、`package.json` 均为 0.7.2 |
| Manifest V3 | `manifest_version: 3`；service worker 为 ESM；无 `update_url`、无自定义 CSP、无 `externally_connectable`、无 `optional_permissions` |
| 权限清单 | `storage`、`activeTab`、`scripting`、`contextMenus`、`host_permissions: <all_urls>`；未申请 `tabs` / `webRequest` / `cookies` / `history` / `downloads` 等 |
| 内容脚本 | 通用脚本 `<all_urls>` + 3 条 `exclude_matches`（Chrome Web Store 新旧域名、Google Accounts）；`all_frames: true`；YouTube 专用脚本仅匹配 3 个 YouTube 域名，其中字幕 hook 为 `world: MAIN` |
| 图标 | 16 / 32 / 48 / 128 / 256 PNG 均存在，打包脚本校验尺寸与 PNG 头 |
| 最低版本 | `minimum_chrome_version: 114`；`documentPictureInPicture`（116+）有特性检测并回退，不阻塞 114 |
| 单一用途 | 翻译网页 / 选中文字 / 弹窗文字 / YouTube 字幕；术语表、提示词、显示选项与可选隐私脱敏都服务这一用途 |
| 远程代码 | 未发现 `eval` / `new Function` / `importScripts` / 远程 `<script src>`；API 返回只按 JSON / 文本解析，不执行。所有 JS/CSS 随包交付 |
| API Key | 仅存 `chrome.storage.local`；`setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`；`config:get` 剥离 Key，内容脚本只拿 `hasKey`；诊断信息不含 Key |
| 数据流 | 待翻文本 / 选中文字 / 弹窗输入 / 字幕 / 提示词 / 命中术语只发往用户配置的接口；作者无服务器、无分析、无遥测、无第三方 SDK |
| 缓存 | 会话缓存 `chrome.storage.session`；磁盘缓存仅短文本（≤160 字符，512 KB）并按域名 / 模型隔离；设置页可清空 |
| 隐私政策 | 已把版本号、更新日期、接收方、HTTP 明文风险、Limited Use 声明、公开 Issues 联系方式写入 [PRIVACY.md](PRIVACY.md) 与 [docs/privacy.en.md](docs/privacy.en.md) |
| README | 修正「不含任何第三方产品代码」的过宽声明，明确 MIT 复用内容见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| 商店文档 | [docs/STORE.md](docs/STORE.md) 已按 0.7.2 重写：真实链接、listing 文案、隐私问卷建议、权限说明、审核员步骤、素材与人工待办 |
| 历史记录 | [docs/STORE-VALIDATION.md](docs/STORE-VALIDATION.md) 追加 0.7.2 验证结果，旧记录未改 |
| 商店包 | `dist/Rimefox-v0.7.2-store.zip`，53 个文件，248,692 B；manifest.json 在 ZIP 根目录；含 LICENSE、THIRD-PARTY-NOTICES.md、licenses/oneaifw-MIT.txt |
| 包内排除 | 无 `test/`、`selftest/`、`docs/`、`.github/`、`tools/`、`node_modules/`、`.DS_Store`、source / preview 图标；无 `sk-` / `AIza` / 私钥块等明显密钥 |
| 公开链接 | <https://github.com/Suethekitten/Rimefox>、`/issues`、`/blob/main/PRIVACY.md` 均返回 200，无需登录 |
| 发布流程 | `.github/workflows/release.yml` 仅在 `manifest.json` / workflow 变更时触发，生成的是整仓发布包，不是商店包 |

### 测试结果

| 检查 | 命令 | 结果 |
|---|---|---|
| Node 单测 | `for f in test/*.test.mjs; do node "$f" || exit 1; done` | **14 个文件全部通过** |
| 离线自检 | 无头 Chrome 打开 `selftest/index.html` | **98 / 98 通过** |
| 商店包构建 | `node tools/package-store.mjs` | 53 个文件，248,692 B |
| ZIP 完整性 | `unzip -t dist/Rimefox-v0.7.2-store.zip` | 无错误 |
| Chrome 校验 | `chrome --pack-extension=<解包目录>` | 成功生成 CRX3 |
| 打包测试 | `node test/package-store.test.mjs` | PASS |
| Markdown 链接 | 仓库内相对链接检查 | 44 个链接，0 失效（见下） |
| 密钥扫描 | 对解包后的商店包做正则扫描 | 未发现明显密钥 |

### 链接检查

检查范围：README、PRIVACY、HANDOFF、THIRD-PARTY-NOTICES、本报告、docs/ 下 8 个 Markdown 与 SECURITY.md，共 44 个相对链接；0 个失效。外部链接（GitHub、Chrome 官方文档、服务商站点）单独用 HTTP 状态核对，见「公开链接」与 docs/STORE.md 的参考列表。

---

## 二、必须修复（提交审核前必须完成）

这些不是代码缺陷，但不完成就不能提交：

1. **真实截图**：Chrome Web Store 至少需要 1 张截图（1280×800 或 640×400），建议 3–5 张。仓库目前只有图标，没有产品截图。
2. **开发者账号**：注册 Chrome Web Store 开发者、完成身份验证与 2FA、支付一次性费用；没有账号无法上传。
3. **审核专用 API Key**：扩展是 BYOK，没有 Key 审核员无法验证真实翻译。需准备限额、可撤销的测试 Key，只通过控制台私密审核说明提供，不能写进仓库、包或公开 Issue。
4. **控制台字段**：单一用途、权限理由、listing 文案、Privacy practices 数据类别与认证、隐私政策 URL、支持 URL 必须按 [docs/STORE.md](docs/STORE.md) 的建议填写。
5. **把本地审计修复推送上线**：当前隐私政策修复只在本地提交；远端 `PRIVACY.md` / `docs/privacy.en.md` 仍是旧版本（英文政策还写着 0.6.2，且没有 Limited Use 声明）。商店填写的隐私政策 URL 必须指向更新后的内容。
6. **上传商店包**：使用 `dist/Rimefox-v0.7.2-store.zip`，不要上传 GitHub Release 的 `Rimefox-v0.7.2.zip`。

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
| 拍真实截图 / 做 440×280 宣传图 | 维护者 | 截图需隐藏 Key、个人页面与账号信息 |
| 准备审核专用 API Key | 维护者 | 限额、可撤销；只放控制台私密说明 |
| 填写 listing 与 Privacy practices | 维护者 | 可按 docs/STORE.md 直接粘贴 |
| 推送审计修复 | 维护者确认后 | 本轮只本地提交，不 push |
| 上传商店包并提交审核 | 维护者 | 不得由本任务执行 |

---

## 五、未验证项

- 没有用真实 API Key 跑端到端翻译；没有在真实网页、YouTube 字幕、iframe 上做人工回归。
- 没有实际拍摄商店截图或制作宣传图。
- 没有上传 Chrome Web Store，因此没有真实审核结果。
- 没有验证 Chrome Web Store 后台对简介字符数、分类和数据类别的最终呈现；以提交时表单为准。

---

## 六、最终回答：当前版本可以提交审核吗？

**还不能。** 代码、权限、隐私政策文案和商店包已经准备好，测试与打包验证通过；但仍缺：

1. 至少一张真实截图；
2. 开发者账号（注册、付费、2FA）；
3. 审核专用 API Key；
4. 控制台 listing / 隐私问卷填写；
5. 把本地隐私政策与文档修复推送上线；
6. 上传 `Rimefox-v0.7.2-store.zip` 并提交审核。

完成这 6 项后，当前版本即可提交审核；不需要再改代码。
