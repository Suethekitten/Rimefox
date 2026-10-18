# DualTrans 交接文档

> 给接手开发的创作者：这份文档覆盖**它是什么、怎么跑、代码怎么组织、哪些坑已经踩过、下一步该做什么**。
> 版本：0.4.7 ｜ 目录：`edge-bilingual/`

---

## 1. 这是什么

一个 Edge / Chrome 的 **MV3 浏览器扩展**，核心能力是网页双语对照翻译：

- 整页双语对照翻译（正文保留原文，界面元素单语）
- 仅译文模式（原地替换，保留页面布局）
- 动态内容补翻（MutationObserver + 点击补扫 + 悬停补扫）
- SPA 前进/后退/路由切换自动续翻
- 弹窗内的随手翻译（不依赖页面）
- 只用**自己的** OpenAI 兼容 API（DeepSeek / 智谱 / 硅基流动 / 通义 / 自建网关）

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
应显示 **37 / 37 全部通过**。这个页面不联网、不花钱，改完 DOM 引擎先跑它。

---

## 3. 目录与职责

```
edge-bilingual/
├── manifest.json          MV3 清单（权限、注入点、快捷键、入口页）
├── background.js          service worker：消息中枢、并发闸门、批处理、缓存、重试
├── lib/
│   ├── config.js          配置默认值 + 存储读写 + 配置版本迁移
│   ├── provider.js        OpenAI 兼容接口客户端（错误翻译成人话）
│   └── cache.js           LRU 翻译缓存（4000 条）
├── content/               内容脚本（classic script，不能 import）
│   ├── core.js            命名空间 DT、文本工具、DT.send（带超时）、toast
│   ├── dom.js             ★ 切分 + 注入 + 还原 + 诊断（核心，改动风险最高）
│   ├── main.js            调度：开关、批处理、观察器、快捷键、看门狗
│   └── styles/inject.css  译文样式与主题
├── popup/                 工具栏面板（含随手翻译）
├── options/               设置页（含快捷键录制）
└── selftest/              离线自检（37 条用例）
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
   │                                   ├─ LRU 缓存命中直接返回
   │                                   ├─ 未命中 → provider.chat()
   │                                   ├─ 解析 JSON 数组（含兜底）
   │                                   ├─ 429/5xx 自动重试 3 次
   │                                   └─ 回写缓存
   │   ◄──────────────────────────────┘
   ├─ 每批回来立即注入（渐进渲染）
   └─ 页面上直接出现译文
```

### 消息协议（content → background）

| type | 入参 | 返回 | 说明 |
|---|---|---|---|
| `translate` | `{texts: string[], target: string}` | `{ok, results: (string\|null)[], failed, cached, error}` | 核心翻译。`results[i]` 为 `null` 表示该段失败 |
| `config:get` | — | `{ok, config}` | 读配置。**不含 `apiKey`**，换成 `hasKey: boolean`（Key 不进内容脚本） |
| `test` | — | `{ok, ms, model, sample}` / `{ok:false,error}` | 测试连接 |
| `cache:clear` | — | `{ok}` | 清缓存 |
| `stats` | — | `{ok, cacheSize}` | 调试用 |
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
| `dt:retranslate` | — | 快照 | 清空重翻 |
| `dt:diagnose` | — | 诊断报告对象 | 见第 7 节 |
| `dt:configChanged` | — | 无 | 后台在 `storage.onChanged` 时广播；内容脚本重拉配置、清零失败退避并补扫。内容脚本**不要**自己监听 `storage.onChanged`（事件里带完整配置含 Key） |

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

**四种情况改为原地替换**（`injectOnly`：替换元素的文本节点，保留子元素如图标）：

| 条件 | 原因 |
|---|---|
| `mode === 'translation'` | 仅译文模式 |
| `isPositioned()`：fixed/sticky/absolute | 盒子尺寸写死，追加必溢出（昵称、日期、浮层标签） |
| `isControlLike()`：a/button/label/summary/option/role=* | 真控件，追加会撑破按钮 |
| 导航/页头里 + 小字号(≤20px) + 单行 | 导航条固定高度，追加会溢出 |

> ⚠️ **不要**把"文本短"或"元素是 flex"单独作为替换条件。
> 0.3.1 试过"短文本 + 父级是 flex-row 就替换"，结果在 Tarkov 这种整页 flex 布局的站点上，
> 标题和正文全被替换，用户看到的是"原文被译文顶掉了"。现在的判据必须同时满足上面表格。

### 5.3 `textOf()` 必须排除自己的节点

`textOf(el)` 递归时跳过 `[data-dt-target]` 和 `[data-dt-ui]` 子树。
**否则**增量重扫时会把"原文 + 已注入的译文"当成新文本再翻一次，表现为同一段译文出现两遍。

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

---

## 7. 调试手册

### 7.1 自检页
```
chrome-extension://<扩展ID>/selftest/index.html
```
37 条纯前端用例，覆盖切分、注入、替换、还原、长文拆分。**改 `dom.js` 前后必跑。**

### 7.2 诊断按钮
弹窗底部「诊断」→ 生成 JSON 并复制到剪贴板，包含：

- `units[]`：每个翻译单元（tag / class / display / position / 是否因过短跳过 / 是否被判成已是目标语言）
- `skipped[]`：被跳过的元素及**原因**（`display:none` / `tag-skip` / `already-translated` / `our-ui` / `our-node`）
- `placements[]`：每条译文的投放记录（`where: inside|replace`，是不是 span）
- `summary`：计数

页面控制台也能取：`copy(JSON.stringify(__DT_LAST_DIAG))`

### 7.3 日志
- 设置页勾选「输出调试日志」→ 网页 Console 过滤 `[DualTrans]`
- API 报错原文：`chrome://extensions/`（Edge：`edge://extensions/`）→ 卡片 →「Service Worker」→ 控制台

---

## 8. 配置项（`lib/config.js`）

| 键 | 默认 | 作用 |
|---|---|---|
| `baseUrl` | `https://api.deepseek.com/v1` | OpenAI 兼容 base，自动补 `/chat/completions` |
| `apiKey` | `''` | 只存 `chrome.storage.local`，仅 background 可读 |
| `model` | `deepseek-chat` | |
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
| `debug` | false | 输出调试日志 |
| `_v` | 3 | 配置版本，用于升级时纠偏性能字段 |

---

## 9. 已知问题（诚实清单）

1. **仅译文模式下短中文会留下空白** —— 站点给容器写了固定高度，中文比英文短 40%，填不满。无通用解，只能按站点写规则或改用双语。
2. **行内标签不在译文里保留** —— 段落里的 `<b>` / `<a>` 会被整段重写，译文是纯文本，不带原格式。
3. **`<br>` 分隔的长帖**读起来是"一整段"，没做逐行对照（route 在图中的 `roadmap`）。
4. ~~没有图标~~（0.4.7 已加：`icons/`，源文件是 `icon.svg` / `icon-small.svg`，PNG 用无头 Chrome 渲染）
5. **没有 i18n**，界面固定中文。
6. **没有站点规则库**，全部靠通用启发式；重前端站点（SPA 框架、虚拟滚动）可能漏翻。
7. **浏览器快捷键（manifest 里的 Alt+A）只是建议**：被其它扩展占用时浏览器不会分配给我们，而且按键在浏览器层就被那个扩展拿走，页面内快捷键也收不到。扩展没法自己改浏览器快捷键，只能引导用户去 `chrome://extensions/shortcuts`（Edge：`edge://extensions/shortcuts`）；设置页和弹窗会用 `chrome.commands.getAll()` 显示实际绑定结果

---

## 10. 下一步路线（按性价比排序）

| 优先级 | 任务 | 预估 | 风险 |
|---|---|---|---|
| P0 | **结构保真**：给文本节点打占位记号，要求模型保留 `<b>`/`<a>` 并回填 | 中 | 中（要改注入层） |
| P0 | ~~可视区优先~~（0.4.3：按离屏幕距离排序取批，分级批次）+ ~~懒翻译~~（0.4.4：远处的滚到附近再翻） | — | — |
| P1 | **划词翻译**：`mouseup` 取选区 → 浮气泡 → 复用 `translate` | 小 | 低（约 150 行） |
| P1 | **输入框翻译**：`Alt+I` 翻译当前输入框内容并回填 | 小 | 中（要处理 IME） |
| P2 | **站点规则**：`{matches, textSelectors, excludeSelectors}` 配置化 | 中 | 中 |
| P2 | **按 `<br>` 拆行**：长帖逐行对照 | 小 | 低 |
| P3 | ~~图标~~（0.4.7）+ **i18n** | 小 | 低 |
| P3 | PDF / 视频字幕 / 图片 OCR | 大 | 高（单独立项，别混进这个仓库） |

---

## 11. 发版流程

1. 改 `manifest.json` 的 `version`
2. 改 `content/core.js` 的 `DT.VERSION`（保持两者一致，不一致时 Actions 会直接报错）
3. 扩展管理页 → 点重新加载 → 刷新页面（`F5` / Mac `⌘R`）
4. 跑自检页：必须 **37 / 37**
5. 手动过一遍三个站点：普通文章页、纯俄语页、SPA 帖子流
6. 更新 `CHANGELOG.md`：标题必须是 `## <版本号> — <标题>`，Release 说明就从这里摘
7. 推送到 `main`：`.github/workflows/release.yml` 会自动跑自检，从同一份构建目录打包
   `DualTrans-v<版本号>.zip` 和 `DualTrans-v<版本号>.crx`（`.github/scripts/build-release.sh`），
   逐项校验（`.github/scripts/verify-package.py`：版本号、引用资源、ZIP 与 CRX 逐字节一致、CRX 签名、不含私钥），
   全部通过才创建 `v<版本号>` 的 Release，并确认两个文件都在。任何一步失败都不会发版。
   同一版本只发一次，已有 Release 或标签就跳过，不会覆盖；没改版本号的推送不会发版。

### 11.1 CRX 签名私钥（一次性配置，之后每个版本复用）

CRX 的扩展 ID 由签名私钥决定。**私钥一旦用于发版就不能换**，换了扩展 ID 就变了，已经用 CRX 装过的用户会变成另一个扩展。

1. 在仓库外面生成私钥（不要放进仓库目录）：
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/dualtrans-crx-key.pem
   ```
2. 转成一行 Base64：macOS `base64 -i ~/dualtrans-crx-key.pem | tr -d '\n'`，Linux `base64 -w0 ~/dualtrans-crx-key.pem`
3. 仓库 **Settings → Secrets and variables → Actions → New repository secret**：名字 `CRX_PRIVATE_KEY_BASE64`，值填上一步的 Base64。
   个人账号下的仓库只有**仓库所有者**能配置 Secret
4. 把 `dualtrans-crx-key.pem` 备份到密码管理器等安全的地方，然后删掉本地明文副本。丢了就只能换私钥（扩展 ID 会变）
5. 可选：算出扩展 ID，在 **Variables** 里加 `CRX_EXPECTED_ID`。之后私钥配错时 Actions 会直接失败，而不是发出一个 ID 不同的包：
   ```bash
   openssl pkey -in ~/dualtrans-crx-key.pem -pubout -outform DER | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p'
   ```

私钥只在 Actions 的打包步骤里解码到临时目录（权限 600），用完即删；`.gitignore` 已忽略 `*.pem` / `*.key` / `*.crx`。

### 11.2 试运行（不发版）

GitHub 仓库 → **Actions → Release → Run workflow**，保持勾选「试运行」：只构建和校验 ZIP + CRX，
产物作为 artifact 上传（保留 7 天），不创建标签和 Release。改了打包流程或换了私钥后先跑一次。

本地也能跑同一个脚本（需要 Chrome 和私钥文件，输出目录要在仓库外）：
```bash
CRX_KEY_FILE=~/dualtrans-crx-key.pem CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  bash .github/scripts/build-release.sh /tmp/dualtrans-dist
```

---

## 12. 代码约定

- 内容脚本用 **ES5 风格**（`var` / `function`），避免任何构建期语法转译需求
- 后台与设置页可以用 ESM + 现代语法（`let`/`const`/箭头函数）
- 所有 DOM 注入必须带 `data-dt-*` 属性，便于诊断与还原
- 新增"跳过规则"前先想清楚：会不会把**可见内容**也跳过（坑 6、7）
- 新增"替换规则"前先想清楚：会不会把**正文**也替换（坑：Tarkov 全页 flex）
- 任何改动都先跑自检页，再上真实站点
