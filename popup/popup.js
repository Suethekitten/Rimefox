import {
  getConfig,
  saveConfig,
  LANGUAGES,
  hotkeyLabel,
  KEYS,
  EXTENSIONS_PAGE,
  FILE_ACCESS_LABEL,
  browserShortcut,
  STYLES,
  mergeConfig,
  DEFAULTS
} from '../lib/config.js';
import { providerById } from '../lib/providers.js';
import { applyI18n, t } from '../lib/i18n.js';
import { normalizeHosts, hostListed } from '../lib/site-rules.js';
import { applyUiAppearance, switchThemeAnimated, rememberSaved, watchConfig } from '../lib/ui-appearance.js';

const el = {
  ver: document.getElementById('ver'),
  toggle: document.getElementById('toggle'),
  modeSeg: document.getElementById('modeSeg'),
  styleSeg: document.getElementById('styleSeg'),
  target: document.getElementById('target'),
  stat: document.getElementById('stat'),
  meta: document.getElementById('meta'),
  statusBox: document.getElementById('statusBox'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progressBar'),
  retranslate: document.getElementById('retranslate'),
  clearCache: document.getElementById('clearCache'),
  diagnose: document.getElementById('diagnose'),
  openOptions: document.getElementById('openOptions'),
  quickInput: document.getElementById('quickInput'),
  quickGo: document.getElementById('quickGo'),
  quickCopy: document.getElementById('quickCopy'),
  quickClear: document.getElementById('quickClear'),
  quickOut: document.getElementById('quickOut'),
  themeToggle: document.getElementById('themeToggle'),
  nightRow: document.getElementById('nightRow'),
  nightSite: document.getElementById('nightSite'),
  nightHost: document.getElementById('nightHost')
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
      reject(new Error(t('没有可用标签页')));
      return;
    }
    // 只发主框架：页面里的 iframe（Twitter 挂件、广告位）也跑着内容脚本，
    // 不带 frameId 时谁先应答就用谁，诊断/状态会拿到 iframe 的空结果
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (res) => {
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

// 状态点颜色 + 进度条（文字仍由下面的 render 填）
function renderState() {
  let state = 'idle';
  if (!supported) state = 'unsupported';
  else if (status.busy) state = 'busy';
  else if (status.failed && status.lastError) state = 'error';
  else if (status.enabled) state = 'on';
  el.statusBox.dataset.state = state;

  const showProgress = state === 'busy' && status.total > 0;
  el.progress.hidden = !showProgress;
  if (showProgress) {
    el.progressBar.style.width = Math.min(100, Math.round((status.translated / status.total) * 100)) + '%';
  }
}

function render() {
  el.ver.textContent = 'v' + (chrome.runtime.getManifest().version || '0.1.0');
  renderState();

  if (!supported) {
    el.toggle.disabled = true;
    const url = tabUrl || '';
    const injectable = /^(https?|file):/i.test(url);
    if (/\.pdf($|[?#])/i.test(url)) {
      // 浏览器自带的 PDF 阅读器里不能注入脚本，刷新也没用
      el.toggle.textContent = t('PDF 暂不支持');
      el.stat.textContent = t('这是浏览器自带的 PDF 阅读器，扩展无法在里面翻译。');
    } else if (/^file:/i.test(url)) {
      // Chrome / Edge 默认不让扩展碰本地文件，要用户手动开开关
      el.toggle.textContent = t('本地文件需要授权');
      el.stat.textContent = t(
        '打开 ' + EXTENSIONS_PAGE + ' → 本扩展的「详细信息」→ 开启「' + FILE_ACCESS_LABEL + '」，然后按 ' +
          KEYS.reload + ' 刷新这个页面。'
      );
    } else if (injectable) {
      el.toggle.textContent = t('无法连接页面脚本');
      el.stat.textContent = t(
        '自动补注入失败。请在网页上按 ' + KEYS.reload + ' 刷新后重新打开本面板；仍然失败请按 ' +
          KEYS.console + ' 打开控制台看红色报错。'
      );
    } else if (!url) {
      // 没有 tabs 权限时，扩展读不到无权访问页面的地址：可能是浏览器内置页，也可能是没开文件访问的本地文件，两种都提示
      el.toggle.textContent = t('当前页面不支持');
      el.stat.textContent = t(
        '浏览器内置页、扩展商店页无法翻译。如果这是本地文件，请打开 ' + EXTENSIONS_PAGE + ' → 本扩展的「详细信息」→ 开启「' +
          FILE_ACCESS_LABEL + '」，然后按 ' + KEYS.reload + ' 刷新。'
      );
    } else {
      el.toggle.textContent = t('当前页面不支持');
      el.stat.textContent = t(
        '浏览器内置页、扩展商店页、扩展自身页面无法注入脚本。请切换到普通网页（http/https）。'
      );
    }
    el.modeSeg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    el.styleSeg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    el.target.disabled = true;
    return;
  }

  el.toggle.disabled = false;
  el.toggle.classList.toggle('on', !!status.enabled);
  el.toggle.textContent = t(
    status.busy ? '翻译中…（点此停止）' : status.enabled ? '还原原文' : '翻译此页'
  );

  el.modeSeg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === status.mode);
  });
  el.styleSeg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.style === (status.style || 'plain'));
  });
  el.target.value = status.target || 'zh-CN';

  if (!status.enabled) {
    if (shortcut === '') {
      el.stat.textContent = t(
        '未开启。浏览器快捷键没有设置成功（' + hotkeyLabel('alt+a') + ' 可能被其它扩展占用），可在「设置」里重新设置。'
      );
    } else {
      el.stat.textContent = t('未开启。按 ' + (shortcut || hotkeyLabel(currentCfg.hotkey)) + ' 可直接翻译。');
    }
  } else if (status.busy) {
    var total = status.total || '?';
    var pct = status.total ? Math.round((status.translated / status.total) * 100) : 0;
    el.stat.textContent = t(
      '翻译中… 已译 ' + status.translated + ' / ' + total + ' 段' + (status.total ? '（' + pct + '%）' : '')
    );
  } else {
    const parts = [t('已译 ' + status.translated + ' 段')];
    if (status.skipped) parts.push(t('与原文相同 ' + status.skipped + ' 段'));
    if (status.failed) parts.push(t('失败 ' + status.failed + ' 段'));
    if (status.total) parts.push(t('共 ' + status.total + ' 段'));
    el.stat.textContent = parts.join(' · ');
    if (status.failed && status.lastError) {
      el.stat.textContent += '\n' + t('失败原因：') + status.lastError;
    }
  }
}

// 当前服务商 + 模型：放在状态卡底部，省得为了确认"在用谁"再进设置
function providerName(cfg) {
  const id = cfg.currentProvider || 'deepseek';
  const custom = (cfg.customProviders || []).find((one) => one.id === id);
  if (custom && custom.name) return custom.name;
  const tpl = providerById(id);
  return (tpl && tpl.name) || id;
}

function renderMeta() {
  const id = currentCfg.currentProvider || 'deepseek';
  const model = ((currentCfg.providerConfig || {})[id] || {}).model || '';
  const name = providerName(currentCfg);
  el.meta.textContent = model ? name + ' · ' + model : name;
  el.meta.title = t('当前服务商和模型');
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
        el.stat.textContent = t('状态同步失败（页面可能正在切换）。重新打开本面板即可。');
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

function applyUiTheme(value) {
  const root = document.documentElement;
  if (value === 'light' || value === 'dark') {
    root.dataset.theme = value;
    root.style.colorScheme = value;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = '';
  }
  // 首帧预判用（lib/ui-theme-boot.js）：读配置之前先按上次的取值上色，避免闪一帧白底
  try {
    if (value === 'light' || value === 'dark') localStorage.setItem('dt.uiTheme', value);
    else localStorage.removeItem('dt.uiTheme');
  } catch (err) {
    /* 存储不可用就退化为 prefers-color-scheme */
  }
}

// ---------------- 深色 / 浅色一键切换 ----------------
// 图标显示"点下去会变成哪边"：浅色时显示月亮（切深色），深色时显示太阳。
// 点一次就写成明确取值（不再留在 auto），下次打开弹窗和设置页都跟着走。
let uiTheme = 'auto';
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveUiTheme() {
  if (uiTheme === 'light' || uiTheme === 'dark') return uiTheme;
  return darkMedia.matches ? 'dark' : 'light';
}

function renderThemeToggle() {
  const next = effectiveUiTheme() === 'dark' ? 'light' : 'dark';
  el.themeToggle.dataset.next = next;
  const label = t(next === 'dark' ? '切换到深色' : '切换到浅色');
  el.themeToggle.title = label;
  el.themeToggle.setAttribute('aria-label', label);
}

darkMedia.addEventListener('change', () => {
  // auto 时随系统变化，图标要跟着换
  if (uiTheme === 'auto') renderThemeToggle();
});

el.themeToggle.addEventListener('click', async () => {
  const next = el.themeToggle.dataset.next === 'light' ? 'light' : 'dark';
  uiTheme = next;
  // 支持 View Transition 时从按钮位置圆形扩散
  switchThemeAnimated(() => {
    applyUiTheme(next);
    renderThemeToggle();
  }, el.themeToggle);
  await saveAndRemember({ uiTheme: next });
});

// 存配置并记下结果：自己这次写入触发的 storage.onChanged 不再回调（见 watchConfig）
async function saveAndRemember(patch) {
  try {
    const saved = await saveConfig(patch);
    if (saved) {
      currentCfg = saved;
      rememberSaved(saved);
    }
    return saved;
  } catch (err) {
    /* 存不进配置也不影响这次显示，下次打开会回到之前的设置 */
    return null;
  }
}

// ---------------- 本站夜间模式（Beta） ----------------
// 只在普通网页显示；打开 = 把当前网站加进名单并打开总开关，关闭 = 把能匹配到这个网站的名单项去掉
function tabHostname() {
  try {
    const url = new URL(tabUrl);
    return /^https?:$/.test(url.protocol) ? url.hostname : '';
  } catch (err) {
    return '';
  }
}

function renderNight() {
  const host = tabHostname();
  el.nightRow.hidden = !host || !supported;
  if (el.nightRow.hidden) return;
  el.nightHost.textContent = host;
  el.nightHost.title = host;
  el.nightSite.checked = !!currentCfg.nightMode && hostListed(host, currentCfg.nightSites);
  const label = t('本站夜间模式（Beta）：把网页反色成深色，图片和视频保持原样');
  el.nightSite.setAttribute('aria-label', label);
  el.nightRow.title = label;
}

el.nightSite.addEventListener('change', async () => {
  const host = tabHostname();
  if (!host) return;
  const sites = normalizeHosts(currentCfg.nightSites || []);
  const on = el.nightSite.checked;
  const patch = on
    ? { nightMode: true, nightSites: hostListed(host, sites) ? sites : sites.concat(host) }
    : { nightSites: sites.filter((one) => !(host === one || host.endsWith('.' + one))) };
  el.nightSite.disabled = true;
  await saveAndRemember(patch);
  el.nightSite.disabled = false;
  renderNight();
});

// 设置页或另一个弹窗改了配置：外观、主题图标、服务商、夜间开关跟着变
function onConfigElsewhere(next) {
  currentCfg = mergeConfig(DEFAULTS, next);
  uiTheme = currentCfg.uiTheme || 'auto';
  applyUiTheme(uiTheme);
  applyUiAppearance(currentCfg);
  renderThemeToggle();
  renderMeta();
  renderNight();
}

async function init() {
  const cfg = await getConfig();
  currentCfg = cfg;
  rememberSaved(cfg);
  uiTheme = cfg.uiTheme || 'auto';
  applyUiTheme(cfg.uiTheme);
  applyUiAppearance(cfg);
  shortcut = await browserShortcut();

  LANGUAGES.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang.value;
    opt.textContent = lang.label;
    el.target.appendChild(opt);
  });
  el.target.value = cfg.targetLang || 'zh-CN';
  STYLES.forEach((style) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.style = style.value;
    btn.textContent = style.label;
    el.styleSeg.appendChild(btn);
  });
  // Mac 上是 ⌘+Enter（keydown 里本来就同时认 Ctrl 和 ⌘）
  el.quickInput.placeholder = t('粘贴 / 输入要翻译的文字…（' + KEYS.submit + ' 翻译）');

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
  applyI18n(document, cfg.uiLang);
  // 状态文案是在切语言之前拼的，重画一遍才会按新语言走
  render();
  renderMeta();
  renderThemeToggle();
  renderNight();
  watchConfig(onConfigElsewhere);
}

el.toggle.addEventListener('click', async () => {
  el.toggle.disabled = true;
  // 先给即时反馈，再等后台真正开始
  el.stat.textContent = t(status.enabled ? '正在还原…' : '正在开始翻译…');
  try {
    status = await sendToTab({ type: 'dt:toggle' });
    supported = true;
  } catch (err) {
    el.stat.textContent = t('操作失败：') + err.message;
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
    await saveAndRemember({ mode });
  } catch (err) {
    el.stat.textContent = t('切换失败：') + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

// 趣味翻译：当前页按风格重翻（不保存到配置，还原后回到普通）
el.styleSeg.addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-style]');
  if (!btn) return;
  try {
    status = await sendToTab({ type: 'dt:setStyle', style: btn.dataset.style });
    stopPolling();
  } catch (err) {
    el.stat.textContent = t('切换失败：') + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.target.addEventListener('change', async () => {
  const target = el.target.value;
  await saveAndRemember({ targetLang: target });
  try {
    status = await sendToTab({ type: 'dt:setTarget', target });
    stopPolling();
  } catch (err) {
    el.stat.textContent = t('切换失败：') + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.retranslate.addEventListener('click', async () => {
  try {
    status = await sendToTab({ type: 'dt:retranslate' });
    stopPolling();
  } catch (err) {
    el.stat.textContent = t('操作失败：') + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.clearCache.addEventListener('click', async () => {
  await sendToBg({ type: 'cache:clear' }).catch(() => {});
  el.stat.textContent = t('缓存已清空，下次翻译会重新请求。');
});

el.diagnose.addEventListener('click', async () => {
  el.stat.textContent = t('正在生成诊断信息…');
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
      t(
        copied
          ? '诊断信息已复制到剪贴板，直接粘贴给我。'
          : '复制失败：在网页上按 ' + KEYS.console + ' 打开控制台，把左上角的「top」切换成本扩展，再执行 copy(JSON.stringify(__DT_LAST_DIAG)) 然后粘贴给我。'
      ) +
      t('\n翻译单元 ' + s.units + ' 个 · 被跳过 ' + s.skipped + ' 个') +
      t('\n其中：文本过短 ' + s.wouldSkipByText + ' 个 · 判定为目标语言 ' + s.wouldSkipByLang + ' 个');
  } catch (err) {
    el.stat.textContent = t('诊断失败：') + err.message;
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
  el.quickGo.textContent = t('翻译中…');
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
      el.quickOut.textContent = t('翻译失败：') + ((res && res.error) || t('未知错误'));
    }
  } catch (err) {
    el.quickOut.textContent = t('翻译失败：') + err.message;
  }

  el.quickGo.disabled = false;
  el.quickGo.textContent = t('开始翻译');
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
    el.quickCopy.textContent = t('已复制');
    setTimeout(() => {
      el.quickCopy.textContent = t('复制结果');
    }, 1200);
  } catch (err) {
    el.quickOut.textContent = t('复制失败，请手动选中复制。');
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
