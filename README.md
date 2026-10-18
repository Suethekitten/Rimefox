# DualTrans 双语对照翻译

> 交接开发请看 **[HANDOFF.md](HANDOFF.md)**（架构、消息协议、踩坑清单、调试方法、路线图）。
> 版本历史见 **[CHANGELOG.md](CHANGELOG.md)**；架构与取舍见 **[docs/DESIGN.md](docs/DESIGN.md)**。
> 打包给他人：双击 `package.bat`，或右键本文件夹 → 压缩。

在 Edge 里自建的双语网页翻译扩展：**只用你自己的 API Key**，不接任何第三方免费端点，不向作者服务器发送任何内容。

- 整页双语对照翻译（原文 + 译文分层显示）
- 支持任意 OpenAI 兼容接口：DeepSeek / 智谱 / 硅基流动 / 通义 / 自建网关
- 先翻眼前这屏；远处的内容滚到附近再翻（长页面省钱，可在设置里关掉）
- 动态内容补翻（MutationObserver）、SPA 路由切换自动重翻
- 批量合并请求 + 并发控制 + LRU 缓存 + 429/5xx 自动重试（省 token、防限流）
- 4 种译文样式、双语 / 仅译文切换、Alt+A 一键开关
- 零构建：纯原生 ESM，不需要 npm / webpack，直接加载即可

## 安装（开发版）

1. 打开 Edge，地址栏输入 `edge://extensions/`
2. 打开左下角「开发人员模式」
3. 点「加载解压缩的扩展」，选择本目录 `edge-bilingual`
4. 首次加载会自动弹出设置页；填好 API 地址 / Key / 模型，点「测试连接」
5. 打开任意网页，点工具栏图标或按 `Alt+A` 翻译；再按一次还原原文

## 目录结构

```
edge-bilingual/
├── manifest.json          MV3 清单
├── background.js          service worker：翻译中枢、并发闸门、缓存、重试
├── lib/
│   ├── config.js          配置项与读写（chrome.storage.local）
│   ├── provider.js        OpenAI 兼容接口客户端
│   └── cache.js           LRU 翻译缓存
├── content/
│   ├── core.js            命名空间、文本工具、提示条
│   ├── dom.js             段落切分、译文注入、还原
│   ├── main.js            调度：开关、批处理、动态补翻、快捷键
│   └── styles/inject.css  译文样式与主题
├── popup/                 工具栏面板
└── options/               设置页
```

## 关键设计

**段落切分**：从 `body` 起递归，只下钻到「块级且包含文本」的子节点；没有块级子节点的元素视为一个翻译单元（`content/dom.js` 的 `walk`）。跳过 `code/pre/script/textarea/[contenteditable]/notranslate/aria-hidden` 以及隐藏元素。

**长文本**：单段超过 `maxUnitChars`（默认 1200）按句末标点切开，分批翻译后拼回同一个注入点，避免一次请求过大。

**结构安全**：`p/h*/div` 这类元素把译文插在后边（`afterend`）；`li/td/th/blockquote/figcaption` 或父容器是 flex/grid 时改为追加到内部，避免破坏列表与网格布局。

**省钱**：条数 + 字符数双阈值合批；同语言跳过；后台 LRU 缓存命中直接返回；并发跟设置走（默认 6）；默认只翻屏幕附近的内容，没滚到的不花钱。

**隐私**：API Key 存在 `chrome.storage.local`，并收紧为只有扩展自身（background / 设置页）可读（`setAccessLevel`，浏览器不支持时跳过）。content script 拿到的配置里没有 Key，只有 `hasKey`，翻译通过消息交给 background 发请求；页面 JS 无法接触 Key。

## 已知限制（v1）

- 不支持 PDF / EPUB / 视频字幕 / 图片 OCR —— 这几项各自是独立大工程，需要另开项目
- 没有做行内标签级结构保真（例如段落里的 `<b>`、`<a>` 文字会被整段重写）；正文翻译够用，代码/富文本站点效果一般
- 没有内置站点规则库，个别重前端站点可能需要后续补 `selectors`
- 没有图标文件，Edge 会显示默认占位图标
- 未做 i18n，界面固定中文

## 后续路线

1. 行内标签保真：给文本节点打占位标记，要求模型保留标记并按标记回填
2. 站点规则：`matches / textSelectors / excludeSelectors` 配置化
3. 划词 / 鼠标悬停 / 输入框翻译
4. PDF：pdf.js 文本层 + 排版重建
5. 术语表与提示词自定义

---

## 声明

本项目为**独立实现**，不含任何第三方产品的代码、图标或文案，与任何商业产品无关联。

所有翻译请求都发往**你自己配置的接口**，不经过本项目作者的服务器；API Key 只保存在本机浏览器的 `chrome.storage.local` 中。

## 许可

[MIT](LICENSE)

