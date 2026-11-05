# OCR 接口与使用方法

状态：**扩展侧流程与 macOS 连接器已实现，界面未开放**（`lib/ocr/feature.js` 的 `OCR_UI_ENABLED = false`）。用户看到的行为与之前相同：扫描页只显示「本页没有可提取的文字」。
打开开关后的完整流程（设置页、逐页识别、缓存、送翻、取消）由 `tools/e2e-ocr.mjs` 在真实 Chrome 里验证；开放前仍需完成 §8。
为什么做独立本地组件、交付和验收顺序见 [PDF-HANDOFF §5](PDF-HANDOFF.md#5-ocr方案已确定尚未实现)。本文只写扩展侧的接口、协议和接入方法。

## 1. 分层与文件

```
设置页 / PDF 阅读器 ──(lib/ocr/page.js)──► chrome.runtime.sendMessage
                                                 │  ocr:status / ocr:recognize / ocr:cancel（仅可信扩展页）
                                                 ▼
                         background.js ── lib/ocr/service.js（选择解析、检测缓存、串行队列、取消）
                                                 │  来源接口 detect / recognize / dispose
                          ┌──────────────────────┴──────────────────────┐
              lib/ocr/native-source.js                         （以后可加）扩展内 WASM 来源
                          │ chrome.runtime.connectNative('com.rimefox.ocr')
                          ▼
              本地组件：连接器（系统 OCR）＋ 可选 PaddleOCR 引擎包
```

| 文件 | 职责 | 运行环境 |
|---|---|---|
| `lib/ocr/protocol.js` | v1 协议常量、请求构造、宿主消息解析与收紧、`OcrError` | 任意（纯函数） |
| `lib/ocr/status.js` | 选择项、状态码、`resolveOcr` 判定、`ocrNotice` 提示文案 | 任意（纯函数） |
| `lib/ocr/native-source.js` | Native Messaging 来源：握手、请求关联、超时、取消、断开恢复、空闲断开 | 后台 |
| `lib/ocr/service.js` | 汇总来源、按选择解析后端、检测缓存、全局串行识别、按 jobId 取消 | 后台 |
| `lib/ocr/cache-key.js` | OCR 结果缓存键（不含翻译配置） | 任意（纯函数） |
| `lib/ocr/page.js` | 页面侧帮助函数：查状态、识别画布、取消、申请权限、打开设置 | 扩展页面 |
| `lib/ocr/layout.js` | OCR 行 → 阅读器文本块（同段续行合并、标题 / 段落切分） | 任意（纯函数） |
| `lib/ocr/feature.js` | 界面总开关、已发布安装包地址表（`OCR_COMPONENT_RELEASES`，目前为空） | 任意 |
| `options/ocr.js` | 设置页 OCR 区块 | 设置页 |
| `reader/reader.js`（OCR 段） | 零文本页逐页识别、页内提示、缓存、取消 | 阅读器 |
| `lib/reader/store.js` | `getOcrResult` / `putOcrResult`：OCR 结果存 IndexedDB | 阅读器 |
| `native/ocr-host/macos/` | macOS 连接器（Swift + Apple Vision），见其 [README](../native/ocr-host/README.md) | 本机 |
| `tools/ocr-mock-host/host.mjs` | 参考 / 假宿主：协议的可运行实现，供组件开发与测试 | Node |
| `tools/e2e-ocr.mjs` | 真实 Chrome 端到端：未授权、参考宿主、真实 macOS 连接器三个阶段 | Node + Chrome |
| `test/ocr.test.mjs`、`test/ocr-routes.test.mjs` | 协议、状态、来源、服务、缓存键、版面、配置、路由与参考宿主进程 | Node |
| `test/ocr-native-macos.test.mjs` | 真实 macOS 连接器识别夹具图（未构建或非 macOS 时跳过） | Node |
| `test/fixtures/ocr-sample.png`、`reader/pdf-samples/ocr-scan.pdf` | 已知文字的识别样本（PNG 由 `native/ocr-host/macos/Tools/render-sample.swift` 生成，PDF 由 `tools/make-pdf-samples.mjs` 生成） | — |

配置项只有一个：`ocrEngine`，取值 `auto`（默认）/ `system` / `paddle` / `off`，清洗在 `mergeConfig`，导入校验在 `pickImportedConfig`。它只是偏好，能否识别以检测结果为准。

## 2. 选择与状态

`resolveOcr(choice, backends)` 是唯一判定入口，设置页和阅读器都用它的结果，不各写一套。

| 选择 | 规则 |
|---|---|
| `auto` | 按 `OCR_AUTO_ORDER`（`system` → `paddle` → 之后新增的后端）选第一个 `ready`；都不就绪时报 `not_configured`，`reason` 给出最值得提示的具体原因；任一后端 `incompatible` 时直接报 `incompatible` |
| `system` / `paddle` | 直接返回该后端的状态；后端不存在时报 `unsupported` |
| `off` | `disabled`，不检测组件 |

| 状态码 | 含义 | 阅读器提示（`ocrNotice`） | 动作 |
|---|---|---|---|
| `ready` | 可识别，`backend` 有值 | 不提示 | — |
| `not_configured` | 自动选择下没有就绪引擎 | `未配置OCR，请前往设置配置`（用户指定原文） | 前往设置 |
| `permission_needed` | 未授予 `nativeMessaging` 可选权限 | 需要授权连接本地 OCR 组件 | 前往设置 |
| `component_missing` | 连接器未安装（宿主清单不存在） | 未检测到本地 OCR 组件 | 前往设置 |
| `engine_missing` / `model_missing` | 连接器在，引擎包或模型缺失 | 所选 OCR 引擎尚未安装 / 缺少模型 | 前往设置 |
| `language_unavailable` | 引擎缺所需识别语言 | 不支持当前识别语言 | 前往设置 |
| `incompatible` | 协议版本、宿主名或扩展 ID 不匹配 | 组件版本不兼容 | 前往设置 |
| `unsupported` | 当前平台没有这种后端 | 当前系统不支持所选 OCR | 前往设置 |
| `error` | 检测失败、宿主崩溃、超时 | 检测失败，可稍后重试 | 重试 |
| `disabled` | 用户主动关闭 | `OCR 已关闭`（只显示状态） | 无 |

英文文案在同一张表里（`status.js` 的 `NOTICES`），`ocrNotice(status, 'en')` 取用。

## 3. 本地组件协议 v1

传输由 Chrome 负责：每条消息是 UTF-8 JSON，前面加 4 字节本机字节序长度。宿主 → 扩展单条上限 1 MB，扩展 → 宿主 64 MiB。宿主的 stdout 只能写协议帧，调试输出写 stderr；Windows 上 stdin / stdout 必须切到二进制模式。

所有消息都带 `v: 1` 和 `id`（扩展生成，`[A-Za-z0-9_-]{1,64}`）。宿主回包沿用请求的 `id`。

### 3.1 hello（握手 / 能力检测）

```json
→ { "v": 1, "id": "r1", "type": "hello", "client": { "name": "rimefox", "version": "0.16.4" } }
← { "v": 1, "id": "r1", "type": "hello",
    "component": { "version": "1.0.0", "platform": "darwin", "protocols": [1] },
    "backends": [
      { "id": "system", "status": "ready", "name": "Apple Vision", "version": "26.1", "languages": ["zh-Hans", "zh-Hant", "en-US"] },
      { "id": "paddle", "status": "model_missing", "name": "PaddleOCR", "version": "3.0", "model": "PP-OCRv5_mobile",
        "devices": ["gpu", "cpu"], "languages": ["zh-Hans", "zh-Hant", "en"], "downloadBytes": 152000000, "diskBytes": 410000000 }
    ] }
```

- `protocols` 不含 1 → 扩展判定 `incompatible` 并断开。
- `backends[].status`：`ready` / `engine_missing` / `model_missing` / `language_unavailable` / `incompatible` / `unsupported`；未知值按 `unsupported`。
- 连接器装好但没报 `paddle` 时，扩展按 `engine_missing` 处理；没报 `system` 时按 `unsupported` 处理。
- `languages` 用 BCP 47 标签，只报**实际可用**的语言（Windows 按已装语言包），最多 64 个。设置页据此显示（中日韩与英文排前），不按平台名推断。
- `name` 只作诊断用；设置页按后端 id 与平台显示「系统 OCR（macOS 文本识别）」等本地化名称。
- `downloadBytes` / `diskBytes` 由组件如实上报，设置页显示当前平台的实际数字。

### 3.2 recognize（识别一张图）

```json
→ { "v": 1, "id": "r2", "type": "recognize", "backend": "paddle",
    "image": { "mime": "image/png", "data": "<base64，无 data: 前缀>", "width": 1654, "height": 2339 },
    "languages": ["zh-Hant"], "options": { "device": "auto" } }
← { "v": 1, "id": "r2", "type": "result", "ok": true, "backend": "paddle",
    "engine": { "name": "PaddleOCR", "version": "3.0", "model": "PP-OCRv5_mobile", "device": "cpu" },
    "fallback": "gpu_failed", "durationMs": 840,
    "lines": [ { "text": "蠶書", "confidence": 0.97, "box": [120, 88, 210, 64] } ] }
← { "v": 1, "id": "r2", "type": "result", "ok": false, "error": { "code": "model_missing", "message": "..." } }
```

- `image.mime` 只接受 `image/png`、`image/jpeg`；单边不超过 8192，base64 不超过 32 Mi 字符。
- `options.device`：`auto` / `gpu` / `cpu`。GPU 初始化或识别失败时组件自行回退 CPU，并在结果里写 `fallback: "gpu_failed"`；只有 CPU 也失败才回错误。
- `box` 为 `[x, y, w, h]`，单位是输入图像像素，原点在左上角；无法给出时省略或写 `null`。
- `confidence` 是 0–1，可省略。超范围会被截断。
- 结果上限：5000 行、每行 4000 字、总计 30 万字，超出视为坏响应。整条响应须小于 1 MB。
- 错误码：`bad_request` / `unsupported_protocol` / `engine_missing` / `model_missing` / `language_unavailable` / `incompatible` / `too_large` / `busy` / `cancelled` / `internal`；未知码按 `internal`。

### 3.3 cancel

```json
→ { "v": 1, "id": "r3", "type": "cancel", "target": "r2" }
```

扩展发出取消后立即在本地结束该任务，之后收到的 `r2` 结果一律丢弃。宿主可以回 `cancelled`，也可以不回。

### 3.4 宿主注册

- 宿主名：`com.rimefox.ocr`（`OCR_NATIVE_HOST`）。
- 宿主清单 `allowed_origins` 只能列具体扩展 ID，不允许通配；商店版与 GitHub 版 ID 不同时须都列出，否则扩展报 `incompatible`。
- 清单位置：Chrome 见 [Native Messaging 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location)；Edge 见 [Microsoft Edge 文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)。正式安装器两种浏览器都要注册。

## 4. 来源接口（新增后端时实现）

`createOcrService({ sources })` 接受任意个来源。每个来源实现：

```js
{
  id: 'native',                       // 来源 id
  provides: ['system', 'paddle'],     // 它负责的后端 id；连不上时这些后端都标成来源的状态
  async detect({ refresh }) {         // → { id, provides, status, component, backends, message }
    // status: 'ok' | 'permission_needed' | 'component_missing' | 'incompatible' | 'error'
    // backends（status 为 ok 时）：[{ id, status, name, version, model, devices, languages, ... }]
  },
  async recognize({ backend, image, languages, device, signal }) {
    // → { backend, engine, fallback, durationMs, lines }；失败抛 OcrError(code)
    // signal 中止时尽快抛 OcrError('cancelled')
  },
  dispose() {}                        // 可选：释放连接 / worker
}
```

接入扩展内 WASM 后端（PDF-HANDOFF §5.1 的后备方案）的步骤：

1. 新建 `lib/ocr/wasm-source.js` 实现上面的接口。WASM 运行库必须随扩展包发布（MV3 禁止远程代码），只有模型 / 语言包可以在用户同意后下载。
2. 在 `status.js` 的 `OCR_CHOICES` 加选择项（如 `wasm`），按需要调整 `OCR_AUTO_ORDER`。
3. `background.js` 创建服务时把新来源加入 `sources`。
4. 在 `test/ocr.test.mjs` 补来源测试；`resolveOcr` 不需要改。

## 5. 后台消息路由

三条路由都在 `TRUSTED_ONLY`，网页内容脚本调用直接被拒绝。失败统一返回 `{ ok: false, errorCode, error }`，`errorCode` 即 §2 的状态码或 §3.2 的错误码。

| type | 入参 | 返回 |
|---|---|---|
| `ocr:status` | `{ refresh?: boolean }` | `{ ok, ocr: { choice, status, backend, reason, backends, sources, checkedAt } }` |
| `ocr:recognize` | `{ image: { mime, data, width, height }, languages?, jobId?, device? }` | `{ ok, result: { backend, engine, fallback, durationMs, lines } }` |
| `ocr:cancel` | `{ jobId }` | `{ ok, cancelled: boolean }` |

- 检测结果缓存 30 秒；`refresh: true` 强制重新握手。权限变化（`chrome.permissions.onAdded` / `onRemoved`）和识别时出现引擎 / 组件类错误会自动作废缓存。
- 识别全局串行；`jobId` 由页面生成（建议 `bookId:page:epoch`），重复的 `jobId` 返回 `bad_request`。
- 未就绪时 `ocr:recognize` 直接返回状态码，不连接组件，也不产生任何翻译请求。

## 6. 页面侧使用方法

### 6.1 设置页（`options/ocr.js`）

- 下拉框 `#ocrEngine` 属于设置表单：`readForm` / `applyConfig` 经 `ocrSettings.value()` / `fill()` 读写，随「保存」写入 `ocrEngine`，和其他设置项一样计入未保存改动。开关关闭时区块隐藏，只透传已保存的值。
- 状态横幅按**当前下拉框的值**和最近一次 `ocr:status` 结果用 `resolveOcr` 实时计算，所以改选后不保存也能看到该选择是否可用。
- 需要授权时，在下拉框 `change` 或「授权连接」按钮的用户手势里调用 `requestOcrPermission()`；拒绝不重复弹出。
- 缺组件 / 缺引擎包时显示「安装说明」弹窗：当前平台、组件上报的下载大小与磁盘占用（未上报写「以发布页为准」）、本机识别说明、安装步骤。`OCR_COMPONENT_RELEASES` 里没有当前平台的地址时下载按钮禁用并说明「尚未发布」；扩展只在用户点击后打开发布页地址。
- 「重新检测」= `getOcrStatus({ refresh: true })`。界面语言切换后调用 `ocrSettings.render()` 重画动态文案。

区块锚点是 `#sec-ocr`（`OCR_SETTINGS_HASH`），阅读器的「前往设置」按钮打开它。

### 6.2 PDF 阅读器

开关关闭时这些代码不执行。流程（`reader/reader.js` 的 OCR 段）：

1. `renderPdfPage` 遇到零文本页 → `handlePdfOcrPage`。只处理进入渲染范围的页，不以零文本为由识别整本书。
2. 按文档缓存一次 `ocr:status`；未就绪时页内显示 `ocrNotice` 文案和「前往设置」/「重试」，不弹窗、不自动下载。
3. 就绪时显示「正在本机识别本页文字…」，`ensurePdfOcr` 先查 IndexedDB 缓存，未命中再用独立倍率（`OCR_RENDER_SCALE = 3`，受单页 4 Mi 像素预算约束，与显示缩放无关）渲染一张不挂到页面的画布，经 `recognizeCanvas` 识别后立即释放画布。同页并发请求合并为一个任务。
4. 缓存键：`ocrCacheKey({ bookId, page, backend, engine: 握手时的 name/version/model, params: { languages, scale } })`，不含翻译目标语言等配置；记录存 `translations` 存储（见 [READER-ARCHITECTURE](READER-ARCHITECTURE.md)）。
5. `linesToBlocks` 把行合成文本块后，与文字层走同一套：原版视图文本块面板（页标签标注「OCR 识别文字，可能有误」）、流式视图、全文搜索、`PdfTranslator` 送翻。取块统一经 `pdfPageData`。识别结果为空时只提示「本页没有识别到文字」，不送翻。
6. 关闭 / 换书时 `cancelPdfOcr` 对在途任务发 `ocr:cancel`；晚归结果因文档已变被丢弃。缩放打断识别用的渲染（AbortError）时不报错，页面重画时再识别。
7. 状态类错误（缺组件 / 缺模型等）作废阅读器的状态缓存，页内显示对应提示；其他错误显示「重试」。配置变化时也重新检测。

当前不做：识别语言选择（默认交给组件：macOS 连接器用简体 + 繁体中文 + 英文）、多栏重排、表格、竖排古籍、画布上的可选中文字层。

## 7. 本地调试

```bash
# 单测（含真实子进程的参考宿主）
node test/ocr.test.mjs
node test/ocr-routes.test.mjs

# macOS：构建连接器后跑真实识别单测
sh native/ocr-host/macos/build.sh
node test/ocr-native-macos.test.mjs

# 真实 Chrome 端到端（自动复制扩展、打开开关、注册临时宿主；不改仓库文件）
node tools/e2e-ocr.mjs

# 手动联调：生成参考宿主的本机清单与启动脚本（输出到 tools/ocr-mock-host/.local/，已 gitignore），按提示复制到浏览器目录
node tools/ocr-mock-host/host.mjs --setup <扩展ID>
```

- 手动联调时要在本地副本里把 `OCR_UI_ENABLED` 改成 `true`，并在 `manifest.json` 加 `"optional_permissions": ["nativeMessaging"]`（或直接放进 `permissions` 免去授权弹窗）。
- 参考宿主用 `OCR_MOCK_MODE` / `OCR_MOCK_MODE_FILE` 模拟各种状态（`ready` / `system-only` / `paddle-model-missing` / `gpu-fallback` / `protocol2` / `slow` / `exit`），`OCR_MOCK_LOG` 记录收到的消息，说明在 `host.mjs` 开头。
- macOS 上不要让浏览器直接启动仓库目录里的宿主：仓库在 `~/Documents` 等受保护目录时，系统会对「浏览器拉起的程序读取该目录」反复弹出访问授权（未签名的开发版二进制每次重建都算新程序）。`tools/e2e-ocr.mjs` 会先把宿主和样本复制到临时目录；手动联调时也把宿主放到受保护目录之外。

## 8. 打开界面前的清单

`OCR_UI_ENABLED` 改成 `true` 之前须全部完成：

| # | 事项 | 状态 |
|---|---|---|
| 1 | 本地组件原型通过 PDF-HANDOFF §5.3 第 1 步 | macOS Vision 连接器已完成并实测；PaddleOCR 引擎包、Windows OCR 未开始 |
| 2 | 签名安装包：macOS Developer ID 签名 + 公证、Windows 代码签名；宿主清单注册 Chrome 与 Edge；`OCR_COMPONENT_RELEASES` 填正式地址 | 未开始 |
| 3 | `manifest.json` 加 `"optional_permissions": ["nativeMessaging"]`（可选权限不会让老用户的扩展被停用） | 未做，打开开关时一起改 |
| 4 | 设置页 `#sec-ocr` 区块（§6.1） | 已完成 |
| 5 | 阅读器逐页识别、OCR 缓存与取消（§6.2） | 已完成 |
| 6 | 真实扩展 E2E：未授权、组件缺失 / 引擎缺失 / 缺模型、取消、换书、文字型 PDF 不触发 OCR、真实连接器 | 已完成（`tools/e2e-ocr.mjs`）；GPU 回退与 Windows 待对应后端实现后补 |
| 7 | 更新隐私说明：扫描图像只发给本机组件，识别出的文字送翻时仍发给翻译服务商 | 未做 |
| 8 | 用《蠶書》等真实扫描件按 PDF-HANDOFF §5.3 探针表评估识别质量 | 未做（需要真实样本） |
