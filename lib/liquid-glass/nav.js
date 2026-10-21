// 设置页左侧导航的竖向液态玻璃透镜。
// 复用并改编自 Sak（@Saknutella）的 Liquid Glass Slider（MIT）：
// https://github.com/Saknutella/liquid-glass-slider
// 与弹窗工具坞共用 material.js 的位移滤镜；这里只负责竖向槽位、悬停预览和弹簧。
// 许可见仓库根目录 THIRD-PARTY-NOTICES.md。

import { clamp, navTop } from './geometry.js';
import { createGlassMaterial } from './material.js';

const DEFAULTS = {
  expand: 2.5,
  spring: { stiffness: 320, damping: 28 },
  press: { stiffness: 700, damping: 42 },
  respectReducedMotion: true
};

function readConfig(nav, options) {
  let custom = {};
  try {
    custom = JSON.parse(nav.dataset.glassConfig || '{}') || {};
  } catch (err) {
    custom = {};
  }
  if (options.config) Object.assign(custom, options.config);
  const config = Object.assign({}, DEFAULTS, custom);
  config.spring = Object.assign({}, DEFAULTS.spring, custom.spring || {});
  config.press = Object.assign({}, DEFAULTS.press, custom.press || {});
  return config;
}

export function mountGlassNav(nav, options = {}) {
  if (!nav || nav.dataset.glassNav === 'mounted') return null;
  const items = [...nav.querySelectorAll(':scope > .nav-item')];
  if (!items.length) return null;

  nav.dataset.glassNav = 'mounted';
  const config = readConfig(nav, options);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const ac = new AbortController();
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, Object.assign({ signal: ac.signal }, opts || {}));
  };

  let lens = nav.querySelector(':scope > .glass-nav__thumb');
  if (!lens) {
    lens = document.createElement('span');
    lens.className = 'glass-nav__thumb';
    lens.setAttribute('aria-hidden', 'true');
    nav.prepend(lens);
  }
  const material = createGlassMaterial(nav, lens, { base: false });

  let step = 1;
  let padTop = 0;
  let padLeft = 0;
  let trackWidth = 1;
  let baseHeight = 1;
  let itemRadius = 9;

  let y = 0;
  let vy = 0;
  let target = 0;
  let press = 0;
  let vPress = 0;
  let hoverIndex = -1;
  let focusIndex = -1;
  let activeIndex = Math.max(0, items.findIndex((item) => item.classList.contains('is-active')));
  let pressing = false;
  let frame = 0;
  let lastTime = 0;
  let lensBuiltW = 0;
  let lensBuiltH = 0;

  const topFor = (index) => navTop(index, step, padTop);

  const paint = () => {
    const margin = config.expand * clamp(press, 0, 1);
    const width = trackWidth + margin * 2;
    const height = baseHeight + margin * 2;
    const left = padLeft - margin;
    const top = y - margin;
    lens.style.left = left.toFixed(2) + 'px';
    lens.style.top = top.toFixed(2) + 'px';
    lens.style.width = width.toFixed(2) + 'px';
    lens.style.height = height.toFixed(2) + 'px';
    lens.style.borderRadius = (itemRadius + margin).toFixed(2) + 'px';
    if (Math.abs(width - lensBuiltW) > 6 || Math.abs(height - lensBuiltH) > 6) {
      lensBuiltW = width;
      lensBuiltH = height;
      material.resizeLens(width, height, itemRadius + margin);
    }
    nav.dataset.state = pressing ? 'pressed' : (frame ? 'settling' : 'idle');
  };

  const tick = (time) => {
    const dt = Math.min((time - (lastTime || time - 16.67)) / 1000, 0.032);
    lastTime = time;
    const expandGoal = pressing ? 1 : 0;
    const reduced = config.respectReducedMotion && reducedMotion.matches;
    if (reduced) {
      y = target;
      vy = 0;
      press = expandGoal;
      vPress = 0;
      paint();
      frame = 0;
      lastTime = 0;
      return;
    }
    const h = dt / 6;
    for (let i = 0; i < 6; i++) {
      vy += ((target - y) * config.spring.stiffness - vy * config.spring.damping) * h;
      y += vy * h;
      vPress += ((expandGoal - press) * config.press.stiffness - vPress * config.press.damping) * h;
      press += vPress * h;
    }
    paint();
    const settled = Math.abs(target - y) < 0.3 && Math.abs(vy) < 1.5
      && Math.abs(press - expandGoal) < 0.006 && Math.abs(vPress) < 0.05;
    if (settled) {
      frame = 0;
      lastTime = 0;
      y = target;
      vy = 0;
      press = expandGoal;
      vPress = 0;
      paint();
    } else {
      frame = requestAnimationFrame(tick);
    }
  };

  const animate = () => {
    if (!frame) {
      lastTime = 0;
      frame = requestAnimationFrame(tick);
    }
  };

  const syncTarget = () => {
    const index = hoverIndex >= 0 ? hoverIndex : focusIndex >= 0 ? focusIndex : activeIndex;
    if (index < 0 || index >= items.length) return;
    target = topFor(index);
    animate();
  };

  const setActive = (index) => {
    if (index < 0 || index >= items.length) return;
    activeIndex = index;
    if (hoverIndex < 0 && focusIndex < 0) {
      target = topFor(activeIndex);
      animate();
    }
  };

  const indexOf = (item) => items.indexOf(item);

  const measure = () => {
    const style = getComputedStyle(nav);
    padTop = parseFloat(style.paddingTop) || 0;
    padLeft = parseFloat(style.paddingLeft) || 0;
    trackWidth = nav.clientWidth - padLeft - (parseFloat(style.paddingRight) || 0);
    baseHeight = items[0].offsetHeight;
    const gap = parseFloat(style.rowGap) || 0;
    step = baseHeight + gap;
    itemRadius = parseFloat(getComputedStyle(items[0]).borderTopLeftRadius) || 9;
    lens.style.left = padLeft + 'px';
    lens.style.top = '0px';
    lens.style.width = trackWidth + 'px';
    lens.style.height = baseHeight + 'px';
    lens.style.borderRadius = itemRadius + 'px';
    lensBuiltW = trackWidth;
    lensBuiltH = baseHeight;
    y = target = topFor(activeIndex);
    vy = 0;
    press = 0;
    vPress = 0;
    material.resize();
    paint();
  };

  on(nav, 'pointerover', (event) => {
    const item = event.target.closest('.nav-item');
    if (!item || !items.includes(item)) return;
    const index = indexOf(item);
    if (index === hoverIndex) return;
    hoverIndex = index;
    syncTarget();
  });
  on(nav, 'pointerleave', () => {
    pressing = false;
    hoverIndex = -1;
    syncTarget();
  });
  on(nav, 'pointerdown', (event) => {
    const item = event.target.closest('.nav-item');
    if (!item || !items.includes(item) || event.button !== 0) return;
    hoverIndex = indexOf(item);
    pressing = true;
    syncTarget();
  });
  on(nav, 'pointerup', () => {
    pressing = false;
    animate();
  });
  on(nav, 'pointercancel', () => {
    pressing = false;
    animate();
  });
  on(nav, 'focusin', (event) => {
    const item = event.target.closest('.nav-item');
    if (!item || !items.includes(item)) return;
    focusIndex = indexOf(item);
    syncTarget();
  });
  on(nav, 'focusout', (event) => {
    if (nav.contains(event.relatedTarget)) return;
    focusIndex = -1;
    syncTarget();
  });
  on(nav, 'keydown', (event) => {
    const item = event.target.closest('.nav-item');
    if (!item || !items.includes(item)) return;
    const index = indexOf(item);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  });
  on(window, 'blur', () => {
    pressing = false;
    animate();
  });

  const resizeObserver = new ResizeObserver(() => measure());
  resizeObserver.observe(nav);
  reducedMotion.addEventListener('change', () => animate());
  measure();

  return {
    element: nav,
    refresh: measure,
    setActive: setActive,
    destroy() {
      ac.abort();
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      material.destroy();
      lens.remove();
      nav.removeAttribute('data-glass-nav');
      nav.removeAttribute('data-state');
    }
  };
}
