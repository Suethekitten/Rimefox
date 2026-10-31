# 本地 OCR 候选评估（参考记录）

状态：**仅评估，未跑探针、未集成、未改代码**。记录时间 2026-10-31。

**2026-11-01 拍板：OCR 放到未来版本（ROADMAP P2-11，未排期），0.14.0 不做。**

## 为什么会有这份记录

PDF 批量实测里出现了纯图片扫描件（`蠶書`，8 页、全文 0 字）。当前产品行为是逐页提示「本页没有可提取的文字（可能是扫描页）」，不崩、也不能翻译。PDF MVP 的范围里明确不包含 OCR（见 [ROADMAP](../ROADMAP.md)），所以这份记录只回答「以后要做 OCR，候选有哪些、代价是什么」。

## 候选对照

数据来自 2026-10-31 的 npm registry 与 GitHub 文档：

| | PaddleOCR.js | Tesseract.js | Scribe.js |
|---|---|---|---|
| 包名 | `@paddleocr/paddleocr-js` 0.4.2 | `tesseract.js` 7.0.0 | `scribe.js-ocr` 0.17.0 |
| 许可证 | Apache-2.0 ✅ | Apache-2.0 ✅ | **AGPL-3.0** ❌ |
| npm 解包体积 | 23.8 MB | 1.4 MB | 46.6 MB |
| 形态 | ESM，支持 Worker | UMD / ESM，Worker | 仅 ESM、无 UMD、要求同源 |
| 额外依赖 | `onnxruntime-web` 1.22、`@techstark/opencv-js` 4.10；模型以 `.tar` 运行时下载 | wasm core；语言包按需下载 | 自身 + 同源资源 |
| 中文支持 | PP-OCRv5 / v6，`lang: "ch"` | chi_sim / chi_tra 语言包 | 封装 Tesseract |
| 输出 | 每行 `text` / `poly` / `score` + 检测/识别耗时 | 文本 + 置信度 | 可写 PDF 隐形文字层 |

## 适配性判断（相对 Rimefox）

- **零构建不是硬门槛**：仓库已经 vendor pdf.js（legacy 4.10.38，约 1.5 MB），OCR 也可以按同样方式 vendor。
- **体积才是门槛**：PaddleOCR.js 整包（SDK + ORT + OpenCV + 模型）大概率 40–60 MB，是当前发布包（约 0.6 MB）的百倍；不可能进基础包，只能做「可选 OCR 增强包」或首次使用时懒下载。
- **MV3 限制**：多线程 WASM / WebGPU 需要 COOP/COEP 跨源隔离头，扩展页设不了 → 只能单线程 wasm，速度会打折。Tesseract.js 单线程即可跑。
- **离线**：PaddleOCR 默认从网络取模型，离线使用必须自己托管模型；Tesseract 语言包同样要随包或预下载。
- **许可证**：Scribe.js 是 AGPL-3.0，与 MIT 不兼容，**只做实现参考，不集成**。
- **繁体**：`蠶書` 是繁体古籍，Tesseract 需要 chi_tra（或实测 chi_sim 效果）；PaddleOCR 的 `ch` 模型对繁体的覆盖需要实测确认。

## 建议的探针（未执行）

目标：同一批扫描页上比较「Tesseract 基线」与「PaddleOCR 准确率」。

1. 资产放在 `reader/ocr-probe/`（gitignore，不进仓库）：
   - Tesseract.js 7 + wasm core + `chi_sim` / `chi_tra`（约 20 MB）
   - PaddleOCR.js（SDK + ORT + OpenCV + `PP-OCRv5_mobile_det/rec` 模型，约 50 MB）
2. 页面：`蠶書` 3 页（繁体扫描）、`r003` 中文期刊 1 页（简体文字型对照）、再补 1 页英文扫描。
3. 指标：单页耗时、峰值内存、字符数、平均置信度、**人工转写 100 字的 CER**、两引擎输出一致率。
4. 只有 PaddleOCR 明显胜出且体积/离线方案可接受时，才考虑「可选 OCR 增强包」。

## 结论

- 现在**不做** OCR；扫描件保持「提示 + 无译文」的行为。
- 将来启动时，先跑 Tesseract 基线探针，再决定是否值得为 PaddleOCR 付 40–60 MB 的代价。
- Scribe.js 只读它的「图片型 PDF → 隐形文字层」流程，不引入依赖。

## 来源

- [PaddleOCR.js（GitHub）](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js) / [SDK README](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md) / [npm](https://www.npmjs.com/package/@paddleocr/paddleocr-js)
- [Scribe.js（GitHub）](https://github.com/scribeocr/scribe.js) / [npm](https://www.npmjs.com/package/scribe.js-ocr)
- [Tesseract.js（GitHub）](https://github.com/naptha/tesseract.js) / [npm](https://www.npmjs.com/package/tesseract.js)
