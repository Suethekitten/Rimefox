# 隐私说明

> **English summary**: Rimefox has no author-operated server or telemetry. See the [full English privacy policy](docs/privacy.en.md). Page text you choose to translate is sent only to the API endpoint **you** configure (DeepSeek, OpenAI-compatible, Anthropic, Gemini…), under that provider's privacy policy. Your API key, settings and translation cache are stored locally; the key is also sent to your configured provider for authentication. No analytics, no telemetry, no third-party SDKs.

凛狐（Rimefox）**没有作者运营的服务器，作者不收集你的数据**。没有统计、没有遥测、没有第三方 SDK，作者收不到你的任何信息。

## 会发到哪里

翻译时，扩展只向**你在设置页填写的接口地址**发送请求，内容包括：

| 场景 | 发送的内容 |
|---|---|
| 整页翻译 | 当前页面上要翻译的文字片段（默认只发屏幕附近的；关闭懒翻译后可能发送整页正文） |
| 划词翻译 | 你选中的文字 |
| 随手翻译（弹窗） | 你在输入框里填的文字 |
| YouTube 字幕双语（默认关闭） | 当前视频的字幕文字（只发播放位置往后约 90 秒） |
| 测试连接 | 两句固定的英文测试句 |

请求还会带上目标语言、翻译提示词（包括你填写的自定义提示词）、本批文本命中的术语表原词与指定译法，以及 API Key（认证请求头，发给配置的接口）。获取模型列表和测试连接也会向配置的接口认证。

YouTube 页面脚本会在本地观察播放器加载的字幕；字幕翻译默认关闭，但页面挂钩仍会加载。启用翻译后才向配置 API 发送待翻字幕。适用站点包括 www.youtube.com、m.youtube.com 和 www.youtube-nocookie.com；需要原文轨道时还可能请求同源 YouTube 字幕地址。
启用自动翻译后，符合条件的文字可能无需逐页点击就发送。服务商也会收到 IP 地址等常规网络信息。
这些数据如何保存、是否用于训练，取决于**你选择的服务商**的隐私政策，请自行查阅。

## 保存在本机的数据

以下是本机保存位置；翻译所需的 Key、提示词和命中术语仍会按上文随请求发送，不是“永不离开本机”：

| 数据 | 位置 | 说明 |
|---|---|---|
| 界面语言、主题、术语表、自定义提示词 | `chrome.storage.local` | 界面语言与主题仅本机使用；主题还在扩展页面 localStorage 缓存以避免闪白 |
| 设置与 API Key | `chrome.storage.local` | 收紧为只有扩展自己的页面和后台可读，网页里的脚本拿不到；内容脚本也只知道「有没有 Key」 |
| 翻译缓存（会话） | `chrome.storage.session` | 翻过的原文和译文，关闭浏览器即清空 |
| 翻译缓存（磁盘） | `chrome.storage.local` | 只存短文本（原文 + 译文 ≤ 160 字符），上限 512 KB；按网站域名和模型分开存 |
| 标签页「正在翻译」状态 | `chrome.storage.session` | 刷新后自动接着翻用，关闭标签页即删除 |

设置页「缓存与迁移」可以随时清空翻译缓存；设置、Key、术语表和提示词保留到你修改、删除或卸载扩展。请检查各服务商保存的 Key；在服务商控制台撤销 Key 才能使已泄露的副本失效。磁盘缓存按容量淘汰，不承诺固定天数；卸载扩展会删除扩展的本地存储。第三方已收到的数据按其保留政策处理，清空本机不会删除第三方副本。主动导出的文件和剪贴板副本需自行清除。

## 不会做的事

- 不读取浏览器 Cookie 或密码数据库；整页翻译跳过输入框和可编辑区域。主动划选或在弹窗提交的文字会按上述方式处理；YouTube 同源字幕请求可能携带浏览器凭据
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
| YouTube 页面脚本（`world: MAIN`） | 只在 manifest 列出的 YouTube 与 youtube-nocookie 页面上运行，读取播放器已加载的字幕交给扩展翻译，见 README 的「YouTube 字幕（非官方功能）」 |

## 你主动导出的内容

- **诊断信息**（弹窗「诊断」）：包含当前页面地址和部分文字片段，只复制到剪贴板，不会自动发送。贴到 Issue 之前请检查并删去隐私内容
- **配置文件**（设置页「导出」）：勾选「包含 API Key」时 Key 以明文写入文件，迁移完请删除，不要外传

## 联系

有疑问请在 GitHub 提 Issue（**不要**贴出 API Key）。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
