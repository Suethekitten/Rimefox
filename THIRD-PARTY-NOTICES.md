# 第三方许可证与来源说明

凛狐（Rimefox）自身以 [MIT](LICENSE) 发布。本文件记录项目里实际复用的第三方代码、模型与素材。Chrome 商店包也会随包分发本文件、LICENSE 和 licenses/。

## OneAIFW

- 项目：OneAIFW — <https://github.com/funstory-ai/aifw>
- 版本：`main` @ `74ee556`（评估时）
- 许可证：MIT，Copyright (c) 2025 Funstory.ai Limited
- 许可证全文：[licenses/oneaifw-MIT.txt](licenses/oneaifw-MIT.txt)

### 实际复用的内容

实现位置：[`lib/privacy.js`](lib/privacy.js)；评估与取舍见仓库中的 `docs/AIFW-PRIVACY-EVAL.md`（商店包不包含 docs/）。

| 上游文件 | 复用的内容 | 修改说明 |
|---|---|---|
| `core/aifw_core.zig` | 占位符格式 `__PII_<TYPE>_<n>__`；span 按「分数 → 长度 → 位置」去重；掩码/恢复流程 | 用纯 JS 重写，未使用 Zig/WASM；恢复从「找不到只告警」改为 fail-closed |
| `core/RegexRecognizer.zig` | 邮箱、URL、私钥、助记词等正则与打分思路 | 改写为 JS 正则；电话、银行卡、验证码规则收紧或替换，避免上游的误识别 |
| `tests/test_zh_pii.txt` 等 | 测试用例思路（中英混合、银行账号、占位符格式） | 重新编写测试，未直接复制夹具 |

**未复用**：Zig/WASM 核心、Rust `regex-automata` 静态库、`libs/aifw-js` 打包产物、`onnxruntime-web`、Transformers.js、任何 ONNX 模型、`py-origin` 服务端代码。

### 上游依赖的许可（仅记录，凛狐不随包分发）

| 依赖 | 许可 |
|---|---|
| `regex-automata` / `regex-syntax` | MIT OR Apache-2.0 |
| `@xenova/transformers` | Apache-2.0 |
| `opencc-js` | MIT AND Apache-2.0 |
| `js-sha3` | MIT |
| `onnxruntime-web` | MIT |
| `ckiplab/bert-tiny-chinese-ner` | **GPL-3.0**（因此明确不引入） |
| `funstory-ai/neurobert-mini` | 未公开（Hugging Face 私有） |

## 凛狐自身的第三方依赖

扩展运行时不依赖任何 npm 包、CDN 脚本或远程模型；打包产物只含仓库内的原生 HTML / CSS / JS / PNG。开发期的 Node 只用于本地测试脚本，不进入发布包。

## 商标

YouTube 是 Google LLC 的商标。凛狐与 YouTube、Google 无关联。
