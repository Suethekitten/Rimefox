// 设置页 / 弹窗的静态界面文案（中文 → English）。
// 只翻译界面，不碰网页正文；动态状态消息不在这一层硬翻，后续按需补。
//
// 用法：
//   applyI18n(document, 'en')  // 切英文
//   applyI18n(document, 'zh')  // 切回中文（从缓存的原文恢复）
// 语言设置存在 config.uiLang；设置页和弹窗各自在 init 里调用。

export const UI_LANGS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' }
];

// 键是界面里原样的中文（trim 后），值是英文
const EN = {
  '凛狐 设置': 'Rimefox Settings',
  '左侧分类导航：点击滚到对应分组，滚动时高亮当前分组': 'Left navigation: click to jump to a section; the current section is highlighted while scrolling.',
  '设置分类': 'Sections',
  'Key 只保存在本机浏览器里，只发给你自己填的接口地址。':
    'Your key stays in this browser and is sent only to the API URL you configure.',
  '接口': 'API',
  '用你自己的接口：OpenAI 兼容 / Anthropic / Gemini。填好地址和 Key 会自动获取可用模型。':
    'Use your own API: OpenAI-compatible / Anthropic / Gemini. Enter the URL and key to load available models automatically.',
  '服务商': 'Provider',
  '提供商': 'Provider',
  '选中后自动填好地址和协议；自定义服务商保存后会出现在列表里，随时可以切回来。':
    'Selecting one fills in the URL and protocol. Custom providers appear here after saving and can be switched back anytime.',
  '服务商名称': 'Provider name',
  '删除': 'Delete',
  '名称只影响列表里怎么显示。': 'The name only affects how it appears in the list.',
  '例如：我的中转 A': 'e.g. My relay A',
  '接口协议': 'Protocol',
  '地址、Key、模型都按服务商分别保存，切换不会丢。': 'URL, key, and model are saved per provider and kept when switching.',
  'API 地址': 'API URL',
  'OpenAI 兼容的 base URL，通常以 /v1 结尾。程序会自动补 /chat/completions。':
    'OpenAI-compatible base URL, usually ending in /v1. /chat/completions is appended automatically.',
  'API Key': 'API key',
  '去申请 →': 'Get one →',
  'DeepSeek / 智谱 / 硅基流动 / 通义 等都可以，填对应平台的 Key。':
    'DeepSeek, Zhipu, SiliconFlow, Qwen and others work; use that platform’s key.',
  '模型': 'Model',
  '模型名': 'Model name',
  '填好 API 地址和 Key 后会自动获取可用模型；也可以直接手填。':
    'Models load automatically after the URL and key are set; you can also type one.',
  '选择 ▾': 'Select ▾',
  '获取模型列表': 'Fetch models',
  '搜索模型…': 'Search models…',
  '列表里没有？直接在上面输入模型名即可': 'Not listed? Type the model name above.',
  '思考模式': 'Thinking mode',
  '自动：不发送额外参数。尽量关闭：按服务商发送对应的关闭参数；服务不支持时会自动去掉参数重试。':
    'Auto: send no extra parameters. Off: send the provider-specific disable flags; if unsupported, retry without them.',
  '自定义参数（JSON）': 'Custom parameters (JSON)',
  '会原样合并进请求体，用于千问 / GLM 这类非标准参数；写错会被忽略。':
    'Merged into the request body for non-standard flags (Qwen / GLM); invalid values are ignored.',
  '测试连接': 'Test connection',
  '会先保存当前表单，再用它发一次很小的请求。': 'Saves the form first, then sends a tiny request.',
  '翻译': 'Translation',
  '开始翻译': 'Translate',
  '目标语言、显示方式和请求节奏。': 'Target language, display, and request cadence.',
  '语言与显示': 'Language & display',
  '目标语言': 'Target language',
  '译文样式': 'Translation style',
  '双语模式下译文的标记方式。': 'How translations are marked in bilingual mode.',
  '悬停对照': 'Hover compare',
  '悬停时显示对应原句；无法准确匹配时回退到行或段落。可在网页悬浮入口中快速开关。':
    'Shows the matching source sentence on hover; falls back to the line or paragraph when no reliable match exists. You can also toggle it from the on-page quick actions.',
  '开启悬停对照': 'Enable hover compare',
  '关闭悬停对照': 'Disable hover compare',
  '段落级对应': 'Paragraph-level match',
  '行级对应': 'Line-level match',
  '原文节选': 'excerpt',
  '展开全文': 'Show full text',
  '收起': 'Collapse',
  '关闭原文提示': 'Close source text',
  '原文内容，可滚动查看': 'Source text, scrollable',
  '设置保存失败，请重试': 'Could not save the setting — please retry',
  '鼠标移到已翻译的段落上，同时高亮这一处的原文和译文；仅译文模式下弹气泡显示原文。':
    'Hover a translated paragraph to highlight its source and translation; in translation-only mode, a bubble shows the source.',
  '跳过已是目标语言的段落': 'Skip paragraphs already in the target language',
  '比如中文页翻中文时不重复翻。': 'For example, don’t retranslate a Chinese page into Chinese.',
  '界面元素也保留原文': 'Keep original UI text too',
  '导航、按钮、标签也中英对照。默认关闭：固定高度的导航条可能换行或溢出。':
    'Nav, buttons, and labels are bilingual too. Off by default: fixed-height nav bars can wrap or overflow.',
  '请求与性能': 'Requests & performance',
  '只翻屏幕附近的内容': 'Translate near the viewport only',
  '滚动到时再翻，长页面省钱；关掉则整页一次翻完。':
    'Translate on scroll to save money on long pages; turn off to translate the whole page at once.',
  '打开页面后自动翻译': 'Auto-translate on page load',
  '谨慎开启，会消耗较多额度。': 'Use with care; it consumes more quota.',
  '并发请求数': 'Concurrent requests',
  '越高整页翻完越快。DeepSeek 可设 6–10；频繁提示限流（429）时调低。':
    'Higher finishes pages faster. 6–10 works for DeepSeek; lower it if you see frequent 429s.',
  '单批条数': 'Batch size',
  '一次请求最多合并多少段。越多越省 token，但延迟更高。':
    'Maximum paragraphs per request. More saves tokens but adds latency.',
  '单批字符上限': 'Characters per batch',
  '超过就自动拆成多批。': 'Split into more batches when exceeded.',
  '长段落拆分阈值': 'Long paragraph split threshold',
  '单段超过该字符数时按句子切开分别翻译。': 'Paragraphs longer than this are split into sentences.',
  '自定义提示词': 'Custom prompt',
  '追加到系统提示词末尾；只影响措辞和术语，不会改变输出格式、条数或目标语言。留空不生效。':
    'Appended to the system prompt; it only affects wording and terminology, not output format, item count, or target language. Leave empty to disable.',
  '例如：保留代码注释原文；产品名统一译作……': 'e.g. keep code comments in the source language; always localize the product name as…',
  '术语表': 'Glossary',
  '指定某些词必须怎么翻（比如 Battle Pass → 战令）。全局一份，只把本页命中的词加进提示词。术语按「分类」分组折叠，CSV 第三列可以写分类。':
    'Force specific translations (e.g. Battle Pass → Battle Pass). One global list; only terms found on the page are added to the prompt. Terms are grouped and collapsible by category; the third CSV column can hold a category.',
  '＋ 添加一行': '+ Add row',
  '导入示例': 'Import sample',
  '导入 CSV': 'Import CSV',
  '导出 CSV': 'Export CSV',
  '清空': 'Clear',
  '原文': 'Source',
  '译法': 'Translation',
  '分类': 'Category',
  '未分类': 'Uncategorized',
  '原文，如 Battle Pass': 'Source, e.g. Battle Pass',
  '译法，如 战令': 'Translation, e.g. Battle Pass',
  '展开全部': 'Expand all',
  '收起全部': 'Collapse all',
  '还没有术语。可以「添加一行」手动加，或「导入示例」用现成的 109 条。':
    'No terms yet. Add one manually or import the built-in sample.',
  '通用UI': 'General UI',
  '战争雷霆': 'War Thunder',
  '塔科夫': 'Tarkov',
  '保留原文': 'Keep source',
  '二次元': 'Anime',
  '划词与字幕': 'Selection & subtitles',
  '不翻整页时，按需翻一句话或一段视频。': 'Translate a phrase or a video on demand without translating the whole page.',
  '划词翻译': 'Selection translation',
  '选中文字后按下面的方式触发，气泡里显示译文（点击气泡复制）。':
    'Select text and use one of the triggers below; the translation appears in a bubble (click to copy).',
  '右键菜单': 'Context menu',
  '「凛狐：翻译所选文字」，只有选中文字时才出现。': '“Rimefox: Translate selection”, shown only when text is selected.',
  '鼠标旁的「译」按钮': '“译” button near the cursor',
  '点击才翻译，推荐，不误触。': 'Translate on click; recommended and less accidental.',
  '选中后立即翻译': 'Translate immediately on selection',
  '选中就发请求，会消耗额度，默认关闭。': 'Sends a request as soon as text is selected; consumes quota; off by default.',
  'YouTube 字幕': 'YouTube subtitles',
  '字幕双语': 'Bilingual subtitles',
  '打开字幕（CC）时显示「原文 + 译文」，支持人工、自动生成和 YouTube 机翻字幕；只翻播放位置往后约 90 秒，看多少翻多少。':
    'When CC is on, show “source + translation” for manual, auto-generated, and YouTube machine-translated captions; only the next ~90 seconds are translated.',
  '默认关闭。非 YouTube 官方功能，与 YouTube / Google 无关联；依赖其未公开的接口，改版后可能失效。':
    'Off by default. Unofficial and not affiliated with YouTube / Google; it relies on an undocumented API that may break.',
  '隐私保护': 'Privacy',
  '可选：发请求前先在本地把敏感信息换成占位符，译文回来后再换回原文。默认关闭。':
    'Optional: replace sensitive data with placeholders locally before sending, then restore it after the reply. Off by default.',
  '本地脱敏': 'Local masking',
  'AI 隐私保护翻译': 'AI privacy-protected translation',
  '翻译前用占位符替换能可靠识别的敏感信息，翻译在本地还原。映射只存在本次请求的内存里，不上传、不写入设置或缓存。':
    'Before translating, reliably detectable sensitive data is replaced with placeholders and restored locally. The mapping lives only in this request\u2019s memory; it is not uploaded or written to settings or cache.',
  '只覆盖有固定格式的数据；姓名和地址仍需人工确认，模型漏掉占位符时对应段落会按翻译失败处理，不会输出错乱内容。':
    'Covers fixed-format data only; names and addresses still need review. If the model drops a placeholder, that segment fails instead of showing corrupted text.',
  '邮箱地址': 'Email addresses',
  '例如 user@example.com。': 'e.g. user@example.com.',
  '电话号码': 'Phone numbers',
  '中国手机号、座机、带 + 的国际号码；日期和订单号不会被当成电话。':
    'Chinese mobile and landline numbers and international numbers with +; dates and order numbers are not treated as phones.',
  '身份证号': 'ID card numbers',
  '18 位，校验位不正确的号码不会脱敏。': '18 digits; numbers with an invalid checksum are not masked.',
  '银行卡号': 'Bank card numbers',
  '13–19 位，通过 Luhn 校验才脱敏；订单号一般不会被误判。':
    '13\u201319 digits, masked only when the Luhn check passes; order numbers are unlikely to be caught.',
  '中文姓名': 'Chinese names',
  '只识别「姓名：」「联系人：」「我叫」等明确上下文里的姓名，默认关闭，避免把普通词当人名。':
    'Only names in explicit contexts such as “Name:”, “Contact:” or “I am …”. Off by default to avoid treating ordinary words as names.',
  '快捷键': 'Shortcuts',
  '翻译 / 还原当前页面，或翻输入框。': 'Translate / restore the page, or translate a text box.',
  '浏览器快捷键': 'Browser shortcut',
  '检测中…': 'Checking…',
  '去浏览器里设置': 'Set in browser',
  '页面内快捷键': 'In-page shortcut',
  '点击右边的按钮，然后直接按下组合键（Esc 取消）。': 'Click the button on the right, then press the shortcut (Esc to cancel).',
  '输入框翻译': 'Text box translation',
  '目标语言': 'Target language',
  '跟随页面语言': 'Follow the page language',
  '输入框快捷键': 'Text box shortcut',
  '点击右边的按钮，然后直接按下组合键（Esc 取消）。只在输入框里有光标时生效。':
    'Click the button on the right, then press the shortcut (Esc to cancel). Only works while the cursor is in a text box.',
  '「跟随页面语言」= 用页面 lang 属性认得出的语言；认不出来时用英文。':
    '“Follow the page language” uses the language in the page’s lang attribute; falls back to English.',
  '光标在输入框或可编辑区域里时，按下快捷键把这段文字翻成目标语言后原地写回；也可以右键 →「凛狐：翻译输入框内容」。有选区时只翻选中的部分，翻完按 Ctrl+Z（Mac：⌘Z）能回到原文。密码框和支付类字段不翻译，输入法拼字中不会打断。输入框里多是草稿和私信，这类翻译不写进翻译缓存。':
    'With the cursor in a text box or editable area, press the shortcut to translate that text in place; the right-click menu has “Rimefox: translate the text box” too. A selection translates only the selected part, and Ctrl+Z (⌘Z on Mac) brings the original back. Password and payment fields are skipped, and composing input is never interrupted. Drafts and private messages are not written to the translation cache.',
  '缓存与迁移': 'Cache & migration',
  '翻过的内容记在本机；换电脑或换版本时把设置带走。': 'Translations are cached locally; take settings with you when switching machines or versions.',
  '翻译缓存': 'Translation cache',
  '翻过的文字会记下来，再遇到直接用，不再请求接口。本次会话的缓存在关闭浏览器时清空；短文本（按钮、标题、导航）另存一份到磁盘，重启浏览器后还能用。缓存按网站和模型分开存；换了模型后旧译文不会再命中，会按新模型重新翻译。':
    'Translated text is cached and reused without another request. Session cache clears when the browser closes; short texts (buttons, headings, nav) are also stored on disk. Cache is separated by site and model; after switching models, old translations are not reused.',
  '当前缓存': 'Current cache',
  '正在读取…': 'Reading…',
  '刷新': 'Refresh',
  '配置迁移': 'Config migration',
  '把 API 地址、Key、模型和各项设置导出成一个 JSON 文件；换电脑或换扩展版本时导入，不用重填。':
    'Export the API URL, key, model, and settings as a JSON file; import it on another machine or version instead of re-entering everything.',
  '导出时包含 API Key': 'Include API key on export',
  '跨电脑 / 跨版本迁移必须勾选。文件里是明文，迁移完请删掉，不要外传。':
    'Required for cross-machine / cross-version migration. The file is plaintext; delete it afterwards and do not share it.',
  '导出 / 导入': 'Export / import',
  '导入会立即保存并生效。': 'Import saves and applies immediately.',
  '导出': 'Export',
  '导入': 'Import',
  '高级': 'Advanced',
  '排查问题时用。': 'For troubleshooting.',
  '输出调试日志': 'Debug logging',
  '网页控制台会打印 [凛狐] 前缀的段落切分 / 批处理信息。':
    'The page console logs paragraph splitting / batching with a [Rimefox] prefix.',
  '界面主题': 'Theme',
  '界面语言': 'Interface language',
  '只影响设置页和弹窗的界面文字；网页正文的翻译目标语言在上面的「翻译」里设置。':
    'Affects the settings and popup UI only; set the page translation target under Translation above.',
  '设置页和弹窗的配色；自动会跟随系统。不改网页内译文的样式。':
    'Colors for settings and popup; Auto follows the system. Does not change translation styles on web pages.',
  '自动': 'Auto',
  '浅色': 'Light',
  '深色': 'Dark',
  '切换到深色': 'Switch to dark',
  '切换到浅色': 'Switch to light',
  '无样式': 'None',
  '下划线': 'Underline',
  '虚线框': 'Dashed box',
  '高亮': 'Highlight',
  '半透明': 'Semi-transparent',
  '普通': 'Plain',
  '文言文': 'Classical Chinese',
  '猫娘': 'Catgirl',
  '自动（不发额外参数）': 'Auto (no extra parameters)',
  '尽量关闭': 'Off (preferred)',
  '自定义参数': 'Custom parameters',
  '恢复默认设置': 'Reset to defaults',
  '把表单填回默认值（已保存的 API Key 保留），确认后点底部「保存」才生效。':
    'Fill the form with defaults (saved API key is kept); click Save at the bottom to apply.',
  '恢复默认': 'Reset',
  '离线自检': 'Offline self-test',
  '不联网、不调接口；改完代码后跑一遍，应显示「全部通过」。':
    'No network or API calls; run it after code changes and it should show “all passed”.',
  '打开自检页': 'Open self-test',
  '所有更改已保存': 'All changes saved',
  '放弃更改': 'Discard',
  '保存': 'Save',

  // 弹窗
  '凛狐': 'Rimefox',
  '双语对照翻译 · Rimefox': 'Bilingual translation · Rimefox',
  '翻译此页': 'Translate this page',
  '显示': 'Display',
  '双语对照': 'Bilingual',
  '仅译文': 'Translation only',
  '译成': 'Translate to',
  '趣味翻译：只对当前页生效，还原后回到普通': 'Fun style: current page only; reverts to plain after restore',
  '趣味': 'Fun',
  '只改写正文，只对当前页生效；还原后回到普通翻译': 'Rewrites body text only, current page only; reverts to plain translation after restore',
  '随手翻译': 'Quick translate',
  '粘贴 / 输入要翻译的文字…（Ctrl+Enter 翻译）': 'Paste or type text… (Ctrl+Enter to translate)',
  '复制结果': 'Copy result',
  '重新翻译': 'Retranslate',
  '清缓存': 'Clear cache',
  '诊断': 'Diagnose',
  '设置': 'Settings',

  // 弹窗 · 动态状态（JS 运行时拼出来的文案，走 translateText / t）
  '翻译中…（点此停止）': 'Translating… (click to stop)',
  '还原原文': 'Restore original',
  '未开启': 'Off',
  'PDF 暂不支持': 'PDF not supported',
  '这是浏览器自带的 PDF 阅读器，扩展无法在里面翻译。':
    'This is the browser’s built-in PDF viewer; extensions can’t translate inside it.',
  '本地文件需要授权': 'File access needed',
  '无法连接页面脚本': 'Cannot reach the page script',
  '当前页面不支持': 'Page not supported',
  '浏览器内置页、扩展商店页、扩展自身页面无法注入脚本。请切换到普通网页（http/https）。':
    'Browser-internal pages, extension stores and extension pages can’t be injected. Open a normal http/https page.',
  '状态同步失败（页面可能正在切换）。重新打开本面板即可。':
    'Lost sync with the page (it may be navigating). Reopen this panel.',
  '正在开始翻译…': 'Starting translation…',
  '正在还原…': 'Restoring…',
  '失败原因：': 'Last error: ',
  '操作失败：': 'Operation failed: ',
  '切换失败：': 'Switch failed: ',
  '诊断失败：': 'Diagnostics failed: ',
  '翻译失败：': 'Translation failed: ',
  '已复制': 'Copied',
  '复制失败，请手动选中复制。': 'Copy failed; select the text and copy it manually.',
  '未知错误': 'Unknown error',
  '没有可用标签页': 'No active tab',
  '诊断信息已复制到剪贴板，直接粘贴给我。': 'Diagnostics copied to the clipboard; paste it here.',
  '当前服务商和模型': 'Current provider and model',
  // ---- 0.7.0：搜索、外观、站点与兼容性、悬浮入口 ----
  '凛狐 Rimefox': 'Rimefox',
  '搜索设置': 'Search settings',
  '没有匹配的设置，换个词试试。': 'No matching settings. Try another word.',
  '可能降低性能': 'May slow pages down',
  '可能影响页面布局': 'May affect page layout',
  '可能破坏部分页面': 'May break some pages',
  '高级参数': 'Advanced',
  '外观': 'Appearance',
  '设置页、弹窗的配色，以及网页里译文的样子。': 'Colors of the settings page and popup, and how translations look on web pages.',
  '界面': 'Interface',
  '只影响设置页和弹窗的界面文字；网页正文的翻译目标语言在「翻译」里设置。':
    'Only changes the text of the settings page and popup; the target language for web pages is set under Translation.',
  '强调色': 'Accent color',
  '设置页和弹窗的主色；网页里译文的下划线、悬停高亮和原文气泡也跟着变。':
    'Main color of the settings page and popup; translation underlines, hover highlights and source bubbles on web pages follow it too.',
  '紫罗兰': 'Violet',
  '海蓝': 'Blue',
  '青绿': 'Teal',
  '松绿': 'Green',
  '琥珀': 'Amber',
  '玫红': 'Rose',
  '石墨': 'Slate',
  '自定义颜色': 'Custom color',
  '减少透明和模糊': 'Reduce transparency and blur',
  '半透明的玻璃效果改成实色背景，弱机、外接屏和视力不佳时更清楚。':
    'Replaces the translucent glass effect with solid backgrounds; clearer on slow machines, external displays and for low vision.',
  '关闭阴影': 'Turn off shadows',
  '去掉卡片和浮层的投影，界面更平。': 'Removes shadows from cards and overlays for a flatter look.',
  '译文排版': 'Translation typography',
  '只影响网页里插入的译文，原文不变。全部保持默认时，译文沿用原文的排版。':
    'Only affects translations inserted into web pages; the original text is unchanged. With all defaults, translations follow the original layout.',
  '字号': 'Font size',
  '跟随原文': 'Same as original',
  '行高': 'Line height',
  '与原文的间距': 'Gap below original',
  '段落译文和上面原文之间的空隙。': 'Space between a translated paragraph and the original above it.',
  '紧凑': 'Compact',
  '默认': 'Default',
  '宽松': 'Relaxed',
  '很宽': 'Wide',
  '首行缩进': 'First-line indent',
  '段落译文首行空两格。': 'Indents the first line of translated paragraphs by two characters.',
  '悬浮入口': 'Floating button',
  '在网页边上显示悬浮入口': 'Show a floating button at the page edge',
  '一个小按钮：开关翻译、切换双语 / 仅译文、查看当前服务商、翻译选中的文字、打开置顶小窗。':
    'A small button to toggle translation, switch bilingual / translation only, see the current provider, translate selected text and open the pinned window.',
  '位置': 'Position',
  '没拖拽过时贴在哪一边；在网页上拖过之后以拖拽位置为准。':
    'Which edge it sticks to before you drag it; once dragged on a page, the dragged position wins.',
  '拖拽后的位置': 'Dragged position',
  '在网页上按住小球拖动：靠近左 / 右边缘松手会吸附到边上，其它位置保持悬浮。':
    'Press and drag the ball on any page: release near the left or right edge and it snaps there; anywhere else it keeps floating.',
  '右侧': 'Right',
  '左侧': 'Left',
  '自动隐藏': 'Auto-hide',
  '平时只露出一小截，鼠标移过去再展开。': 'Mostly tucked away; expands when you hover over it.',
  '置顶翻译窗': 'Pinned translation window',
  '置顶小窗': 'Pinned window',
  '在悬浮入口或划词气泡里点「置顶」，划词译文会固定在一个始终在最上层的小窗里，看 PDF、全屏视频或多窗口阅读时用。需要 Chrome 116 以上；不支持时改用普通小窗。':
    'Click Pin in the floating button or the selection bubble to keep selection translations in an always-on-top window, handy for PDFs, full-screen video or multi-window reading. Needs Chrome 116+; otherwise a normal small window is used.',
  '站点与兼容性': 'Sites & compatibility',
  '会改变网页外观的开关集中在这里；某个网站翻得不好时，用站点规则单独调整。':
    'Switches that change how web pages look live here; if a site translates poorly, adjust it with a site rule.',
  '页面适配': 'Page adaptation',
  '深色网页自动调整译文颜色': 'Adjust translation colors on dark pages',
  '检测到网页是深色背景时，译文下划线、高亮和气泡换成适合夜读的颜色。':
    'When a page has a dark background, translation underlines, highlights and bubbles switch to night-friendly colors.',
  '站点规则': 'Site rules',
  '按网址指定只翻哪些区域、跳过哪些区域，或固定显示方式。内置规则随版本更新；你自己的规则写在下面，优先生效。':
    'Choose by URL which areas to translate or skip, or fix the display mode. Built-in rules update with new versions; your own rules go below and take priority.',
  '内置规则': 'Built-in rules',
  'GitHub：文件列表里的文件名不翻译': 'GitHub: file names in file lists are not translated',
  'Wikipedia：语言切换列表（上百个语言名）不翻译': 'Wikipedia: the language switcher (hundreds of language names) is not translated',
  '我的规则（JSON）': 'My rules (JSON)',
  '留空表示不加规则。字段：matches（网址，支持 *. 子域名和路径里的 *）、textSelectors（只翻这些区域）、excludeSelectors（不翻这些区域）、mode（dual / translation）、theme。':
    'Leave empty for no rules. Fields: matches (URLs; supports *. subdomains and * in paths), textSelectors (translate only these areas), excludeSelectors (skip these areas), mode (dual / translation), theme.',
  '网页夜间模式（Beta）': 'Web night mode (Beta)',
  '启用网页夜间模式': 'Enable web night mode',
  '把网页反色成深色，图片和视频保持原样。只在下面列出的网站生效；用画布绘制的界面、复杂背景图可能显示异常。':
    'Inverts pages to dark while keeping images and video as they are. Only applies to the sites listed below; canvas-drawn interfaces and complex background images may look wrong.',
  '生效的网站': 'Sites',
  '一行一个域名，包含子域名，例如 example.com。也可以在弹窗里一键加入当前网站。':
    'One domain per line, subdomains included, e.g. example.com. You can also add the current site from the popup.',
  '译文自定义 CSS': 'Custom translation CSS',
  '只作用于网页里的译文，站点适配坏掉时临时救急。只能写属性声明，例如 color: #555; font-size: 0.95em; 不支持选择器、@ 规则和 url()。':
    'Applies only to translations on web pages, as a quick fix when a site looks wrong. Declarations only, e.g. color: #555; font-size: 0.95em; no selectors, @ rules or url().',
  '设置在别的页面被修改过；保存时会以这里的内容为准': 'Settings were changed on another page; saving here will overwrite them',
  '站点规则有错误，改好再保存': 'Site rules have errors; fix them before saving',
  '译文自定义 CSS 有错误，改好再保存': 'Custom translation CSS has errors; fix it before saving',
  '站点规则必须是一个 JSON 数组': 'Site rules must be a JSON array',
  '不能包含 { } @ < \\ 这些字符（只写属性声明，不写选择器和 @ 规则）':
    'Can’t contain { } @ < \\ (declarations only, no selectors or @ rules)',
  '不能引用外部资源（url() / image-set()）': 'Can’t reference external resources (url() / image-set())',
  '不能包含脚本相关写法': 'Can’t contain script-like code',
  '不能包含注释': 'Can’t contain comments',
  '夜间': 'Night',
  '本站夜间模式（Beta）：把网页反色成深色，图片和视频保持原样': 'Night mode for this site (Beta): inverts the page to dark, keeping images and video as they are',
  '把网页反色成深色，只对这个网站生效（Beta）': 'Inverts the page to dark, for this site only (Beta)',
  // 0.6.2 起漏掉的几处
  '＋ 新建自定义服务商': '+ New custom provider',
  'OpenAI 兼容': 'OpenAI-compatible',
  '智谱 GLM': 'Zhipu GLM',
  '月之暗面 Kimi': 'Moonshot Kimi',
  '阿里云百炼（千问）': 'Alibaba Cloud Model Studio (Qwen)',
  '硅基流动': 'SiliconFlow',
  'Ollama（本地）': 'Ollama (local)',
  'LM Studio（本地）': 'LM Studio (local)',
  '浏览器快捷键：读取失败': 'Browser shortcut: could not read it',

  // ---- 首次安装欢迎页 / 新手引导 ----
  '凛狐 · 新手引导': 'Rimefox · Getting started',
  '跳到主要内容': 'Skip to main content',
  '双语对照翻译': 'Bilingual translation',
  '版本': 'Version',
  '切换界面语言为英文': 'Switch interface language to English',
  '切换界面语言为中文': 'Switch interface language to Chinese',
  '引导步骤': 'Guide steps',
  '欢迎': 'Welcome',
  '认识凛狐': 'Meet Rimefox',
  '功能': 'Features',
  '能做什么': 'What it does',
  '配置': 'Set up',
  '连接翻译服务': 'Connect a translator',
  '开始': 'Start',
  '基本用法': 'Basic usage',
  '大约 2 分钟即可完成。': 'Takes about 2 minutes.',
  '你的 Key 只保存在本机。': 'Your key stays on this device.',
  '首次安装 · 欢迎': 'First install · Welcome',
  '让跨语言阅读': 'Make reading across languages',
  '自然发生。': 'feel natural.',
  '凛狐把原文和译文放在一起，不打断你的阅读节奏。用你自己的 API Key，选择你信任的翻译模型。':
    'Rimefox keeps the original and the translation together without breaking your reading flow. Use your own API key and choose the model you trust.',
  '整页双语对照': 'Bilingual pages',
  '无遥测': 'No telemetry',
  '开始配置': 'Set up translation',
  '先看看功能': 'See what it does',
  '原文与译文同屏': 'Original and translation together',
  '页面文字只发给你配置的接口': 'Page text goes only to the endpoint you configure',
  '支持中文 / English 界面': 'Chinese / English interface',
  '译文': 'Translation',
  '已翻译': 'Translated',
  '划词翻译': 'Selection translation',
  '示意图 · 实际界面以扩展为准': 'Illustration · actual interface may differ',
  '主要功能': 'Main features',
  '从整页阅读到视频字幕': 'From full pages to video captions',
  '五个功能，覆盖日常跨语言阅读的常见场景。': 'Five features for everyday cross-language reading.',
  '整页双语翻译': 'Full-page bilingual translation',
  '原文与译文分层显示，可切换双语或仅译文；动态加载的内容会继续补翻。':
    'Original and translation are layered together, with bilingual or translation-only views; dynamically loaded content keeps getting translated.',
  '划词即时翻译': 'Instant selection translation',
  '选中文字后点旁边的「译」或使用右键菜单，气泡里显示译文，可复制或置顶。':
    'Select text, then click “Translate” or use the context menu. The result appears in a bubble and can be copied or pinned.',
  'YouTube 双语字幕': 'Bilingual YouTube captions',
  '打开 CC 时显示原文和译文。默认关闭，非官方功能，依赖平台接口，可能随平台更新失效。':
    'Shows source and translation when CC is on. Off by default; unofficial, relies on an undocumented API and may break after platform updates.',
  '多模型 API 支持': 'Bring your own model',
  'DeepSeek、智谱 GLM、通义千问、Kimi、硅基流动、OpenRouter、Ollama、Anthropic、Gemini，或任意 OpenAI 兼容网关。':
    'DeepSeek, Zhipu GLM, Qwen, Kimi, SiliconFlow, OpenRouter, Ollama, Anthropic, Gemini, or any OpenAI-compatible gateway.',
  '术语表与自定义提示词': 'Glossary and custom prompts',
  '指定术语的固定译法，追加自己的措辞要求，让译文更贴近你的习惯。':
    'Fix how key terms are translated and add your own wording preferences so results match your style.',
  '配置翻译服务': 'Set up translation',
  '使用你自己的 API Key': 'Use your own API key',
  '凛狐采用 BYOK（Bring Your Own Key）模式：扩展不内置翻译额度，也不经过作者服务器。你需要准备一个兼容服务的 API Key，翻译才会工作。':
    'Rimefox uses BYOK (Bring Your Own Key): no translation quota is bundled, and requests never pass through the author’s server. You need an API key from a compatible provider before translation can work.',
  '为什么需要 API Key？': 'Why do I need an API key?',
  '翻译由你自己选择的模型完成，请求直接发往你填写的接口。':
    'Translation is done by the model you choose, and requests go directly to the endpoint you configure.',
  '服务商可能按用量收费，价格和数据处理方式以服务商为准。':
    'Providers may charge by usage; pricing and data handling are set by the provider.',
  '没有内置免费额度；换服务商或模型只需在设置里修改。':
    'No free translation quota is included; to switch providers or models, just change it in settings.',
  '可以选择哪些服务': 'Which providers can I use?',
  '通义千问': 'Qwen',
  '自定义 / 兼容网关': 'Custom / compatible gateway',
  '也可以填写任意 OpenAI 兼容网关，或本机 Ollama 地址。不确定选哪个？先看服务商是否提供兼容接口、是否支持你需要的语言，以及价格是否合适。':
    'You can also use any OpenAI-compatible gateway or a local Ollama endpoint. Not sure which to pick? Check whether it offers a compatible API, supports your languages, and fits your budget.',
  '三步完成配置': 'Set up in three steps',
  '打开扩展设置': 'Open extension settings',
  '点下面的按钮，或从扩展菜单进入设置。': 'Use the button below, or open settings from the extensions menu.',
  '选择服务商，填写 API 地址、Key 和模型': 'Choose a provider and enter the API URL, key and model',
  '地址通常以 /v1 结尾；具体以服务商文档为准。': 'The URL usually ends in /v1; check your provider’s documentation.',
  '点「测试连接」，成功后保存': 'Click “Test connection”, then save',
  '看到连接正常，就可以去翻译网页了。': 'Once the connection works, you can start translating pages.',
  '打开设置': 'Open settings',
  '没有 Key？先到你选择的服务商控制台创建，再回到这里填写。':
    'No key yet? Create one in your provider’s dashboard, then come back and enter it here.',
  '关于隐私': 'About privacy',
  'API Key 只保存在本机浏览器的 chrome.storage.local 中，只作为认证头发送给你填写的接口。待翻文本会直接发往该接口，不经过作者服务器，也没有遥测。':
    'Your API key is stored only in this browser’s chrome.storage.local and is sent only to your endpoint as an authentication header. Text to translate goes directly to that endpoint; it never passes through the author’s server, and there is no telemetry.',
  '可选的本地脱敏默认关闭，开启后会在发请求前把可识别的邮箱、电话、身份证号和银行卡号换成占位符。第三方服务商的数据处理以其隐私政策为准。':
    'Optional local masking is off by default. When enabled, detectable emails, phone numbers, ID card numbers and bank card numbers are replaced with placeholders before sending. Third-party providers process data under their own privacy policies.',
  '阅读隐私说明': 'Read the privacy policy',
  '开始使用': 'Start using Rimefox',
  '四步开始第一次翻译': 'Four steps to your first translation',
  '配置完成后，打开任意普通网页就能试。': 'Once set up, open any regular web page and try it.',
  '打开任意普通网页': 'Open any regular web page',
  '支持 http / https 页面。浏览器内置页和扩展商店页不能翻译。':
    'http / https pages work. Browser-internal pages and extension store pages cannot be translated.',
  '点击工具栏里的凛狐图标': 'Click the Rimefox icon in the toolbar',
  '也可以在页面上按 Alt + A（Mac：Option + A）翻译或还原。':
    'You can also press Alt + A (Mac: Option + A) on the page to translate or restore.',
  '选择整页翻译或划词翻译': 'Translate the whole page or just a selection',
  '整页翻译在弹窗里点「翻译此页」；划词时选中文字再点「译」。':
    'Click “Translate this page” in the popup for the whole page, or select text and click “Translate” for a selection.',
  '想试字幕就打开 CC': 'For captions, turn on CC',
  '先在设置里开启「YouTube 字幕双语」，再打开有 CC 轨道的视频。':
    'Enable “Bilingual YouTube subtitles” in settings first, then open a video with a CC track.',
  '把凛狐固定到工具栏': 'Pin Rimefox to the toolbar',
  'Chrome 和 Edge 会把新扩展收进拼图（扩展）菜单。点旁边的图钉就能固定；扩展无法替你自动固定。':
    'Chrome and Edge tuck new extensions into the puzzle (extensions) menu. Click the pin next to Rimefox to keep it visible; extensions cannot pin themselves automatically.',
  '准备好了': 'You’re all set',
  '需要重新查看时，可以在设置页或弹窗里打开「使用指南」。':
    'You can reopen this guide anytime from Settings or the popup.',
  '完成引导': 'Finish guide',
  '查看详细文档': 'View documentation',
  '上一步': 'Back',
  '下一步': 'Next',
  '用你自己的 Key，不经过作者服务器。': 'Your own key. No author server.',
  '相关链接': 'Related links',
  '隐私说明': 'Privacy',
  '源码': 'Source',
  '文档': 'Docs',
  '界面语言已切换为英文': 'Interface language set to English',
  '界面语言已切换为中文': 'Interface language set to Chinese',
  '请在扩展环境中打开设置页。': 'Open this page inside the extension to reach settings.',
  '无法打开设置页，请从扩展菜单进入。': 'Could not open settings; use the extensions menu instead.',
  '已打开设置页': 'Settings opened',
  '使用指南': 'User guide',
  '指南': 'Guide',
  '重新查看首次安装时的功能介绍和配置步骤。': 'Revisit the feature tour and setup steps from your first install.',
  '打开使用指南': 'Open the user guide'
};
const TEXT_ORIG = new WeakMap();
const ATTR_ORIG = new WeakMap();
const SELF = new WeakSet();
let current = 'zh';
let observer = null;
let applying = false;
const ATTRS = ['placeholder', 'title', 'aria-label'];

// 动态状态文案（带数字 / 时间 / 错误原文），用正则替换；匹配不到就保持中文
const PATTERNS = [
  [/^已保存（(.+)）$/, 'Saved ($1)'],
  [/^已保存，但还没有填 API Key，翻译会失败。$/, 'Saved, but no API key yet; translation will fail.'],
  [/^已放弃未保存的更改$/, 'Discarded unsaved changes'],
  [/^已填入默认值，点「保存」后生效$/, 'Defaults filled in; click Save to apply'],
  [/^已删除 (\d+) 条（点「保存」后生效）$/, 'Deleted $1 term(s); click Save to apply'],
  [/^已导入 (\d+) 条（新增 (\d+) 条，点「保存」后生效）$/, 'Imported $1 term(s) ($2 new); click Save to apply'],
  [/^已导入示例 (\d+) 条（分类已分好，再点一次「导入示例」可收起）$/, 'Imported $1 sample term(s); click Import sample again to remove'],
  [/^已收起示例（回到导入前，点「保存」后生效）$/, 'Sample removed (back to before import); click Save to apply'],
  [/^已清空（点「保存」后生效）$/, 'Cleared; click Save to apply'],
  [/^已导出 (\d+) 条（含分类）。$/, 'Exported $1 term(s) with categories.'],
  [/^这个 CSV 里没有可用的原文 \/ 译法两列（第三列分类可选）。$/, 'No source/target columns found in this CSV (category is optional).'],
  [/^读取失败：(.+)$/, 'Read failed: $1'],
  [/^正在生成诊断信息…$/, 'Generating diagnostics…'],
  [/^正在翻译…$/, 'Translating…'],
  [/^正在还原…$/, 'Restoring…'],
  [/^翻译中…$/, 'Translating…'],
  [/^缓存已清空，下次翻译会重新请求。$/, 'Cache cleared; the next translation will request again.'],
  [/^切换失败：(.+)$/, 'Switch failed: $1'],
  [/^操作失败：(.+)$/, 'Operation failed: $1'],
  [/^诊断失败：(.+)$/, 'Diagnostics failed: $1'],
  [/^已翻译$/, 'Translated'],
  [/^未翻译$/, 'Not translated'],

  [/^不是合法的 JSON：(.+)$/, 'Not valid JSON: $1'],
  [/^格式正确，共 (\d+) 条规则$/, 'Looks good: $1 rule(s)'],
  [/^会应用到译文：(.+)$/, 'Will apply to translations: $1'],
  [/^第 (\d+) 条规则的 (\w+) 必须是数组$/, 'Rule $1: $2 must be an array'],
  [/^第 (\d+) 条规则的 (\w+) 里有不合法的项：(.+)$/, 'Rule $1: invalid item in $2: $3'],
  [/^第 (\d+) 条规则不是对象$/, 'Rule $1 is not an object'],
  [/^第 (\d+) 条规则的网址写法不对：(.+)$/, 'Rule $1: invalid URL pattern: $2'],
  [/^第 (\d+) 条规则没有可用的 matches$/, 'Rule $1 has no usable matches'],
  [/^第 (\d+) 条规则的 mode 只能是 dual \/ translation$/, 'Rule $1: mode must be dual / translation'],
  [/^第 (\d+) 条规则的 theme 取值不认识$/, 'Rule $1: unknown theme'],
  [/^第 (\d+) 条规则的选择器写错了：(.+)$/, 'Rule $1: invalid selector: $2'],
  [/^最多 (\d+) 条规则，多出的已忽略$/, 'At most $1 rules; the rest were ignored'],
  [/^超过 (\d+) 字$/, 'Longer than $1 characters'],
  [/^「(.+)」不是「属性: 值」的写法$/, '“$1” is not in “property: value” form'],
  [/^「(.+)」不是合法的属性名$/, '“$1” is not a valid property name'],
  [/^最多 (\d+) 条声明$/, 'At most $1 declarations'],
  [/^已获取 (\d+) 个模型。点「选择」挑一个，或直接手填；别忘了保存。$/, 'Loaded $1 models. Click Select to pick one, or type it in; remember to save.'],
  [/^已获取 (\d+) 个模型，但「(.+)」不在列表里，请确认拼写或点「选择」挑一个。$/,
    'Loaded $1 models, but “$2” is not in the list; check the spelling or click Select to pick one.'],
  [/^浏览器快捷键：未设置。(.+) 可能已被其它扩展占用，点右边按钮给「翻译 \/ 还原当前页面」设一个键。$/,
    'Browser shortcut: not set. $1 may be taken by another extension; use the button on the right to assign a key to “Translate / restore current page”.'],
  [/^浏览器快捷键：(.+)$/, 'Browser shortcut: $1'],
  [/^本次会话：(\d+) 条 · (.+?)（上限 (\d+) 条 \/ (.+?)）　磁盘：(\d+) 条 · (.+?)（上限 (.+?)）　命中率：(\d+)%（(\d+) \/ (\d+)）$/,
    'This session: $1 entries · $2 (limit $3 entries / $4)　Disk: $5 entries · $6 (limit $7)　Hit rate: $8% ($9 / $10)'],
  [/^本次会话：(\d+) 条 · (.+?)（上限 (\d+) 条 \/ (.+?)）　磁盘：(\d+) 条 · (.+?)（上限 (.+?)）　命中率：—$/,
    'This session: $1 entries · $2 (limit $3 entries / $4)　Disk: $5 entries · $6 (limit $7)　Hit rate: —'],

  // 弹窗动态状态：带数字 / 快捷键 / 页面地址的句子
  [/^未开启。按 (.+) 可直接翻译。$/, 'Off. Press $1 to translate the page.'],
  [/^未开启。浏览器快捷键没有设置成功（(.+) 可能被其它扩展占用），可在「设置」里重新设置。$/,
    'Off. The browser shortcut could not be assigned ($1 is probably taken by another extension); set it in Settings.'],
  [/^翻译中… 已译 (\d+) \/ (\S+) 段（(\d+)%）$/, 'Translating… $1 / $2 paragraphs ($3%)'],
  [/^翻译中… 已译 (\d+) \/ (\S+) 段$/, 'Translating… $1 / $2 paragraphs'],
  [/^已译 (\d+) 段$/, '$1 paragraphs translated'],
  [/^与原文相同 (\d+) 段$/, '$1 identical to source'],
  [/^失败 (\d+) 段$/, '$1 failed'],
  [/^共 (\d+) 段$/, '$1 total'],
  [/^打开 (.+) → 本扩展的「详细信息」→ 开启「(.+)」，然后按 (.+) 刷新这个页面。$/,
    'Open $1 → this extension’s Details → enable “$2”, then press $3 to reload this page.'],
  [/^浏览器内置页、扩展商店页无法翻译。如果这是本地文件，请打开 (.+) → 本扩展的「详细信息」→ 开启「(.+)」，然后按 (.+) 刷新。$/,
    'Built-in browser pages and the extension store can’t be translated. If this is a local file, open $1 → this extension’s Details → enable “$2”, then press $3 to reload.'],
  [/^自动补注入失败。请在网页上按 (.+) 刷新后重新打开本面板；仍然失败请按 (.+) 打开控制台看红色报错。$/,
    'Auto re-injection failed. Press $1 on the page, then reopen this panel; if it still fails, press $2 to open the console and look for red errors.'],
  [/^粘贴 \/ 输入要翻译的文字…（(.+) 翻译）$/, 'Paste or type text… ($1 to translate)'],
  [/^翻译失败：(.+)$/, 'Translation failed: $1'],
  [/^翻译单元 (\d+) 个 · 被跳过 (\d+) 个$/, '$1 translation unit(s) · $2 skipped'],
  [/^其中：文本过短 (\d+) 个 · 判定为目标语言 (\d+) 个$/, 'Of which: $1 too short · $2 detected as target language'],
  [/^复制失败：在网页上按 (.+) 打开控制台，把左上角的「top」切换成本扩展，再执行 copy\(JSON\.stringify\(__DT_LAST_DIAG\)\) 然后粘贴给我。$/,
    'Copy failed: open the console with $1, switch the “top” context to this extension, run copy(JSON.stringify(__DT_LAST_DIAG)), and paste it here.']
];

export function translateText(text) {
  const value = String(text == null ? '' : text);
  const key = value.trim();
  if (!key) return value;
  let hit = EN[key];
  if (!hit) {
    for (let i = 0; i < PATTERNS.length; i += 1) {
      const pair = PATTERNS[i];
      if (pair[0].test(key)) {
        hit = key.replace(pair[0], pair[1]);
        break;
      }
    }
  }
  // 校验结果常是几条错误用「；」连起来：逐条翻，能翻的才换
  if (!hit && key.indexOf('；') > 0) {
    const parts = key.split('；');
    const done = parts.map((part) => translateText(part).trim());
    if (done.some((part, i) => part !== parts[i].trim())) hit = done.join('; ');
  }
  if (!hit) return value;
  const lead = /^\s*/.exec(value)[0];
  const trail = /\s*$/.exec(value)[0];
  return lead + hit + trail;
}

// 动态文案：按当前界面语言输出（translateText 只负责中文→英文，不判断当前语言）
export function t(text) {
  const value = String(text == null ? '' : text);
  return current === 'en' ? translateText(value) : value;
}

function translateNode(node) {
  if (!TEXT_ORIG.has(node)) TEXT_ORIG.set(node, node.nodeValue);
  const orig = TEXT_ORIG.get(node);
  const next = current === 'en' ? translateText(orig) : orig;
  if (next !== node.nodeValue) {
    SELF.add(node);
    node.nodeValue = next;
  }
}

function translateAttrs(el) {
  if (!ATTR_ORIG.has(el)) ATTR_ORIG.set(el, {});
  const map = ATTR_ORIG.get(el);
  ATTRS.forEach((name) => {
    if (!el.hasAttribute(name)) return;
    if (!(name in map)) map[name] = el.getAttribute(name);
    const orig = map[name];
    el.setAttribute(name, current === 'en' ? translateText(orig) : orig);
  });
}

function walk(node) {
  if (!node) return;
  if (node.nodeType === 3) {
    translateNode(node);
    return;
  }
  if (node.nodeType === 1) {
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    // TEXTAREA 的内容不能翻，但 placeholder 是界面文案，要翻
    translateAttrs(node);
    if (tag === 'TEXTAREA') return;
  } else if (node.nodeType !== 9 && node.nodeType !== 11) {
    return;
  }
  for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
}

function startObserver(root) {
  if (typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(function (mutations) {
    if (applying || current !== 'en') return;
    applying = true;
    mutations.forEach(function (mutation) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (SELF.has(node)) {
          SELF.delete(node);
          return;
        }
        const value = node.nodeValue;
        const translated = translateText(value);
        if (translated !== value) {
          TEXT_ORIG.set(node, value);
          SELF.add(node);
          node.nodeValue = translated;
        } else if (!TEXT_ORIG.has(node)) {
          TEXT_ORIG.set(node, value);
        }
        return;
      }
      mutation.addedNodes.forEach(function (node) {
        walk(node);
      });
    });
    applying = false;
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true });
}

// 切换界面语言；root 传 document 即可。切回中文时从缓存的原文恢复。
// 没有 document（比如 Node 单测）时只切语言状态，不碰 DOM。
export function applyI18n(root, lang) {
  current = lang === 'en' ? 'en' : 'zh';
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  const scope = root || (typeof document !== 'undefined' ? document : null);
  applying = true;
  walk(scope);
  applying = false;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
  }
  // 动态渲染（术语表分组、导入结果）之后让调用方再刷一次
  if (typeof window !== 'undefined') {
    window.__rimefoxI18nRefresh = function () {
      walk(root || document);
    };
  }
  if (current === 'en') startObserver(scope);
}