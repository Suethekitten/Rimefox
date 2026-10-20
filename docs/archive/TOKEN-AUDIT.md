> **已归档** —— 这是一次性记录（中日翻译 Token 消费审计（0.8.x）），不是「现在怎么做」。
> 内容反映归档当时的状态，可能已经过期。现状见 [STORE](../STORE.md)、[ROADMAP](../ROADMAP.md)、[HANDOFF](../../HANDOFF.md)。

# 中日翻译 Token 消耗审计

审计日期：2026-10-18（Rimefox 0.8.5 开发基线）
对象：`background.js`、`lib/provider.js`、`lib/engines/*`、`lib/cache.js`、`lib/prompt.js`、`content/main.js`

## 结论摘要

1. **「日译中 32 段 / 中译日 55 段」首先是单元计数差异，不是 token 差异。** 弹窗的「已译 N 段」只统计成功注入 DOM 的单元；「与原文相同 / 空译文」计入 skipped，不算已译。两个方向的跳过规则和相同译文判定本身不同，不能直接横比。
2. **代码里没有按「中→日 / 日→中」分支的计费逻辑。** 切分、组批、缓存键、`maxTokens`、重试、解析全部共用同一条路径。唯一与方向有关的是语言判定 / 跳过与提示词「已是目标语言原样返回」。
3. **真正会放大消耗的是解析失败 → 对半拆批 → 重试 → 部分成功被丢弃。** 一个 n 条批次在条数不匹配时最坏可到 **8n−2 次 HTTP**（n=8 → 62；n=12 → 94）；每次请求都重发系统提示词。
4. **已确认并修复的浪费路径**：拆批时一半失败导致另一半结果被整体丢弃且不缓存；内容脚本 90s 超时早于后台 180s 单请求上限，重试可能和原请求重叠。
5. **没有真实 API Key，因此没有真实 token 数据。** 本轮只做代码路径、受控请求计数与诊断埋点；不编造 token 数或费用。

---

## 一、段数不是 token

- `content/main.js` 的 `translated` 只在 `DT.inject()` 成功时 +1；与原文相同、空译文、失败分别走 `skipped` / `failed`。
- 一个 DOM 单元到计费之间还有：`maxUnitChars` 长段拆分 → 内容脚本 `batchSize / maxCharsPerBatch`（屏幕内更小）→ 后台再切批 → 重试 / 思考二次请求 / 对半拆批。
- 因此「已译 32 段」可能是 20 次请求，也可能是 200 次；必须同时看「与原文相同 / 失败 / 共 N 段」。

## 二、方向不对称的真实来源

| 环节 | 是否按方向分支 | 说明 |
|---|---|---|
| 切分 / 组批 | 否 | 只按字符数；日文同义文本通常更长，每批装得更少、请求更多 |
| 语言跳过 | **是（间接）** | 中→日：源文本无假名，`looksLikeTarget(..., 'ja')` 永远 false，几乎不跳；日→中：汉字-only 短语可能被判「已是中文」而跳过。`jaPageToZh` 只在页面声明 `lang="ja"` 时豁免 |
| 近似重复 | **是（结果驱动）** | 日→中汉字-only 原文与译文相似时计入 skipped；中→日源文本不会被判「已是日语」 |
| 缓存 | 含 target，非方向分支 | 中→日 / 日→中各自独立；默认目标 zh-CN 让日→中更容易有热缓存 |
| maxTokens | 否 | 唯一公式 `min(8000, 512 + 源字符 × 2)`；字符 ≠ token |
| 重试 / 解析 | 否 | 但截断 / 解析失败越多的方向被放大越多 |

正常的语言差异（日文更长、输出膨胀、分词效率、缓存冷热）可以解释大部分差异，**不应为了对齐数字去改算法**。

## 三、拆批放大公式

`translateBatchWithRetry()` 在多条文本条数不匹配时立即跳出重试并递归对半拆：

- 内部节点 n−1 个，每个最多 1 次 chat；
- 叶子 n 个，每个最多 3 次 attempt；
- `chat()` 每次最多 2 个 pass（思考参数 400 / 空 content 截断重试）；
- **HTTP 最坏 = 2 × ((n−1) + 3n) = 8n−2**；典型全成功拆树 = 2n−1。
- 再叠加内容脚本失败退避（最多 4 轮）还会继续放大。

## 四、本轮修复

1. **拆批一半失败不再丢弃另一半**：`translateBatchWithRetry()` 改为顺序拆半；失败一半的项用 `null` 标记，`handleTranslate()` 不缓存 `null`、只把该条记为失败；成功一半照常还原隐私占位符并写缓存。
2. **拆批不再瞬间绕过并发闸门**：两半顺序执行，始终只占父批次已经取得的并发名额。
3. **超时阶梯对齐**：翻译消息 90s → 190s、看门狗 100s → 200s，高于 provider 单请求 180s 总上限，减少后台仍在生成时内容脚本重发。多轮重试仍可能超过 190s，属于剩余风险。
4. **用量诊断**（仅 `debug` 开启）：
   - 三个引擎的 `parseResponse` 提取 usage（OpenAI / Anthropic / Gemini 字段不同，缺失即 unknown）；
   - `provider.chat` 记录实际 HTTP 次数、每次响应 usage、finish_reason；
   - `background.js` 聚合请求数、响应数、输入 / 输出 / 思考 / 缓存 token、缓存命中、重试、拆批、丢弃、失败；
   - `usage:stats` / `usage:reset` 路由读取，默认不记录正文、Key、Prompt 或原始响应。

## 五、受控验证（假接口，数字为请求/字段计数，不是真实 token）

`test/usage-pipeline.test.mjs` 用假 chrome + 假 fetch 驱动真实 `background.js`：

| 场景 | 结果 |
|---|---|
| 2 条正常翻译 | 1 次 HTTP；2 条 usage；输入 20 / 输出 10（假数据） |
| 同文本第二次 | 0 次 HTTP；cacheHits +2 |
| 条数不匹配（2 条 → 1 条） | 3 次 HTTP（1 次失败 + 2 个半批）；splits=1；discarded=1 |
| 拆批一半失败 | 3 次 HTTP；成功一半保留并缓存；失败项 null |
| 服务商不返回 usage | unknownUsageResponses=1；不估算 token |
| debug 关闭 | `usage:stats` 拒绝返回 |

`test/usage.test.mjs` 另验证三协议 usage 字段与统计聚合。

## 六、真实对照验证方案（需要你的 API Key）

1. 同一 provider / model、`thinkingMode=off`、`batchSize=8`、`maxCharsPerBatch=2000`、`maxUnitChars=1200`、`lazy=false`。
2. 选同一项目的 `README.zh.md` 与 `README.ja.md`（或平行语料各 20 段），不要用不同主题页面。
3. 每个方向跑 3 次冷启动（每次前清缓存）+ 2 次热缓存，取中位数。
4. 设置页打开「输出调试日志」，在扩展页面控制台执行：
   ```js
   chrome.runtime.sendMessage({ type: 'usage:reset' }, console.log);
   // 翻一次页后
   chrome.runtime.sendMessage({ type: 'usage:stats' }, console.log);
   ```
5. 记录：请求数、输入 / 输出 / 思考 token、unknown usage、finish_reason 分布、cacheHits / cacheMisses、retries、splits、failed。
6. 派生指标：`tokens / 1000 源字符`、`请求数 / 1000 源字符`、`output / input`、`inputTokens / 总 token`。

判读：

- 两方向 `tokens / 1000 源字符` 差 < 10–15%，finish_reason 基本 stop、拆批少 → 正常语言差异，不改代码。
- 某方向 length 明显偏多或拆批多 → 查 `maxTokens` 与批次大小。
- 请求数差异远大于 token 差异 → 问题在请求放大（固定提示词 / 拆批 / 重试），不是语言本身。

## 七、仍未修的项（需要数据或更大改动）

- **并发批次的 in-flight 去重**：同一文本同时出现在两个批次时仍可能各发一次；需要后台按缓存键合并 Promise，且隐私模式下要在还原后的文本层做。
- **maxCharsPerBatch > 3744 时 8000 输出上限**：预算降到 2 token/源字符以下，CJK 输出可能截断；是否加目标语言系数需要真实 finish_reason 数据。
- **单条截断被宽松解析接受**：单条批次可能把半截译文当成成功；需要结合 finish_reason 与 JSON 完整性判断。
- **真实 YouTube / Edge 回归**、**真实模型 token 对照**：本机未完成，未编造结果。

## 八、一句话回答

**中译日 55 段 vs 日译中 32 段不能证明 token 异常。** 段数是成功注入的单元数；代码没有方向计费分支。真正可能放大消耗的是拆批、重试和超时重叠，已修其中两条确凿路径；剩余项需要真实 usage 数据再决定是否改。
