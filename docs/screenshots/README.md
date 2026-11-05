# 商店截图（0.16.4）

两组截图，2026-11-04 用 `tools/screenshot-store.mjs` 生成，全部 1280×800，**真实扩展界面 + 本地假接口返回的人工示例译文**，没有使用真实 API Key，也没有向任何真实服务商发请求。

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

脚本做这些事：启动隔离的 Chrome 156（headless，本机未安装 Edge）→ CDP 加载工作树里的扩展 → 用扩展设置页当控制台写好界面语言 / 目标语言 / 假服务商 / 示例术语表 → 打开本地演示页触发翻译 → 等「已翻译 N 段」提示消失 → 按 1280×800 截图 → 切到设置页截隐私与术语表。

- 用独立的临时用户配置，**不会**动你正在用的浏览器设置
- 演示页在脚本里内联（英文站点外壳 + 日文/英文正文），不访问外网
- 假接口只返回事先写好的示例译文，目的是构图与排版，不是模型质量展示

## 说明

- 截图里的界面、交互、双语排版、划词气泡、设置页都是真实扩展；文章与译文是为演示准备的内容。
- 上传前自己再确认一遍：没有 Key、账号、个人页面、私人内容露出。
- 这组 PNG 不在商店包里（`docs/` 被 `tools/package-store.mjs` 排除），只作为仓库素材。
- 0.8.3 时期那版旧截图已被这批替换，需要的话从 git 历史里取。

## 校验（sha256）

```text
d7d2f677b3a1c1239cb9df842d3a3c523939b3e94237c53d1d1f7976d96f4a18  en/en-01-fullpage-light.png
2cb015813924c334a34fecca096830e29a0104dd729647da876b42f762ae418c  en/en-02-fullpage-dark.png
76af256e6cbdfb9560171804da0d62236a4dc8e7459d3cd4fb3b0873e8566683  en/en-03-selection.png
8b9007de02e4ba3c28711a8fef7ddfca0e251edd10acb6da4329fea8a8547dbe  en/en-04-options-privacy.png
a71285445ec8bcd0ef4f277cb124c5785cdde84dbce77c3ac0f2c4a0bb184c25  en/en-05-options-glossary.png
aa9863c6e5a33058ff53e2a24e2d185497fca499f8a7bd1a63d91eab2c94b916  store-01-fullpage-light.png
3b38b4194fdc1c455d06a5c424a1a3ab84fd964a349213ee41902c17c0893a72  store-02-fullpage-dark.png
4ca460ef2b88ccb458062cff59f18bc09338baf2a4dcbef5f26508394c2a382c  store-03-options-privacy.png
8226c709903e6ae20d6a4bf020dc520b07eca30bdccdc0a28d24d7a2e7fba15b  store-04-options-glossary.png
f27a9f68627f4db0aae543a21b763b7936b214a95e7b3970616876026e2c9cfb  store-05-selection.png
```
