# 隐私说明

> **English summary**: Rimefox has no server and collects no data. Page text you choose to translate is sent only to the API endpoint **you** configure (DeepSeek, OpenAI-compatible, Anthropic, Gemini…), under that provider's privacy policy. Your API key, settings and translation cache stay in your browser's local extension storage. No analytics, no telemetry, no third-party SDKs.

凛狐（Rimefox）**没有服务器，也不收集任何数据**。没有统计、没有遥测、没有第三方 SDK，作者收不到你的任何信息。

## 会发到哪里

翻译时，扩展只向**你在设置页填写的接口地址**发送请求，内容包括：

| 场景 | 发送的内容 |
|---|---|
| 整页翻译 | 当前页面上要翻译的文字片段（只发屏幕附近的，见设置「只翻屏幕附近的内容」） |
| 划词翻译 | 你选中的文字 |
| 随手翻译（弹窗） | 你在输入框里填的文字 |
| YouTube 字幕双语（默认关闭） | 当前视频的字幕文字（只发播放位置往后约 90 秒） |
| 测试连接 | 两句固定的英文测试句 |

每次请求还会带上目标语言、翻译提示词和你的 API Key（放在请求头里，发给同一个接口）。
这些数据如何保存、是否用于训练，取决于**你选择的服务商**的隐私政策，请自行查阅。

## 保存在本机的数据

全部保存在浏览器为本扩展分配的存储里，不会上传：

| 数据 | 位置 | 说明 |
|---|---|---|
| 设置与 API Key | `chrome.storage.local` | 收紧为只有扩展自己的页面和后台可读，网页里的脚本拿不到；内容脚本也只知道「有没有 Key」 |
| 翻译缓存（会话） | `chrome.storage.session` | 翻过的原文和译文，关闭浏览器即清空 |
| 翻译缓存（磁盘） | `chrome.storage.local` | 只存短文本（原文 + 译文 ≤ 160 字符），上限 512 KB；按网站域名和模型分开存 |
| 标签页「正在翻译」状态 | `chrome.storage.session` | 刷新后自动接着翻用，关闭标签页即删除 |

设置页「缓存与迁移」可以随时清空翻译缓存；卸载扩展时浏览器会删除以上全部数据。

## 不会做的事

- 不读取 Cookie、密码、表单内容；输入框和可编辑区域里的文字不翻译
- 不记录浏览历史，不在后台访问你没打开的网站
- 不向作者或任何第三方发送数据

## 权限用途

| 权限 | 用途 |
|---|---|
| `storage` | 保存设置、API Key 和翻译缓存 |
| `activeTab`、`scripting` | 在当前标签页注入翻译脚本（页面在安装扩展前就打开时补注入） |
| `tabs` | 快捷键找到当前标签页；设置变更时通知已打开的页面 |
| `contextMenus` | 划词翻译的右键菜单 |
| `<all_urls>`（网站访问权限） | 在任意网页上翻译；向你填写的接口地址发请求 |
| YouTube 页面脚本（`world: MAIN`） | 只在 youtube.com 上运行，读取播放器已加载的字幕交给扩展翻译，见 README 的「YouTube 字幕（非官方功能）」 |

## 你主动导出的内容

- **诊断信息**（弹窗「诊断」）：包含当前页面地址和部分文字片段，只复制到剪贴板，不会自动发送。贴到 Issue 之前请检查并删去隐私内容
- **配置文件**（设置页「导出」）：勾选「包含 API Key」时 Key 以明文写入文件，迁移完请删除，不要外传

## 联系

有疑问请在 GitHub 提 Issue（**不要**贴出 API Key）。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
