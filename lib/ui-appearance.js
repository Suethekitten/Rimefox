// 设置页 / 弹窗共用的界面外观：强调色、减少透明、关闭阴影、深色切换动画、跨页面同步、空闲执行。
// 只在扩展自己的页面用（可信上下文）；网页里的译文外观在 content/appearance.js。
import { accentHex, isDefaultAccent } from './appearance.js';

const LOOK_KEY = 'dt.uiLook';

// 强调色等写到 <html> 上；CSS 里所有 hover / soft / glow 都由 --accent-user 用 color-mix 派生
export function applyUiAppearance(cfg, root) {
  const el = root || document.documentElement;
  const c = cfg || {};
  const look = {};
  if (isDefaultAccent(c.accentColor)) {
    delete el.dataset.accent;
    el.style.removeProperty('--accent-user');
  } else {
    look.accent = accentHex(c.accentColor);
    el.dataset.accent = 'custom';
    el.style.setProperty('--accent-user', look.accent);
  }
  look.rt = !!c.reduceTransparency;
  look.ns = !!c.disableShadow;
  el.toggleAttribute('data-reduce-transparency', look.rt);
  el.toggleAttribute('data-no-shadow', look.ns);
  // 首帧预判用（lib/ui-theme-boot.js）：读配置之前先按上次的取值上色
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch (err) {
    /* 存储不可用就等配置读回来再上色 */
  }
}

// 切换深浅色：支持 View Transition 时从按钮位置圆形扩散；不支持 / 用户要求减少动态时直接切
export function switchThemeAnimated(apply, origin) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce) {
    apply();
    return;
  }
  const rect = origin && origin.getBoundingClientRect ? origin.getBoundingClientRect() : null;
  const x = rect ? rect.left + rect.width / 2 : innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] },
        { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)', pseudoElement: '::view-transition-new(root)' }
      );
    })
    .catch(() => {});
}

// 另一个页面改了配置（弹窗切深色、设置页保存）时通知这里。
// lastRaw 记住自己最近写进去的值：自己保存触发的 onChanged 不再回调，避免回写循环
let lastRaw = '';
export function rememberSaved(cfg) {
  try {
    lastRaw = JSON.stringify(cfg);
  } catch (err) {
    lastRaw = '';
  }
}

export function watchConfig(handler) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return () => {};
  const listener = (changes, area) => {
    // 扩展被重新加载后，旧页面里的回调会抛 Extension context invalidated：直接摘掉
    if (!chrome.runtime || !chrome.runtime.id) {
      chrome.storage.onChanged.removeListener(listener);
      return;
    }
    if (area !== 'local' || !changes.config) return;
    const next = changes.config.newValue;
    let raw = '';
    try {
      raw = JSON.stringify(next);
    } catch (err) {
      raw = '';
    }
    if (!next || raw === lastRaw) return;
    lastRaw = raw;
    handler(next);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// 非首屏的工作（模型列表、缓存统计、快捷键检测）放到空闲时做，打开页面不卡
export function runWhenIdle(fn, timeout) {
  const limit = timeout || 1500;
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout: limit });
  } else {
    setTimeout(fn, 1);
  }
}
