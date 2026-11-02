# PDF 文本质量与稳定性实施记录（0.16.0）

> 记录日期：2026-11-02。当前实现契约见 [HANDOFF §14](../../HANDOFF.md#14-本版技术记录0161)，PDF 文本层边界见 [PDF-HANDOFF](../PDF-HANDOFF.md)，后续优先级见 [ROADMAP](../ROADMAP.md#4-近期安排)。

## 基线与交付范围

GitHub 基线为已发布的 0.15.0。本轮先后完成 PDF 文本层重写与全仓审计修复，再统一发版为 0.16.0：

- PDF 文本层：多栏 / 4 栏按行首 x 聚类排序、跨栏标题不粘栏、justified 碎片同栏拼回、复杂页提示。
- 目录页：条目跨行合并，标题与页码保持成对；`Contents` 不再粘页码。
- 公式：残渣换 `[公式]` 占位；只有占位的块不送翻译。
- 脚注与上标编号从正文剥离；单栏数据表按单元格拆分。
- 阅读器存储：IndexedDB v4，`books` 只存元数据，新增 `files` 存原书；旧库升级自动迁移，删除书清理文件。
- PDF 任务与性能：版式切换防抖 + 代际检查 + 已渲染页锚点；页面缓存 12 页 LRU、译文内存 24 页 LRU、缓存批量读、可视页二分窗口、渲染失败重试。
- 配置安全：导入改接口地址且不带新 Key 时清旧 Key；远程明文 HTTP 警告；单本上限提示跟随设置。
- 维护：删除旧 `package.bat` / `package.ps1` 和未使用的 `STORES`；快捷键格式化改由后台 `config:get` 下发。

## 验证

真实浏览器为 Edge，直接加载本工作树；PDF / EPUB E2E 与真实样本探针均使用假接口或本地样本，不调用付费模型。

| 检查 | 命令 / 方法 | 结果 |
|---|---|---|
| 全量 Node | `node --test test/*.test.mjs` | 139 / 139 |
| PDF Chrome E2E | `node tools/e2e-pdf-reader.mjs` | 61 / 61，含快速切换版式用例 |
| EPUB Chrome E2E | `node tools/e2e-reader.mjs` | 18 / 18 |
| 会话 / 暂停 E2E | `node tools/e2e-session-keys.mjs` | 25 / 25 |
| PDF 真实样本探针 | `node tools/e2e-pdf-probe.mjs` | ALL OK |
| 离线自检 | Edge headless 打开 `selftest/index.html` | 268 / 269；失败项「悬浮入口·首帧」在基线 `b0256d5` 同样失败 |
| 发版说明 | `python tools/check-release-notes.py 0.16.0` | 通过 |
| 本地安装包 | `node tools/package-store.mjs` 与 `node tools/package-store.mjs --release` | 两种 ZIP 完整 |

手动验收（Edge，真实模型）：

- 旧书库打开 / 删除 / 重新导入正常，升级后旧书仍在。
- 快速切换 PDF 版式不再跳到远处页；普通切换保留阅读位置。
- 大 PDF 拖动到底、缩放 125% / 适合宽度，重新渲染正常。
- OBP 第 20 / 21 / 24 页多栏顺序、目录页（635 页文档）、公式页 `[公式]` 不送翻、表格单元格顺序均正常。
- 单本上限 200 ↔ 100 MB 提示同步，重新导入按新上限拒绝。
- 配置导入清 Key、明文 HTTP 警告、完整备份恢复与「测试连接」恢复正常。
- 错误 Key 触发鉴权暂停、不无限重试；换回正确 Key 后恢复。

## 未覆盖 / 边界

- 旧库升级逻辑未做自动化覆盖，只做了真实浏览器手动验收。
- 跨页段落合并、表格结构重建、公式识别与扫描件 OCR 仍未做（见 ROADMAP §3）。
- 真实 API 延迟统计未做；真实翻译质感只做了样本页抽样验收。
- 离线自检的「悬浮入口·首帧」失败为基线既有问题，不计入本版。
