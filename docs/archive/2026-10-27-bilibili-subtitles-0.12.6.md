# 0.12.6 视频字幕扩展到哔哩哔哩 — 开发与 QA 交接

> **已归档**：这是 0.12.6 的一次性开发 / 验证记录。当前架构与限制以 [docs/VIDEO-SUBTITLES.md](../VIDEO-SUBTITLES.md)、[HANDOFF.md](../../HANDOFF.md) §5.4 / §14 为准。
> 下文「无 P0、无未关闭 P1」的结论已被后续独立 QA 推翻，见 [2026-10-27-bilibili-subtitles-qa-0.12.6.md](2026-10-27-bilibili-subtitles-qa-0.12.6.md)。

## 结论

- 0.12.6 在本地完成：YouTube / 哔哩哔哩共用统一字幕轨道、翻译调度、缓存身份和双语叠层；没有新增 B 站独立开关，也没有复制翻译引擎。
- 独立 QA 最终复评结论：**PASS WITH LIMITATIONS**（无 P0，无未关闭 P1；代码级复核干净）。初审指出的两个 P1 风险已处理：分 P 的 `?p` 与轨道 page 不一致立即失效（运行时 track 已带 page，并有 `DT.subtitleRuntime.create` 集成断言）；active class 缺失时可用播放器元数据 `selectedLan` / 唯一轨道 + 原生字幕层兜底。复评还发现并关闭了一个 page 字段未进运行时的 P2。
- 仍需真实登录态 Bilibili 会话复核：真实人工 / AI 字幕轨、真实 active 轨道选择器、真实多 P 播放器切换、真实全屏；本轮 Chrome E2E 用合成轨道覆盖了播放器 DOM、叠层、原生恢复和费用路径。
- 未 push、未建远端 tag、未创建 GitHub Release、未提交 Chrome / Edge 商店。

## 架构落点

```
来源适配（平台各一份）                     统一运行时（content/subtitles.js）
YouTube json3 / Bilibili player wbi v2   → 统一轨道 { platform, videoKey, trackKey, lang, kind, page, units }
                                             → 懒翻译（当前 −3s ~ +90s，8 句 / 1000 字）
                                             → cacheScope + gen / processSeq 隔离
                                             → 双语叠层 / 原生恢复
```

- `content/subtitles-core.js`：YouTube json3 + Bilibili body 纯函数；Bilibili from/to 秒转毫秒、空 / 非法 / 重复 / 超长过滤、句末合并。
- `content/subtitles-source.js`：YouTube 来源；`content/bilibili-subtitles-source.js`：Bilibili 来源（bvid/cid/page/轨道选择/白名单 URL）。
- `content/bilibili-hook.js`：MAIN world，仅观察播放器自己的 `/x/player/(wbi/)v2`，保留最近 4 份供 replay；不改请求 / 不读 Cookie。
- `background.js`：新增 `subtitle:fetch`，只给 B 站视频页、白名单 HTTPS CDN、无 Cookie、manual redirect、Content-Length/2 MB 限制；字幕请求带 `cacheScope`。
- `lib/cache.js`：缓存键追加 `subtitle-v1:platform|videoKey|trackKey|lang`；目标语言 / 风格 / 模型 / 接口 / 术语 / 提示词仍由原基础键负责。

## 测试证据

| 检查 | 结果 |
|---|---|
| 全部 Node 测试（`for f in test/*.test.mjs`） | 42 个文件全部 exit 0 |
| 新增 `test/bilibili-subtitles.test.mjs` | 20 / 20 |
| `test/subtitles-session.test.mjs`（YouTube A–Q） | 17 / 17 |
| `test/background-state.test.mjs`（含 subtitle:fetch） | 10 / 10 |
| `test/i18n.test.mjs` | 19 / 19 |
| `test/welcome.test.mjs` | 13 / 13 |
| `selftest/index.html`（Chrome 156，离线） | 269 / 269 |
| 完整 Chrome E2E（`tools/e2e-extension.mjs`） | 277 / 277 |
| Bilibili 合成轨道 E2E（`--bilibili-subtitles`） | 14 / 14 |
| YouTube 真实字幕 E2E（`--youtube`） | 9 / 9 |
| `python3 tools/check-release-notes.py 0.12.6` | 合规 |
| `git diff --check` | 通过 |
| 商店包 / Release ZIP | `dist/Rimefox-v0.12.6-store.zip` / `dist/Rimefox-v0.12.6.zip` |

Bilibili E2E 使用真实 B 站视频页 + 合成字幕轨 + CDP 拦截字幕 CDN；不读取真实字幕版权内容，不包含 Cookie / 私密字幕正文。结果保存在 E2E 临时目录的 `result.json`。

## 真实网页调查

- 在已登录浏览器中观察到播放器请求 `/x/player/wbi/v2`，响应含当前 `bvid` / `cid`、`subtitle.subtitles[]`（如 `ai-zh`，`lan_doc=中文`）和带时限 `auth_key` 的官方 `subtitle_url`。
- 直接读取该签名 `subtitle_url` 得到 `{ body: [{ from, to, content }] }`，时间单位是秒；这是解析器的真实格式依据。该调查只在本地进行，没有把真实字幕正文 / URL 写进仓库。
- 未用本轮扩展在登录态下完成真实人工 / AI 字幕轨的端到端验收；没有伪造成功。

## 已知限制 / 未支持

- 真实登录态 Bilibili 人工 / AI 字幕轨、真实 active 轨道选择器、真实多 P 播放器切换、真实全屏仍需人工复测。
- 真实 `bilibili-hook` XHR/fetch → postMessage → accept/take 路径未在登录态页面端到端复测；Node 单测覆盖 accept/take/轨道选择，E2E 覆盖 source.resolve + runtime。
- 独立 QA 复评期间，已登录 API 的匿名探测显示 `/x/player/v2` 返回 `need_login_subtitle: true` 与空 `subtitle.lan/subtitles`；这解释了为什么真实人工 / AI 轨必须在登录态复测，不能由合成轨道代替。
- Bilibili 番剧、第三方嵌入、直播、弹幕翻译、画面硬字幕 OCR、音频转写、自动生成字幕、视频下载、DRM / 会员限制不在本轮范围。
- Bilibili 字幕 CDN 的 content-type 真实值未在本轮登录态复测；后台已允许 JSON / text / octet-stream 并限制官方白名单。
- 真实 YouTube 字体 / 间距只由 E2E 与代码检查覆盖；无视觉像素对比。

## 独立 QA 复测清单

1. 打开有官方字幕的普通 BV 视频，确认字幕按钮出现后能接管；人工字幕和 AI 中文字幕各一条。
2. 多 P 视频：P1 → P2，确认 URL `?p`、player `page_no`、cid 三者变化时旧字幕立即消失，新字幕出现。
3. 站内换另一个 BV / 快速连续换视频：确认旧请求晚归不显示、无重复叠层。
4. 播放 / 暂停 / 拖动 / 倍速 / 剧场 / 全屏：字幕位置、字号、原生恢复与控制条不遮挡。
5. 关闭字幕翻译：原生字幕恢复、无 `rimefox-subs-on` 残留、无请求。
6. 目标语言 = 字幕语言：不接管、0 请求；切回外语目标后有请求。
7. 长视频：只翻当前位置往后约 90 秒；暂停不重复请求；已显示译文切换双语 / 仅译文不重复付费。
8. 无字幕视频 / 未登录：不接管、不弹重复提示、播放器功能正常。
9. YouTube 回归：真实 CC、原生恢复、广告、缓存命中、目标语言切换。
10. 权限 / 隐私：manifest 无新增权限；B 站请求不带 Cookie；不记录签名 URL / 字幕正文。