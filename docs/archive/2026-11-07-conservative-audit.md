# Rimefox 0.17.5 全仓库审计与保守优化

> **一次性审计归档，2026-11-07。** 当前开发约定见 [AGENTS](../../AGENTS.md)，运行时契约见 [HANDOFF](../../HANDOFF.md)，排期见 [ROADMAP](../ROADMAP.md)。

基线是 GitHub `main` 的 [5528126](https://github.com/Suethekitten/Rimefox/commit/55281261ce0a403b4bd22d569002b1bc36c23028)（GitHub 比对为 identical）；开始时本地 `main` 干净，manifest、`DT.VERSION` 和 package 都是 0.17.5。使用独立工作树 `audit/conservative-0175`。下文代码位置指向基线行号。P0 是已确认的正确性或资源问题，P1 是值得控制的复杂度或尚待复现的风险，P2 是局部改善；优先级和修复风险分别评估。

审计从 manifest 注入与打包边界开始，沿网页收集、调度、后台、存储、渲染与恢复追踪；另检查阅读器、字幕、原生组件、设置 / 弹窗 / 欢迎页及测试、打包与本地化接线。第三方库、生成的数据与二进制资产按调用和分发边界检查，未逐行审计供应商源码。审计依据为 [翻译引擎交接](../TRANSLATION-ENGINE-HANDOFF.md)、[Shadow DOM](../SHADOW-DOM-ADAPTER.md)、[阅读器架构](../READER-ARCHITECTURE.md)、[PDF 交接](../PDF-HANDOFF.md)、[字幕契约](../VIDEO-SUBTITLES.md)、[OCR 协议](../OCR-INTERFACE.md)、[原生组件](../../native/ocr-host/README.md)及[升级契约](../UPGRADING.md)。

| 优先级 / 位置 | 现状、影响及优化价值 | 建议 / 预期收益 | 风险、验证和处置 |
|---|---|---|---|
| **P0-1** [reader/reader.js:90,1599–1640](../../reader/reader.js#L1599)、[translate.js:177–192,215–217](../../lib/reader/translate.js#L177)、[epub.js:245–253,303–314](../../lib/reader/epub.js#L245) | 关闭阅读器后，页面状态清掉 `doc`，但模块单例仍引用停止的翻译器。其 `doc`、`section` 未清空；章节加载器与资源读取闭包仍持有解包条目。即使没有在途请求，刚关闭的 EPUB 仍被保留至替换文档或卸载页面。这是可由引用链确认的有界滞留，未证明每次开关都累积一本书。 | 单独明确“暂停 / 换章”和“关闭文档”的边界；停用后释放文档引用，用请求时快照保留已经付费的晚归缓存写入。收益是关闭大书后允许回收解包内容。 | **中**；同一个翻译器还参与配置恢复、预取与晚归写入。先在 Chrome 用合成大 EPUB、强制 GC/堆快照验证引用链；测关闭中有在途请求、关闭后重开命中、快速换章/换书及 TXT/Markdown。**提案**，本轮不改文档生命周期。 |
| **P0-2** [background.js:297–327,331–368](../../background.js#L297)、[lib/subtitle-budget.js:27–41](../../lib/subtitle-budget.js#L27) | 已有的字幕账本读失败时，catch 以空快照初始化并缓存；相同的已耗尽额度可被当作新额度。在基线用真实后台路由和假存储预置两份已耗尽的标签页账本：正常读取返回 `subtitle_budget`、零 HTTP；仅让另一份账本的读取抛错，原本应拦截的同类请求却成功，假 HTTP 增加一次。没有访问真实模型。 | 将“没有账本”和“账本暂不可读”分开。经维护者决策后，在读取失败时按明确策略处理，避免忽略已有额度；同时验证节流写入期间 worker 被回收的边界。 | **高**；会改变异常时的字幕可用性及费用边界。先将上述故障注入纳入 `subtitle-budget-pipeline`，覆盖单标签/全局及正常恢复，再做 Chrome worker 回收 E2E。**独立修复提案**。 |
| **P1-1** [content/dom.js:1868–1982,4636–4678](../../content/dom.js#L1868)、[units.js:36](../../content/units.js#L36)、[core.js:208](../../content/core.js#L208) | 诊断遍历与实际收集都用 `flowBreaks`、`usableChildren`、`shouldDescend`，却各自表达分支顺序。实际收集还处理活跃渲染、Shadow 与撤销，诊断跳过这些副作用。纯文本规范化和 DOM 字符映射也有共同规则，但后者要保留源偏移及硬换行证据。 | 先用 fixture 明确两遍历应一致和应不同的情况；如有新增漂移，仅共享无写入的形态判断。文本层共享前先证明空白、BR、全角缩进与映射不变。收益是诊断更可信，避免站点规则只改一边。 | **高**；影响单元、送翻次数、DOM 保真。用自检、青空/多段/Ruby/控件夹具、Science/Nature 与链接顺序回放逐单元比对；**提案**。 |
| **P1-2** [content/main.js:1510–1616](../../content/main.js#L1510)、[shadow.js:200–290](../../content/shadow.js#L200)、[dom.js:2044–2065,4771–4785](../../content/dom.js#L2044) | 两个观察器有相似的外部节点判断，但 document 还登记新增宿主、处理克隆并标记上下文，Shadow 另管观察边界和释放。document 回调遇第一条有效变更即返回；同一批后续记录不会在该回调经过登记、克隆或上下文处理。定时补扫可能弥补，未证明实站漏译。翻译前的 `pruneDetached`、收集入口与 Shadow 回调也都可触发 Shadow 清理；不能直接判为冗余。 | 先构造一个回调内“普通改字 → 新宿主 / 克隆 / 标题变更”的回放，量记录数、收集次数、请求数和断开节点。再考虑把逐记录记账与单次调度拆开；确认独立调用者后才调整 prune 位置。 | **高**；影响 B 站评论、动态补翻、AI 精翻快照和还原。需 Shadow 夹具、SPA/虚拟滚动、双语/仅译文、悬停及长时堆验证；**提案**。普通运行的强引用数组和注册表有 prune/restore，未据此判定无泄漏。 |
| **P1-3** [background.js:373–851](../../background.js#L373)、[lib/cache.js:78–205,282–355](../../lib/cache.js#L78)、[lib/provider.js:76–174](../../lib/provider.js#L76) | 后台已共用消息路由、并发闸门和在途表，但编排同时持有条目索引、分批、行内校验、术语、对齐、隐私和写缓存决策，跨阶段状态难跟。三层缓存按需提升、分段写入；清空代际拦旧结果。provider 的拒绝思考参数表限于当前 worker 生命周期，重启重试是现行行为。未证实存在可删的并发层或重复 HTTP。 | 为现有请求与缓存验收建表驱动回放（空响应、复核、身份隔离、清空中晚归）；有覆盖后再抽取只返回判定的纯函数，保留闸门、持久层和 provider 各自边界。收益是能独立读懂验收和缓存写入条件。 | **高**；影响隐私、缓存命中及模型费用。需要 translate/inline/privacy/auth/usage/background/cache 测试和假 API 请求计数；**提案**。不持久化思考拒绝表，也不改重试、队列或缓存键。 |
| **P1-4** [lib/config-storage.js:38–184](../../lib/config-storage.js#L38)、[lib/config-broadcast.js:13–44](../../lib/config-broadcast.js#L13)、[options/options.js:1036–1068,1195–1214](../../options/options.js#L1036) | 配置写队列、凭据提交标记和广播指纹各有职责；单标签发送失败可在下次刷新时重试，设置页另有草稿保护。广播的后台读取失败会结束当前刷新，且其失败处理不同于设置页的主动退避重读；未证实正常流程丢设置。 | 先用故障注入分别覆盖设备凭据提交中断、广播读失败/标签无应答，确认新配置最终如何抵达，再决定是否需要自动重试。收益是维护时能区分已提交、已广播和已应用。 | **高**；跨标签同步及凭据边界。跑 session-keys、options-save、watch-config 并补故障注入。**提案**，保持当前队列、重试与恢复。 |
| **P1-5** [lib/reader/translate.js:326–338,417–433](../../lib/reader/translate.js#L326) | EPUB、TXT 和 Markdown 已经共享 `BookDocument`、阅读进度和正文翻译器。正文与下章预取仍分别拼装相同的 `translate` 信封：当前目标、风格、`noCache`、配置身份、行内协议、可选强度。一边漏改会导致缓存隔离或送翻差异。 | 在该模块内复用请求构造，保留两条路径各自选出的文本、发出时点、代际和缓存写入。以后添加公共请求字段只需维护一处。 | **低**；影响两条路径的内部消息。对照原始信封、跑 reader batch/contract/cache 与 Chrome 阅读器。**实施**。PDF 独立分批，块序与坐标仍由 PDF 负责。 |
| **P1-6** [reader/reader.js:1333–1411,1560–1640,1786–1833](../../reader/reader.js#L1333)、[lib/reader/pdf.js:110–204](../../lib/reader/pdf.js#L110)、[reader/pdf-layout.js:14](../../reader/pdf-layout.js#L14) | PDF 视图切换、打开和关闭分别管理渲染代际、画布、OCR 与译文；正文的章节进度和 PDF 页锚点虽同存储，含义不同。异步 render / OCR / zoom / close 交叉，简单合并容易漏清理或错误复用坐标。 | 优先补上视图切换/缩放同时关闭的取消与像素预算回归，再整理有同一所有者的清理步骤。坐标算法和版式覆盖沿既有 [0.18 交接](../NEXT-MINOR-HANDOVER.md)单独推进。 | **高**；PDF 缓存、进度、坐标、资源释放。需要 PDF reader、resource-hardening 和真机 OCR 图页验证；**提案**。 |
| **P1-7** [content/subtitles.js:79–147,420–518](../../content/subtitles.js#L79)、[YouTube 来源:20–102](../../content/subtitles-source.js#L20)、[Bilibili 来源:116–278](../../content/bilibili-subtitles-source.js#L116) | 轨道代际、懒翻译、叠层和关闭恢复已共用。来源层都在把事件归一成轨道，但 YouTube 的 timedtext/广告/ASR 与 B 站的 bvid/cid、CDN 白名单、在途拉轨不是等价实现。白名单在前后两侧都做，已有差分测试。 | 有第三个来源或明确漂移时，先复用**契约测试**（轨道切换、旧响应、无轨、同语言、关闭后原生恢复），保留来源专用判断与请求所有权。收益是适配器新增/改动时能检查同样的运行时不变量。 | **中**；影响字幕轨身份、请求费用和原生字幕。现有两平台单测、预算管线、离线 B 站 E2E 及联网人工轨验证；**保留实现**。 |
| **P1-8** [Windows Program.cs:26–78,104–170,205–272](../../native/ocr-host/windows/Program.cs#L26)、[macOS main.swift:15–42,87–182,215–230](../../native/ocr-host/macos/Sources/main.swift#L15) | 两端都以小端长度帧处理 v1 `hello/recognize/cancel`，串行识别、有限排队、限制响应体并回收任务。WinRT 位图/流用 `using`，队列和 token 在 finally 释放；Vision 用独立串行队列和锁，清理与取消检查由宿主控制。引擎语言选择、像素变换与错误映射是平台行为。复制协议约束有漂移可能，未确认协议不兼容。 | 两平台运行同一组帧 / 错误 / 取消 / EOF 测试，扩充畸形帧与断开中的任务样本，比较语义字段，允许平台诊断和原文识别差异。 | **中**（测试低，生产协议高）；Native Messaging、安装器与阅读器 OCR。跑 native-host/installer、Chrome OCR 与 Windows 实机矩阵；**测试提案**，不重写宿主、不动安装或签名。 |
| **P2-1** [background.js:1204–1240](../../background.js#L1204) | 恢复记忆的写入和读取各自解析同一个 `sender.tab.url`，都在解析失败时使用空字符串。误换成缓存使用的 `hostOf(sender)` 会失去端口并改用 frame URL。 | 共用一个只读标签页 URL 的私有 helper，保留 `URL.host` 与失败回退；只留一处定义恢复范围。 | **低**；影响刷新/返回自动恢复。核对端口、iframe 与无 URL 的兼容语义，跑全量 Node/Chrome；**实施**。 |
| **P2-2** [welcome/welcome.js:43–58](../../welcome/welcome.js#L43)、[lib/ui-appearance.js:37–53](../../lib/ui-appearance.js#L37) | 欢迎页已引用公共外观模块，却另写一份相同的主题应用代码，包括主题属性、`colorScheme` 与首帧缓存。样式变量和开关几何已由 `ui-tokens.css` 共用；不同页面的排版和字节数显示格式不能统一。 | 欢迎页使用已导出的 `applyUiTheme`，保留按钮、动画、保存时点和静态首帧脚本。收益是三页遵守同一个主题缓存规则。 | **低**；影响欢迎页主题初始化及切换。跑 welcome、ui-theme、i18n、真实 Chrome 设置 / 欢迎页；**实施**。 |

必须保留的兼容分支：`DT.inject` 旧签名和替换记录视图、无登记 DOM 的还原兜底、Ruby 范围扫描、同父链接事务顺序和外部改写保护；旧分段/整层缓存迁移、短文本与非法回包的不同处理、句对齐旁路与无对齐时本地回退；按服务商分槽及设备/会话凭据两阶段恢复；阅读器旧书文件回退和删书后拒绝晚归写入；字幕提供商各自的原生轨道选择与恢复。文件大本身不构成缺陷。

## 修改前验证

Node 24.22.1 的 `tools/checks.mjs unit` 通过；当时原生宿主尚未构建，平台/构建相关项有跳过。随后 macOS 宿主构建、签名验证、协议和隔离安装器专项通过。Chrome 157 在受限 shell 启动会收到 SIGABRT，使用临时配置在沙箱外运行后，两种动画偏好的 selftest 以及浏览器矩阵中的会话密钥、设置保存、阅读器、PDF 通过。主 E2E 的基线只有窄视口悬浮球几何断言失败（`transform: none`），本轮不改该功能或放宽断言。Edge 未安装。

## 实施与前后对照

| 本地提交 | 文件 | 行为等价证据 |
|---|---|---|
| `bddba58` | [lib/reader/translate.js](../../lib/reader/translate.js) | 将正文和预取的消息字段收口到私有函数，调用方仍保有各自的待翻单元、配置快照与写入时点。用基线两处原实现和新调用逐字比较序列化输出，120 个对照覆盖目标回退、plain/趣味风格、行内协议和身份有无；全部一致。阅读器专项和 Chrome 章末预取回归通过，切章请求计数前后均为 6 → 6。 |
| `ae37b8f` | [background.js](../../background.js)、[test/background-state.test.mjs](../../test/background-state.test.mjs) | `resume:set/get` 共用标签页 host 解析；存储名、消息应答、错误退回和带端口的匹配保留。新增路由回归在修改前后均通过：同一顶层 host/端口允许续翻，frame URL 改变不影响，端口改变拒绝，缺失标签页 URL 保留原兼容行为。 |
| `9d4951c` | [welcome/welcome.js](../../welcome/welcome.js) | 删除欢迎页自己的主题应用，三处调用转到同一已导出函数。Chrome 分别加载基线和工作树、核对路径派生的扩展 ID；两版均通过 auto → dark → light → auto，检查了 DOM 属性、`colorScheme`、首帧缓存与可信配置。 |

产品与回归测试 diff：4 个文件，52 行新增、56 行删除。其余改动仅为本归档与索引。未改变 manifest、版本、依赖、公共接口、存储 Schema、缓存身份、模型请求策略、DOM 注入或原生代码。

## 验证矩阵

macOS arm64，Chrome 157.0.8103.38，Node 24.22.1。使用各自的临时浏览器配置和本地假 API；未读取已有配置或调用付费模型。计数只对应本次运行。

| 命令 / 项目 | 基线 → 优化后 |
|---|---|
| `RIMEFOX_TEST_INSTALLERS=1 node tools/checks.mjs unit`（已构建相同的 macOS 宿主） | 226 通过、2 跳过 → 227 通过、2 跳过，零失败；两跳为 Windows 专项。修改后另按 HANDOFF 逐个运行 `test/*.test.mjs`，退出 0。 |
| `node tools/checks.mjs browser`（Chrome） | 两版 selftest 在两种动画偏好均 269/269；会话凭据 / 设置保存 / EPUB、TXT、Markdown / PDF 分别 30/30、22/22、49/49、74/74。包括回收/重启、跨标签同步、关闭重开、预取/缓存、PDF 切换与释放。 |
| `node tools/e2e-extension.mjs`（离线夹具） | 301/302 → 302/302；基线唯一失败为窄视口悬浮球，优化后未复现，没有改动悬浮球或该断言。两版都是 170 次假 API HTTP、337 条送翻、2 次思考参数被拒。覆盖双语/仅译文/恢复、动态补翻、配置广播、语言/风格、文献引用、B 站轨道切换/恢复/缓存。 |
| `node tools/e2e-inline-layout.mjs`、`node tools/e2e-link-order.mjs` | 两版均通过：三个视口/缩放组合各 557/557，链接顺序、节点身份、点击与恢复 613/613。 |
| `node tools/e2e-settings-nav.mjs` | 两版均通过；另有欢迎页主题与设置同步专项。 |
| `node tools/e2e-extension.mjs --aozora-live` | 优化后真实青空文库《罗生门》13/13；实际网页、假接口。29 段、悬停、Ruby 显隐、双语切换、动态新增和关闭后逐字还原。 |
| `sh native/ocr-host/macos/build.sh`、`node tools/e2e-ocr.mjs` | 同一份构建通过 arm64/x86_64 架构检查与 ad-hoc 签名验证；真实 OCR、协议、取消/重试、临时安装、浏览器联调与卸载通过。Chrome OCR 两版均 72/72。未运行 Intel 实机。 |
| `node tools/e2e-extension.mjs --youtube-only --youtube <仓库样本>` | **未通过**。基线与优化后重试均能切到英文轨，但 120 秒内运行时未取得该视频的轨道，没有发翻译请求（均 3/6）。优化后首试另遇到 video 节点在检查后消失。不能据此验收联网 YouTube。 |
| `node tools/e2e-extension.mjs --youtube-only --bilibili-subtitles <仓库样本>` | **未通过**。真实播放器页面用合成字幕。优化后两轮首次叠层未出现；加诊断重跑时两版均 22/24。随后将两个 Git 快照依次加载到同一个临时目录（同扩展 ID、独立 profile），再次均 22/24，复现同两项既有失败：重新开启翻译 / CC 后未恢复叠层。离线 B 站端到端和两平台运行时单测通过；未验证真实登录态字幕。 |
| `RIMEFOX_TEST_BROWSER=edge node tools/checks.mjs browser`、Windows OCR | Edge 未安装，未能启动；当前宿主为 macOS，不能运行 Windows WinRT、安装器/注册表专项或 Windows/Ubuntu 浏览器矩阵。 |

环境排查：同一 Chrome 测试在 shell 沙箱中早退；构建后在沙箱中运行 Vision 也返回内部错误。改用临时 profile、允许系统 OCR 后，上表的本地离线套件通过。OCR 来源校验需要 Git 元数据，不能使用仅有源码的 `git archive` 目录跑完整 Node 矩阵；最终基线使用隔离 Git 克隆。

## 性能与请求

复现：在同机依次运行 `node tools/stability-audit.mjs --ref 5528126 --json /tmp/rimefox-before.json` 与 `node tools/stability-audit.mjs --json /tmp/rimefox-after.json`。两次 benchmark 和加载的五份内容脚本 SHA-256 均相同。该工具在直接页面测 `collect/inject/restore`，跳过 MV3 消息、API 与模型延迟；它不是端到端首译计时。

| 指标 | 基线 | 优化后 |
|---|---:|---:|
| 50 万字符段落首次收集 / 注入 / 重扫 | 84.2 / 12.1 / 4.2 ms | 84.2 / 11.9 / 4.2 ms |
| 3000 段含 Ruby 首次收集 / 注入 / 重扫 | 376.1 / 22.3 / 7.5 ms | 376.7 / 22.5 / 7.5 ms |
| 1 万 DOM 节点首次收集 / 注入 / 重扫 | 54.5 / 231.4 / 44.5 ms | 48.3 / 235.5 / 45.8 ms |
| 模拟动态插入/删除与重扫（20 轮，每轮 20 个节点） | 459.2 ms；GC 后 5.4 MB | 501.9 ms；GC 后 5.4 MB |
| 500 段反复收集、注入、还原（10 轮） | 49.6 ms；GC 后 6.3 MB | 53.0 ms；GC 后 6.3 MB |
| 500 段重复循环（加测 500 轮，每 100 轮释放临时单元、强制 GC 采样） | 5 个样点及移除容器后均 5.5 MB | 5 个样点及移除容器后均 5.5 MB |
| Chrome 医学正文夹具：仅改动态导航 | 1 次增量扫、0 次重建/还原 | 1 次增量扫、0 次重建/还原 |
| Chrome 全量离线 E2E：假 HTTP / 送翻条数 | 170 / 337 | 170 / 337 |

两次 bench 均逐场景还原成功、未尝试访问网络，均以 2 退出（3000 段收集超过脚本 100 ms 告警阈值）。相同脚本的一次前后差值不作为性能变化结论。500 轮加测从同一 HTML 基准把循环上限改为 500；在每轮 `DT.restore()` 后清掉当前 `units`，每 100 轮调用已有 `gc()` 并记录 `heapMB()`。两版样点均未增长；这只覆盖本地 DOM 循环，不能证明数小时运行、长时 MV3 / PDF 资源或第三方网页都没有泄漏。本轮收益是减少规则分叉，不主张提速。

本地结项：以 `git diff --stat origin/main...HEAD` 查看总 diff；`git diff --check origin/main...HEAD` 通过。最终 GitHub 比对仍以 5528126 为远端主线。版本保持 0.17.5，本次没有用户向 CHANGELOG，也未推送、发 Release 或提交商店。
