// 设置页「OCR」区块：选择引擎、显示本地组件的实际检测结果、申请 nativeMessaging 可选权限、安装说明与重新检测。
// 选择随设置页「保存」一起写入配置（ocrEngine）；状态显示按当前下拉框的值和最近一次检测结果实时计算。
// 判定口径与阅读器共用 lib/ocr/status.js；接口说明见 docs/OCR-INTERFACE.md §6.1。
import { OCR_UI_ENABLED, OCR_COMPONENT_RELEASES } from '../lib/ocr/feature.js';
import { OCR_STATUS, resolveOcr, normalizeOcrChoice } from '../lib/ocr/status.js';
import { getOcrStatus, requestOcrPermission } from '../lib/ocr/page.js';
import { t } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);

export function platformId() {
  const raw = String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  if (raw.includes('mac')) return 'macos';
  if (raw.includes('win')) return 'windows';
  if (raw.includes('linux') || raw.includes('cros')) return 'linux';
  return 'other';
}

const PLATFORM_LABEL = { macos: 'macOS', windows: 'Windows', linux: 'Linux', other: '' };

function backendLabel(id) {
  if (id === 'system') {
    const p = platformId();
    return p === 'macos' ? t('系统 OCR（macOS 文本识别）') : p === 'windows' ? t('系统 OCR（Windows OCR）') : t('系统 OCR');
  }
  if (id === 'paddle') return t('本地 PaddleOCR');
  return id;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.max(1, Math.round(mb)) + ' MB';
}

// 中日韩与英文排在前面：扫描件最常见，也是用户最想确认的几种。
const LANG_PRIORITY = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko'];
function langRank(tag) {
  const lower = tag.toLowerCase();
  const i = LANG_PRIORITY.findIndex((p) => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase() + '-'));
  return i < 0 ? LANG_PRIORITY.length : i;
}

function languageNames(tags, uiLang) {
  if (!tags || !tags.length) return '';
  let names = tags.slice().sort((a, b) => langRank(a) - langRank(b));
  try {
    const dn = new Intl.DisplayNames([uiLang === 'en' ? 'en' : 'zh-CN'], { type: 'language' });
    names = names.map((tag) => { try { return dn.of(tag) || tag; } catch (err) { return tag; } });
  } catch (err) { /* 老浏览器：显示原始标签 */ }
  names = Array.from(new Set(names));
  const shown = names.slice(0, 6).join(uiLang === 'en' ? ', ' : '、');
  return names.length > 6 ? shown + (uiLang === 'en' ? ' and ' + (names.length - 6) + ' more' : ' 等 ' + names.length + ' 种') : shown;
}

// 设置页里的状态标题（阅读器用 ocrNotice，那里要引导「前往设置」，这里不需要）。
const TITLES = {
  ready: '已就绪',
  not_configured: '未配置OCR',
  permission_needed: '需要授权连接本地 OCR 组件',
  component_missing: '未检测到本地 OCR 组件',
  engine_missing: '所选引擎尚未安装',
  model_missing: '所选引擎缺少模型',
  language_unavailable: '所选引擎缺少识别语言',
  incompatible: '本地 OCR 组件版本不兼容，请更新组件',
  unsupported: '当前系统不支持所选 OCR',
  error: '检测失败，可点击「重新检测」重试',
  disabled: 'OCR 已关闭'
};

const NEEDS_INSTALL = new Set([OCR_STATUS.COMPONENT_MISSING, OCR_STATUS.ENGINE_MISSING, OCR_STATUS.MODEL_MISSING]);

export function createOcrSettings({ uiLang } = {}) {
  let saved = 'auto';
  let snapshot = null;
  let checking = null;
  const select = $('ocrEngine');

  if (!OCR_UI_ENABLED || !select) {
    return {
      enabled: false,
      value: () => saved,
      fill(cfg) { saved = normalizeOcrChoice(cfg && cfg.ocrEngine); },
      render() {},
      refresh() { return Promise.resolve(null); }
    };
  }

  $('navOcr').hidden = false;
  $('sec-ocr').hidden = false;
  const lang = () => (typeof uiLang === 'function' ? uiLang() : 'zh');

  function resolved() {
    return snapshot ? resolveOcr(select.value, snapshot.backends) : null;
  }

  function installTarget(r) {
    if (!r) return null;
    const status = r.status === OCR_STATUS.NOT_CONFIGURED ? r.reason : r.status;
    if (!NEEDS_INSTALL.has(status)) return null;
    // 连接器都没装时先装连接器；连接器在、只缺引擎包时装 PaddleOCR。
    if (status === OCR_STATUS.COMPONENT_MISSING) return 'connector';
    return select.value === 'system' ? 'connector' : 'paddle';
  }

  function render() {
    const banner = $('ocrStatus');
    const info = $('ocrComponentInfo');
    if (!snapshot) {
      banner.hidden = true;
      info.textContent = checking ? t('正在检测…') : t('尚未检测。');
      $('ocrGrant').hidden = true;
      $('ocrInstall').hidden = true;
      return;
    }
    const r = resolved();
    const ui = lang();
    banner.hidden = false;
    banner.classList.toggle('ok', r.status === OCR_STATUS.READY);
    banner.classList.toggle('bad', r.status !== OCR_STATUS.READY);
    if (r.status === OCR_STATUS.DISABLED || r.status === OCR_STATUS.NOT_CONFIGURED) banner.dataset.kind = 'warn';
    else delete banner.dataset.kind;
    banner.dataset.ocrStatus = r.status;

    let title = t(TITLES[r.status] || TITLES.error);
    let detail = '';
    if (r.status === OCR_STATUS.READY) {
      const b = snapshot.backends.find((one) => one.id === r.backend) || {};
      title = (select.value === 'auto' ? t('自动选择：') : '') + backendLabel(r.backend) + ' · ' + title;
      const parts = [];
      const names = languageNames(b.languages, ui);
      if (names) parts.push(t('可识别：') + names);
      if (b.devices && b.devices.length) parts.push(t('设备：') + b.devices.map((d) => d.toUpperCase()).join(' / '));
      detail = parts.join(' · ');
    } else if (r.status === OCR_STATUS.NOT_CONFIGURED && r.reason) {
      detail = t(TITLES[r.reason] || '') || '';
    } else if (r.status !== OCR_STATUS.DISABLED) {
      const b = snapshot.backends.find((one) => one.id === select.value);
      if (b && b.message) detail = b.message;
    }
    $('ocrStatusTitle').textContent = title;
    $('ocrStatusDetail').textContent = detail;
    $('ocrStatusDetail').hidden = !detail;

    const native = (snapshot.sources || []).find((s) => s.id === 'native');
    if (native && native.component) {
      info.textContent = t('已连接本地组件') + ' ' + native.component.version;
    } else if (native && native.status === OCR_STATUS.PERMISSION_NEEDED) {
      info.textContent = t('尚未授权连接本地组件。');
    } else {
      info.textContent = t('未连接本地组件。');
    }

    const needsGrant = r.status === OCR_STATUS.PERMISSION_NEEDED || (r.status === OCR_STATUS.NOT_CONFIGURED && r.reason === OCR_STATUS.PERMISSION_NEEDED);
    $('ocrGrant').hidden = !needsGrant || select.value === 'off';
    $('ocrInstall').hidden = !installTarget(r) || select.value === 'off';
  }

  async function refresh(force) {
    const run = getOcrStatus({ refresh: force !== false }).then((snap) => { snapshot = snap; }, () => {
      snapshot = { backends: [], sources: [], status: OCR_STATUS.ERROR };
    });
    checking = run;
    render();
    await run;
    if (checking === run) checking = null;
    render();
    return snapshot;
  }

  async function grant() {
    // 必须在点击 / 选择的用户手势里调用；拒绝时保持「需要授权」，不反复弹出。
    const ok = await requestOcrPermission();
    if (ok) await refresh(true);
    else render();
    return ok;
  }

  function openInstall() {
    const target = installTarget(resolved()) || 'connector';
    const platform = platformId();
    const urls = OCR_COMPONENT_RELEASES[platform] || {};
    const url = urls[target] || '';
    const backend = target === 'paddle' && snapshot ? snapshot.backends.find((b) => b.id === 'paddle') : null;
    $('ocrInstallTitle').textContent = target === 'paddle' ? t('安装本地 PaddleOCR') : t('安装本地 OCR 组件');
    $('ocrInstallPlatform').textContent = PLATFORM_LABEL[platform] || t('未知平台');
    $('ocrInstallSize').textContent = formatBytes(backend && backend.downloadBytes) || t('以发布页为准');
    $('ocrInstallDisk').textContent = formatBytes(backend && backend.diskBytes) || t('以发布页为准');
    $('ocrInstallNote').textContent = url ? '' : t('当前平台的安装包尚未发布。开发者可按仓库 native/ocr-host 的说明自行构建。');
    const download = $('ocrInstallDownload');
    download.disabled = !url;
    download.onclick = () => {
      if (!url) return;
      chrome.tabs.create({ url });
      $('ocrInstallDialog').close('download');
      render();
    };
    $('ocrInstallDialog').showModal();
  }

  select.addEventListener('change', () => {
    const r = resolved();
    const needsGrant = r && (r.status === OCR_STATUS.PERMISSION_NEEDED ||
      (r.status === OCR_STATUS.NOT_CONFIGURED && r.reason === OCR_STATUS.PERMISSION_NEEDED));
    if (needsGrant && (select.value === 'system' || select.value === 'paddle')) grant();
    else render();
  });
  $('ocrGrant').addEventListener('click', () => { grant(); });
  $('ocrInstall').addEventListener('click', openInstall);
  $('ocrRecheck').addEventListener('click', () => { refresh(true); });
  $('ocrInstallDialog').addEventListener('close', () => { if ($('ocrInstallDialog').returnValue === 'download') refresh(true); });

  return {
    enabled: true,
    value: () => normalizeOcrChoice(select.value),
    fill(cfg) {
      saved = normalizeOcrChoice(cfg && cfg.ocrEngine);
      select.value = saved;
      render();
    },
    render,
    refresh
  };
}
