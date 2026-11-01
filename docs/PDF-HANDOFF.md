# PDF 阅读器交接：现状、限制与 OCR 准备

状态：**0.14.0 已发布，内部定位测试版**（2026-11-01 拍板，不作正式推广）。后续维护交给协助者。
用户向变更看 [CHANGELOG](../CHANGELOG.md)；排期看 [ROADMAP](ROADMAP.md)；技术问题总表看 [HANDOFF §9](../HANDOFF.md#9-已知问题技术清单) 第 21–26 条。

## 1. 代码在哪

| 文件 | 职责 |
|---|---|
| `lib/reader/pdf.js` | `PdfDocument`：打开 PDF、元数据、按页加载、渲染、三档目录、跨页页眉扫描 |
| `lib/reader/pdf-text.js` | 纯函数文本层：片段→行（按内容流）、页眉页脚/横幅过滤、栏检测、段落合并、项目符号分段、印刷版目录解析 |
| `lib/reader/pdf-translate.js` | PDF 页翻译：按块分批调用 `translate`、译文缓存（IndexedDB） |
| `reader/reader.js` | 阅读器 UI：导入（EPUB/PDF）、页容器、可视范围渲染队列、缩放、模式切换、目标语言、进度 |
| `reader/reader.css` | `.pdf-*` 样式、`data-pdf-mode` 三种显示模式 |
| `reader/pdf-probe.html` / `pdf-probe.js` | 阶段 0 探针页：直接测 pdf.js 的解析/渲染/文本块（不经过 reader UI） |
| `tools/e2e-pdf-reader.mjs` | PDF 阅读器 E2E（真实扩展 + 真 PDF + 假翻译 API） |
| `tools/e2e-pdf-probe.mjs` | 探针批量跑分（真实 PDF 放 `reader/pdf-real/`，已 gitignore） |
| `reader/vendor/pdfjs/` | pdf.js 4.10.38 legacy 构建 + worker + 169 个 CJK cmaps |

## 2. 数据流（排查顺序）

导入：`reader.js importFile` → 检测 PDF（扩展名/magic）→ `importPdf`（只存文件与元数据，**不在导入时开 pdf.js 文档**，避免同页两个文档导致渲染异常）→ 书库记录。

打开：`openPdfBook` → `loadPdfDocument()` → 生成页容器（`aspect-ratio` 占位）→ 目录 `doc.toc()` → `renderVisiblePdfPages()`。

渲染：`renderVisiblePdfPages` 只处理可视范围 ±800px → 串行队列 `pdfRenderQueue` → `renderPdfPage`（canvas 基准宽 = `#bookContent` 宽 − padding，渲染倍率 = `max(1.5, dpr) × zoom`，上限 3）→ 文本块面板 → `applyPdfTranslations`。

翻译：`translatePdfPage` → `PdfTranslator.translatePage`（≤16 段 / 3600 字一批）→ 缓存 key `pdf|bookId|page:N|块序号|FNV` → 写回块下方。

## 3. 已知限制（0.14.0）

1. **印刷版目录页码是书内页码**，和 PDF 物理页有前目录偏移；点击可能差几页。没有做页偏移映射。
2. **少数页两栏被 pdf.js 编码成单个 text item**（示例 OBP 第 20 页：作者小传 + 西语摘要），坐标上没有断点，仍可能合并成一段。需要文本级兜底，但该页文本是词中间交错的，按文本切会切坏，需谨慎设计。
3. **扫描件 0 文本**：逐页提示「本页没有可提取的文字（可能是扫描页）」，不翻译；OCR 排未来版本（见 §5）。
4. **跨栏/跨页段落按页分块**：段落会在页边界断开，译文也按页。
5. **高倍缩放需要横向滚动页面**：不自动换行/重排。
6. 阅读器画布本身不可选中文字；下方文本块可选中、可翻译。
7. **没有流式 / 重排阅读模式**：PDF 画布是固定版式，字号 / 行高只影响下方文本块，画布不重排；因此不存在「流式模式下调字号导致双语错位」的场景。

另：源 PDF 缺字形时画布显示「口口」，这是文件本身的问题（本地 PDF 软件同样显示），不是渲染 bug；文本提取仍然是正确字符。

## 4. 未来更新候选（未排期）

按收益/成本排序，供接手者决定：

1. **跨页/跨栏段落合并**：把上一页末尾与下一页开头按「无句末标点 + 续行」拼成同一翻译单元，减少断句。
2. **单 text item 的双栏兜底**：仅在「整页无栏 + 多行超宽 + 行内有稳定列起点」时启用，避免误切正文；需要更多样本验证。
3. **印刷版目录页偏移映射**：用目录页自身的印刷页码与 PDF 页号估算 offset；或点击时按标题回搜。
4. **列表/表格**：项目符号已分段；编号列表、表格行仍是合并文本。
5. **缩放体验**：适应宽度 / 双页模式 / 记住每本书的缩放。
6. **性能**：目前串行渲染；大页面可加缩略图或后台预取（注意后台标签页 rAF 暂停，见 HANDOFF §9 第 21 条）。
7. **流式 / 重排阅读（大工程）**：把 PDF 文本流重排成可调字号的阅读视图，需要处理栏顺序、图表位置、脚注锚点；目前未排期。
8. **表格 / 公式文本清洗（0.15+ 分两步）**：小版本先做「表格按坐标拆行列、公式 base64 换 [公式] 占位不送翻、脚注标记剥离」；表格结构重建与公式识别属大工程，与 OCR / 真流式一起评估。

## 5. OCR（准备工作已开始，未实现）

**边界**：0.14.0 不做 OCR；扫描件只提示。2026-11-01 拍板排到未来版本（ROADMAP P2-11），**准备工作已开始：候选评估完成、探针计划就绪，尚未跑探针、未集成代码**。

候选事实（2026-10-31 取自 npm/GitHub，详见 [归档评估](archive/2026-10-31-ocr-candidates.md)）：

| 候选 | 许可 | 体积/依赖 | 适配性 |
|---|---|---|---|
| PaddleOCR.js `@paddleocr/paddleocr-js` | Apache-2.0 | 23.8 MB SDK + ONNX Runtime Web + OpenCV；模型是运行时 `.tar` 下载 | 中文准确率候选；体积大（整体 40–60 MB），MV3 下拿不到 COOP/COEP，只能单线程 |
| Tesseract.js | Apache-2.0 | 1.4 MB + wasm + 语言包（chi_sim ≈15 MB） | 基线；单线程可跑；中文/繁体准确率需实测 |
| Scribe.js | **AGPL-3.0** | 46.6 MB，仅 ESM、要求同源 | **不能集成**（与 MIT 不兼容），只参考「图片型 PDF → 隐形文字层」流程 |

**探针计划（未执行）**：`reader/ocr-probe/`（gitignore）放 Tesseract 资产，同一批扫描页对比 Tesseract vs PaddleOCR；指标：单页耗时、峰值内存、字符数、平均置信度、人工转写 100 字的 CER、跨引擎一致率。测试页建议：`蠶書`（繁体扫描）、中文期刊（简体）、英文扫描页。

**决策门槛**：只有 PaddleOCR 明显胜出且体积/离线方案可接受（懒下载或可选增强包）才集成；否则维持「文本型 PDF + 提示扫描页」。

## 6. 2026-11-01 烂 PDF 实测

- 样本：DPO（arXiv 2305.18290）、RAFT（2104.00680）、YOLOv4（2004.10934），加上已有的中文双栏期刊与 OBP。
- **RAFT 的 LaTeX base64 垃圾**：文本层混入 `<latexitsha1_base64="…">…</latexit>`，已加过滤（纯 base64 长串也剔除），首块从乱码恢复为 `1. Local Feature CNN`。
- **YOLOv4 长段落**：单栏顺序正确，但一页只有 2 个大块（约 2900 字/块），翻译单元偏大。
- **双栏顺序**：中文期刊已按内容流输出正确顺序；OBP 仍有单 text item 合并页（§3 第 2 条）。
- **图表**：画布保留图表原样；文本只提取图注 / 表格里的文字，表格结构可能被拍平。
- **字号**：只影响下方文本块（PDF 画布不重排）；实测 18px → 文本块 20.16px。
- **模式切换**：原文 / 双语 / 仅译文不重建页面，滚动位置保持（实测 1200 → 1200）。
- **延迟**：假 API 下点击「双语」到译文渲染约 204ms；进度条在开始翻译时即显示，真实 API 超过 3 秒也有进度提示。
- **文字模式提示条**：顶部细条「当前为纯文字重排，图表/公式请切回原版版面」+ 一键切换按钮（非弹窗）。
- **长块切分**：单块超过 1500 字时按句末标点切开再送翻，避免整段翻译质量崩。
- **原版交互**：新增「适合宽度（100%）」「单栏（190%）」缩放按钮，减少模式来回切换。

## 7. 测试与调试

```bash
# 全部 Node 单测（含 pdf-text 纯函数）
node --test test/*.test.mjs

# EPUB 阅读器 E2E（真实 Chrome + 假翻译 API）
node tools/e2e-reader.mjs

# PDF 阅读器 E2E（含渲染/缩放/译文；默认跑完整断言）
RIMEFOX_PDF_RENDER=1 node tools/e2e-pdf-reader.mjs

# 探针：批量真实 PDF（文件放 reader/pdf-real/，cases.json 指定页码）
node tools/e2e-pdf-probe.mjs
```

- 真 PDF 样本与 `cases.json` 都在 `reader/pdf-real/`，**已 gitignore**，不要提交
- 后台标签页里 pdf.js 渲染会停（rAF 暂停）：E2E 用 `Page.bringToFront`，产品侧靠 `visibilitychange` 补渲染
- Chrome 114 最低版本用 `--legacy-load` 跑探针（`tools/e2e-pdf-probe.mjs <chrome> --legacy-load`）

## 8. 发版与维护

- 版本号三处同步：`manifest.json`、`content/core.js` 的 `DT.VERSION`、`package.json`；规则见 [AGENTS.md](../AGENTS.md)
- CHANGELOG 3–6 条、每条一句话、≤90 字；发版前 `python tools/check-release-notes.py <版本号>`
- 打包：`node tools/package-store.mjs --release`（用户包）/ `node tools/package-store.mjs`（商店包）；已排除 `reader/pdf-real`、`pdf-samples`、`pdf-probe`
- 推 main 且 manifest 版本变化会触发 Release workflow；同版本只发一次
- 0.14.0 是**内部测试版**：GitHub Release 保持正常标签，不作正式推广

## 9. 文档地图

| 想知道什么 | 看哪 |
|---|---|
| PDF 实现与维护交接（本文） | `docs/PDF-HANDOFF.md` |
| 已知问题全表 | `HANDOFF.md` §9（PDF 是 21–26 条） |
| 0.14.0 实施记录 | `HANDOFF.md` §14 |
| 接下来做什么、优先级 | `ROADMAP.md`（P1-4 已完成，P2-11 OCR） |
| OCR 评估细节 | `docs/archive/2026-10-31-ocr-candidates.md` |
| 阅读器接口 / BookDocument | `docs/READER-ARCHITECTURE.md` |
