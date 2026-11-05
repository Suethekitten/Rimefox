# 凛狐本地 OCR 组件（Native Messaging 宿主）

扩展通过 Native Messaging 调用的本机程序，负责在本机识别 PDF 扫描页。协议、状态码和扩展侧接入见 [docs/OCR-INTERFACE.md](../../docs/OCR-INTERFACE.md)；为什么做成独立组件见 [PDF-HANDOFF §5](../../docs/PDF-HANDOFF.md#5-ocr方案已确定尚未实现)。

这个目录不进扩展安装包（`tools/package-store.mjs` 只收扩展自身的目录）。

| 平台 | 目录 | 系统 OCR | PaddleOCR | 状态 |
|---|---|---|---|---|
| macOS 12+ | `macos/` | Apple Vision（`VNRecognizeTextRequest`，accurate） | 报告 `engine_missing` | 原型可用，未签名 |
| Windows | — | 计划用 `Windows.Media.Ocr` | — | 未开始 |

## macOS 连接器

单个 Swift 文件 `macos/Sources/main.swift`，只依赖系统框架（Foundation / Vision / ImageIO），不需要第三方库。

```bash
# 构建通用二进制（arm64 + x86_64），输出 native/ocr-host/macos/build/rimefox-ocr-host（已 gitignore）
sh native/ocr-host/macos/build.sh

# 自检
native/ocr-host/macos/build/rimefox-ocr-host --version
native/ocr-host/macos/build/rimefox-ocr-host --languages   # Vision 实际支持的识别语言

# 真实识别单测、真实 Chrome 端到端
node test/ocr-native-macos.test.mjs
node tools/e2e-ocr.mjs
```

- 只需要 Xcode 或 Command Line Tools 里的 `swiftc`。部分 Command Line Tools 升级后会残留重复的 `SwiftBridging` modulemap，报错看起来像「SDK 与编译器版本不匹配」；`build.sh` 检测到后用 VFS overlay 绕过，不改系统文件。根治方法是重装 Command Line Tools。
- 行为：`hello` 报告 `system` 就绪及 Vision 支持的语言，`paddle` 为 `engine_missing`；`recognize` 只接受 `backend: "system"`，未指定语言时按简体中文、繁体中文、英文识别；识别在串行队列里执行，`cancel` 会中止 Vision 请求并回 `cancelled`；结果超过 1 MB 时回 `too_large`。
- 坐标：Vision 的归一化框（原点左下）换算成输入图像像素、原点左上的 `[x, y, w, h]`。
- 冷启动第一次识别要加载模型，耗时明显长于之后的识别；扩展保持连接 60 秒，同一本书后续页不再重复加载。

### 本机联调（开发用）

1. 构建后，把二进制复制到受保护目录之外（例如 `~/Library/Application Support/Rimefox/`）。仓库在 `~/Documents` 时，让浏览器直接启动仓库里的二进制会反复触发「访问文稿」授权。
2. 写宿主清单 `com.rimefox.ocr.json`：`path` 指向复制后的二进制，`allowed_origins` 写 `chrome-extension://<扩展ID>/`。格式可参考 `node tools/ocr-mock-host/host.mjs --setup <扩展ID>` 生成的文件。
3. 放到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`（Edge：`~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`）。
4. 扩展本地副本按 [OCR-INTERFACE §7](../../docs/OCR-INTERFACE.md#7-本地调试) 打开开关并加权限。

### 发布前还缺

- Developer ID 签名与公证、安装包（安装二进制并为 Chrome / Edge 注册宿主清单）、卸载方式。
- 正式扩展 ID 写进 `allowed_origins`（商店版与 GitHub 版 ID 不同时都要列）。
- 安装包地址填进 `lib/ocr/feature.js` 的 `OCR_COMPONENT_RELEASES`。
