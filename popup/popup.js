import {
  getConfig,
  saveConfig,
  LANGUAGES,
  hotkeyLabel,
  KEYS,
  EXTENSIONS_PAGE,
  FILE_ACCESS_LABEL,
  browserShortcut
} from '../lib/config.js';

const el = {
  ver: document.getElementById('ver'),
  toggle: document.getElementById('toggle'),
  modeSeg: document.getElementById('modeSeg'),
  target: document.getElementById('target'),
  stat: document.getElementById('stat'),
  retranslate: document.getElementById('retranslate'),
  clearCache: document.getElementById('clearCache'),
  diagnose: document.getElementById('diagnose'),
  openOptions: document.getElementById('openOptions'),
  quickInput: document.getElementById('quickInput'),
  quickGo: document.getElementById('quickGo'),
  quickCopy: document.getElementById('quickCopy'),
  quickClear: document.getElementById('quickClear'),
  quickOut: document.getElementById('quickOut')
};

let tabId = null;
let tabUrl = '';
let supported = false;
let injectFailed = false;
let currentCfg = { targetLang: 'zh-CN' };
// 浏览器实际分配的快捷键（空 = 没分配到，多半被其它扩展占用）；null = 还没查
let shortcut = null;
let status = { enabled: false, mode: 'dual', target: 'zh-CN', total: 0, translated: 0, failed: 0, busy: false };

function sendToTab(msg) {
  return new Promise((resolve, reject) => {
    if (tabId == null) {
      reject(new Error('没有可用标签页'));
      return;
    }
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

function sendToBg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

function render() {
  el.ver.textContent = 'v' + (chrome.runtime.getManifest().version || '0.1.0');

  if (!supported) {
    el.toggle.disabled = true;
    const url = tabUrl || '';
    const injectable = /^(https?|file):/i.test(url);
    if (/\.pdf($|[?#])/i.test(url)) {
      // 浏览器自带的 PDF 阅读器里不能注入脚本，刷新也没用
      el.toggle.textContent = 'PDF 暂不支持';
      el.stat.textContent = '这是浏览器自带的 PDF 阅读器，扩展无法在里面翻译。';
    } else if (/^file:/i.test(url)) {
      // Chrome / Edge 默认不让扩展碰本地文件，要用户手动开开关
      el.toggle.textContent = '本地文件需要授权';
      el.stat.textContent =
        '打开 ' + EXTENSIONS_PAGE + ' → 本扩展的「详细信息」→ 开启「' + FILE_ACCESS_LABEL + '」，然后按 ' +
        KEYS.reload + ' 刷新这个页面。';
    } else if (injectable) {
      el.toggle.textContent = '无法连接页面脚本';
      el.stat.textContent =
        '自动补注入失败。请在网页上按 ' + KEYS.reload + ' 刷新后重新打开本面板；仍然失败请按 ' +
        KEYS.console + ' 打开控制台看红色报错。';
    } else {
      el.toggle.textContent = '当前页面不支持';
      el.stat.textContent = '浏览器内置页、扩展商店页、扩展自身页面无法注入脚本。请切换到普通网页（http/https）。';
    }
    el.modeSeg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    el.target.disabled = true;
    return;
  }

  el.toggle.disabled = false;
  el.toggle.classList.toggle('on', !!status.enabled);
  el.toggle.textContent = status.busy
    ? '翻译中…（点此停止）'
    : status.enabled
    ? '还原原文'
    : '翻译此页';

  el.modeSeg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === status.mode);
  });
  el.target.value = status.target || 'zh-CN';

  if (!status.enabled) {
    if (shortcut === '') {
      el.stat.textContent =
        '未开启。浏览器快捷键没有设置成功（' + hotkeyLabel('alt+a') + ' 可能被其它扩展占用），可在「设置」里重新设置。';
    } else {
      el.stat.textContent = '未开启。按 ' + (shortcut || hotkeyLabel(currentCfg.hotkey)) + ' 可直接翻译。';
    }
  } else if (status.busy) {
    var total = status.total || '?';
    var pct = status.total ? Math.round((status.translated / status.total) * 100) : 0;
    el.stat.textContent =
      '翻译中… 已译 ' + status.translated + ' / ' + total + ' 段' + (status.total ? '（' + pct + '%）' : '');
  } else {
    const parts = ['已译 ' + status.translated + ' 段'];
    if (status.skipped) parts.push('与原文相同 ' + status.skipped + ' 段');
    if (status.failed) parts.push('失败 ' + status.failed + ' 段');
    if (status.total) parts.push('共 ' + status.total + ' 段');
    el.stat.textContent = parts.join(' · ');
    if (status.failed && status.lastError) {
      el.stat.textContent += '\n失败原因：' + status.lastError;
    }
  }
}

// 轮询：翻译过程中实时刷新进度（内容脚本每插一段就更新计数）
let pollTimer = 0;
let pollFailures = 0;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = 0;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollFailures = 0;
  pollTimer = setInterval(async () => {
    try {
      status = await sendToTab({ type: 'dt:status' });
      pollFailures = 0;
      supported = true;
      render();
      if (!status.busy) stopPolling();
    } catch (err) {
      // 单次失败（页面正在导航、内容脚本重注入）不要立刻停，
      // 否则面板会永久冻结在"翻译中"的旧状态
      pollFailures += 1;
      if (pollFailures >= 4) {
        stopPolling();
        el.stat.textContent = '状态同步失败（页面可能正在切换）。重新打开本面板即可。';
      }
    }
  }, 400);
}

async function refresh() {
  try {
    status = await sendToTab({ type: 'dt:status' });
    supported = true;
    injectFailed = false;
    render();
    return;
  } catch (err) {
    // 连不上：先让后台补注入一次，再重试
    const injected = await sendToBg({ type: 'ensure', tabId }).catch(() => null);
    if (injected && injected.ok) {
      try {
        status = await sendToTab({ type: 'dt:status' });
        supported = true;
        injectFailed = false;
        render();
        return;
      } catch (err2) {
        /* 补注入后仍然连不上 */
      }
    }
    supported = false;
    injectFailed = true;
    render();
  }
}

async function init() {
  const cfg = await getConfig();
  currentCfg = cfg;
  shortcut = await browserShortcut();

  LANGUAGES.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang.value;
    opt.textContent = lang.label;
    el.target.appendChild(opt);
  });
  el.target.value = cfg.targetLang || 'zh-CN';
  // Mac 上是 ⌘+Enter（keydown 里本来就同时认 Ctrl 和 ⌘）
  el.quickInput.placeholder = '粘贴 / 输入要翻译的文字…（' + KEYS.submit + ' 翻译）';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) {
      tabId = tabs[0].id;
      tabUrl = tabs[0].url || '';
    }
  } catch (err) {
    tabId = null;
  }

  await refresh();
  if (status.target) el.target.value = status.target;
  if (status.busy) startPolling();
}

el.toggle.addEventListener('click', async () => {
  el.toggle.disabled = true;
  // 先给即时反馈，再等后台真正开始
  el.stat.textContent = status.enabled ? '正在还原…' : '正在开始翻译…';
  try {
    status = await sendToTab({ type: 'dt:toggle' });
    supported = true;
  } catch (err) {
    el.stat.textContent = '操作失败：' + err.message;
  }
  el.toggle.disabled = false;
  render();
  if (status && status.busy) startPolling();
});

el.modeSeg.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode;
  try {
    status = await sendToTab({ type: 'dt:setMode', mode });
    stopPolling();
    await saveConfig({ mode });
  } catch (err) {
    el.stat.textContent = '切换失败：' + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.target.addEventListener('change', async () => {
  const target = el.target.value;
  await saveConfig({ targetLang: target });
  try {
    status = await sendToTab({ type: 'dt:setTarget', target });
    stopPolling();
  } catch (err) {
    el.stat.textContent = '切换失败：' + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.retranslate.addEventListener('click', async () => {
  try {
    status = await sendToTab({ type: 'dt:retranslate' });
    stopPolling();
  } catch (err) {
    el.stat.textContent = '操作失败：' + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.clearCache.addEventListener('click', async () => {
  await sendToBg({ type: 'cache:clear' }).catch(() => {});
  el.stat.textContent = '缓存已清空，下次翻译会重新请求。';
});

el.diagnose.addEventListener('click', async () => {
  el.stat.textContent = '正在生成诊断信息…';
  try {
    const report = await sendToTab({ type: 'dt:diagnose' });
    const text = JSON.stringify(report, null, 1);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = false;
    }
    const s = report && report.summary ? report.summary : { units: 0, skipped: 0 };
    el.stat.textContent =
      (copied ? '诊断信息已复制到剪贴板，直接粘贴给我。' : '复制失败：在网页上按 ' + KEYS.console + ' 打开控制台，把左上角的「top」切换成本扩展，再执行 copy(JSON.stringify(__DT_LAST_DIAG)) 然后粘贴给我。') +
      '\n翻译单元 ' + s.units + ' 个 · 被跳过 ' + s.skipped + ' 个' +
      '\n其中：文本过短 ' + s.wouldSkipByText + ' 个 · 判定为目标语言 ' + s.wouldSkipByLang + ' 个';
  } catch (err) {
    el.stat.textContent = '诊断失败：' + err.message;
  }
});

// ---------------- 快捷翻译（不依赖页面） ----------------
async function runQuickTranslate() {
  const text = el.quickInput.value.trim();
  if (!text) {
    el.quickInput.focus();
    return;
  }

  el.quickGo.disabled = true;
  el.quickGo.textContent = '翻译中…';
  el.quickOut.hidden = false;
  el.quickOut.textContent = '……';

  try {
    const res = await sendToBg({
      type: 'translate',
      texts: [text],
      target: (status && status.target) || currentCfg.targetLang || 'zh-CN'
    });
    if (res && res.ok && res.results && typeof res.results[0] === 'string' && res.results[0]) {
      el.quickOut.textContent = res.results[0];
    } else {
      el.quickOut.textContent = '翻译失败：' + ((res && res.error) || '未知错误');
    }
  } catch (err) {
    el.quickOut.textContent = '翻译失败：' + err.message;
  }

  el.quickGo.disabled = false;
  el.quickGo.textContent = '翻译';
}

el.quickGo.addEventListener('click', runQuickTranslate);

el.quickInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    runQuickTranslate();
  }
});

el.quickCopy.addEventListener('click', async () => {
  const text = el.quickOut.textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    el.quickCopy.textContent = '已复制';
    setTimeout(() => {
      el.quickCopy.textContent = '复制结果';
    }, 1200);
  } catch (err) {
    el.quickOut.textContent = '复制失败，请手动选中复制。';
  }
});

el.quickClear.addEventListener('click', () => {
  el.quickInput.value = '';
  el.quickOut.textContent = '';
  el.quickOut.hidden = true;
  el.quickInput.focus();
});

el.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
