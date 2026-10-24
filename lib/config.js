// 配置读写：所有页面（service worker / options / popup）共用
// 结构（v5 起）：接口配置按"服务商"分别保存（DeepSeek / 硅基流动 / 自定义…各一份），
// 同一协议下的不同服务商不会互相覆盖 Key。行为项保持扁平。
import { PROVIDERS, CUSTOM_PROVIDER_ID, findProviderByBaseUrl, providerById } from './providers.js';
import { normalizeGlossary, assertGlossaryNotes, glossaryNoteUpdateSources } from './glossary.js';
import { isValidAccent, sanitizeTranslationCss, CUSTOM_CSS_MAX } from './appearance.js';
import { normalizeSiteRules, normalizeHosts } from './site-rules.js';

export const ENGINE_IDS = ['openai', 'anthropic', 'gemini'];

// ---------------- 自定义目标语言 ----------------
// 内置语言保持在 LANGUAGES；用户语言独立存 customLanguages，不覆盖内置表。
// id 是配置 / 缓存 / 消息里的稳定身份。有标准代码时用规范 BCP 47 标签作为 code；
// 没有标准代码的虚构语言只用内部 id（cl_…），不伪造语言标签，也不把内部 id 交给 Intl / lang。
export const CUSTOM_LANGUAGE_MAX = 20;
export const CUSTOM_LANGUAGE_NAME_MAX = 40;
export const CUSTOM_LANGUAGE_CODE_MAX = 35;
export const CUSTOM_LANGUAGE_NOTE_MAX = 300;
export const CUSTOM_LANGUAGE_ID_RE = /^cl_[a-z0-9]{4,16}$/;

// 趣味风格强度：统一偏好，只对非 plain 风格生效。强度由提示词层实现，不靠 temperature。
export const FUN_INTENSITIES = [
  {
    value: 'light',
    label: '轻度',
    prompt:
      '风格强度：轻度。只在词汇、语气和修辞上做小幅调整，尽量贴近原文的句式与长度；角色感保持克制，不要每句都加口头禅。'
  },
  {
    value: 'standard',
    label: '标准',
    prompt:
      '风格强度：标准。明显体现该风格，允许适量角色化表达和口语化改写；保持自然，不要机械地给每句加同一个语气词，也不要把示例句式当模板。'
  },
  {
    value: 'exaggerated',
    label: '夸张',
    prompt:
      '风格强度：夸张。允许更鲜明的表演性口吻、感叹和修辞性增补；仍不得改变事实、数字、专名、引用、否定、因果和结论，也不要为了效果添加误导性信息。'
  }
];

// 风格提示词版本：风格文本或强度语义改变时 +1，让旧的风格译文不再命中缓存。
export const STYLE_PROMPT_VERSION = '2';

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id).concat(CUSTOM_PROVIDER_ID);

// 自定义服务商的 id：__custom__ 是老槽位，新建的是 custom:2、custom:3…
const CUSTOM_ID_RE = /^(__custom__|custom:[\w-]+)$/;

function isValidEngine(id) {
  return ENGINE_IDS.indexOf(id) >= 0;
}
function isValidProvider(id) {
  return PROVIDER_IDS.indexOf(id) >= 0 || CUSTOM_ID_RE.test(String(id || ''));
}

export const DEFAULTS = {
  // —— 接口（按服务商分别保存：同一协议下的不同服务商也各存各的） ——
  currentProvider: 'deepseek',
  providerConfig: {},
  // 用户自己保存的自定义服务商：[{ id, name }]，配置在 providerConfig[id] 里
  customProviders: [],

  // 术语表：[{ source, target, category?, note? }]，全局一份（不按服务商分）
  glossary: [],

  temperature: 0.2,
  timeoutMs: 60000,
  // 思考模式：auto（什么都不发）/ off（按服务商发关闭参数）/ custom（原样合并自定义 JSON）
  // 默认尽量关闭思考：翻译不需要推理，开着既慢又可能把 token 预算用光、content 为空（DeepSeek 新模型默认开思考）
  thinkingMode: 'off',
  thinkingExtra: '',
  // 全局附加提示词：追加在 system prompt 末尾；留空不加
  customPrompt: '',
  // professionalProfile 是专业模式的主字段；medicalMode 保留给旧弹窗/导入文件兼容。
  professionalProfile: 'general',
  professionalOptions: { quality: 'balanced', subdomain: 'auto', maxReviewRequests: 1 },
  medicalMode: false,

  // —— 翻译行为 ——
  targetLang: 'zh-CN',
  // 用户自定义目标语言：[{ id, name, code?, note? }]，内置语言仍在 LANGUAGES。
  customLanguages: [],
  // 趣味风格（plain / classical / catgirl）：用户选择的默认风格；具体页面在明确翻译时才应用。
  funStyle: 'plain',
  // 趣味风格强度（light / standard / exaggerated）：只对非 plain 风格生效。
  funIntensity: 'standard',
  // AI 精翻：额外发送有限的相关上下文（默认关闭，不额外发起复核请求）。
  aiContextEnabled: false,
  batchSize: 8,
  maxCharsPerBatch: 2000,
  maxUnitChars: 1200,
  concurrency: 6,
  skipSameLang: true,
  translateOnLoad: false,
  // 只翻屏幕附近（上 1 屏 ~ 下 2 屏），滚动到时再翻远处的：长页面省钱。关掉 = 整页都翻
  lazy: true,
  // 划词翻译：选中文字后怎么触发
  selectionTranslate: true, // 总开关
  selectionMenu: true, // A：右键菜单「凛狐：翻译所选文字」
  selectionButton: true, // B：选区旁小按钮「译」
  selectionImmediate: false, // D：选中即翻译（旧行为，默认关）
  // YouTube 字幕双语：打开 CC 时把字幕换成「原文 + 译文」，只翻播放位置往后一段，按观看时长计费。
  // 默认关闭（0.5.2 起）：非官方功能、打开 CC 就会调接口计费，让用户自己决定要不要开
  subtitleTranslate: false,
  // 悬停对照：鼠标移到已翻译的段落上，高亮这一处的原文和译文（仅译文模式弹气泡显示原文）
  hoverCompare: true,
  // —— 隐私保护（可选，默认关闭）——
  // 翻译前在本地把敏感信息换成占位符，回包后还原；映射只存在单次请求的内存里。
  // 默认关闭，且关闭时翻译管线行为与之前完全一致。
  privacyEnabled: false,
  privacyMaskEmail: true,
  privacyMaskPhone: true,
  privacyMaskIdCard: true,
  privacyMaskBankCard: true,
  privacyMaskUserName: false,
  debug: false,
  // 页面级快捷键（我自己解析，可在设置里改；浏览器 commands 的那条写死在 manifest 里）
  hotkey: 'alt+a',
  // 输入框翻译（0.9.0）：在可编辑区域里按这个键，把这段文字翻成目标语言后原地写回
  inputHotkey: 'alt+i',
  // 输入框翻译的目标语言：auto = 跟随页面语言（<html lang> 认得出就用，认不出用英文）
  inputTargetLang: 'auto',

  // —— 显示 ——
  mode: 'dual', // dual | translation
  theme: 'underline', // none | underline | dashed | highlight | mask
  chromeBilingual: false,
  // 设置页 / 弹窗的界面主题：auto 跟随系统，light / dark 固定
  uiTheme: 'auto',
  // 界面语言：zh 中文 / en English（只影响设置页和弹窗）
  uiLang: 'zh',

  // —— 外观（0.7.0）——
  accentColor: 'violet', // 强调色：预设 id 或 #rrggbb；设置页、弹窗、网页里译文的下划线 / 高亮 / 气泡都跟着变
  reduceTransparency: false, // 减少透明和模糊（设置页 / 弹窗 / 悬浮入口）
  disableShadow: false, // 关闭阴影
  liquidGlass: true, // 液态玻璃（设置页左侧导航 + 弹窗底部工具坞）；关闭后回到普通样式
  typoFontScale: 100, // 译文字号（相对原文的百分比）
  typoLineHeight: 0, // 译文行高（0 = 跟随原文）
  typoGap: 3, // 译文与原文的段距（单位 0.1em）
  typoIndent: false, // 译文首行缩进

  // —— 站点与兼容性（0.7.0）——
  pageDarkAdapt: true, // 深色网页上自动换一套译文颜色
  siteRules: [], // 用户自己的站点规则（见 lib/site-rules.js）
  nightMode: false, // 网页夜间模式（Beta）：只在 nightSites 里的网站生效
  nightSites: [],
  customCss: '', // 译文自定义 CSS：只写属性声明，只作用于 .dt-target

  // —— 浮层与入口（0.7.0）——
  dockEnabled: false, // 网页边上的悬浮入口
  dockSide: 'right', // right | left
  dockAutoHide: true, // 平时只露出一小截
  dockPos: null // 拖拽后的位置 {x,y}；null = 跟 dockSide 贴边（0.9.3）
};

export const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
  { value: 'pt', label: 'Português' }
];

export const THEMES = [
  { value: 'none', label: '无样式' },
  { value: 'underline', label: '下划线' },
  { value: 'dashed', label: '虚线框' },
  { value: 'highlight', label: '高亮' },
  { value: 'mask', label: '半透明' }
];

// 趣味翻译：语言 × 风格（风格不是目标语言，能和任何目标语言组合）。
// 只在弹窗里对当前页生效、不写进配置（一次性动作，省钱，也不会让别的页面意外变成猫娘语气）。
// prompt 会替换提示词里的规则 4（见 lib/prompt.js）；temperature 覆盖用户设置，风格需要更放开一点。
export const STYLES = [
  { value: 'plain', label: '普通', temperature: null, prompt: '' },
  {
    value: 'classical',
    label: '文言文',
    temperature: 0.5,
    prompt:
      '把译文写成文言文：多用单音节词与文言虚词（之、其、乃、焉、矣、乎），句式短促，避用现代口语与网络用语；' +
      '目标语言不是中文时，改用该语言里古雅庄重的书面文体。专名、代码、URL 原样保留。'
  },
  {
    value: 'catgirl',
    label: '傲娇猫娘',
    temperature: 0.8,
    // 角色有独立性格，允许有限的文学化 / 口语化改写；事实、数字、引用和专业结论仍然锁死。
    prompt:
      '把译文写成一只傲娇猫娘的口吻，像轻小说里有独立性格的猫娘角色，而不是机械地给每句话加「喵」：' +
      '中文自称「本喵」或「人家」，偶尔用「我」；语气词在「喵、喵呜、呀、嘛、啦、欸嘿、哼、呜…」里混用，每段「喵」最多 1–2 次，不要每句都加；' +
      '语气活泼、会撒娇，偶尔傲娇（「才不是…呢」「哼，本喵才没有」），句子短、口语化；' +
      '允许为了角色感做有限的文学化、口语化和角色化改写，可以加入少量自称、撒娇、傲娇转折和轻微吐槽，但不要每段套同一个句式，也不要让角色感盖过原文；' +
      '目标语言不是中文时用当地猫娘的对应说法（英文 nya / meow、日语 にゃ、韩语 냥），同样不要每句都用，也不要把中文语气词机械地拼接到别的语言里。' +
      '内容边界：数字、日期、剂量、引用、价格、代码、URL、专有名词、研究结果和客观事实不增不减；医疗说明、法律条款、金融风险、严重安全警告等高敏感内容采用保守表达，不因角色扮演添加可能误导用户的事实或指示；新闻和学术正文只做轻度口吻变化，事实关系、否定、因果和证据强弱不变。不要色情低俗。'
  }
];

export function normalizeIntensity(id) {
  const value = String(id == null ? '' : id).trim();
  return FUN_INTENSITIES.some((one) => one.value === value) ? value : 'standard';
}

export function normalizeFunStyle(id) {
  return styleById(id).value;
}

export function intensityById(id) {
  const value = normalizeIntensity(id);
  return FUN_INTENSITIES.find((one) => one.value === value) || FUN_INTENSITIES[1];
}

// 风格提示词 = 风格本体 + 强度说明；plain 永远为空（普通翻译不因强度突然文学化）。
export function stylePrompt(styleId, intensity) {
  const style = styleById(styleId);
  if (style.value === 'plain') return '';
  return style.prompt + '\n' + intensityById(intensity).prompt;
}

// 风格译文缓存身份：只在非 plain 时追加，普通翻译的旧键逐字不变。
export function styleFingerprint(styleId, intensity) {
  const style = styleById(styleId);
  if (style.value === 'plain') return '';
  return 'style-v' + STYLE_PROMPT_VERSION + ':' + style.value + ':' + normalizeIntensity(intensity);
}

// ---------------- 自定义语言：清洗 / BCP 47 / 展示 / 检测 ----------------
function sliceCodePoints(value, max) {
  const chars = Array.from(String(value == null ? '' : value));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

function cleanLanguageName(value) {
  return sliceCodePoints(
    String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    CUSTOM_LANGUAGE_NAME_MAX
  );
}

function cleanLanguageNote(value) {
  return sliceCodePoints(
    String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, ' ')
      .trim(),
    CUSTOM_LANGUAGE_NOTE_MAX
  );
}

// 只接受结构合法、可被 Intl 规范化的 BCP 47 标签。
// 拒绝私有语言标签（x-…）和 und：它们不是可审核的标准目标语言，也不能拿去做 lang 属性。
export function canonicalLanguageTag(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > CUSTOM_LANGUAGE_CODE_MAX) return '';
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(raw)) return '';
  if (/^x(?:-|$)/i.test(raw) || /^und$/i.test(raw)) return '';
  try {
    if (typeof Intl === 'undefined' || typeof Intl.getCanonicalLocales !== 'function') return '';
    const list = Intl.getCanonicalLocales(raw);
    if (list.length !== 1) return '';
    const tag = String(list[0]);
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return '';
    return tag;
  } catch (err) {
    return '';
  }
}

export function makeCustomLanguageId(existing) {
  const used = new Set((Array.isArray(existing) ? existing : []).map((one) => one && one.id));
  for (let i = 0; i < 40; i += 1) {
    let random = '';
    try {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      random = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    }
    const id = 'cl_' + random.slice(0, 8);
    if (!used.has(id)) return id;
  }
  return 'cl_' + Date.now().toString(36).slice(-8);
}

// 配置 / 导入 / 合并共用的清洗：非法 id、空名、重复名、无效代码、重复代码都丢弃。
// 名称与代码都属于用户数据，只作为数据保存；展示走 textContent，提示词走 JSON 编码。
export function normalizeCustomLanguages(list) {
  const out = [];
  const ids = new Set();
  const names = new Set(LANGUAGES.map((one) => one.label.toLowerCase()));
  const codes = new Set(LANGUAGES.map((one) => one.value.toLowerCase()));
  (Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const id = String(row.id == null ? '' : row.id).trim();
    if (!CUSTOM_LANGUAGE_ID_RE.test(id) || ids.has(id)) return;
    const name = cleanLanguageName(row.name);
    if (!name) return;
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) return;
    const rawCode = String(row.code == null ? '' : row.code).trim();
    const code = rawCode ? canonicalLanguageTag(rawCode) : '';
    if (rawCode && !code) return;
    if (code && codes.has(code.toLowerCase())) return;
    const note = cleanLanguageNote(row.note);
    out.push({ id, name, code, note });
    ids.add(id);
    names.add(nameKey);
    if (code) codes.add(code.toLowerCase());
    if (out.length >= CUSTOM_LANGUAGE_MAX) return;
  });
  return out.slice(0, CUSTOM_LANGUAGE_MAX);
}

// 设置页 / 导入用的逐条校验（返回错误码，空字符串表示通过）。
export function customLanguageError(entry, existing, opts) {
  const options = opts || {};
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'bad_value';
  const id = String(entry.id == null ? '' : entry.id).trim();
  if (!CUSTOM_LANGUAGE_ID_RE.test(id)) return 'bad_id';
  const rawName = String(entry.name == null ? '' : entry.name).trim();
  if (!rawName) return 'name_required';
  if (Array.from(rawName).length > CUSTOM_LANGUAGE_NAME_MAX) return 'name_too_long';
  const rawCode = String(entry.code == null ? '' : entry.code).trim();
  if (rawCode.length > CUSTOM_LANGUAGE_CODE_MAX) return 'code_too_long';
  const code = rawCode ? canonicalLanguageTag(rawCode) : '';
  if (rawCode && !code) return 'bad_code';
  const rawNote = String(entry.note == null ? '' : entry.note);
  if (Array.from(rawNote).length > CUSTOM_LANGUAGE_NOTE_MAX) return 'note_too_long';
  const name = cleanLanguageName(rawName);
  if (!name) return 'bad_value';
  const nameKey = name.toLowerCase();
  const ignoreId = String(options.ignoreId || '');
  const rows = normalizeCustomLanguages(existing);
  const others = ignoreId ? rows.filter((row) => row.id !== ignoreId) : rows;
  if (others.length >= CUSTOM_LANGUAGE_MAX) return 'full';
  if (LANGUAGES.some((one) => one.label.toLowerCase() === nameKey)) return 'duplicate_name';
  for (const row of rows) {
    if (ignoreId && row.id === ignoreId) continue;
    if (row.name.toLowerCase() === nameKey) return 'duplicate_name';
    if (code && row.code && row.code.toLowerCase() === code.toLowerCase()) return 'duplicate_code';
  }
  if (code && LANGUAGES.some((one) => one.value.toLowerCase() === code.toLowerCase())) return 'duplicate_code';
  return '';
}

function scriptFromCode(code) {
  const parts = String(code || '').toLowerCase().split('-').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    if (/^[a-z]{4}$/.test(parts[i])) return parts[i];
  }
  const base = parts[0] || '';
  if (base === 'zh') return /-(tw|hk|mo|hant)\b/.test(String(code).toLowerCase()) ? 'hant' : 'hans';
  if (base === 'ja') return 'jpan';
  if (base === 'ko') return 'kore';
  if (base === 'ar') return 'arab';
  if (base === 'he') return 'hebr';
  return '';
}

function detectForLanguage(code) {
  const base = String(code || '').toLowerCase().split('-')[0];
  if (base === 'zh' || base === 'cmn') return 'zh';
  if (base === 'ja') return 'ja';
  if (base === 'ko') return 'ko';
  if (base === 'en') return 'en';
  // yue / lzh / wuu / nan 等中文系语言与普通话共享汉字，无法高置信度区分；
  // 未知代码同样返回 none：宁可多翻，也不因误判跳过本应翻译的文字。
  return 'none';
}

function cjkForLanguage(code) {
  const base = String(code || '').toLowerCase().split('-')[0];
  const script = scriptFromCode(code);
  return (
    ['zh', 'ja', 'ko', 'yue', 'lzh', 'wuu', 'nan', 'hak', 'cmn'].indexOf(base) >= 0 ||
    ['hans', 'hant', 'jpan', 'kore', 'hang'].indexOf(script) >= 0
  );
}

function infoOf(value, label, code, kind, note) {
  return {
    value,
    name: label,
    label,
    code: code || '',
    kind,
    note: note || '',
    detect: kind === 'custom' ? detectForLanguage(code) : detectForLanguage(value),
    script: scriptFromCode(code || value),
    cjk: cjkForLanguage(code || value)
  };
}

export function languageInfoFor(value, customLanguages) {
  const wanted = String(value == null ? '' : value).trim();
  if (!wanted) return null;
  const builtin = LANGUAGES.find((one) => one.value.toLowerCase() === wanted.toLowerCase());
  if (builtin) return infoOf(builtin.value, builtin.label, builtin.value, 'builtin', '');
  const customs = normalizeCustomLanguages(customLanguages);
  const custom =
    customs.find((one) => one.id === wanted) ||
    customs.find((one) => one.code && one.code.toLowerCase() === wanted.toLowerCase());
  if (custom) return infoOf(custom.id, custom.name, custom.code, 'custom', custom.note);
  return null;
}

export function languageOptions(customLanguages) {
  const customs = normalizeCustomLanguages(customLanguages);
  const builtins = LANGUAGES.map((one) => {
    const info = infoOf(one.value, one.label, one.value, 'builtin', '');
    return { value: info.value, label: info.label, code: info.code, kind: 'builtin', detect: info.detect, script: info.script, cjk: info.cjk };
  });
  const custom = customs.map((one) => {
    const info = infoOf(one.id, one.name, one.code, 'custom', one.note);
    return { value: info.value, label: info.label, code: info.code, kind: 'custom', detect: info.detect, script: info.script, cjk: info.cjk };
  });
  return builtins.concat(custom);
}

export function normalizeTargetLang(value, customLanguages) {
  const wanted = String(value == null ? '' : value).trim();
  if (!wanted) return DEFAULTS.targetLang;
  if (LANGUAGES.some((one) => one.value === wanted)) return wanted;
  if (normalizeCustomLanguages(customLanguages).some((one) => one.id === wanted)) return wanted;
  return DEFAULTS.targetLang;
}

export function normalizeInputTarget(value, customLanguages) {
  const wanted = String(value == null ? '' : value).trim();
  if (!wanted || wanted === 'auto') return 'auto';
  if (LANGUAGES.some((one) => one.value === wanted)) return wanted;
  if (normalizeCustomLanguages(customLanguages).some((one) => one.id === wanted)) return wanted;
  return 'auto';
}

// 自定义语言参与模型输出时，名称 / 代码 / 说明都要进缓存身份；内置语言不追加，旧键逐字不变。
export function customLanguageFingerprint(info) {
  if (!info || info.kind !== 'custom') return '';
  const seed = JSON.stringify([info.id, info.name, info.code || '', info.note || '']);
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'lang-v1:' + hash.toString(36);
}

// 输入框翻译的目标语言：显式设置优先；auto / 空 = 跟随页面 <html lang>，认不出来用英文。
// pref = 配置里的 inputTargetLang（或消息里的 target），pageLang = document.documentElement.lang。
// 内容脚本不 import：content/input.js 只把 pageLang 一起发过来，由后台调这里，语言表只有一份。
export function resolveInputTarget(pref, pageLang, customLanguages) {
  const customs = normalizeCustomLanguages(customLanguages);
  const options = languageOptions(customs);
  const chosen = String(pref == null ? '' : pref).trim();
  if (chosen && chosen !== 'auto') {
    const byValue = options.find((one) => one.value.toLowerCase() === chosen.toLowerCase());
    if (byValue) return byValue.value;
    const byCode = options.find((one) => one.code && one.code.toLowerCase() === chosen.toLowerCase());
    if (byCode) return byCode.value;
  }
  const raw = String(pageLang == null ? '' : pageLang).trim().toLowerCase();
  if (raw) {
    const exact = options.find((one) => one.value.toLowerCase() === raw);
    if (exact) return exact.value;
    // 先认自定义语言的标准代码（zh-HK / yue-Hant-HK），再退回内置语言的主语言段；
    // 否则自定义「香港中文」会被内置 zh-CN 抢走。
    const byCode = options.find((one) => one.code && one.code.toLowerCase() === raw);
    if (byCode) return byCode.value;
    const base = raw.split('-')[0];
    const byBase = options.find((one) => one.value.toLowerCase().split('-')[0] === base);
    if (byBase) return byBase.value;
    const codeBase = options.find((one) => one.code && one.code.toLowerCase().split('-')[0] === base);
    if (codeBase) return codeBase.value;
  }
  return 'en';
}

// 导入时把文件里的自定义语言补进本机列表（同 id 用文件里的新内容，其余本机语言保留）。
export function mergeCustomLanguageLists(current, incoming) {
  const out = normalizeCustomLanguages(current).map((one) => ({ ...one }));
  normalizeCustomLanguages(incoming).forEach((one) => {
    const hit = out.find((row) => row.id === one.id);
    if (hit) Object.assign(hit, one);
    else out.push({ ...one });
  });
  return normalizeCustomLanguages(out);
}

export function styleById(id) {
  return STYLES.find((s) => s.value === id) || STYLES[0];
}

// ---- 平台相关的叫法（Chrome / Edge，Mac / Windows）----
// 内容脚本不能 import，content/core.js 里有一份同样逻辑的 DT.hotkeyLabel，改这里记得同步。
export const IS_MAC = /mac/i.test(
  (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
);
export const IS_EDGE = /\bEdg\//.test(navigator.userAgent || '');

// "alt+shift+a" → Mac："Option + Shift + A"；其它："Alt + Shift + A"
export function hotkeyLabel(spec) {
  const names = IS_MAC ? { alt: 'Option', ctrl: 'Control', shift: 'Shift' } : { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift' };
  return String(spec || 'alt+a')
    .split('+')
    .filter(Boolean)
    .map((part) => {
      const p = part.trim().toLowerCase();
      if (names[p]) return names[p];
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' + ');
}

// 刷新页面 / 打开控制台 / 扩展管理页，在不同浏览器和系统上的叫法
export const KEYS = IS_MAC
  ? { reload: '⌘R', console: '⌥⌘J', submit: '⌘+Enter' }
  : { reload: 'F5', console: 'F12', submit: 'Ctrl+Enter' };
export const EXTENSIONS_PAGE = IS_EDGE ? 'edge://extensions' : 'chrome://extensions';
export const FILE_ACCESS_LABEL = IS_EDGE ? '允许访问文件 URL' : '允许访问文件网址';
export const SHORTCUTS_PAGE = EXTENSIONS_PAGE + '/shortcuts';

// 浏览器实际分配给"翻译 / 还原"的快捷键（如 Mac 上的 "⌥A"）。
// 空字符串 = 没分配到：manifest 里的 Alt+A 被别的扩展占用了，或用户在快捷键页清掉了；
// null = 读不到（不是扩展页面等）
export async function browserShortcut() {
  try {
    const all = await chrome.commands.getAll();
    const cmd = all.find((c) => c.name === 'toggle-translate');
    return cmd ? cmd.shortcut || '' : null;
  } catch (err) {
    return null;
  }
}

// 打开浏览器的扩展快捷键设置页（普通链接点不开 chrome:// 地址，要用 tabs.create）
export function openShortcutsPage() {
  chrome.tabs.create({ url: SHORTCUTS_PAGE });
}

export function langLabel(code, customLanguages) {
  const info = languageInfoFor(code, customLanguages);
  if (info) return info.label;
  const hit = LANGUAGES.find((x) => x.value === code);
  return hit ? hit.label : code;
}

// 配置版本：
// 3：并发默认 4 → 6
// 4：接口配置改为按协议分开保存（engine + engineConfig）
// 5：改为按服务商分开保存（currentProvider + providerConfig）
// 6：自定义服务商支持命名与多个（customProviders 列表）
// 7：专业模式主字段与质量策略；保留 medicalMode 的双向兼容。
// 8：自定义目标语言、趣味风格强度、AI 精翻开关（只新增字段，不清缓存/不改旧值）。
export const CONFIG_VERSION = 8;

export function professionalProfileFor(value) {
  const cfg = value || {};
  if (cfg.professionalProfile === 'medical' || cfg.professionalProfile === 'general') return cfg.professionalProfile;
  return cfg.medicalMode === true ? 'medical' : 'general';
}

export function normalizeProfessionalOptions(value, base) {
  const defaults = DEFAULTS.professionalOptions;
  const fallback = base && typeof base === 'object' && !Array.isArray(base) ? base : defaults;
  const options = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const merged = { ...defaults, ...fallback, ...options };
  const requests = Number(merged.maxReviewRequests);
  return {
    quality: ['fast', 'balanced', 'strict'].includes(merged.quality) ? merged.quality : defaults.quality,
    subdomain: typeof merged.subdomain === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(merged.subdomain) ? merged.subdomain : defaults.subdomain,
    maxReviewRequests: Number.isFinite(requests) ? Math.max(0, Math.min(3, Math.floor(requests))) : defaults.maxReviewRequests
  };
}

// 取某个服务商的配置（没保存过就用模板默认值）
export function slotFor(cfg, providerId) {
  const conf = cfg || {};
  const id = isValidProvider(providerId) ? providerId : DEFAULTS.currentProvider;
  const stored = (conf.providerConfig && conf.providerConfig[id]) || {};
  const tpl = providerById(id);

  const engine = isValidEngine(stored.engine) ? stored.engine : tpl ? tpl.engine : 'openai';

  return {
    provider: id,
    engine,
    // 自定义服务商没有模板地址，默认留空让用户自己填
    baseUrl:
      typeof stored.baseUrl === 'string' && stored.baseUrl ? stored.baseUrl : tpl ? tpl.baseUrl : '',
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    model: typeof stored.model === 'string' ? stored.model : ''
  };
}

// 当前生效的服务商配置（后台 / 设置页共用）
export function activeConfig(cfg) {
  const conf = cfg || {};
  return slotFor(conf, conf.currentProvider || DEFAULTS.currentProvider);
}

// 可切换的服务商列表（给悬浮入口 / 弹窗用）：只含配置过的槽位，标出当前与是否有 Key。
// 不返回 Key 本身；顺序：当前在前，其次有 Key 的，最后其余。
export function providerChoices(cfg) {
  const c = cfg || {};
  const slots = c.providerConfig || {};
  const customs = c.customProviders || [];
  const ids = [];
  Object.keys(slots).forEach((id) => {
    // 不在列表里的自定义槽位是已删除的服务商留下的，不能再出现在切换列表里
    if (CUSTOM_ID_RE.test(id) && !customs.some((p) => p.id === id)) return;
    ids.push(id);
  });
  customs.forEach((p) => {
    if (ids.indexOf(p.id) < 0) ids.push(p.id);
  });

  const list = ids.map((id) => {
    const slot = slots[id] || {};
    const custom = customs.filter((p) => p.id === id)[0];
    const preset = providerById(id);
    return {
      id,
      name: (custom && custom.name) || (preset && preset.name) || id,
      model: slot.model || '',
      hasKey: !!slot.apiKey,
      current: id === c.currentProvider
    };
  });

  return list.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.hasKey !== b.hasKey) return a.hasKey ? -1 : 1;
    return 0;
  });
}

// 纯函数：把任意历史版本的配置整理成 v5 结构（不碰存储，可单测）
export function migrateConfig(stored) {
  const src = stored || {};
  const version = Number(src._v) || 1;
  const next = { ...src };

  // v3：旧版本把并发/批量固化成旧默认值，升级时纠偏一次
  if (version < 3) {
    next.batchSize = DEFAULTS.batchSize;
    next.maxCharsPerBatch = DEFAULTS.maxCharsPerBatch;
    next.concurrency = DEFAULTS.concurrency;
  }

  if (version < 5) {
    const providerConfig =
      src.providerConfig && typeof src.providerConfig === 'object' ? { ...src.providerConfig } : {};

    // v4：按协议存的（engine + engineConfig）→ 按服务商拆开
    const legacy = src.engineConfig && typeof src.engineConfig === 'object' ? src.engineConfig : {};
    let migratedCurrent = '';

    ENGINE_IDS.forEach((engineId) => {
      const one = legacy[engineId];
      if (!one || typeof one !== 'object') return;
      const hit = findProviderByBaseUrl(one.baseUrl);
      const pid = hit ? hit.id : CUSTOM_PROVIDER_ID;
      providerConfig[pid] = {
        engine: engineId,
        baseUrl: typeof one.baseUrl === 'string' ? one.baseUrl : '',
        apiKey: typeof one.apiKey === 'string' ? one.apiKey : '',
        model: typeof one.model === 'string' ? one.model : ''
      };
      if (!migratedCurrent && engineId === (src.engine || 'openai')) migratedCurrent = pid;
    });

    // v3 及更早：扁平字段
    if (src.baseUrl || src.apiKey || src.model) {
      const hit = findProviderByBaseUrl(src.baseUrl);
      const pid = hit ? hit.id : CUSTOM_PROVIDER_ID;
      providerConfig[pid] = {
        engine: 'openai',
        baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl : '',
        apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
        model: typeof src.model === 'string' ? src.model : ''
      };
      if (!migratedCurrent) migratedCurrent = pid;
    }

    next.providerConfig = providerConfig;
    next.currentProvider = migratedCurrent || (isValidProvider(src.currentProvider) ? src.currentProvider : DEFAULTS.currentProvider);
    delete next.engine;
    delete next.engineConfig;
    delete next.baseUrl;
    delete next.apiKey;
    delete next.model;
  }

  // v6：自定义服务商可命名、可多个；把已存在的自定义槽补进列表
  if (version < 6) {
    const list = Array.isArray(next.customProviders)
      ? next.customProviders.filter((p) => p && isValidProvider(p.id) && CUSTOM_ID_RE.test(String(p.id)))
      : [];
    const has = (id) => list.some((p) => p.id === id);
    Object.keys(next.providerConfig || {}).forEach((id) => {
      if (!CUSTOM_ID_RE.test(String(id)) || has(id)) return;
      list.push({ id, name: '自定义 ' + (list.length + 1) });
    });
    next.customProviders = list;
  }

  next.professionalProfile = professionalProfileFor(src);
  next.professionalOptions = normalizeProfessionalOptions(src.professionalOptions);
  next.medicalMode = next.professionalProfile === 'medical';

  // v8：新增字段只做清洗，不覆盖旧值、不清缓存。
  if (version < 8) {
    const custom = normalizeCustomLanguages(next.customLanguages);
    next.customLanguages = custom;
    next.funStyle = normalizeFunStyle(next.funStyle);
    next.funIntensity = normalizeIntensity(next.funIntensity);
    next.aiContextEnabled = next.aiContextEnabled === true;
    if (next.targetLang !== undefined) next.targetLang = normalizeTargetLang(next.targetLang, custom);
    if (next.inputTargetLang !== undefined) next.inputTargetLang = normalizeInputTarget(next.inputTargetLang, custom);
  }

  next._v = CONFIG_VERSION;
  return next;
}

// 深合并：providerConfig 按服务商逐个合并，避免整体覆盖
export function mergeConfig(base, patch) {
  const b = base || {};
  const p = patch || {};
  const out = { ...b, ...p };

  // 显式的新字段优先；旧 UI 只写 medicalMode 时仍必须能开/关已有 profile。
  if (p.professionalProfile === 'general' || p.professionalProfile === 'medical') {
    out.professionalProfile = p.professionalProfile;
  } else if (typeof p.medicalMode === 'boolean') {
    out.professionalProfile = p.medicalMode ? 'medical' : 'general';
  } else {
    out.professionalProfile = professionalProfileFor(b);
  }
  out.medicalMode = out.professionalProfile === 'medical';
  out.professionalOptions = normalizeProfessionalOptions(p.professionalOptions, b.professionalOptions);

  // 自定义语言 / 趣味强度 / AI 精翻：每次保存都清洗；删除正在使用的自定义语言时
  // targetLang 回退到简体中文、inputTargetLang 回退到 auto，绝不留下空值或无效代码。
  out.customLanguages = normalizeCustomLanguages(p.customLanguages !== undefined ? p.customLanguages : b.customLanguages);
  out.targetLang = normalizeTargetLang(p.targetLang !== undefined ? p.targetLang : b.targetLang, out.customLanguages);
  out.inputTargetLang = normalizeInputTarget(p.inputTargetLang !== undefined ? p.inputTargetLang : b.inputTargetLang, out.customLanguages);
  out.funStyle = normalizeFunStyle(p.funStyle !== undefined ? p.funStyle : b.funStyle);
  out.funIntensity = normalizeIntensity(p.funIntensity !== undefined ? p.funIntensity : b.funIntensity);
  out.aiContextEnabled = (p.aiContextEnabled !== undefined ? p.aiContextEnabled : b.aiContextEnabled) === true;

  const slots = { ...(b.providerConfig || {}) };
  Object.keys(p.providerConfig || {}).forEach((id) => {
    slots[id] = { ...(slots[id] || {}), ...(p.providerConfig[id] || {}) };
  });
  // 自定义服务商的槽位跟着列表走：列表里没有了（设置页「删除」）就连同 Key 一起删掉。
  // 上面按服务商逐个合并，只删 patch 里的槽位删不掉存储里的旧槽位，悬浮入口还能切过去
  if (Array.isArray(p.customProviders)) {
    const keep = new Set(p.customProviders.map((one) => one && one.id));
    Object.keys(slots).forEach((id) => {
      if (CUSTOM_ID_RE.test(id) && !keep.has(id)) delete slots[id];
    });
  }
  out.providerConfig = slots;
  // 术语表统一清洗（去空 / 去重 / 限条数），不管来自旧配置还是设置页
  out.glossary = normalizeGlossary(p.glossary !== undefined ? p.glossary : b.glossary);
  // 站点规则 / 夜间名单同样每次清洗，不管来自哪里都不让坏数据落盘
  out.siteRules = normalizeSiteRules(p.siteRules !== undefined ? p.siteRules : b.siteRules).rules;
  out.nightSites = normalizeHosts(p.nightSites !== undefined ? p.nightSites : b.nightSites);
  // 悬浮窗拖拽位置：不管来自哪里都清洗成 {x,y} 或 null，坏数据不落盘
  out.dockPos = normalizeDockPos(p.dockPos !== undefined ? p.dockPos : b.dockPos);
  return out;
}

export async function getConfig() {
  try {
    const got = await chrome.storage.local.get(['config', 'config_backup_v3']);
    const stored = (got && got.config) || {};

    if ((Number(stored._v) || 1) < CONFIG_VERSION) {
      const next = migrateConfig(stored);
      try {
        // 迁移前留一份原始配置，出问题能回退
        if (!got.config_backup_v3) {
          await chrome.storage.local.set({ config_backup_v3: stored });
        }
        await chrome.storage.local.set({ config: next });
      } catch (err) {
        /* 迁移写失败不阻塞使用 */
      }
      return mergeConfig(DEFAULTS, next);
    }

    return mergeConfig(DEFAULTS, stored);
  } catch (err) {
    return mergeConfig(DEFAULTS, {});
  }
}

// 同一个页面 / service worker 里的保存排队执行：保存是「读 → 合并 → 写」，两次交错时后写的会盖掉先写的
// （悬浮入口里连着点「切换显示方式」和「悬停对照」，其中一项就丢了）。
// 不同页面之间（弹窗 / 设置页 / 后台）仍可能交错：设置页保存时会提示「设置在别的页面被修改过」
// patch 也可为同步函数：在队列内根据最新配置生成补丁；返回 null 时不写存储。
let saveQueue = Promise.resolve();

export function saveConfig(patch) {
  const run = saveQueue.then(async () => {
    const current = await getConfig();
    const change = typeof patch === 'function' ? patch(current) : patch || {};
    if (change === null) return current;
    if (change.glossary !== undefined) assertGlossaryNotes(change.glossary);
    const next = mergeConfig(current, change);
    next._v = CONFIG_VERSION;
    await chrome.storage.local.set({ config: next });
    return next;
  });
  saveQueue = run.catch(() => {});
  return run;
}

// ---------------- 配置导入 ----------------
// 导出文件的身份标记与结构版本。导入时必须严格匹配，否则任何 JSON
// 只要碰巧有同名键（比如别的软件的 "theme"）就会被当成配置吞进来。
export const IMPORT_APP = 'rimefox';
export const IMPORT_SCHEMA = 1;

// 数值项的合理范围：越界的值直接丢弃，不写进配置
const CONFIG_RANGES = {
  temperature: [0, 2],
  timeoutMs: [5000, 300000],
  batchSize: [1, 50],
  maxCharsPerBatch: [200, 12000],
  maxUnitChars: [200, 6000],
  concurrency: [1, 16],
  typoFontScale: [70, 160],
  typoLineHeight: [0, 3],
  typoGap: [0, 20]
};

const ENUM_VALUES = {
  professionalProfile: ['general', 'medical'],
  funIntensity: FUN_INTENSITIES.map((x) => x.value),
  theme: THEMES.map((x) => x.value),
  mode: ['dual', 'translation'],
  thinkingMode: ['auto', 'off', 'custom'],
  uiTheme: ['auto', 'light', 'dark'],
  uiLang: ['zh', 'en'],
  dockSide: ['right', 'left']
};

// 与内容脚本 matchesHotkey 的格式保持一致："alt+a" / "alt+shift+a" / "ctrl+shift+t"
const HOTKEY_RE = /^(alt|ctrl)(\+shift)?\+[a-z0-9]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

function normalizeDockPos(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Math.round(Number(value.x));
  const y = Math.round(Number(value.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function isValidValue(key, value) {
  if (ENUM_VALUES[key]) return ENUM_VALUES[key].indexOf(value) >= 0;
  if (key === 'hotkey' || key === 'inputHotkey') return HOTKEY_RE.test(value);
  if (key === 'baseUrl') return URL_RE.test(value);
  if (key === 'model') return value.length > 0 && value.length <= 100;
  if (key === 'thinkingExtra') return value.length <= 2000;
  if (key === 'customPrompt') return value.length <= 2000;
  if (key === 'accentColor') return isValidAccent(value);
  if (key === 'customCss') return value.length <= CUSTOM_CSS_MAX && !sanitizeTranslationCss(value).errors.length;
  return true;
}

// 解析导入文件。返回 { config, rejected }：
//   config   —— 只含已知字段、类型与取值都合法的项
//   rejected —— 值不合法的字段名（用于提示，不会写进配置）
export function pickImportedConfig(raw, opts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('文件内容不是一个 JSON 对象');
  }
  if (raw.app !== IMPORT_APP) {
    throw new Error('这不是凛狐的配置文件（缺少 app="rimefox" 标记）');
  }
  if (!Number.isFinite(Number(raw.schema))) {
    throw new Error('配置文件缺少 schema 版本号');
  }
  if (Number(raw.schema) > IMPORT_SCHEMA) {
    throw new Error('配置文件版本比当前扩展新，请先升级扩展');
  }
  if (!raw.config || typeof raw.config !== 'object' || Array.isArray(raw.config)) {
    throw new Error('配置文件里没有 config 对象');
  }

  const src = raw.config;
  const out = {};
  const rejected = [];

  Object.keys(DEFAULTS).forEach((key) => {
    if (key === 'currentProvider' || key === 'providerConfig') return; // 下面单独处理
    // 这三个要跟自定义语言一起校验，不能在通用字符串分支里按内置名单拒掉
    if (key === 'targetLang' || key === 'inputTargetLang' || key === 'customLanguages') return;

    const def = DEFAULTS[key];
    const val = src[key];
    if (val === undefined || val === null) return;

    if (typeof def === 'boolean') {
      out[key] = !!val;
      return;
    }

    if (typeof def === 'number') {
      const n = Number(val);
      const range = CONFIG_RANGES[key];
      if (!Number.isFinite(n) || (range && (n < range[0] || n > range[1]))) {
        rejected.push(key);
        return;
      }
      out[key] = n;
      return;
    }

    if (typeof def === 'string') {
      if (typeof val !== 'string' || !isValidValue(key, val)) {
        rejected.push(key);
        return;
      }
      out[key] = val;
    }
  });

  if (src.professionalOptions !== undefined) {
    const options = src.professionalOptions;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      rejected.push('professionalOptions');
    } else {
      const accepted = {};
      if (options.quality !== undefined) {
        if (['fast', 'balanced', 'strict'].includes(options.quality)) accepted.quality = options.quality;
        else rejected.push('professionalOptions.quality');
      }
      if (options.subdomain !== undefined) {
        if (typeof options.subdomain === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(options.subdomain)) accepted.subdomain = options.subdomain;
        else rejected.push('professionalOptions.subdomain');
      }
      if (options.maxReviewRequests !== undefined) {
        const limit = Number(options.maxReviewRequests);
        if (Number.isInteger(limit) && limit >= 0 && limit <= 3) accepted.maxReviewRequests = limit;
        else rejected.push('professionalOptions.maxReviewRequests');
      }
      if (Object.keys(accepted).length) out.professionalOptions = accepted;
    }
  }
  // 导入旧配置也补齐主字段；两字段冲突时显式 profile 优先。
  if (out.professionalProfile !== undefined || out.medicalMode !== undefined) {
    out.professionalProfile = professionalProfileFor(out);
    out.medicalMode = out.professionalProfile === 'medical';
  }

  // 当前服务商
  if (src.currentProvider !== undefined && src.currentProvider !== null) {
    if (typeof src.currentProvider === 'string' && isValidProvider(src.currentProvider)) {
      out.currentProvider = src.currentProvider;
    } else {
      rejected.push('currentProvider');
    }
  }

  // 按服务商分开的接口配置
  if (src.providerConfig && typeof src.providerConfig === 'object' && !Array.isArray(src.providerConfig)) {
    const conf = {};
    Object.keys(src.providerConfig).forEach((id) => {
      if (!isValidProvider(id)) {
        rejected.push('providerConfig.' + id);
        return;
      }
      const cur = src.providerConfig[id];
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
      const one = {};
      if (typeof cur.engine === 'string' && isValidEngine(cur.engine)) one.engine = cur.engine;
      if (typeof cur.baseUrl === 'string' && URL_RE.test(cur.baseUrl)) one.baseUrl = cur.baseUrl;
      if (typeof cur.apiKey === 'string') one.apiKey = cur.apiKey;
      if (typeof cur.model === 'string' && cur.model.length <= 100) one.model = cur.model;
      if (Object.keys(one).length) conf[id] = one;
    });
    if (Object.keys(conf).length) out.providerConfig = conf;
  }

  // 自定义服务商列表（名称 + id）
  if (Array.isArray(src.customProviders)) {
    const list = [];
    src.customProviders.forEach((p) => {
      if (!p || typeof p !== 'object') return;
      if (typeof p.id !== 'string' || !CUSTOM_ID_RE.test(p.id)) {
        rejected.push('customProviders');
        return;
      }
      list.push({ id: p.id, name: typeof p.name === 'string' ? p.name.slice(0, 40) : '自定义' });
    });
    if (list.length) out.customProviders = list;
  }

  // 兼容 v4 的导入文件（engine + engineConfig）以及更早的扁平结构
  if (src.engineConfig && typeof src.engineConfig === 'object') {
    const migrated = migrateConfig({ _v: 4, engine: src.engine, engineConfig: src.engineConfig });
    out.providerConfig = { ...(out.providerConfig || {}), ...migrated.providerConfig };
    if (!out.currentProvider) out.currentProvider = migrated.currentProvider;
  }
  if (src.baseUrl && typeof src.baseUrl === 'string') {
    const migrated = migrateConfig({ _v: 3, baseUrl: src.baseUrl, apiKey: src.apiKey, model: src.model });
    out.providerConfig = { ...(out.providerConfig || {}), ...migrated.providerConfig };
    if (!out.currentProvider) out.currentProvider = migrated.currentProvider;
  }

  // 导入的自定义槽位都要进列表：列表决定槽位留不留（见 mergeConfig），老格式迁移出来的 __custom__ 也一样
  const customIds = Object.keys(out.providerConfig || {}).filter((id) => CUSTOM_ID_RE.test(id));
  const listFromFile = !!out.customProviders;
  if (customIds.length) {
    const list = (out.customProviders || []).slice();
    customIds.forEach((id) => {
      if (!list.some((p) => p.id === id)) list.push({ id, name: '自定义 ' + (list.length + 1) });
    });
    out.customProviders = list;
  }

  // 自定义目标语言：逐条严格校验；坏条目只忽略该条，不把无效代码写进配置。
  if (src.customLanguages !== undefined) {
    if (!Array.isArray(src.customLanguages)) {
      rejected.push('customLanguages');
    } else {
      const list = [];
      src.customLanguages.forEach((row) => {
        const id = row && typeof row === 'object' ? String(row.id || '') : '';
        if (list.length >= CUSTOM_LANGUAGE_MAX || list.some((one) => one.id === id) || customLanguageError(row, list, { ignoreId: id })) {
          if (rejected.indexOf('customLanguages') < 0) rejected.push('customLanguages');
          return;
        }
        const normalized = normalizeCustomLanguages([row])[0];
        if (normalized) list.push(normalized);
      });
      if (list.length) out.customLanguages = list;
    }
  }

  // 目标语言可以引用内置语言，也可以引用文件里 / 本机已有的自定义语言。
  // 本机列表由调用方传入（导入时语言按 id 合并），避免把文件里没带的本机语言误判成无效。
  const currentLanguages = normalizeCustomLanguages(opts && opts.currentLanguages);
  const allowedLanguages = new Set(
    LANGUAGES.map((one) => one.value).concat(
      (out.customLanguages || []).map((one) => one.id),
      currentLanguages.map((one) => one.id)
    )
  );
  if (src.targetLang !== undefined && src.targetLang !== null) {
    if (typeof src.targetLang === 'string' && allowedLanguages.has(src.targetLang)) out.targetLang = src.targetLang;
    else rejected.push('targetLang');
  }
  if (src.inputTargetLang !== undefined && src.inputTargetLang !== null) {
    if (src.inputTargetLang === 'auto' || (typeof src.inputTargetLang === 'string' && allowedLanguages.has(src.inputTargetLang))) {
      out.inputTargetLang = src.inputTargetLang;
    } else {
      rejected.push('inputTargetLang');
    }
  }

  // 数组项：清洗后有内容才导入，坏的计入 rejected
  // 术语表：导出文件里有，以前导入时漏掉了（换电脑后术语对照悄悄没了）
  if (src.glossary !== undefined) {
    if (!Array.isArray(src.glossary)) rejected.push('glossary');
    else {
      assertGlossaryNotes(src.glossary);
      const glossary = normalizeGlossary(src.glossary);
      if (glossary.length) out.glossary = glossary;
    }
  }
  if (src.siteRules !== undefined) {
    const result = normalizeSiteRules(src.siteRules);
    if (result.errors.length) rejected.push('siteRules');
    if (result.rules.length) out.siteRules = result.rules;
  }
  if (src.nightSites !== undefined) out.nightSites = normalizeHosts(src.nightSites);

  // 上面自动补出来的列表不算文件里认出的配置项
  const count = Object.keys(out).length + (out.providerConfig ? 1 : 0) - (out.customProviders && !listFromFile ? 1 : 0);
  // 第二道防线：真正的配置文件至少有十几项，命中过少说明不是我们的文件
  if (count < 3) {
    throw new Error('只认出 ' + count + ' 项配置，可能不是凛狐的配置文件');
  }
  const glossaryNoteUpdates = glossaryNoteUpdateSources(src.glossary);
  return { config: out, rejected, glossaryNoteUpdates };
}

// 导入时的自定义服务商列表：在现有列表上补进文件里的（同 id 用文件里的名字）。
// 直接用文件里的列表替换的话，本机已有、文件里没有的自定义服务商会被 mergeConfig 连同 Key 删掉
export function mergeCustomProviderLists(current, incoming) {
  const out = (Array.isArray(current) ? current : []).map((p) => ({ id: p.id, name: p.name }));
  (Array.isArray(incoming) ? incoming : []).forEach((p) => {
    const hit = out.find((one) => one.id === p.id);
    if (hit) hit.name = p.name;
    else out.push({ id: p.id, name: p.name });
  });
  return out;
}

// 本地时间 + 时区偏移（导出文件名和 exportedAt 用当地时间，避免 UTC 让人误判）
export function localIso(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) +
    ':' + pad(abs % 60)
  );
}
