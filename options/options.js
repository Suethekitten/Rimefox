import {
  DEFAULTS,
  getConfig,
  saveConfig,
  LANGUAGES,
  THEMES,
  IS_MAC,
  hotkeyLabel,
  browserShortcut,
  openShortcutsPage,
  IMPORT_APP,
  IMPORT_SCHEMA,
  pickImportedConfig,
  localIso,
  activeConfig,
  slotFor,
  mergeConfig
} from '../lib/config.js';
import { listModels, engineList } from '../lib/provider.js';
import { providerById } from '../lib/providers.js';
import { $, fillSelect, setResult } from './ui.js';
import { createModelPicker } from './model-picker.js';
import {
  NEW_CUSTOM_ID,
  SEP_ID,
  isCustomProvider,
  fillProviderSelect,
  updateProviderNameUI,
  createCustomProvider,
  updateKeyLink,
  stashCurrentProvider,
  providerSlot
} from './provider-list.js';
import { createGlossaryEditor } from './glossary.js';

// 思考模式的三种取值（与 lib/config.js 的 DEFAULTS.thinkingMode 对应）
const THINKING_MODES = [
  { value: 'auto', label: '自动（不发额外参数）' },
  { value: 'off', label: '尽量关闭' },
  { value: 'custom', label: '自定义参数' }
];

// 当前正在编辑的服务商（每个服务商各自保存地址 / Key / 模型）
let currentProvider = 'deepseek';

const fields = {
  engine: $('engine'),
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
  thinkingMode: $('thinkingMode'),
  thinkingExtra: $('thinkingExtra'),
  targetLang: $('targetLang'),
  theme: $('theme'),
  batchSize: $('batchSize'),
  maxCharsPerBatch: $('maxCharsPerBatch'),
  maxUnitChars: $('maxUnitChars'),
  concurrency: $('concurrency'),
  skipSameLang: $('skipSameLang'),
  translateOnLoad: $('translateOnLoad'),
  lazy: $('lazy'),
  selectionTranslate: $('selectionTranslate'),
  selectionMenu: $('selectionMenu'),
  selectionButton: $('selectionButton'),
  selectionImmediate: $('selectionImmediate'),
  subtitleTranslate: $('subtitleTranslate'),
  hoverCompare: $('hoverCompare'),
  chromeBilingual: $('chromeBilingual'),
  debug: $('debug')
};

// 最近一次读到的配置（导出时用）
let currentCfg = {};

// 术语表编辑器：直接改 currentCfg.glossary，保存时统一清洗
const glossaryEditor = createGlossaryEditor({
  getConfig: () => currentCfg,
  onChanged: () => scheduleDirty()
});

// ---------------- 快捷键录制 ----------------
const hotkeyBtn = $('hotkeyBtn');
const hotkeyHint = $('hotkeyHint');

let hotkeyValue = DEFAULTS.hotkey;
let recordingHotkey = false;

const KEY_NAMES = {
  ' ': 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  enter: 'enter',
  tab: 'tab'
};

// 必须带的修饰键：Mac 上叫 Option / Control
const MODIFIERS_HINT = IS_MAC ? 'Option 或 Control' : 'Alt 或 Ctrl';
const prettyHotkey = hotkeyLabel;

function renderHotkey() {
  hotkeyBtn.textContent = recordingHotkey ? '按下组合键…' : prettyHotkey(hotkeyValue);
  hotkeyBtn.classList.toggle('recording', recordingHotkey);
}

function setHotkeyValue(spec) {
  hotkeyValue = spec || DEFAULTS.hotkey;
  renderHotkey();
}

hotkeyBtn.addEventListener('click', () => {
  recordingHotkey = true;
  renderHotkey();
  hotkeyHint.textContent = '现在按下组合键（必须包含 ' + MODIFIERS_HINT + '，Esc 取消）';
});

document.addEventListener(
  'keydown',
  (event) => {
    if (!recordingHotkey) return;
    event.preventDefault();
    event.stopPropagation();

    const key = String(event.key || '').toLowerCase();
    if (key === 'escape') {
      recordingHotkey = false;
      renderHotkey();
      hotkeyHint.textContent = '已取消，快捷键没变。';
      return;
    }
    // 还在按修饰键，等真正的按键
    if (key === 'alt' || key === 'control' || key === 'shift' || key === 'meta') return;

    const parts = [];
    if (event.altKey) parts.push('alt');
    if (event.ctrlKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (!parts.length) {
      hotkeyHint.textContent = '必须包含 ' + MODIFIERS_HINT + '，否则会和页面本身的按键冲突。再试一次。';
      return;
    }

    let k = KEY_NAMES[key] || key;
    // macOS 上 Option+A 按出来的是 "å"（Option+E 是 "Dead"），非拉丁布局是 "ф" 这类：
    // 录成物理键位上的字母，和内容脚本的匹配规则一致。其它命名键（pageup、f5 等）原样保留
    const codeMatch = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code || '');
    if (!/^[a-z0-9]$/.test(k) && codeMatch) {
      k = (codeMatch[1] || codeMatch[2]).toLowerCase();
    }
    parts.push(k);

    hotkeyValue = parts.join('+');
    recordingHotkey = false;
    renderHotkey();
    hotkeyHint.textContent = '已录制：' + prettyHotkey(hotkeyValue) + '（别忘了点下面的「保存」）';
  },
  true
);

// 不同协议下地址 / Key / 模型名的说明不一样
const ENGINE_HINTS = {
  openai: {
    baseUrl: 'OpenAI 兼容的 base URL，通常以 /v1 结尾。程序会自动补 /chat/completions。',
    key: 'DeepSeek / 智谱 / 硅基流动 / 通义 等都可以，填对应平台的 Key。',
    model: 'deepseek-chat'
  },
  anthropic: {
    baseUrl: 'Anthropic 的地址，通常填 https://api.anthropic.com/v1（程序会自动补 /messages）。',
    key: '在 console.anthropic.com 申请，形如 sk-ant-...',
    model: 'claude-...'
  },
  gemini: {
    baseUrl: 'Google 的地址，通常填 https://generativelanguage.googleapis.com/v1beta（模型名会拼进 URL）。',
    key: '在 aistudio.google.com 申请，形如 AIza...',
    model: 'gemini-...'
  }
};

function updateEngineHints() {
  const hint = ENGINE_HINTS[fields.engine.value] || ENGINE_HINTS.openai;
  $('baseUrlHint').textContent = hint.baseUrl;
  $('apiKeyHint').textContent = hint.key;
  fields.model.placeholder = hint.model;
}

function updateThinkingUI() {
  $('thinkingExtraField').hidden = fields.thinkingMode.value !== 'custom';
}

function applyConfig(cfg) {
  refreshProviderList();

  const slot = slotFor(cfg, cfg.currentProvider);
  currentProvider = slot.provider;
  providerSelect.value = slot.provider;
  fields.engine.value = slot.engine;
  fields.baseUrl.value = slot.baseUrl || '';
  fields.apiKey.value = slot.apiKey || '';
  fields.model.value = slot.model || '';
  fields.thinkingMode.value = cfg.thinkingMode || DEFAULTS.thinkingMode;
  fields.thinkingExtra.value = cfg.thinkingExtra || '';

  fields.targetLang.value = cfg.targetLang || 'zh-CN';
  fields.theme.value = cfg.theme || 'underline';
  fields.batchSize.value = cfg.batchSize;
  fields.maxCharsPerBatch.value = cfg.maxCharsPerBatch;
  fields.maxUnitChars.value = cfg.maxUnitChars;
  fields.concurrency.value = cfg.concurrency;
  setHotkeyValue(cfg.hotkey);
  fields.skipSameLang.checked = cfg.skipSameLang !== false;
  fields.translateOnLoad.checked = !!cfg.translateOnLoad;
  fields.lazy.checked = cfg.lazy !== false;
  fields.selectionTranslate.checked = cfg.selectionTranslate !== false;
  fields.selectionMenu.checked = cfg.selectionMenu !== false;
  fields.selectionButton.checked = cfg.selectionButton !== false;
  fields.selectionImmediate.checked = cfg.selectionImmediate === true;
  fields.subtitleTranslate.checked = cfg.subtitleTranslate === true;
  fields.hoverCompare.checked = cfg.hoverCompare !== false;
  fields.chromeBilingual.checked = !!cfg.chromeBilingual;
  fields.debug.checked = !!cfg.debug;

  updateEngineHints();
  updateThinkingUI();
  updateKeyLink(keyLink, providerById(slot.provider));
  syncProviderNameUI();
  picker.updateHint();
  glossaryEditor.render();
}

function readForm() {
  // 先把手上的编辑存回内存，避免切过服务商后未保存的内容被丢掉
  stash();

  const providerConfig = {};
  Object.keys((currentCfg && currentCfg.providerConfig) || {}).forEach((id) => {
    const one = currentCfg.providerConfig[id] || {};
    providerConfig[id] = {
      engine: one.engine || 'openai',
      baseUrl: one.baseUrl || '',
      apiKey: one.apiKey || '',
      model: one.model || ''
    };
  });

  return {
    currentProvider,
    providerConfig,
    customProviders: ((currentCfg && currentCfg.customProviders) || []).map((p) => ({
      id: p.id,
      name: p.name || '自定义'
    })),
    glossary: ((currentCfg && currentCfg.glossary) || []).slice(),
    thinkingMode: fields.thinkingMode.value,
    thinkingExtra: fields.thinkingExtra.value.trim(),

    targetLang: fields.targetLang.value,
    theme: fields.theme.value,
    batchSize: Number(fields.batchSize.value) || DEFAULTS.batchSize,
    maxCharsPerBatch: Number(fields.maxCharsPerBatch.value) || DEFAULTS.maxCharsPerBatch,
    maxUnitChars: Number(fields.maxUnitChars.value) || DEFAULTS.maxUnitChars,
    concurrency: Number(fields.concurrency.value) || DEFAULTS.concurrency,
    hotkey: hotkeyValue || DEFAULTS.hotkey,
    skipSameLang: fields.skipSameLang.checked,
    translateOnLoad: fields.translateOnLoad.checked,
    lazy: fields.lazy.checked,
    selectionTranslate: fields.selectionTranslate.checked,
    selectionMenu: fields.selectionMenu.checked,
    selectionButton: fields.selectionButton.checked,
    selectionImmediate: fields.selectionImmediate.checked,
    subtitleTranslate: fields.subtitleTranslate.checked,
    hoverCompare: fields.hoverCompare.checked,
    chromeBilingual: fields.chromeBilingual.checked,
    debug: fields.debug.checked
  };
}

// ---------------- 浏览器快捷键 ----------------
// manifest 里的 Alt+A 只是"建议"：被别的扩展占用时浏览器不会分配给我们，按了没反应，
// 而且按键在浏览器层就被那个扩展拿走了，页面内快捷键也收不到。这里显示浏览器实际分配的结果。
async function renderBrowserShortcut() {
  const node = $('browserShortcut');
  const shortcut = await browserShortcut();
  if (shortcut === null) {
    setResult(node, '浏览器快捷键：读取失败', '');
  } else if (shortcut) {
    setResult(node, '浏览器快捷键：' + shortcut, 'ok');
  } else {
    setResult(
      node,
      '浏览器快捷键：未设置。' + hotkeyLabel('alt+a') + ' 可能已被其它扩展占用，点右边按钮给「翻译 / 还原当前页面」设一个键。',
      'bad'
    );
  }
}

$('openShortcuts').addEventListener('click', openShortcutsPage);
// 从快捷键设置页切回来时刷新
window.addEventListener('focus', renderBrowserShortcut);

// ---------------- 模型列表 ----------------
// 只留能对话的：嵌入、重排、语音、画图这类模型不能拿来翻译
const NON_CHAT = /embed|rerank|whisper|tts|speech|audio|dall-?e|moderation|bge-|stable-diffusion|flux|kolors|cogview|cogvideo|video|image|realtime|transcribe/i;
// 带"思考"过程的模型：能用，但整页翻译会慢很多倍
const REASONING = /reason|thinking|qwq|(^|[-/])[rz]1([-.]|$)|(^|[-/])o[134](-|$)/i;

const modelHint = $('modelHint');
const providerSelect = $('provider');
const keyLink = $('keyLink');

// 可搜索的模型选择器（渲染 / 过滤 / 键盘 / 开合在 options/model-picker.js）
const picker = createModelPicker({
  input: fields.model,
  toggle: $('modelToggle'),
  panel: $('modelPicker'),
  search: $('modelSearch'),
  list: $('modelList'),
  hint: modelHint,
  isSlow: (id) => REASONING.test(id)
});

let modelSeq = 0;
let modelTimer = 0;

function scheduleModelFetch() {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(fetchModels, 800);
}

async function fetchModels(manual) {
  const baseUrl = fields.baseUrl.value.trim();
  const apiKey = fields.apiKey.value.trim();
  if (!baseUrl || !apiKey) {
    if (manual === true) setResult(modelHint, '先填好 API 地址和 Key。', 'bad');
    return;
  }
  const seq = ++modelSeq;
  setResult(modelHint, '正在获取模型列表…');
  try {
    const ids = (await listModels({ engine: fields.engine.value, baseUrl, apiKey })).filter((id) => !NON_CHAT.test(id)).sort();
    if (seq !== modelSeq) return; // 期间地址或 Key 又改了，以最新一次为准
    picker.setItems(ids);
  } catch (err) {
    if (seq !== modelSeq) return;
    picker.setItems([]);
    // "接口不提供模型列表"本身已经说了要手填，别再重复一遍
    const text = /手填/.test(err.message)
      ? err.message + '。'
      : '获取模型列表失败：' + err.message + '。可以直接手填模型名。';
    setResult(modelHint, text, 'bad');
  }
}

// ---------------- 提供商模板 ----------------
// 列表 / 名称 / 槽位等纯操作在 options/provider-list.js
const providerNameEls = { nameField: $('providerNameField'), nameInput: $('providerName') };

function formOf() {
  return {
    engine: fields.engine.value,
    baseUrl: fields.baseUrl.value,
    apiKey: fields.apiKey.value,
    model: fields.model.value
  };
}

function stash() {
  stashCurrentProvider(currentCfg, currentProvider, formOf());
}

function refreshProviderList() {
  fillProviderSelect(providerSelect, currentCfg);
}

function syncProviderNameUI() {
  updateProviderNameUI(providerNameEls, currentCfg, currentProvider);
}

// 载入某个服务商自己的地址 / Key / 模型（没保存过就用模板默认值）
function loadProvider(id) {
  const slot = providerSlot(currentCfg, id);
  currentProvider = slot.provider;
  providerSelect.value = slot.provider;
  fields.engine.value = slot.engine;
  fields.baseUrl.value = slot.baseUrl || '';
  fields.apiKey.value = slot.apiKey || '';
  fields.model.value = slot.model || '';
  picker.setItems([]);
  picker.close();
  updateEngineHints();
  updateKeyLink(keyLink, providerById(slot.provider));
  picker.updateHint();
}

// 切换服务商：各用各的地址 / Key / 模型
providerSelect.addEventListener('change', () => {
  const id = providerSelect.value;
  if (!id || id === SEP_ID) return;

  stash(); // 先把上一个服务商的编辑存住

  if (id === NEW_CUSTOM_ID) {
    const newId = createCustomProvider(currentCfg);
    refreshProviderList();
    loadProvider(newId);
    syncProviderNameUI();
    setResult(modelHint, '新的自定义服务商：填地址和 Key，测试通过后改个名字点「保存」。');
    return;
  }

  loadProvider(id);
  syncProviderNameUI();
  setResult($('testResult'), '');

  if (isCustomProvider(id)) {
    setResult(
      modelHint,
      '自定义服务商：地址、Key、模型都会单独记住；默认按 OpenAI 通用协议，需要时可改「接口协议」。'
    );
    return;
  }

  const provider = providerById(id);
  if (!provider) return;
  // 模型名也按服务商记忆：loadProvider 已经恢复了上次填的，这里不要再清空
  setResult(
    modelHint,
    fields.model.value
      ? '已切回「' + provider.name + '」，模型沿用上次保存的「' + fields.model.value + '」。'
      : '已套用「' + provider.name + '」的地址，模型请点「获取模型列表」后选一个。'
  );
  if (fields.apiKey.value) fetchModels();
});

// 自定义服务商改名：同步下拉里的文字（保存后持久化）
$('providerName').addEventListener('input', () => {
  const list = (currentCfg && currentCfg.customProviders) || [];
  const entry = list.find((p) => p.id === currentProvider);
  if (!entry) return;
  entry.name = $('providerName').value.trim() || '自定义';
  const opt = Array.from(providerSelect.options).find((o) => o.value === currentProvider);
  if (opt) opt.textContent = entry.name;
});

// 删除当前自定义服务商
$('deleteProvider').addEventListener('click', (event) => {
  event.preventDefault();
  if (!isCustomProvider(currentProvider)) return;

  currentCfg.customProviders = ((currentCfg && currentCfg.customProviders) || []).filter(
    (p) => p.id !== currentProvider
  );
  if (currentCfg.providerConfig) delete currentCfg.providerConfig[currentProvider];

  refreshProviderList();
  loadProvider('deepseek');
  syncProviderNameUI();
  setResult(modelHint, '已删除该自定义服务商（点底部「保存」后生效）。');
});

// 改协议：只改当前服务商使用的协议，地址 / Key / 模型保留
fields.engine.addEventListener('change', () => {
  const target = fields.engine.value;
  if (!target) return;
  stash();
  setResult($('testResult'), '');
  const label = (engineList().find((e) => e.id === target) || {}).label || target;
  setResult(modelHint, '协议已切换为「' + label + '」，地址和模型请确认后保存。');
  updateEngineHints();
  if (fields.baseUrl.value && fields.apiKey.value) fetchModels();
});

fields.thinkingMode.addEventListener('change', updateThinkingUI);
fields.baseUrl.addEventListener('input', scheduleModelFetch);
fields.apiKey.addEventListener('input', scheduleModelFetch);
$('refreshModels').addEventListener('click', () => fetchModels(true));

// ---------------- 未保存的更改（底部保存栏） ----------------
// 以"上次保存时的表单"为基准，和当前表单逐项比较：改回原值就不算改动
let savedCfg = null; // 上次保存的完整配置（放弃更改时恢复用）
let savedForm = null; // 上次保存时 readForm() 的结果
const savebar = $('savebar');

function clone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

// 有几处不同：普通项一项算一处，服务商配置按「服务商 × 字段」算
function countChanges(a, b) {
  let n = 0;
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  keys.forEach((key) => {
    if (key === 'providerConfig') {
      const pa = a.providerConfig || {};
      const pb = b.providerConfig || {};
      new Set(Object.keys(pa).concat(Object.keys(pb))).forEach((id) => {
        const sa = pa[id] || {};
        const sb = pb[id] || {};
        ['engine', 'baseUrl', 'apiKey', 'model'].forEach((f) => {
          if ((sa[f] || '') !== (sb[f] || '')) n += 1;
        });
      });
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      n += 1;
    }
  });
  return n;
}

function updateDirty() {
  if (!savedForm) return;
  const n = countChanges(savedForm, readForm());
  const dirty = n > 0;
  savebar.dataset.dirty = String(dirty);
  $('saveState').textContent = dirty ? '有 ' + n + ' 处未保存的更改' : '所有更改已保存';
  $('save').disabled = !dirty;
  $('discard').disabled = !dirty;
  if (dirty) setResult($('saveResult'), '');
}

function markSaved(cfg) {
  savedCfg = clone(cfg);
  savedForm = readForm();
  updateDirty();
}

// 表单的任何交互之后重新比较一次（下拉、开关、输入、快捷键录制、删除服务商、选模型都覆盖到）
// 合并同一轮里的多个事件（一次点击会连发 click / input / change），等事件处理完再比较
let dirtyTimer = 0;
function scheduleDirty() {
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(() => {
    dirtyTimer = 0;
    updateDirty();
  }, 0);
}
['input', 'change', 'click', 'keyup'].forEach((type) => document.addEventListener(type, scheduleDirty, true));

$('discard').addEventListener('click', () => {
  if (!savedCfg) return;
  currentCfg = clone(savedCfg);
  applyConfig(currentCfg);
  updateDirty();
  setResult($('saveResult'), '已放弃未保存的更改');
});

// Ctrl/⌘ + S 保存
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && String(event.key).toLowerCase() === 's') {
    event.preventDefault();
    if (!$('save').disabled) $('save').click();
  }
});

// 有未保存的更改时关闭 / 刷新页面先提醒
window.addEventListener('beforeunload', (event) => {
  if (savebar.dataset.dirty === 'true') {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ---------------- 左侧导航：滚动时高亮当前分组 ----------------
function bindNav() {
  const links = Array.from(document.querySelectorAll('.nav-item'));
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const visible = new Map();
  function highlight(id) {
    links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === '#' + id));
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => visible.set(e.target.id, e.isIntersecting));
      // 最上面那个还在视口里的分组算当前分组
      const first = sections.find((sec) => visible.get(sec.id));
      if (first) highlight(first.id);
    },
    { rootMargin: '-10% 0px -55% 0px' }
  );
  sections.forEach((sec) => io.observe(sec));
  links.forEach((a) => a.addEventListener('click', () => highlight(a.getAttribute('href').slice(1))));
  if (sections[0]) highlight(sections[0].id);
}

async function init() {
  try {
    $('appVersion').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (err) {
    /* 不在扩展环境 */
  }
  ['testResult', 'cfgResult'].forEach((id) => {
    $(id).dataset.default = $(id).textContent;
  });
  bindNav();
  refreshProviderList();
  fillSelect(fields.engine, engineList().map((e) => ({ value: e.id, label: e.label })));
  fillSelect(fields.thinkingMode, THINKING_MODES);
  fillSelect(fields.targetLang, LANGUAGES);
  fillSelect(fields.theme, THEMES);
  renderHotkey();
  const cfg = await getConfig();
  currentCfg = cfg;
  applyConfig(cfg);
  markSaved(cfg);
  renderBrowserShortcut();
  renderCacheStats();
  fetchModels(); // 已经保存过地址和 Key 时，打开设置页就把列表准备好
}

$('save').addEventListener('click', async () => {
  const patch = readForm();
  const active = activeConfig(patch);
  currentCfg = await saveConfig(patch);
  markSaved(currentCfg);
  glossaryEditor.render(); // 清洗后的结果（去空行 / 去重）反映到表格
  if (active.apiKey) setResult($('saveResult'), '已保存（' + new Date().toLocaleTimeString() + '）', 'ok');
  else setResult($('saveResult'), '已保存，但还没有填 API Key，翻译会失败。', 'bad');
});

// 恢复默认：只填进表单，确认后点「保存」才生效（可以「放弃更改」反悔）。
// 只重置翻译 / 显示设置：不切走当前服务商，也不动已保存的地址 / Key / 模型和自定义服务商
$('reset').addEventListener('click', () => {
  currentCfg = mergeConfig(currentCfg, {
    ...DEFAULTS,
    currentProvider: currentCfg.currentProvider,
    customProviders: (currentCfg && currentCfg.customProviders) || []
  });
  applyConfig(currentCfg);
  updateDirty();
  setResult($('saveResult'), '已填入默认值，点「保存」后生效');
});

$('test').addEventListener('click', async () => {
  const btn = $('test');
  btn.disabled = true;
  setResult($('testResult'), '测试中…');
  try {
    currentCfg = await saveConfig(readForm()); // 先落盘，后台读的是存储里的配置
    markSaved(currentCfg);
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'test' }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(r);
      });
    });
    if (res && res.ok && res.reasoning) {
      setResult(
        $('testResult'),
        '连接正常 · ' + res.ms + 'ms，但这个模型带"思考"过程：每批都要先想一阵再输出，整页翻译会慢很多。' +
          '建议换成不带思考的模型，或在服务商那边关闭思考模式。',
        'bad'
      );
    } else if (res && res.ok) {
      setResult($('testResult'), '连接正常 · ' + res.ms + 'ms · ' + (res.sample || ''), 'ok');
    } else {
      setResult($('testResult'), '失败：' + ((res && res.error) || '未知错误'), 'bad');
    }
  } catch (err) {
    setResult($('testResult'), '失败：' + err.message, 'bad');
  }
  btn.disabled = false;
});

// ---------------- 翻译缓存 ----------------
function askBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError; // 后台没起来时别在控制台报未检查的错误
      resolve(res);
    });
  });
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function renderCacheStats() {
  const node = $('cacheStats');
  const res = await askBackground({ type: 'cache:stats' });
  if (!res || !res.ok) {
    setResult(node, '读取失败：' + ((res && res.error) || '后台没有响应'), 'bad');
    return;
  }
  const { memory, disk, hits, misses } = res.stats;
  const used = res.bytesInUse || {};
  // 有浏览器实际占用就显示实际值，没有（旧版浏览器的 session 区）就显示估算值
  const memBytes = used.session != null ? used.session : memory.bytes;
  const diskBytes = used.local != null ? used.local : disk.bytes;
  const lookups = hits + misses;
  node.textContent =
    '本次会话：' + memory.entries + ' 条 · ' + formatBytes(memBytes) +
    '（上限 ' + memory.maxEntries + ' 条 / ' + formatBytes(memory.maxBytes) + '）　' +
    '磁盘：' + disk.entries + ' 条 · ' + formatBytes(diskBytes) + '（上限 ' + formatBytes(disk.maxBytes) + '）　' +
    '命中率：' + (lookups ? Math.round((hits / lookups) * 100) + '%（' + hits + ' / ' + lookups + '）' : '—');
  node.classList.remove('ok', 'bad');
}

$('refreshCache').addEventListener('click', renderCacheStats);

$('clearCache').addEventListener('click', async () => {
  await askBackground({ type: 'cache:clear' });
  setResult($('cacheResult'), '翻译缓存已清空', 'ok');
  renderCacheStats();
});

// ---------------- 配置导出 / 导入 ----------------
// 用途：换电脑、或换扩展 ID（品牌改名、目录改名）时，把配置整份搬过去，
// 不用重新填 Key 和各项设置。
// 解析与校验在 lib/config.js 的 pickImportedConfig 里（纯函数，可被 node 直接测试）。
function buildExport(includeKey) {
  const cfg = { ...currentCfg };
  // Key 藏在每个服务商的配置里：导出时逐个处理
  cfg.providerConfig = {};
  Object.keys(currentCfg.providerConfig || {}).forEach((id) => {
    const one = { ...(currentCfg.providerConfig[id] || {}) };
    if (!includeKey) delete one.apiKey;
    cfg.providerConfig[id] = one;
  });
  return {
    app: IMPORT_APP,
    schema: IMPORT_SCHEMA,
    exportedAt: localIso(new Date()),
    extensionVersion: chrome.runtime.getManifest().version,
    config: cfg
  };
}

$('exportCfg').addEventListener('click', () => {
  try {
    const includeKey = $('exportKey').checked;
    const payload = buildExport(includeKey);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    // 文件名用本地时间：UTC 会让人误判"这是凌晨导出的"
    const stamp = localIso(new Date()).slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rimefox-config-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setResult(
      $('cfgResult'),
      includeKey
        ? '已导出（含 API Key，用完请删除这个文件）'
        : '已导出（不含 API Key，迁移后需要手动填 Key）',
      'ok'
    );
  } catch (err) {
    setResult($('cfgResult'), '导出失败：' + err.message, 'bad');
  }
});

$('importCfg').addEventListener('click', () => {
  $('importFile').value = '';
  $('importFile').click();
});

$('importFile').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error('不是合法的 JSON 文件');
    }

    const parsed = pickImportedConfig(raw);
    const patch = parsed.config;
    const next = await saveConfig(patch);
    currentCfg = next;
    applyConfig(next);
    markSaved(next);
    renderBrowserShortcut();
    if (next.baseUrl && next.apiKey) fetchModels();

    let msg = '已导入 ' + Object.keys(patch).length + ' 项设置';
    if (parsed.rejected.length) {
      msg += '；' + parsed.rejected.length + ' 项取值不合法已忽略（' + parsed.rejected.join('、') + '）';
    }
    const importedKey = Object.keys(patch.providerConfig || {}).some(
      (id) => patch.providerConfig[id] && patch.providerConfig[id].apiKey
    );
    if (!importedKey) msg += '（文件里没有 API Key，请手动填）';
    setResult($('cfgResult'), msg, parsed.rejected.length ? 'bad' : 'ok');
  } catch (err) {
    setResult($('cfgResult'), '导入失败：' + err.message, 'bad');
  }
});

init();
