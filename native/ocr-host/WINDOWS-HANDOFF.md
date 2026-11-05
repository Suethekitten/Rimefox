# Windows OCR 维护交接

用户操作统一见 [INSTALL](INSTALL.md)，平台状态、构建命令和未打包 API 兼容边界统一见 [README](README.md)。协议以 [OCR-INTERFACE](../../docs/OCR-INTERFACE.md) 为准。本文仅记 Windows 实现与维护约束。

## 宿主

`windows/Program.cs` 使用 C# / .NET 8 WinRT 投影和 Windows.Media.Ocr，自包含单文件、不裁剪。原始 stdin / stdout 使用四字节小端帧，stdout 不输出日志。输入循环不等待识别；任务受限、串行执行，取消排队和运行任务均返回协议错误，防止浏览器无法打断识别。结果不带置信度，因为该系统 API 不提供它。

`hello` 如实报告已安装的 `LanguageTag`，PaddleOCR 报 `engine_missing`。缺少请求语言时回 `language_unavailable`；不能用其他后端冒充就绪。默认模型和组件版本进入 model 身份，升级或默认识别语言变化会区分 OCR 缓存。图像实际解码格式 / 尺寸必须与声明一致，超系统尺寸上限等比缩小并换算坐标。中文相邻字符间空格本地清理。

`--diagnose` 通过 `GetCurrentPackageFullName` 检查是否具有 package identity，同时输出 OS、架构、组件版本、API 状态和实际语言。API 激活异常不会使握手进程直接崩溃；它报告 `unsupported`。本机成功不是未打包 API 的系统支持承诺。

## 当前用户安装器

`install.ps1` / `uninstall.ps1` 共用 `install-common.ps1`，兼容 Windows PowerShell 5.1。ID 严格校验并去重；JSON 使用无 BOM UTF-8，完整绝对路径由序列化生成，支持空格和非 ASCII 路径。只写 HKCU 的 Chrome / Edge 宿主项，不触碰 HKLM、不请求管理员权限、不自动安装语言或解除下载标记。

安装前检查来源二进制 SHA-256、路径所有权和重解析点。版本存 `versions/<SHA>/`，避免覆盖旧浏览器进程仍占用的 exe；稳定清单指向当前版本。替换外来注册需显式确认参数，连续升级保留旧备份；若用户明确再次替换后来安装的外来宿主，备份更新为当前外来注册。修改注册前记录所有权与备份，以便部分安装也能卸载恢复。

卸载只处理所有权标记覆盖的文件和仍指向本组件的注册；别的程序后来写入的注册不覆盖，用户额外文件不删。安装目录不可指向卷根目录或穿过 junction / symlink。文件锁导致删除失败时保留恢复信息，关闭相关浏览器后再试。

测试专用 RegistryPrefix 限定为 `Software\Rimefox\OCR\InstallTests\<id>`，生产默认使用正常 Software 路径。测试必须恢复自己写过的注册，不能把临时路径遗留给用户。

## 验证边界与后续

原生测试覆盖真实 exe、图像校验、缩小、排队取消；安装集成测试覆盖校验失败、空格 / 中文路径、重复安装、真实二进制升级和卸载恢复。浏览器 E2E 另用真实安装器生成的清单连接实际 exe，Chrome / Edge 都跑；临时注册在结束时恢复。证据只保留在 [本轮验证归档](../../docs/archive/2026-11-05-system-ocr-preview.md)。

下一步是干净机器上的 Windows 版本 / 策略 / 语言矩阵、浏览器真实下载 ZIP 的 MOTW / SmartScreen 提示，以及未打包 API 不兼容时的 package identity 路线。Windows ARM64 可以构建，但未实际验收。签名分发和未来 PaddleOCR 独立推进，不作为系统 OCR 预览代码完成的前置条件；也不在当前界面展示未实现后端。
