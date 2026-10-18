import {
  DEFAULTS,
  getConfig,
  saveConfig,
  LANGUAGES,
  THEMES,
  IS_MAC,
  hotkeyLabel,
  browserShortcut,
  openShortcutsPage
} from '../lib/config.js';
import { listModels } from '../lib/provider.js';

const $ = (id) => document.getElementById(id);

const fields = {
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
  targetLang: $('targetLang'),
  theme: $('theme'),
  batchSize: $('batchSize'),
  maxCharsPerBatch: $('maxCharsPerBatch'),
  maxUnitChars: $('maxUnitChars'),
  concurrency: $('concurrency'),
  skipSameLang: $('skipSameLang'),
  translateOnLoad: $('translateOnLoad'),
  lazy: $('lazy'),
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

function applyConfig(cfg) {
  fields.baseUrl.value = cfg.baseUrl || '';
  fields.apiKey.value = cfg.apiKey || '';
  fields.model.value = cfg.model || '';
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
  fields.chromeBilingual.checked = !!cfg.chromeBilingual;
  fields.debug.checked = !!cfg.debug;
}

function readForm() {
  return {
    baseUrl: fields.baseUrl.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim(),
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
const NON_CHAT = /embed|rerank|whisper|tts|speech|audio|dall-?e|moderation|bge-|stable-diffusion|flux|kolors|cogview|cogvideo|video|image/i;
// 带"思考"过程的模型：能用，但整页翻译会慢很多倍
const REASONING = /reason|thinking|qwq|(^|[-/])[rz]1([-.]|$)|(^|[-/])o[134](-|$)/i;

const modelSelect = $('modelSelect');
const modelHint = $('modelHint');
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
    const ids = (await listModels({ baseUrl, apiKey })).filter((id) => !NON_CHAT.test(id)).sort();
    if (seq !== modelSeq) return; // 期间地址或 Key 又改了，以最新一次为准
    renderModelList(ids);
  } catch (err) {
    if (seq !== modelSeq) return;
    renderModelList([]);
    // "接口不提供模型列表"本身已经说了要手填，别再重复一遍
    const text = /手填/.test(err.message)
      ? err.message + '。'
      : '获取模型列表失败：' + err.message + '。可以直接手填模型名。';
    setResult(modelHint, text, 'bad');
  }
}

function renderModelList(ids) {
  modelSelect.innerHTML = '';
  modelSelect.hidden = !ids.length;
  if (!ids.length) return;

  const head = document.createElement('option');
  head.value = '';
  head.textContent = '从 ' + ids.length + ' 个模型中选择…';
  modelSelect.appendChild(head);
  ids.forEach((id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = REASONING.test(id) ? id + '（带思考，翻译慢）' : id;
    modelSelect.appendChild(opt);
  });

  // 没填过模型就自动选一个：优先默认模型，其次第一个不带思考的。填过的不动
  let picked = '';
  if (!fields.model.value.trim()) {
    picked = ids.includes(DEFAULTS.model) ? DEFAULTS.model : ids.find((id) => !REASONING.test(id)) || ids[0];
    fields.model.value = picked;
  }
  syncModelSelect(ids.length, picked);
}

// 输入框是唯一的真值；下拉框只跟着显示，并提示"填的模型不在列表里"
function syncModelSelect(count, picked) {
  const current = fields.model.value.trim();
  const listed = Array.from(modelSelect.options).some((o) => o.value && o.value === current);
  modelSelect.value = listed ? current : '';
  if (current && !listed) {
    setResult(modelHint, '已获取 ' + count + ' 个模型，但当前填的「' + current + '」不在列表里，请确认拼写或从右边选一个。', 'bad');
  } else {
    setResult(
      modelHint,
      '已获取 ' + count + ' 个模型' + (picked ? '，已自动选好「' + picked + '」' : '') + '。可以从右边的列表换一个，别忘了保存。',
      'ok'
    );
  }
}

modelSelect.addEventListener('change', () => {
  if (!modelSelect.value) return;
  fields.model.value = modelSelect.value;
  syncModelSelect(modelSelect.options.length - 1, '');
});
fields.model.addEventListener('input', () => {
  if (!modelSelect.hidden) syncModelSelect(modelSelect.options.length - 1, '');
});
fields.baseUrl.addEventListener('input', scheduleModelFetch);
fields.apiKey.addEventListener('input', scheduleModelFetch);
$('refreshModels').addEventListener('click', () => fetchModels(true));

async function init() {
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
  if (!patch.apiKey) {
    setResult($('saveResult'), '还没有填 API Key，保存后翻译会失败。', 'bad');
  }
  await saveConfig(patch);
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
const EXPORT_APP = 'rimefox';
const EXPORT_SCHEMA = 1;

function buildExport(includeKey) {
  const cfg = { ...currentCfg };
  if (!includeKey) delete cfg.apiKey;
  return {
    app: EXPORT_APP,
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    config: cfg
  };
}

// 只接受已知字段，并按默认值的类型转换；多余字段直接丢弃（避免把陌生键写进配置）
function pickImportedConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('文件内容不是一个 JSON 对象');
  }
  if (raw.app && raw.app !== EXPORT_APP) {
    throw new Error('这不是凛狐的配置文件（app = ' + raw.app + '）');
  }
  if (raw.schema && Number(raw.schema) > EXPORT_SCHEMA) {
    throw new Error('配置文件版本比当前扩展新，请先升级扩展');
  }

  const src = raw.config && typeof raw.config === 'object' ? raw.config : raw;
  const out = {};

  Object.keys(DEFAULTS).forEach((key) => {
    const def = DEFAULTS[key];
    const val = src[key];
    if (val === undefined || val === null) return;
    if (typeof def === 'boolean') {
      out[key] = !!val;
    } else if (typeof def === 'number') {
      const n = Number(val);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof def === 'string') {
      if (typeof val === 'string') out[key] = val;
    }
  });

  if (!Object.keys(out).length) throw new Error('文件里没有可识别的配置项');
  return out;
}

$('exportCfg').addEventListener('click', () => {
  try {
    const includeKey = $('exportKey').checked;
    const payload = buildExport(includeKey);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
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

    const patch = pickImportedConfig(raw);
    const next = await saveConfig(patch);
    currentCfg = next;
    applyConfig(next);
    renderBrowserShortcut();
    if (next.baseUrl && next.apiKey) fetchModels();

    const count = Object.keys(patch).length;
    setResult(
      $('cfgResult'),
      '已导入 ' + count + ' 项设置' + (patch.apiKey ? '（含 API Key）' : '（文件里没有 API Key，请手动填）'),
      'ok'
    );
  } catch (err) {
    setResult($('cfgResult'), '导入失败：' + err.message, 'bad');
  }
});

init();
