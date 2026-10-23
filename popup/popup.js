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
import { applyUiTheme, applyUiAppearance, switchThemeAnimated, rememberSaved, watchConfig } from '../lib/ui-appearance.js';
import { openWelcomePage } from '../lib/welcome.js';
import { mountGlassDock } from '../lib/liquid-glass/dock.js';
import { ensureGlassFilter } from '../lib/liquid-glass/material.js';

const el = {
  ver: document.getElementById('ver'),
  toggle: document.getElementById('toggle'),
  toggleLabel: document.getElementById('toggleLabel'),
  toggleKbd: document.getElementById('toggleKbd'),
  statusTitle: document.getElementById('statusTitle'),
  statusCount: document.getElementById('statusCount'),
  heroFoot: document.getElementById('heroFoot'),
  modeSeg: document.getElementById('modeSeg'),
  styleSelect: document.getElementById('styleSelect'),
  target: document.getElementById('target'),
  hoverCompare: document.getElementById('hoverCompare'),
  medicalMode: document.getElementById('medicalMode'),
  medicalRow: document.getElementById('medicalRow'),
  stat: document.getElementById('stat'),
  meta: document.getElementById('meta'),
  statusBox: document.getElementById('statusBox'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progressBar'),
  retranslate: document.getElementById('retranslate'),
  clearCache: document.getElementById('clearCache'),
  diagnose: document.getElementById('diagnose'),
  openGuide: document.getElementById('openGuide'),
  openOptions: document.getElementById('openOptions'),
  quickInput: document.getElementById('quickInput'),
  quickGo: document.getElementById('quickGo'),
  quickCopy: document.getElementById('quickCopy'),
  quickClear: document.getElementById('quickClear'),
  quickOut: document.getElementById('quickOut'),
  quickKbd: document.getElementById('quickKbd'),
  quickTarget: document.getElementById('quickTarget'),
  themeToggle: document.getElementById('themeToggle'),
  langToggle: document.getElementById('langToggle'),
  nightRow: document.getElementById('nightRow'),
  hoverRow: document.getElementById('hoverRow'),
  nightSite: document.getElementById('nightSite'),
  nightHost: document.getElementById('nightHost'),
  glassDock: document.getElementById('glassDock')
};

let tabId = null;
let tabUrl = '';
let glassDock = null;
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

// 主按钮的文字放在 #toggleLabel 里：按钮里还有图标和快捷键徽章，不能整体改 textContent
function setToggle(text) {
  el.toggleLabel.textContent = text;
}

// 主按钮右侧的快捷键徽章：浏览器实际分配的快捷键；没分配到（被占用）就不显示
function renderKbd() {
  const keys = shortcut === '' ? '' : shortcut || hotkeyLabel(currentCfg.hotkey);
  el.toggleKbd.textContent = keys || '';
  el.toggleKbd.hidden = !keys || !supported;
}

// 状态卡：标题（未开启 / 翻译中… / 已译 N 段）+ 右侧计数胶囊 + 详情（提示、失败原因）
function render() {
  el.ver.textContent = 'v' + (chrome.runtime.getManifest().version || '0.1.0');
  renderMedical();
  renderState();
  renderKbd();
  renderQuickTarget();
  let title = '';
  let count = '';
  let detail = '';

  if (!supported) {
    el.toggle.disabled = true;
    setToggle(t('翻译此页'));
    const url = tabUrl || '';
    const injectable = /^(https?|file):/i.test(url);
    if (/\.pdf($|[?#])/i.test(url)) {
      // 浏览器自带的 PDF 阅读器里不能注入脚本，刷新也没用
      title = t('PDF 暂不支持');
      detail = t('这是浏览器自带的 PDF 阅读器，扩展无法在里面翻译。');
    } else if (/^file:/i.test(url)) {
      // Chrome / Edge 默认不让扩展碰本地文件，要用户手动开开关
      title = t('本地文件需要授权');
      detail = t(
        '打开 ' + EXTENSIONS_PAGE + ' → 本扩展的「详细信息」→ 开启「' + FILE_ACCESS_LABEL + '」，然后按 ' +
          KEYS.reload + ' 刷新这个页面。'
      );
    } else if (injectable) {
      title = t('无法连接页面脚本');
      detail = t(
        '自动补注入失败。请在网页上按 ' + KEYS.reload + ' 刷新后重新打开本面板；仍然失败请按 ' +
          KEYS.console + ' 打开控制台看红色报错。'
      );
    } else if (!url) {
      // 没有 tabs 权限时，扩展读不到无权访问页面的地址：可能是浏览器内置页，也可能是没开文件访问的本地文件，两种都提示
      title = t('当前页面不支持');
      detail = t(
        '浏览器内置页、扩展商店页无法翻译。如果这是本地文件，请打开 ' + EXTENSIONS_PAGE + ' → 本扩展的「详细信息」→ 开启「' +
          FILE_ACCESS_LABEL + '」，然后按 ' + KEYS.reload + ' 刷新。'
      );
    } else {
      title = t('当前页面不支持');
      detail = t('浏览器内置页、扩展商店页、扩展自身页面无法注入脚本。请切换到普通网页（http/https）。');
    }
    el.modeSeg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    el.styleSelect.disabled = true;
    el.target.disabled = true;
    paintStatus(title, count, detail);
    return;
  }

  el.toggle.disabled = false;
  el.toggle.classList.toggle('on', !!status.enabled);
  setToggle(t(status.busy ? '翻译中…（点此停止）' : status.enabled ? '还原原文' : '翻译此页'));

  el.modeSeg.querySelectorAll('button').forEach((btn) => {
    btn.disabled = false;
    btn.classList.toggle('active', btn.dataset.mode === status.mode);
  });
  el.styleSelect.disabled = false;
  el.styleSelect.value = status.style || 'plain';
  el.target.disabled = false;
  el.target.value = status.target || 'zh-CN';
  renderQuickTarget();

  if (status.busy) {
    title = t('翻译中…');
    if (status.total) {
      const pct = Math.round((status.translated / status.total) * 100);
      count = status.translated + ' / ' + status.total + ' · ' + pct + '%';
    } else {
      count = String(status.translated || 0);
    }
  } else if (!status.enabled) {
    title = t('未开启');
    // 快捷键已经在主按钮右侧；只有没设置成功时才多说一句
    if (shortcut === '') {
      detail = t(
        '未开启。浏览器快捷键没有设置成功（' + hotkeyLabel('alt+a') + ' 可能被其它扩展占用），可在「设置」里重新设置。'
      );
    }
  } else {
    title = t('已译 ' + status.translated + ' 段');
    const parts = [];
    if (status.skipped) parts.push(t('跳过 ' + status.skipped));
    if (status.failed) parts.push(t('失败 ' + status.failed));
    if (!parts.length && status.total) parts.push(t('共 ' + status.total + ' 段'));
    count = parts.join(' · ');
    if (status.failed && status.lastError) detail = t('失败原因：') + status.lastError;
  }
  if (status.enabled && status.qualityWarnings) {
    const warning = t('专业翻译有 ' + status.qualityWarnings + ' 段需要核对；请对照原文确认数值与结论。');
    detail = detail ? detail + '\n' + warning : warning;
  }
  paintStatus(title, count, detail);
}

function paintStatus(title, count, detail) {
  el.statusTitle.textContent = title;
  el.statusCount.textContent = count;
  el.statusCount.hidden = !count;
  el.stat.textContent = detail;
}

// 随手翻译的目标语言提示（跟「译成」下拉框同一个值，文字已经过界面语言翻译）
function renderQuickTarget() {
  const opt = el.target.selectedOptions && el.target.selectedOptions[0];
  el.quickTarget.textContent = opt ? '→ ' + opt.textContent : '';
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

function renderHover() {
  var on = currentCfg.hoverCompare !== false;
  el.hoverCompare.checked = on;
  var label = t('悬停时显示对应原句；无法准确匹配时回退到行或段落。可在网页悬浮入口中快速开关。');
  el.hoverCompare.setAttribute('aria-label', t('悬停对照'));
  el.hoverRow.title = label;
}

function renderMedical() {
  if (!el.medicalMode) return;
  el.medicalMode.checked = currentCfg.medicalMode === true;
  const label = t('医学专业模式：优先使用已审核的医学术语；保留剂量、统计结果和临床结论');
  el.medicalMode.setAttribute('aria-label', t('医学专业模式'));
  if (el.medicalRow) el.medicalRow.title = label;
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

el.hoverCompare.addEventListener('change', async () => {
  var wanted = el.hoverCompare.checked;
  el.hoverCompare.disabled = true;
  var saved = await saveAndRemember({ hoverCompare: wanted });
  el.hoverCompare.disabled = false;
  if (!saved) {
    // 保存失败：恢复界面状态，不能让用户以为已经生效
    el.hoverCompare.checked = currentCfg.hoverCompare !== false;
    el.stat.textContent = t('设置保存失败，请重试');
    setTimeout(function () { render(); }, 1800);
    return;
  }
  currentCfg = saved;
  rememberSaved(saved);
  renderHover();
});

el.medicalMode.addEventListener('change', async () => {
  var wanted = el.medicalMode.checked;
  el.medicalMode.disabled = true;
  var saved = await saveAndRemember({ medicalMode: wanted });
  el.medicalMode.disabled = false;
  if (!saved) {
    el.medicalMode.checked = currentCfg.medicalMode === true;
    el.stat.textContent = t('设置保存失败，请重试');
    setTimeout(function () { renderMedical(); }, 1800);
    return;
  }
  currentCfg = saved;
  rememberSaved(saved);
  renderMedical();
});

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

// 按 <html data-liquid-glass> 挂载 / 销毁工具坞；关闭时 CSS 会把底部还原成普通图标栏。
function syncGlassDock() {
  const on = document.documentElement.getAttribute('data-liquid-glass') !== 'off';
  if (on) {
    ensureGlassFilter('mini-slider', { width: 20, height: 14, radius: 7 }, {
      strength: 3.5, depth: 1.2, chromaticAberration: 1.2, blur: 0.35, brightness: 1.06, saturate: 1.7
    });
  }
  if (on && !glassDock) {
    try {
      glassDock = mountGlassDock(el.glassDock);
      if (glassDock) glassDock.syncLabels();
    } catch (err) {
      console.warn('[凛狐] 液态玻璃工具坞未启用：', err);
    }
  } else if (!on && glassDock) {
    glassDock.destroy();
    glassDock = null;
  }
}

// 设置页或另一个弹窗改了配置：外观、主题图标、服务商、夜间开关跟着变
function onConfigElsewhere(next) {
  const langBefore = currentCfg.uiLang;
  currentCfg = mergeConfig(DEFAULTS, next);
  uiTheme = currentCfg.uiTheme || 'auto';
  applyUiTheme(uiTheme);
  applyUiAppearance(currentCfg);
  syncGlassDock();
  if (currentCfg.uiLang !== langBefore) {
    applyI18n(document, currentCfg.uiLang);
    if (glassDock) {
      glassDock.syncLabels();
      // 标签变了要换一个透镜元素，否则 Chrome 的 backdrop 纹理可能还停在旧语言。
      glassDock.reset();
    }
    render();
  }
  renderThemeToggle();
  renderMeta();
  renderNight();
  renderHover();
  renderMedical();
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
    const opt = document.createElement('option');
    opt.value = style.value;
    opt.textContent = style.label;
    el.styleSelect.appendChild(opt);
  });
  el.styleSelect.value = 'plain';
  // Mac 上是 ⌘+Enter（keydown 里本来就同时认 Ctrl 和 ⌘）：提示放在输入框右侧的键帽里
  el.quickKbd.textContent = KEYS.submit;

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
  renderHover();
  renderMedical();
  // 底部工具坞：折射滤镜 / 透镜动效复用 Liquid Glass Slider（Sak，MIT）。
  // 设置里关掉「液态玻璃」时这里不会挂载，CSS 还原成普通图标栏。
  syncGlassDock();
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
el.styleSelect.addEventListener('change', async () => {
  try {
    status = await sendToTab({ type: 'dt:setStyle', style: el.styleSelect.value });
    stopPolling();
  } catch (err) {
    el.stat.textContent = t('切换失败：') + err.message;
  }
  render();
  if (status && status.busy) startPolling();
});

el.target.addEventListener('change', async () => {
  const target = el.target.value;
  renderQuickTarget();
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
    // 图标短暂变成绿色对勾（按钮里有图标，不能改 textContent）
    el.quickCopy.classList.add('is-copied');
    el.quickCopy.title = t('已复制');
    setTimeout(() => {
      el.quickCopy.classList.remove('is-copied');
      el.quickCopy.title = t('复制结果');
    }, 1500);
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

// 状态卡底部的「服务商 · 模型」：点一下去设置页改
el.heroFoot.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 界面语言一键切换（中文 ⇄ English），和设置页「界面语言」是同一个配置项
el.langToggle.addEventListener('click', async () => {
  const next = currentCfg.uiLang === 'en' ? 'zh' : 'en';
  el.langToggle.disabled = true;
  const saved = await saveAndRemember({ uiLang: next });
  el.langToggle.disabled = false;
  if (!saved) return;
  applyI18n(document, next);
  if (glassDock) {
    glassDock.syncLabels();
    glassDock.reset();
  }
  render();
  renderMeta();
  renderThemeToggle();
  renderNight();
  renderHover();
});

// 使用指南：重新打开首次安装时的欢迎页，不改配置、不触发安装逻辑
el.openGuide.addEventListener('click', () => {
  openWelcomePage().catch(() => {});
});

init();
