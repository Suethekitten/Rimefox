import { DEFAULTS, getConfig, saveConfig, LANGUAGES, THEMES, IS_MAC, hotkeyLabel } from '../lib/config.js';

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

async function init() {
  fillSelect(fields.targetLang, LANGUAGES);
  fillSelect(fields.theme, THEMES);
  renderHotkey();
  const cfg = await getConfig();
  applyConfig(cfg);
  $('saveResult').textContent = '';
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

init();
