# 0.13.0 EPUB 阅读与翻译 — 开发与验证交接

> 一次性记录。当前架构、接口与限制以 [docs/READER-ARCHITECTURE.md](../READER-ARCHITECTURE.md) 和 [HANDOFF.md](../../HANDOFF.md) §4.6 / §14 为准。

## 范围

0.13.0 新增本地 EPUB 阅读器与按需翻译，复用现有翻译引擎，不新增 Provider、不新增浏览器权限。

冻结决定：

- 独立 `reader/index.html` 全标签页阅读器；弹窗入口；文件选择 / 拖拽。
- 本地书库、封面 / 元数据 / 目录 / 进度；无高亮、批注、云同步。
- 可重排 EPUB 2/3；拒绝 DRM、固定版式、音频 / 视频、脚本、远程资源和表单；纯字体混淆允许但不加载出版字体。
- 一次一个 spine section，章内滚动；进度为 section + offsetRatio。
- 自动只翻当前视口 + 后 2 屏；接近章末时预取下一章开头；手动「翻译本章」翻当前 section；不自动整本。
- 打开按书记住原文 / 双语 / 仅译文；恢复双语时只翻当前视口。
- 行内 b/strong、i/em、u、s、sup/sub、普通链接、脚注引用、br 保留；pre/code 保留不翻；复杂结构降级纯文本。
- 原书 / 进度 / 译文只在本机 IndexedDB；单本约 100 MB、书库约 500 MB；删除书清理全部。
- PDF 只留 `BookDocument` / `DocumentAdapter` 接口，不实现、不引入 pdf.js。

## 实现

| 文件 | 作用 |
|---|---|
| `reader/index.html` / `reader.css` / `reader.js` | 阅读器 UI、书库、目录、章节、脚注、设置 |
| `lib/reader/epub.js` | ZIP → container.xml → OPF → spine/nav；DRM / 固定版式 / 路径穿越 / 压缩比限制 |
| `lib/reader/sanitize.js` | XHTML allowlist 清洗、图片 Blob、内部链接、脚注标记 |
| `lib/reader/store.js` | IndexedDB 书库 / 进度 / 译文 / 失败 / 设置 / 删除 |
| `lib/reader/translate.js` | 可见范围队列、手动本章、取消代际、reader 缓存、`DT.collect` / `DT.inject` |
| `lib/vendor/fflate.browser.mjs` | fflate 0.8.2（MIT），仅同步解压 |
| `docs/READER-ARCHITECTURE.md` | 唯一接口契约（含 PDF 预留） |

翻译没有复制引擎：阅读器页面加载 `content/core.js`、`units.js`、`direction.js`、`dom.js`，由 `dom.js` 做收集 / 行内注入；阅读器只负责文档与队列。发送 `noCache: true`，避免书籍正文进入现有 512 KB 全局缓存。

## 验证

- `test/reader-contract.test.mjs`：静态契约 / 权限 / 资产 / 文档 token，通过。
- `test/reader-smoke.html`：真实 Chrome 解析 / 清洗 / 图片 / 链接 / 目录 / DRM / 固定版式 / 路径穿越，冒烟通过。
- `tools/e2e-reader.mjs`：真实扩展 + 真实 reader 页 + 真实 IndexedDB + 本地假 API；覆盖导入、书卡、目标语言切换、章节、目录、图片、脚本清除、脚注浮层、原生链接、双语注入、行内粗体/链接、缓存命中、模式记忆、原文恢复、原文状态点「翻译本章」、章末预取下一章、删除清理，17 / 17 通过。
- 全量 Chrome E2E：296 / 296；自检页 269 / 269；全量 Node 测试通过。
- 完整 E2E 使用本地假接口，不调用付费模型。

> 阅读体验参考了 [ColorTxt](https://github.com/ssnangua/ColorTxt)（MPL-2.0，Electron 阅读器）的字体/排版、书库/进度、目录、主题和全屏思路；没有复制其代码。

## 限制 / 后续

- 真实大型出版社 EPUB、真实移动端、真实多语言 RTL fixture 仍需独立 QA。
- 固定版式、漫画、音频 / 视频、PDF、MOBI/AZW3、DRM、OCR、云同步、高亮 / 批注、完整屏幕阅读器审计不在 0.13.0。
- 下一章开头预取只覆盖前 12 个单元；更长的预取不自动扩散，超出部分切章后按需翻译。
- 不保证所有 EPUB 的出版社 CSS；0.13.0 归一化阅读排版。
- 字体由用户自行上传，扩展不提供字体文件；用户需确认字体授权。字体上传路径已在开发中的临时 E2E 验证过，最终 E2E 未保留该步骤（避免依赖本机字体文件）。

## 打包 / 结果

0.13.0 商店包与 Release 包由 `tools/package-store.mjs` 生成；reader / lib/reader / fflate / 许可文件都纳入白名单。发布前仍按 AGENTS.md 停下来等待明确推送授权。

## 独立 QA 复测清单

1. 真实 EPUB 2 和 EPUB 3 各一本：目录、章节、图片、图注、脚注、内部链接。
2. 真实大文件：接近 100 MB 单本和接近 500 MB 书库；拒绝超限时书库不被破坏。
3. DRM、固定版式、损坏 ZIP、路径穿越、zip bomb：拒绝且不产生书卡。
4. 删除书后检查 IndexedDB 的 books / progress / translations / failures 全清。
5. 切换目标语言、风格、专业模式、模型后，旧译文不命中；切回旧配置可命中。
6. 章内滚动、章末预取下一章、切章、切模式、重新打开：无旧译文串台、无新增重复请求。
7. 320 px / 768 px / 宽屏，键盘方向键、目录焦点、脚注关闭、无横向溢出。
8. 阅读器页面无未捕获异常、无残留 Blob URL / scroll 监听器；关闭书后不再产生翻译请求。
