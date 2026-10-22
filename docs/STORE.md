# 凛狐 Rimefox：Chrome Web Store 上架材料

最后更新：2026-10-22，对应 `main`（Rimefox 0.10.0）；Chrome 商店线上 0.8.3，Edge 线上 0.9.6、0.9.7 审核中。

> 本文只写**通用材料 + Chrome**；Edge 的差异与专属填写内容见 [STORE-EDGE.md](STORE-EDGE.md)。
> 历史审计（0.8.5 的「差哪 5 项」）已归档到 [archive/STORE-READINESS.md](archive/STORE-READINESS.md)，不再是现状。

## 当前状态

| 事项 | 现状 |
|---|---|
| 仓库 | 已公开：<https://github.com/Suethekitten/Rimefox>（最新 Release 见 Releases 页） |
| 商店包 | `node tools/package-store.mjs` 产出 `dist/Rimefox-v<版本>-store.zip`，manifest.json 在 ZIP 根目录 |
| 提交状态（Edge） | **0.9.6 已上线**（2026-10-20 提交）；**0.9.7 审核中**（截至 2026-10-22）。商店页：<https://microsoftedge.microsoft.com/addons/detail/pampbegmmdpmjplkfddajfegbeknmelh> |
| 提交状态（Chrome） | **0.8.3 已上线**（2026-10-21 更新；提供方 APXS）。商店页：<https://chromewebstore.google.com/detail/gbaoafaogljdolpkppocfaeldejampeo> |

两个商店都已走通首次上架；**当前的问题是版本落后**：

- Chrome 线上是 **0.8.3**（首包用了旧版本），比 `main`（0.10.0）落后多个版本；
- Edge 线上是 **0.9.6**，0.9.7 审核中，0.10.0 还没提审；
- 下一次更新：**Chrome 可以现在就用 0.10.0 上传**（0.10.0 > 0.8.3，没有排队冲突）；**Edge 等 0.9.7 审核结束再传 0.10.0**，避免顶掉正在认证的版本；两边版本号都必须大于各自线上版本。

## Chrome 商店标识

| 项 | 值 |
|---|---|
| 商店页 | <https://chromewebstore.google.com/detail/gbaoafaogljdolpkppocfaeldejampeo> |
| 扩展 ID | `gbaoafaogljdolpkppocfaeldejampeo` |
| 提供方 | APXS |
| 线上版本 | 0.8.3（2026-10-21 更新） |

> GitHub Release 的 zip 从 0.8.6 起与商店包用同一份白名单，但多一层 `Rimefox/` 文件夹、manifest.json 不在根目录，**不能**当商店包上传。

## 商店包

安装 Node 18 或以上，在源码目录执行：

```bash
node tools/package-store.mjs
```

脚本输出 `dist/Rimefox-v<manifest版本>-store.zip`，并打印每个文件。收录范围：

- 运行时：`manifest.json`、`background.js`、`lib/`、`content/`、`options/`、`popup/`、`welcome/`、`icons/`
- 许可：`LICENSE`、`THIRD-PARTY-NOTICES.md`、`licenses/`

校验：DT.VERSION 与 manifest 一致、四种 PNG 图标尺寸、manifest 运行时引用、欢迎页三个入口文件（`welcome/index.html`、`welcome/welcome.css`、`welcome/welcome.js`）、三份许可文件必须在包内；拒绝符号链接；排除开发文件；固定 ZIP 时间戳。`dist` 不进入运行包。

验证命令：

```bash
unzip -l dist/Rimefox-v0.8.5-store.zip
unzip -t dist/Rimefox-v0.8.5-store.zip
node test/package-store.test.mjs
```

最近一次实测记录在 [archive/STORE-VALIDATION.md](archive/STORE-VALIDATION.md)（数字属于当时版本，不再更新）。出包后自己跑上面三条命令，以当前输出为准。

## 商店 listing 草稿

| 字段 | 内容 |
|---|---|
| 中文名称（≤45 字符） | 凛狐 · 双语对照翻译（来自 `_locales/zh_CN`） |
| English name（≤45 characters） | Rimefox - Bilingual Translation |
| 中文简介（≤132 字符） | 使用自己的 API Key 翻译网页、选中文字和 YouTube 字幕，支持术语表、自定义提示词、中英文界面与可选本地隐私脱敏。 |
| English summary（≤132 characters） | Translate pages, selections and YouTube captions with your own API key; glossary, prompts, bilingual UI, optional local masking. |
| 分类建议 | Productivity；按控制台当前可选项选择最接近的生产力 / 工具分类 |
| 界面与 listing 语言 | 简体中文、English；0.9.6 起 manifest 用 `_locales`（`zh_CN` / `en`）本地化名称和简介，商店会出现中文（简体）+ English (United States) 两行 |
| 支持入口 | <https://github.com/Suethekitten/Rimefox/issues> |
| 仓库 | <https://github.com/Suethekitten/Rimefox> |
| 隐私政策（中文） | <https://github.com/Suethekitten/Rimefox/blob/main/PRIVACY.md> |
| Privacy policy (English) | <https://github.com/Suethekitten/Rimefox/blob/main/docs/privacy.en.md> |

> 0.9.6 起名称 / 简介来自 `_locales/<语言>/messages.json`（`zh_CN` / `en`）；`tools/package-store.mjs` 会校验默认语言文件与 manifest 引用的文案 key，缺一个就拒绝出包。

中文详细说明：

凛狐 Rimefox 让你在网页上对照阅读原文和译文，悬停译文可查看对应原句（长段落以可展开的节选显示），也支持仅译文显示、动态内容补翻、划词翻译、弹窗文字翻译与可选的 YouTube 双语字幕。通过术语表指定常用词的译法，用自定义提示词调整表达，按需要切换中文或英文界面、浅色或深色主题。可选的「AI 隐私保护翻译」会在发请求前于本地把邮箱、电话、身份证号、银行卡号等可识别信息换成占位符，译文回来后再还原；该功能默认关闭，不保证识别全部敏感信息。

本扩展采用 BYOK：你需要自行配置 API 地址、API Key 和模型，服务商可能收取费用。支持 DeepSeek 等 OpenAI 兼容接口以及 Anthropic、Gemini 协议，没有内置免费翻译额度。作者不运营翻译服务器，不使用分析或遥测。待翻文本、自定义提示词及命中术语直接发给你配置的接口；Key 用于该接口认证。本机保存设置与缓存，第三方处理以其隐私政策为准。

YouTube 字幕翻译默认关闭，仅支持可用的 CC 字幕，不支持画面硬字幕。此功能非官方，与 Google 或 YouTube 无关联，平台更新可能导致失效。暂不支持 PDF、EPUB 或图片 OCR。

源码与支持：<https://github.com/Suethekitten/Rimefox> 。隐私政策：<https://github.com/Suethekitten/Rimefox/blob/main/PRIVACY.md> 。

English detailed description:

Read webpages with original text and translation together, hover a translated sentence to see the matching source with an expandable excerpt for long paragraphs, or switch to translation-only view. Rimefox also offers selected-text translation, a popup text translator, dynamic-page translation, and optional bilingual YouTube captions. Use a glossary for preferred terminology and custom prompts for wording. The interface supports Chinese and English, with light and dark themes. The optional “AI privacy masking” feature replaces reliably detectable email addresses, phone numbers, ID card numbers and bank card numbers with placeholders before a request and restores them afterwards; it is off by default and does not guarantee that all sensitive data is detected.

Bring your own API key: configure an endpoint, key and model from your chosen provider. Provider charges may apply; no free translation quota is bundled. Rimefox supports OpenAI-compatible endpoints such as DeepSeek, plus Anthropic and Gemini protocols. The author operates no translation server and uses no analytics or telemetry. Text to translate, custom prompts and matching glossary terms go directly to your configured endpoint, with your key used for authentication. Settings and caches are stored locally; providers process requests under their own policies.

YouTube caption translation is disabled by default and requires an available CC track. It cannot translate captions burned into video. This unofficial feature is not affiliated with Google or YouTube and may stop working after platform changes. PDF, EPUB and image OCR are not supported.

Source and support: <https://github.com/Suethekitten/Rimefox> . Privacy policy: <https://github.com/Suethekitten/Rimefox/blob/main/PRIVACY.md> .

> 控制台字符上限以实际表单为准；提交前把简介粘贴进去确认没有超限。

## Privacy practices 问卷建议

单一用途（建议原文）：

> Translate web pages, selected text, popup text and YouTube captions using a translation API endpoint and API key configured by the user. Glossary, prompts, display options and optional local privacy masking support this single purpose.

不要以「作者没有服务器」为由勾选「完全不收集 / 传输数据」。按当前问卷对 collection / transmission 的定义，以代码真实行为申报：

| 类别 | 建议 | 依据 |
|---|---|---|
| Website content | 是 | 待翻页面文本、选中文字、弹窗输入、启用后的字幕；不传视频或音频 |
| Authentication information | 是 | 用户填写的 API Key 保存在本机，并作为认证头发送给其配置的接口 |
| Personally identifiable information | 是（保守） | 页面正文可能包含姓名、邮箱、电话等；隐私政策已披露，且默认不保证自动过滤。若控制台定义只统计开发者主动收集，再按控制台说明调整 |
| Health / financial / payment / personal communications | 否 | 不专门请求这些类别；页面正文已归入 Website content / PII，不得承诺自动过滤 |
| Location | 否 | 扩展不读取定位；服务商仍能看到请求来源 IP |
| Web history | 否 | 不保存浏览历史清单；缓存按域名隔离，诊断信息可含当前 URL，均本机保存 |
| User activity | 否 | 无点击追踪、分析或遥测 |
| Remote code | 否 | 所有 JS/CSS 随扩展打包；API 返回只作为文本 / JSON 解析，不作为代码执行 |

认证声明：

- 不出售用户数据，不用于个性化广告、信用评估或贷款
- 只为单一用途及维护、保障、衡量该用途使用数据
- 不转交给与核心功能无关的第三方；接收方仅为用户配置的翻译接口
- 不允许人工读取用户数据，安全排查或法律要求除外

有限使用声明已写入 [PRIVACY.md](../PRIVACY.md) 与 [privacy.en.md](privacy.en.md) 的「Limited Use / 有限使用声明」一节。

说明：Chrome 用户数据 FAQ 对「用户指定服务器」有单独说明（客户端连用户自己的服务器时，Limited Use 对该传输有例外）。本项目仍保留完整隐私政策与 Limited Use 声明，不依赖该例外。

## 权限审计

已复核 `manifest.json`、`background.js`、`popup/popup.js`、`lib/config.js` 与内容脚本的实际调用。

| 权限 / 配置 | 代码中的用途 | 控制台说明（可直接粘贴） |
|---|---|---|
| `storage` | 保存设置、API Key、术语表、提示词、三层缓存与标签页续翻状态 | Store settings, API key, glossary, prompts and translation cache locally. |
| `activeTab` | 用户点击扩展 / 快捷键时临时获得当前页访问权；用于站点访问权限被设为「点击时」的场景 | Grants temporary access when the user invokes the extension, so fallback injection also works when site access is set to "on click". |
| `scripting` | 页面在安装 / 更新扩展前已打开时，补注入**包内**内容脚本与样式 | Re-injects the extension's own bundled content scripts into already-open tabs after install or update. Never loads remote code. |
| `contextMenus` | 划词翻译右键菜单 | Adds a context-menu item for translating the user's selected text. |
| `host_permissions: <all_urls>` | 在用户打开的任意网页运行内容脚本读取待翻正文；向用户填写的任意 API 地址发请求 | Reads page text only when the user translates, and sends it only to the endpoint the user configures. No background browsing, no history collection, no ad or analytics use. Broad host access is required because the user can choose any page and any API endpoint. |
| `all_frames: true` | iframe 内的正文、选区和嵌入播放器 | The content script runs in subframes so embedded text and selections can be translated. Translation is initiated by the user, or by the optional auto-translate setting the user enables. |
| YouTube `world: MAIN` | 只在 manifest 列出的 YouTube / youtube-nocookie 域读取播放器已加载的字幕；无扩展 API Key | Reads caption data already loaded by the player on the listed YouTube domains only. No key or extension API is exposed to the page. |
| `exclude_matches` | 排除 Chrome Web Store 新旧域名与 Google Accounts | Declarative exclusion; programmatic fallback injection checks the target URL first. |
| `web_accessible_resources` | 置顶翻译窗里显示扩展图标 | Exposes one 32px icon so the pinned translation window can display it. |

未申请 `tabs` 权限：代码只使用标签页 ID、`sendMessage`、`query`、`create`、`onRemoved`；当前标签页 URL 通过用户调用时的 `activeTab` 或既有 host 权限获得。不要为了「方便」加回 `tabs`。

## Test instructions（给审核员的英文草稿）

Install the submitted extension in Chrome. A four-step welcome page opens on first install; click Open settings (or use the Settings entry). For local reproduction, unzip the store ZIP and use chrome://extensions → Developer mode → Load unpacked, selecting the folder directly containing manifest.json. Pin Rimefox and open Settings.

Select a provider/protocol, enter an endpoint, an authorized API key and a supported model, save, then run Test connection. This is BYOK software: a valid key and provider access are required, and charges may apply. Reviewer credential/access details: `REVIEWER_ACCESS_PENDING` — provide a limited, revocable key only through the Developer Dashboard private review notes; never commit it or put it in the package. Without credentials, settings can be inspected, but live translation cannot be verified; there is currently no Demo mode.

Open a normal English article in a fresh tab. Click Translate in the popup or use Alt+A (Option+A on macOS; assign a free shortcut in chrome://extensions/shortcuts if needed). Check original/translated text, scrolling to load more, and toggling back to the original. Repeat on a tab opened before installation to exercise fallback injection. Hover a translated sentence to verify the matching source highlight and, in translation-only mode, the source tip; for a long paragraph verify the excerpt, expand/collapse and close. Toggle Hover compare from the on-page quick-action dock, the popup switch, or Settings → Display, and confirm all three stay in sync without a new translation request.

Select a short phrase and use the translation button or context menu. Repeat in an iframe. Enter a sentence in the popup translator and submit. In Settings add a matching glossary entry and a short custom prompt, save and retranslate; change interface language and theme, reopen Settings, and confirm persistence. Changing settings should update already-open pages. Clear the cache in Settings.

Optional privacy masking: open Settings → Privacy, enable `AI privacy masking`, keep email/phone/ID/bank toggles on, and translate a test page containing `test@example.com`, `18744325579`, `11010519491231002X` and `4242 4242 4242 4242`. With a real endpoint, verify the displayed translation restores the original values. Network inspection should show placeholders such as `__PII_EMAIL_ADDRESS_1__` in the request rather than the originals. Turn the feature off and confirm the request contains the original text again. If a model drops a placeholder, that segment should fail rather than display corrupted text.

YouTube captions are off by default. First confirm no translation API request for captions with that setting off (the local caption hook can still run). Enable subtitle translation, open a YouTube video with an available CC track, enable CC, and verify bilingual captions. Seek and change video, then disable the feature. No CC track or hardcoded subtitles are unsupported, not test failures. Also check mobile YouTube and youtube-nocookie embeds where accessible.

Open accounts.google.com and both Chrome Web Store URL patterns; confirm automatic general content scripts are absent. Browser-internal pages and the store are not translation targets. Report errors without sharing private page content or keys.

## 素材清单

| 素材 | 规格与当前状态 |
|---|---|
| 图标 | `icons/icon128.png`，128×128 PNG 已存在；包内校验通过 |
| 真实截图 | **已生成 5 张** 1280×800：整页双语（浅色 / 深色）、划词气泡、隐私保护设置、术语表。位于 [docs/screenshots/](screenshots/)，说明见 [screenshots/README.md](screenshots/README.md) |
| 小宣传图 | 440×280；按控制台当前要求确认是否必填，待制作 |
| 大宣传图 | 1400×560，可选，待决定 |

截图隐藏 Key、个人网页、账号、账单与私人内容。现有 5 张截图使用真实扩展界面 + 本地测试接口返回的人工示例译文（未使用真实 API Key）；如果希望展示真实服务商输出，请用自己的 Key 按 [screenshots/README.md](screenshots/README.md) 重拍。

## 仍需人工完成

| 事项 | 说明 |
|---|---|
| 开发者账号 | 已完成（Chrome）；后续保持 2FA |
| 商店包上传 | 0.8.3 已上线（2026-10-21）；下一次更新重新出包，不要上传 GitHub Release 整仓包 |
| 截图 / 宣传图 | 5 张已生成；Chrome listing 目前是 0.8.3 界面的旧截图，下次更新时换成 0.10.0 界面 |
| 审核专用 API Key | 首次审核已通过；后续更新沿用同一个限额、可撤销的 Key |
| 隐私政策 URL | 已可用：GitHub `blob` 页面公开无需登录；如果希望更正式，可部署静态页面 |
| 支持入口 | 已可用：GitHub Issues 公开 |
| 单一用途 / 权限说明 | 已填写；权限或数据流有改动时同步更新 |
| 提交审核 | 已完成（0.8.3）；后续更新走同样的上传 + 提交流程 |

## 风险与说明

| 风险 | 处理 |
|---|---|
| 广泛网站权限 `<all_urls>` | 提交上述最小权限理由；不为降权限破坏任意网页 / 任意 API 支持。后续可单独设计 `optional_host_permissions` |
| BYOK 无法直接测试 | 最高优先级：准备审核专用、限额、可撤销 Key，通过控制台私密说明交付 |
| YouTube 非官方接口 | 明示非官方、默认关闭、仅 CC；验证当前可用性，避免品牌背书与「保证全部字幕可用」的承诺 |
| 隐私政策与实际行为不一致 | 本次已按 0.8.5 代码核对；悬停对照开关、字幕稳定性、仅调试可见的用量统计都没有新增请求接收方或权限，后续改数据流必须同步 PRIVACY.md、privacy.en.md 与本文件 |
| 版本与仓库差异 | Chrome 线上 0.8.3、Edge 线上 0.9.6（0.9.7 审核中），都落后于 `main` 的 0.10.0；以商店后台实际版本为准，下一次更新统一用 0.10.0+ |

## 官方依据（2026-10-18 查询）

- 项目政策：<https://developer.chrome.com/docs/webstore/program-policies/policies>
- 用户数据 FAQ：<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- 隐私字段说明：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- 远程代码：<https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code>
- 素材规格：<https://developer.chrome.com/docs/webstore/images>
- 开发者注册：<https://developer.chrome.com/docs/webstore/register>
