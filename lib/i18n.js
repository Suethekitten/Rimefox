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
  '快捷键': 'Shortcuts',
  '翻译 / 还原当前页面。': 'Translate / restore the current page.',
  '浏览器快捷键': 'Browser shortcut',
  '检测中…': 'Checking…',
  '去浏览器里设置': 'Set in browser',
  '页面内快捷键': 'In-page shortcut',
  '点击右边的按钮，然后直接按下组合键（Esc 取消）。': 'Click the button on the right, then press the shortcut (Esc to cancel).',
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
  '当前服务商和模型': 'Current provider and model'
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
