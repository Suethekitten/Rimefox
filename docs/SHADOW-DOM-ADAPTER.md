# 开放 Shadow DOM 翻译适配（0.10.2）

> 给后续 Agent / 协作者。先读 [AGENTS.md](../AGENTS.md)、[HANDOFF.md](../HANDOFF.md) 和
> [TRANSLATION-ENGINE-HANDOFF.md](TRANSLATION-ENGINE-HANDOFF.md)。
> 本文只讲 **开放 Shadow DOM 的收集、监听、样式、悬停和还原**；翻译请求、缓存、句子对齐仍是原引擎，不改。

---

## A. 设计与架构

目标不是另写一个 `shadowTranslate()`，而是让 Shadow DOM 里的文本进入同一条 TranslationUnit 管线：

```
普通 DOM + 开放 Shadow DOM
        ↓
DT.collectAll(accept)
        ↓  walk() / 适配器 collectTargets()
ParagraphUnit（和普通网页完全相同的单元）
        ↓
DT.send({ type: 'translate' }) / 现有缓存 / 并发 / 批处理
        ↓
DT.inject(unit, ...) / RenderTransaction
        ↓
DT.restore() / DT.refreshStale() / DT.pruneDetached()
```

### 关键文件

| 文件 | 职责 |
|---|---|
| `content/shadow.js` | 通用层：open root 登记、进入 / 跳过、slot、收集目标根、Observer、样式、诊断、释放 |
| `content/adapters/bilibili-comments.js` | B 站专用：只收评论正文 `bili-rich-text #contents`，排除昵称 / 时间 / 点赞 / 操作区 / 登录提示 |
| `content/dom.js` | `walk()` 新增 open root / slot 分支；`collectAll()` 合并适配器内容根；`restore()` 深查询 |
| `content/main.js` | 文档 Observer 里登记新增宿主；Shadow observer 回调和现有 `scheduleIncremental` 复用 |
| `content/hover.js` | 事件用 `composedPath()[0]`；caret 拿不到内部文本时整段安全降级 |
| `content/styles/inject.css` | Shadow root 里通过共享 Constructable Stylesheet 复用；不复制整套 CSS |

### 通用层接口（`DT.shadow`）

```js
DT.shadow.enable({ mode, name, maxRoots, isHost, skipHost, collectTargets })
DT.shadow.active()             // 是否启用
DT.shadow.enter(host)          // auto 模式：返回 open shadowRoot；targets 模式返回 null
DT.shadow.skip(host)           // 适配器要求普通 walk 跳过的宿主
DT.shadow.isSlot(el) / assigned(slot)
DT.shadow.collectTargets()     // targets 模式的内容根（元素）
DT.shadow.observe(root, host)  // 只给指定边界建一个 observer
DT.shadow.noteAdded(nodes)     // 文档 Observer 新增节点登记 / 延迟补扫
DT.shadow.prune()              // 断开已脱离的 root observer
DT.shadow.reset()              // 还原 / 关闭翻译时全部释放
DT.shadow.all(selector)        // 兜底清理用：遍历 document + 所有 open root
DT.shadow.diagnostics()        // roots / observers / targets / pending / capped
```

两种启用方式：

- **auto**：普通 `walk()` 遇到 open shadow root 就进入；适合通用夹具 / 不需要排除区的站点。
- **targets**：普通 walk 不进入评论组件，适配器只返回明确的内容根（B 站用这种），避免把昵称、时间、按钮当正文。

`content/shadow.js` 自己不默认全站启用。只有：
1. B 站适配器在 `*.bilibili.com` 启用 targets；或
2. 页面显式带 `data-dt-shadow-auto`（离线夹具）启用 auto。

### `walk()` 的变化

`ShadowRoot` 是 `DocumentFragment`（nodeType 11），不是 Element。`walk()` 只接受 Element，所以：

- 宿主元素先经过 `isSkipped` / 站点规则 / 已翻译判断；
- 有 open shadow root 且通用层允许时，只遍历 `shadowRoot.children`，**不再把宿主 light DOM 当正文**；
- `<slot>` 只走 `assignedNodes({ flatten: true })`，并用本轮 `walkSeen` WeakSet 去重；
- `DT.collect()` 现在也能直接接收 `ShadowRoot` 作为根（遍历 `root.children`）。

限制：ShadowRoot 的**直接文本子节点**没有 Element 包装，当前不收集；实际 Web Component 一般会把正文放在 `#contents` 这类元素里。

---

## B. Bilibili 适配（2026-10-22 实站验证）

真实页面（Chrome 156 / 未登录，视频页）确认的结构：

```text
bili-comments
  #shadow-root (open)
    #feed
      bili-comment-thread-renderer
        #shadow-root (open)
          #comment
            bili-comment-renderer
              #shadow-root (open)
                bili-rich-text
                  #shadow-root (open)
                    #contents   ← 评论正文
```

实测可访问的组件：

| 组件 | 用途 | 选择器 |
|---|---|---|
| `bili-comments` | 评论区宿主 | `document.querySelector('bili-comments')` |
| `bili-comments.shadowRoot` | 一级评论 feed | `#feed`，children 是 `bili-comment-thread-renderer` |
| `bili-comment-thread-renderer` | 一条一级评论 + 回复 | open shadow root；`#comment` 里是 `bili-comment-renderer` |
| `bili-comment-renderer` | 评论正文 + 用户区 | open shadow root；正文是 `bili-rich-text` |
| `bili-rich-text` | 富文本正文 | open shadow root；`#contents` 是真正正文 |
| `bili-comment-reply-renderer` | 楼中楼容器 | 递归找到它下面的 `bili-comment-renderer` |

适配器不依赖固定嵌套层级：从 `bili-comments` 的 `#feed` 开始 BFS，遇到 **bili-* 且带 open shadowRoot**
的元素就入队；在每个 root 里找 `bili-rich-text`，再取其 `shadowRoot.querySelector('#contents')`。
回复 / 表情 / 操作区换标签时不需要改白名单；起点限定在 bili-comments 内，不会跑进播放器或推荐位。

### 应翻译

- 一级评论正文
- 楼中楼回复正文
- 评论内的链接 / @ / 表情所在的富文本
- 展开、排序、滚动后新出现的正文

### 不翻译

只把 `#contents` 作为内容根，所以默认不会碰：

- 昵称、UID、头像
- 点赞数、回复数、时间、IP 属地
- 操作按钮 / 菜单
- 评论输入框
- `登录后查看 N 条评论` 这类登录提示（适配器额外用文本前缀排除）
- 未展示 / `display:none` 的回复（`checkVisibility` + 祖先可见性）

### 实站验证结论

- 已验证：`bili-comments` open root、`#feed`、`BILI-COMMENT-THREAD-RENDERER`、`bili-comment-renderer`、
  `bili-rich-text`、`#contents` 均可直接访问。
- 已验证：用本地假 OpenAI 接口把真实中文评论翻译成英文，译文写入 `#contents`；昵称 / 时间 / 操作区没有译文。
- **未验证**：未登录时 B 站只给首屏（本次只看到 2 个 thread，并显示“登录后查看 3.5万+ 条评论”），
  真实站点的**滚动加载新评论**和**楼中楼展开**没有在登录态下跑过；离线夹具覆盖了动态新增、异步回复、隐藏回复、排序。
- 真实视频页还会翻译标题 / 简介等普通 DOM；这次没有对番剧、专栏、动态页逐页验证。

---

## C. Observer 生命周期

### 只观察一个边界

B 站适配器只对 `bili-comments.shadowRoot`（feed）建 **一个** MutationObserver，不按评论 / 不按 thread 建：

- 新一级评论、排序重建：feed 的 childList 触发 → 现有 `scheduleIncremental`。
- 楼中楼展开 / 异步加载：走现有 document 的 click / scroll 补扫；`main.js` 在 shadow 启用时额外安排一次 1.2s 后的增量扫描。
- 评论正文被站点改写：comment / rich-text 的嵌套 root 没有单独的 observer，靠 click / scroll / URL 变化补扫；
  这是为控制 observer 数量做的取舍，见「已知限制」。

### 去重与清理

- `records`：host → root 记录；`WeakMap` 做 O(1) 去重，`records` 数组只用于生命周期遍历。
- `prune()`：宿主脱离、`host.shadowRoot !== root` 时断开 observer、移除样式、删除记录。
  每次 `DT.collectAll` / `DT.pruneDetached` / `refreshStale` 都会 prune。
- 上限：B 站 `maxRoots: 200`；通用 auto 默认 160。超过上限的 root 不再登记（`diagnostics.capped` 可查）。
- `DT.restore()` 开头调用 `DT.shadow.reset()`：断开所有 observer、移除共享 / 兜底样式，再回放 RenderTransaction。
- 页面卸载：content script 生命周期结束；B 站切换视频后的旧宿主由 prune 断开。

### 为什么不是 attachShadow 补丁

没有 monkey-patch `Element.prototype.attachShadow`。发现靠：采集时遇到宿主 + 文档 Observer 新增节点 + 延迟补扫。
限制：一个宿主插入后、shadowRoot 很晚才创建且没有任何 DOM 变化 / 点击 / 滚动时，可能晚一轮才发现；
B 站当前自定义元素在插入时已经能访问 open root。

---

## D. 样式隔离

1. `content/styles/inject.css` 已加入 `web_accessible_resources`，`content/shadow.js` 只 fetch 一次。
2. 把 CSS 里的 `html[...]` 改成 `:host-context(html[...])`，让主题 / 深色 / 排版规则在 shadow root 内也匹配外层 `<html>`。
3. 优先使用共享的 **Constructable Stylesheet**：`root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]`；
   一个 sheet 被多个 root 复用，不复制几十套。
4. `CSSStyleSheet` / `replaceSync` 不可用时，每个 root 放一个 `<style data-dt-shadow-style>`，文本仍是同一份 CSS。
5. fetch 完成前有 `BASE_CSS` 同步兜底（display / margin / 行高 / 首字下沉等），避免第一次注入裸节点。
6. 只对 `.dt-target` / `[data-dt-hover]` / `br[data-dt-collapsed]` 这些扩展节点生效，不改 B 站原始评论样式。
7. 设置页的「自定义 CSS」目前只注入 document，不会进 shadow root；这是已知限制。

---

## E. 翻译与缓存

- 普通页面照旧：`DT.collectRoots()` → `body` → `walk`。
- 启用 target 适配器时：`DT.collectAll` 在普通 roots 后面追加 `DT.shadow.collectTargets()` 返回的内容根；
  每个内容根仍走 `DT.collect(root, accept)`。
- 一个 `#contents` 产生一个 ParagraphUnit（若它内部有块级段落，沿用现有规则切分），不会把整棵评论树拼成一段。
- 同一内容根只出现一次：适配器 `targetSeen`；同一轮 walk 的 slot / light DOM 去重：`walkSeen`。
- 缓存键、并发、请求去重、懒翻译、失败退避、双语 / 仅译文都没变；shadow 只改变「从哪里收集」。
- 动态新增评论只送新增文本；已有评论命中现有缓存。
- 真实 B 站中文评论在目标语言为中文时会被 `looksLikeTarget` 正确跳过；要验证翻译请把目标改成英文等。

---

## F. 已知限制

| 限制 | 现状 / 原因 |
|---|---|
| closed Shadow Root | 无法访问，安全跳过 |
| ShadowRoot 直接文本子节点 | 不收集（需要 Element 作为单元宿主）；B 站 / 夹具正文都在元素里 |
| slot 里的直接文本 | 只遍历 assigned 的 **Element**；直接文本节点不收集 |
| 嵌套 slot / fallback | 走 `assignedNodes({flatten:true})`，fallback 文本未覆盖 |
| iframe 内评论区 | 内容脚本在 iframe 只加载配置，不装整页管线；未开启 iframe 评论翻译 |
| 自定义 CSS | 只作用于 document，不进 shadow root |
| B 站登录态滚动 / 楼中楼 | 实站未登录只显示首屏，未做登录态验证；离线夹具覆盖动态行为 |
| 评论正文被站点改写 | 没有 per-thread observer；靠 click / scroll / URL 补扫 |
| 选择翻译 / 划词跨 shadow | 现有 Selection API 限制；未作为本轮验收 |
| 番剧 / 专栏 / 动态 | 只验证了视频页；适配器按组件名，理论上可复用，但未逐页验证 |
| 性能 | 真实评论内容根 BFS 每轮遍历；现场 11 条夹具 0.3ms/次（Chrome headless，accept=false 的收集），大评论区仍需观察 |

---

## G. 新网站适配指南

1. **只在确认需要时启用**，不要在所有网站打开 auto。
2. 新建 `content/adapters/<site>.js`，检查 hostname / 页面特征，早退不匹配的站点。
3. 调用 `DT.shadow.enable`：
   - 需要普通 walk 进入 shadow：`mode: 'auto'`（谨慎，可能收集到 UI）。
   - 需要精确内容区：`mode: 'targets'`，提供：
     - `isHost(el)`：新增宿主是否需要延迟补扫；
     - `skipHost(el)`：普通 walk 应跳过的宿主；
     - `collectTargets()`：返回**内容根 Element**（最好是正文容器，不是整个组件）；
     - `maxRoots`：受控上限。
4. 在 `collectTargets()` 里对每个要翻的根做可见性 / 排除判断；不要把昵称、时间、按钮、输入框返回。
5. 只对**一个**合适的边界调用 `DT.shadow.observe(root, host)`（例如 feed / 列表根）；不要为每条内容建 observer。
   异步展开 / 分页交给现有 click / scroll 补扫；必要时在 `main.js` 的 shadow 分支加一次延迟扫描。
6. 在 `manifest.json` 和 `background.js` 的 `ensureInjected` 里按顺序加入 `content/shadow.js` 和适配器
   （shadow 在 dom 之后、main 之前；适配器在 shadow 之后、main 之前）。
7. 增加离线夹具 / E2E：
   - 单层 / 多层 open root、closed root、slot；
   - 一级 / 嵌套 / 动态新增 / 修改 / 删除 / 排序重建；
   - 只翻正文、不翻控件；
   - 双语、仅译文、还原、悬停；
   - `DT.shadow.diagnostics().observers` 在还原 / 切页后归零。
8. 如果新站点需要不同的样式隔离 / 主题，优先扩 `shadow.js` 的共享样式，不要复制整套 CSS。

---

## H. 本轮实现情况

| 项 | 状态 |
|---|---|
| 通用 open root 收集 / nested / slot / closed 跳过 | 已实现，离线夹具 + 真实 B 站结构已验证 |
| B 站一级评论 / 楼中楼正文选择器 | 已实现；真实 B 站结构已验证，真实楼中楼展开未登录态未验证 |
| 动态新增一级评论 / 排序重建 | 已实现，离线夹具 + E2E 验证 |
| 点击后异步回复 / 隐藏回复展开 | 已实现，离线夹具 + E2E 验证 |
| 昵称 / 时间 / 点赞 / 操作区 / 输入框排除 | 已实现，离线夹具 + 真实 B 站昵称 / 时间 / 操作区验证 |
| 双语 / 仅译文 / 链接保留 | 已实现，离线夹具 E2E 验证；真实 B 站双语译文已验证 |
| 悬停对照 | 已实现，真实鼠标进入 shadow 正文 E2E 验证（逐句不可得时整段降级） |
| 原文还原 / observer 释放 | 已实现，E2E 验证 |
| 样式共享 / 兜底 | 已实现，E2E 验证共享 stylesheet 生效 |
| 真实 B 站滚动加载 | **未验证**：未登录只显示首屏 + 登录提示 |
| 真实 B 站楼中楼展开 | **未验证**：同上；离线夹具覆盖 |
| 番剧 / 专栏 / 动态 | 未验证 |
| 性能长稳 | 夹具 11 条 0.3ms/次；真实大评论区未长时间跑 |

版本：0.10.2。发布前按 [AGENTS.md](../AGENTS.md) 跑 Node / 自检 / E2E；本文不重复命令。
