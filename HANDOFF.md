# 凛狐 Rimefox 交接文档

> 给接手开发的创作者：这份文档覆盖**它是什么、怎么跑、代码怎么组织、哪些坑已经踩过、下一步该做什么**。
> 版本：0.6.2 ｜ 目录：`edge-bilingual/`
> 翻译引擎（收集 → 分段 → 批量 → 解析 → 缓存 → 注入 → 还原）的实现细节、0.8.7 的优化、外部项目参考（Wenyi / Agent Book Translate）与后续路线，
> 单独写在 [docs/TRANSLATION-ENGINE-HANDOFF.md](docs/TRANSLATION-ENGINE-HANDOFF.md)；改翻译链路前先读它。

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
应显示 **135 / 135 全部通过**。这个页面不联网、不花钱，改完 DOM 引擎先跑它。
自检页只在直接加载仓库目录时才有：商店包和 0.8.6 起的 GitHub Release 包只收运行时文件（`tools/package-store.mjs` 的白名单），设置页里的「打开自检页」会自动隐藏。

---

## 3. 目录与职责

```
edge-bilingual/
├── manifest.json          MV3 清单（权限、注入点、快捷键、入口页；名称 / 简介用 __MSG_*__）
├── _locales/              manifest 文案（zh_CN / en）：名称、简介按浏览器界面语言显示
├── background.js          service worker：消息中枢、并发闸门、批处理、缓存、重试
├── lib/
│   ├── config.js          配置默认值 + 存储读写 + 版本迁移（v6）
│   ├── provider.js        接口门面：chat() / listModels()，按 engine 分发
│   ├── engines/           各协议实现（openai / anthropic / gemini）
│   ├── providers.js       内置提供商模板（地址 + 协议 + 关闭思考的参数）
│   ├── parse.js           模型返回值解析（JSON 数组容错）+ 换行规范化 + 写入前校验 + 输出长度护栏
│   ├── prompt.js          翻译提示词（普通 / 趣味风格 / 结构化对齐共用目标语言约束），纯函数
│   ├── lang-guard.js      目标语言保守校验：英文等拉丁字母目标却整段回中日韩正文（缓存定向失效用），纯函数
│   ├── cache.js           三层翻译缓存：内存 + storage.session（8000 条）+ storage.local（短文本，512 KB）
│   ├── privacy.js         可选的本地脱敏 / 恢复（纯 JS，无依赖）：识别、占位符、fail-closed 恢复
│   ├── usage.js           仅调试用的用量计数：HTTP、usage token、缓存、重试、拆批、失败、finish_reason
│   ├── appearance.js      强调色预设、译文排版变量、译文自定义 CSS 清洗（纯函数，后台按网址算 page 对象用）
│   ├── site-rules.js      站点规则：内置规则、校验、按网址匹配；夜间模式网站名单
│   ├── ui-appearance.js   设置页/弹窗共用：强调色等写到 <html>、深浅色圆形过渡、跨页面配置同步、空闲执行
│   ├── ui-theme-boot.js   设置页/弹窗的首帧主题与外观预判（<head> 同步执行，避免闪一帧白底）
│   ├── ui-tokens.css      弹窗 / 设置页 / 欢迎页共用的设计变量：材质、三级文字、强调色派生、圆角、阴影、字体；深浅色与「减少透明 / 关闭阴影」都在这里切换（各页面 CSS 首行 @import）
│   └── welcome.js         首次安装判断 / 欢迎页语言默认值 / getURL 打开（纯函数，可单测）
├── content/               内容脚本（classic script，不能 import）
│   ├── core.js            命名空间 DT、文本工具、DT.send（带超时）、toast
│   ├── units.js           翻译单元结构层（纯函数）：文本映射 / 段落 / 句子 / 对齐校验 / 签名
│   ├── dom.js             ★ 切分 + 注入 + 还原 + 诊断（核心，改动风险最高）；站点规则的只翻 / 跳过区域
│   ├── appearance.js      网页里的外观：强调色、译文排版、自定义 CSS、页面明暗、夜间模式写到 <html> 上
│   ├── main.js            调度：开关、批处理、观察器、快捷键、看门狗；DT.control 给悬浮入口用
│   ├── selection.js       划词：右键菜单 / 选区按钮 / 气泡（翻完可「置顶」、可「加入术语表」）
│   ├── input.js           输入框翻译（0.9.0）：可编辑区域里按快捷键 / 右键菜单，翻完原地写回（可撤销）
│   ├── subtitles-core.js  YouTube 字幕纯函数（解析 json3、拼句）；自检页与 YouTube 运行时共用
│   ├── subtitles.js       YouTube 字幕运行时：懒翻译、叠层显示（只在 YouTube 加载）
│   ├── youtube-hook.js    页面主环境（world: MAIN）：捕获播放器的字幕请求，转给 subtitles.js
│   ├── hover.js           悬停对照：高亮同一处的原文和译文，替换型单元弹原文气泡
│   ├── pip.js             置顶翻译窗：Document Picture-in-Picture，不支持时退回 window.open 小窗
│   ├── dock.js            悬浮入口：Shadow DOM（closed）里的小球 + 按钮列；拖拽 / 吸附 / 半隐藏，默认关闭
│   └── styles/inject.css  译文样式与主题、页面明暗适配、夜间模式反色
├── welcome/               首次安装欢迎页 / 新手引导（index.html + welcome.css + welcome.js，无构建）
├── popup/                 工具栏面板（含随手翻译）
├── options/               设置页（提供商模板、模型选择器、快捷键录制、外观 / 站点规则交互、设置搜索；拆分见 options/ 下各模块）
├── test/                  Node 单测（引擎 / 配置 / 提供商模板 / 回包解析 / 缓存 / 提示词 / 目标语言校验 / 外观 / 站点规则 / 界面语言 / 隐私脱敏 / 欢迎页 / 字幕运行时竞态 / 用量诊断）
├── tools/                 打包（package-store.mjs）、发版说明检查、真实浏览器端到端检查（e2e-extension.mjs，见 7.1c）
└── selftest/              离线自检（201 条用例；e2e 脚本会顺带跑一遍，见 7.1c）
```

**为什么内容脚本是 classic script 而不是 ESM？**
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
| `translate` | `{texts: string[], target: string, style?: string, noCache?: boolean, pageLang?: string}` | `{ok, results: (string\|null)[], failed, cached, error}` | 核心翻译。`results[i]` 为 `null` 表示该段失败。`target: 'auto'` = 跟随页面语言（配 `pageLang`，即 `<html lang>`，认不出来用英文）；`noCache: true` = 不读也不写三层缓存，输入框翻译用（草稿 / 私信不落盘）|
| `config:get` | — | `{ok, config}` | 读配置。**不含 `apiKey`**，换成 `hasKey: boolean`（Key 不进内容脚本）。`config.page` 是后台按发送方网址算好的 `{accent, customCss, typo, site, night, provider}`（自定义 CSS 已清洗、站点规则已匹配） |
| `mode:set` | `{mode}` | `{ok}` | 悬浮入口切显示方式后记进配置；只接受 `dual` / `translation`，内容脚本改不了别的配置项 |
| `hover:set` | `{value: boolean}` | `{ok, value}` / `{ok:false,error}` | 悬浮入口切悬停对照；只接受严格布尔值，内容脚本不能改其他配置项 |
| `glossary:add` | `{source, target, overwrite?}` | `{ok, action}` / `{ok:false,error}` | 划词气泡「加入术语表」。两个字符串各 ≤200 字，清洗 / 去重 / 限条数复用 upsertGlossaryEntry。action 是 added / updated / same（已有这条）/ conflict（同名原文另有译法，带 current 回去问用户，确认后带 overwrite: true 再来）。错误：too_long / bad_value / full（满 500 条）|
| `test` | — | `{ok, ms, model, sample}` / `{ok:false,error}` | 测试连接 |
| `cache:clear` | — | `{ok}` | 清空三层缓存（storage 里的 `dt.cache.v1.*` 分段和清单一并删掉） |
| `cache:stats` | — | `{ok, stats: {memory, disk, hits, misses}, bytesInUse: {session, local}}` | 设置页「翻译缓存」卡片用；`bytesInUse` 是浏览器实际记的占用 |
| `usage:stats` | — | `{ok, stats}` / `{ok:false,error}` | 仅 `debug` 开启时；HTTP 请求、usage token、缓存、重试、拆批、失败、finish_reason 计数，不含正文 / Key |
| `usage:reset` | — | `{ok}` | 仅 `debug` 开启时；清空累计用量统计 |
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
| `dt:translateInput` | — | 无 | 右键菜单「凛狐：翻译输入框内容」：翻译当前聚焦的输入框（有选区只翻选区），原地写回 |
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
├── parse.js          模型返回值解析（JSON 数组容错、换行规范化、写入前校验）
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

### 5.1 切分（`dom.js` 的 `walk` + `addParagraphs`）

0.9.1 起，**一个翻译单元 = 一个 ParagraphUnit（语义段落）**，不再等于一个元素。
`walk` 仍决定"下钻还是整体"，但整体元素里的文本会再按空行切段：

```
对每个元素：
  1) 没有子元素          → addParagraphs()（一个或多个段落单元）
  2) 子元素全被跳过      → 只翻自己的直接文本（ownText），仍按段落切
  3) 有直接文本 / 不该下钻 → addParagraphs()（一个或多个段落单元）
     其中「有直接文本、但夹着块级 / 控件子元素」（0.9.7）→ 只收自己的行内文字（flowTokens），
     单元标成局部（partial：不 whole、不打 data-dt-src），再下钻那些子元素
  4) 容器（无直接文本）  → 逐个下钻到子元素
```

> ⚠️ 0.9.7 容器保护：以前第 3 步只要有直接文本就整棵子树当一段，`shouldDescend` 的控件 / 块级判据被短路；
> 一个零宽字符就能让 SPA 的 `.container` 整块压平（Partner Center 白屏）。现在由 `breaksFlow(parent, kid)` 判断：
> 可见的块级 / flex 子项，或（非正文块里）带交互控件的子元素，会打断父级的行内文字流。
> `flowTokens` 照常拼直接文本、`<br>`、链接 / 强调 / ruby，打断文字流的子元素记成一个空行（`{ br: kid, boundary: true }` ×2），
> 所以块前块后各成一段，双语锚点就是那个子元素；`lineGroups` 不把 boundary 当 `<br>` 收起。
> 判据只看结构、不看文字比例：「See `<a>`很长的链接`</a>`.」「`<span>`Hello`</span> <span>`World`</span>`」仍是一句。
> 局部单元不能打 `data-dt-src`（`isSkipped` 会让整棵子树以后不再扫描，懒翻译到不了屏幕外的子段落），
> `walk` 入口对 `el.__dtPartial` 不做「已全部渲染」早退；最后一段的双语锚点是「这段文字之后」，不是容器末尾；
> ruby 只认文字流里的（标题里的注音归标题自己的单元）。诊断的 `walkDiag` 用同一判据。

`addParagraphs` 的步骤：

1. `tokensOf(el)`（或 own 单元的 `ownTokens`）按阅读顺序给出文本节点 / `<br>`；
2. `DT.units.textMap(tokens)` 生成规范化文本 + 每个字符的 DOM 映射；
3. `DT.units.paragraphsOf()` 按空行（`\n\n`）切段；**单个 `<br>` / `\n` 只是同一段里的行**；
4. 段落边界：空行（连续 `<br>` / `pre-*` 连续换行）；或单个 `<br>` 后的新行同时有**源码换行 + 行首全角缩进**（青空文库）；或块级元素。
   其它单个 `<br>` 只是段内换行；**不能**把每个 `<br>` 都当段落。`pre-*` 单文本节点里的空行 / 缩进仍是一个单元（行级结构保留）；
   如果整棵子树只切出一个单元、却有 8+ 个 `<br>` 行且超过 800 字，按行拆成可诊断单元（`fallback='line'`），不静默变成巨型单元；
5. 每个单元记录 `anchor`（分隔空行的第一个 `<br>`；最后一段 / 独占元素为 null → append 到元素末尾）。

`shouldDescend(el)` 决定"容器"还是"段落"（与 0.9.0 相同）：
- flex/grid 容器 → 下钻（一排并列的条目）
- 有真正的块级子元素 → 下钻
- ≥3 个并列子元素 → 下钻（列表、菜单）
- 其余（如 `<h1><span>Hello</span> <span>World</span></h1>`）→ 作为一个整体

> ⚠️ 标准段落 `<p>Hello <strong>beautiful</strong> world.</p>` 是一个单元，跨 3 个文本节点；
> 不要因为行内 `<strong>` 把它拆成多段。

**已翻译元素的重新检查**：`data-dt-src` 只在「元素整块已渲染且源文本签名没变」时才等于跳过。
有渲染记录、但签名变了 / 译文被站点删了的元素，`walk()` 照常重新判断：先撤掉原文已变的双语段落，再按现在的结构收集。
own 单元（第 2 步，只翻了直接文本）不覆盖子元素，不走整块早退。子元素露出来时按现在的结构重收：露出的是子菜单等块级子元素，
双语那段撤掉、按局部段落重插到子块前面（替换型原地写的，留着不闪），子块各自下钻；露出的是行内子元素就撤掉、并成整段。
以前整块翻过、现在要下钻的元素（第 4 步）先撤掉整块旧译文。只改了子元素 class / style、每段原文都没变时记下新签名，不重翻。
父级判断子元素时 `data-dt-src` 仍算跳过（坑 3）。

### 5.2 注入策略（`DT.inject`）

**双语**：独占元素的段落把译文节点 append 到元素**内部末尾**（跟随源元素的盒子、字号、对齐）；
共用容器的段落把译文插在**分隔空行的第一个 `<br>` 之前**（P1 → 译文1 → 空行 → P2 → 译文2 …）。
0.9.0 的「所有译文都 append 到容器末尾」只适用于独占元素，多段落容器不再这样处理。

**三种情况改为原地替换**（`injectReplace`：替换本段落的文本节点，保留子元素如图标；有分行时按行写回，见 5.2.1。含 Ruby 的段落走 `injectRuby`）：

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

### 5.2.1 分行、段落与 Ruby（0.9.2）

- **送翻文本**：`DT.units.textMap` 与 `DT.normalizeLines` 同一套规则——`<br>` 和
  `white-space: pre / pre-wrap / pre-line` 里的 `\n` 是硬换行；普通元素里源码的折行算空格；
  行首尾空白（含全角缩进）去掉，行内全角空格保留；连续硬换行最多留一个空行。
- **段落**：空行（`\n\n`）分段；单个换行是同一段里的行。连续 `<br><br>` 的容器会形成多个
  ParagraphUnit，各有独立锚点；这是青空文库 / 小说页逐段对照的基础。`DT.splitLong` 只负责请求长度，
  不再决定页面段落。
- **仅译文写回**（`injectReplace` / `injectLines`）：按行分组（`lineGroups`，与 `textMap` 同一套切法），
  第 i 行译文写进本段第 i 行第一个有字的文本节点（保留行首全角缩进），同一行其余节点清空；
  `<br>`、空行、各行所在的元素都不动。模型改了行数时按顺序填，多出的并进最后一行，
  不够的把**本段自己的**空行 / 换行收起（`data-dt-collapsed`），**不折叠段落之间的空行**。
  单行段落仍走「整段写进第一个文本节点」。
- **Ruby（仅译文）**：`tokensOf` / `ownTokens` 排除 `rt` / `rp`；`rubyAnnotationsFor` 先按字符映射找基字在本段的
  `<ruby>`，再按**本段 DOM 范围**扫所有 `<ruby>`（基字是 `<img class="gaiji">` 的图片 Ruby 没有文本字符，字符映射会漏）；`injectRuby` 清空本段正文文本、只隐藏这些 `rt/rp`（`style.display=none` + `data-dt-rt-hidden`）、
  在段落锚点插入独立译文节点。**绝不把整句译文写进 `ruby/rb/rt/rp`**，也不全局隐藏所有 `<rt>`。
- **双语**：译文里有换行时给节点加 `dt-lines`（`white-space: pre-line`），只作用在这种节点上。
- **过期译文**：注入前 `DT.sourceChanged(unit)` 用采集时的文本节点快照复核；等译文期间站点改了这段
  （SPA 重渲染、翻页复用元素）就放弃这次注入。同一元素连续 3 次都在翻译途中被改（计时器、实时数字）不再翻它。
- **悬停对照**：消费 `unit.sentences` / `unit.align`。句子对应按可信度依次取：模型的结构化对齐（`parts`，内容侧校验
  `sum(n) === 源句数` 且片段按顺序出现在译文里）→ 本地句子对齐 `units.alignLocal`（0.9.3：句长动态规划 +
  数字 / 专名锚点 + 句末语气，组可以是 1–1 / 1–2 / 2–1 / 2–2 / 1–3 / 3–1；句界和「挪一句」的最优路径比代价，
  差距不够就合并相邻组）→ 两边都 ≥2 行且行数相同按行 → 段落级。双语模式只高亮、不弹气泡；
  仅译文 / Ruby 的气泡给原文，行级 / 段落级时标明范围。**不再**用「句数相同 + 句界相对位置」猜句子。
- **渲染事务**：所有文本 / 节点 / 属性 / 样式修改都进 `DT.tx`；`DT.restore()` 逆序回放，只撤销仍是我们
  写入的值。`DT.releaseReplaced` 只放回被站点改过的替换型 / Ruby 段落；`DT.refreshStale` 只撤掉源文本
  确实变了的双语段落，兄弟段落不动。
- **段落里的保留区**（notranslate / `translate="no"` / 站点规则 `excludeSelectors` 的行内子元素）：整段单元（`tokensOf`）照样把它们的文字拼进句子，
  送翻时用 `<k1>…</k1>` 包住（`unit.wire` = `DT.units.keepWrap`；缓存按带标记的文本记），本批有标记时提示词追加「标记连同内容原样照抄、按译文语序摆放」（`lib/prompt.js` 的 `hasKeepMarks`，没标记的请求提示词逐字不变）。
  回包经 `DT.units.keepParse`：标记里的内容一律换回原文（双语 / 悬停 / 去重都用去标记的文字）。**保留元素的文本节点永远不写、不清空**：
  仅译文单行段落按标记把译文切成 N+1 段，分别写进各保留元素前后的文本节点（`keepPlan`）；模型漏了标记时按原文逐字（整词、唯一、按序）找位置；
  换了顺序 / 找不到 / 某一侧没有文本节点可写 → 兜底：整句写进非保留节点，保留元素 `display:none` + `data-dt-keep-hidden`（进 `DT.tx`，还原恢复）。
  分行段落、Ruby 段落直接走兜底（只有保留内容的那一行不隐藏）。保留区挂在 `addParagraphs` 里，三条收集路径共用：
  own 单元（子元素全被跳过：`ownTokens`，`ownText` 与它一致）和 0.9.7 的局部段落（`flowTokens`）也把**直接子级**里看得见的行内保留元素拼进句子（`keptChild`），
  否则「Install `<span class="notranslate">`Rimefox`</span>` today.」只送「Install today.」、仅译文时整句写在 span 前面；
  隐藏 / `display:none`、块级或打断文字流（`breaksFlow`）的保留元素，以及因别的原因跳过的子元素（已翻过 `data-dt-src`、译文 / 界面节点、`PRE` / `IMG` 等跳过类标签、可编辑）仍不收。
  文字流里带 notranslate 的行内 `<code>`（GitHub）、行内子元素里嵌的保留元素同样按保留区处理。整段只剩保留内容的段落不收。
- **多译文节点**：同一个容器里多个 `[data-dt-target]` 是正常的；`cleanupDuplicateTargets` 只清理
  `data-dt-unit` 相同的克隆副本，不能按「同一父级只留一个」清理。

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
   ├─ 每 200ms：按 video.currentTime 找当前句；只翻 [当前 − 3s, 当前 + 90s] 里没翻过的，8 句 / 1000 字一批
   └─ 叠层插在 .html5-video-player 里（全屏跟着走），z-index 30；播放器加 rimefox-subs-on 类隐藏原生字幕
```

- **为什么挂钩而不是自己请求**：字幕地址要带播放器生成的 `pot` 令牌，直接请求 `captionTracks[].baseUrl` 只会拿到 200 + 空内容（2026-10 实测）
- **CC 开关**看 `.ytp-subtitles-button[aria-pressed]`；换视频看地址里的 `v`，不清轨道（新字幕可能比地址栏先到）
- **会话状态**（0.8.5）：track 带 `v / lang / kind / target / style` 与 `gen / inflight / pending`。目标语言或风格一变，`invalidate()` 清空译文并把 `gen` +1，旧请求回来时按 `track === mine && gen === mine.gen` 丢弃；新目标 = 原字幕语言时 `reset()` 交还原生字幕
- **视频切换**：`inflight` 挂在 track 上，不再全局阻塞；旧视频请求的回调不碰当前 track、不改 `shown`。异步 `fetchText()` 用 `processSeq` 代际，晚完成的旧轨道不能覆盖新轨道
- **播放器重建**：显示缓存同时绑定"哪个叠层"（`shownOverlay`）；播放器 DOM 被替换后即使字幕文本相同也会重新写入新叠层。CC 关闭 / 字幕翻译关闭时移除 `rimefox-subs-on`，原生字幕恢复
- 纯函数在 `DT.subs.*`，运行时工厂 `DT.subtitleRuntime.create(env)` 可注入假 DOM / 假 send；`test/subtitles-session.test.mjs` 覆盖 A–Q 的竞态场景（含播广告时不接管、插播广告的字幕不替换正片轨道）。真实运行时只在 `youtube.com` / `youtube-nocookie.com` 启动
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
| 25 | 把 computed 字号 / 行高按 px 复制给译文，并依赖 `<html data-dt>` 控制样式 | Aeon 的 H1 是 `72px/72px`（窄屏 `42px/42px`），中文标题异常放大、行高重叠；Next.js hydration 删掉 `data-dt` 后 `.dt-target` 归一化整组失效 | 译文用 `inherit` / `em` 跟随原站响应式；CJK 大标题 0.8em、紧行高 1.25；`::first-letter` 归一化；`data-dt` 被删时 MutationObserver 补回 |
| 26 | 仅译文把多行段落整段写进第一个文本节点 | Pixiv 小说几行对白并成一大段，段尾留一串空行（`<br>` 还在、后面的 span 被清空） | 送翻保留分行，按行写回；行数对不上时收起多余 `<br>`（5.2.1） |
| 27 | 句数不同时按相对位置猜对应句 | 悬停气泡显示相邻句子的原文，看起来像「翻译错位」 | 0.9.1 删除比例猜测；0.9.3 改为动态规划 + 句界置信度：两可的句界合并成组，宁可高亮两句也不配错 |
| 28 | 同一容器多段落仍 append 到元素末尾 | 青空文库式「段1<br><br>段2」全部原文在前、译文堆在页尾 | 0.9.1 ParagraphUnit + 分隔 `<br>` 锚点；只有独占元素才 append |
| 29 | 多个段落译文共享一个容器就按「同父级只留一个」清理 | 克隆清理把兄弟段落的译文节点删掉（E2E 抓到） | `cleanupDuplicateTargets` 只删 `data-dt-unit` 相同的克隆副本 |
| 30 | 仅译文把整句中文写进 `<ruby>` / 全局隐藏 `<rt>` | 中文被 Ruby 排版规则撑开；未翻译段落的假名也没了 | 关联 Ruby 段落走 `injectRuby`：清空正文 + 只隐藏本段 `rt/rp` + 独立译文节点 |
| 31 | `paragraphsOf` 只认规范化文本里的 `\n\n` | 真实 Aozora 用「单 `<br>` + 全角缩进」，整篇被当成一个单元：双语 1 个译文节点堆页尾、仅译文清空正文后留下一串 `<br>` 巨大空白 | 0.9.2 `textMap` 在 trim 前记录源码换行 + 全角缩进，按排版语义分段；保留 `<br><br>` 规则；无法识别时按行兜底 |
| 32 | Ruby 只按字符映射关联 | 基字是 `<img class="gaiji">` 的外字 Ruby 没有文本字符，仅译文残留 3 个 `rt` 假名（真实《罗生门》） | `rubyAnnotationsFor` 再用本段 DOM Range 扫一遍所有 `<ruby>` |
| 33 | 多段落共用容器时仍按 HTMLElement 记状态 | 一段失败 / 抖动会清掉或拖住同容器其它段；懒翻译把整个容器当一个矩形 | 0.9.2 `settled` / `failures` / `churn` 改为「元素 → Map(签名+段序号)」；`DT.rectOfUnit` 用段首文本节点算矩形 |
| 34 | 句级高亮只认模型返回的 parts | 0.9.1–0.9.2 实际几乎总是整段高亮：对齐不进缓存、后台重启即丢、模型不按格式输出、本地断句与模型句数不一致（`home.11 Since` 不断句）都会让校验失败 | 0.9.3 本地对齐兜底（`units.alignLocal`），断句认脚注号 / 缩写 / 首字母 / 小写续接；模型对齐仍优先 |
| 35 | 双语模式也弹对照气泡；单行段落标「行级对应」 | 原文和译文都在页面上，气泡挡住下面的正文；一行一段时「行级」其实就是整段 | 双语只高亮不弹气泡；行级只在两边都 ≥2 行且行数相同时成立 |
| 36 | 结构化对齐的输出指令只写「第 i 段的译文对象」、示例译文固定中文 | 目标语言选英文、开着悬停对照（多句段落走 align）时日文回中文；同一目标语言下普通模式正常 | 两种模式共用「唯一目标语言：Name (code)」；`parts[].t` 点名目标语言；示例只用占位文字，并说明字段名不是译文语言（0.9.6） |
| 37 | 拖拽要等第一次 pointermove 才 setPointerCapture | 第一次移动正好落进页面 iframe 时，顶层文档收不到 pointermove，拖拽永远起不来（0.9.4 / 0.9.5 e2e 一直失败） | 小球 pointerdown 就捕获指针；面板按钮不提前捕获（0.9.5 `d9189c1`） |
| 38 | 自动隐藏按固定的 14px 换算整块 dock 的位移 | CSS 的 100% 是 dock 宽度，小球又在 dock 里居中，结果球几乎整个藏到屏幕外 | 小球水平居中，整块挪 50% = 球心贴边 = 露出半球；起拖前把这段位移折算进 host 坐标（0.9.6） |
| 39 | 自检里同步量 getBoundingClientRect 时不关过渡 | 读到的是过渡起点（style.left 已是 700、rect 还是 0），几何用例假失败 | 几何用例先关 host 的 left 过渡和 dock 的 transform 过渡再量；动画交给真实浏览器 E2E（0.9.6） |
| 40 | `data-dt-src` 一打上，`isSkipped` 就让整棵子树永远跳过 | 双语模式站点改了字，旧译文一直挂着（`refreshStale` 只在网址变化时跑）；`<li>` 只翻了直接文本，子菜单显示出来后永远不翻 | 有渲染记录的已翻译元素签名变了就重新检查；own 单元不覆盖子元素，子菜单露出来按局部段落重收（见 5.1） |

---

## 7. 调试手册

### 7.1 自检页
```
chrome-extension://<扩展ID>/selftest/index.html
```
201 条纯前端用例（需要真实计时器的用例用 `checkAsync` 排在最后逐个跑），覆盖切分、注入、替换（含区域判定 `DT.areaOf`）、还原、长文拆分、调度纯函数、简繁区分、近似重复闸门、YouTube 字幕解析与拼句（`DT.subs`）、趣味翻译单元判定、逐句悬停对照（`DT.hover`）、站点规则区域、网页外观（强调色 / 排版 / 明暗 / 夜间）、悬浮入口（含半隐藏：左右贴边露半球 / 展开收起 / 关闭自动隐藏 / 中间不缩进）、Aeon 风格大标题 / 首字下沉 / 紧行高 / 引用富文本 / 窄容器 / 仅译文首字下沉拆分回归、小说正文分行（`tpl-novel`：span + `<br>`、连续空行、pre-line、对白、行内强调、模型合并 / 拆分行、还原、切换模式、途中改原文）、0.9.1 青空文库式 3 段拆分与锚点、Ruby（普通 / rp / rb / 多个混合 / 未翻译不受影响 / 释放）、结构化对齐的合法 / 非法 / 一对多 / 多对一、断句（缩写 / 首字母 / 脚注号 / 小写续接）、本地句子对齐（一对多 / 多对一 / 数字锚点 / 调换语序整段合并）、悬停句级 / 行级 / 段落级（双语不弹气泡、没有模型对齐也逐句）、代际隔离与段落级 SPA 更新、真实《罗生门》夹具（单 `<br>`+全角缩进 / rb/rp/rt / 图片基字 Ruby / 只有 fixture 时也要跑）、0.9.7 容器保护（直接文本 + 块级 / 控件子元素不整块替换、句子不被拆、嵌套列表 / `<main>`、正文夹标题的注音归属、引用块前后分段、懒翻译第二轮仍收子段落、诊断一致）、已翻译元素重新检查（双语改字重收、只改样式不重翻、子菜单露出补收 / 译文挪到子菜单前、祖先 class 展开、仅译文不闪、整块改下钻不重复、行内子元素并成整段、原文藏起来撤译文）、段落里的保留区（notranslate / translate="no" / 站点规则排除：送翻标记、双语、仅译文原地分段写回、换序 / 漏标记兜底、GitHub 式行内 code、分行段落、0.9.7 局部段落、own 单元和局部段落直接子级的保留元素（隐藏 / 块级的不收、旁边已翻过的子元素不动）、还原逐字一致）。**改 `dom.js` 前后必跑。**（真实 Chrome 里自动跑：`node tools/e2e-extension.mjs` 的「自检页」一节）

### 7.1b Node 单测（接口层）
```
node test/engines.test.mjs     # 三种协议的请求构造 / 回包解析 / 错误映射 / 模型列表请求（48 条）
node test/config.test.mjs      # 配置迁移 / 按服务商隔离 / 导入校验（含术语表）/ 删除自定义服务商 / 输入框目标语言（45 条）
node test/providers.test.mjs   # 提供商模板完整性 + 关闭思考参数（13 条）
node test/parse.test.mjs       # 回包解析 parseArray / parseAlignedArray（结构化句子对齐）/ 换行规范化 / 写入前校验 / 思考过程兜底 / 输出长度护栏 / 单条拆句拼回（42 条）
node test/cache.test.mjs       # 三层缓存：落地恢复、字节预算、删除、清空、分段落盘与旧格式迁移（17 条）
node test/translate-pipeline.test.mjs  # 真实 background.js + 假 fetch：多转义换行、旧缓存修复、JSON 包装拦截、可修补格式不拆批、在途请求去重、术语改动、glossary:add、命中术语才注入提示词、输入框 noCache、align 对齐 / 旧缓存降级、目标语言（align / 普通 / 坏缓存定向失效 / 不写坏缓存）（28 条）
node test/prompt.test.mjs      # 提示词：普通 vs 趣味风格、align 结构化输出、温度、保留分行规则、简繁转写、两种模式共用的唯一目标语言（23 条）
node test/lang-guard.test.mjs  # 目标语言保守校验：英文目标回中文 / 正常英文 / 专名清单 / 短文本 / 中文目标不判（9 条）
node test/provider.test.mjs    # 思考模式吃空 content：关思考重试、错误信息、记住服务端不认的思考参数（6 条，假 fetch）
node test/glossary.test.mjs    # 术语表：清洗 / CSV 往返 / 命中 / 提示词与指纹 / 按命中算的缓存指纹 / 一键收录 upsert（27 条）
node test/i18n.test.mjs        # 界面中英文：静态文案 / 动态状态 / t() / 校验提示全覆盖（16 条）
node test/appearance.test.mjs  # 强调色、译文排版变量、自定义 CSS 清洗（8 条）
node test/site-rules.test.mjs  # 站点规则匹配 / 校验 / 合并、夜间名单、配置导入（8 条）
node test/welcome.test.mjs     # 首次安装判断 / 语言默认值 / 欢迎页资源、英文覆盖、权限与后台接线（13 条）
node test/subtitles-session.test.mjs # 字幕运行时 A–Q：语言/视频切换、异步轨道、播放器重建、CC/开关、广告（17 条）
node test/usage.test.mjs       # 三协议 usage 提取 + 统计聚合（6 条）
node test/usage-pipeline.test.mjs # 假 chrome/fetch：请求数、缓存、拆批、部分成功、usage 汇总（8 条）
node test/hover-config.test.mjs # hover:set 严格布尔、重复写、无网络请求、并发保存不丢项（7 条）
node test/content-main.test.mjs # 内容脚本调度：自动翻译只在顶层页面、配置广播改模式 / 语言时整页重建（7 条）
node test/sentence-align.test.mjs # 悬停对照的断句（缩写 / 脚注号 / 小写续接）与本地句子对齐：38 段人工语料每个句界都对（6 条）
```
需要 Node 18+。仓库根的 `package.json` 只为了让 Node 把 `.js` 当 ESM（`type: module`），扩展本身仍然零构建。

### 7.1c 真实浏览器端到端检查（发版前）
```
node tools/e2e-extension.mjs                                                  # 文章页 / 划词 / 加入术语表 / 输入框翻译 / 仅译文 / 还原 / 配置广播 / 简繁 / 缓存落盘 / 设置页 / 自检页
node tools/e2e-extension.mjs --youtube "https://www.youtube.com/watch?v=iG9CE55wbtY"   # 再加 YouTube 真实页面的双语字幕
node tools/e2e-extension.mjs --aozora-live   # 真实青空文库《罗生门》验收（需要能上 aozora.gr.jp；诊断写 docs/verification/）
node tools/stability-audit.mjs                # 真实 Chrome 长文 / 大量段落 / 动态 / 内存基准（直接页面）
```
真实 Chrome（`--browser` 或环境变量 `RIMEFOX_BROWSER` 可换成 Edge）+ CDP `Extensions.loadUnpacked` 加载工作树 + 本地假 OpenAI 兼容接口，不需要 API Key，不进 CI（要真实浏览器，YouTube 还要能上网）。
`--verbose` 打印扩展调试日志、YouTube 字幕请求 / 响应、钩子消息和广告开始 / 结束；`--youtube-only` 跳过文章页和设置页；`--headed` 显示窗口。
YouTube 检查固定切到英文字幕轨再翻成简体中文（YouTube 会按地区自动选中文字幕，和目标语言相同时扩展按设计不接管），遇到广告能跳就跳、跳不过就等它播完；YouTube 每次的加载情况不同，失败时先加 `--verbose` 重跑看是哪一步

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
| `inputHotkey` | `alt+i` | 输入框翻译快捷键（只在可编辑区域里生效），可在设置里录制 |
| `inputTargetLang` | `auto` | 输入框翻译的目标语言：`auto` = 跟随页面 `<html lang>`（认不出来用英文），也可固定成某个 `LANGUAGES` 值 |
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
| `dockAutoHide` | true | 悬浮入口收起时半藏；贴边吸附时只露出半个小球 |
| `customPrompt` | `''` | 追加到系统提示词末尾，进缓存指纹（改了旧译文失效） |
| `glossary` | `[]` | 术语表 `[{source, target, category?}]`，全局一份，命中才注入提示词；缓存键只带这段原文命中的术语的指纹（没命中是 `none`），加 / 改一条只让用到它的段落重翻。设置页可编辑 / CSV 导入导出，网页里划词气泡也能「加入术语表」（走后台 `glossary:add`）|
| `debug` | false | 输出调试日志 |
| `_v` | 6 | 配置版本（迁移逻辑在 `migrateConfig`） |

---

## 9. 已知问题（诚实清单）

1. **仅译文模式下短中文会留下空白** —— 站点给容器写了固定高度，中文比英文短 40%，填不满。无通用解，只能按站点写规则或改用双语。
2. **行内标签不在译文里保留** —— 段落里的 `<b>` / `<a>` 会被整段重写，译文是纯文本，不带原格式。
3. **`<br>` 分隔的长帖**：0.8.4 起译文保留分行（双语、仅译文都是），但双语仍是整段译文追加在段末，没做「一行原文一行译文」的逐行穿插对照。
4. ~~没有图标~~（0.4.7 已加：`icons/`，源文件是 `icon.svg` / `icon-small.svg`，PNG 用无头 Chrome 渲染）
5. **站点规则库还很小**：内置规则只有 GitHub 文件列表和 Wikipedia 语言列表两条，其余靠通用启发式和用户自己写的规则；重前端站点（SPA 框架、虚拟滚动）可能漏翻。
6. **浏览器快捷键（manifest 里的 Alt+A）只是建议**：被其它扩展占用时浏览器不会分配给我们，而且按键在浏览器层就被那个扩展拿走，页面内快捷键也收不到。扩展没法自己改浏览器快捷键，只能引导用户去 `chrome://extensions/shortcuts`（Edge：`edge://extensions/shortcuts`）；设置页和弹窗会用 `chrome.commands.getAll()` 显示实际绑定结果
7. **划词没有独立快捷键** —— 快捷键监听在 `main.js`，按计划等 P0 拆分后再统一成"有选区就划词、没选区就整页"的自适应键
8. **不支持 OpenAI Responses 协议**（`/v1/responses`）——目前只有 OpenAI 兼容（chat completions）/ Anthropic / Gemini 三种。遇到只开 responses 的第三方接口会 404，见第 10 节 P3
9. **网页夜间模式是反色实现**：`filter: invert(1) hue-rotate(180deg)` + 媒体元素反向回正；画布绘制的界面、CSS 背景图、自带深色主题的网站可能显示异常，所以默认关闭、只对名单里的网站生效。
10. **置顶小窗依赖浏览器能力**：Document Picture-in-Picture 需要 Chrome 116+；退回的 `window.open` 小窗不会置顶，网页设置了 COOP 等隔离或拦截弹窗时打不开（会提示）。
11. ~~振假名会混进原文 / 仅译文残留假名~~（0.9.2 已在真实青空文库《罗生门》验证：29 段、双语逐段、仅译文 0 个可见 `rt`、关闭后逐字恢复；Pixiv 真实注音页仍只有 fixture）
12. **Ruby 段落仅译文用独立译文容器**：为了不把整句中文写进 `<ruby>`，含注音的段落不再按基字逐词替换，局部排版可能与原页略有差异；竖排（縦書き）/ `writing-mode: vertical-*` 未验证
13. **真实网站覆盖**：0.9.2 只对青空文库《罗生门》做了真实页面验收；Pixiv / GitHub / Aeon / OWID / YouTube 仍只过了本地 fixture 或旧版检查，不能当成已验证
13. **结构化句子对齐依赖模型遵守输出格式**：不遵守时自动降级为行 / 段落级（页面照常显示）；真实模型下的遵守率与译文质量尚未用 API Key 验证
14. **目标语言校验是保守的定向失效**：只覆盖「英文等拉丁字母目标却整段回中日韩正文」这种高置信度情况；短文本、专名 / 术语清单不做自动失效，旧缓存里的这类条目可能保留，重新翻译即可覆盖；中文 / 日文目标方向没有做自动校验

---

## 10. 下一步路线（按性价比排序）

| 优先级 | 任务 | 预估 | 风险 |
|---|---|---|---|
| P0 | **拆 `main.js`**：把纯函数（离屏距离、取批上限、退避时间表）抽到 `core.js`，只动这两个文件 + 自检页；动手前先问协作者有没有并行改动 | 中 | 中 |
| P0 | **结构保真**：给文本节点打占位记号，要求模型保留 `<b>`/`<a>` 并回填 | 中 | 中（要改注入层） |
| ~~P1~~ | ~~**输入框翻译**~~（0.9.0 已做：`Alt+I` + 右键菜单，选区 / 整个框、可撤销、不进缓存） | — | — |
| P1 | **划词快捷键**：监听在 `main.js`，等 P0 拆完再和整页翻译统一成"自适应快捷键" | 小 | 低 |
| P2 | **站点规则库扩充**：0.7.0 已有规则机制，按真实站点补内置规则（每条都要在保存的真实页面上验证） | 小 | 低 |
| P2 | **夜间模式改进**：自带深色主题的网站自动跳过反色；CSS 背景图更准确地回正 | 中 | 中 |
| ~~P2~~ | ~~**按 `<br>` 拆行**~~（0.9.1 已做：连续 `<br>` 拆段 + 段落锚点 + 结构化句子对齐） | — | — |
| P1 | **对齐实测**：用真实模型统计 `align` 遵守率、悬停命中率、请求 / Token 变化；弱模型降级率 | 中 | 中 |
| P3 | **OpenAI Responses 协议**（`/v1/responses`）：只有遇到"只开 responses 的第三方接口"时才需要 | 小 | 中（离线无法验证） |
| P3 | PDF / 其它站点的视频字幕 / 图片 OCR | 大 | 高（单独立项，别混进这个仓库）；YouTube 字幕已做（见 5.4） |

---

## 11. 发版流程

1. 改 `manifest.json` 的 `version`
2. 改 `content/core.js` 的 `DT.VERSION`（保持两者一致，不一致时 Actions 会直接报错），`package.json` 的 `version` 也一起改。
   取号按 [AGENTS.md](AGENTS.md)「版本号规则」：1.0 之前一律 `0.x.y`，`0.9.x` 之后是 `0.10.0`，用户提出才发 `1.0.0`
3. 扩展管理页 → 点重新加载 → 刷新页面（`F5` / Mac `⌘R`）
4. 跑自检页：必须 **201 / 201**
4b. 跑 Node 单测：`node --test test/*.test.mjs`（24 个文件、按退出码判定，应全部通过；CI 发版前跑同一条命令）
5. 手动过一遍三个站点：普通文章页、纯俄语页、SPA 帖子流
6. 更新 `CHANGELOG.md`：标题必须是 `## <版本号> — <标题>`，这一节会原样成为 Release 说明。规则见 [AGENTS.md](AGENTS.md)「发版说明」：
   每版 3–6 条、每条一句话且 ≤ 90 字、不许有子项、只写用户会感觉到什么、只写这一版。
   发版前跑 `python3 tools/check-release-notes.py <版本号>`，CI 也会跑，不合规就不发布
6b. 实现细节、取舍、内部重构、测试变化写进本文件末尾的「本版技术记录」（整节替换成这一版），以及 commit message
7. 推送到 `main`：`.github/workflows/release.yml` 依次校验三处版本号、发版说明格式、跑全部 Node 单测（`node --test`）和离线自检，
   再用 `node tools/package-store.mjs --release` 打 `Rimefox-v<版本号>.zip`（与商店包同一份白名单）、检查安装包清单，全部通过才创建 `v<版本号>` 的 Release。
   同一版本只发一次；没改版本号的推送不会发版。也可以在 GitHub 的 Actions 页面手动运行

---

## 12. 代码约定

- 内容脚本用 **ES5 风格**（`var` / `function`），避免任何构建期语法转译需求
- 后台与设置页可以用 ESM + 现代语法（`let`/`const`/箭头函数）
- 所有 DOM 注入必须带 `data-dt-*` 属性，便于诊断与还原
- 新增"跳过规则"前先想清楚：会不会把**可见内容**也跳过（坑 6、7）
- 新增"替换规则"前先想清楚：会不会把**正文**也替换（坑：Tarkov 全页 flex）
- 任何改动都先跑自检页，再上真实站点
- **界面结构约定（0.9.5 UI 重构）**：
  - 弹窗：主按钮文字写 `#toggleLabel`（按钮里还有图标和快捷键键帽 `#toggleKbd`，不能整体改 `#toggle.textContent`）；状态卡分成标题 `#statusTitle` / 计数胶囊 `#statusCount` / 详情 `#stat`（空时不占位）；趣味风格是下拉框 `#styleSelect`；分段控制器的滑块是 `.seg::before`，靠 `:has(.active)` 平移，不需要 JS。
  - 设置页：服务商胶囊（`provider-list.js` 的 `renderProviderPills`）照着 `#provider` 下拉框的选项渲染，点胶囊 = 在下拉框里选它，切换逻辑仍只走下拉框的 change；排版滑块（`appearance-ui.js` 的 `enhanceTypoSelect`）只是隐藏下拉框的镜像，`select.value` 仍是唯一数据来源；保存栏是悬浮岛，`#saveResult` 有字时（保存结果、别处改了配置）靠 `data-flash` 短暂弹出；搜索命中用 CSS Highlight（`rimefox-settings-search`）。
  - 网页内：划词气泡和「译」按钮在网页 DOM 里只能用行内样式，配色走 `selection.js` 的 `paletteOf()`（深色网页 / 夜间模式换深色玻璃）；e2e 依赖 `span[aria-label="加入术语表"]` 和按钮文字「保存 / 覆盖」，别改；页面级 `scroll` 捕获监听要忽略 `[data-dt-ui]` 里的滚动（`input.select()` 会横向滚动）。悬浮入口小球的状态点读 `DT.control.status()`（开着翻译时 700ms 一次）。
- **扩展页面的样式只用 `lib/ui-tokens.css` 的变量**（`--bg-canvas / --bg-card / --bg-subtle / --bg-elevated`、`--text-1/2/3`、`--accent` 及其派生 `--accent-hover / -soft / -ring / -border / -grad / -fill`、`--r-lg / -md / -sm`、`--shadow-card / -raise / -pop`、`--font-mono`）。不要在页面里另写一套深色变量：深色、自定义强调色、减少透明、关闭阴影都只改 ui-tokens.css。页面里的 `--bg / --card / --line / --muted …` 只是旧名别名。多层阴影里的「空阴影」写 `0 0 #0000`，不能写 `none`（整条声明会失效）；最低 Chrome 114，不能用 `light-dark()`
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

## 14. 本版技术记录（0.9.7）

> 每次发版整节替换成这一版的内容（规则见 [AGENTS.md](AGENTS.md)）；旧版本的技术细节看 git log 和 commit message。
> 0.9.6 的目标语言约束 / 悬浮球半隐藏、0.9.5 的悬停本地对齐与 UI 重构、0.9.2 的段落 / 注音修复见对应提交与 `docs/STABILITY-AUDIT-0.9.2.md`。

- **问题**：0.9.6 在 Partner Center 的扩展 Dashboard 上（页面加载中翻译、仅译文）主内容区白屏。诊断 `placements[0]` 是 `DIV.container` 的 `replace`：`walk()` 第 3 步只要有直接文本就 `addParagraphs(tokensOf(el))`，`shouldDescend` 里 0.7.2 的控件 / 块级判据被短路，整个 Dashboard 成了一个单元，`injectReplace` 把全部译文写进第一个文本节点、其余清空。最小复现只要一个零宽字符当直接文本（`directText` 不认它是空白）。同一路径还会伤到嵌套列表的 `<li>`（子项清空）、`<main>` / `<section>` 容器、正文里夹章节标题的青空文库（标题文字拼进下一段、下一段译文写进 `<h4>`）。
- **还原**：静态 DOM 上实测压平后 `DT.restore()` 逐字还原（元素没删，只清了文本节点），「还原无法重建子结构」不成立；真实页面还原后仍空白更可能是站点在压平期间接管 / 重建了节点。修复点是不再压平，还原逻辑没改。
- **容器保护**（`content/dom.js`，见 §5.1 的说明）：`breaksFlow(parent, kid)` = 可见的块级 / flex 子项，或非正文块里带控件的子元素（`CONTROL_SELECTOR`，与 `shouldDescend` 共用）；跳过类标签（图片 / 视频等）不算，`<pre>` 算。有直接文本且有这样的子元素时，`flowTokens` 拼父级自己的行内文字（直接文本、`<br>`、行内代码、未跳过的行内子元素），打断文字流的子元素记成空行边界 `{ br: kid, boundary: true }` ×2（块前块后各成一段，锚点就是该子元素；`lineGroups` 不把 boundary 当 `<br>` 收起），再只对这些子元素 `walk`。
- **局部段落**：`addParagraphs(out, el, tokens, own, partial)`。partial 单元不是 whole（不打 `data-dt-src` / `data-dt-sig`，否则 `isSkipped` 让整棵子树以后不再扫描，懒翻译第二轮收不到屏幕外的子段落）；`el.__dtPartial` 让 `walk` 入口不做「已全部渲染」早退（`addParagraphs` 自己的早退保留）；最后一段的双语锚点是「这段文字所在的直接子节点之后」；ruby 只认文字流里的（`inFlow`），且不走按 DOM 范围扫 ruby 的兜底，标题里的注音归标题自己的单元。`walkDiag` 用同一判据，诊断与真实收集一致。
- **已翻译元素重新检查**（`7581ee3`）：以前元素一打上 `data-dt-src`，`isSkipped` 就让整棵子树永远跳过——双语模式站点改了已翻段落的字，旧译文一直挂着（`refreshStale` 只在网址变化时跑）；`<li>` 只翻了直接文本，后来显示出来的 `display:none` 子菜单永远不翻。现在 `isSkipped(el, recheck)`：`walk` 对有渲染记录的元素不按 `data-dt-src` 整棵跳过，先撤掉原文已变 / 译文被删的双语段落再按现在的结构收集；own 单元和局部段落一样不走整块早退；子菜单露出时按局部段落重收、双语译文挪到子菜单前；只改了子元素 class / style 时记下新签名不重翻。父级判断子元素时 `data-dt-src` 仍算跳过（坑 3）。细节见 §5.1、坑 40。
- **段落里的保留区**（`270872e`）：整段单元会把 notranslate / `translate="no"` / 站点规则排除的行内子元素拼进句子，仅译文模式把它们清空。现在这些文字仍送翻当上下文，用 `<k1>…</k1>` 包住（`unit.wire`，缓存按带标记的文本记）；本批有标记时提示词追加一条「标记连同内容原样照抄」（`hasKeepMarks`，没标记的请求提示词逐字不变）；回包经 `DT.units.keepParse` 把标记内容换回原文。保留元素的文本节点永远不写：仅译文单行段落按标记切成 N+1 段写进前后的文本节点（`keepPlan`），模型漏标记时按原文唯一定位，换序 / 找不到 / 没处可写时整句写进其它节点、保留元素 `display:none`（进 `DT.tx`，还原恢复）。整段 / own / 0.9.7 局部段落三条路径共用（挂在 `addParagraphs` 里）；`7a8c27d` 起 own 单元和局部段落也把「容器的直接子级」保留元素（`keptChild`：看得见的行内元素，只因保留才被跳过）拼进句子，「Install <span class="notranslate">Rimefox</span> today.」不再只送「Install today.」、品牌名不再被挤到句尾。
- **没采用的方案**：BUG 文档建议的「直接文本 × 2 < 整块文字就当容器」+ 复用 `ownTokens` / `addParagraphs(..., true)`。实测：「See `<a>`长链接`</a>`.」和「`<span>`Hello`</span> <span>`World`</span>`」被拆碎；own 单元 whole=true 打 `data-dt-src`，懒翻译第二轮收到 0 个子段落；双语译文落在容器末尾；`CONTENT_TAGS` 含 MAIN / SECTION / ARTICLE / TABLE，这些仍整块；`ownTokens` 丢 ruby 基字和链接文字（青空文库「暮方」「羅生門」从句子里消失、注音照常显示）。文档里的回归用例按它自己的修法也会失败（own 单元的 el 就是那个容器），已改写。
- **行为变化**：flex 容器的子项被计算样式块化，所以「直接文本 + flex 子项」现在分开收（如 `<a style="display:flex">Settings<span>3</span></a>` 收成「Settings」，徽标数字照旧跳过）；混排容器里的 `<pre>` 不再拼进句子；正文块（p / li / td…）里的按钮仍算句子的一部分（同 0.7.2）。没有块级 / 控件子元素的元素切分完全不变。
- **测试**：自检 171 → **201**（容器保护 8 条，旧代码上 7 条失败、「句子不被拆」防比例判据那类回归；重新检查 8 条：改字重收、只改样式不重翻、子菜单补收且译文挪到子菜单前、祖先 class 展开、仅译文不闪 + 还原、整块 `<li>` 改下钻不重复、行内子元素并成整段、原文藏起来撤译文；保留区 14 条：标记解析、双语 / 仅译文 / 兜底、两个保留元素按序 / 换序 / 缺空隙、GitHub 行内 code、分行、站点规则与纯保留段落、0.9.7 局部段落、own 单元 / 局部段落的直接子级保留元素（隐藏 / 块级不收、旁边已翻过的子元素不动），均校验还原逐字一致）；Node 24 个文件全绿（prompt / content-main / translate-pipeline 各 +1）；合并后 E2E 70 / 70（含自检页 201 / 201）；`--aozora-live` 真实《罗生门》13 / 13 在容器保护提交上跑过。
- **缓存 / 配置**：不改 `SCHEMA` / `makeKey` / 配置结构 / `DT.tx` 事务语义。受影响页面的单元切分变了、带保留区的段落送翻文本多了标记，都会按新文本翻译，旧缓存不清；没有保留区的请求提示词与 0.9.6 逐字一致。
- **已知 / 未验证**：真实 Partner Center 页面（要登录合作伙伴中心）、Edge、真实付费模型未验证——尤其真实模型能否原样照抄 `<kN>` 标记只用假模型测过（漏标记 / 换序有兜底：整句写进其它节点、保留元素隐藏）。性能：own 单元元素不再整块早退，每轮增量重扫多一次样式读取；局部段落的早退按整棵子树签名，仅译文下子元素被替换后父级每轮重建一次文字流；只有保留内容的段落不收，所在元素永远不算「全部渲染」——都只影响速度，超长混排页未测。
