# 商店截图（0.9.6）

两组截图，2026-10-20 用 `tools/screenshot-store.mjs` 生成，全部 1280×800，**真实扩展界面 + 本地假接口返回的人工示例译文**，没有使用真实 API Key，也没有向任何真实服务商发请求。

## 中文商店（根目录）

| 文件 | 内容 | 建议顺序 |
|---|---|---|
| `store-01-fullpage-light.png` | 整页双语对照（浅色，英文文章 → 中文译文） | 1 |
| `store-02-fullpage-dark.png` | 整页双语对照（深色） | 2 |
| `store-05-selection.png` | 划词翻译气泡（复制 / 置顶 / 加入术语表） | 3 |
| `store-03-options-privacy.png` | 设置页「隐私保护」（总开关打开） | 4 |
| `store-04-options-glossary.png` | 设置页「翻译 → 术语表」 | 5 |

## 英文商店（`en/`）

英文界面 + 日文文章 → 英文译文，给 Edge 的 `English (United States)` 语言行用。

| 文件 | 内容 |
|---|---|
| `en-01-fullpage-light.png` | 整页双语（浅色，日文 → 英文） |
| `en-02-fullpage-dark.png` | 整页双语（深色） |
| `en-03-selection.png` | 划词气泡 |
| `en-04-options-privacy.png` | 设置页 Privacy |
| `en-05-options-glossary.png` | 设置页 Translation → Glossary |

## 怎么重新生成

```bash
node tools/screenshot-store.mjs            # 英文那 5 张 → docs/screenshots/en/
node tools/screenshot-store.mjs --lang zh  # 中文那 5 张 → docs/screenshots/
```

脚本做这些事：启动 Edge（headless）→ CDP 加载工作树里的扩展 → 用扩展设置页当控制台写好界面语言 / 目标语言 / 假服务商 / 示例术语表 → 打开本地演示页触发翻译 → 等「已翻译 N 段」提示消失 → 按 1280×800 截图 → 切到设置页截隐私与术语表。

- 用独立的临时用户配置，**不会**动你正在用的浏览器设置
- 演示页在脚本里内联（英文站点外壳 + 日文/英文正文），不访问外网
- 假接口只返回事先写好的示例译文，目的是构图与排版，不是模型质量展示

## 说明

- 截图里的界面、交互、双语排版、划词气泡、设置页都是真实扩展；文章与译文是为演示准备的内容。
- 上传前自己再确认一遍：没有 Key、账号、个人页面、私人内容露出。
- 这组 PNG 不在商店包里（`docs/` 被 `tools/package-store.mjs` 排除），只作为仓库素材。
- 0.8.3 时期那版旧截图已被这批替换，需要的话从 git 历史里取。

## 校验（sha256）

```
be65f3addaca74e711029d7c68ca853f873176ab962c503851fe34b51d806aab  store-01-fullpage-light.png
36b6cd12dd3516a45109326d9b48bf0b0c48ca7894f7297cc21447b9333503cc  store-02-fullpage-dark.png
a6624a9cbdfc2e0738d755cb4092f09f5dc02415e5a49b0453692228606d24fd  store-03-options-privacy.png
3d846a5e923646b8a982e2c3645bbf392d4131bd35c9f94595566caf31a47b65  store-04-options-glossary.png
8fcebc5b88ec5f24232cac4dbd5e789b1e86101a8aa42ba63b6f62c3b42d8072  store-05-selection.png
40d238271226883bf776b03d81c5e1f90e40f5c3f345cc73d113097d119c9bba  en/en-01-fullpage-light.png
4f5b4d44085320e59f950ddf2df0222aa3d0ae069e104618a6aa14d043e0ef96  en/en-02-fullpage-dark.png
8fcb8ff800b483f19fdb2635befbbe8d8b7463a4350075d4e7d45b52389676c3  en/en-03-selection.png
55a320cc11bf5c08736c12e958ee0db759ff4d209385527aaaa23715efc374c7  en/en-04-options-privacy.png
cb68d649b292a25373db4ddfed9de1810e04aeee86b532ff9fb85b7db5f21110  en/en-05-options-glossary.png
```
