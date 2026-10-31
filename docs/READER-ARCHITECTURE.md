# EPUB 阅读器架构（0.13.0）

> 状态：0.13.0 实现契约。EPUB 是第一个文档适配器；PDF 只预留接口，不在本版实现。
> 阅读器入口：`reader/index.html`（扩展页，不是 content script）。
> 翻译仍走 `background.js` 的 `translate` 路由；不新增 Provider、不新增翻译服务器。

## 1. 边界

```
reader/index.html
  ├─ LibraryView        本地书库、导入、删除、进度
  ├─ ReaderView         目录 / 章节 / 图片 / 脚注 / 阅读设置
  ├─ TranslationQueue   当前视口 + 后 2 屏；手动本章；切章取消
  └─ BookDocument       格式无关的只读文档接口
       ├─ EpubDocument  EPUB 2/3 → sanitized XHTML sections
       └─ PdfDocument   （未来）PDF 页面/文本层 → 独立 renderer
```

共享：书库、元数据、目录、进度、翻译队列、翻译缓存、设置、删除、错误模型。
不共享：EPUB 的 XHTML renderer 与 PDF 的页面/文本层 renderer。

### Renderer 边界（EPUB）

- `reader/index.html` 显式加载 `content/core.js`、`units.js`、`direction.js`、`dom.js` 作为本地 classic 脚本，只对 `#bookContent` 调 `DT.collect` / `DT.inject`；不加载 `content/main.js`、`selection.js`、`dock.js`，也不会被 manifest 注入到网页。
- `content/dom.js` 的页面假设由 `tools/e2e-reader.mjs` 在真实扩展页覆盖；改动 `dom.js` 必须同时跑 selftest、普通网页 E2E 和 reader E2E。
- 阅读器 UI 一律标 `data-dt-ui`，只让正文进入收集；不要把 `reader/index.html` 当成网页内容脚本页面。

## 2. BookDocument 接口

```js
/**
 * @typedef {Object} BookMetadata
 * @property {string} title
 * @property {string[]} authors
 * @property {string} language
 * @property {string} [publisher]
 * @property {string} [description]
 * @property {string} [identifier]
 */

/**
 * @typedef {Object} BookTocItem
 * @property {string} title
 * @property {string} href        // 原始 href（可能含 fragment）
 * @property {string} sectionHref // 解析到 ZIP 内 section 路径
 * @property {BookTocItem[]} children
 */

/**
 * @typedef {Object} BookSection
 * @property {string} id          // 稳定：spine index + 归一化 href
 * @property {string} title
 * @property {string} href
 * @property {number} index
 * @property {() => Promise<SanitizedSection>} load
 */

/**
 * @typedef {Object} BookDocument
 * @property {string} id          // reader 用 SHA-256(original file) 赋值
 * @property {'epub'|'pdf'} format
 * @property {BookMetadata} metadata
 * @property {{bytes:Uint8Array,mediaType:string,href:string}|null} cover
 * @property {BookTocItem[]} toc
 * @property {BookSection[]} sections
 * @property {(href:string, base?:string) => {sectionHref:string,sectionId:string,fragment:string}} resolveHref
 * @property {(path:string) => Uint8Array|null} getResource
 */
```

`EpubDocument` 由 `lib/reader/epub.js` 构造。未来 `PdfDocument` 必须实现同一接口；`section.load()` 返回页面/文本块，不返回 EPUB XHTML。EPUB 的 `load()` 返回原始 XHTML，清洗由 `sanitizeXhtml()` 完成，避免解析器依赖 DOM。

## 3. SanitizedSection

`sanitizeXhtml(html, {baseHref, book, document, DOMParser})` 返回：

```js
{
  fragment: DocumentFragment, // 只含 allowlist 元素 / 文本
  assets: Map<string,string>, // 章节内相对图片 href → Blob URL
  notes: Map                 // 预留；当前脚注通过内部链接 / 浮层读取
}
```

- 输入 XHTML 一律视为不可信 HTML。
- 输出通过 `document.createElement` / `createTextNode` 构造，不把不可信字符串写入 `innerHTML`。
- 禁止：`script`、`iframe`、`object`、`embed`、`form`、`input`、`button`、`link`、`meta`、`style`、`svg`、事件属性、`javascript:` / `data:` 链接、远程资源。
- 保留：标题、段落、列表、引用、图片（本地 raster）、图注、简单表格、`b/strong/i/em/u/s/sup/sub`、普通链接、脚注引用、`br`、`pre/code`。
- 图片通过 ZIP 内字节转 Blob URL；不加载远程 URL。
- 链接：同章 `#fragment` 滚动；跨章按 `resolveHref` 切章；外链 `target=_blank rel=noopener noreferrer`。

## 4. 阅读与翻译

- 一次只加载一个 spine section；进度 = `{ sectionId, offsetRatio }`。
- 自动翻译：当前视口 + 后 2 屏；接近章末时预取下一章开头（最多 12 个单元 / 8 条一批），不自动翻整章。
- 手动“翻译本章”：只翻当前 section，不扩散到后续章节；超过 400 段或 5 万字先弹确认，避免误触发大量请求。
- 打开时按书记住模式：`original | bilingual | translation`；恢复 `bilingual` 时只自动翻当前视口。
- 阅读器顶部提供目标语言下拉；切换会写回全局 `targetLang`，重建翻译队列和缓存 key，不沿用旧语言译文。
- 翻译单元：段落、列表项、引用、图注、简单表格单元格；跳过目录/导航、页眉页脚、页码、`pre/code`、图片 alt。
- 行内格式 wire：`<fN>…</fN>` 表示可翻译的格式范围，`<kN>…</kN>` 表示不可变的链接/原子。复用 `lib/inline-protocol.js` 的 `INLINE_VERSION / inspect`。
- 失败/格式缺失：整段降级纯文本并记录诊断；不把标记失真的译文写进缓存。
- 阅读器排版：不随包分发字体；用户可上传本机 TTF/OTF/WOFF/WOFF2，字体 Blob 只存本机 IndexedDB，通过 FontFace 加载。提供字号、行高、字间距、段间距、页宽、主题和全屏，系统宋体 / 黑体作为回退。

> 参考了 [ColorTxt](https://github.com/ssnangua/ColorTxt)（MPL-2.0，Electron 阅读器）的部分阅读体验（字体/排版、书库/进度、目录、主题、全屏）；**没有复制其代码**，实现基于本仓库现有 reader 架构。

## 5. 翻译缓存

reader 调 `background.translate` 时使用 `noCache: true`，避免书籍正文进入现有 512 KB 全局缓存。译文存 reader 的 IndexedDB：

```text
key = epub-v1|bookId|bookHash|sectionId|contentHash|targetLang|style|intensity|provider|model|professional|language fingerprint|glossary/prompt fingerprint
```

- 内容哈希变化、目标语言/风格/模型/术语/提示词变化 → 不命中。
- 删除书：删除原书 Blob、封面、目录、进度、该书全部译文与失败状态。
- 同一文件 SHA-256 重复导入 → 打开已有书。
- 删除后重新导入视为新书，不恢复旧译文。

## 6. IndexedDB schema

数据库：`rimefox-reader`（version 3；v1 → v2 新增 `progress`，v2 → v3 新增 `fonts`，旧书仍可读）

```text
books        keyPath: id
  { id, hash, format, title, authors[], language, metadata,
    coverBlob, fileBlob, toc, createdAt, lastOpenedAt, mode }

progress     keyPath: bookId
  { bookId, sectionId, offsetRatio, updatedAt }

fonts        keyPath: id
  { id:'user', name, type, blob, addedAt }   // 用户上传，仅本机

translations keyPath: key
  { key, bookId, sectionId, contentHash, targetLang, style, intensity,
    provider, model, source, translated, updatedAt }
  index: bookId

failures     keyPath: key
  { key, bookId, sectionId, reason, updatedAt }
  index: bookId

settings     keyPath: id
  { id:'reader', fontFamily, fontSize, lineHeight, measure, theme }
```

上限：约 100 MB/本、500 MB/书库；不申请 `unlimitedStorage`。超限拒绝并给出明确错误。

## 7. 错误码

```text
not_epub           不是 ZIP 或缺少 META-INF/container.xml
drm_protected      检测到加密/DRM，拒绝
unsupported_layout fixed-layout / 非可重排
too_large          单本或书库超限
corrupt_epub       OPF/spine/nav 缺失或损坏
unsafe_archive     路径穿越 / zip bomb / 异常压缩比
missing_content    章节文件缺失
unsupported_media  远程资源或不允许的媒体
import_failed      其它导入错误
```

失败只显示一次简洁状态；不循环 toast，不破坏已有书库。

## 8. PDF 未来路径

0.13.0 不引入 pdf.js。未来 `PdfDocument` 必须实现同一个 `BookDocument`：

```js
// 约定，不是本版代码
PdfDocument = {
  id, format: 'pdf', metadata, cover, toc, sections,
  getResource(path),
  resolveHref(href, base),
  // section.load() → { kind:'pdf', pages:[{index, width, height, textItems}] }
}
```

- 共享：`BookDocument`、书库、进度、翻译队列/缓存、设置、删除。
- 独立：PDF 页面 canvas + 文本层 renderer；文本块坐标用于翻译叠层。
- 不把 PDF 页面塞进 EPUB XHTML renderer；不要把 EPUB 的 `DocumentFragment` 假设带进 PDF。
- 翻译单元仍需带稳定 `sectionId/contentHash`；缓存 key 继续走 `epub-v1` 之外的格式前缀（例如 `pdf-v1`）。
- 不承诺 PDF 日期；先完成 EPUB 后再立项。

## 9. 权限

不新增浏览器权限。读取本地文件使用 reader 页的 `<input type=file>` / 拖拽；不申请 `file://`、`unlimitedStorage`、`downloads`。不读 Cookie，不上传原书。
