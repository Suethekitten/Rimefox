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

## Liquid Glass Slider

- 项目：Liquid Glass Slider — <https://github.com/Saknutella/liquid-glass-slider>
- 作者：Sak（GitHub [@Saknutella](https://github.com/Saknutella)）
- 版本：`main` @ `4ac99f2`（2026-10-21，上游 package.json 3.0.0）
- 许可证：MIT，Copyright (c) 2026 Liquid Glass Slider contributors
- 实际复用位置：[lib/liquid-glass/](lib/liquid-glass/)（`filter.js` / `material.js` / `dock.js` / `nav.js` / `geometry.js`）、[popup/popup.css](popup/popup.css) 的 `.foot` / `.glass-dock__*` 样式，以及 [options/options.css](options/options.css) 的 `.nav` / `.glass-nav__*` 样式

### 实际复用的内容

| 上游文件 | 复用的内容 | 修改说明 |
|---|---|---|
| `glass-filter.js` | 位移贴图与三通道色散（R/G/B 依次错开 2cab / 1cab / 0）的 SVG 组织 | 改成 ESM，去掉全局 `window`；参数与滤镜结构保留 |
| `glass-material.js` | 每个实例独立滤镜 id、按尺寸重建、WebKit / 减少透明降级 | 改成 ESM `createGlassMaterial()`，并新增 `ensureGlassFilter()` 给设置页开关 / 排版滑块共用 30×20、弹窗小开关 20×14 的固定滤镜；接入「减少透明」 |
| `liquid-glass.js` | 槽位几何、弹簧积分、拖动 / 回弹 / 放大、`requestAnimationFrame` 调度 | 弹窗改成命令工具坞（没有常驻选中项，透镜跟随 hover / 焦点，拖动不提交命令）；设置页改成竖向导航（透镜跟随当前分组 / 悬停）；滑块透镜复用同一套折射 |
| `liquid-glass.css` | 底座 / 透镜的图层顺序与材质参数 | 用 `lib/ui-tokens.css` 的变量重写为 54px 高的弹窗工具坞、220px 宽的设置页导轨和 30px 的滑块透镜 |

**未复用**：`liquid-glass-slider.standalone.html`、`dist/` 构建产物、示例页与预览素材。扩展里没有引入任何第三方运行时依赖，仍是零构建。

### 上游算法的来源

Liquid Glass Slider 的位移贴图与三通道色散又改编自 [nikdelvin/liquid-glass](https://github.com/nikdelvin/liquid-glass)（MIT，Copyright (c) 2025 Nikita Stadnik），上游修订 `49251869805a117db87c70998e3f7b83719c690e`。两份 MIT 许可全文如下。

```text
MIT License

Copyright (c) 2026 Liquid Glass Slider contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
MIT License

Copyright (c) 2025 Nikita Stadnik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 凛狐自身的第三方依赖

扩展运行时不依赖任何 npm 包、CDN 脚本或远程模型；打包产物只含仓库内的原生 HTML / CSS / JS / PNG。开发期的 Node 只用于本地测试脚本，不进入发布包。

## 商标

YouTube 是 Google LLC 的商标。凛狐与 YouTube、Google 无关联。
