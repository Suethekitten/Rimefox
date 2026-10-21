// 液态玻璃工具坞：把弹窗底部的 5 个动作按钮包成一条会折射的玻璃条。
// 布局 / 滤镜 / 弹簧均复用并改编自 Sak（@Saknutella）的 Liquid Glass Slider（MIT）：
// https://github.com/Saknutella/liquid-glass-slider
// 与上游不同的地方：这里是一组「命令」而不是单选导航，所以没有常驻选中项——
// 透镜在悬停 / 键盘聚焦时滑到对应按钮，按下放大、拖动拉伸，松手回弹；
// 拖动跨过按钮不会触发任何命令（清缓存这类动作不能被误触）。
// 许可见仓库根目录 THIRD-PARTY-NOTICES.md。

import { clamp, slotPosition, rubberBand, slotAt } from './geometry.js';
import { createGlassMaterial } from './material.js';

const DEFAULTS = {
  hoverPress: 0.45,
  hoverExpand: 0.5,
  lensSlots: 1.75,
  coverThreshold: 0.85,
  pressThreshold: 0.2,
  magnify: 0.1,
  magnifyLift: 2,
  magnifyReach: { width: 0.9, slot: 0.75 },
  magnifyEnergy: 0.9,
  dragThreshold: 4,
  verticalLock: 8,
  lightLerp: 0.18,
  substeps: 6,
  maxFrameDt: 0.032,
  speedRef: 6.5,
  speedClamp: 1.15,
  signedRef: 5,
  jumpRef: 3,
  respectReducedMotion: true,
  settled: {
    position: 0.3, velocity: 1.5, pressV: 0.05, growV: 0.05, expandV: 0.05,
    bounce: 0.02, bounceV: 0.1, grow: 0.003, expand: 0.003
  },
  restSlack: 0.25,
  overshoot: 0.08,
  squashLeft: 0.17,
  squashRight: 0.15,
  lean: 1.2,
  surge: 0.12,
  settleSquashLeft: 0.09,
  settleSquashRight: 0.07,
  inertia: { projectX: 0.16, projectV: 0.12, kick: 0.35, bounce: 3, maxKick: 14 },
  drag: { stiffness: 900, damping: 52 },
  settle: { stiffness: 300, damping: 26, zetaMin: 0.55, zetaSlope: 3.2, zetaMax: 0.92 },
  pressDown: { stiffness: 760, damping: 46 },
  pressUp: { stiffness: 280, damping: 26 },
  growOut: { stiffness: 300, damping: 24 },
  growBack: { stiffness: 520, damping: 34 },
  expandOut: { stiffness: 320, damping: 28 },
  expandBack: { stiffness: 480, damping: 32 },
  bounce: { stiffness: 200, damping: 11 }
};

const TUNED = [
  'drag', 'settle', 'pressDown', 'pressUp', 'growOut', 'growBack',
  'expandOut', 'expandBack', 'bounce', 'inertia', 'magnifyReach', 'settled'
];

function readConfig(bar, options) {
  let custom = {};
  try {
    custom = JSON.parse(bar.dataset.glassConfig || '{}') || {};
  } catch (err) {
    custom = {};
  }
  if (options.config) Object.assign(custom, options.config);
  const config = Object.assign({}, DEFAULTS, custom);
  TUNED.forEach((key) => {
    config[key] = Object.assign({}, DEFAULTS[key], custom[key] || {});
  });
  return config;
}

export function mountGlassDock(bar, options = {}) {
  if (!bar || bar.dataset.glassDock === 'mounted') return null;
  const items = [...bar.querySelectorAll(':scope > button')];
  if (!items.length) return null;

  bar.dataset.glassDock = 'mounted';
  bar.style.setProperty('--glass-slots', String(items.length));
  const slots = items.map((item, index) => index);
  const config = readConfig(bar, options);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const ac = new AbortController();
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, Object.assign({ signal: ac.signal }, opts || {}));
  };

  // 透镜与选中色副本：副本裁在透镜轮廓里，只让被盖住的图标变成强调色。
  let lens = bar.querySelector(':scope > .glass-dock__thumb');
  if (!lens) {
    lens = document.createElement('span');
    lens.className = 'glass-dock__thumb';
    lens.setAttribute('aria-hidden', 'true');
    lens.dataset.glassDockPart = 'thumb';
    bar.append(lens);
  }
  const tint = document.createElement('div');
  tint.className = 'glass-dock__tint';
  tint.setAttribute('aria-hidden', 'true');
  tint.inert = true;
  const tinted = new Map();
  items.forEach((item, index) => {
    const copy = item.cloneNode(true);
    copy.removeAttribute('id');
    copy.removeAttribute('aria-label');
    copy.removeAttribute('title');
    copy.tabIndex = -1;
    copy.classList.add('glass-dock__copy');
    copy.style.gridColumn = String(index + 1);
    tint.append(copy);
    tinted.set(item, copy);
  });
  bar.append(tint);

  const syncLabels = () => {
    items.forEach((item) => {
      const copy = tinted.get(item);
      if (!copy) return;
      copy.className = item.className + ' glass-dock__copy';
      const from = item.querySelector('span');
      const to = copy.querySelector('span');
      if (from && to && from.textContent !== to.textContent) to.textContent = from.textContent;
    });
  };
  syncLabels();

  let material = createGlassMaterial(bar, lens);

  let step = 1;
  let trackWidth = 1;
  let trackHeight = 1;
  let baseWidth = 1;
  let baseHeight = 1;
  let maxGrow = 1.38;
  let padTop = 0;
  let padLeft = 0;

  let x = 0;
  let vx = 0;
  let target = 0;
  let press = 0;
  let vPress = 0;
  let grow = 0;
  let vGrow = 0;
  let expand = 0;
  let vExpand = 0;
  let lensProtrude = 8;

  let bounce = 0;
  let vBounce = 0;
  let lightX = 26;

  let hoverSlot = -1;
  let focusSlot = -1;
  let activeSlot = -1;
  let gesture = null;
  let settling = false;
  let suppressClick = false;
  let frame = 0;
  let lastTime = 0;
  let lastFilter = '';
  let lensRadius = 1;
  let lensBuiltW = 0;
  let lensBuiltH = 0;
  let lensBuiltAt = 0;
  let jumpSpan = 0;
  let jumpDir = 0;
  let lastTarget = 0;
  let lastPointerX = 0;

  const slotFor = (slot) => slotPosition(slot, step, baseWidth);
  const maxSlotPosition = () => slotFor(slots[slots.length - 1]);

  const paint = () => {
    const reduced = config.respectReducedMotion && reducedMotion.matches;
    const speed = reduced ? 0 : clamp(vx / (step * config.speedRef), -config.speedClamp, config.speedClamp);
    const barHeight = bar.clientHeight;
    const margin = Math.max(0, (barHeight + lensProtrude * 2 - baseHeight) / 2);
    const clickWidth = baseWidth + margin * 2;
    const clickHeight = baseHeight + margin * 2;
    const dragWidth = Math.min(step * config.lensSlots, baseWidth * (1 + maxGrow), trackWidth * 1.02);
    const pressWidth = baseWidth + (clickWidth - baseWidth) * expand;
    const layoutWidth = pressWidth + (dragWidth - clickWidth) * grow * expand;
    const layoutHeight = baseHeight + (clickHeight - baseHeight) * expand;

    const signed = reduced ? 0 : clamp(vx / (step * config.signedRef), -1, 1);
    const rightSpeed = Math.max(0, signed);
    const leftSpeed = Math.max(0, -signed);
    const jumpFactor = clamp(jumpSpan / (step * config.jumpRef), 0, 1);
    const settleSquash = reduced || gesture || !settling ? 0
      : jumpDir > 0 ? -jumpFactor * config.settleSquashRight
        : jumpDir < 0 ? jumpFactor * config.settleSquashLeft : 0;
    const squash = reduced ? 1 : 1 + leftSpeed * config.squashLeft - rightSpeed * config.squashRight - bounce * 0.02 + settleSquash;
    const lean = reduced ? 0 : signed * config.lean;
    const surge = reduced ? 0 : signed * layoutWidth * config.surge * expand;

    const visualWidth = layoutWidth;
    const visualHeight = layoutHeight * squash;
    const overshoot = trackWidth * config.overshoot;
    const grown = !reduced && (expand > 0.02 || grow > 0.02 || layoutWidth > baseWidth + 1 || layoutHeight > baseHeight + 1);
    const lensCenter = x + baseWidth / 2;
    const desiredVisualLeft = lensCenter - visualWidth / 2 + surge;
    const visualLeft = grown
      ? clamp(desiredVisualLeft, -overshoot, trackWidth - visualWidth + overshoot)
      : clamp(desiredVisualLeft, 0, Math.max(0, trackWidth - visualWidth));
    const layoutLeft = visualLeft + (visualWidth - layoutWidth) / 2;
    const visualTop = (trackHeight - visualHeight) / 2;
    lensRadius = layoutHeight / 2;

    lens.style.width = layoutWidth.toFixed(2) + 'px';
    lens.style.height = layoutHeight.toFixed(2) + 'px';
    lens.style.top = (padTop + (trackHeight - layoutHeight) / 2).toFixed(2) + 'px';
    lens.style.borderRadius = lensRadius.toFixed(2) + 'px';
    bar.style.setProperty('--drag-x', layoutLeft.toFixed(2) + 'px');
    bar.style.setProperty('--press', clamp(press, 0, 1).toFixed(4));
    bar.style.setProperty('--squash', squash.toFixed(4));
    bar.style.setProperty('--lean', lean.toFixed(2) + 'deg');
    bar.style.setProperty('--light-x', lightX.toFixed(1) + '%');
    bar.toggleAttribute('data-active', activeSlot >= 0);

    const refraction = material.filter;
    if (refraction !== lastFilter) {
      if (refraction) lens.style.setProperty('--thumb-refraction', refraction);
      else lens.style.removeProperty('--thumb-refraction');
      lastFilter = refraction;
    }
    if (material) {
      const now = performance.now();
      if ((Math.abs(layoutWidth - lensBuiltW) > 10 || Math.abs(layoutHeight - lensBuiltH) > 10)
        && now - lensBuiltAt > 70) {
        lensBuiltW = layoutWidth;
        lensBuiltH = layoutHeight;
        lensBuiltAt = now;
        material.resizeLens(layoutWidth, layoutHeight);
      }
    }

    tint.style.clipPath =
      'inset(' + visualTop.toFixed(2) + 'px ' + (trackWidth - visualLeft - visualWidth).toFixed(2) + 'px ' +
      visualTop.toFixed(2) + 'px ' + visualLeft.toFixed(2) + 'px round ' +
      (lensRadius * squash).toFixed(2) + 'px / ' + (lensRadius * squash).toFixed(2) + 'px)';

    const reach = Math.max(baseWidth * config.magnifyReach.width, step * config.magnifyReach.slot);
    const energy = Math.max(press, Math.min(1, Math.abs(bounce) * config.magnifyEnergy));
    items.forEach((item, index) => {
      const center = (slots[index] + 0.5) * step;
      const distance = Math.abs(center - lensCenter);
      const proximity = clamp(1 - distance / reach, 0, 1);
      const magnify = reduced ? 0 : proximity * energy;
      const covered = Boolean(gesture) && press > config.pressThreshold && distance <= step * config.coverThreshold;
      item.toggleAttribute('data-covered', covered);
      const copy = tinted.get(item);
      if (copy) copy.toggleAttribute('data-covered', covered);
      const surfaces = copy ? [item, copy] : [item];
      surfaces.forEach((surface) => {
        surface.style.setProperty('--item-scale', (1 + magnify * config.magnify).toFixed(4));
        surface.style.setProperty('--item-lift', (magnify * -config.magnifyLift).toFixed(2) + 'px');
      });
    });

    const interacting = Boolean(gesture || settling || press > 0.004 || grow > 0.004 || Math.abs(bounce) > 0.004);
    bar.toggleAttribute('data-gesture', Boolean(gesture));
    bar.toggleAttribute('data-interacting', interacting);
    bar.dataset.state = gesture ? (gesture.dragging ? 'dragging' : 'pressed')
      : interacting ? 'settling' : 'idle';
  };

  const tick = (time) => {
    const dt = Math.min((time - (lastTime || time - 16.67)) / 1000, config.maxFrameDt);
    lastTime = time;
    const pressGoal = gesture ? 1 : (activeSlot >= 0 ? config.hoverPress : 0);
    const expandGoal = gesture ? 1 : (activeSlot >= 0 ? config.hoverExpand : 0);
    const growGoal = gesture && gesture.dragging ? 1 : 0;
    if (target !== lastTarget) {
      jumpSpan = Math.abs(target - x);
      jumpDir = Math.sign(target - x);
      lastTarget = target;
    }

    const reduced = config.respectReducedMotion && reducedMotion.matches;
    if (reduced) {
      x = target;
      vx = 0;
      press = pressGoal;
      vPress = 0;
      grow = growGoal;
      vGrow = 0;
      expand = expandGoal;
      vExpand = 0;
      bounce = 0;
      vBounce = 0;
      settling = false;
      paint();
      frame = 0;
      lastTime = 0;
      return;
    }

    const moving = Boolean(gesture && gesture.dragging);
    const stiffness = moving ? config.drag.stiffness : config.settle.stiffness;
    let damping = moving ? config.drag.damping : config.settle.damping;
    if (!moving) {
      const distance = Math.abs(target - x);
      const zeta = clamp(config.settle.zetaMin + distance / (step * config.settle.zetaSlope),
        config.settle.zetaMin, config.settle.zetaMax);
      damping = 2 * Math.sqrt(stiffness) * zeta;
    }
    const pressSpring = gesture ? config.pressDown : config.pressUp;
    const growSpring = gesture ? config.growOut : config.growBack;
    const expandSpring = gesture ? config.expandOut : config.expandBack;
    const steps = config.substeps;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      vx += ((target - x) * stiffness - vx * damping) * h;
      x += vx * h;
      vPress += ((pressGoal - press) * pressSpring.stiffness - vPress * pressSpring.damping) * h;
      press += vPress * h;
      vGrow += ((growGoal - grow) * growSpring.stiffness - vGrow * growSpring.damping) * h;
      grow += vGrow * h;
      vExpand += ((expandGoal - expand) * expandSpring.stiffness - vExpand * expandSpring.damping) * h;
      expand += vExpand * h;
      vBounce += ((0 - bounce) * config.bounce.stiffness - vBounce * config.bounce.damping) * h;
      bounce += vBounce * h;
    }

    paint();

    const settled = Math.abs(target - x) < config.settled.position
      && Math.abs(vx) < config.settled.velocity
      && Math.abs(press - pressGoal) < 0.006
      && Math.abs(vPress) < config.settled.pressV
      && Math.abs(grow - growGoal) < 0.006
      && Math.abs(vGrow) < config.settled.growV
      && Math.abs(expand - expandGoal) < 0.006
      && Math.abs(vExpand) < config.settled.expandV
      && Math.abs(bounce) < config.settled.bounce
      && Math.abs(vBounce) < config.settled.bounceV;
    if (settled) {
      frame = 0;
      lastTime = 0;
      x = target;
      vx = 0;
      press = pressGoal;
      vPress = 0;
      grow = growGoal;
      vGrow = 0;
      expand = expandGoal;
      vExpand = 0;
      bounce = 0;
      vBounce = 0;
      settling = false;
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

  const syncActive = () => {
    const next = hoverSlot >= 0 ? hoverSlot : focusSlot;
    if (next === activeSlot) return;
    activeSlot = next;
    if (next >= 0 && !gesture) {
      target = slotFor(next);
      settling = true;
    }
    animate();
  };

  const endGesture = () => {
    if (!gesture) return;
    const id = gesture.id;
    const wasDragging = gesture.dragging;
    const touch = gesture.pointerType === 'touch';
    gesture = null;
    bar.removeAttribute('data-gesture');
    bar.removeAttribute('data-dragging');
    if (id !== undefined && bar.hasPointerCapture(id)) bar.releasePointerCapture(id);
    if (wasDragging) {
      const rect = bar.getBoundingClientRect();
      const slot = slotAt(lastPointerX, rect.left, padLeft, trackWidth, items.length);
      hoverSlot = slot;
      if (slot >= 0) target = slotFor(slot);
    }
    // 触摸没有 hover：松手后透镜淡出，不要停在刚点的按钮上。
    if (touch) hoverSlot = -1;
    settling = true;
    syncActive();
    animate();
  };

  const setRoving = (activeIndex) => {
    items.forEach((item, index) => {
      item.tabIndex = index === activeIndex ? 0 : -1;
    });
  };

  const measure = () => {
    if (gesture) endGesture();
    const style = getComputedStyle(bar);
    padLeft = parseFloat(style.paddingLeft);
    padTop = parseFloat(style.paddingTop);
    trackWidth = bar.clientWidth - padLeft - parseFloat(style.paddingRight);
    trackHeight = bar.clientHeight - padTop - parseFloat(style.paddingBottom);

    step = trackWidth / items.length;
    lens.style.width = '';
    lens.style.height = '';
    lens.style.top = '';
    lens.style.borderRadius = '';
    baseWidth = lens.offsetWidth;
    baseHeight = lens.offsetHeight;
    lensBuiltW = baseWidth;
    lensBuiltH = baseHeight;
    lensBuiltAt = 0;
    lensRadius = baseHeight / 2;

    const readNumber = (name, fallback) => {
      const value = parseFloat(getComputedStyle(bar).getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    maxGrow = readNumber('--glass-lens-grow', 1.38);
    lensProtrude = readNumber('--glass-lens-protrude', 8);

    const start = activeSlot >= 0 ? activeSlot : 0;
    x = target = slotFor(start);
    vx = 0;
    press = 0;
    vPress = 0;
    grow = 0;
    vGrow = 0;
    expand = 0;
    vExpand = 0;
    bounce = 0;
    vBounce = 0;
    lastFilter = '';
    material.resize();
    paint();
    // 尺寸变化时按压被清零；指针还停在工具坞上就让它重新淡入，而不是等下一次移动。
    if (activeSlot >= 0) animate();
  };

  // 语言切换后重建透镜：Chrome 的 backdrop-filter 不一定会因为身后的文字变了就重新采样，
  // 换一个新元素可以强制丢掉旧纹理，避免透镜里残留另一种语言的标签。
  const rebuildLens = () => {
    const next = lens.cloneNode(false);
    next.removeAttribute('style');
    next.className = lens.className;
    next.setAttribute('aria-hidden', 'true');
    next.dataset.glassDockPart = 'thumb';
    lens.replaceWith(next);
    lens = next;
    material.destroy();
    material = createGlassMaterial(bar, lens);
    measure();
  };

  const focusIndex = (item) => items.indexOf(item);

  on(bar, 'pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    const item = event.target.closest('button');
    if (!item || !items.includes(item)) return;
    const slot = focusIndex(item);
    bar.removeAttribute('data-keyboard');
    hoverSlot = slot;
    lastPointerX = event.clientX;
    gesture = {
      id: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastTime: performance.now(),
      velocity: 0,
      origin: slotFor(slot),
      dragging: false
    };
    activeSlot = slot;
    settling = false;
    target = gesture.origin;
    bar.setAttribute('data-gesture', '');
    animate();
  });

  on(bar, 'pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.id) {
      if (!gesture && event.pointerType !== 'touch') {
        if (!reducedMotion.matches) {
          const rect = bar.getBoundingClientRect();
          lightX += ((event.clientX - rect.left) / rect.width * 100 - lightX) * config.lightLerp;
        }
        const rect = bar.getBoundingClientRect();
        const slot = slotAt(event.clientX, rect.left, padLeft, trackWidth, items.length);
        if (slot !== hoverSlot) {
          hoverSlot = slot;
          syncActive();
        }
      }
      if (!frame) paint();
      return;
    }
    lastPointerX = event.clientX;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (Math.abs(dy) > config.verticalLock && Math.abs(dy) > Math.abs(dx)) {
        endGesture();
        return;
      }
      if (Math.abs(dx) < config.dragThreshold) return;
      gesture.dragging = true;
      bar.setPointerCapture(event.pointerId);
      bar.setAttribute('data-dragging', '');
    }
    const now = performance.now();
    const elapsed = Math.max(now - gesture.lastTime, 1);
    const instant = (event.clientX - gesture.lastX) / elapsed * 1000;
    gesture.velocity = gesture.velocity * 0.68 + instant * 0.32;
    gesture.lastX = event.clientX;
    gesture.lastTime = now;
    target = rubberBand(gesture.origin + dx, slotFor(0), maxSlotPosition(), step * config.restSlack);
    animate();
  });

  on(bar, 'pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (gesture.dragging) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    lastPointerX = event.clientX;
    endGesture();
  });

  on(bar, 'pointercancel', () => endGesture());
  on(bar, 'lostpointercapture', (event) => {
    if (event.target === bar && gesture && gesture.id === event.pointerId) endGesture();
  });
  on(bar, 'pointerleave', (event) => {
    if (gesture) {
      if (!gesture.dragging) endGesture();
      return;
    }
    if (event.pointerType !== 'touch' && hoverSlot >= 0) {
      hoverSlot = -1;
      syncActive();
    }
  });
  on(bar, 'pointerover', (event) => {
    if (gesture || event.pointerType === 'touch') return;
    const item = event.target.closest('button');
    if (!item || !items.includes(item)) return;
    const slot = focusIndex(item);
    if (slot !== hoverSlot) {
      hoverSlot = slot;
      syncActive();
    }
  });

  on(bar, 'focusin', (event) => {
    const item = event.target.closest('button');
    if (!item || !items.includes(item)) return;
    const slot = focusIndex(item);
    setRoving(slot);
    requestAnimationFrame(() => {
      if (!item.isConnected) return;
      if (item.matches(':focus-visible') || bar.hasAttribute('data-keyboard')) {
        focusSlot = slot;
        syncActive();
      }
    });
  });
  on(bar, 'focusout', (event) => {
    if (bar.contains(event.relatedTarget)) return;
    focusSlot = -1;
    syncActive();
  });
  on(bar, 'keydown', (event) => {
    const item = event.target.closest('button');
    if (!item || !items.includes(item)) return;
    const index = focusIndex(item);
    let next = -1;
    if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    bar.setAttribute('data-keyboard', '');
    items[next].focus();
  });
  on(bar, 'click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  on(window, 'blur', () => endGesture());

  setRoving(0);

  const resizeObserver = new ResizeObserver(() => measure());
  resizeObserver.observe(bar);
  reducedMotion.addEventListener('change', () => animate());
  measure();

  return {
    element: bar,
    refresh: measure,
    reset: rebuildLens,
    syncLabels: syncLabels,
    destroy() {
      ac.abort();
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      material.destroy();
      tint.remove();
      lens.remove();
      bar.removeAttribute('data-glass-dock');
      bar.removeAttribute('data-gesture');
      bar.removeAttribute('data-dragging');
      bar.removeAttribute('data-interacting');
      bar.removeAttribute('data-active');
      bar.removeAttribute('data-keyboard');
      delete bar.dataset.state;
      bar.style.removeProperty('--glass-slots');
      bar.style.removeProperty('--drag-x');
      bar.style.removeProperty('--press');
      bar.style.removeProperty('--squash');
      bar.style.removeProperty('--lean');
      bar.style.removeProperty('--light-x');
      items.forEach((item) => {
        item.tabIndex = 0;
        item.removeAttribute('data-covered');
        item.style.removeProperty('--item-scale');
        item.style.removeProperty('--item-lift');
      });
    }
  };
}
