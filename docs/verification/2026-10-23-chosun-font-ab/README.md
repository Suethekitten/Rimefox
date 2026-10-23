# 朝鲜日报韩文 → 中文：字体 A/B 截图

这组截图对应 `tools/e2e-extension.mjs --chosun-live`，用本地假翻译接口，不调用真实付费模型。

文章：

<https://www.chosun.com/economy/industry-company/2026/10/23/ZWDCNVYTJ5AJ3OEPV2PTABG5WA/>

| 文件 | 状态 |
|---|---|
| `chosun-01-korean-source.png` | 未翻译，原文 `chosun-myeongjo, serif` |
| `chosun-02-chinese-adapted.png` | 仅译文，目标文字使用 `"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif` |
| `chosun-03-restored.png` | 关闭翻译，字体壳移除，原文韩文字体恢复 |

验收关注：

- 中文译文的字重、字号、行高、颜色与原文正文一致；
- 中文字形均匀，不再出现部分字粗、部分字细；
- 标题、代码 / 公式、图标和真正的强调文本不被字体壳覆盖；
- 关闭翻译后 `.dt-font`、`data-dt-replaced`、`data-dt-target` 均无残留。

截图中的中文文本由本地假 API 统一填充，仅用于字体渲染 A/B，不代表真实译文内容。

说明：`chosun-myeongjo` 是韩文衬线字体，没有完整中文字形；继续沿用它会让浏览器逐字回退到不同中文字体，正是笔画粗细抖动的来源。因此跨文字系统时优先采用用户实测通过的中文兼容栈，字号、字重、行高、颜色仍从原文继承。
