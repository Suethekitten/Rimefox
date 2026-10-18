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
  ENGINE_DEFAULTS
} from '../lib/config.js';
import { listModels, engineList } from '../lib/provider.js';
import { PROVIDERS, CUSTOM_PROVIDER_ID, findProviderByBaseUrl, providerById } from '../lib/providers.js';

const $ = (id) => document.getElementById(id);

// 思考模式的三种取值（与 lib/config.js 的 DEFAULTS.thinkingMode 对应）
const THINKING_MODES = [
  { value: 'auto', label: '自动（不发额外参数）' },
  { value: 'off', label: '尽量关闭' },
  { value: 'custom', label: '自定义参数' }
];

// 当前正在编辑的协议（每个协议各自保存地址 / Key / 模型）
let currentEngine = 'openai';

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
  chromeBilingual: $('chromeBilingual'),
  debug: $('debug')
};

function fillSelect(select, items) {
  select.innerHTML = '';
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
  });
}

// 最近一次读到的配置（导出时用）
let currentCfg = {};

function setResult(node, text, kind) {
  node.textContent = text || '';
  node.className = 'result' + (kind ? ' ' + kind : '');
}

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
  const hint = ENGINE_HINTS[currentEngine] || ENGINE_HINTS.openai;
  $('baseUrlHint').textContent = hint.baseUrl;
  $('apiKeyHint').textContent = hint.key;
  fields.model.placeholder = hint.model;
}

function updateThinkingUI() {
  $('thinkingExtraField').hidden = fields.thinkingMode.value !== 'custom';
}

function applyConfig(cfg) {
  const active = activeConfig(cfg);
  currentEngine = active.engine;
  fields.engine.value = active.engine;
  fields.baseUrl.value = active.baseUrl || '';
  fields.apiKey.value = active.apiKey || '';
  fields.model.value = active.model || '';
  fields.thinkingMode.value = cfg.thinkingMode || 'auto';
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
  fields.chromeBilingual.checked = !!cfg.chromeBilingual;
  fields.debug.checked = !!cfg.debug;

  updateEngineHints();
  updateThinkingUI();
  syncProviderSelect();
  updateModelHint();
}

function readForm() {
  // 先把手上的编辑存回内存，避免切过协议后未保存的内容被丢掉
  stashCurrentEngine();

  const engineConfig = {};
  Object.keys((currentCfg && currentCfg.engineConfig) || {}).forEach((id) => {
    const one = currentCfg.engineConfig[id] || {};
    engineConfig[id] = {
      baseUrl: one.baseUrl || '',
      apiKey: one.apiKey || '',
      model: one.model || ''
    };
  });

  return {
    engine: currentEngine,
    engineConfig,
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
const picker = $('modelPicker');
const pickerSearch = $('modelSearch');
const pickerList = $('modelList');
const pickerToggle = $('modelToggle');
const providerSelect = $('provider');
const keyLink = $('keyLink');

let modelSeq = 0;
let modelTimer = 0;
let modelIds = [];
let pickerIndex = -1;

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
    const ids = (await listModels({ engine: currentEngine, baseUrl, apiKey })).filter((id) => !NON_CHAT.test(id)).sort();
    if (seq !== modelSeq) return; // 期间地址或 Key 又改了，以最新一次为准
    modelIds = ids;
    if (!picker.hidden) renderPicker();
    updateModelHint();
  } catch (err) {
    if (seq !== modelSeq) return;
    modelIds = [];
    if (!picker.hidden) renderPicker();
    // "接口不提供模型列表"本身已经说了要手填，别再重复一遍
    const text = /手填/.test(err.message)
      ? err.message + '。'
      : '获取模型列表失败：' + err.message + '。可以直接手填模型名。';
    setResult(modelHint, text, 'bad');
  }
}

function updateModelHint() {
  const current = fields.model.value.trim();
  if (!modelIds.length) {
    setResult(modelHint, '填好 API 地址和 Key 后会自动获取可用模型；也可以直接手填模型名。');
    return;
  }
  if (current && modelIds.indexOf(current) < 0) {
    setResult(
      modelHint,
      '已获取 ' + modelIds.length + ' 个模型，但「' + current + '」不在列表里，请确认拼写或点「选择」挑一个。',
      'bad'
    );
    return;
  }
  setResult(modelHint, '已获取 ' + modelIds.length + ' 个模型。点「选择」挑一个，或直接手填；别忘了保存。', 'ok');
}

// ---------------- 可搜索的模型选择器 ----------------
function pickerItems(query) {
  const q = String(query || '').trim().toLowerCase();
  const hit = q ? modelIds.filter((id) => id.toLowerCase().indexOf(q) >= 0) : modelIds;
  return hit.slice(0, 100); // 列表可能几百条，只渲染前 100
}

function renderPicker() {
  const items = pickerItems(pickerSearch.value);
  pickerList.innerHTML = '';
  pickerIndex = -1;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = modelIds.length ? '没有匹配的模型' : '还没有拉取到模型列表';
    pickerList.appendChild(empty);
    return;
  }

  const current = fields.model.value.trim();
  items.forEach((id) => {
    const row = document.createElement('div');
    row.className = 'picker-item' + (id === current ? ' is-current' : '');
    row.dataset.id = id;
    row.textContent = id;
    if (REASONING.test(id)) {
      const tag = document.createElement('span');
      tag.className = 'picker-tag';
      tag.textContent = '慢';
      row.appendChild(tag);
    }
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      chooseModel(id);
    });
    pickerList.appendChild(row);
  });
}

function openPicker() {
  if (!modelIds.length) {
    setResult(modelHint, '先点「获取模型列表」把可用模型拉下来。', 'bad');
    return;
  }
  picker.hidden = false;
  pickerToggle.setAttribute('aria-expanded', 'true');
  pickerSearch.value = '';
  renderPicker();
  pickerSearch.focus();
}

function closePicker() {
  picker.hidden = true;
  pickerToggle.setAttribute('aria-expanded', 'false');
  pickerIndex = -1;
}

function chooseModel(id) {
  fields.model.value = id;
  closePicker();
  updateModelHint();
}

function movePicker(step) {
  const rows = Array.from(pickerList.querySelectorAll('.picker-item'));
  if (!rows.length) return;
  pickerIndex = (pickerIndex + step + rows.length) % rows.length;
  rows.forEach((row, i) => row.classList.toggle('is-active', i === pickerIndex));
  rows[pickerIndex].scrollIntoView({ block: 'nearest' });
}

pickerToggle.addEventListener('click', () => {
  if (picker.hidden) openPicker();
  else closePicker();
});

pickerSearch.addEventListener('input', renderPicker);

pickerSearch.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    movePicker(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    movePicker(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const rows = Array.from(pickerList.querySelectorAll('.picker-item'));
    const hit = rows[pickerIndex] || rows[0];
    if (hit && hit.dataset.id) chooseModel(hit.dataset.id);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closePicker();
  }
});

document.addEventListener('mousedown', (event) => {
  if (picker.hidden) return;
  if (picker.contains(event.target) || pickerToggle.contains(event.target)) return;
  closePicker();
});

fields.model.addEventListener('input', updateModelHint);

// ---------------- 提供商模板 ----------------
function fillProviderSelect() {
  const items = PROVIDERS.map((p) => ({ value: p.id, label: p.name }));
  items.push({ value: CUSTOM_PROVIDER_ID, label: '使用自定义提供商' });
  fillSelect(providerSelect, items);
}

function updateKeyLink(provider) {
  if (provider && provider.keyUrl) {
    keyLink.href = provider.keyUrl;
    keyLink.hidden = false;
  } else {
    keyLink.hidden = true;
    keyLink.removeAttribute('href');
  }
}

// 根据地址反查模板，让下拉跟着当前地址走
function syncProviderSelect() {
  const hit = findProviderByBaseUrl(fields.baseUrl.value);
  providerSelect.value = hit ? hit.id : CUSTOM_PROVIDER_ID;
  updateKeyLink(hit);
}

// 把当前表单存回内存中的配置（切协议时不丢未保存的编辑）
function stashCurrentEngine() {
  if (!currentCfg) return;
  currentCfg.engineConfig = currentCfg.engineConfig || {};
  currentCfg.engineConfig[currentEngine] = {
    baseUrl: fields.baseUrl.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim()
  };
}

// 载入某个协议已保存的地址 / Key / 模型
function loadEngine(id) {
  const conf = (currentCfg && currentCfg.engineConfig && currentCfg.engineConfig[id]) || {
    baseUrl: (ENGINE_DEFAULTS[id] || {}).baseUrl || '',
    apiKey: '',
    model: ''
  };
  currentEngine = id;
  fields.engine.value = id;
  fields.baseUrl.value = conf.baseUrl || '';
  fields.apiKey.value = conf.apiKey || '';
  fields.model.value = conf.model || '';
  modelIds = [];
  closePicker();
  updateEngineHints();
  syncProviderSelect();
  updateModelHint();
}

providerSelect.addEventListener('change', () => {
  const id = providerSelect.value;
  stashCurrentEngine();

  if (id === CUSTOM_PROVIDER_ID) {
    fields.baseUrl.value = '';
    fields.model.value = '';
    modelIds = [];
    closePicker();
    updateKeyLink(null);
    setResult(modelHint, '自定义：填第三方兼容接口或自建网关的地址；没有模型列表时直接手填模型名。');
    return;
  }

  const provider = providerById(id);
  if (!provider) return;

  // 模板只负责填地址和协议；Key 用该协议自己保存的那份
  if (provider.engine !== currentEngine) loadEngine(provider.engine);
  fields.baseUrl.value = provider.baseUrl;
  fields.model.value = '';
  modelIds = [];
  closePicker();
  updateKeyLink(provider);
  setResult($('testResult'), '');
  setResult(modelHint, '已套用「' + provider.name + '」的地址，模型请点「获取模型列表」后选一个。');
  if (fields.apiKey.value) fetchModels();
});

// 切换协议：换成该协议单独保存的地址 / Key / 模型
fields.engine.addEventListener('change', () => {
  const target = fields.engine.value;
  if (!target || target === currentEngine) return;

  stashCurrentEngine();
  loadEngine(target);
  setResult($('testResult'), ''); // 上一个协议的测试结果不能留在这里

  const label = (engineList().find((e) => e.id === target) || {}).label || target;
  setResult(modelHint, '已切换到「' + label + '」，填好 Key 后会拉取该协议的模型列表。');

  if (fields.baseUrl.value && fields.apiKey.value) fetchModels();
});

fields.thinkingMode.addEventListener('change', updateThinkingUI);

// 手动改地址时，让提供商下拉跟着变（反查模板）+ 防抖拉模型
let providerSyncTimer = 0;
fields.baseUrl.addEventListener('input', () => {
  clearTimeout(providerSyncTimer);
  providerSyncTimer = setTimeout(syncProviderSelect, 300);
  scheduleModelFetch();
});
fields.apiKey.addEventListener('input', scheduleModelFetch);
$('refreshModels').addEventListener('click', () => fetchModels(true));

async function init() {
  fillProviderSelect();
  fillSelect(fields.engine, engineList().map((e) => ({ value: e.id, label: e.label })));
  fillSelect(fields.thinkingMode, THINKING_MODES);
  fillSelect(fields.targetLang, LANGUAGES);
  fillSelect(fields.theme, THEMES);
  renderHotkey();
  const cfg = await getConfig();
  currentCfg = cfg;
  applyConfig(cfg);
  $('saveResult').textContent = '';
  renderBrowserShortcut();
  fetchModels(); // 已经保存过地址和 Key 时，打开设置页就把列表准备好
}

$('save').addEventListener('click', async () => {
  const patch = readForm();
  const active = activeConfig(patch);
  if (!active.apiKey) {
    setResult($('saveResult'), '还没有填 API Key，保存后翻译会失败。', 'bad');
  }
  currentCfg = await saveConfig(patch);
  setResult($('saveResult'), '已保存（' + new Date().toLocaleTimeString() + '）', 'ok');
});

$('reset').addEventListener('click', async () => {
  await saveConfig(DEFAULTS);
  applyConfig(DEFAULTS);
  setResult($('saveResult'), '已恢复默认值', 'ok');
});

$('test').addEventListener('click', async () => {
  const btn = $('test');
  btn.disabled = true;
  setResult($('testResult'), '测试中…');
  try {
    await saveConfig(readForm()); // 先落盘，后台读的是存储里的配置
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

$('clearCache').addEventListener('click', async () => {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'cache:clear' }, () => resolve());
  });
  setResult($('saveResult'), '翻译缓存已清空', 'ok');
});

// ---------------- 配置导出 / 导入 ----------------
// 用途：换电脑、或换扩展 ID（品牌改名、目录改名）时，把配置整份搬过去，
// 不用重新填 Key 和各项设置。
// 解析与校验在 lib/config.js 的 pickImportedConfig 里（纯函数，可被 node 直接测试）。
function buildExport(includeKey) {
  const cfg = { ...currentCfg };
  // Key 藏在每个引擎的配置里：导出时逐个处理
  cfg.engineConfig = {};
  Object.keys(currentCfg.engineConfig || {}).forEach((id) => {
    const one = { ...(currentCfg.engineConfig[id] || {}) };
    if (!includeKey) delete one.apiKey;
    cfg.engineConfig[id] = one;
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
    renderBrowserShortcut();
    if (next.baseUrl && next.apiKey) fetchModels();

    let msg = '已导入 ' + Object.keys(patch).length + ' 项设置';
    if (parsed.rejected.length) {
      msg += '；' + parsed.rejected.length + ' 项取值不合法已忽略（' + parsed.rejected.join('、') + '）';
    }
    const importedKey = Object.keys(patch.engineConfig || {}).some(
      (id) => patch.engineConfig[id] && patch.engineConfig[id].apiKey
    );
    if (!importedKey) msg += '（文件里没有 API Key，请手动填）';
    setResult($('cfgResult'), msg, parsed.rejected.length ? 'bad' : 'ok');
  } catch (err) {
    setResult($('cfgResult'), '导入失败：' + err.message, 'bad');
  }
});

init();
