# 系统 OCR 预览组件：安装与卸载

这是 Windows / macOS **系统 OCR 预览版**。只识别本机扫描图像，不包含 PaddleOCR。连接器本身不需要翻译 API Key；识别文字送翻时仍会发送给扩展中配置的翻译服务商。文档、图像不会发送给组件发布者。

本页是安装说明的唯一维护位置；开发构建和验收状态见同目录 README。预览包尚未发布时，不要把扩展中的 OCR 开关当作已安装组件。请向维护者取得完整、对应平台的预览包；不要使用第三方来源或猜测下载链接。

## 安装前

1. 在扩展设置 → 系统 OCR 查看“当前浏览器扩展 ID”。Chrome、Edge 可能不同；需要使用哪个浏览器，就把哪个 ID 交给安装器。每个 ID 是 32 个小写 a–p 字母，不允许通配。
2. 对照维护者提供的 **ZIP SHA-256** 校验下载文件，再完整解压。包内 `SHA256SUMS` 用于检查各文件完整性，安装器在执行连接器前检查其 SHA-256；同一 ZIP 内的校验值不能代替可信发布来源或发布者签名。
3. 阅读系统安全提示。本预览包没有受信任的发布者签名，也未经过 Apple 公证。Windows SmartScreen、应用控制、组织策略、macOS Gatekeeper 可能阻止运行；**不保证每台机器都能安装**。不要关闭系统安全功能，也不要为了预览版导入不明证书。

## Windows

要求：Windows 10 2004+ 或 Windows 11；选择与系统对应的 x64 / ARM64 包。普通用户不需要安装 .NET SDK 或运行库。当前验证范围和未打包 API 限制见 README；Windows S 模式、企业应用控制环境可能不能使用。

Windows 自包含包包含 .NET / C#/WinRT 依赖，其条款见包内 `THIRD-PARTY-NOTICES.md` 和 `licenses/`，不全部适用凛狐自身的 MIT 许可。安装后许可保留在当前版本目录的 `licenses/` 下。

在解压目录打开 PowerShell：

```powershell
# 校验 ZIP 的值应与维护者提供的可信校验值一致
Get-FileHash -LiteralPath 'C:\下载目录\对应的预览包.zip' -Algorithm SHA256
# 一个浏览器；也可以不传 ExtensionIds，由脚本提示填写
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\install.ps1 -ExtensionIds '你自己的32位扩展ID'
# 两个不同的浏览器扩展 ID（替换为实际值）
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\install.ps1 -ExtensionIds 'Chrome的实际ID,Edge的实际ID'
```

这里的中文占位文字必须换成实际扩展 ID。命令中的 `RemoteSigned` 只作用于这次 PowerShell 进程，不更改用户级或机器级执行策略；组织强制策略仍可能阻止执行。脚本只写当前用户的 `%LOCALAPPDATA%\Rimefox\OCR` 及 HKCU 下 Chrome / Edge 的 Native Messaging 注册项，**不会申请管理员权限**。再次运行用于更新二进制与 ID 列表；每次填写全部需要保留的 ID。版本按二进制 SHA-256 分目录，避免覆盖浏览器仍在使用的旧 exe。

若 PowerShell 因下载文件标记或执行策略拒绝脚本，先确认来源、ZIP 校验值并阅读脚本。符合你的组织政策时，可以对**这几个已验证的脚本文件**使用 `Unblock-File -LiteralPath .\install.ps1, .\install-common.ps1, .\uninstall.ps1`，再执行；安装器不自动清除下载标记。不要修改全局执行策略，不要认为通过 PowerShell 下载就能保证绕过 SmartScreen。若系统仍禁止运行，请停止并反馈，不要关闭 Defender / SmartScreen。

已有别的 `com.rimefox.ocr` 注册时安装器默认拒绝。确认需要替换后显式传 `-ReplaceExisting`；旧注册会备份，卸载时仅在注册仍属于本组件时恢复。不会覆盖其他程序后来改写的注册项。

安装器打印实际 OCR 语言。缺中文时打开“设置 → 时间和语言 → 语言和区域”，添加所需的简体 / 繁体中文及 OCR 可选功能，然后回扩展重新检测；系统语言功能可能需要管理员协助。安装器不会偷偷提权或下载 Windows 语言包。

诊断和卸载：

```powershell
# 安装目录中的 manifest.json 路径名是 com.rimefox.ocr.json，path 指向当前版本的 exe
$hostInfo = Get-Content -LiteralPath "$env:LOCALAPPDATA\Rimefox\OCR\com.rimefox.ocr.json" -Raw | ConvertFrom-Json
& $hostInfo.path --diagnose
# 先关闭扫描 PDF 阅读器；若文件仍被占用，关闭 Chrome / Edge 后重试
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "$env:LOCALAPPDATA\Rimefox\OCR\uninstall.ps1"
```

卸载只删除组件管理的版本和脚本，保留扩展、书库和其他文件。自选安装目录时传相同的 `-InstallDirectory`；默认目录无需此参数。

## macOS

构建目标是 macOS 12+，通用二进制含 Apple Silicon / Intel。普通用户不需要 Xcode、Node、Python 或额外模型包。构建可能带有让 Apple Silicon 正常执行所需的 **ad-hoc 本地完整性签名**；它不等于 Developer ID 身份签名，也不等于公证。

在解压目录打开终端：

```sh
shasum -a 256 '对应的预览包.zip'
sh ./install.sh --extension-id '实际32位扩展ID'
# 两个浏览器 ID 不同：重复这个参数
sh ./install.sh --extension-id 'Chrome的实际ID' --extension-id 'Edge的实际ID'
```

安装器把连接器复制到 `~/Library/Application Support/Rimefox/OCR/versions/<SHA-256>/`，并在用户 Library 的 Chrome / Edge `NativeMessagingHosts` 下写宿主清单。浏览器不从 Downloads / Documents 或仓库目录直接启动宿主，避免其重复读取受保护目录。不会使用 sudo，也不会移除隔离属性或降低 Gatekeeper 设置。

**下载和系统安全提示尚需实机验收**。浏览器下载的 ZIP、解压工具和 macOS 版本会影响隔离标记及提示行为；源码构建能运行不能证明下载版能运行。如果诊断被“无法验证开发者 / 未公证”提示阻止，安装器会停止，不注册不可启动的宿主。确认来源和校验值后，可按 [Apple 官方说明](https://support.apple.com/en-us/102445) 在“系统设置 → 隐私与安全性”中处理这**一个程序**的“仍要打开”提示，再重跑安装。

命令行程序不一定会出现与图形 App 相同的按钮；若没有对应提示或策略禁止例外，请停止并反馈。不要运行全局关闭 Gatekeeper、关闭 SIP 或批量移除隔离标记的命令。当前没有“所有未签名 Mac 都能一键装好”的承诺。

已有同名宿主时默认拒绝覆盖；确认后可传 `--replace-existing`，旧清单会备份。再次安装更新二进制和全部 ID；卸载仅恢复仍属于本组件的注册。

```sh
sh "$HOME/Library/Application Support/Rimefox/OCR/uninstall.sh"
```

## 在扩展中使用

回到设置 → 系统 OCR（预览版），选择“系统 OCR”，保存，点击“授权连接”授予可选的本地组件通信权限，再点“重新检测”。只有实际检测到引擎和识别语言才显示就绪。没有预览包、语言缺失或系统无法启动时可选择“关闭 OCR”，PDF 原版和文字型 PDF 仍可阅读。

导入扫描 PDF，只识别进入阅读范围的页面。识别文字在页内显示，再按现有模式翻译；已识别的结果存本机缓存。零文本也可能是空白页，OCR 不保证一定得到文字。多栏、斜图、竖排古籍、表格和低清扫描件可能识别错误或顺序不准；重要文字请核对原页。

## 反馈应包含

平台与系统版本、CPU 架构、Chrome / Edge 版本、实际扩展 ID、`--diagnose` 输出、安装命令的错误和扩展状态。请勿发送 API Key、敏感扫描原件或未经许可的文档。系统安全提示请保留原文，区分本机构建、浏览器下载和干净机器这几种环境。
