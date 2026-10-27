# 0.12.6 哔哩哔哩字幕独立 QA 与修复

> **已归档**：一次性 QA 记录，2026-10-27。当前架构以 [HANDOFF.md](../../HANDOFF.md) §5.4 / §14 和 [docs/VIDEO-SUBTITLES.md](../VIDEO-SUBTITLES.md) 为准。

## 方法

- 被测：本地 0.12.6（`677f5d4`），对照 0.12.5。没有调用付费模型，没有登录 B 站，也没有用扩展打开真实 B 站 / YouTube 页面。
- 真实扩展 + 本地假 B 站：一个本地 HTTPS 服务（自签证书 + `--host-resolver-rules`，其余主机全部解析失败）同时扮演视频页、`api.bilibili.com` 播放器元数据和 `aisubtitle.hdslb.com` 字幕 CDN，跑通「播放器请求 → 页面钩子 → postMessage → 来源层 → 后台取字幕 → 翻译 → 叠层」。原有 E2E 直接调用 `resolve()`，从未经过钩子。
- 两个审计子代理分别审查安全 / 隐私与字幕运行时 / YouTube 回归，关键结论都由运行代码复现。
- 只读下载过一次公开视频页和播放器脚本（`core.*.js`），确认真实播放器把元数据地址写成 `//api.bilibili.com/x/player/wbi/v2`。

## 发现与处理

| ID | 级别 | 问题 | 处理 |
|---|---|---|---|
| V1 | P0 风险 | 钩子只认 `https://…` 或 `/x/player/…`，不认真实播放器的协议相对地址和 URL / Request 对象 | 已修 |
| V2 | P1 | 字幕缓存键含 BV / cid / YouTube 视频 ID，写进 `chrome.storage.local`，与隐私政策矛盾 | 已修 |
| V3 | P1 | 换到没有译文的语言后旧叠层继续盖住原生字幕 | 已修 |
| V4 | P1 | 取字幕失败一次后同一轨道永不重试 | 已修 |
| V5 | P1 | 无句末标点的字幕合并成 11–33 秒长块 | 已修 |
| V6 | P1 | 无 active 类的 `selectedLan` 兜底每 200 ms 闪烁且照常计费 | 已修 |
| V7 | P2 | 唯一轨道兜底取了字幕却从不显示 | 已修 |
| V8 | P2 | 页面恶意脚本轮换 cid / `id_str` 可让付费请求增加约 40 倍 | 未处理 |
| V9 | P2 | YouTube `adShowing()` 调用不存在的 `player()` | 未处理 |
| V10 | P2 | `?p` 消失或新回包先于地址栏时短暂显示旧轨道 | 未处理 |
| V11–V15 | P3 | 伪造高 seq 锁死 / 对象 `id_str` 冻结、2 MB 先读后判、CDN 跳转一律拒绝、白名单端口、钩子可被页面识别 | 未处理 |

页面翻译（DOM 保真）代码未改动，随机注入、链接语序和 4 篇维基的结果与 0.12.5 逐项相同。

## 验证

修复后：

- `for f in test/*.test.mjs; do node "$f"; done`：全部通过，新增 `test/bilibili-hook.test.mjs`。
- 自检页：全部通过。
- `node tools/e2e-extension.mjs`：全部通过，其中离线 Bilibili 经真实钩子（`--bilibili-only` 可单跑）。
- inline-layout、link-order E2E：全部通过。

新增的钩子、缓存、来源层和 E2E 检查在修复前的代码上都会失败。

## 仍需真实页面确认

- 登录态下真实人工 / AI 字幕轨。
- 全屏 / 网页全屏 / 小窗下的叠层位置。
- 真实播放器关闭 CC 时 active 类和字幕层的行为。
- 元数据缺 `page_no` 的情况。
