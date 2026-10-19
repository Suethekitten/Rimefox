// 欢迎页 / 新手引导的交互层。
// 只读配置来决定语言、主题和外观；只有用户主动点语言 / 主题按钮，或新安装
// 需要把浏览器语言记为初始界面语言时，才保存对应字段；不会清空配置，
// 也不会重新触发 onInstalled。
import { DEFAULTS, mergeConfig, saveConfig } from '../lib/config.js';
import { applyI18n, t } from '../lib/i18n.js';
import { applyUiAppearance, rememberSaved, switchThemeAnimated, watchConfig } from '../lib/ui-appearance.js';
import { hasSavedUiLang, pickWelcomeLang } from '../lib/welcome.js';

const root = document.documentElement;
const hasChrome = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);

const panels = Array.from(document.querySelectorAll('.panel'));
const stepButtons = Array.from(document.querySelectorAll('.step-btn'));
const dots = Array.from(document.querySelectorAll('.progress-dots .dot'));
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const langToggle = document.getElementById('langToggle');
const themeToggle = document.getElementById('themeToggle');
const openSettingsBtn = document.getElementById('openSettings');
const finishSettingsBtn = document.getElementById('finishSettings');
const versionLine = document.getElementById('versionLine');
const versionText = document.getElementById('version');
const toast = document.getElementById('toast');

const state = {
  lang: 'zh',
  cfg: null,
  step: 0,
  toastTimer: 0
};

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function browserLang() {
  const list = navigator.languages;
  return (list && list[0]) || navigator.language || 'en';
}

// ---------------- 主题 ----------------
function applyTheme(value) {
  if (value === 'light' || value === 'dark') {
    root.dataset.theme = value;
    root.style.colorScheme = value;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = '';
  }
  // 首帧预判用（lib/ui-theme-boot.js）；auto 时清掉缓存，交给系统偏好
  try {
    if (value === 'light' || value === 'dark') localStorage.setItem('dt.uiTheme', value);
    else localStorage.removeItem('dt.uiTheme');
  } catch (err) {
    /* 存储不可用就退化为 prefers-color-scheme */
  }
}

function currentTheme() {
  if (root.dataset.theme === 'light' || root.dataset.theme === 'dark') return root.dataset.theme;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeButton() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  themeToggle.dataset.next = next;
  themeToggle.setAttribute('aria-label', t(next === 'dark' ? '切换到深色' : '切换到浅色'));
}

// ---------------- 语言 ----------------
function applyLanguage(lang) {
  state.lang = lang === 'en' ? 'en' : 'zh';
  // 语言切换时丢掉上一语言的提示，避免 toast 停留在旧语言
  clearTimeout(state.toastTimer);
  toast.classList.remove('is-on');
  applyI18n(document, state.lang);

  // 语言名本身不翻译；按钮显示「点了会切到哪种语言」
  langToggle.textContent = state.lang === 'en' ? '中文' : 'English';
  langToggle.setAttribute(
    'aria-label',
    t(state.lang === 'en' ? '切换界面语言为中文' : '切换界面语言为英文')
  );
  updateThemeButton();
}

// ---------------- 提示 ----------------
function showToast(message) {
  if (!message) return;
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add('is-on');
  state.toastTimer = setTimeout(() => {
    toast.classList.remove('is-on');
  }, 2600);
}

// ---------------- 步骤切换 ----------------
// 窄屏下步骤条是横向滚动的：切到第 4 步时把它滚进可视区，
// 否则当前步骤可能完全在屏幕外。
function revealStep(index) {
  const rail = document.querySelector('.steps');
  const button = stepButtons[index];
  if (!rail || !button || rail.scrollWidth <= rail.clientWidth + 2) return;
  const box = button.getBoundingClientRect();
  const view = rail.getBoundingClientRect();
  const delta = box.left - view.left - (view.width - box.width) / 2;
  if (Math.abs(delta) > 2) {
    rail.scrollBy({ left: delta, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

function goToStep(index, options) {
  const last = panels.length - 1;
  const next = Math.max(0, Math.min(last, Number(index) || 0));
  state.step = next;

  panels.forEach((panel, i) => {
    panel.hidden = i !== next;
    panel.classList.toggle('is-active', i === next);
  });
  stepButtons.forEach((button, i) => {
    if (i === next) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  dots.forEach((dot, i) => dot.classList.toggle('is-on', i === next));
  revealStep(next);

  prevBtn.disabled = next === 0;
  // 最后一步的操作放在正文里的「完成引导 / 查看详细文档」卡片里，
  // 底部分页不再重复一个同样显眼的按钮。
  nextBtn.hidden = next === last;

  if (options && options.focus) {
    const heading = panels[next].querySelector('h1, h2');
    if (heading) heading.focus({ preventScroll: true });
  }
  if (options && options.scroll) {
    panels[next].scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

function bindStepKeys() {
  stepButtons.forEach((button, index) => {
    button.addEventListener('keydown', (event) => {
      let target = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (index + 1) % stepButtons.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (index - 1 + stepButtons.length) % stepButtons.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = stepButtons.length - 1;
      if (target == null) return;
      event.preventDefault();
      stepButtons[target].focus();
      goToStep(target, { scroll: true });
    });
  });
}

// ---------------- 打开设置 ----------------
function openSettings() {
  if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.openOptionsPage !== 'function') {
    showToast(t('请在扩展环境中打开设置页。'));
    return;
  }
  try {
    const result = chrome.runtime.openOptionsPage();
    if (result && typeof result.then === 'function') {
      result.then(
        () => showToast(t('已打开设置页')),
        () => showToast(t('无法打开设置页，请从扩展菜单进入。'))
      );
    } else {
      showToast(t('已打开设置页'));
    }
  } catch (err) {
    showToast(t('无法打开设置页，请从扩展菜单进入。'));
  }
}

// ---------------- 配置读取 / 同步 ----------------
async function readStoredConfig() {
  if (!hasChrome) return { stored: {}, cfg: mergeConfig(DEFAULTS, {}) };
  try {
    const got = await chrome.storage.local.get('config');
    const stored = (got && got.config) || {};
    return { stored: stored, cfg: mergeConfig(DEFAULTS, stored) };
  } catch (err) {
    return { stored: {}, cfg: mergeConfig(DEFAULTS, {}) };
  }
}

async function persist(patch) {
  if (!hasChrome) return;
  try {
    const next = await saveConfig(patch);
    state.cfg = next;
    rememberSaved(next);
  } catch (err) {
    /* 设置写不进去时，本页的语言 / 主题仍然生效 */
  }
}

function onConfigElsewhere(next) {
  const merged = mergeConfig(DEFAULTS, next || {});
  state.cfg = merged;
  applyUiAppearance(merged);
  applyTheme(merged.uiTheme || 'auto');
  updateThemeButton();
  const lang = pickWelcomeLang(next || {}, browserLang());
  if (lang !== state.lang) applyLanguage(lang);
}

// ---------------- 事件 ----------------
function bindEvents() {
  stepButtons.forEach((button, index) => {
    button.addEventListener('click', () => {
      goToStep(index, { focus: true, scroll: true });
    });
  });
  bindStepKeys();

  document.querySelectorAll('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => {
      goToStep(Number(button.dataset.goto), { focus: true, scroll: true });
    });
  });

  prevBtn.addEventListener('click', () => {
    goToStep(state.step - 1, { focus: true, scroll: true });
  });
  nextBtn.addEventListener('click', () => {
    if (state.step >= panels.length - 1) openSettings();
    else goToStep(state.step + 1, { focus: true, scroll: true });
  });

  langToggle.addEventListener('click', async () => {
    const next = state.lang === 'en' ? 'zh' : 'en';
    applyLanguage(next);
    showToast(next === 'en' ? t('界面语言已切换为英文') : t('界面语言已切换为中文'));
    await persist({ uiLang: next });
  });

  themeToggle.addEventListener('click', async () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    switchThemeAnimated(() => applyTheme(next), themeToggle);
    updateThemeButton();
    await persist({ uiTheme: next });
  });

  openSettingsBtn.addEventListener('click', openSettings);
  finishSettingsBtn.addEventListener('click', openSettings);

  if (typeof matchMedia === 'function') {
    const media = matchMedia('(prefers-color-scheme: dark)');
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', updateThemeButton);
    }
  }
}

// ---------------- 启动 ----------------
async function init() {
  const { stored, cfg } = await readStoredConfig();
  state.cfg = cfg;

  applyTheme(cfg.uiTheme || 'auto');
  applyUiAppearance(cfg);
  const initialLang = pickWelcomeLang(stored, browserLang());
  applyLanguage(initialLang);

  try {
    const version = chrome.runtime.getManifest().version;
    versionText.textContent = 'v' + version;
    versionLine.hidden = false;
  } catch (err) {
    /* 不在扩展环境（例如直接打开 HTML 预览）就不显示版本 */
  }

  // 新安装还没有 uiLang 时，把按浏览器语言选出的初始值记下来：
  // 否则欢迎页可能显示英文，而设置页按默认值显示中文。
  if (!hasSavedUiLang(stored) && initialLang !== DEFAULTS.uiLang) {
    await persist({ uiLang: initialLang });
  }

  bindEvents();
  goToStep(0, {});
  watchConfig(onConfigElsewhere);

  // 语言和主题应用完再显示，避免英文用户先看到一帧中文
  root.setAttribute('data-ready', '');
}

init().catch(() => {
  // 初始化失败也让页面可见（CSS 里还有 0.5s 的兜底显示），不把用户卡在空白页
  root.setAttribute('data-ready', '');
});
