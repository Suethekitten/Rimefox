# OCR 接口与使用方法

状态：**接口骨架已落地，界面未开放**（`lib/ocr/feature.js` 的 `OCR_UI_ENABLED = false`）。用户看到的行为与之前相同：扫描页只显示「本页没有可提取的文字」。
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
| `lib/ocr/feature.js` | 界面总开关 | 任意 |
| `tools/ocr-mock-host/host.mjs` | 参考 / 假宿主：协议的可运行实现，供组件开发与测试 | Node |
| `test/ocr.test.mjs`、`test/ocr-routes.test.mjs` | 协议、状态、来源、服务、缓存键、配置、路由与参考宿主进程 | Node |

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
      { "id": "system", "status": "ready", "name": "macOS Vision", "version": "26.1", "languages": ["zh-Hans", "zh-Hant", "en"] },
      { "id": "paddle", "status": "model_missing", "name": "PaddleOCR", "version": "3.0", "model": "PP-OCRv5_mobile",
        "devices": ["gpu", "cpu"], "languages": ["zh-Hans", "zh-Hant", "en"], "downloadBytes": 152000000, "diskBytes": 410000000 }
    ] }
```

- `protocols` 不含 1 → 扩展判定 `incompatible` 并断开。
- `backends[].status`：`ready` / `engine_missing` / `model_missing` / `language_unavailable` / `incompatible` / `unsupported`；未知值按 `unsupported`。
- 连接器装好但没报 `paddle` 时，扩展按 `engine_missing` 处理；没报 `system` 时按 `unsupported` 处理。
- `languages` 用 BCP 47 标签，只报**实际可用**的语言（Windows 按已装语言包）。设置页据此显示，不按平台名推断。
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

### 6.1 设置页（待实现，见 §8）

```js
import { getOcrStatus, requestOcrPermission } from '../lib/ocr/page.js';
import { saveConfig } from '../lib/config.js';

// 渲染：用 ocr.choice 选中下拉框，用 ocr.backends 显示每个后端的实际状态 / 语言 / 体积
const ocr = await getOcrStatus();

// 用户在下拉框选了 system / paddle：必须在这次点击里申请权限
select.addEventListener('change', async () => {
  if (select.value === 'system' || select.value === 'paddle') await requestOcrPermission();
  await saveConfig({ ocrEngine: select.value });
  render(await getOcrStatus({ refresh: true }));
});
// 「重新检测」按钮：getOcrStatus({ refresh: true })
```

设置页 OCR 区块的锚点是 `#sec-ocr`（`OCR_SETTINGS_HASH`），阅读器的「前往设置」按钮会打开它。

### 6.2 PDF 阅读器

已接入的部分（开关关闭时不执行）：`renderPdfPage` 遇到零文本页时调用 `showPdfOcrNotice`。它按文档缓存一次 `ocr:status`，未就绪时在页内显示 `ocrNotice` 文案和「前往设置」/「重试」按钮，不弹窗、不自动下载。

就绪后的逐页识别（PDF-HANDOFF §5.3 第 3 步）按下面的方式接：

```js
import { recognizeCanvas, cancelOcr } from '../lib/ocr/page.js';
import { ocrCacheKey } from '../lib/ocr/cache-key.js';

const jobId = bookId + ':' + index + ':' + epoch;
const result = await recognizeCanvas(canvas, { jobId, languages: ['zh-Hant'] });
// 1. 晚归检查：文档 / 代际变了就丢弃结果（与 PdfTranslator.epoch 同一套）
// 2. 以 ocrCacheKey({ bookId, page: index, backend: result.backend, engine: result.engine, params }) 存缓存
// 3. 把 result.lines 合成文本块，交给现有的 PDF 翻译流程；lines 为空时不送翻
// 关闭 / 换书 / 停止：cancelOcr(jobId)
```

## 7. 本地调试

```bash
# 单测（含真实子进程的参考宿主）
node test/ocr.test.mjs
node test/ocr-routes.test.mjs

# 生成参考宿主的本机清单与启动脚本（输出到 tools/ocr-mock-host/.local/，已 gitignore），按提示复制到浏览器目录
node tools/ocr-mock-host/host.mjs --setup <扩展ID>
```

在真实浏览器里联调前，还要临时在 `manifest.json` 加 `"optional_permissions": ["nativeMessaging"]`，并在扩展页控制台执行 `chrome.permissions.request({ permissions: ['nativeMessaging'] })`。参考宿主用 `OCR_MOCK_MODE` 模拟各种状态（`ready` / `system-only` / `paddle-model-missing` / `gpu-fallback` / `protocol2` / `slow`），说明在 `host.mjs` 开头。

## 8. 打开界面前的清单

`OCR_UI_ENABLED` 改成 `true` 之前须全部完成：

1. 本地组件原型通过 PDF-HANDOFF §5.3 第 1 步（真实安装资产、体积、Vision / Windows OCR / PaddleOCR GPU·CPU 路径）。
2. `manifest.json` 加 `"optional_permissions": ["nativeMessaging"]`。可选权限不会让老用户的扩展被停用。
3. 设置页加 `#sec-ocr` 区块：下拉框、各后端实际状态、权限申请、下载说明弹窗与「重新检测」，文案遵守 PDF-HANDOFF §5.2。
4. 阅读器接入逐页识别、OCR 缓存与取消（§6.2）。
5. 真实扩展 + 参考宿主的 E2E：未授权、组件缺失、引擎缺失、GPU 回退、取消、组件断开、换书与停止后晚归；文字型 PDF 的翻译请求次数不变。
6. 更新隐私说明：扫描图像只发给本机组件，识别出的文字送翻时仍发给翻译服务商。
