# 凛狐 Rimefox：Microsoft Edge 加载项商店上架材料

最后更新：2026-10-22，对应 `main`（Rimefox 0.10.0）；商店里 0.9.6 已上线、0.9.7 审核中，0.10.0 未提审。

> **分工**：提交状态、差哪几项、待办清单在 [STORE.md](STORE.md)（唯一主人）。
> 本文只写 **Edge 与 Chrome 的差异**、Partner Center 的提交流程，以及只给 Edge 控制台用的粘贴文案（≥250 字符描述、search terms、notes for certification）。
> 两份文档里的「粘贴文案」不是重复知识：它们要分别贴进两个不同商店的表单，谁也不能代替谁。

## 结论

- **代码不需要为 Edge 改**：MV3、无 `update_url`、无远程代码、无混淆，`lib/config.js` 已经区分 `edge://` 与 `chrome://`，`world: "MAIN"` 和 `minimum_chrome_version` 都是 Edge 支持的字段。
- **已走通一次**：Partner Center 账号、listing、截图、审核用临时 Key、上传审核都完成了；0.9.6 于 2026-10-20 提交、已上线，0.9.7 随后提交、审核中（最长 7 个工作日）。
- Edge 注册**免费**（Chrome 收一次性 $5）；后续更新用 **Packages → 上传新包**，版本号必须比线上大。

## 商店标识

| 项 | 值 |
|---|---|
| 商店页 | <https://microsoftedge.microsoft.com/addons/detail/pampbegmmdpmjplkfddajfegbeknmelh> |
| Store ID | `0RDCKCQ14SMG` |
| CRX ID | `pampbegmmdpmjplkfddajfegbeknmelh` |
| Product ID | `9735085a-4809-4244-86be-3f9ddf90bf21` |

## 一、Edge 与 Chrome 的差异

| 项目 | Chrome Web Store | Microsoft Edge 加载项 |
|---|---|---|
| 后台 | Chrome Developer Dashboard | **Partner Center**（Microsoft 账户 / GitHub 登录） |
| 注册费用 | 一次性 $5 | **免费** |
| 账号类型 | 个人 / 组织 | Individual（验证快）/ Company（可能数天到数周，会被电话核实） |
| 扩展包 | zip，manifest 在根目录 | **同一份 zip，完全一样** |
| 简介 | manifest `description` 自动带入 | 同上，控制台里叫 **Short description**，只读 |
| 详细描述 | 无 250 字下限（有上限） | **最少 250 字符、最多 10000 字符** |
| 商店 logo | 128×128 起 | **1:1，推荐 300×300，最小 128×128** |
| 截图 | 最多 5 张，1280×800 / 640×480 | **最多 6 张**，640×480 或 1280×800 |
| 宣传图 | 440×280（小）、1400×560（大） | 同名同尺寸，**都是可选** |
| 审核时长 | 一般几天 | **最长 7 个工作日** |
| 更新 | 上传新包 | 同一入口上传新包，版本号必须更大 |
| 多语言 listing | 按 `_locales` 检测 | 同样按 `_locales` 检测；没有 `_locales` 只出现一个语言行 |

Edge 目前对 **名称 / 描述引用其他浏览器** 比 Chrome 严：政策 1.1.2 明确「不得引用其他浏览器」，1.5.2 还要求隐私政策**以 Microsoft Edge 为主**。manifest 的 `name` / `description` 里没有 Chrome，符合；但 `PRIVACY.md` 原文只提 "Chrome Web Store 用户数据政策"，本次已改成 Edge + Chrome 并列（见第五节）。

## 二、提交步骤

### 0. 先在 Edge 里手工装一遍（10 分钟）

不要拿「e2e 过了」代替真实安装：`node tools/package-store.mjs` 产出的 zip 解压后，`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选含 `manifest.json` 的那层目录。确认悬浮入口、设置页、划词、YouTube 字幕在 Edge 里都能用。这一步也是审核会做的事。

### 1. 注册开发者账号

1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge/public/login>，用 Microsoft 账户登录（也可以直接用 GitHub 账号登录，会自动建一个 MSA）。
2. 编辑 `Partner Center` 左侧 **Account settings → Programs**，在 **Microsoft Edge** 卡片点 **Get started**。
3. 填：Account country/region（**注册后不可改**）、Account type（个人选 **Individual**）、**Publisher display name**（≤50 字符，商店里显示的作者名）、联系方式、勾选同意 App Developer Agreement → **Finish**。
4. 等验证邮件。Individual 一般很快；Company 要准备营业执照等材料，可能被电话核实。

> 账号类型和所在国家/地区注册后都不能改，建议先想好。

### 2. 打包

```bash
node tools/package-store.mjs
```

产物：`dist/Rimefox-v<版本>-store.zip`，manifest.json 在 ZIP 根目录（0.9.6 已用它上传）。**要传这个**，不是 GitHub Release 那个整仓包；文件数与体积以当前输出为准。

### 3. 新建扩展并上传

Partner Center → **Edge** → **Create new extension** → 把 zip 拖进 **Drag your package here (.zip)** → 校验通过后看 **Extension overview** → 左侧 **Packages** → **Continue**。

### 4. Availability

- **Visibility**：`Public`（先 `Hidden` 自测也可以，链接拿到就能装）
- **Markets**：默认全部市场（含以后新增的）

### 5. Properties

| 字段 | 填什么 |
|---|---|
| Category | `Productivity`（按控制台当前选项选最接近的） |
| Website | `https://github.com/Suethekitten/Rimefox`（必须是自己的站点，不能填商店链接） |
| Support contact detail | `https://github.com/Suethekitten/Rimefox/issues` |
| Mature content | 不勾 |

### 6. Privacy

四块都要填，且必须和代码行为、隐私政策一致：

- **Single Purpose**：见下方粘贴块
- **Permission justification**：逐个权限填（`storage` / `activeTab` / `scripting` / `contextMenus` / host permissions）
- **Are you using remote code?**：选 **No**（所有 JS/CSS 随包，API 返回只按 JSON/文本解析）
- **Data usage**：按下方表格勾
- **Privacy policy URL**：`https://github.com/Suethekitten/Rimefox/blob/main/PRIVACY.md`

### 7. Store listings

每个语言行都要填 **Description**（≥250 字符）和 **Extension logo**；**Extension name** 与 **Short description** 来自 manifest，控制台里只读。

- **0.9.6 起包内带 `_locales/{zh_CN,en}`**，控制台会出现**两个语言行**：`English (United States)` 和 `中文（简体）`，两行的扩展名 / 短描述分别读对应语言的 `messages.json`。
- 两个语言行都要填 Description 和 logo；截图每行独立：英文行 `docs/screenshots/en/`，中文行 `docs/screenshots/`。
- 0.9.5 及以前没有 `_locales`，只会出现一个 `English (United States)` 行、名字固定中文——这也是当时加不出中文行的原因。
- 打包脚本会校验 `default_locale` 对应的 `messages.json` 存在，且每个语言文件都有 `name` / `description`；漏 `_locales` 的 zip 上传后 Edge 只会认一种语言。

建议：截图 5 张（英文行 `en-0*.png`、中文行 `store-0*.png`，均 1280×800）全部上传；小宣传图 440×280 可选，先不做也不影响提交。

### 7.1 `_locales` 内容参照（0.9.6）

```json
// _locales/zh_CN/messages.json
{
  "extensionName": { "message": "凛狐 · 双语对照翻译" },
  "extensionDescription": { "message": "用自己的 API 做整页双语对照翻译，动态内容自动补翻。" }
}
```

```json
// _locales/en/messages.json
{
  "extensionName": { "message": "Rimefox - Bilingual Translation" },
  "extensionDescription": { "message": "Translate pages and selections with your own API key." }
}
```

manifest 里 `name` → `__MSG_extensionName__`、`description` → `__MSG_extensionDescription__`，并加 `"default_locale": "zh_CN"`。上限：名称 ≤45 字符、短描述 ≤132。

### 8. Notes for certification

**这一步是 BYOK 扩展能不能过审的关键**。审核员机器上没有你的 Key，装上去只会看到「请填 API Key」。政策 1.3.1 允许「说明为什么给不了测试凭据」，但大概率判「不可测」——**准备一个限额、可撤销的 Key**，只贴在这个框里，不要进仓库、包或公开 Issue。

贴完后 **Publish**，进入认证，最长 7 个工作日。

### 9. 之后

- 通过 → 状态变 **In the store**，用户可在 Edge 加载项站点装。
- 驳回 → 邮件 + 报告里写原因，改完重新上传/提交；同一版本号重复提交可能被要求先升版本。
- 更新 → 在同一扩展里 **Packages → 上传新包**（版本号必须更大），走同样的认证。

## 三、可直接粘贴的控制台文案

### Single Purpose

```
Translate web pages, selected text, text in a webpage text box, popup text and YouTube captions using a translation API endpoint and API key configured by the user. Glossary, custom prompts, display options and optional local privacy masking exist only to support this single purpose.
```

### Permission justification

| 权限 | 英文（可粘贴） |
|---|---|
| `storage` | Stores settings, the user's API key, glossary, prompts and translation caches locally. |
| `activeTab` | Grants temporary access to the current page when the user invokes the extension, so fallback script injection works even when site access is set to "on click". |
| `scripting` | Re-injects the extension's own bundled content scripts into tabs that were already open when the extension was installed or updated. Never loads remote code. |
| `contextMenus` | Adds context-menu items for translating selected text and the content of a text box. |
| Host permission `<all_urls>` | Runs the content script on pages the user chooses to translate and sends requests to any API endpoint the user configures. The extension cannot be limited to a fixed site list because both the pages and the endpoint are chosen by the user. It does not collect browsing history, does not run in the background on unopened sites, and shows no ads. |

### Data usage

| Edge 面板里的类别 | 勾选 | 理由 |
|---|---|---|
| Website content | 是 | 待翻正文、选中文字、输入框文字、字幕 |
| Authentication information | 是 | 用户自己的 API Key：本机保存，并作为认证头发给他配置的接口 |
| Personally identifiable information | 是（保守） | 页面正文可能含姓名、邮箱、电话；默认不做过滤，隐私政策已披露 |
| Health / financial / payment information | 否 | 不专门请求；密码框和支付类字段不参与输入框翻译 |
| Personal communications | 否 | 不读取邮件 / 聊天记录，只处理用户主动触发的文本 |
| Location | 否 | 不读取定位 |
| Web history | 否 | 不保存浏览历史，缓存按域名隔离 |
| User activity | 否 | 无分析、无遥测 |
| Remote code | 否 | 全部脚本随包 |

认证声明（勾选项）依据：

- 不出售、不转让用户数据，不用于广告 / 信用评估
- 只为单一用途及维护、保障、衡量该用途使用数据
- 接收方只有用户自己配置的翻译接口
- 不允许人工读取用户数据（安全排查或法律要求除外）

### Store listing：中文 Description（≥250 字符）

```
凛狐 Rimefox 让你用自己的 API 做整页双语对照翻译：原文和译文逐段交错显示，鼠标停在译文上可以看到对应的原句（长段落以可展开的节选显示），也可以切换成仅译文模式。支持动态内容补翻、划词翻译、弹窗随手翻译、输入框翻译（快捷键或右键菜单，翻完可 Ctrl+Z 还原），以及可选的 YouTube 双语字幕（默认关闭，仅支持可用的 CC 字幕，不支持画面硬字幕）。

用术语表固定常用词的译法，用自定义提示词调整表达；界面支持中文和英文，主题支持浅色和深色，悬浮入口可以拖动并吸附到页面边缘。可选的「AI 隐私保护翻译」会在发请求前于本地把邮箱、电话、身份证号、银行卡号等可识别信息换成占位符，译文回来后再还原；该功能默认关闭，不保证识别全部敏感信息。

本扩展采用 BYOK：你需要自行配置 API 地址、API Key 和模型，服务商可能收取费用。支持 DeepSeek 等 OpenAI 兼容接口以及 Anthropic、Gemini 协议，没有内置免费翻译额度。作者不运营翻译服务器，不使用分析或遥测；待翻文本、自定义提示词及命中术语直接发给你配置的接口。设置与缓存保存在本机。

暂不支持 PDF、EPUB 或图片 OCR。源码、问题反馈与隐私政策见 https://github.com/Suethekitten/Rimefox 。
```

### Store listing：English Description

```
Rimefox translates web pages with your own API key. Original and translated paragraphs are shown together, so you can read the source and the translation side by side. Hover a translated sentence to see the matching source (long paragraphs show an expandable excerpt), or switch to translation-only view. It also handles dynamic pages that load more content, selected text, text you type in the popup, text in a webpage text box (shortcut or context menu, with Ctrl+Z to undo), and optional bilingual YouTube captions (off by default, available CC tracks only, captions burned into the video are not supported).

Use a glossary to pin down terminology and custom prompts to shape the wording. The interface is available in Chinese and English, with light and dark themes; the on-page dock can be dragged and snaps to the page edge. The optional "AI privacy masking" feature replaces reliably detectable email addresses, phone numbers, ID card numbers and bank card numbers with placeholders before a request and restores them afterwards; it is off by default and does not guarantee that all sensitive data is detected.

Bring your own key: configure an endpoint, key and model from your chosen provider. Provider charges may apply and no free quota is bundled. Rimefox supports OpenAI-compatible endpoints such as DeepSeek, plus Anthropic and Gemini protocols. The author operates no translation server and uses no analytics or telemetry; text to translate, custom prompts and matching glossary terms go directly to the endpoint you configure. Settings and caches stay on your device.

PDF, EPUB and image OCR are not supported. Source, support and privacy policy: https://github.com/Suethekitten/Rimefox
```

### Search terms（≤7 个词/短语，每个 ≤30 字符）

```
translation, translate, bilingual, DeepSeek, OpenAI, YouTube captions, glossary
```

### Notes for certification（英文，直接贴进控制台）

```
Rimefox is a bring-your-own-key translation extension. It ships no translation service of its own and no demo content: translation requires an API endpoint and key supplied by the user, so please use the temporary reviewer key below.

Credentials (rate-limited, revoked after review):
  Endpoint: https://api.deepseek.com/v1
  Model: deepseek-chat
  API key: <PASTE_TEMPORARY_KEY_HERE>

Test steps:
1. Install the extension. A welcome page opens on first run; close it.
2. Click the toolbar icon -> Settings (or right-click the icon -> Options).
3. Choose provider "DeepSeek" (or "OpenAI compatible"), paste the endpoint, key and model above, click Save, then "Test connection". It should report success.
4. Open any English article, for example https://en.wikipedia.org/wiki/Translation
5. Click the toolbar icon -> Translate (or press Alt+A). Paragraphs are translated and shown alternately with the original.
6. Hover a translated sentence: the matching source sentence is highlighted. Use the on-page dock to switch between bilingual and translation-only view, then restore the original page.
7. Select a phrase and use the context menu "Translate selection".
8. Settings -> Subtitles: enable subtitle translation, then open a YouTube video that offers a CC track. The feature is off by default and this is an optional, unofficial feature.
9. Settings -> Privacy: "AI privacy masking" is off by default; when enabled, it masks emails/phones/IDs/card numbers locally before sending.

Notes:
- All JavaScript and CSS are packaged in the extension; no remote code is loaded or executed. API responses are parsed as JSON or text only.
- The broad host permission is needed because both the pages and the API endpoint are chosen by the user. The extension does not read browsing history, does not run on unopened sites, and shows no ads.
- The API key is stored with chrome.storage.local restricted to trusted extension contexts, and is only sent as an authentication header to the endpoint the user configured.
- If the temporary key cannot be used, the settings UI can still be inspected, but live translation cannot be verified.
```

## 四、素材

| 素材 | 要求 | 现状 |
|---|---|---|
| 商店 logo | 1:1，推荐 300×300 | 本轮从 `icons/source.png` 生成 `docs/edge-store/logo-300.png` |
| 截图（英文行） | ≤6 张，1280×800 或 640×480 | `docs/screenshots/en/en-0*.png` 5 张：英文界面 + 日文→英文，`node tools/screenshot-store.mjs` 生成（0.9.6 界面） |
| 截图（中文行） | 同上 | `docs/screenshots/store-0*.png` 5 张：中文界面 + 英文→中文，`node tools/screenshot-store.mjs --lang zh` 生成（0.9.6 界面） |
| 小宣传图 | 440×280，可选 | 未做 |
| 大宣传图 | 1400×560，可选 | 未做 |
| 扩展包 | zip，manifest 在根 | 0.9.6 的包已上传并过审；下次更新重新 `node tools/package-store.mjs` 出包 |

截图内容为真实扩展界面 + 本地测试接口返回的人工示例译文，未使用真实 Key；上传前自己再确认一遍没有泄露 Key、账号、私人页面。

## 五、仓库侧 Edge 适配检查（2026-10-20 实测）

| 检查项 | 结果 |
|---|---|
| Manifest V3 + ESM service worker | 通过 |
| `update_url` | 无（Edge 要求移除） |
| 远程代码 / `eval` / 远程 `<script>` | 无 |
| 混淆代码 | 无，内容脚本为可读 ES5 |
| `name` / `description` 是否引用 Chrome | 否 |
| `minimum_chrome_version: 114` | Edge 支持该字段，不阻塞 |
| `world: "MAIN"` | Edge 111+ 支持，当前 Edge 版本远高于此 |
| `edge://` 适配 | `lib/config.js` 已有 `IS_EDGE`，扩展管理页 / 快捷键页地址按浏览器给 |
| 扩展内文案提到 Chrome | `welcome/index.html` 有一句「Chrome 和 Edge 会把新扩展收进拼图（扩展）菜单」。属于使用说明，不是元数据，政策 1.1.2 约束的是名称/描述，低风险；想零风险可改成「Edge（及其他 Chromium 浏览器）」 |
| `_locales` | 0.9.6 起内置 `zh_CN` + `en`，控制台出现两个语言行（见第二节第 7 步） |
| 隐私政策引用 Edge | 本次已改：`PRIVACY.md`、`docs/privacy.en.md` 改为 Edge + Chrome 并列 |
| 隐私政策覆盖输入框翻译（0.9.0 新增） | 原文遗漏，本次已补进 `PRIVACY.md` 与 `privacy.en.md` |

## 六、风险与驳回点

| 风险 | 处理 |
|---|---|
| **BYOK 不可测**（最可能被驳回） | Notes 里给限额、可撤销的临时 Key + 分步操作；同时写明不给 Key 时的降级说明 |
| `<all_urls>` 被质疑过宽 | 用上表的权限理由；强调页面和接口都由用户选择 |
| YouTube `world: "MAIN"` 被当成侵入页面 | 说明只在 manifest 列出的 3 个 YouTube 域读取播放器已加载的字幕，默认关闭，非官方 |
| 隐私政策与实际行为不一致 | 本次补了输入框翻译；以后改数据流必须同步 `PRIVACY.md` / `privacy.en.md` / 本文 |
| API Key 明文存 `chrome.storage.local`（政策 1.5.5「认证信息要安全」） | 已是 `TRUSTED_CONTEXTS`、网页脚本读不到；更彻底的做法是会话级存储（ROADMAP 0.11.0）。真被问到，按现状如实说明 |
| 只声明一种语言却宣传中英双语界面（政策 1.7） | 0.9.6 起 `_locales` 带 `zh_CN` + `en`，两种语言各一份 listing，已解决 |
| 审核环境版本差异 | `documentPictureInPicture` 有特性检测并回退，不阻塞 |

## 七、人工待办（只列 Edge 专属）

提交状态见 [STORE.md](STORE.md)「当前状态」；Edge 这边只剩：

1. 等 0.9.7 认证结果（最长 7 个工作日）；被驳回就按报告改完重提，可能要求先升版本号。
2. 下一次更新：`node tools/package-store.mjs` 出包（确认 zip 里有 `_locales/`）→ **Packages → 上传新包** → 版本号比线上大（当前线上 0.9.6；0.10.0 是最新未提审版本）。
3. 可选：补 440×280 小宣传图、1400×560 大宣传图。

## 八、官方依据（2026-10-20 查询）

- 注册开发者：<https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account>（明确「无注册费」）
- 上架流程 / 字段规格：<https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension>
- 移植 Chrome 扩展（`update_url`、名称不得引用 Chrome）：<https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension>
- 开发者政策（1.1.2 / 1.3.1 / 1.5.x / 1.6 / 1.7 / 1.8）：<https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies>
- Manifest 字段支持：<https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/manifest-format>
