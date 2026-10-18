// 配置读写：所有页面（service worker / options / popup）共用
export const DEFAULTS = {
  // —— 接口（仅 OpenAI 兼容） ——
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  timeoutMs: 60000,

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
  // 划词翻译：选中文字后在选区下方弹气泡
  selectionTranslate: true,
  debug: false,
  // 页面级快捷键（我自己解析，可在设置里改；浏览器 commands 的那条写死在 manifest 里）
  hotkey: 'alt+a',

  // —— 显示 ——
  mode: 'dual', // dual | translation
  theme: 'underline', // none | underline | dashed | highlight | mask
  // 界面元素（导航/按钮/标签）是否也保留原文。
  // false = 界面单语（推荐，布局最稳）；true = 界面也中英对照（可能溢出）
  chromeBilingual: false
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

export const HOTKEYS = [
  { value: 'alt+a', label: 'Alt + A' },
  { value: 'alt+b', label: 'Alt + B' },
  { value: 'alt+q', label: 'Alt + Q' },
  { value: 'alt+shift+a', label: 'Alt + Shift + A' },
  { value: 'ctrl+shift+a', label: 'Ctrl + Shift + A' },
  { value: 'ctrl+shift+t', label: 'Ctrl + Shift + T' }
];

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

// 配置版本：升级时要对性能相关字段做一次纠偏。
// 因为「测试连接」会把整张表单落盘，用户存储里会固化旧默认值，
// 只改 DEFAULTS 对老用户不生效。
// 3：并发默认 4 → 6（内容脚本以前写死 3 路，设置项不生效）
export const CONFIG_VERSION = 3;

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
  mode: ['dual', 'translation']
};

// 与内容脚本 matchesHotkey 的格式保持一致："alt+a" / "alt+shift+a" / "ctrl+shift+t"
const HOTKEY_RE = /^(alt|ctrl)(\+shift)?\+[a-z0-9]+$/;

function isValidValue(key, value) {
  if (ENUM_VALUES[key]) return ENUM_VALUES[key].indexOf(value) >= 0;
  if (key === 'hotkey') return HOTKEY_RE.test(value);
  if (key === 'baseUrl') return /^https?:\/\/\S+$/i.test(value);
  if (key === 'model') return value.length > 0 && value.length <= 100;
  return true;
}

// 解析导入文件。返回 { config, rejected }：
//   config   —— 只含已知字段、类型与取值都合法的项
//   rejected —— 值不合法的字段名（用于提示，不会写进配置）
// 调用方拿到的 config 直接交给 saveConfig 合并即可。
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

  const count = Object.keys(out).length;
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

export async function getConfig() {
  try {
    const got = await chrome.storage.local.get('config');
    const stored = (got && got.config) || {};
    const merged = { ...DEFAULTS, ...stored };

    if ((stored._v || 1) < CONFIG_VERSION) {
      merged.batchSize = DEFAULTS.batchSize;
      merged.maxCharsPerBatch = DEFAULTS.maxCharsPerBatch;
      merged.concurrency = DEFAULTS.concurrency;
      merged._v = CONFIG_VERSION;
      try {
        await chrome.storage.local.set({ config: merged });
      } catch (err) {
        /* 迁移失败不阻塞使用 */
      }
    }
    return merged;
  } catch (err) {
    return { ...DEFAULTS, _v: CONFIG_VERSION };
  }
}

export async function saveConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...(patch || {}), _v: CONFIG_VERSION };
  await chrome.storage.local.set({ config: next });
  return next;
}
