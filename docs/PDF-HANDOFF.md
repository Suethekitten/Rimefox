# PDF 阅读器交接：现状、限制与 OCR 准备

状态：**PDF 自 0.14.0 发布，仍为 Beta，暂不列入 1.0 基础支持承诺**。0.16.4 加入画布预算与渲染取消；正式范围与验收状态统一见 [SUPPORT](SUPPORT.md)。
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
| `lib/ocr/`、`options/ocr.js`、`native/ocr-host/` | OCR：协议、状态、Native 来源、服务、缓存键、版面、设置页区块与 macOS 连接器；界面未开放，见 [OCR-INTERFACE](OCR-INTERFACE.md) |

## 2. 数据流（排查顺序）

导入：`reader.js importFile` → 检测 PDF（扩展名/magic）→ `importPdf`（只存文件与元数据，**不在导入时开 pdf.js 文档**，避免同页两个文档导致渲染异常）→ 书库记录。

打开：`openPdfBook` → `loadPdfDocument()` → 生成页容器（`aspect-ratio` 占位）→ 目录 `doc.toc()` → `renderVisiblePdfPages()`。

渲染：`renderVisiblePdfPages` 只处理可视范围 ±800px → 串行队列 `pdfRenderQueue` → `renderPdfPage`（canvas 基准宽 = `#bookContent` 宽 − padding，渲染倍率 = `max(1.5, dpr) × zoom`，上限 3）→ 文本块面板 → `applyPdfTranslations`。

翻译：`translatePdfPage` → `PdfTranslator.translatePage`（≤16 段 / 3600 字一批）→ 按下列身份读取 reader 缓存 → 写回块下方。

### PDF 译文缓存与任务生命周期（0.14.2 本地修复）

原 0.14.2 修复未单独发布，现纳入 0.15.0；发布状态以 [ROADMAP](ROADMAP.md#4-近期安排) 为准。

- 键为 `pdf-v2|bookId|page:N|块序号|配置身份|原文 FNV`；读取还要核对记录的配置身份与完整 source，避免哈希碰撞误用。原书与进度、EPUB 缓存不迁移。
- 配置身份由 `lib/reader/pdf-cache.js` 统一生成 SHA-256：包含目标语言元数据、风格 / 强度、服务商 / 协议 / 规范化地址 / 模型、术语 / 提示词、专业策略版本 / 选项、隐私选项、温度与思考配置。显示模式、外观与 API Key 不参与；切回原语言或配置可以复用其译文。
- 旧 `pdf|...` 条目缺少完整配置身份，保留但不复用；下次翻译按当前配置重新生成，删除书时照常一并清理。
- 阅读器请求带 `pdfCacheIdentity`；后台取到当前配置后用同一实现核对，不一致则返回 `errorCode: 'config_changed'`，不发送模型请求，避免设置页与阅读器之间的竞态污染缓存。
- 切目标语言或有效翻译配置会作废旧任务、撤去旧译文并回到有效的原文模式；仅修改配置 / 下拉框不翻译。外观变化保留当前译文。页面监听可信扩展页的 storage 变化，并在明确翻译前重拉去 Key 的配置。
- `PdfTranslator.epoch` 与阅读器文档代际共同检查缓存读取、模型响应和视图写回；关闭 / 换书 / 停止后旧任务不能覆盖当前视图或修改新进度。停止保留已完成的译文，并禁止滚动自动续发，直到明确重新翻译。
- 长块全部切片成功后才写入整块缓存；缺片不把部分译文当成完整结果保存。

## 3. 已知限制（截至 0.16.4）

1. **印刷版目录页码是书内页码**，和 PDF 物理页有前目录偏移；点击可能差几页。没有做页偏移映射。
2. **极少数页仍可能被 pdf.js 编码成单个 text item**：坐标上没有断点，自动拆栏只剩提示，不静默切坏。2026-11-02 复核本地 OBP 样本时发现，第 20 页实际是 4 栏页面（标题横跨多栏），旧逻辑被跨栏标题干扰后回退到「按中线分左右」，导致整页碎成大量小块；现已改为按行首 x 聚类识别栏，4 栏顺序正常。真正单 item 的页面本地样本未复现。
3. **扫描件 0 文本**：逐页提示「本页没有可提取的文字（可能是扫描页）」，不翻译；OCR 排未来版本（见 §5）。
4. **跨栏/跨页段落按页分块**：段落会在页边界断开，译文也按页。
5. **高倍缩放需要横向滚动页面**：不自动换行/重排。
6. 阅读器画布本身不可选中文字；下方文本块可选中、可翻译。
7. **已有文本流式视图**：可调整字号与行高，在原版与流式间同步到附近页；图表、合并单元格、跨页段落与公式不能完整重建。

另：源 PDF 缺字形时画布显示「口口」，这是文件本身的问题（本地 PDF 软件同样显示），不是渲染 bug；文本提取仍然是正确字符。

## 4. 未来更新候选（未排期）

按收益/成本排序，供接手者决定：

1. **跨页/跨栏段落合并**：把上一页末尾与下一页开头按「无句末标点 + 续行」拼成同一翻译单元，减少断句。
2. **单 text item 的双栏兜底**：已改为按行首 x 聚类识别栏，跨栏标题不会再干扰；真正「整页 1–2 个 text item」的页面仍无法靠坐标拆，只显示复杂版式提示，不静默切。需要更多样本验证后再考虑文本级兜底。
3. **印刷版目录页偏移映射**：用目录页自身的印刷页码与 PDF 页号估算 offset；或点击时按标题回搜。
4. **列表/表格**：项目符号已分段；编号列表、合并单元格、纯文字表格仍是合并文本。数据表在单栏页会按单元格拆开（见 §6）。
5. **缩放体验**：适应宽度 / 双页模式 / 记住每本书的缩放。
6. **性能**：目前串行渲染；大页面可加缩略图或后台预取（注意后台标签页 rAF 暂停，见 HANDOFF §9 第 21 条）。
7. **完善流式阅读**：基础文本流已实现；图表位置、脚注锚点、表格结构与跨页段落合并仍待改进。
8. **表格 / 公式文本清洗（低风险项已落地，2026-11-02）**：表格仅在单栏页、连续行且数据行带数字时按单元格拆（不重建合并单元格）；公式残渣换 `[公式]` 占位且公式块不送翻；脚注标记与上标编号从正文剥离；目录页不再被当成第二栏。表格结构重建、公式识别与纯文字表格仍留待 OCR / 真流式一起评估。

## 5. OCR（方案已确定，尚未实现）

**当前状态**：2026-11-04 已确定采用「可选安装的本地 OCR 组件」。2026-11-05 扩展侧流程（设置页区块、逐页识别、缓存、送翻、取消）与 macOS Vision 连接器（`native/ocr-host/macos`）已实现并在真实 Chrome 中端到端验证，但界面开关关闭：PaddleOCR 引擎包、Windows、签名安装包与隐私说明尚未完成，现有版本仍只提示扫描页。进度与开放前清单见 [OCR-INTERFACE §8](OCR-INTERFACE.md#8-打开界面前的清单)。排期以 [ROADMAP P2-11](ROADMAP.md#p2--可配置性) 为准。

### 5.1 交付方式

- 基础扩展提供选择、能力检测和阅读器接入；OCR 引擎、模型及其本地依赖随独立组件交付，不放进基础扩展安装包。
- 通过 Native Messaging 与已安装的本地组件通信。macOS 优先接入系统 Vision；检测到 macOS 本身不代表可用，仍须确认连接组件、系统能力及所选语言可用。
- 本地 PaddleOCR 由组件提供。可用时优先 GPU，初始化或识别不兼容时按可恢复的错误回退 CPU；CPU / GPU 共用兼容模型。具体运行库、安装包体积与平台支持须在原型验证后确定，不直接沿用浏览器 WASM 方案的体积估计。
- 系统 OCR 按实际能力显示；其它平台没有系统后端时不显示为已配置。扫描图片在本机识别；识别出的文字若进入现有翻译流程，仍按用户配置发送给翻译服务商。
- 用户主动选择下载组件后才联网获取安装资产，并由用户完成系统安装；扩展不静默安装或执行下载程序。安装来源、平台匹配与完整性校验随正式组件一起实现。
- 模型随组件安装包或安装步骤一次就位，识别时不再从 PaddleOCR 官方源或第三方 CDN 拉取模型；装好后断网可用。
- 引擎许可证限 Apache-2.0 / MIT 等宽松协议。PaddleOCR 与 Tesseract 均为 Apache-2.0；Scribe.js 为 AGPL-3.0，组件内同样不集成，只参考其「图片型 PDF → 隐形文字层」流程。
- **组件分两层交付**：轻量连接器（Native Messaging 宿主 + 系统 OCR 调用，目标为几 MB）与 PaddleOCR 引擎包（运行库 + 模型，体积按原型实测）。只用系统 OCR 的用户不必下载 PaddleOCR；PaddleOCR 包依赖连接器，可一次安装两者。扩展里的「系统 OCR」同样需要连接器：浏览器扩展无法直接调用 Vision / Windows OCR，这点与桌面应用不同。
- **`nativeMessaging` 只放 `optional_permissions`**，在用户于设置页选择需要组件的 OCR 选项时（用户手势内）用 `chrome.permissions.request` 申请。放进必需权限会让老用户升级时扩展被停用，直到接受「与协作的本机应用通信」的新权限警告。拒绝授权按「未授权」状态处理，不当作未配置反复提示。
- **签名与公证是组件发布的前置条件**：macOS 安装包须 Developer ID 签名并公证，Windows 安装包须代码签名，否则 Gatekeeper / SmartScreen 会拦截。宿主清单的 `allowed_origins` 只列正式扩展 ID（不允许通配），商店版与 GitHub 版 ID 不同时须分别列出。
- **引擎无关接口**：扩展侧只依赖统一的 OCR 后端接口（能力检测、识别、取消）和统一状态码，不在设置页或阅读器里写死引擎。原生组件维护不过来时，可把 10-31 评估中的浏览器内 WASM 方案作为第三种后端接入；注意 MV3 禁止远程代码，WASM 运行库必须随扩展包发布，只有模型 / 语言包这类数据能按需下载。接口与协议见 [OCR-INTERFACE](OCR-INTERFACE.md)。

### 5.1.1 原型阶段待定项

以下事项两份评估都未实测，原型前不写进用户承诺：

- **Windows 系统 OCR**：Edge 用户以 Windows 为主，而 Windows 10+ 自带 [Windows.Media.Ocr](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr)，可用语言取决于已装语言包。原型须确认它能否作为 Windows 上的「系统 OCR」，以及繁体 / 古籍效果；确认前 Windows 只走本地 PaddleOCR。
- **Tesseract 的角色**：可作对照基线，也可作 PaddleOCR 之外的轻量后备。只有当 PaddleOCR 在 §5.3 的样本上明显胜出时，才值得为它付出安装体积；差距不大时改以 Tesseract 为主或二者择一。
- **繁体覆盖**：首个扫描样本《蠶書》是繁体古籍。PaddleOCR 的 `ch` 模型和 Tesseract 的 `chi_tra` / `chi_sim` 对它的效果都须实测，不按官方语言列表认定可用。
- **识别结果的呈现**：首版只把 OCR 文本接入下方文本块与翻译流程。是否像 Scribe.js 那样给画布叠一层可选中的隐形文字层（同时解决 §3 第 6 条），留到首版之后再评估。

### 5.2 设置与阅读器交互

设置页与 PDF 阅读器共用一套 OCR 配置、能力检测结果和组件就绪状态；从任一入口修改后同步到另一个入口。

| 选择 | 预期行为 |
|---|---|
| 自动选择 | 优先已就绪的系统 OCR，否则使用已就绪的本地 PaddleOCR；未就绪时提示配置，不自动下载 |
| 系统 OCR | 显示实际能力；缺连接组件时提供安装说明，不因平台名称就认定可用 |
| 本地 PaddleOCR | 未安装、缺模型或版本不兼容时打开配置 / 下载说明；就绪后才可识别 |
| 关闭 OCR | 尊重用户主动关闭，显示关闭状态，保留 PDF 原文阅读 |

**用户指定的未配置提示原文**：`未配置OCR，请前往设置配置`。英文界面对应 `No OCR configured. Please configure OCR in Settings.`。

- 当页面需要新增 OCR 且没有可用引擎时，在阅读器内显示上述提示，提供直达 OCR 设置的按钮。设置页同时显示未配置状态；不反复弹窗或强制打开设置页。
- PDF 原版仍可阅读；现有文字层照常处理，已有 OCR 文本 / 译文缓存不因组件暂时不可用而删除。空白页也可能没有文字，不以零文本为由自动下载组件或识别整本书。
- 用户选择未安装的本地 PaddleOCR 时，弹窗显示当前平台、实际下载大小、所需磁盘空间、本机识别说明、下载及取消按钮。下载后显示安装步骤和「重新检测」入口。
- 文案须如实反映扩展场景（参考稿来自桌面应用，以下几处不能照搬）：
  - 系统 OCR 只显示**实际检测到的**平台与可用识别语言，例如「已检测到 macOS 文本识别（简体中文、繁体中文、英文）」，不写「macOS Live Text / Windows OCR」并列；Windows 缺中文语言包时明确提示缺哪种语言。
  - 不写「完全离线」。写「识别在本机完成，无需 API Key」；识别出的文字送翻时仍发给所配置的翻译服务商。
  - 不写「在本地进程内运行」，写「在独立本地组件中运行」。
  - 体积写当前平台的实际下载大小与所需磁盘空间，不写跨平台的约数。
- 组件经过检测确认就绪后才启用。取消、下载失败或安装未完成时保留此前可用选择，允许重试；缺组件、识别失败和用户主动关闭使用不同状态，避免都误报为未配置。
- 缺组件 / 模型或检测失败时，不向翻译 API 发送空文本，不把未配置状态当成可无限重试的 OCR 任务。

### 5.3 实施与验收顺序

1. 先验证本地组件的能力检测、版本兼容、系统 Vision、本地 PaddleOCR GPU / CPU 路径及断开恢复；确认真实安装资产与体积。
2. 接入设置页 / PDF 阅读器的共享选择器、未配置提示、下载及安装后重新检测流程；检测与任务控制只接受可信扩展页调用。
3. 接入逐页识别、页图像 / 像素与并发限制、取消及旧任务晚归隔离。OCR 缓存区分原书、页码、引擎 / 模型版本和识别参数；不因切翻译目标语言重复识别原图。
4. 用简体、繁体和英文扫描页核对正文保留、识别误差、耗时及内存；补真实扩展与组件的 E2E，覆盖组件未安装、模型缺失、GPU 失败回退 CPU、取消下载、组件断开、换书与停止后晚归。无 OCR 时的文字型 PDF、原版阅读和翻译请求次数必须保持正确。

进度：第 2、3 步已完成；第 1 步完成 macOS 系统 OCR（Vision），PaddleOCR GPU / CPU 与 Windows 未开始；第 4 步已有真实扩展 E2E（参考宿主 + macOS 连接器），真实扫描件质量评估未做。逐项状态见 [OCR-INTERFACE §8](OCR-INTERFACE.md#8-打开界面前的清单)。

第 1 步与第 4 步的引擎对比沿用 10-31 评估中设计好、但当时没跑的探针：

| 项 | 内容 |
|---|---|
| 样本 | 《蠶書》3 页（繁体扫描，0 文本）；`r003` 中文期刊 1 页（简体文字型，按 OCR 输入分辨率渲染成图片后识别，原文字层作为参考答案）；英文扫描 1 页（待补） |
| 引擎 | 已接入平台的系统 OCR、本地 PaddleOCR（GPU / CPU 各跑一次）、Tesseract 基线 |
| 指标 | 单页耗时、峰值内存、识别字符数、平均置信度、人工转写 100 字的 CER、引擎间输出一致率 |
| 放行条件 | 记录实际安装体积；PaddleOCR 须在繁体与简体样本上明显优于 Tesseract，否则按 §5.1.1 重新选择默认引擎 |

样本与探针资产放 gitignore 目录（参照 `reader/pdf-real/`），不进仓库，也不进打包产物。

### 5.4 两份评估的合并说明

| 议题 | 2026-10-31 浏览器内评估 | 2026-11-04 交付决定 | 现行口径 |
|---|---|---|---|
| 运行位置 | 扩展内 WASM，作可选增强包或懒下载 | 独立本地组件，经 Native Messaging 调用 | 独立组件 |
| 体积 | PaddleOCR 整包约 40–60 MB，Tesseract + 语言包约 20 MB | 原型后按真实资产确定 | 浏览器估算不沿用，按组件实测 |
| 多线程 / GPU | 认为扩展页做不到跨源隔离，只能单线程 | 已更正：扩展支持 COOP / COEP | 不作为排除依据；选组件是交付决定，不是算力限制 |
| 候选与许可证 | PaddleOCR、Tesseract 可用；Scribe.js 因 AGPL 排除 | 系统 Vision + 本地 PaddleOCR | 加 Tesseract 作基线 / 后备，Scribe.js 继续排除（§5.1、§5.1.1） |
| 离线 | 模型默认联网取，须自托管 | 用户主动下载组件 | 模型随组件就位，识别时不联网（§5.1） |
| 验收 | 繁 / 简 / 英样本，CER 等指标 | 简 / 繁 / 英，正确性、耗时、内存与 E2E | 合并为 §5.3 的探针表 |

原始记录见 [2026-10-31 评估](archive/2026-10-31-ocr-candidates.md)。该记录作为历史保留，新增结论只更新本节。

参考：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Apple Vision 文本识别](https://developer.apple.com/documentation/vision/recognizing-text-in-images)、[Chrome 扩展跨源隔离](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)。

## 6. 2026-11-01 烂 PDF 实测

- 样本：DPO（arXiv 2305.18290）、RAFT（2104.00680）、YOLOv4（2004.10934），加上已有的中文双栏期刊与 OBP。
- **RAFT 的 LaTeX base64 垃圾**：文本层混入 `<latexitsha1_base64="…">…</latexit>`，已加过滤（纯 base64 长串也剔除），首块从乱码恢复为 `1. Local Feature CNN`。
- **YOLOv4 长段落**：单栏顺序正确，但一页只有 2 个大块（约 2900 字/块），翻译单元偏大。
- **双栏 / 多栏顺序**：中文期刊已按内容流输出正确顺序；OBP 第 20 页这类 4 栏页改为按行首 x 聚类，跨栏标题不会再把栏粘成一片。真正被 pdf.js 编码成单个 text item 的页面仍只提示，不静默切（§3 第 2 条）。
- **图表**：画布保留图表原样；文本只提取图注 / 表格里的文字，表格结构可能被拍平。
- **字号**：只影响下方文本块（PDF 画布不重排）；实测 18px → 文本块 20.16px。
- **模式切换**：原文 / 双语 / 仅译文不重建页面，滚动位置保持（实测 1200 → 1200）。
- **延迟**：假 API 下点击「双语」到译文渲染约 204ms；进度条在开始翻译时即显示，真实 API 超过 3 秒也有进度提示。
- **文字模式提示条**：顶部细条「当前为纯文字重排，图表/公式请切回原版版面」+ 一键切换按钮（非弹窗）。
- **长块切分**：单块超过 1500 字时按句末标点切开再送翻，避免整段翻译质量崩。
- **原版交互**：新增「适合宽度（100%）」「单栏（190%）」缩放按钮，减少模式来回切换。
- **P0 可用性**：加密/损坏 PDF 明确提示；目录面板加「跳页」与「全文搜索」（最多 50 条）；翻译进度条带「停止」；页面文本块过大或碎块过多时标注「复杂版式，文本顺序可能不准确」。
- **文本清洗（2026-11-02 本地实现，0.16.3 收紧）**：公式残渣换 `[公式]` 且公式块不送翻（十六进制哈希 / DNA 序列除外）；脚注 `[1]` / 上标编号按上下文剥离（区间 `[0, 1]`、下标 `a[0]`、单位 `m²`、指数 `10⁶`、同位素 `¹⁴C` 保留），版面上的上下标转成 Unicode 上 / 下标留在正文；目录页逐条输出、标题与页码成对；数据表在单栏页按单元格拆开，纯文字表与多栏页表格保持原样。标题字号明显大于正文时单独成段。

## 7. 测试与调试

```bash
# 全部 Node 单测（含 pdf-text 纯函数）
node --test test/*.test.mjs

# PDF 缓存 / 取消 / 配置隔离；后台快照竞态
node --test test/reader-pdf-cache.test.mjs test/background-state.test.mjs

# EPUB 阅读器 E2E（真实 Chrome + 假翻译 API）
node tools/e2e-reader.mjs

# PDF 阅读器 E2E（默认用仓库合成 PDF + 按目标语言回包的假 API）
node tools/e2e-pdf-reader.mjs

# 探针：批量真实 PDF（文件放 reader/pdf-real/，cases.json 指定页码）
node tools/e2e-pdf-probe.mjs
```

- 真 PDF 样本与 `cases.json` 都在 `reader/pdf-real/`，**已 gitignore**，不要提交
- 合成阅读器样本由 `node tools/make-pdf-samples.mjs` 生成；E2E 覆盖语言 / 配置切换、重开缓存、旧响应晚归与停止，不等同于真实模型质量验收
- 后台标签页里 pdf.js 渲染会停（rAF 暂停）：E2E 用 `Page.bringToFront`，产品侧靠 `visibilitychange` 补渲染
- Chrome 114 最低版本用 `--legacy-load` 跑探针（`tools/e2e-pdf-probe.mjs <chrome> --legacy-load`）

## 8. 发版与维护

- 版本号三处同步：`manifest.json`、`content/core.js` 的 `DT.VERSION`、`package.json`；规则见 [AGENTS.md](../AGENTS.md)
- CHANGELOG 3–6 条、每条一句话、≤90 字；发版前 `python tools/check-release-notes.py <版本号>`
- 打包：`node tools/package-store.mjs --release`（用户包）/ `node tools/package-store.mjs`（商店包）；已排除 `reader/pdf-real`、`pdf-samples`、`pdf-probe`
- 推 main 且 manifest 版本变化会触发 Release workflow；同版本只发一次
- PDF 仍按**内部测试版**维护：GitHub Release 保持正常标签，不作正式推广

## 9. 文档地图

| 想知道什么 | 看哪 |
|---|---|
| PDF 实现与维护交接（本文） | `docs/PDF-HANDOFF.md` |
| 已知问题全表 | `HANDOFF.md` §9（PDF 是 21–26 条） |
| 0.16.0 实施记录 | `HANDOFF.md` §14 与 [PDF 文本质量归档](archive/2026-11-02-pdf-quality-0.16.0.md) |
| 接下来做什么、优先级 | `ROADMAP.md`（P1-4 已完成，P2-11 OCR） |
| OCR 现行方案与评估合并结论 | 本文 §5（历史候选：`docs/archive/2026-10-31-ocr-candidates.md`） |
| OCR 接口、协议与接入方法 | [OCR-INTERFACE](OCR-INTERFACE.md) |
| 阅读器接口 / BookDocument | `docs/READER-ARCHITECTURE.md` |

## 10. 画布资源契约（0.16.4）

`pdf-raster.js` 约束单页 4 Mi 像素、单文档全部画布 16 Mi 像素、单边 8192，超限按比例降采样并显示提示。预算覆盖真实 canvas，而不只是页面/译文缓存；LRU 释放离屏 bitmap，滚回时重绘。预算约对应 64 MiB RGBA，**不代表整个 pdf.js、GPU 或浏览器进程内存上限**。缩放、换书、关闭会取消已启动的 RenderTask，未完成的旧代际任务不得再分配画布；无效尺寸直接拒绝。合成样本包括 `/Rotate 90` 与 15000×15000 的 12 页文档，生成命令为 `node tools/make-pdf-samples.mjs`。
