# 系统 OCR 预览组件：安装与卸载

这是 Windows / macOS **系统 OCR 预览版**。只识别本机扫描图像，不包含 PaddleOCR。连接器本身不需要翻译 API Key；识别文字送翻时仍会发送给扩展中配置的翻译服务商。文档、图像不会发送给组件发布者。

本页是安装说明的唯一维护位置；开发构建和验收状态见同目录 README。预览包尚未发布时，不要把扩展中的 OCR 开关当作已安装组件。请向维护者取得完整、对应平台的预览包；不要使用第三方来源或猜测下载链接。

## 交给其他使用者或接手 Agent

维护者需要提供以下交接材料；对方仅安装使用时不需要完整源码、编译器或开发环境：

| 材料 | 要求 |
|---|---|
| 对应平台和架构的 OCR 预览 ZIP | 提供完整包，不要只发 exe 或安装脚本；包内含本说明、安装 / 卸载脚本、连接器、许可和文件校验清单 |
| ZIP 对应的 `.sha256` 文件 | 由维护者通过可信交接渠道提供；文件名与 ZIP 对应，不能以包内 `SHA256SUMS` 代替 ZIP 来源校验 |
| 凛狐扩展安装包或可信安装入口 | 应包含系统 OCR 预览入口；扩展与本地组件分别安装、分别版本管理，版本号不必相同 |

本地构建的组件 ZIP 和外附校验文件在 `dist/ocr-preview/`，生成方式见 [README 的本地打包一节](https://github.com/Suethekitten/Rimefox/blob/main/native/ocr-host/README.md#本地打包)。这些被忽略的构建产物不会随着源码克隆自动出现在接手机器上，必须另行交付或由具备环境的开发者在目标平台重新构建。Windows 包不能用于 macOS；Mac 构建与验收状态见 [README](https://github.com/Suethekitten/Rimefox/blob/main/native/ocr-host/README.md#当前交付层级)。

安装包可通过可信渠道直接交接，不必等扩展内的下载按钮开放。要让使用者点击下载，维护者还需发布真实资产并配置下载地址，见同一 [打包说明](https://github.com/Suethekitten/Rimefox/blob/main/native/ocr-host/README.md#本地打包)。每次修改安装说明或脚本后，需要重新打包并交付新的 ZIP 与对应校验值；已生成的旧 ZIP 不会自动更新。

**可以让对方的 Agent 配置。** 在使用者明确要求安装、Agent 能访问上述文件并具备本机执行权限时，它可以核对校验值、解压、调用安装器、注册宿主并执行诊断。应使用下文的安装器，不要另写注册表 / 宿主清单逻辑。Windows 可传实际 ID 和 `-NoPrompt` 非交互安装；macOS 可传 `--extension-id`。多个浏览器使用的全部 ID 应一次传入；重复安装会更新 ID 列表。

扩展 ID 必须来自**接手者目标浏览器中实际安装的扩展**，不能沿用维护者机器的 ID 或猜测。Agent 有浏览器操作能力时可从设置页读取；否则由使用者提供。扩展安装 / 解压加载、可选权限授权和最后的重新检测需要浏览器交互；Agent 有相应工具时可在授权范围内操作真实界面，没有时交给使用者点击，不能通过改浏览器配置文件伪造授权。系统安全提示或组织策略限制仍按本文的平台说明处理。

以下提示词可以随交接材料直接发给接手者（替换方括号中的路径或链接）：

```text
请在这台电脑上安装并配置凛狐系统 OCR 预览组件。
材料：OCR ZIP [绝对路径]，维护者提供的 ZIP SHA-256 文件 [绝对路径]，
凛狐扩展安装包或可信安装入口 [路径或链接]。
目标浏览器：[Chrome / Edge / 两者]。

请先确认操作系统和架构与组件包匹配，核对材料来源及 ZIP SHA-256；
校验不符就停止，不要执行包内程序。完整解压并阅读包内 INSTALL.md。
检查目标浏览器是否已安装带系统 OCR 入口的凛狐；没有则按提供的入口安装，
有则保留其设置。读取每个目标浏览器设置页显示的实际扩展 ID，不能套用他人的 ID。
没有浏览器工具时，请向我索取实际 ID，并说明我需要完成的浏览器操作。

使用包内安装器完成当前用户安装，传入全部实际 ID：
Windows 按 INSTALL.md 的命令加 -NoPrompt；macOS 使用 --extension-id。
若已有其他同名宿主，先报告实际冲突，不默认使用替换选项。
不要修改全局安全设置、伪造浏览器权限或自动安装系统语言包。

检查安装输出和连接器 --diagnose，确认实际 OCR API 状态及识别语言。
回扩展选择系统 OCR、保存，通过真实界面授权连接并重新检测；
若工具无法操作浏览器，给我明确点击步骤，完成前标记为待验证。
用我授权使用的非敏感扫描 PDF 验证识别；没有样本时说明尚未验证识别效果。
最后报告实际安装位置、浏览器及 ID、诊断结果、权限和检测状态、未完成项。
只有扩展实际显示就绪时才报告连接成功；安装脚本退出成功本身不足以证明可用。
```

## 安装前

先安装扩展：完整解压扩展安装 ZIP，打开 `chrome://extensions/`（Edge 使用 `edge://extensions/`），开启开发者模式，点击“加载已解压的扩展程序”，选择包内的 `Rimefox` 文件夹。Windows x64 体验包同时提供扩展 ZIP 与独立 OCR 组件 ZIP，不能把外层体验包当作扩展加载，也不能在尚未安装扩展时猜测 ID。

升级扩展时，将新包内的 `Rimefox` 内容覆盖到原来的同一路径，再在扩展管理页点击“重新加载”，保留原有设置和设备记忆密钥；会话密钥需要重新填写。Chrome / Edge 分别安装和读取 ID。不要删除旧扩展后另建目录，否则 ID 和设置可能改变。

1. 在扩展设置 → 系统 OCR 查看“当前浏览器扩展 ID”。Chrome、Edge 可能不同；需要使用哪个浏览器，就把哪个 ID 交给安装器。每个 ID 是 32 个小写 a–p 字母，不允许通配。
2. 对照维护者提供的 **ZIP SHA-256** 校验下载文件，再完整解压。包内 `SHA256SUMS` 用于检查各文件完整性，安装器在执行连接器前检查其 SHA-256；同一 ZIP 内的校验值不能代替可信发布来源或发布者签名。
3. 阅读系统安全提示。本预览包没有受信任的发布者签名，也未经过 Apple 公证。Windows SmartScreen、应用控制、组织策略、macOS Gatekeeper 可能阻止运行；**不保证每台机器都能安装**。不要关闭系统安全功能，也不要为了预览版导入不明证书。

## Windows

要求：Windows 10 2004+ 或 Windows 11；本次体验包仅提供 x64，ARM64 尚未验收且没有对应发布包。普通用户不需要安装 .NET SDK 或运行库。当前验证范围和未打包 API 限制见上面的在线 README；Windows S 模式、企业应用控制环境可能不能使用。

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
