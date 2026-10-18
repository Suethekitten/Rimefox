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

export function langLabel(code) {
  const hit = LANGUAGES.find((x) => x.value === code);
  return hit ? hit.label : code;
}

// 配置版本：升级时要对性能相关字段做一次纠偏。
// 因为「测试连接」会把整张表单落盘，用户存储里会固化旧默认值，
// 只改 DEFAULTS 对老用户不生效。
// 3：并发默认 4 → 6（内容脚本以前写死 3 路，设置项不生效）
export const CONFIG_VERSION = 3;

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
