# 凛狐 Rimefox 交接文档

> 给接手开发的创作者：这份文档覆盖**它是什么、怎么跑、代码怎么组织、哪些坑已经踩过、下一步该做什么**。
> 版本：0.6.2 ｜ 目录：`edge-bilingual/`

---

## 1. 这是什么

一个 Edge / Chrome 的 **MV3 浏览器扩展**，核心能力是网页双语对照翻译：

- 整页双语对照翻译（正文保留原文，界面元素单语）
- 仅译文模式（原地替换，保留页面布局）
- 动态内容补翻（MutationObserver + 点击补扫 + 悬停补扫）
- SPA 前进/后退/路由切换自动续翻
- 弹窗内的随手翻译（不依赖页面）
- 设置页 / 弹窗：浅色与深夜配色、弹窗一键切换，界面文字可中英文
- 术语表（指定译法）+ 自定义提示词（追加措辞要求）
- **划词翻译**：右键菜单 / 选区小按钮 / 选中即译（三选，默认前两种）
- 多协议接口：**OpenAI 兼容 / Anthropic Claude / Google Gemini**，内置 10 家提供商模板 + 可命名的自定义服务商
- 只用**自己的** API，不内置任何免费端点

**零构建**：纯原生 JS + ESM，没有 npm / webpack / tsc。改完文件直接在扩展管理页「重新加载扩展」即可，不需要任何编译步骤。这是刻意选择——降低接手门槛。

---

## 2. 快速开始

1. 打开 `chrome://extensions/`（Edge：`edge://extensions/`）
2. 开启开发者模式（Chrome：右上角「开发者模式」；Edge：左下角「开发人员模式」）
3. 点「加载已解压的扩展程序」（Edge：「加载解压缩的扩展」），选中 `edge-bilingual/` 文件夹
4. 首次安装会自动打开设置页
5. 填 API 地址（默认 `https://api.deepseek.com/v1`）、Key、模型名（默认 `deepseek-chat`）
6. 点「保存」→「测试连接」
7. 打开任意英文网页 → `Alt+A`（Mac：`Option+A`；或点工具栏图标 →「翻译此页」）

**验证健康度**：
```
chrome-extension://<扩展ID>/selftest/index.html
```
扩展 ID 在扩展管理页的卡片上能看到（Edge 同样是 `chrome-extension://` 开头）。
应显示 **88 / 88 全部通过**。这个页面不联网、不花钱，改完 DOM 引擎先跑它。

---

## 3. 目录与职责

```
edge-bilingual/
├── manifest.json          MV3 清单（权限、注入点、快捷键、入口页）
├── background.js          service worker：消息中枢、并发闸门、批处理、缓存、重试
├── lib/
│   ├── config.js          配置默认值 + 存储读写 + 版本迁移（v6）
│   ├── provider.js        接口门面：chat() / listModels()，按 engine 分发
│   ├── engines/           各协议实现（openai / anthropic / gemini）
│   ├── providers.js       内置提供商模板（地址 + 协议 + 关闭思考的参数）
│   ├── parse.js           模型返回值解析（JSON 数组容错）+ 输出长度护栏
│   ├── prompt.js          翻译提示词（普通 / 趣味风格），纯函数
│   ├── cache.js           三层翻译缓存：内存 + storage.session（8000 条）+ storage.local（短文本，512 KB）
│   ├── privacy.js         可选的本地脱敏 / 恢复（纯 JS，无依赖）：识别、占位符、fail-closed 恢复
│   ├── appearance.js      强调色预设、译文排版变量、译文自定义 CSS 清洗（纯函数，后台按网址算 page 对象用）
│   ├── site-rules.js      站点规则：内置规则、校验、按网址匹配；夜间模式网站名单
│   ├── ui-appearance.js   设置页/弹窗共用：强调色等写到 <html>、深浅色圆形过渡、跨页面配置同步、空闲执行
│   ├── ui-theme-boot.js   设置页/弹窗的首帧主题与外观预判（<head> 同步执行，避免闪一帧白底）
│   └── welcome.js         首次安装判断 / 欢迎页语言默认值 / getURL 打开（纯函数，可单测）
├── content/               内容脚本（classic script，不能 import）
│   ├── core.js            命名空间 DT、文本工具、DT.send（带超时）、toast
│   ├── dom.js             ★ 切分 + 注入 + 还原 + 诊断（核心，改动风险最高）；站点规则的只翻 / 跳过区域
│   ├── appearance.js      网页里的外观：强调色、译文排版、自定义 CSS、页面明暗、夜间模式写到 <html> 上
│   ├── main.js            调度：开关、批处理、观察器、快捷键、看门狗；DT.control 给悬浮入口用
│   ├── selection.js       划词：右键菜单 / 选区按钮 / 气泡（翻完可「置顶」）
│   ├── subtitles-core.js  YouTube 字幕纯函数（解析 json3、拼句）；自检页与 YouTube 运行时共用
│   ├── subtitles.js       YouTube 字幕运行时：懒翻译、叠层显示（只在 YouTube 加载）
│   ├── youtube-hook.js    页面主环境（world: MAIN）：捕获播放器的字幕请求，转给 subtitles.js
│   ├── hover.js           悬停对照：高亮同一处的原文和译文，替换型单元弹原文气泡
│   ├── pip.js             置顶翻译窗：Document Picture-in-Picture，不支持时退回 window.open 小窗
│   ├── dock.js            悬浮入口：Shadow DOM（closed）里的小球 + 按钮列，默认关闭
│   └── styles/inject.css  译文样式与主题、页面明暗适配、夜间模式反色
├── welcome/               首次安装欢迎页 / 新手引导（index.html + welcome.css + welcome.js，无构建）
├── popup/                 工具栏面板（含随手翻译）
├── options/               设置页（提供商模板、模型选择器、快捷键录制、外观 / 站点规则交互、设置搜索；拆分见 options/ 下各模块）
├── test/                  Node 单测（引擎 / 配置 / 提供商模板 / 回包解析 / 缓存 / 提示词 / 外观 / 站点规则 / 界面语言 / 隐私脱敏 / 欢迎页）
└── selftest/              离线自检（98 条用例）
```

**为什么内容脚本是 3 个 classic script 而不是 ESM？**
manifest 的 `content_scripts.js` 不支持 ESM import。所以用三个文件按顺序加载，通过 `window.__DT` 共享命名空间。`background.js` 是 `type: "module"`，可以正常 import。

---

## 4. 运行时架构

```
content script                    service worker               外部 API
──────────────                    ──────────────               ────────
DT.collect()  收集待翻单元
   │
   ├─ 分段/长文拆分/组批
   │
   ├─ DT.send({type:'translate'}) ──► 并发闸门（默认 6）
   │                                   ├─ 同批重复文本合并，缓存命中直接返回
   │                                   ├─ 未命中 → provider.chat()
   │                                   ├─ 解析 JSON 数组（含兜底）
   │                                   ├─ 429/5xx 自动重试 3 次
   │                                   └─ 回写缓存
   │   ◄──────────────────────────────┘
   ├─ 每批回来立即注入（渐进渲染）
   └─ 页面上直接出现译文
```

### 可选：本地脱敏（`lib/privacy.js`）

只在 `background.js` 的 `translate` 路由里挂钩，因此整页、划词、弹窗、YouTube 字幕、批量翻译共用同一套逻辑：

```
texts ──► 缓存查找（原文） ──► privacy.maskTexts()
                                  └─ 占位符文本 ──► provider.chat()（敏感值不上行）
                                                          │
        results ◄── privacy.restoreText()（fail-closed）◄─┘
```

- 默认关闭（`privacyEnabled: false`）；关闭时整段分支跳过，行为与改动前一致。
- 占位符沿用 OneAIFW 的 `__PII_<TYPE>_<n>__`。映射（占位符 → 原文）只存在于本次调用的内存里，不写 storage、不进缓存、不进日志。
- 恢复要求「该段出现过的占位符至少出现一次」；缺失、改写后认不出、出现映射表外的占位符，都返回失败，该段结果为 `null`（内容脚本按失败退避重试），不会输出半截译文。
- 只做固定格式：邮箱 / 电话 / 身份证（校验位）/ 银行卡（Luhn）/ 带标签的银行账号；中文姓名需要显式开启。地址、机构、密码、助记词不处理。
- 开启时 `lib/prompt.js` 会追加一段「`__PII_<类型>_<数字>__` 是占位符，原样保留」；关闭时提示词与改动前逐字一致。
- 评估与体积 / 许可证说明见 [docs/AIFW-PRIVACY-EVAL.md](docs/AIFW-PRIVACY-EVAL.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### 消息协议（content → background）

| type | 入参 | 返回 | 说明 |
|---|---|---|---|
| `translate` | `{texts: string[], target: string, style?: string}` | `{ok, results: (string\|null)[], failed, cached, error}` | 核心翻译。`results[i]` 为 `null` 表示该段失败 |
| `config:get` | — | `{ok, config}` | 读配置。**不含 `apiKey`**，换成 `hasKey: boolean`（Key 不进内容脚本）。`config.page` 是后台按发送方网址算好的 `{accent, customCss, typo, site, night, provider}`（自定义 CSS 已清洗、站点规则已匹配） |
| `mode:set` | `{mode}` | `{ok}` | 悬浮入口切显示方式后记进配置；只接受 `dual` / `translation`，内容脚本改不了别的配置项 |
| `test` | — | `{ok, ms, model, sample}` / `{ok:false,error}` | 测试连接 |
| `cache:clear` | — | `{ok}` | 清空三层缓存（storage 里的 `dt.cache.v1` 一并删掉） |
| `cache:stats` | — | `{ok, stats: {memory, disk, hits, misses}, bytesInUse: {session, local}}` | 设置页「翻译缓存」卡片用；`bytesInUse` 是浏览器实际记的占用 |
| `ensure` | `{tabId}` | `{ok}` | 补注入内容脚本（页面在安装前打开时） |
| `resume:set` | `{value: boolean}` | `{ok}` | 记录本标签页"在翻译"，用于返回/刷新后自动续翻 |
| `resume:get` | — | `{ok, value}` | 查询（会校验域名一致） |

### 消息协议（popup/background → content）

| type | 入参 | 返回 | 说明 |
|---|---|---|---|
| `dt:toggle` | `{source?}` | 状态快照 | 开/关翻译（**立即返回**，不等翻完）。`source: 'command'` = 浏览器快捷键触发，0.5 秒内和页面内快捷键去重 |
| `dt:status` | — | 状态快照 | `{enabled, mode, target, total, translated, failed, skipped, lastError, busy}` |
| `dt:setMode` | `{mode}` | 快照 | `dual` / `translation`，会重建 |
| `dt:setTarget` | `{target}` | 快照 | 切换目标语言，会重建 |
| `dt:setStyle` | `{style}` | 快照 | 趣味翻译：`plain` / `classical` / `catgirl`，当前页按风格重建（没开翻译就顺带打开），不写进配置；还原后回到 `plain` |
| `dt:retranslate` | — | 快照 | 清空重翻 |
| `dt:diagnose` | — | 诊断报告对象 | 见第 7 节 |
| `dt:configChanged` | — | 无 | 后台在 `storage.onChanged` 时广播；内容脚本重拉配置、清零失败退避并补扫。内容脚本**不要**自己监听 `storage.onChanged`（事件里带完整配置含 Key） |

### 接口层（协议 / 服务商 / 思考模式）

```
lib/
├── provider.js       门面：chat() / listModels()，按 engine 分发
├── engines/
│   ├── openai.js     OpenAI 兼容（DeepSeek / 千问 / GLM / Kimi / 硅基流动 / 第三方接口）
│   ├── anthropic.js  原生 Messages 协议
│   └── gemini.js     原生 generateContent 协议
├── providers.js      内置 10 家模板（地址 + 协议 + 关闭思考的参数）
├── parse.js          模型返回值解析（JSON 数组容错）
└── prompt.js         翻译提示词：普通翻译 / 趣味风格（风格表在 config.js 的 STYLES）
```

每个引擎导出同一套接口，其中前三个必须是**纯函数**（这样能脱离浏览器跑单测）：

```js
{
  id, label, defaults,
  buildRequest(cfg, req) → { url, headers, body },
  parseResponse(json) → { text, reasoning, error? },
  parseError(status, bodyText) → ApiError,
  listModels(cfg) → string[]
}
```

**配置按「服务商」分槽，不是按协议**：

```js
{
  currentProvider: 'deepseek',
  providerConfig: {
    deepseek:    { engine, baseUrl, apiKey, model },
    siliconflow: { engine, baseUrl, apiKey, model },
    __custom__:  { engine, baseUrl, apiKey, model }   // 自定义（可命名、可多个）
  },
  customProviders: [{ id: '__custom__', name: '我的中转 A' }]
}
```

> 为什么不能按协议：DeepSeek 与硅基流动都走 OpenAI 协议，按协议存会让两家的 Key 互相覆盖（0.4.9 踩过这个坑）。

**迁移**：`lib/config.js` 的 `migrateConfig()` 是纯函数，v3 → v4 → v5 → v6 逐级升级；迁移前把原配置备份到 `storage.config_backup_v3`。加字段只加不删。

**思考模式**（`thinkingMode`）三态，**默认 `off`**（0.5.1 起；翻译不需要推理，开着既慢又可能把预算用光）：

| 取值 | 行为 |
|---|---|
| `auto` | 不发送任何额外参数 |
| `off` | 按服务商发送关闭参数（`providers.js` 的 `thinkingOff`） |
| `custom` | 把用户填的 JSON 合并进请求体 |

服务不认该参数（400）时，`provider.js` 会**自动去掉参数重试一次**。

**content 为空**（推理模型把预算花在思考上，或把答案写进了 `reasoning_content`）：
1. `finish_reason` 是截断（`length` / `max_tokens` / `MAX_TOKENS`，见 `isLengthStop`）且这次没关思考 → `chat()` **关掉思考重试一次**
2. 仍为空 → 抛 `code: 'empty_content'` 的错误，消息里有 `finish_reason`、content 长度和思考内容长度（不再截一段原始 JSON）
3. 后台捕获后用 `parseArrayFromReasoning`（`lib/parse.js`）从思考过程里从后往前找「条数对得上、且不是复述原文」的 JSON 数组兜底
老用户存储里的 `thinkingMode: 'auto'` 不会被强制改掉（分不清是主动选的还是旧默认值），靠上面这套兜底。

各家关闭参数（来源：各家官方文档）：

| 服务商 | 参数 |
|---|---|
| DeepSeek / 智谱 GLM / Kimi / Anthropic | `thinking: {"type":"disabled"}` |
| 通义千问 / 硅基流动 | `enable_thinking: false` |
| OpenRouter | `reasoning: {"enabled": false}` |
| Gemini 2.5 | `thinkingConfig.thinkingBudget = 0` |
| Gemini 3 | `thinkingConfig.thinkingLevel = "minimal"` |

> GLM-5.3 系列、Kimi k3、Gemini 3 Pro 是**强制思考**，关不掉；参数被拒后会自动降级，不会让翻译失败。

**新增一个协议**：写 `lib/engines/xxx.js` → 在 `provider.js` 的 `ENGINES` 注册 → `config.js` 的 `ENGINE_IDS` 加 id → 补 `test/engines.test.mjs` 用例。

---

## 5. ★ 核心算法：切分与注入（最容易改坏的部分）

### 5.1 切分（`dom.js` 的 `walk`）

```
对每个元素：
  1) 没有子元素          → 它本身是一个翻译单元
  2) 子元素全被跳过      → 直接返回（★ 不能整体再翻，见坑 3）
  3) 有直接文本（段落）  → 整体是一个单元
  4) 容器（无直接文本）  → 逐个下钻到子元素
```

`shouldDescend(el)` 决定"容器"还是"段落"：
- flex/grid 容器 → 下钻（一排并列的条目）
- 有真正的块级子元素 → 下钻
- ≥3 个并列子元素 → 下钻（列表、菜单）
- 其余（如 `<h1><span>Hello</span> <span>World</span></h1>`）→ 作为一个整体

### 5.2 注入策略（`DT.inject`）

**默认追加**（双语）：把译文节点 append 到源元素**内部末尾**，这样它跟随源元素的盒子、字号、对齐。

**三种情况改为原地替换**（`injectOnly`：替换元素的文本节点，保留子元素如图标）：

| 条件 | 原因 |
|---|---|
| `mode === 'translation'` | 仅译文模式 |
| `isPositioned()`：fixed/sticky/absolute | 盒子尺寸写死，追加必溢出（昵称、日期、浮层标签） |
| `DT.areaOf(el)` 为 `control` / `chrome`（且 `chromeBilingual` 关） | 控件 / 导航里的界面文字，追加会撑破按钮、把导航条挤成两排 |

`DT.areaOf()` 是"这段文字属于哪一层"的唯一判定（`content/dom.js`），站点适配问题只改它：

1. 在目录里（祖先 id / class 带 `toc`、`table-of-contents`）→ `content`
2. 自己是控件，或沿**行内包裹链**找到所属控件（`<a><svg/><span>Code</span></a>` 的 span），且整个控件 ≤80 字 → `control`；超过 80 字的整条链接是卡片，不算控件
3. `header` / `nav` / `role=navigation|banner|menubar` 内 + 字号 ≤20px + 只占一行 → `chrome`
4. 其余 → `content`

诊断报告的 `units[].area` 和 `placements[].area` 会写出每个单元的判定结果。

> ⚠️ **不要**把"文本短"或"元素是 flex"单独作为替换条件。
> 0.3.1 试过"短文本 + 父级是 flex-row 就替换"，结果在 Tarkov 这种整页 flex 布局的站点上，
> 标题和正文全被替换，用户看到的是"原文被译文顶掉了"。现在的判据必须同时满足上面表格。

### 5.3 `textOf()` 必须排除自己的节点

`textOf(el)` 递归时跳过 `[data-dt-target]` 和 `[data-dt-ui]` 子树。
**否则**增量重扫时会把"原文 + 已注入的译文"当成新文本再翻一次，表现为同一段译文出现两遍。

### 5.4 YouTube 字幕（`subtitles-core.js` + `subtitles.js` + `youtube-hook.js`）

```
播放器 XHR /api/timedtext?…&pot=…&fmt=json3
   │  youtube-hook.js（world: MAIN）挂钩 XHR / fetch，postMessage 原样转出；留最后一份，扩展脚本晚到时发 replay 再要
   ▼
subtitles.js（扩展环境，只在 YouTube 加载；纯函数在 subtitles-core.js）
   ├─ 地址带 tlang（YouTube 机翻）→ 去掉 tlang 同源再请求一次，拿原文轨道
   ├─ 字幕语言 = 目标语言 → 不接管
   ├─ 人工字幕：按句末标点合并相邻事件；自动生成：逐词按停顿拼句（短句要长停顿才断）
   ├─ 每 200ms：按 video.currentTime 找当前句；只翻 [当前 − 3s, 当前 + 90s] 里没翻过的，20 句 / 2000 字一批
   └─ 叠层插在 .html5-video-player 里（全屏跟着走），z-index 30；播放器加 rimefox-subs-on 类隐藏原生字幕
```

- **为什么挂钩而不是自己请求**：字幕地址要带播放器生成的 `pot` 令牌，直接请求 `captionTracks[].baseUrl` 只会拿到 200 + 空内容（2026-10 实测）
- **CC 开关**看 `.ytp-subtitles-button[aria-pressed]`；换视频看地址里的 `v`，不清轨道（新字幕可能比地址栏先到）
- 纯函数在 `DT.subs.*`，自检页直接测；运行时只在 `youtube.com` / `youtube-nocookie.com` 启动
- 这一块依赖 YouTube 的私有接口与 DOM 类名，YouTube 改版就可能失效 —— 出问题先看 `/api/timedtext` 回包还在不在、类名变没变

---

## 6. 踩过的坑（按代价排序，别重犯）

| # | 坑 | 表现 | 现在的做法 |
|---|---|---|---|
| 1 | 译文插在源元素**外面** | 导航挤成一行、卡片标题浮在图片上 | 一律 append 到元素**内部末尾** |
| 2 | flex 容器把 `<span>` 块化 | 行内元素被当成独立块，译文叠在原文上 | 判定改为"整行当一个单元" |
| 3 | 父级对"子级全已翻译"做 fallback | 同一段译文重复 2~4 遍（有几层容器就几份） | `usableChildren()===0` 时直接返回，不再整体翻 |
| 4 | `textOf` 用 `innerText` | 把译文算进源文本 → 重复 | 自建递归，跳过自己的节点 |
| 5 | 用 `display:none` 隐藏原文实现"仅译文" | 容器塌陷、译文跟着消失 | 改为原地替换文本节点 |
| 6 | 按 `aria-hidden` 跳过 | 弹层打开时站点给背景加 aria-hidden → 整页译文消失 | **不要**按 aria-hidden 跳过 |
| 7 | 按 `opacity:0` 跳过 | 导航下拉菜单被跳过 → 展开后是原文 | 只跳过 `display:none` |
| 8 | MV3 service worker 被回收 | `sendMessage` 的 Promise 永不 resolve → 永远"翻译中" | `DT.send` 自带 90s 超时 + 看门狗复位 |
| 9 | URL 变化就全量清空重翻 | 点开帖子/弹层时整页闪烁 | 记 `data-dt-sig` 源文本签名，只撤掉真变了的元素 |
| 10 | 弹窗等 `dt:toggle` 完成 | 面板一直显示"未开启"，翻完才跳变 | `toggle` 立即返回 + 弹窗 400ms 轮询 |
| 11 | 其它翻译扩展 / 浏览器自带翻译同时在跑 | 页面已被换成中文 → 我们全部跳过，看起来"没工作" | 启动时检测并提示用户关掉另一个 |
| 12 | 看门狗按"总耗时"判卡死 + 全局 `abort` 标志 | 长页面翻到 90 秒被误杀，之后增量补翻永久失效 | 按"多久没有批次返回"判；用 `runId` 作废旧一轮，不留全局中止状态 |
| 13 | 失败（`null`）和"模型返回空"混为一谈 | Key 无效时提示"已翻译 N 段" | 后台：`''` = 无需翻译，`null` = 失败；内容侧分别计数 |
| 14 | 用 `el.tagName` 直接查表 | SVG 的 tagName 是小写，`<svg><title>` 抢走链接译文 | 一律 `tagOf(el)` 转大写；拼文本/替换时绕开 `NON_TEXT_TAGS` |
| 15 | 替换型元素只记原值 | 站点改字后不再重翻；还原时旧原文盖掉新内容 | 同时记"我们写入的值"，对不上就放回待翻译、还原时不碰 |
| 16 | 失败段每次补扫都整页重发 | Key 无效 / 限流时，每次点击、悬停都打一波请求，429 越试越重 | 按段落退避（5s/15s/45s，第 4 次失败放弃，`RETRY_DELAYS`）；不要整页一起退避，否则一批固定出错的段落会拖住新内容 |
| 17 | `config:get` 把整份配置（含 API Key）发给内容脚本 | 每个网页的渲染进程里都有一份 Key | 只给 `hasKey`；`storage.local` 收紧为 `TRUSTED_CONTEXTS`；配置变更走 `dt:configChanged` 广播 |
| 18 | 请求超时按总时长算（0.4.2） | DeepSeek 非流式先回响应头、生成期间发空行保活；生成超过 60s 的批次全被中止重试，永远不成功 | 按"多久没收到数据"计时（每块数据重置），另设 180s 总上限 |
| 19 | 内容侧并发写死 3、按文档顺序从头翻、一批 2000 字符 | 设置里的并发不生效；人在页面中间要等上面全翻完；首屏要等一整批生成完 | 并发跟设置走；每次取批按离屏幕距离排序；屏幕内批次 ≤3 条 / ≤500 字符 |
| 20 | 收集上限把"不送翻"的单元也算进去 + 观察器不再被自己的译文触发（0.4.2） | 超长页面（>上限）后半段永远不翻 | `collect(root, accept)` 只算送翻的；收满了本轮结束后接着收 |
| 21 | 以为页面内快捷键能兜底"被其它扩展占用的 Alt+A" | 装了其它默认 Alt+A 的扩展时，Option+A / Alt+A 完全没反应 | 占用发生在浏览器层，页面收不到按键；改为显示 `chrome.commands.getAll()` 的实际绑定，没绑定就引导去快捷键设置页 |
| 22 | service worker 里用 `tabs.query({currentWindow})` 找当前标签页 | 快捷键偶尔找不到标签页 | 用 `onCommand` 传进来的 `tab`，退回 `lastFocusedWindow` |
| 24 | 直接请求 YouTube 字幕地址 | 200 + 空内容：地址要带播放器生成的 `pot` 令牌 | 页面主环境挂钩播放器自己的请求（`youtube-hook.js`）；要别的轨道时拿它的地址改参数同源再请求 |
| 23 | 用 `getComputedStyle().height` / `lineHeight` 判"单行"，控件判定只看元素自身 | GitHub 顶栏 `Code / 代码` 两行堆叠、整页错位：链接里的行内 `<span>` 高度是 `"auto"` → NaN → 不替换 → 追加把导航挤成两排；`line-height: normal` 同样 NaN | 统一走 `DT.areaOf()`：沿行内包裹链找所属控件；单行看 `getClientRects()` / `getBoundingClientRect()`，行高 `normal` 按字号 × 1.2 |

---

## 7. 调试手册

### 7.1 自检页
```
chrome-extension://<扩展ID>/selftest/index.html
```
98 条纯前端用例，覆盖切分、注入、替换（含区域判定 `DT.areaOf`）、还原、长文拆分、调度纯函数、近似重复闸门、YouTube 字幕解析与拼句（`DT.subs`）、趣味翻译单元判定、逐句悬停对照（`DT.hover`）、站点规则区域、网页外观（强调色 / 排版 / 明暗 / 夜间）、悬浮入口。**改 `dom.js` 前后必跑。**

### 7.1b Node 单测（接口层）
```
node test/engines.test.mjs     # 三种协议的请求构造 / 回包解析 / 错误映射（45 条）
node test/config.test.mjs      # 配置迁移 / 按服务商隔离 / 导入校验（30 条）
node test/providers.test.mjs   # 提供商模板完整性 + 关闭思考参数（13 条）
node test/parse.test.mjs       # 回包解析 parseArray / 思考过程兜底 parseArrayFromReasoning / 输出长度护栏 isRunaway（15 条）
node test/cache.test.mjs       # 三层缓存：落地恢复、字节预算、清空（13 条）
node test/prompt.test.mjs      # 提示词：普通 vs 趣味风格、温度（13 条）
node test/provider.test.mjs    # 思考模式吃空 content：关思考重试、错误信息（5 条，假 fetch）
node test/glossary.test.mjs    # 术语表：清洗 / CSV 往返 / 命中 / 提示词与指纹（18 条）
node test/i18n.test.mjs        # 界面中英文：静态文案 / 动态状态 / t() / 校验提示全覆盖（13 条）
node test/appearance.test.mjs  # 强调色、译文排版变量、自定义 CSS 清洗（8 条）
node test/site-rules.test.mjs  # 站点规则匹配 / 校验 / 合并、夜间名单、配置导入（8 条）
node test/welcome.test.mjs     # 首次安装判断 / 语言默认值 / 欢迎页资源、英文覆盖、权限与后台接线（13 条）
```
需要 Node 18+。仓库根的 `package.json` 只为了让 Node 把 `.js` 当 ESM（`type: module`），扩展本身仍然零构建。

### 7.2 诊断按钮
弹窗底部「诊断」→ 生成 JSON 并复制到剪贴板，包含：

- `units[]`：每个翻译单元（tag / class / display / position / 是否因过短跳过 / 是否被判成已是目标语言）
- `skipped[]`：被跳过的元素及**原因**（`display:none` / `tag-skip` / `already-translated` / `our-ui` / `our-node`）
- `placements[]`：每条译文的投放记录（`where: inside|replace`，是不是 span）
- `summary`：计数

页面控制台也能取：`copy(JSON.stringify(__DT_LAST_DIAG))`

### 7.3 日志
- 设置页勾选「输出调试日志」→ 网页 Console 过滤 `[凛狐]`
- API 报错原文：`chrome://extensions/`（Edge：`edge://extensions/`）→ 卡片 →「Service Worker」→ 控制台

---

## 8. 配置项（`lib/config.js`）

| 键 | 默认 | 作用 |
|---|---|---|
| `currentProvider` | `deepseek` | 当前服务商（内置模板 id，或 `__custom__` / `custom:N`） |
| `providerConfig` | `{}` | 按服务商存的 `{engine, baseUrl, apiKey, model}`，**Key 不进内容脚本** |
| `customProviders` | `[]` | 用户保存并命名的自定义服务商 `[{id, name}]` |
| `thinkingMode` | `off` | `auto` / `off` / `custom`，见接口层一节（0.5.1 前默认 `auto`） |
| `thinkingExtra` | `''` | `custom` 时合并进请求体的 JSON 字符串 |
| `targetLang` | `zh-CN` | |
| `batchSize` | 8 | 单批条数（屏幕外的批次用。按离屏幕距离分级：屏幕内 ≤3 条 / ≤500 字符，一屏以内 ≤1000 字符，见 `takeBatch`） |
| `maxCharsPerBatch` | 2000 | 单批字符上限 |
| `maxUnitChars` | 1200 | 长段落拆分阈值 |
| `concurrency` | 6 | 并发请求数：内容侧工作协程数和后台闸门都用它（0.4.3 前内容侧写死 3） |
| `skipSameLang` | true | 跳过已是目标语言的段落 |
| `translateOnLoad` | false | 打开页面自动翻译 |
| `lazy` | true | 懒翻译：只翻屏幕上方 1 屏 ~ 下方 2 屏（`LAZY_ABOVE/LAZY_BELOW`），滚动时节流补翻（`onViewChange`）。false = 整页一次翻完 |
| `mode` | `dual` | `dual` / `translation` |
| `theme` | `underline` | 无 / 下划线 / 虚框 / 高亮 / 半透明 |
| `chromeBilingual` | false | 界面元素也保留原文（可能溢出） |
| `hotkey` | `alt+a` | **页面级**快捷键，可在设置里录制 |
| `selectionTranslate` | true | 划词翻译总开关 |
| `selectionMenu` | true | 划词：右键菜单「翻译所选文字」 |
| `selectionButton` | true | 划词：选区旁「译」小按钮 |
| `selectionImmediate` | false | 划词：选中即翻译（会消耗额度，默认关） |
| `subtitleTranslate` | false | YouTube 字幕双语：打开 CC 时接管字幕，只翻播放位置往后约 90 秒（0.5.2 起默认关闭；已保存过设置的用户保持原值） |
| `hoverCompare` | true | 悬停对照：高亮同一处的原文和译文 |
| `privacyEnabled` | false | 可选：翻译前在本地把敏感信息换成占位符，回包后还原（映射只在请求内存里） |
| `privacyMaskEmail` | true | 脱敏邮箱地址 |
| `privacyMaskPhone` | true | 脱敏电话号码 |
| `privacyMaskIdCard` | true | 脱敏 18 位身份证号（校验位通过才算） |
| `privacyMaskBankCard` | true | 脱敏银行卡号（Luhn）与带标签的银行账号 |
| `privacyMaskUserName` | false | 脱敏「姓名：」「联系人：」「我叫」等上下文里的中文姓名 |
| `uiTheme` | `auto` | 设置页 / 弹窗配色：`auto` 跟随系统，`light` / `dark` 固定；弹窗右上角按钮直接改这一项 |
| `uiLang` | `zh` | 设置页 / 弹窗界面语言：`zh` / `en`；网页里的悬浮入口和置顶小窗也跟着它 |
| `accentColor` | `violet` | 强调色：预设 id（`violet` / `blue` / `teal` / `green` / `amber` / `rose` / `slate`）或 `#rrggbb`；`violet` = 不改网页译文颜色 |
| `reduceTransparency` | false | 设置页 / 弹窗：玻璃效果改实色 |
| `disableShadow` | false | 设置页 / 弹窗：去掉投影 |
| `typoFontScale` | 100 | 译文字号百分比（70–160，100 = 跟随原文） |
| `typoLineHeight` | 0 | 译文行高（0 = 跟随原文，最大 3） |
| `typoGap` | 3 | 段落译文与原文的间距（0.1em 为单位，0–20） |
| `typoIndent` | false | 段落译文首行缩进两格 |
| `pageDarkAdapt` | true | 深色网页上换一套译文颜色（`html[data-dt-scheme="dark"]`） |
| `siteRules` | `[]` | 用户站点规则 `[{matches, textSelectors?, excludeSelectors?, mode?, theme?}]`，优先于内置规则；最多 50 条 |
| `nightMode` | false | 网页夜间模式总开关（Beta） |
| `nightSites` | `[]` | 夜间模式生效的域名（含子域名，不带端口） |
| `customCss` | `''` | 译文自定义 CSS：只允许属性声明，后台清洗后包进 `.dt-target` |
| `dockEnabled` | false | 网页悬浮入口 |
| `dockSide` | `right` | 悬浮入口位置：`right` / `left` |
| `dockAutoHide` | true | 悬浮入口收起时半藏 |
| `customPrompt` | `''` | 追加到系统提示词末尾，进缓存指纹（改了旧译文失效） |
| `glossary` | `[]` | 术语表 `[{src, dst, cat?}]`，全局一份，命中才注入提示词（进缓存指纹） |
| `debug` | false | 输出调试日志 |
| `_v` | 6 | 配置版本（迁移逻辑在 `migrateConfig`） |

---

## 9. 已知问题（诚实清单）

1. **仅译文模式下短中文会留下空白** —— 站点给容器写了固定高度，中文比英文短 40%，填不满。无通用解，只能按站点写规则或改用双语。
2. **行内标签不在译文里保留** —— 段落里的 `<b>` / `<a>` 会被整段重写，译文是纯文本，不带原格式。
3. **`<br>` 分隔的长帖**读起来是"一整段"，没做逐行对照（route 在图中的 `roadmap`）。
4. ~~没有图标~~（0.4.7 已加：`icons/`，源文件是 `icon.svg` / `icon-small.svg`，PNG 用无头 Chrome 渲染）
5. **站点规则库还很小**：内置规则只有 GitHub 文件列表和 Wikipedia 语言列表两条，其余靠通用启发式和用户自己写的规则；重前端站点（SPA 框架、虚拟滚动）可能漏翻。
6. **浏览器快捷键（manifest 里的 Alt+A）只是建议**：被其它扩展占用时浏览器不会分配给我们，而且按键在浏览器层就被那个扩展拿走，页面内快捷键也收不到。扩展没法自己改浏览器快捷键，只能引导用户去 `chrome://extensions/shortcuts`（Edge：`edge://extensions/shortcuts`）；设置页和弹窗会用 `chrome.commands.getAll()` 显示实际绑定结果
7. **划词没有独立快捷键** —— 快捷键监听在 `main.js`，按计划等 P0 拆分后再统一成"有选区就划词、没选区就整页"的自适应键
8. **不支持 OpenAI Responses 协议**（`/v1/responses`）——目前只有 OpenAI 兼容（chat completions）/ Anthropic / Gemini 三种。遇到只开 responses 的第三方接口会 404，见第 10 节 P3
9. **网页夜间模式是反色实现**：`filter: invert(1) hue-rotate(180deg)` + 媒体元素反向回正；画布绘制的界面、CSS 背景图、自带深色主题的网站可能显示异常，所以默认关闭、只对名单里的网站生效。
10. **置顶小窗依赖浏览器能力**：Document Picture-in-Picture 需要 Chrome 116+；退回的 `window.open` 小窗不会置顶，网页设置了 COOP 等隔离或拦截弹窗时打不开（会提示）。

---

## 10. 下一步路线（按性价比排序）

| 优先级 | 任务 | 预估 | 风险 |
|---|---|---|---|
| P0 | **拆 `main.js`**：把纯函数（离屏距离、取批上限、退避时间表）抽到 `core.js`，只动这两个文件 + 自检页；动手前先问协作者有没有并行改动 | 中 | 中 |
| P0 | **结构保真**：给文本节点打占位记号，要求模型保留 `<b>`/`<a>` 并回填 | 中 | 中（要改注入层） |
| P1 | **输入框翻译**：`Alt+I` 翻译当前输入框并回填 | 小 | 中（要处理 IME） |
| P1 | **划词快捷键**：监听在 `main.js`，等 P0 拆完再和整页翻译统一成"自适应快捷键" | 小 | 低 |
| P2 | **站点规则库扩充**：0.7.0 已有规则机制，按真实站点补内置规则（每条都要在保存的真实页面上验证） | 小 | 低 |
| P2 | **夜间模式改进**：自带深色主题的网站自动跳过反色；CSS 背景图更准确地回正 | 中 | 中 |
| P2 | **按 `<br>` 拆行**：长帖逐行对照 | 小 | 低 |
| P3 | **OpenAI Responses 协议**（`/v1/responses`）：只有遇到"只开 responses 的第三方接口"时才需要 | 小 | 中（离线无法验证） |
| P3 | PDF / 其它站点的视频字幕 / 图片 OCR | 大 | 高（单独立项，别混进这个仓库）；YouTube 字幕已做（见 5.4） |

---

## 11. 发版流程

1. 改 `manifest.json` 的 `version`
2. 改 `content/core.js` 的 `DT.VERSION`（保持两者一致，不一致时 Actions 会直接报错），`package.json` 的 `version` 也一起改。
   取号按 [AGENTS.md](AGENTS.md)「版本号规则」：1.0 之前一律 `0.x.y`，`0.9.x` 之后是 `0.10.0`，用户提出才发 `1.0.0`
3. 扩展管理页 → 点重新加载 → 刷新页面（`F5` / Mac `⌘R`）
4. 跑自检页：必须 **96 / 96**
4b. 跑 Node 单测：`for f in test/*.test.mjs; do node $f; done`（应全绿）
5. 手动过一遍三个站点：普通文章页、纯俄语页、SPA 帖子流
6. 更新 `CHANGELOG.md`：标题必须是 `## <版本号> — <标题>`，这一节会原样成为 Release 说明。规则见 [AGENTS.md](AGENTS.md)「发版说明」：
   每版 3–6 条、每条一句话且 ≤ 90 字、不许有子项、只写用户会感觉到什么、只写这一版。
   发版前跑 `python3 tools/check-release-notes.py <版本号>`，CI 也会跑，不合规就不发布
6b. 实现细节、取舍、内部重构、测试变化写进本文件末尾的「本版技术记录」（整节替换成这一版），以及 commit message
7. 推送到 `main`：`.github/workflows/release.yml` 会自动跑自检、打包 `Rimefox-v<版本号>.zip`、创建 `v<版本号>` 的 Release。
   同一版本只发一次；没改版本号的推送不会发版。也可以在 GitHub 的 Actions 页面手动运行

---

## 12. 代码约定

- 内容脚本用 **ES5 风格**（`var` / `function`），避免任何构建期语法转译需求
- 后台与设置页可以用 ESM + 现代语法（`let`/`const`/箭头函数）
- 所有 DOM 注入必须带 `data-dt-*` 属性，便于诊断与还原
- 新增"跳过规则"前先想清楚：会不会把**可见内容**也跳过（坑 6、7）
- 新增"替换规则"前先想清楚：会不会把**正文**也替换（坑：Tarkov 全页 flex）
- 任何改动都先跑自检页，再上真实站点
- **我们加到网页上的界面**（悬浮入口、置顶小窗、气泡、提示条）都带 `data-dt-ui`，切分 / 观察器 / 点击补扫都会跳过；大块界面放进 closed Shadow DOM，不受网页样式影响。文案用 `DT.uiText(zh, en)` 跟随界面语言
- **配置变了要跟着变的模块**用 `DT.onConfig(fn)` 订阅（外观、站点规则、悬浮入口），`main.js` 的 `loadConfig` 读完后统一 `DT.emitConfig`
- **调度用的纯函数放 `core.js`，挂成 `DT.*`**（自检页能直接测）。约定：不读 `window`、不调 `getBoundingClientRect`、不碰 DOM 状态，矩形/时间等全部由调用方传参。现有：`distanceOf` / `nearView` / `batchLimits` / `nextRetry` / `joinSlots` / `matchesHotkey` / `keyFromCode` / `isEditableTarget`

---

## 13. Anthropic / Gemini 实机验证记录

2026-10 已由海外协作者实机验证通过：模型列表、测试连接、整页翻译、划词翻译都正常；「思考模式 → 尽量关闭」也没有出现“带思考过程”的提示。

下面保留回归清单。以后改引擎层、升级协议或服务商换接口时，按这几步过一遍；报错时仍然回传四项。

### Anthropic Claude

1. 设置 → 提供商 `Anthropic Claude` → 填 Key（`sk-ant-...`）
2. 「获取模型列表」→ 应看到 claude-* 列表（走 `GET /v1/models`）
3. 「测试连接」→ 期望「连接正常 · xxx ms」
4. 打开英文页面 `Alt+A` 整页翻译；再划词翻译一段
5. 把「思考模式」切到「尽量关闭」再测试 → **不应**出现“带思考过程”的提示

### Google Gemini

1. 设置 → 提供商 `Google Gemini` → 填 Key（`AIza...`）
2. 「获取模型列表」→ 应只出现能对话的模型（embedding 会被过滤）
3. 「测试连接」
4. 整页翻译 + 划词
5. 如果报「当前网络所在地区不被 Gemini 支持」→ 出口 IP 仍被判定为不支持地区，换节点再试

### 报错时请回传这四项

| 项 | 在哪看 |
|---|---|
| 引擎 | 设置页「接口协议」 |
| 地址 | 设置页「API 地址」 |
| HTTP 状态 / 错误码 | 「测试连接」的结果，或 `edge://extensions` → Service Worker 控制台 |
| 错误原文 | 同上 |

### 预期行为（不是 bug）

- Anthropic 已带 `anthropic-dangerous-direct-browser-access: true`（浏览器直连必需）
- Gemini 3 用 `thinkingLevel`、2.5 用 `thinkingBudget`，由模型名自动选择
- 「尽量关闭」发送的参数：Anthropic `thinking.type=disabled`、Gemini `thinkingConfig`
- 服务返回 400 且提示不认识参数时，扩展会自动去掉参数重试一次（会成功，但思考没关掉）

---

## 14. 本版技术记录（0.8.0）

> 每次发版整节替换成这一版的内容（规则见 [AGENTS.md](AGENTS.md)）；旧版本的技术细节看 git log 和 commit message。

- **新增欢迎页** `welcome/`：四步引导（欢迎 / 功能 / 配置 / 开始），单页 + 左侧步骤导航；零构建、无第三方依赖、无远程字体 / 脚本 / 图片；功能插图用 HTML/CSS 画「原文 + 译文」「划词气泡」「字幕」「模型芯片」「术语行」，页面上明确标注「示意图 · 实际界面以扩展为准」，不伪装真实截图。
- **首次安装判断** `lib/welcome.js`：`shouldOpenWelcome(details)` 只在 `reason === 'install'` 返回 true；`background.js` 的 `onInstalled` 用它决定是否 `chrome.tabs.create({url: chrome.runtime.getURL('welcome/index.html')})`，更新 / 浏览器重启都不打开；`welcomeOpened` 防止同一 worker 生命周期重复打开。移除了原先「安装且没有 Key 就打开设置页」的行为，改由欢迎页的「打开设置」按钮进入设置。
- **手动重开**：设置页侧栏新增「使用指南」，弹窗底部新增「指南」，都通过 `lib/welcome.js` 的 `openWelcomePage()` 打开；只创建标签页，不写配置、不触发安装逻辑、不清空任何设置。
- **语言与主题**：复用 `lib/i18n.js`，新增欢迎页中→英映射，`test/welcome.test.mjs` 会扫描欢迎页 HTML，检查每条中文文案和 `aria-label / title / placeholder` 都有英文（示意图里的示例译文用 `data-i18n-skip` 跳过）。语言优先级为已保存 `uiLang` > 浏览器语言；新安装若浏览器非中文，会把初始 `uiLang` 写进配置，避免「欢迎页英文、设置页中文」。主题复用 `lib/ui-theme-boot.js` + `applyUiAppearance`，语言 / 主题按钮的改动保存到配置。
- **无障碍与响应式**：步骤按钮支持 Tab、方向键、Home / End；切换步骤后焦点落到标题；步骤按钮有 `aria-current` / `aria-controls`；外链带 `noopener noreferrer`；`prefers-reduced-motion` 关闭动画；980px 以下步骤条横向滚动、卡片单列，390px 下完成按钮与分页不重叠；首帧等语言应用后再显示，避免英文用户先看到中文。
- **商店包**：`tools/package-store.mjs` 白名单加入 `welcome/`，并显式校验 `welcome/index.html`、`welcome/welcome.css`、`welcome/welcome.js` 三个入口文件；`test/package-store.test.mjs` 覆盖欢迎页资源入包、缺失资源拒绝出包、manifest 仍在 ZIP 根目录。
- **测试**：新增 `test/welcome.test.mjs`（13 条：安装判断、语言默认值、getURL、手动打开、远程资源 / 内联事件、四步结构、英文覆盖、权限不新增、后台接线、入口存在、配置写入边界）；Node 测试 15 个文件全部通过；无头 Chrome 检查了中英文、深浅色、1440px 桌面与 390px 窄屏。
- **未实机验证**：本机 Chrome 155 headless 不加载 `--load-extension`（用最小扩展复现同样不加载），所以「Chrome / Edge 首次安装自动打开」「商店包安装后资源加载」没有在真实扩展进程里跑；改用 CDP 注入 chrome API 模拟验证了语言 / 主题持久化、设置按钮和版本号显示。首次安装 / 更新 / 重启的判定由纯函数单测覆盖。
