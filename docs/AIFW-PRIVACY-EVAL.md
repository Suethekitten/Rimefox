# OneAIFW 隐私保护能力评估报告

> 评估对象：[funstory-ai/aifw](https://github.com/funstory-ai/aifw)（OneAIFW）
> 评估基线：`main` @ `74ee556`（"Fix typo in entity type from USER_MAME to USER_NAME…"），仓库 1.3 MB / 116 个文件
> 评估目的：判断能否把 OneAIFW 的敏感信息识别、匿名化与恢复能力整合进凛狐 Rimefox（MV3、零构建）
> 结论日期：2025-12（以下体积均为实测字节数，来源 URL 见文末）

---

## 0. 结论摘要

**推荐做法：移植「契约与策略」，不移植「运行时」。**

| 结论 | 说明 |
|---|---|
| ❌ 不直接嵌入 `libaifw.js` / WASM / ORT / NER 模型 | 需要 Zig + Rust + Vite 构建、10 MB 级 WASM、ONNX 模型；与「零构建、轻量」直接冲突 |
| ❌ 不引入上游 NER 模型 | 默认模型 `funstory-ai/neurobert-mini` 在 Hugging Face 上为私有（401），示例 CDN 已 404；公开备选 `ckiplab/bert-tiny-chinese-ner` 是 **GPL-3.0**，不能与 MIT 扩展一起分发 |
| ✅ 复用占位符契约与安全语义 | `__PII_<TYPE>_<n>__` 形式、按 span 掩码、恢复时校验缺失/重复；用纯 JS 重写、约 20–30 KB |
| ✅ 移植正则识别规则 | 邮箱/电话/银行卡/URL/私钥/验证码/密码/助记词的表达式与打分思路，改为 JS 正则并修正上游已知误识别 |
| ⏳ 中文姓名/地址 | 上游正则层也不识别（见 §2.6 官方测试夹具），NER 路径当前不可用；原型先用「标签 + 姓氏」保守规则，并在文档中明确局限 |

**一句话**：OneAIFW 的价值在「先脱敏再发给 LLM、回来再恢复」这套流程和占位符约定；它的实现栈（Zig/WASM + Transformers.js + ONNX）不适合凛狐。我们照搬语义、自己实现纯 JS 版本，既保留可靠性，也不破坏零构建架构。

---

## 1. 上游结构

```
aifw/
├── core/                    Zig 核心：识别器聚合、span 合并、掩码/恢复管线
│   ├── aifw_core.zig        52,680 B：MaskPipeline / RestorePipeline / 导出 ABI
│   ├── RegexRecognizer.zig  15,426 B：各实体类型的静态正则与打分
│   ├── NerRecognizer.zig     7,413 B：接收外部 NER 的 BIO 结果
│   ├── SpanMerger.zig        2,346 B：重叠 span 合并
│   ├── merge_zh_addr.zig    44,635 B：中文地址扩展合并
│   └── recog_entity.zig        819 B：EntityType 枚举（12 类）
├── libs/aifw-js/            JS 绑定（Vite 构建产物才是可分发的 ESM bundle）
│   ├── libaifw.js           39,281 B
│   └── libner.js            13,182 B
├── libs/regex/              Rust 静态库：regex-automata（wasm32-unknown-unknown）
├── browser_extension/       示例扩展：offscreen + WASM + IndexedDB 模型缓存
├── py-origin/               Presidio + LiteLLM 后端（服务端方案）
├── apps/webapp/             Vite 演示站
└── docs/                    aifw-js API、服务 API、中文地址设计
```

核心执行链（`core/aifw_core.zig`）：

1. 各实体类型跑 `RegexRecognizer`（静态正则 + 打分）；
2. 可选 `NerRecognizer` 接收外部 BIO 结果（由 JS 侧 Transformers.js 推理）；
3. `SpanMerger` 排序、去重、按分数过滤（< 0.5 丢弃）；
4. 重叠 span 按「分数高 → 更长 → 更靠前」保留；
5. 逐 span 写出占位符 `__PII_<TYPE>_<serial>__`，同时记录 `entity_id/type/start/end` 元数据；
6. 恢复时按 `entity_id` 重新生成占位符，在返回文本里查找并替换回原文。

---

## 2. 逐模块可行性

### 2.1 `core/aifw_core.zig` — 不能直接运行，语义可复用

- 语言：Zig 0.15.2；构建目标 `wasm32-freestanding`，同时需要 `cargo build --target wasm32-unknown-unknown` 产出 `libaifw_regex.a`。
- 浏览器侧依赖 `WebAssembly.instantiate` + 自定义 `aifw_malloc/free` 内存协议。
- MV3 内容脚本可以跑 WASM，但前提是：WASM 二进制随扩展打包、CSP 加 `wasm-unsafe-eval`、构建链进 CI。
- **判定：不直接复用。提取其占位符格式、span 合并/去重规则、恢复时的查找替换语义，用 JS 重写。**

### 2.2 `core/RegexRecognizer.zig` — 可直接移植为 JS 正则

上游正则清单（`presetSpecsFor`）：

| 类型 | 表达式（节选） | 分数 | 备注 |
|---|---|---|---|
| EMAIL | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | 0.90 | 可直接用 |
| URL | `https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+` | 0.80 | 可直接用 |
| PHONE | `\+?\d[\d -]{7,}\d` | 0.70 | **过宽**：会把银行卡、卡号一起吞掉（见 §2.6） |
| BANK | `\b\d{12,19}\b` | 0.60 | 与 PHONE 竞争，分数低常被压掉 |
| VCODE | `\b\d{4,8}\b` | 0.50 | 误伤年份/数量，阈值刚好卡在过滤线 |
| PASSWORD | `(?i)\bpassword\s*[:=]\s*(\S+)` | 0.40 | 低于 0.5 过滤线，实际上会被丢弃 |
| SEED | `(?i)(seed|mnemonic)\s*[:=]?\s*([a-z]+\s+){11,23}[a-z]+` | 0.70 | 可用 |
| PRIVKEY | PEM 块 / 64 位 hex | 0.95 / 0.75 | 可用 |

- `regex-automata` 与 JS `RegExp` 语法基本兼容（`(?i)` 行内标志现代 JS 支持），但上游用 C ABI 编译，不能直接搬到浏览器。
- **判定：移植表达式与分数，按 JS 能力重写；PHONE/BANK/VCODE 需要按凛狐场景收紧，不要照抄缺陷。**

### 2.3 `libs/aifw-js/libaifw.js` — 不能直接运行

- 顶部 `import { sha3_256 } from 'js-sha3'`，运行期 `await import('opencc-js')`；裸模块说明符在原生 ESM 里无法解析，必须经 Vite/Rollup 打包。
- `loadAifwCore()` 通过 `fetch(new URL('./wasm/liboneaifw_core.wasm', import.meta.url))` + `WebAssembly.instantiate` 加载核心；`libner.js` 再加载 `@xenova/transformers`、ORT wasm 与 ONNX 模型。
- 还要校验 SHA3-256 资源哈希（`assets/oneaifw_assets_hashes.json`）。
- **判定：不直接复用。其 `maskText/restoreText` 的入参、返回 `[maskedText, Uint8Array meta]` 契约可以作为我们 JS API 的参照。**

### 2.4 `libs/aifw-js/libner.js` — 需要模型与推理运行时

- 依赖 `@xenova/transformers` 2.17.2（Apache-2.0），内部带 `onnxruntime-web`。
- 实测 ORT wasm：`ort-wasm-simd.wasm` **10,014,674 B（9.55 MiB）**，`ort-wasm-simd-threaded.wasm` **9,960,821 B（9.50 MiB）**。
- 模型：默认 `funstory-ai/neurobert-mini` 在 HF 返回 401；示例 CDN `s.immersivetranslate.com/.../20250926/` 已 404。公开的 `ckiplab/bert-tiny-chinese-ner` 提供 `pytorch_model.bin` 45,891,063 B（43.8 MiB，还需转 ONNX/量化），**license 为 GPL-3.0**。
- 多线程还需要 COOP/COEP（`crossOriginIsolated`），示例扩展为此强制 `navigator.hardwareConcurrency = 1` 规避 importScript 问题。
- **判定：不引入。既无法复现资产，也有 GPL 污染风险与 10 MB+ 体积。**

### 2.5 `browser_extension/` — 架构参考，不采纳

示例扩展的做法与代价：

| 做法 | 代价 |
|---|---|
| 新增 `offscreen` 权限 + offscreen document 跑 WASM | 凛狐目前不申请该权限；增加审核面 |
| CSP `script-src 'self' 'wasm-unsafe-eval'` | 需修改 manifest CSP，商店审核需解释 |
| COOP `same-origin` / COEP `require-corp` | 可能影响宿主页面/嵌入资源，扩展页内也会限制跨源 |
| `web_accessible_resources` 暴露 vendor bundle 与 wasm | 页面可探测/加载扩展资源 |
| 首次安装从远端下载模型进 IndexedDB | 远程代码/远程资产合规风险；离线不可用 |
| 选区右键 → 复制脱敏文本 | 仅覆盖「手动复制」场景，不是翻译管线 |

- **判定：只借用「脱敏在本地、映射不落盘」的思路；权限与运行时一律不照搬。**

### 2.6 官方测试夹具暴露的上游局限

`tests/test_zh_pii.anonymized.expected.txt` 的期望输出里：

- 银行卡号 `1234 5678 9012 3456`、Visa 卡号 `4242-...` 都被标成 `__PII_PHONE_NUMBER_n__`（PHONE 正则吞掉了 BANK 的结果）；
- 姓名「约翰·A·杜」、公司「宏信科技」、地址「北京市朝阳区…」**完全未脱敏**；
- 验证码、密码、助记词同样未脱敏（分数低于 0.5 或格式不匹配）。

这说明：**纯正则层本身就只覆盖邮箱/电话/URL/私钥等强格式数据**；姓名、地址靠 NER，而 NER 资产当前不可得。凛狐 MVP 必须如实按这个边界承诺能力。

### 2.7 `py-origin/`、`cli/python/`、`apps/webapp`

- Presidio/LiteLLM 服务端与 Python CLI：需要常驻服务、Python 依赖（transformers/onnxruntime），与「扩展本地运行」目标不符。
- Web 演示站：Vite + COOP/COEP 服务器，仅作交互参考。
- **判定：不采纳。**

---

## 3. 五个重点问题的结论

### 3.1 哪些代码可以在 MV3 扩展中直接运行？

**几乎没有可直接运行的模块。** 可复用的是「知识」而非「文件」：

- 正则表达式与打分（需改写为 JS）；
- 占位符格式 `__PII_<TYPE>_<n>__`；
- span 排序/去重/过滤规则；
- 恢复时的「重新生成占位符 → 查找 → 替换」流程；
- 「映射仅存内存、不落盘、不发第三方」的安全边界。

### 3.2 哪些模块需要 WASM、构建工具或额外模型？

| 模块 | 需要 |
|---|---|
| `core/aifw_core.zig` | Zig 0.15.2；WASM 目标；Rust `regex-automata` 静态库 |
| `libs/aifw-js/libaifw.js` | Vite 打包（裸导入）、WASM fetch、SHA3 校验 |
| `libs/aifw-js/libner.js` | Transformers.js + onnxruntime-web + ONNX 模型 |
| `browser_extension/` | vendor bundle、wasm 资源、模型下载/IndexedDB、offscreen、COOP/COEP |
| `py-origin` / CLI | Python 3.10+、transformers、onnxruntime、Presidio、LiteLLM |

### 3.3 哪些代码可以独立提取、保持零构建？

可以，且只需一个 ESM 文件：

- 邮箱/电话/身份证/银行卡/URL/私钥等**强格式识别器**（纯 JS 正则 + 校验位）；
- 占位符生成与替换；
- 恢复校验（缺失、重复、改写、未知占位符）；
- 失败即拒绝输出（fail-closed）策略；
- 与 `background.js` 的单点接入（翻译请求前 mask、响应后 restore）。

实测：模块源码 **12,823 B**（`lib/privacy.js`），加上设置页 / 文案 / 配置 / 管线改动，打包前净增 **21,817 B**；不新增权限、不新增资源文件。

### 3.4 许可证与第三方依赖

| 对象 | 许可 | 结论 |
|---|---|---|
| OneAIFW 仓库代码 | **MIT**，Copyright (c) 2025 Funstory.ai Limited | 兼容；复用需保留版权与许可文本 |
| `regex-automata` / `regex-syntax` | MIT OR Apache-2.0 | 不随本方案分发（未使用） |
| `@xenova/transformers` | Apache-2.0 | 不引入 |
| `opencc-js` | MIT AND Apache-2.0 | 不引入 |
| `js-sha3` | MIT | 不引入 |
| `onnxruntime-web` | MIT | 不引入 |
| `ckiplab/bert-tiny-chinese-ner` | **GPL-3.0** | **不可随 MIT 扩展分发** |
| `funstory-ai/neurobert-mini` | 未公开（HF 私有） | 不可用 |

**合规动作**：新增 `THIRD-PARTY-NOTICES.md` 与 `licenses/oneaifw-MIT.txt`，在 `lib/privacy.js` 头部注明衍生来源与修改说明。

### 3.5 对体积、性能、内存、权限、商店审核的影响

| 维度 | 直接嵌入上游 | 本方案（纯 JS） |
|---|---|---|
| 安装包体积 | +10 MB（ORT wasm）× 1–2，另加模型（数十 MB，或首次下载） | **+约 20–30 KB 源码** |
| 首次使用 | 下载/解压模型，首次推理慢 | 无额外下载，毫秒级正则扫描 |
| 内存 | ORT + 模型常驻数十 MB | 每批文本临时字符串，KB 级 |
| CPU | 每段一次 tokenizer + ONNX 推理 | 每段一次正则扫描（可忽略） |
| 新权限 | `offscreen`（+ CSP/COOP/COEP 变更） | **无** |
| 商店审核 | WASM 必须打包；远程模型下载属高风险；CSP 需说明 | 无新增审核面 |
| 离线可用 | 依赖模型缓存 | 完全离线 |

---

## 4. 推荐复用清单

| 复用内容 | 源码路径 | 做法 | 难度 | 风险 | 预计体积 |
|---|---|---|---|---|---|
| 占位符契约 | `core/aifw_core.zig` `writePlaceholder` | 照搬 `__PII_<TYPE>_<n>__` | 低 | 模型可能改写/拆分占位符 | <1 KB |
| 邮箱规则 | `core/RegexRecognizer.zig` `EMAIL_SPECS` | 移植 + 边界收紧 | 低 | 误识别极少 | <0.5 KB |
| 电话规则 | `PHONE_SPECS` | **重写**：按国家/长度/分隔符约束 | 中 | 上游过宽，会吞卡号 | ~1 KB |
| 银行卡/身份证 | `BANK_SPECS` + 校验位 | 移植思路 + Luhn/GB 11643 校验 | 中 | 需要校验位避免误伤 | ~1.5 KB |
| URL/私钥规则 | `URL_SPECS` / `PRIVKEY_SPECS` | 视需要启用 | 低 | 长 URL 可能被误伤 | ~1 KB |
| span 合并/去重 | `aifw_core.zig` `dedupOverlappingSpans` | 重写为 JS | 低 | 重叠优先级需测试 | ~1 KB |
| 恢复流程 | `RestorePipeline.run` | 重写 + 严格校验 | 中 | 占位符丢失/重复 | ~3 KB |
| 失败语义 | 上游「找不到占位符仅告警」 | **改为 fail-closed** | 低 | 与上游行为不同，需文档说明 | — |
| 中文姓名/地址 | `NerRecognizer.zig` / `merge_zh_addr.zig` | **暂不复用**（模型不可得） | 高 | 误识别/漏识别 | 0 |

---

## 5. 原型设计（第二阶段）

### 5.1 范围

- 新增 `lib/privacy.js`（纯 ESM、无依赖、零构建）。
- 支持实体：`EMAIL`、`PHONE`、`ID_CARD`（18 位校验）、`BANK_CARD`（Luhn）、`USER_NAME`（仅标签/自我介绍等保守场景）。
- 默认关闭；开关与分项在设置页「隐私保护」分组。
- 仅接入 `background.js` 的 `translate` 路由：整页、划词、弹窗、YouTube 字幕、术语表、自定义提示词都走这一条，天然全覆盖。

### 5.2 数据流

```
content/popup/subtitles
        │  type: 'translate' (原文)
        ▼
background.handleTranslate
        │  ① 缓存查找（本地，用原文）
        │  ② privacy.maskTexts(texts)  →  { masked, map, tokensByText }
        ▼
   provider.chat（只收到占位符文本）  ← 映射不上行
        │  ③ parseArray
        ▼
privacy.restoreTexts(parsed, map)  →  { ok, text } | { ok:false, reason }
        │  ④ 只有恢复成功才写缓存、回填
        ▼
content 注入译文（原文敏感信息完整还原）
```

- 映射对象只在本次请求的闭包里存活，返回前丢弃；不写 `chrome.storage`、不进日志、不进缓存。
- 缓存键仍是原文；缓存值是「恢复后的译文」，与关闭隐私时一致。
- 一个文本恢复失败 → 该条返回 `null`（与网络失败同语义），内容脚本按失败处理，不注入半截内容。

### 5.3 恢复安全策略

| 情况 | 处理 |
|---|---|
| 占位符完整、次数一致 | 还原 |
| 占位符缺失（模型漏掉） | 该条判失败，不输出译文 |
| 占位符重复（模型重复了同一实体） | 全部还原为同一原文 |
| 占位符被改写（空格/大小写/全角下划线） | 容错匹配后还原 |
| 出现映射表外的占位符 | 该条判失败 |
| 未启用隐私 / 无实体 | 原样返回，零开销路径 |
| 原文本身含 `__PII_` | 跳过本批脱敏并记录原因，避免歧义 |

### 5.4 明确不做

- 不引入 WASM/ORT/ONNX/模型；不新增权限；不申请 `offscreen`；不改 CSP。
- 不做地址、机构、密码、助记词的自动识别（误识别代价高，留待后续）。
- 不把映射写进缓存、配置、导出文件或诊断信息。
- 不改变隐私关闭时的任何行为。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 模型改写占位符 | 无法恢复 | 容错匹配 + fail-closed；测试覆盖 |
| 模型把占位符翻译成自然语言 | 无法恢复 | 判失败；提示词中不解释占位符语义 |
| 正则误识别（把订单号当电话） | 译文丢失数字/被替换 | 校验位 + 长度/上下文约束；可关闭分项 |
| 中文姓名/地址漏识别 | 隐私承诺不完整 | 文档明确边界；默认不宣传 |
| 占位符影响翻译质量 | 语序/搭配变化 | 使用短占位符；上线前人工对比 |
| 映射被日志带出 | 泄露 | 不打印原文；debug 日志脱敏 |

---

## 7. 验收标准

1. 关闭隐私时，单元测试与自检页结果与改动前一致（默认行为不变）。
2. 中文、英文、中英混合文本的邮箱/电话/身份证/银行卡全部脱敏。
3. 正常响应可 100% 还原；缺失/重复/改写/未知占位符均按上表处理。
4. 翻译请求体中不出现原始敏感值（可用假 provider 断言）。
5. 映射不进入 `chrome.storage`、缓存、日志、导出。
6. `for f in test/*.test.mjs; do node "$f"; done` 全绿；`selftest/index.html` 全过。

---

## 8. 原型实测（`feat/aifw-privacy` 分支）

### 8.1 体积

| 项目 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| Store ZIP（`tools/package-store.mjs`） | 235,861 B | 244,441 B | **+8,580 B（+3.64%）** |
| 打包文件数 | 49 | 50 | +1（`lib/privacy.js`） |
| 其中脱敏模块源码 | — | 12,823 B | 压缩后约 5.8 KB |
| 配置 / 设置页 / 文案 / 管线 | — | +8,994 B | 主要是设置页分区与中英文文案 |

> 实测中发现并修复了打包脚本的一个排除规则 bug：`PRIVACY.*` 会把 `lib/privacy.js` 当成隐私文档一起排除，导致发布包里缺模块。已改为只排除 `PRIVACY.md` 等具体文档，并在 `test/package-store.test.mjs` 里加了「`lib/privacy.js` 必须在包里」的断言。

### 8.2 性能

基准脚本：`tools/bench-privacy.mjs`（1,440 段 / 52,774 字符 / 620 个唯一占位符，25 轮平均）：

| 阶段 | 单轮耗时 |
|---|---|
| 识别 + 脱敏 | 1.54 ms |
| 恢复 | 0.56 ms |
| 合计 | **2.10 ms**（约 0.04 µs/字符） |

按每批 12 条估算，单批开销约 17 µs，相对一次网络往返可忽略。内存只有每批的临时字符串与映射，KB 级；无 WASM、无模型常驻。

### 8.3 测试结果

| 测试 | 条数 | 结果 |
|---|---|---|
| `test/privacy.test.mjs` | 27 | 全绿 |
| `test/privacy-pipeline.test.mjs`（假 chrome + 假 fetch 驱动 `background.js`） | 13 | 全绿 |
| 其余 11 个既有单测（含 `package-store`） | — | 全部通过 |

管线测试直接断言：

- 关闭隐私时，请求体就是原文（默认行为不变）；
- 开启后请求体不含邮箱 / 电话 / 身份证 / 银行卡原文；
- 回包后完整还原；
- 占位符丢失、映射表外占位符 → 该条 `null`，不输出半截译文；
- 模型重复同一占位符 → 两处都还原；
- 整页 / 划词 / 字幕 / 弹窗四个入口都走同一个 `translate` 路由；
- 术语表、自定义提示词照常进入提示词；
- 拆批后每批各自脱敏、各自还原；
- 第二次请求命中缓存，且缓存与 `chrome.storage` 里没有占位符或映射。

### 8.4 误识别情况（已覆盖的负例）

以下文本在测试中**不会**被脱敏：`2024-01-15`、`2024/01/15`、`12:34:56`、`1.2.3.4`、`1234567890123`（14 位以内订单号）、`192.168.1.1`、`110105194912310021`（校验位错误）、`编号 1234 5678 9012 3456`（无标签且 Luhn 不通过）、`联系人：客服中心`、`我是中国人`。

仍存在的边界：真实中文姓名 / 地址 / 机构名不识别；未加标签的银行账号不识别；英文姓名只在 `Name:` 标签下识别；模型对占位符的改写方式无法穷举，认不出时按失败处理。

### 8.5 未验证项（诚实清单）

- 没有用真实网页、真实 YouTube 字幕和真实模型跑端到端；验证依赖单元测试与假接口的管线测试。
- 没有在真实 Chrome 里加载本分支的设置页做交互验证。
- 没有测量真实模型看到占位符后的翻译质量变化（语序、专名一致性）。
- 没有做 Chrome Web Store 审核预检（本方案未新增权限与资源，风险面小，但仍需发版前人工过一遍）。

## 9. 参考来源

- 仓库：<https://github.com/funstory-ai/aifw>（MIT，Copyright (c) 2025 Funstory.ai Limited）
- 占位符与管线：`core/aifw_core.zig`；正则：`core/RegexRecognizer.zig`；实体枚举：`core/recog_entity.zig`
- JS 绑定：`libs/aifw-js/libaifw.js`、`libs/aifw-js/libner.js`、`libs/aifw-js/package.json`
- 示例扩展：`browser_extension/`（README、manifest、background.js、offscreen.js、aifw-extension-sample.js）
- 测试夹具：`tests/test_zh_pii.txt`、`tests/test_zh_pii.anonymized.expected.txt`、`tests/test_en_pii.txt`
- 资源哈希：`assets/oneaifw_assets_hashes.json`
- 模型：<https://huggingface.co/funstory-ai/neurobert-mini>（401）、<https://huggingface.co/ckiplab/bert-tiny-chinese-ner>（GPL-3.0）
- ORT wasm 体积：<https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/ort-wasm-simd.wasm> 等（实测 `Content-Length` 下载字节数）
