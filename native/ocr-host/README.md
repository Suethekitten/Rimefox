# 本地系统 OCR 预览组件

浏览器通过 Native Messaging 调用本机系统 OCR。系统 OCR 本身无需证书；签名和公证解决的是我们自己连接器的分发与系统信任。此阶段只开放 Windows.Media.Ocr / Apple Vision，不等待 PaddleOCR 或签名证书。

用户安装、卸载、扩展 ID、安全提示及缺语言指引的唯一维护位置是 [INSTALL.md](INSTALL.md)。扩展状态与协议见 [OCR-INTERFACE](../../docs/OCR-INTERFACE.md)。组件不进入扩展商店包。

## 当前交付层级

| 平台 | 开发联调 | 本地预览构建 | 普通用户下载验收 |
|---|---|---|---|
| Windows x64 | 当前开发机上的真实系统 OCR、Chrome / Edge 已通过 | 自包含 exe、用户级安装 / 卸载、ZIP 与 SHA-256 已实现 | 干净机器、带下载标记的 ZIP、安全提示与兼容矩阵未验收；无已配置的发布资产 |
| macOS Apple Silicon / Intel | 新版代码已实现，当前 Windows 环境无法验证 Vision | 通用构建、安装 / 卸载、打包及双架构 macOS CI 已接入代码；尚未执行该 CI | 未编译验收新版产物；下载隔离、Gatekeeper 和浏览器启动均待实机验收 |

这不是签名正式分发。macOS 默认 ad-hoc 完整性签名不提供 Developer ID 身份，也不表示已公证。尚无可信发布者签名的 Windows 包。保留后续签名入口，不要求用户降低全局安全设置。一次性证据和初始缺口见 [本轮验证记录](../../docs/archive/2026-11-05-system-ocr-preview.md)。

## Windows 构建与边界

需要 .NET 8 SDK；扩展自身仍然零构建。输出为自包含单文件，运行机器无需预装 .NET。

```powershell
./native/ocr-host/windows/build.ps1
# SDK 不在 PATH：-Dotnet 'C:\完整路径\dotnet.exe'
# 可交叉构建 -Runtime win-arm64，但 ARM64 尚未实机验收
./native/ocr-host/windows/build/rimefox-ocr-host.exe --diagnose
$env:RIMEFOX_REQUIRE_NATIVE = '1'
node test/ocr-native-host.test.mjs
$env:RIMEFOX_TEST_INSTALLERS = '1'
node --test test/ocr-installers.test.mjs
node tools/e2e-ocr.mjs
node tools/package-ocr-preview.mjs --platform windows
```

目标框架 `net8.0-windows10.0.19041.0`，即构建目标 Windows 10 2004+，并不等于所有对应版本都支持未打包 exe。[微软 OCR API 文档](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr)将桌面 API 支持限定于具有 package identity 的应用。当前未打包方案只在本机得到成功证据，不能推广为全平台保证。`--diagnose` 报告实际 OS、架构、package identity、API 状态和识别语言；不兼容时应停止使用并反馈。MSIX / sparse package identity 仍可作为后续兼容路线，不能在未经干净机器验证时宣称已支持。

每次选择一个已安装的语言模型；默认依次尝试简中、繁中、英文、系统 UI 语言。中文相邻字间空格会清理；超出系统 `MaxImageDimension` 时等比缩小并换算回输入坐标。更多实现注意事项见 [WINDOWS-HANDOFF](WINDOWS-HANDOFF.md)。

## macOS 构建与边界

只依赖系统 Foundation / Vision / ImageIO / CoreGraphics，编译需 Xcode 或 Command Line Tools。构建目标 macOS 12+，同时生成 arm64 / x86_64 后合并，默认执行 ad-hoc 签名和完整性验证；可用 `RIMEFOX_CODESIGN_IDENTITY` 指定将来的身份签名，公证须独立实施。

```sh
sh native/ocr-host/macos/build.sh
lipo -verify_arch arm64 x86_64 native/ocr-host/macos/build/rimefox-ocr-host
otool -l native/ocr-host/macos/build/rimefox-ocr-host
native/ocr-host/macos/build/rimefox-ocr-host --diagnose
RIMEFOX_REQUIRE_NATIVE=1 node test/ocr-native-host.test.mjs
RIMEFOX_TEST_INSTALLERS=1 node --test test/ocr-installers.test.mjs
node tools/e2e-ocr.mjs
RIMEFOX_BROWSER='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' node tools/e2e-ocr.mjs
node tools/package-ocr-preview.mjs --platform macos
```

`build.sh` 对残留重复 SwiftBridging modulemap 使用临时 VFS overlay，不改系统文件。Vision 使用 accurate 和实际支持的语言，归一化框转换为输入图像左上原点像素坐标。请求校验、串行队列与取消均在连接器内完成；冷启动加载模型可能较慢。

`.github/workflows/ocr-preview.yml` 在 macOS Apple Silicon / Intel runner 上构建通用程序，检查 slices / deployment target，运行真实 Vision 夹具、隔离 Library 的安装测试、Chrome / Edge 联调并在 runner 本地产生 ZIP。没有上传或 Release 步骤；当前未推送、未触发远端执行。CI 成功也不证明真实下载、最低系统或干净机器可安装。

## Mac 必须补的实机验收

1. 分别在 Apple Silicon / Intel 检查 `lipo`、`otool` 最低目标、`codesign -dv` 和 `--diagnose`，在 macOS 12 最低版本验证实际启动。
2. 按 INSTALL 从真实可信 HTTPS 来源通过浏览器下载完整 ZIP，记录下载程序、解压工具、隔离属性、Gatekeeper 原始提示及仅针对该程序的例外是否实际可用。源码构建、无隔离副本和 CI 产物都不能替代此步骤；不得全局关闭 Gatekeeper / SIP。
3. 用含空格的 HOME / 解压路径安装；确认宿主固定在用户 Library，Chrome / Edge 清单使用各自实际 ID，不从 Documents 启动；重复安装、更新 ID、卸载恢复旧清单。
4. 运行上列原生与安装自动测试；用简体、繁体、英文真实扫描件验证 Apple Vision 文字与坐标、斜图、多栏和竖排限制。
5. Chrome 和 Edge 各自加载当前扩展，用户点击授予真实可选权限，再检测、导入扫描 PDF、翻译、重开缓存、重试、取消、换书、关书；文字型 PDF 不应触发 OCR。核对没有重复“访问文稿”授权。

## 本地打包

`tools/package-ocr-preview.mjs` 必须在对应平台运行真实二进制，检查版本与诊断；Mac 还验证双架构及两片 Mach-O 的 macOS 12.0 目标。输出在 `dist/ocr-preview/`，含连接器、安装 / 卸载脚本、INSTALL、LICENSE、带源码身份的 `preview.json`、各文件 `SHA256SUMS`，Windows 还包含实际构建依赖的许可与第三方声明，外附 ZIP SHA-256。校验和不能代替可信来源或签名。先提交已审核源码，再重新打包，可得到 `dirtyWorktree: false` 的审核产物。

安装器只消费完整本地包，不内置下载 URL。真正发布后才可把官方 Release 的真实平台资产和 SHA-256 加进 `lib/ocr/feature.js`；在此之前扩展如实禁用下载。发布按 [AGENTS](../../AGENTS.md) 请求许可，不自动推送、上传或运行远端工作流。

要对最终 ZIP 本身跑安装集成，先设置 `RIMEFOX_TEST_INSTALLERS=1`，再把 `RIMEFOX_OCR_PREVIEW_ZIP` 设置为 ZIP 的绝对路径，运行 `node --test test/ocr-installers.test.mjs`；测试读取同路径 `.sha256`、核对包内校验，并只安装到隔离测试目录。
