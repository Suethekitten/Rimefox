// 设置页「OCR」区块：选择引擎、显示本地组件的实际检测结果、申请 nativeMessaging 可选权限、安装说明与重新检测。
// 选择随设置页「保存」一起写入配置（ocrEngine）；状态显示按当前下拉框的值和最近一次检测结果实时计算。
// 判定口径与阅读器共用 lib/ocr/status.js；接口说明见 docs/OCR-INTERFACE.md §6.1。
import { OCR_UI_ENABLED, OCR_COMPONENT_RELEASES, systemOcrPreviewChoice, verifiedOcrRelease } from '../lib/ocr/feature.js';
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

export function createOcrSettings({ uiLang } = {}) {
  let saved = 'system';
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
  $('ocrExtensionId').value = chrome.runtime.id;
  const lang = () => (typeof uiLang === 'function' ? uiLang() : 'zh');

  function resolved() {
    return snapshot ? resolveOcr(systemOcrPreviewChoice(select.value), snapshot.backends) : null;
  }

  function installTarget(r) {
    if (!r) return null;
    const status = r.status === OCR_STATUS.NOT_CONFIGURED ? r.reason : r.status;
    return status === OCR_STATUS.DISABLED ? null : 'connector';
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
      title = backendLabel(r.backend) + ' · ' + title;
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
    const system = snapshot.backends.find((one) => one.id === 'system');
    $('ocrLanguageList').hidden = !(system && system.languages && system.languages.length);
    $('ocrLanguageTags').textContent = system && system.languages ? system.languages.join(' · ') : '';
    const noChinese = platformId() === 'windows' && system &&
      (system.status === OCR_STATUS.LANGUAGE_UNAVAILABLE || (system.status === OCR_STATUS.READY && !(system.languages || []).some(tag => /^zh(?:-|$)/i.test(tag))));
    $('ocrLanguageHelp').hidden = !noChinese;
    $('ocrLanguageHelp').textContent = noChinese ? t('尚未检测到中文 OCR 语言包。请打开 Windows 设置 → 时间和语言 → 语言和区域，添加简体或繁体中文及其 OCR 可选功能，再点击「重新检测」。可能需要管理员协助，凛狐不会代为安装。') : '';

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
      snapshot = { backends: [{ id: 'system', status: OCR_STATUS.ERROR }], sources: [], status: OCR_STATUS.ERROR };
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
    const platform = platformId();
    const release = verifiedOcrRelease(OCR_COMPONENT_RELEASES[platform]);
    const url = release ? release.connector : '';
    $('ocrInstallTitle').textContent = t('安装系统 OCR 预览组件');
    $('ocrInstallPlatform').textContent = PLATFORM_LABEL[platform] || t('未知平台');
    $('ocrInstallSize').textContent = formatBytes(release && release.downloadBytes) || t('尚未发布');
    $('ocrInstallDisk').textContent = formatBytes(release && release.diskBytes) || t('以预览包说明为准');
    $('ocrInstallNote').textContent = url ? t('下载后先按预览包说明核对 SHA-256，再安装。') : t('当前平台的预览组件尚未发布。请仅使用维护者提供的完整预览包及校验值；没有预览包时请保持 OCR 关闭。');
    const steps = $('ocrInstallSteps'); steps.textContent = '';
    const instructions = platform === 'windows' ? [
      '解压完整 Windows 预览包，核对校验值后运行 install.ps1，填写上方的扩展 ID。无需管理员权限。',
      'Windows 可能拦截未签名组件；请阅读预览包说明和系统提示，凛狐不会自动绕过安全保护。'
    ] : platform === 'macos' ? [
      '解压完整 macOS 预览包，核对校验值后按包内说明运行 install.sh，填写上方的扩展 ID。组件安装到用户 Library。',
      'macOS 可能拦截未公证组件；仅在确认来源和校验值后，按系统「隐私与安全性」中的单个程序提示处理。不要关闭 Gatekeeper。'
    ] : ['当前平台没有系统 OCR 预览组件，请保持 OCR 关闭。'];
    instructions.push('安装后回到此页，授权连接本地组件并点击「重新检测」。');
    for (const instruction of instructions) { const li = document.createElement('li'); li.textContent = t(instruction); steps.appendChild(li); }
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
    if (needsGrant && select.value === 'system') grant();
    else render();
  });
  $('ocrGrant').addEventListener('click', () => { grant(); });
  $('ocrInstall').addEventListener('click', openInstall);
  $('ocrRecheck').addEventListener('click', () => { refresh(true); });
  $('ocrInstallDialog').addEventListener('close', () => { if ($('ocrInstallDialog').returnValue === 'download') refresh(true); });

  return {
    enabled: true,
    value: () => systemOcrPreviewChoice(select.value),
    fill(cfg) {
      saved = systemOcrPreviewChoice(cfg && cfg.ocrEngine);
      select.value = saved;
      render();
    },
    render,
    refresh
  };
}
