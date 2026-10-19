# Chrome Web Store 截图

这组截图按 Chrome Web Store 的 1280×800 规格生成（2026-10-18，对应 Rimefox 0.8.2），可直接作为商店素材候选。

| 文件 | 内容 | 建议顺序 |
|---|---|---|
| `store-01-fullpage-light.png` | 整页双语对照（浅色文章） | 1 |
| `store-02-fullpage-dark.png` | 整页双语对照（深色文章，译文颜色自动适配） | 2 |
| `store-05-selection.png` | 划词翻译气泡（含置顶 / 复制按钮） | 3 |
| `store-03-options-privacy.png` | 设置页「隐私保护」分区 | 4 |
| `store-04-options-glossary.png` | 设置页术语表 | 5 |

## 截图环境

- 浏览器：Chrome for Testing 155（macOS arm64，headless）
- 扩展：从 `dist/Rimefox-v0.8.2-store.zip` 解包后加载，未修改代码
- 页面：本地演示文章（`127.0.0.1`），非真实网站
- 翻译接口：本地 OpenAI 兼容测试端点，返回为本演示页人工撰写的示例译文；未使用任何真实 API Key，也没有向真实服务商发请求
- 分辨率：全部 1280×800；未放大、未拼接、未伪造界面

## 重要说明

截图里的**界面、交互、双语排版、划词气泡、设置页都是真实扩展**；但文章正文与译文是为演示准备的内容，不是某个真实模型 / 服务商的实际输出。

商店审核通常接受这种「真实界面 + 示例内容」的截图；如果你希望截图里的译文来自你自己的服务商，可以用真实 API Key 重新截图，步骤：

1. 加载 `dist/Rimefox-v0.8.2-store.zip`
2. 在设置页配置你的服务商、Key 和模型
3. 打开一篇普通英文文章，按 `Alt+A` 翻译，再按需要截整页 / 划词 / 设置页
4. 截图时隐藏 Key、个人页面和账号信息

这组 PNG 不在商店包里（`docs/` 被 `tools/package-store.mjs` 排除），只作为仓库素材。

## 校验

```
b6b056699afdd8712febefed44ae6f77ad9e248a555a53deca6583cdb3ea5e56  store-01-fullpage-light.png
89e6743a8229c416ebf4c4c7a2112bf81231e29e4fe75e7ab5f28298a7ef4a6a  store-02-fullpage-dark.png
e9a11a21b1e2ee82b3441fdf6a77025e6185911900e1038168d5556d6293eeab  store-05-selection.png
f003fdd5ec1d90d3f82b70be847d09f63af6cd67f5f014bc981d23188c0cdbb7  store-03-options-privacy.png
5c4712ef030f4f9bd52b47c8ba830ffc5988fff8f8aba78dcd783aeebc32c1e8  store-04-options-glossary.png
```
