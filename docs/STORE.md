# 凛狐 Rimefox：Chrome Web Store 上架材料

## 当前交付范围

基于真实仓库 `/Users/apxs/Documents/Claude-workspace/edge-bilingual`，起点 `79090d4`。manifest.json 与 DT.VERSION 均为 0.6.2，CHANGELOG 不改。初始工作区干净；远端 main 经 git ls-remote 核实也是 79090d4。已读取原 package.ps1 与 release.yml，普通发布流程保持不变。候选补丁通过 git apply --check 后审阅合并，并修正打包排除规则及程序化补注入。

只提供本地文件，不注册、不登录、不上传、不提交审核、不 push、不实现 Demo。运行包结构可用于商店上传；公开政策地址、素材和真实 API 审核路径未完成前，不应视为已经具备完整送审条件。

## 打包与合并

安装 Node 18 或以上，在源码目录执行 `node tools/package-store.mjs`。脚本也可从其他工作目录通过绝对路径执行，无 npm 安装或外部 zip 命令依赖。输出 dist/Rimefox-v<manifest版本>-store.zip，打印每个文件。只收录 manifest.json、background.js、lib/、content/、options/、popup/、icons/；校验 DT.VERSION、四种 PNG 图标尺寸及 manifest 引用。拒绝符号链接，排除开发文件，固定 ZIP 时间戳。dist 不进入运行包。

实际验证见 [STORE-VALIDATION.md](STORE-VALIDATION.md)。本任务仅本地提交，不 reset/rebase/push。普通发布包与商店包用途不同，不要上传材料包。

## 商店 listing 草稿

| 字段 | 内容 |
|---|---|
| 中文名称（≤45 字符） | 凛狐 Rimefox · 双语对照翻译 |
| English name（≤45 characters） | Rimefox - Bilingual Translation |
| 中文简介（≤132 字符） | 使用自己的 API Key 翻译网页、选中文字和 YouTube 字幕，支持术语表、自定义提示词与中英文界面。 |
| English summary（≤132 characters） | Translate pages, selected text and YouTube captions with your own API key. Includes glossaries and custom prompts. |
| 分类建议 | Productivity，按当前控制台可选项选择对应生产力/工具分类 |
| 界面与 listing 语言 | 简体中文、English；界面语言支持不等于已实现 manifest 的 _locales 本地化 |
| 支持入口 | 待维护者确认的 GitHub Issues；支持邮箱由维护者填写并验证，不使用猜测或个人账户资料 |
| 仓库 | https://github.com/OWNER/REPO （占位，必须替换） |
| Issues | https://github.com/OWNER/REPO/issues （占位，必须替换） |
| 隐私政策 | PRIVACY_POLICY_URL（待公开部署与无登录访问验证） |

中文详细说明：

凛狐 Rimefox 让你在网页上对照阅读原文和译文，也支持仅译文显示、动态内容补翻、划词翻译、弹窗文字翻译与可选的 YouTube 双语字幕。通过术语表指定常用词的译法，用自定义提示词调整表达，按需要切换中文或英文界面、浅色或深色主题。

本扩展采用 BYOK：你需要自行配置 API 地址、API Key 和模型，服务商可能收取费用。支持 DeepSeek 等 OpenAI 兼容接口以及 Anthropic、Gemini 协议，没有内置免费翻译额度。作者不运营翻译服务器，不使用分析或遥测。待翻文本、自定义提示词及命中术语直接发给你配置的接口；Key 用于该接口认证。本机保存设置与缓存，第三方处理以其隐私政策为准。

YouTube 字幕翻译默认关闭，仅支持可用的 CC 字幕，不支持画面硬字幕。此功能非官方，与 Google 或 YouTube 无关联，平台更新可能导致失效。暂不支持 PDF、EPUB 或图片 OCR。

源码与支持： https://github.com/OWNER/REPO 。隐私政策： PRIVACY_POLICY_URL 。发布前替换占位信息。

English detailed description:

Read webpages with original text and translation together, or switch to translation-only view. Rimefox also offers selected-text translation, a popup text translator, dynamic-page translation, and optional bilingual YouTube captions. Use a glossary for preferred terminology and custom prompts for wording. The interface supports Chinese and English, with light and dark themes.

Bring your own API key: configure an endpoint, key and model from your chosen provider. Provider charges may apply; no free translation quota is bundled. Rimefox supports OpenAI-compatible endpoints such as DeepSeek, plus Anthropic and Gemini protocols. The author operates no translation server and uses no analytics or telemetry. Text to translate, custom prompts and matching glossary terms go directly to your configured endpoint, with your key used for authentication. Settings and caches are stored locally; providers process requests under their own policies.

YouTube caption translation is disabled by default and requires an available CC track. It cannot translate captions burned into video. This unofficial feature is not affiliated with Google or YouTube and may stop working after platform changes. PDF, EPUB and image OCR are not supported.

Source and support: https://github.com/OWNER/REPO . Privacy policy: PRIVACY_POLICY_URL . Replace both placeholders before publishing.

## Privacy practices 问卷草稿

单一用途：通过用户配置的翻译 API，在用户打开的网页及扩展界面提供文本双语翻译。字幕、术语表、提示词均服务于这个用途。

不能以“作者没有服务器”为理由勾选“完全不收集/传输数据”。按当前问卷对 collection/transmission 的定义申报，以下以代码真实行为为准。

| 类别或问题 | 建议答案与范围 |
|---|---|
| Website content | 是，发送待翻页面文本、选中文字、启用后的字幕；不传视频或音频 |
| Authentication information | 是，用户提供的 API Key 本地保存，认证发送给其配置的服务商；不是网站登录密码 |
| 用户输入文字 | 是，包括弹窗输入、自定义提示词、命中的术语表原词及译法；通常归 Website content/User-provided content，按实际表单映射 |
| Personally identifiable / health / financial / personal communications | 不专门采集或推断这些类别；用户主动提交的文本可能含这些信息，不应承诺自动过滤。维护者按控制台定义核对是否需额外申报 |
| Web history | 不采集浏览历史清单；缓存按域名区分，诊断可含当前 URL，均本机保存。不要把这写成完全不接触 URL |
| User activity / location | 无行为分析、点击追踪或定位；服务商仍可看到网络 IP |
| 用途 | 核心翻译、用户指定术语/风格、认证、缓存提升性能 |
| 出售或用于广告、信用/贷款 | 否 |
| 转交第三方 | 仅核心功能所需的用户配置服务商；YouTube 字幕获取见政策。不得填“绝不向第三方发送” |
| Remote code | 否；JS/CSS 打包随扩展交付，API 返回是文本数据，不作为代码执行。MAIN 脚本也是包内静态代码 |
| 合规声明 | 不出售；不为与核心用途无关的目的使用/转交；不用于信用判断。维护者核对实际业务后再勾选 |

## 权限审计与审核说明

已复核 background.js、popup/popup.js、lib/config.js 中的 tabs、scripting、contextMenus 调用。

| 权限 / 配置 | 用途 | 审核说明 |
|---|---|---|
| `<all_urls>` host 与通用内容脚本 | 在用户打开的网页读取待翻正文，并请求用户自定义 API 地址 | 不后台浏览、不记录历史；自动翻译需用户启用。API 域名未知所以保留广泛 host 权限。它并非技术上只能读取正文的沙箱，实际代码限定用途 |
| activeTab / scripting | 用户调用后，为安装前已打开的页面补注入 | 保留现有交互；不是用于绕过浏览器限制 |
| tabs（本次移除） | 原文档称“快捷键定位当前标签页、设置变更通知已打开页面” | 这两项只使用 ID/query/sendMessage，无需 tabs 权限。popup 读取当前 URL 由 host 权限或用户调用 activeTab 覆盖。tabs.create、onRemoved 也不要求 tabs 权限。并非用 activeTab 替代所有标签广播 |
| contextMenus | 右键翻译所选文字 | 只处理用户发起的 selection 操作 |
| storage | 设置、API Key、缓存与恢复状态 | local/session 本机保存；Key、提示词等请求发送范围在政策披露 |
| YouTube world: MAIN | 观察播放器已加载的字幕响应 | 仅 www.youtube.com、m.youtube.com、www.youtube-nocookie.com 匹配页面；脚本无扩展 API Key。翻译默认关，但本地 hook 默认加载；取原文轨道可能同源再请求 |
| all_frames | iframe 内选区和嵌入播放器 | 允许匹配的子框架加载脚本；不代表全页面框架无差别自动送翻。主页面消息通常 frameId:0，右键选区按 frameId 定位 |
| exclude_matches | Chrome Web Store 新旧域名、Google Accounts | 声明式通用脚本排除这三个模式；程序化补注入先检查目标框架 URL，再按 documentId 注入以避免导航竞态；不撤销 host 权限，也不是网络防火墙 |

调用点：background.js 的命令回调只取 id；配置广播 query({}) 后逐 tab.id 发消息；关闭回调清 session；popup/popup.js 查询当前 id/url；lib/config.js 用 tabs.create 打开快捷键设置。Chrome 官方说明 tabs 权限主要提供 URL/title 等敏感属性，不是调用整个 tabs API 的许可。移除后仍须真实扩展回归，单元测试不能代替权限集成测试。

## Test instructions（给审核员的英文草稿）

Install the submitted extension in Chrome. For local reproduction, unzip the store ZIP and use chrome://extensions → Developer mode → Load unpacked, selecting the folder directly containing manifest.json. Pin Rimefox and open Settings.

Select a provider/protocol, enter an endpoint, an authorized API key and a supported model, save, then run Test connection. This is BYOK software: a valid key and provider access are required, and charges may apply. Reviewer credential/access details: REVIEWER_ACCESS_PENDING. Do not publish or commit a real key. Without credentials, settings can be inspected, but live translation cannot be verified; there is currently no Demo mode.

Open a normal English article in a fresh tab. Click Translate in the popup or use Alt+A (Option+A on macOS; assign a free shortcut in chrome://extensions/shortcuts if needed). Check original/translated text, scrolling to load more, and toggling back to the original. Repeat on a tab opened before installation to exercise fallback injection.

Select a short phrase and use the translation button or context menu. Repeat in an iframe. Enter a sentence in the popup translator and submit. In Settings add a matching glossary entry and a short custom prompt, save and retranslate; change interface language and theme, reopen Settings, and confirm persistence. Changing settings should update already-open pages. Clear the cache in Settings.

YouTube captions are off by default. First confirm no translation API request for captions with that setting off (the local caption hook can still run). Enable subtitle translation, open a YouTube video with an available CC track, enable CC, and verify bilingual captions. Seek and change video, then disable the feature. No CC track or hardcoded subtitles are unsupported, not test failures. Also check mobile YouTube and youtube-nocookie embeds where accessible.

Open accounts.google.com and both Chrome Web Store URL patterns; confirm automatic general content scripts are absent. Test normal pages and user-gesture fallback after removing tabs permission. Browser-internal pages and the store are not translation targets. Report errors without sharing private page content or keys.

## 素材清单

| 素材 | 规格与当前状态 |
|---|---|
| 图标 | icons/icon128.png，128×128 PNG 已存在；人工检查边距及明暗背景辨识度 |
| 真实截图 | 1–5 张，1280×800 推荐或 640×400；待人工拍摄。建议整页双语、划词、设置/术语表、深色英文界面、YouTube CC |
| 小宣传图 | 440×280，必需，待制作；不伪造真实功能效果 |
| 大宣传图 | 1400×560，可选，待决定 |

截图隐藏 Key、个人网页、账号、账单与私人内容；不能用 Demo 冒充真实 API 输出。

## 拒绝风险与人工待办

| 风险 / 待办 | 处理 |
|---|---|
| 广泛网站权限 | 提交上述最小权限理由；后续可单独设计 optional_host_permissions，但本轮不为降权限破坏任意网页/API 支持 |
| BYOK 无法测试 | 最高优先级：准备审核专用、限额、可撤销 Key，通过控制台私密审核说明交付；不能放入仓库或包内，审核期间确保可用 |
| 隐私政策不完整或打不开 | 发布完整中英文政策，核对真实数据流和问卷；不得提交占位 URL |
| YouTube 非官方接口 | 明示非官方、默认关闭、CC 限制；验证当前可用性，避免品牌背书与“保证全部字幕可用”的承诺 |
| 版本与仓库差异 | 先核对本地实际版本和 Git 状态；本轮不发版、不改 CHANGELOG，不覆盖原有提交 |
| 开发者账号 | 人工注册并支付一次性费用；预算 US$5，准确金额以官方注册结算页为准。本任务未注册或付款 |
| 联系方式和素材 | 填写真实支持邮箱/仓库/Issues；补真实截图和小宣传图 |
| 最后提交 | 原仓库本地提交并人工审阅，再由人决定上传与提交审核；本任务不上传 |

真实 remote 是 `https://github.com/Suethekitten/Rimefox`。仓库公开前匿名访问仓库及 Issues 会返回 HTTP 404；公开后该地址即可作为支持入口。

建议公开 URL（均未部署、未经验证）：`https://OWNER.github.io/REPO/privacy/`；或 `https://github.com/OWNER/REPO/blob/main/docs/privacy.en.md` 与中文 `https://github.com/OWNER/REPO/blob/main/PRIVACY.md`。仓库必须公开，无需登录。英文政策联系段也要替换为真实 Issues 链接。

## 最小 Demo 方案：仅设计，未实现

设置页或弹窗增加“试用示例（不调用 API）”，打开包内 demo/index.html。用三段固定英文及对应预置中文演示原译文对照，用指定短句的选区示范划词气泡，并提供进入真实设置页的按钮。整页持续标注“Demo / 本地预置译文 / 未调用 API”，不伪造请求进度、额度或模型结果。任意非预置选区显示“此处仅演示固定示例”。

改动面为 popup/options 的入口、文案/i18n，以及独立 demo HTML/CSS/JS/固定文本；打包白名单需明确增加 demo/。不修改真实 provider、缓存或发送流程，不创建假成功结果，不内置 Key。退出 Demo 后真实翻译仍需要用户配置 API。

测试点为无 Key 可打开、断网可用、网络记录无 API 请求、没有配置/缓存污染、中英界面和明暗主题、键盘操作及退出路径、未命中句子不伪造译文；运行包包含新资源。值得做，可降低首次体验门槛，但只能演示 UI，不能替代审核员验证真实 API 核心功能。需用户确认后另行实现。

## 官方依据（2026-10-18 查询）

权限依据：https://developer.chrome.com/docs/extensions/reference/api/tabs 和 https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions 。

素材依据：https://developer.chrome.com/docs/webstore/images 。

开发者注册：https://developer.chrome.com/docs/webstore/register 。费用以实际结算为准。
