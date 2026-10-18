// 配置读写：所有页面（service worker / options / popup）共用
// 结构（v5 起）：接口配置按"服务商"分别保存（DeepSeek / 硅基流动 / 自定义…各一份），
// 同一协议下的不同服务商不会互相覆盖 Key。行为项保持扁平。
import { PROVIDERS, CUSTOM_PROVIDER_ID, findProviderByBaseUrl, providerById } from './providers.js';
import { normalizeGlossary } from './glossary.js';

export const ENGINE_IDS = ['openai', 'anthropic', 'gemini'];

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

  // 术语表：[{ source, target }]，全局一份（不按服务商分）
  glossary: [],

  temperature: 0.2,
  timeoutMs: 60000,
  // 思考模式：auto（什么都不发）/ off（按服务商发关闭参数）/ custom（原样合并自定义 JSON）
  // 默认尽量关闭思考：翻译不需要推理，开着既慢又可能把 token 预算用光、content 为空（DeepSeek 新模型默认开思考）
  thinkingMode: 'off',
  thinkingExtra: '',
  // 全局附加提示词：追加在 system prompt 末尾；留空不加
  customPrompt: '',

  // —— 翻译行为 ——
  targetLang: 'zh-CN',
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
  debug: false,
  // 页面级快捷键（我自己解析，可在设置里改；浏览器 commands 的那条写死在 manifest 里）
  hotkey: 'alt+a',

  // —— 显示 ——
  mode: 'dual', // dual | translation
  theme: 'underline', // none | underline | dashed | highlight | mask
  chromeBilingual: false,
  // 设置页 / 弹窗的界面主题：auto 跟随系统，light / dark 固定
  uiTheme: 'auto',
  // 界面语言：zh 中文 / en English（只影响设置页和弹窗）
  uiLang: 'zh'
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
    label: '猫娘',
    temperature: 0.8,
    prompt:
      '把译文写成猫娘的口吻，像轻小说里的猫娘角色，而不是每句句尾加「喵」：' +
      '中文自称「本喵」或「人家」，偶尔用「我」；语气词在「喵、喵呜、呀、嘛、啦、欸嘿、哼、呜…」里混用，每段「喵」最多 1–2 次，不要每句都加；' +
      '语气活泼、会撒娇，偶尔傲娇（「才不是…呢」「哼，本喵才没有」），句子短、口语化；' +
      '目标语言不是中文时用当地猫娘的对应说法（英文 nya / meow、日语 にゃ、韩语 냥），同样不要每句都用。' +
      '只改语气和措辞：信息、数字、专名、代码、URL 不增不减；不要加原文没有的事实、解释或括号吐槽；不要色情低俗。'
  }
];

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

export function langLabel(code) {
  const hit = LANGUAGES.find((x) => x.value === code);
  return hit ? hit.label : code;
}

// 配置版本：
// 3：并发默认 4 → 6
// 4：接口配置改为按协议分开保存（engine + engineConfig）
// 5：改为按服务商分开保存（currentProvider + providerConfig）
// 6：自定义服务商支持命名与多个（customProviders 列表）
export const CONFIG_VERSION = 6;

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

  next._v = CONFIG_VERSION;
  return next;
}

// 深合并：providerConfig 按服务商逐个合并，避免整体覆盖
export function mergeConfig(base, patch) {
  const b = base || {};
  const p = patch || {};
  const out = { ...b, ...p };

  const slots = { ...(b.providerConfig || {}) };
  Object.keys(p.providerConfig || {}).forEach((id) => {
    slots[id] = { ...(slots[id] || {}), ...(p.providerConfig[id] || {}) };
  });
  out.providerConfig = slots;
  // 术语表统一清洗（去空 / 去重 / 限条数），不管来自旧配置还是设置页
  out.glossary = normalizeGlossary(p.glossary !== undefined ? p.glossary : b.glossary);
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

export async function saveConfig(patch) {
  const current = await getConfig();
  const next = mergeConfig(current, patch || {});
  next._v = CONFIG_VERSION;
  await chrome.storage.local.set({ config: next });
  return next;
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
  concurrency: [1, 16]
};

const ENUM_VALUES = {
  targetLang: LANGUAGES.map((x) => x.value),
  theme: THEMES.map((x) => x.value),
  mode: ['dual', 'translation'],
  thinkingMode: ['auto', 'off', 'custom'],
  uiTheme: ['auto', 'light', 'dark'],
  uiLang: ['zh', 'en']
};

// 与内容脚本 matchesHotkey 的格式保持一致："alt+a" / "alt+shift+a" / "ctrl+shift+t"
const HOTKEY_RE = /^(alt|ctrl)(\+shift)?\+[a-z0-9]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

function isValidValue(key, value) {
  if (ENUM_VALUES[key]) return ENUM_VALUES[key].indexOf(value) >= 0;
  if (key === 'hotkey') return HOTKEY_RE.test(value);
  if (key === 'baseUrl') return URL_RE.test(value);
  if (key === 'model') return value.length > 0 && value.length <= 100;
  if (key === 'thinkingExtra') return value.length <= 2000;
  if (key === 'customPrompt') return value.length <= 2000;
  return true;
}

// 解析导入文件。返回 { config, rejected }：
//   config   —— 只含已知字段、类型与取值都合法的项
//   rejected —— 值不合法的字段名（用于提示，不会写进配置）
export function pickImportedConfig(raw) {
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

  const count = Object.keys(out).length + (out.providerConfig ? 1 : 0);
  // 第二道防线：真正的配置文件至少有十几项，命中过少说明不是我们的文件
  if (count < 3) {
    throw new Error('只认出 ' + count + ' 项配置，可能不是凛狐的配置文件');
  }
  return { config: out, rejected };
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
