# 归档

这里放**一次性记录**：审计报告、评估、验证流水、已完成的实施计划。

判断标准：**「现在该怎么做」不在这里**。仓库里其余文档只写现状与流程，历史证据都在本目录和 git 里。

| 文件 | 是什么 | 归档时的版本 |
|---|---|---|
| [2026-10-25-link-reorder-0.12.3.md](2026-10-25-link-reorder-0.12.3.md) | 仅译文同父普通链接的事务化语序重排、边界、固定回放与 QA 交接 | 0.12.3，本地未推送 |
| [2026-10-25-link-order-0.12.2.md](2026-10-25-link-order-0.12.2.md) | 仅译文链接顺序专项：安全失败、录制响应、截图、独立复核与重排研究 | 0.12.2，本地未推送 |
| [2026-10-24-0120-a-b-integration.md](2026-10-24-0120-a-b-integration.md) | A+B 直接合入本地 main 的冲突处理、缺陷修复、联合回归与 QA 交接 | 0.12.0，本地未推送 |
| [2026-10-24-inline-fidelity-0.12.0.md](2026-10-24-inline-fidelity-0.12.0.md) | 行内格式本地开发、独立复核、基线/性能证据与待验收交接 | 0.12.0，本地未推送 |
| [2026-10-24-language-style-context.md](2026-10-24-language-style-context.md) | 自定义目标语言、趣味风格零误触、傲娇猫娘 / 强度、AI 精翻的开发报告与验证证据 | 0.11.7 基线，本地分支未发布 |
| [2026-10-23-glossary-notes.md](2026-10-23-glossary-notes.md) | 可选术语说明、语境首选译法、CSV/JSON 兼容和本地验证记录 | 0.11.6，本地未发布 |
| [2026-10-23-professional-engine-v2.md](2026-10-23-professional-engine-v2.md) | 专业引擎 v2 / JAMA 本地开发报告及链接的精简验证证据 | 0.11.3，本地未发布 |
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
