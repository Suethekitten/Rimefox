# 归档

这里放**一次性记录**：审计报告、评估、验证流水、已完成的实施计划。

判断标准：**「现在该怎么做」不在这里**。仓库里其余文档只写现状与流程，历史证据都在本目录和 git 里。

| 文件 | 是什么 | 版本 / 状态 |
|---|---|---|
| [2026-11-05-release-0.17.0.md](2026-11-05-release-0.17.0.md) | 0.17.0 Windows OCR 体验包构建来源、本地验证和草稿发布控制 | 0.17.0，已发布（0.17.1–0.17.5 见 ROADMAP） |
| [2026-11-05-system-ocr-preview.md](2026-11-05-system-ocr-preview.md) | Windows / macOS 系统 OCR 预览实现、安装流程、本机验证、真实扫描质量及未测项；文档双列 / 版式预览回归 | 0.17.0 已发布预览；Windows preview.2 随 0.17.5 待发布，组件未签名 |
| [2026-11-04-ci-matrix-0.16.4.md](2026-11-04-ci-matrix-0.16.4.md) | 0.16.4 发布后 Checks 矩阵 7 项失败的根因与只改测试 / CI 的修复验证 | 0.16.4，不改运行时、不重新发版 |
| [2026-11-04-hardening-0.16.4.md](2026-11-04-hardening-0.16.4.md) | 密钥、异常 EPUB、PDF 资源、升级恢复及验收边界 | 0.16.4，已发布 |
| [2026-11-04-real-model-acceptance.json](2026-11-04-real-model-acceptance.json) | 已配置 DeepSeek/Gemini 的真实译文、格式、对齐回退、400 恢复与 HTTP/Token 统计 | 0.16.4；缺少 Anthropic；不含 Key |
| [2026-11-03-qa-fixes-0.16.3.md](2026-11-03-qa-fixes-0.16.3.md) | 0.16.1 独立 QA 的修复清单、未修项与验证记录 | 0.16.3 验证记录，发布状态见 ROADMAP |
| [2026-11-02-pdf-quality-0.16.0.md](2026-11-02-pdf-quality-0.16.0.md) | PDF 多栏 / 目录 / 公式 / 表格文本质量、阅读器存储拆分、版式切换与渲染稳定性、配置导入清 Key 的验证记录 | 0.16.0 验证记录，发布状态见 ROADMAP |
| [2026-11-01-session-keys-0.15.0.md](2026-11-01-session-keys-0.15.0.md) | 会话密钥、旧 Key 迁移、鉴权暂停、配置同步及真实 Chrome 生命周期验证 | 0.15.0 验证记录，发布状态见 ROADMAP |
| [2026-11-01-pdf-cache-0.14.2.md](2026-11-01-pdf-cache-0.14.2.md) | PDF 缓存语言 / 配置隔离、任务取消与晚归、顶部定位修复；Chrome 假接口与离线验证记录 | 原 0.14.2 候选验证记录，现纳入 0.15.0；发布状态见 ROADMAP |
| [2026-10-31-ocr-candidates.md](2026-10-31-ocr-candidates.md) | 本地 OCR 候选（PaddleOCR.js / Tesseract.js / Scribe.js）的体积、许可与适配性评估；未跑探针、未集成 | 参考记录，2026-10-31；后续系统 OCR 预览见 ROADMAP P2-11 |
| [2026-10-31-epub-reader-0.13.0.md](2026-10-31-epub-reader-0.13.0.md) | 0.13.0 EPUB 阅读与翻译：冻结范围、实现、真实 Chrome / 假接口验证、限制与 QA 交接 | 0.13.0，已发布 |
| [2026-10-27-bilibili-subtitles-0.12.6.md](2026-10-27-bilibili-subtitles-0.12.6.md) | 0.12.6 Bilibili 字幕扩展：架构、Chrome 合成轨道 E2E、测试证据、真实登录态限制与 QA 复测清单 | 0.12.6，已发布 |
| [2026-10-27-bilibili-subtitles-qa-0.12.6.md](2026-10-27-bilibili-subtitles-qa-0.12.6.md) | 0.12.6 哔哩哔哩字幕独立 QA（V1–V15）与修复记录 | 0.12.6 |
| [2026-10-25-0.12.3-release-verification.md](2026-10-25-0.12.3-release-verification.md) | 0.12.3 发布前最终验证：P3 计数修复、全量测试、发布包与发布结果 | 0.12.3，已发布 |
| [2026-10-25-link-reorder-0.12.3.md](2026-10-25-link-reorder-0.12.3.md) | 仅译文同父普通链接的事务化语序重排、边界、固定回放与 QA 交接 | 0.12.3，已发布 |
| [2026-10-25-link-order-0.12.2.md](2026-10-25-link-order-0.12.2.md) | 仅译文链接顺序专项：安全失败、录制响应、截图、独立复核与重排研究 | 0.12.2，已发布 |
| [2026-10-24-0120-a-b-integration.md](2026-10-24-0120-a-b-integration.md) | A+B 直接合入本地 main 的冲突处理、缺陷修复、联合回归与 QA 交接 | 0.12.0，已发布 |
| [2026-10-24-inline-fidelity-0.12.0.md](2026-10-24-inline-fidelity-0.12.0.md) | 行内格式本地开发、独立复核、基线/性能证据与验收交接 | 0.12.0，已发布 |
| [2026-10-24-language-style-context.md](2026-10-24-language-style-context.md) | 自定义目标语言、趣味风格零误触、傲娇猫娘 / 强度、AI 精翻的开发报告与验证证据 | 0.11.7，已发布 |
| [2026-10-23-glossary-notes.md](2026-10-23-glossary-notes.md) | 可选术语说明、语境首选译法、CSV/JSON 兼容和本地验证记录 | 0.11.6，已发布 |
| [2026-10-23-professional-engine-v2.md](2026-10-23-professional-engine-v2.md) | 专业引擎 v2 / JAMA 本地开发报告及链接的精简验证证据 | 0.11.3，已发布 |
| [STORE-READINESS.md](STORE-READINESS.md) | Chrome 商店上架审计与「差哪 5 项」 | 0.8.5 |
| [STORE-VALIDATION.md](STORE-VALIDATION.md) | 每次上架材料验证的流水记录 | 0.7.1–0.8.5 |
| [STABILITY-AUDIT-0.9.2.md](STABILITY-AUDIT-0.9.2.md) | 稳定性 / 性能 / 恶性 bug 审计 | 0.9.2 |
| [TOKEN-AUDIT.md](TOKEN-AUDIT.md) | 中日翻译 token 消耗审计 | 0.8.x |
| [AIFW-PRIVACY-EVAL.md](AIFW-PRIVACY-EVAL.md) | OneAIFW 隐私方案评估（结论已实现于 `lib/privacy.js`） | 0.7.1 |
| [2026-10-20-docs-and-dedup.md](2026-10-20-docs-and-dedup.md) | 2026-10-20 的文档去重 + 代码去重交接记录（谁去哪了、什么没做） | 0.9.8 |
| [2026-10-19-dom-translation-units-plan.md](2026-10-19-dom-translation-units-plan.md) | DOM 单元模型重构的实施计划（已发布） | 0.9.1 |

归档规则：

- 只归档**已经结束、不再更新**的内容；还在维护的东西不许进来
- 归档前在本目录 README 加一行，写清「是什么 / 哪个版本」
- 归档文档顶部加「已归档」横幅，并指向当前的权威文档
- 相对链接要按新层级修好（从 `docs/archive/` 出发：`../../` 到仓库根，`../` 到 docs）
