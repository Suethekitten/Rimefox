# 2026-11-05：系统 OCR 预览与文档阅读本地验证

本轮在 Windows 开发环境实施。没有推送、创建 Release、上传安装包或运行远端工作流。扩展版本保留 0.16.6，建议验收完成后的新功能版本为 0.17.0；尚未定稿版本或 CHANGELOG。

## 核对实际代码后的初始缺口

| 范围 | 起点的实际缺口 | 本轮处理 |
|---|---|---|
| 扩展开放 | OCR UI 总开关关闭，缺 nativeMessaging 可选权限；旧设计暴露未实现后端 | 开放明确标注的系统预览，仅 system / off；旧 auto / paddle 偏好在产品路由中归一为 system；主动点击申请权限 |
| Windows | 已有本机识别原型，但没有普通用户安装 / 卸载、宿主注册、升级或真实分发路径 | 用户级脚本、精确 ID、空格 / 中文路径、SHA-256、版本目录、Chrome / Edge 注册备份恢复、语言诊断及本地 ZIP；未打包 API 的系统支持仍有限 |
| macOS | 旧 Vision 原型及构建脚本，没有固定 Library 安装 / 卸载；当前机器不能验证新版 | 补齐安装 / 卸载、任务队列与校验、通用构建和 macOS 双架构 CI；本轮仅 shell 语法检查，未编译或运行 Vision |
| 分发与说明 | 文档把 PaddleOCR、签名和公证列成开放前置，未区分各交付层级 | 改为系统预览独立交付，保留未来后端和签名能力；未发布下载禁用；安装和系统安全限制以 INSTALL 为准 |
| 隐私 / 验收 | 缺扫描图像与送翻文字的隐私边界、真实扫描质量、安装后浏览器测试 | 更新中英文隐私说明，执行下列本机验证并保留未测项 |

当前使用和维护流程以 [OCR-INTERFACE](../OCR-INTERFACE.md)、[组件 README](../../native/ocr-host/README.md)、[INSTALL](../../native/ocr-host/INSTALL.md) 为准；这里只保留一次性证据。

## 执行环境与结果

实际 Windows OS build `10.0.22631.0`、x64、`packaged: false`。连接器 `0.2.0-preview.1`，协议 v1；检测到 `en-US`、`ja`、`zh-Hans-CN`。没有安装系统语言组件、申请提权或修改全局安全策略。

| 验证 | 实际执行结果 |
|---|---|
| `node --test test/*.test.mjs` | 205 项，204 通过、0 失败；1 项安装集成默认跳过，另行显式运行 |
| `node test/ocr-native-host.test.mjs` | 最新 Windows exe 的 5 项通过：真实夹具、MIME / 尺寸 / 语言 / 协议校验、缩小、分片帧与排队取消；系统 API 未提供硬件设备证据时不冒报 CPU / GPU |
| `RIMEFOX_TEST_INSTALLERS=1 node --test test/ocr-installers.test.mjs` | Windows 实际脚本通过；测试私有 HKCU 路径与空格 / 中文安装目录；检查拒绝无效 ID / 外来注册 / 错误校验、重复安装、不同二进制升级、许可保留、卸载恢复与额外文件保留 |
| `node tools/e2e-ocr.mjs`，Chrome / Edge 分别执行 | 各 62 / 62；真实浏览器、参考宿主、真实 Windows OCR 和实际安装器生成清单；包括扫描 PDF 识别、搜索、缓存、送翻、语言缺失、版本不兼容、失败 / 重试、取消 / 换书 / 关书，以及正文过滤后的页码文字 PDF 不触发 OCR |
| `node tools/e2e-reader.mjs`，Chrome / Edge | 各 49 / 49；EPUB 迁移 / 删除 / 缓存，TXT / Markdown 导入与双列、Markdown 安全处理、默认 1 GB 与用户 2 GB 设置持久化；LOG 扩展名路由另由 Node 单测覆盖 |
| `node tools/e2e-pdf-reader.mjs`，Chrome / Edge | 各 74 / 74；默认双列、实际缩放、语言与配置缓存身份、旧任务隔离、版式译文位置 / 溢出 / 插图抽样像素、切语言 / 缩窗、超大 PDF 双画布预算与关书释放；假 API 按目标语言回包 |
| `node tools/e2e-session-keys.mjs`，Chrome | 30 / 30；会话 / 设备 Key、真实浏览器重启及 chrome://extensions 重新加载；文章页为本地真实浏览器夹具，不调用付费服务 |
| `node tools/e2e-settings-nav.mjs`，Chrome / Edge | 全部通过：记住密钥与悬停对照开关同为 52×24 px、真实点击；所有可见行、第四行停留、减少动态效果、125% 缩放、隐藏 OCR 与不等高行、键盘跳过隐藏项 |
| `node tools/check-selftest.mjs`，Chrome / Edge | 各自 no-preference / reduce 均为 269 / 269 |
| Windows 构建、本地打包 | .NET SDK 8.0.427 / runtime 8.0.33，自包含 exe；商店与扩展用户 ZIP 的白名单打包通过；原生 ZIP 含各文件 SHA256SUMS、外附 ZIP SHA-256、源码身份、实际依赖许可 |
| `bash -n`，Mac install / uninstall / build | 语法检查通过；不是 macOS 运行证据 |

另用 `RIMEFOX_OCR_PREVIEW_ZIP` 指向实际生成的完整 Windows ZIP，显式运行安装集成：外层 SHA-256 和包内各文件校验通过，再从 ZIP 执行安装、升级和卸载；测试包括升级前后来被其他宿主替换、明确重新接管后的备份更新，以及卸载时保留后来的外来注册。它是本地 ZIP 验证，仍不等于真实下载安全验收。

Chrome `156.0.8078.80`，Edge `156.0.4314.58`。隔离浏览器加载的当前源码目录是 `D:\DSH\CodexWorkspace\Rimefox`，扩展 ID `cogofldpapijkkakgjjpbmggianclhpd`；OCR E2E 的两个临时副本有各自 ID，安装器使用当次实际值，没有写死用户 ID。临时宿主注册在结束时恢复；没有留下一套永久安装给用户。

权限测试边界：未授权夹具保留可选权限，检测加载不弹权限、点击才调用请求，以及注入拒绝结果；已授权夹具用测试 manifest 的必需权限模拟已授予状态。**没有人工点击验收真实权限确认对话框**。不能把这些结果写成用户已同意授权。

全量检查曾捕获参考宿主测试的 Windows 管道竞态：取消后立刻主动销毁子进程，尚未写完的 stdin 帧可能产生 EPIPE。测试夹具现在仅在已主动 kill 的进程上接收预期的关闭错误，其余错误仍失败；针对该取消用例连续重跑通过，再跑全量检查。没有据此放宽产品协议、语言或缓存校验。

版式预览采用合成 PDF（彩色图形 / 背景与白色文字框）及假译文；不是用户截图对应原 PDF 的验收，不是导出的译文 PDF。复杂背景、字体、颜色、表格、公式、扫描页擦除和极长译文的限制见 PDF-HANDOFF。插图检查是已知位置的像素抽查，不是对任意文档的全页像素保证。

## 真实扫描质量

使用本机真实 Windows OCR，未调用翻译 API。源扫描来自 Wikimedia 公版书页：

- [Alice in Wonderland.djvu](https://commons.wikimedia.org/wiki/File:Alice_in_Wonderland.djvu)，第 10 个图像页（印刷页 4）。原 JPEG 解码成 PNG，另派生顺时针 3° 斜图及上下两段不同内容并排的双栏输入。
- [上海图书馆《農書三卷蠶書一卷於潛令樓公進耕織二圖詩一卷》](https://commons.wikimedia.org/wiki/?curid=147681943)，PDF 第 12 页的真实竖排繁体扫描预览图。没有把它误称为《蠶書》正文页。

精简、带输入 SHA-256 / 分辨率 / 参考转写的机器结果见 [quality.json](2026-11-05-system-ocr-quality.json)。原图、PNG、cases.json 和完整原始结果保留于忽略的 `reader/pdf-real/ocr-preview/`，不进仓库或扩展包。可复跑 `node tools/evaluate-ocr.mjs reader/pdf-real/ocr-preview/cases.json`。

| 输入 | 宿主识别耗时 / 整体耗时 | 输出 | 抽查结果 |
|---|---|---|---|
| 英文原扫描 | 219 / 247 ms | 41 行，2878 字符 | 230 个正规化字母 / 数字的人工参考片段，0 编辑，片段 CER 0% |
| 同一扫描派生 3° 斜图 | 313 / 331 ms | 40 行，2880 字符 | 同一片段 0 编辑；不代表任意角度、低清或真实倾斜页面均通过，也没有实现主动纠偏 |
| 真扫描片段派生双栏 | 114 / 125 ms | 26 行，1862 字符 | 本例先左栏、后右栏；有 `up` → `un` 等错误，未算整页 CER，也没有真实多栏期刊质量保证 |
| 《農書》竖排繁体 | 213 / 221 ms | 48 行，390 字符 | 本机只有简体中文模型；38 字人工参考片段 34 编辑，片段 CER 89.47%，大量乱码，当前不能用于可靠古籍转写 |

CER 的范围必须与数字一起读：先 NFKC、转小写、只留字母 / 数字，再计算人工参考与 OCR 输出任一连续片段的最小编辑距离；不是全页 CER，忽略的标点和空格未验收。仅顺序执行一次，没有统计均值、冷启动分布或峰值内存。繁体语言模型没有安装，不能以此评价正确繁体模型或 Apple Vision。合成中文夹具证明基本链路可用，不是中文真实扫描质量结论。

## 未测与外部阻碍

- Windows 干净机器、Windows 10 各版本 / ARM64 / S 模式 / 企业策略，真实浏览器下载 ZIP 的 MOTW / SmartScreen，以及未打包 Windows OCR 的完整兼容范围。微软文档的 package identity 限制已写入组件 README，当前开发机成功不消除该限制。
- 新版 Swift 在 macOS 上的实际编译、Apple Silicon / Intel 与 macOS 12 最低系统启动；CI 文件已实现但未推送执行，不报告 CI 成功。
- Mac 浏览器下载、解压后隔离属性、Gatekeeper / 单程序例外的实际提示，以及固定用户 Library 安装后的 Chrome / Edge 启动和 Documents 授权行为。
- 真实权限对话框的同意 / 拒绝、真实翻译服务收费调用、真实 YouTube / Bilibili 页面回归、本轮以外的 Linux 矩阵，均未在本轮重新验收。
- 真实简体中文横排扫描、繁体中文 OCR 模型、更多低清 / 倾斜 / 表格 / 多栏样本；未测峰值内存。PaddleOCR、GPU / CPU 回退、签名和公证不是本轮交付项。

需要在 Mac 执行的具体清单唯一维护在 [组件 README 的 Mac 实机验收](../../native/ocr-host/README.md#mac-必须补的实机验收)。未获许可不推送、不触发远端 CI，不把任何本机静态检查当成该清单已通过。
