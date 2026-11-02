# 会话密钥与鉴权暂停实施记录（0.15.0 本地候选）

> 记录日期：2026-11-01。当前实现契约见 [HANDOFF §4.7](../../HANDOFF.md#47-配置会话凭据与鉴权暂停0150)，保存期见 [隐私说明](../../PRIVACY.md#保存在本机的数据)，后续优先级见 [ROADMAP](../ROADMAP.md#4-近期安排)。

## 基线与交付范围

GitHub 基线为已发布的 0.14.1（`e3efed2`），先在本地完成 PDF 缓存与任务生命周期修复（`cb5d0ca`），再实现路线图 P2-1。原拟作为 0.14.2 的 PDF 修复未单独发布，已并入 0.15.0；此前验证保留在 [PDF 修复归档](2026-11-01-pdf-cache-0.14.2.md)。

本轮完成新 Key 默认会话保存、按服务商选择设备记忆、旧用户迁移选择、旧备份去 Key、后台统一保存队列与中断恢复；完成鉴权失败全局暂停、发送前检查、可信测试连接恢复及旧失败晚归隔离；完成公开配置指纹、合并广播和多设置窗口独立修改合并。

本地完成记录形成时，三处版本号与 CHANGELOG 已统一为 0.15.0，按用户当时要求未推送、未创建 Release、未上传商店。用户随后明确授权推送；后续发布状态见 ROADMAP，本记录保留实施与验证时的事实。

## 验证

真实浏览器为 Chrome 156.0.8078.79，独立临时配置直接加载本工作树；脚本打印源目录与扩展 ID，本轮为 `oplfpnmkibcjeeelbmgjkilkeklabkpa`。假 API 使用专用测试凭据，不读取个人 Key，不调用付费模型。

| 检查 | 命令 / 方法 | 结果 |
|---|---|---|
| 全量 Node | `node --test --test-reporter=spec test/*.test.mjs` | 全部通过 |
| 离线自检 | Chrome headless 打开 `selftest/index.html`，读取 summary；参数见 [HANDOFF §7](../../HANDOFF.md#7-调试手册) | 全部通过 |
| 扩展整体 Chrome E2E | `node tools/e2e-extension.mjs` | 全部通过，含文章、设置、弹窗、输入框、配置同步及离线 B 站字幕 |
| 会话 / 暂停 Chrome E2E | `node tools/e2e-session-keys.mjs` | 全部通过，含完整重启、真实扩展重载与多标签验收 |
| PDF Chrome E2E | `node tools/e2e-pdf-reader.mjs` | 全部通过 |
| EPUB Chrome E2E | `node tools/e2e-reader.mjs` | 全部通过 |
| 真实 YouTube | `node tools/e2e-extension.mjs --youtube-only --youtube 'https://www.youtube.com/watch?v=iG9CE55wbtY' --verbose` | 未通过：持续处于广告阶段，未取得正片字幕；见下方边界 |
| 发版说明 | `python3 tools/check-release-notes.py 0.15.0` | 通过 |
| 本地安装包 | `node tools/package-store.mjs` 与 `node tools/package-store.mjs --release` | 两种 ZIP 完整，运行文件一致，含新增模块且无开发夹具 |

专项证据包括：

- 并发初始化、写入失败和已提交日志的 worker 中断恢复；旧 Key 保留设备策略，同意迁移后当前配置与旧备份均不留 Key。
- 会话 Key 跨 service worker 停止 / 唤醒保留；完整关闭并重启浏览器后消失；设备记忆 Key 跨完整重启保留；改回会话后设备副本删除。
- 在 `chrome://extensions` 通过真实开发者模式重载按钮重载扩展，再打开新的设置页，看到会话 Key 已清除和重新配置入口；不能用直接调用 `runtime.reload()` 代替这项验收。
- 真实设置表单修改保存方式，以及两个窗口并发编辑不同字段；外部通知到来时保留刚输入的草稿。
- 明确鉴权失败后排队与后续翻译零新增 HTTP；内容脚本不能读取可信配置、写任意设置或借测试连接绕过暂停；旧 Key 晚归的 401 不会暂停新配置。
- 设置页与弹窗显示暂停；PDF / EPUB 暂停期间可读原文且不请求翻译；更新 Key 或可信测试成功后可恢复。
- 20 个真实文章标签页收到合并后的配置；相同指纹不再重拉，替换 Key 即使 hasKey 不变也能通知；广播不包含 Key 或 Key 散列。
- 整体回归发现逐个等待标签应答会拖慢后续通知，已改为错开发送并限制应答等待；单个标签不应答不阻塞其它标签及下一轮广播，相关配置检查等待实际生效后再验证行为。

## 边界与后续

本地假 API 证明请求控制、凭据生命周期、结构与缓存行为，不代表真实模型译文质量、延迟或服务商全部错误格式。Edge、真实付费 API 和真实扫描件 OCR 未在本轮验收。PDF 默认使用仓库合成样本；表格 / 公式清洗、单 text item 双栏兜底与 OCR 仍属后续候选，未计入 0.15.0 完成范围。

真实 YouTube 验收尝试后增加状态诊断并复跑：播放器与英文轨道可用，但等待期始终未结束广告；收到的字幕属于广告视频，目标正片没有字幕响应。扩展 hasKey 为真、authPaused 为假、字幕开关为真，运行时没有正片轨道，没有发送翻译 HTTP，也没有未捕获异常。该项不能记为通过，仍需在可正常播放正片的环境复验；不能据此宣称已验证真实 YouTube 的 0.15 行为。

推送 main 且包含版本变化会触发 Release 工作流；仍须由用户决定是否发布，规则见 [AGENTS.md](../../AGENTS.md#提交与推送)。
