# 隐私说明

最后更新：2026-10-20。

> **English summary**: Rimefox has no author-operated server or telemetry. See the [full English privacy policy](docs/privacy.en.md). Page text you choose to translate is sent only to the API endpoint **you** configure (DeepSeek, OpenAI-compatible, Anthropic, Gemini…), under that provider's privacy policy. An optional, off-by-default local masking feature replaces reliably detectable sensitive values with placeholders before sending and restores them locally; the mapping never leaves the request. Your API key, settings and translation cache are stored locally; the key is also sent to your configured provider for authentication. No analytics, no telemetry, no third-party SDKs.

凛狐（Rimefox）**没有作者运营的服务器，作者不收集你的数据**。没有统计、没有遥测、没有第三方 SDK，作者收不到你的任何信息。

## 会发到哪里

翻译时，扩展只向**你在设置页填写的接口地址**发送请求，内容包括：

| 场景 | 发送的内容 |
|---|---|
| 整页翻译 | 当前页面上要翻译的文字片段（默认只发屏幕附近的；关闭懒翻译后可能发送整页正文）。开启「AI 隐私保护翻译」时，其中的邮箱、电话、身份证号、银行卡号会先换成占位符 |
| 划词翻译 | 你选中的文字 |
| 随手翻译（弹窗） | 你在弹窗输入框里填的文字 |
| 输入框翻译（快捷键 / 右键菜单） | 你在网页输入框或可编辑区域里选中的文字，或整个框里的文字；密码框与支付类字段不会翻译 |
| YouTube 字幕双语（默认关闭） | 当前视频的字幕文字（只发播放位置往后约 90 秒） |
| 测试连接 | 两句固定的英文测试句 |

请求还会带上目标语言、翻译提示词（包括你填写的自定义提示词）、本批文本命中的术语表原词与指定译法，以及 API Key（认证请求头，发给配置的接口）。获取模型列表和测试连接也会向配置的接口认证。

YouTube 页面脚本会在本地观察播放器加载的字幕；字幕翻译默认关闭，但页面挂钩仍会加载。启用翻译后才向配置 API 发送待翻字幕。适用站点包括 www.youtube.com、m.youtube.com 和 www.youtube-nocookie.com；需要原文轨道时还可能请求同源 YouTube 字幕地址。
启用自动翻译后，符合条件的文字可能无需逐页点击就发送。页面里的子框架（iframe）也会运行内容脚本，翻译时其中的文字按同样规则发送。服务商也会收到 IP 地址等常规网络信息。
这些数据如何保存、是否用于训练，取决于**你选择的服务商**的隐私政策，请自行查阅。

接收方只有你在设置页配置的接口（例如 DeepSeek、智谱、通义、Kimi、硅基流动、OpenRouter、Ollama、Anthropic、Gemini，或你自建 / 中转的网关）；作者和其他第三方不会收到这些数据。如果你填写的是 `http://` 地址，数据会以明文传输；除本机服务外，建议使用 HTTPS。

## AI 隐私保护翻译（可选，默认关闭）

设置页「隐私保护」里可以打开。打开后，翻译请求发出前会先在**本地**做一次识别：

1. 把能可靠识别的敏感信息（邮箱、电话号码、身份证号、银行卡号；可选中文姓名）替换成 `__PII_<类型>_<序号>__` 形式的占位符；
2. 只把**带占位符的文本**发给上面说的接口；
3. 译文返回后，在本机把占位符换回原文，再显示在页面上。

关于这份「占位符 → 原文」的映射：

- 只存在于**单次翻译请求的内存**里，请求结束即丢弃；
- 不写入 `chrome.storage`、不写配置文件、不导出、不进日志，也不会随请求发送；
- 没有新增任何扩展权限，也没有额外下载（不含 WASM、ONNX 或远程模型）。

如果模型把占位符弄丢、改写或换成了别的占位符，对应段落会按**翻译失败**处理（页面保持原文，稍后按原有退避策略重试），不会显示半截译文，也不会把原文误当成译文插入。

能力边界（请勿把它当成完整的匿名化）：

- 只覆盖有固定格式的数据；中文地址、公司名、密码、助记词、私钥等**不在**脱敏范围内；
- 中文姓名只识别「姓名：」「联系人：」「我叫」等明确上下文里的写法，默认关闭，仍可能漏识别或误识别；
- 号码类识别做了校验位 / 长度约束（如身份证校验位、银行卡 Luhn），但不保证 100%；
- 翻译缓存仍按原有规则工作：短文本（原文 + 译文 ≤ 160 字符）可能写入本机磁盘缓存，这与是否开启隐私保护无关；映射本身不会进入缓存。

## 有限使用声明

凛狐对用户数据的使用遵守 Microsoft Edge 加载项与 Chrome Web Store 的用户数据政策，包括有限使用（Limited Use）要求：数据只用于提供本扩展披露的翻译功能，以及维护、保障和衡量这些功能；不出售，不用于个性化广告、信用评估或贷款，不允许人工读取（安全排查或法律要求除外）。

## 保存在本机的数据

以下是本机保存位置；翻译所需的 Key、提示词和命中术语仍会按上文随请求发送，不是“永不离开本机”：

| 数据 | 位置 | 说明 |
|---|---|---|
| 界面语言、主题、术语表、自定义提示词 | `chrome.storage.local` | 界面语言与主题仅本机使用；主题还在扩展页面 localStorage 缓存以避免闪白 |
| 外观、站点规则、夜间模式网站名单、译文自定义 CSS | `chrome.storage.local` | 仅本机使用，不随翻译请求发送；强调色等外观也在扩展页面 localStorage 缓存以避免闪白 |
| 设置与 API Key | `chrome.storage.local` | 收紧为只有扩展自己的页面和后台可读，网页里的脚本拿不到；内容脚本也只知道「有没有 Key」 |
| 翻译缓存（会话） | `chrome.storage.session` | 翻过的原文和译文，关闭浏览器即清空 |
| 翻译缓存（磁盘） | `chrome.storage.local` | 只存短文本（原文 + 译文 ≤ 160 字符），上限 512 KB；按网站域名和模型分开存 |
| 标签页「正在翻译」状态 | `chrome.storage.session` | 刷新后自动接着翻用，关闭标签页即删除 |

设置页「缓存与迁移」可以随时清空翻译缓存；设置、Key、术语表和提示词保留到你修改、删除或卸载扩展。请检查各服务商保存的 Key；在服务商控制台撤销 Key 才能使已泄露的副本失效。磁盘缓存按容量淘汰，不承诺固定天数；卸载扩展会删除扩展的本地存储。第三方已收到的数据按其保留政策处理，清空本机不会删除第三方副本。主动导出的文件和剪贴板副本需自行清除。

## 不会做的事

- 不读取浏览器 Cookie 或密码数据库；整页翻译跳过输入框和可编辑区域。主动划选、在弹窗提交、或在输入框里主动触发翻译的文字会按上述方式处理；YouTube 同源字幕请求可能携带浏览器凭据
- 不记录浏览历史，不在后台访问你没打开的网站
- 不向作者发送数据；仅按上述功能向用户配置的服务商发送请求，YouTube 字幕获取例外见上文
- 不出售数据，不用于广告或信用评估

## 权限用途

| 权限 | 用途 |
|---|---|
| `storage` | 保存设置、API Key 和翻译缓存 |
| `activeTab`、`scripting` | 在当前标签页注入翻译脚本（页面在安装扩展前就打开时补注入） |
| `contextMenus` | 划词翻译的右键菜单 |
| `<all_urls>`（网站访问权限） | 在任意网页上翻译；向你填写的接口地址发请求 |
| YouTube 页面脚本（`world: MAIN`） | 只在 manifest 列出的 YouTube 与 youtube-nocookie 页面上运行，读取播放器已加载的字幕交给扩展翻译，见 [docs/YOUTUBE.md](docs/YOUTUBE.md) |

## 你主动导出的内容

- **诊断信息**（弹窗「诊断」）：包含当前页面地址和部分文字片段，只复制到剪贴板，不会自动发送。贴到 Issue 之前请检查并删去隐私内容
- **配置文件**（设置页「导出」）：勾选「包含 API Key」时 Key 以明文写入文件，迁移完请删除，不要外传

## 联系

有疑问请在 [GitHub Issues](https://github.com/Suethekitten/Rimefox/issues) 提（**不要**贴出 API Key）。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
