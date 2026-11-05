# Windows OCR 连接器：开发交接

写给接手 Windows 端的开发者。目标是做出和 macOS 连接器行为一致的 `rimefox-ocr-host.exe`，让扩展在 Windows 上也能识别 PDF 扫描页。

扩展侧已经全部写好，不需要改：设置页、阅读器逐页识别、缓存、取消和状态提示都在。你只需要实现本机程序，并让它说同一套协议。

## 0. 先读这些

| 文档 | 读什么 |
|---|---|
| [docs/OCR-INTERFACE.md](../../docs/OCR-INTERFACE.md) §3 | **协议 v1**：帧格式、`hello` / `recognize` / `cancel` 的字段、错误码、大小上限。以它为准 |
| [docs/OCR-INTERFACE.md](../../docs/OCR-INTERFACE.md) §2、§8 | 状态码含义，以及界面开放前的清单 |
| [native/ocr-host/README.md](README.md) | macOS 连接器的行为说明 |
| `native/ocr-host/macos/Sources/main.swift` | **参考实现**，约 200 行，结构可以照搬 |
| `tools/ocr-mock-host/host.mjs` | 协议的 Node 实现，帧编解码可以对照 |
| [docs/PDF-HANDOFF.md](../../docs/PDF-HANDOFF.md) §5 | 为什么做成独立组件、组件分层、签名要求 |

## 1. 交付物与约定

- 输出路径：`native/ocr-host/windows/build/rimefox-ocr-host.exe`（`build/` 要加进 `.gitignore`）。测试和 E2E 都按这个路径找。
- 源码放在 `native/ocr-host/windows/`，附一个构建命令（脚本或 `dotnet publish` 一行），写进本目录 README 的 Windows 一节。
- 宿主名固定为 `com.rimefox.ocr`；协议版本 `protocols: [1]`。
- 不写安装器之前，用注册表手动注册（见 §4）。

## 2. 推荐实现

**C# / .NET 8 + `Windows.Media.Ocr`**：

- 目标框架 `net8.0-windows10.0.19041.0`，可以直接使用 WinRT API。
- 发布方式可选 NativeAOT 或自包含单文件。体积敏感时优先 NativeAOT；如果 WinRT 投影在 AOT 下有问题，退回自包含单文件。
- C++/WinRT 体积更小，但开发成本高，按你的熟悉程度选。

对照 `main.swift` 的结构：

| 部分 | Windows 写法 | 注意 |
|---|---|---|
| 帧读写 | `Console.OpenStandardInput()` / `OpenStandardOutput()` 的原始 Stream，4 字节小端长度 + UTF-8 JSON | stdout 上不能有任何 `Console.WriteLine`，调试信息写 stderr。不要经过 `Console.Out` 的文本编码层 |
| hello | `system` 后端：`OcrEngine.AvailableRecognizerLanguages` 非空即 `ready`，`languages` 填各语言的 `LanguageTag`；`version` 填系统版本号；`name` 填 `Windows OCR`。`paddle` 报 `engine_missing` | 只报**已安装**的语言。设置页会显示「可识别：…」，看不到中文时提示用户装语言包 |
| recognize | base64 → `InMemoryRandomAccessStream` → `BitmapDecoder` → `SoftwareBitmap`，再交给 `OcrEngine.RecognizeAsync` | 先检查 `OcrEngine.MaxImageDimension`，超出时按比例缩小，坐标再换算回原图；也可以回 `too_large`，但缩小更友好 |
| 语言选择 | 请求带 `languages` 时：用第一个已安装且匹配的语言创建引擎（`zh-Hans` 也要能匹配到 `zh-Hans-CN`）；都不匹配回 `language_unavailable`。没带时：按简体中文 → 繁体中文 → 英文 → 用户界面语言的顺序挑第一个已安装的 | Windows OCR **一个引擎只认一种语言**。中文引擎大体也能认拉丁字母，和 macOS 的默认行为接近 |
| 行与坐标 | 每个 `OcrLine` 输出一行；`box` 取该行所有 `OcrWord.BoundingRect` 的并集，单位是输入图像像素 | **中文行的 `OcrLine.Text` 会在字与字之间插空格**，要删掉两个 CJK 字符之间的空格，否则送翻和搜索都会出问题。`result.TextAngle` 不为空时说明图是斜的，第一版可以忽略 |
| confidence | Windows OCR 不提供置信度 | 省略这个字段即可（协议允许） |
| cancel | 每个识别任务一个 `CancellationTokenSource`，`RecognizeAsync(...).AsTask(token)`；收到 `cancel` 后取消，并回 `cancelled` | 识别要排队串行执行；读 stdin 的循环不能被识别阻塞，否则收不到 `cancel` |
| 结果过大 | 序列化后超过 1 MB 时回 `too_large` | 和 macOS 一致 |

## 3. 先在本机把协议跑通（不需要浏览器）

```powershell
# 仓库根目录；需要 Node 20+
node --test test/ocr.test.mjs
# 构建出 native\ocr-host\windows\build\rimefox-ocr-host.exe 之后：
node test/ocr-native-host.test.mjs
```

`test/ocr-native-host.test.mjs` 会直接启动你的 exe，完成握手，再识别 `test/fixtures/ocr-sample.png`（图里有中英文各几行）。它检查的内容：

- 系统 OCR 是否就绪，语言列表里有没有中文；
- PaddleOCR 是否报 `engine_missing`；
- 识别结果是否包含「凛狐扫描页识别测试」和「Rimefox OCR sample page 2026」；
- 每一行是否都有坐标；
- 坏图像是否回 `bad_request`，协议版本不对是否回 `unsupported_protocol`。

**中文语言包**：「设置 → 时间和语言 → 语言和区域 → 添加语言 → 中文（简体）」，勾选 OCR 相关功能。也可以用管理员 PowerShell 安装：

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'Language.OCR*'
Add-WindowsCapability -Online -Name 'Language.OCR~~~zh-CN~0.0.1.0'
```

## 4. 在浏览器里联调

**自动 E2E**：

```powershell
node tools/e2e-ocr.mjs
```

它会做这些事：

- 把扩展复制到临时目录，并打开 OCR 开关；
- 在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rimefox.ocr` 写入临时宿主（结束时恢复原值）；
- 依次跑三个阶段：未授权、参考宿主、你的 exe。阶段 C 只在找到 `windows\build\rimefox-ocr-host.exe` 时运行。

> ⚠️ **E2E 的 Windows 分支是在 macOS 上写的，还没在 Windows 上跑过**（`.bat` 启动脚本和注册表那两段）。请把「在 Windows 上跑通 `tools/e2e-ocr.mjs`」作为第一项任务：遇到问题修脚本就行，不要改扩展的行为来迁就测试。

**手动联调**：

1. 在扩展的本地副本里，把 `lib/ocr/feature.js` 的 `OCR_UI_ENABLED` 改成 `true`，并在 `manifest.json` 的 `permissions` 里加 `"nativeMessaging"`。然后在 `chrome://extensions` 以「加载已解压的扩展程序」加载，记下扩展 ID。
2. 写宿主清单 `com.rimefox.ocr.json`，内容如下（`path` 在 Windows 上可以写相对清单文件的路径）：

   ```json
   { "name": "com.rimefox.ocr", "description": "Rimefox OCR", "path": "rimefox-ocr-host.exe", "type": "stdio",
     "allowed_origins": ["chrome-extension://<扩展ID>/"] }
   ```

3. 注册（Chrome 和 Edge 各一条）：

   ```powershell
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rimefox.ocr" /ve /t REG_SZ /d "C:\路径\com.rimefox.ocr.json" /f
   reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.rimefox.ocr" /ve /t REG_SZ /d "C:\路径\com.rimefox.ocr.json" /f
   ```

4. 打开设置页的 OCR 区块，应显示「自动选择：系统 OCR（Windows OCR） · 已就绪」和可识别语言。然后导入 `reader/pdf-samples/ocr-scan.pdf`，第 1 页应出现识别出的文字。

`node tools/ocr-mock-host/host.mjs --setup <扩展ID>` 会生成一份可用的清单和 `.bat` 启动脚本，并打印上面的注册命令，可以拿来对照。

## 5. 安装脚本（免费方案，下一步）

签名证书到位之前，用 PowerShell 安装脚本分发，具体做法：

- `install.ps1`：用 `Invoke-WebRequest` 从 GitHub Release 下载 exe，核对 SHA-256，复制到 `%LOCALAPPDATA%\Rimefox\OCR\`，写入宿主清单（`allowed_origins` 填商店版和 GitHub 版两个扩展 ID），再写 Chrome / Edge 两条注册表项。
- `uninstall.ps1`：删除文件和两条注册表项。
- 脚本下载的文件一般不带浏览器的「来自网络」标记（Mark of the Web），所以不会触发 SmartScreen。这一点要在一台干净的 Windows 上实测确认。如果实测会拦，就在脚本里对下载的文件执行 `Unblock-File`，并在说明里写清楚原因。
- 地址确定后，填进 `lib/ocr/feature.js` 的 `OCR_COMPONENT_RELEASES.windows`。

## 6. 代码签名：SignPath Foundation（免费）

[SignPath Foundation](https://signpath.org/) 为开源项目免费提供代码签名。本项目是 MIT 许可证的公开仓库，符合基本条件。主要要求：

- 不含闭源组件；
- 负责签名的团队就是维护仓库的团队；
- 所有成员开启双重验证；
- 构建必须能从仓库源码在 CI 上复现。

详细条款以 [官方条款](https://signpath.org/terms) 为准。注意：签名证书颁发给 SignPath Foundation，所以 exe 的发布者会显示为 "SignPath Foundation"。

接入步骤：

1. 加一个 GitHub Actions 工作流，在 `windows-latest` 上构建 exe 并上传为 artifact。
2. 在 signpath.org 申请开源项目签名，按要求配置项目、签名策略和 [来源验证](https://docs.signpath.io/origin-verification)。
3. 工作流里用 SignPath 的 GitHub Action 提交签名请求，签好的 exe 再附加到 Release。
4. 发布前在干净的 Windows 上确认：下载、运行都不再弹出 SmartScreen 警告。

## 7. 第二阶段：PaddleOCR 引擎包

系统 OCR 稳定之后再做。方向：

- ONNX Runtime + PP-OCRv5 的 ONNX 模型（Apache-2.0），GPU 用 DirectML，失败时回退 CPU，并在结果里写 `fallback: "gpu_failed"`。
- 引擎包独立于连接器安装。连接器在 `hello` 里如实报告 `paddle` 的状态（`engine_missing` / `model_missing` / `ready`）以及 `downloadBytes` / `diskBytes`。

设计约束见 PDF-HANDOFF §5.1 和 §5.1.1；对比评估按 §5.3 的探针表做。

## 8. 完成标准

- [ ] `node test/ocr-native-host.test.mjs` 在 Windows 上全部通过（需要装中文语言包）
- [ ] `node tools/e2e-ocr.mjs` 在 Windows 上三个阶段全部通过（包括修好脚本的 Windows 分支）
- [ ] 中文行没有字间空格；斜图、超大图（超过 `MaxImageDimension`）不崩溃
- [ ] 阅读器里换书、关书时能取消识别，宿主收到 `cancel`
- [ ] `native/ocr-host/README.md` 的平台表和 Windows 构建说明已更新
- [ ] 安装 / 卸载脚本，以及 SignPath 签名流程（可以和以上分两个 PR）

全程不改 `lib/ocr/feature.js` 的开关和 `manifest.json` 的权限：什么时候对用户开放，按 OCR-INTERFACE §8 的清单统一决定。
