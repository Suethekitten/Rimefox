// 把位移滤镜接到普通 DOM：每个实例独立 id，尺寸变化时按新尺寸重建。
// 复用并改编自 Sak（@Saknutella）的 Liquid Glass Slider（MIT）：
// https://github.com/Saknutella/liquid-glass-slider
// 位移贴图与三通道色散算法改编自 nikdelvin/liquid-glass（MIT）。
// 许可见仓库根目录 THIRD-PARTY-NOTICES.md。

import { displacementFilter } from './filter.js';

const NS = 'http://www.w3.org/2000/svg';
let serial = 0;

const supportsURL = typeof CSS !== 'undefined' && CSS.supports
  && CSS.supports('backdrop-filter', 'url("#test")');
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const webkitOnly = /AppleWebKit/.test(ua)
  && ua.indexOf('Chrome/') < 0 && ua.indexOf('Chromium/') < 0 && ua.indexOf('Edg/') < 0;
const reducedTransparency = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-transparency: reduce)')
  : null;

const sharedFilters = new Map();

const svg = document.createElementNS(NS, 'svg');
svg.setAttribute('aria-hidden', 'true');
svg.setAttribute('width', '0');
svg.setAttribute('height', '0');
svg.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden';
const defs = document.createElementNS(NS, 'defs');
svg.append(defs);
document.body.append(svg);

function createLayer(element, variable, id, defaults) {
  return {
    element: element,
    variable: variable,
    id: id,
    defaults: defaults,
    node: null,
    effect: '',
    key: ''
  };
}

/**
 * 给底座和透镜生成折射滤镜。
 * @param {HTMLElement} bar 底座（承载 --glass-refraction）
 * @param {HTMLElement} lens 透镜（承载 --thumb-refraction）
 */
export function createGlassMaterial(bar, lens, options = {}) {
  const id = ++serial;
  const baseLayer = createLayer(bar, '--glass-refraction', 'lg-dock-base-' + id,
    { strength: 18, depth: 9, cab: 0.5, blur: 3, brightness: 1.03, saturate: 1.3 });
  const lensLayer = createLayer(lens, '--thumb-refraction', 'lg-dock-lens-' + id,
    { strength: 26, depth: 6, cab: 2.2, blur: 0, brightness: 1.1, saturate: 1.5 });
  // base: false 时只给透镜生成滤镜（设置页导航的底座用普通 blur，省一次大尺寸滤镜）
  const layers = options.base === false ? [lensLayer] : [baseLayer, lensLayer];
  let lensSize = null;
  let filterValue = '';

  const readNum = (name, fallback) => {
    const value = parseFloat(getComputedStyle(bar).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };

  const measureLayer = (layer) => {
    if (layer === lensLayer && lensSize) return lensSize;
    const width = layer.element.offsetWidth;
    const height = layer.element.offsetHeight;
    const radius = Math.min(
      width / 2,
      height / 2,
      parseFloat(getComputedStyle(layer.element).borderTopLeftRadius) || height / 2
    );
    return { width: width, height: height, radius: radius };
  };

  const enabledNow = () => supportsURL && !webkitOnly
    && !document.documentElement.hasAttribute('data-reduce-transparency')
    && (!reducedTransparency || !reducedTransparency.matches
      || bar.hasAttribute('data-glass-allow-transparency'));

  const apply = () => {
    const enabled = enabledNow();
    bar.dataset.material = enabled ? 'svg-refraction' : 'frosted-fallback';
    if (!enabled) {
      layers.forEach((layer) => layer.element.style.removeProperty(layer.variable));
      filterValue = '';
      return;
    }
    layers.forEach((layer) => {
      const isLens = layer === lensLayer;
      const size = measureLayer(layer);
      if (!(size.width > 0) || !(size.height > 0)) return;
      const fallback = layer.defaults;
      const scale = isLens ? 1 : size.height / 144;
      const strength = isLens
        ? readNum('--glass-lens-strength', fallback.strength)
        : readNum('--glass-base-strength', fallback.strength) * scale;
      const depth = isLens
        ? readNum('--glass-lens-depth', fallback.depth)
        : readNum('--glass-base-depth', fallback.depth) * scale;
      const cab = isLens
        ? readNum('--glass-lens-cab', fallback.cab)
        : readNum('--glass-base-cab', fallback.cab) * scale;
      const blur = isLens ? readNum('--glass-lens-blur', fallback.blur) : fallback.blur;
      const brightness = isLens
        ? readNum('--glass-lens-brightness', fallback.brightness)
        : readNum('--glass-base-brightness', fallback.brightness);
      const saturate = isLens
        ? readNum('--glass-lens-saturate', fallback.saturate)
        : readNum('--glass-base-saturate', fallback.saturate);
      const key = [
        size.width.toFixed(1), size.height.toFixed(1), size.radius.toFixed(1),
        strength.toFixed(2), depth.toFixed(2), cab.toFixed(2),
        blur.toFixed(2), brightness.toFixed(2), saturate.toFixed(2)
      ].join('|');
      if (layer.key === key && layer.node && document.getElementById(layer.id)) {
        layer.element.style.setProperty(layer.variable, layer.effect);
        return;
      }
      layer.key = key;
      const url = displacementFilter({
        width: size.width,
        height: size.height,
        radius: size.radius,
        depth: depth,
        strength: strength,
        chromaticAberration: cab
      });
      const source = decodeURIComponent(url.slice(url.indexOf(',') + 1, url.lastIndexOf('#')));
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
      const filter = document.importNode(parsed.querySelector('filter'), true);
      filter.id = layer.id;
      const previous = document.getElementById(layer.id);
      if (previous) previous.replaceWith(filter);
      else defs.append(filter);
      layer.node = filter;
      layer.effect = isLens
        ? 'blur(' + (blur / 2) + 'px) url("#' + layer.id + '") blur(' + blur + 'px) brightness(' + brightness + ') saturate(' + saturate + ')'
        : 'url("#' + layer.id + '") blur(' + blur + 'px) brightness(' + brightness + ') saturate(' + saturate + ')';
      layer.element.style.setProperty(layer.variable, layer.effect);
      if (isLens) filterValue = layer.effect;
    });
  };

  const resize = () => {
    lensSize = null;
    apply();
  };

  // 拖动放大时调用：按当前 layout 尺寸重建透镜贴图，保持真实的边缘折射。
  const resizeLens = (width, height, radius) => {
    lensSize = { width: width, height: height, radius: radius || height / 2 };
    apply();
  };

  const onTransparencyChange = () => resize();
  if (reducedTransparency && reducedTransparency.addEventListener) {
    reducedTransparency.addEventListener('change', onTransparencyChange);
  }
  const attrObserver = new MutationObserver(resize);
  attrObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-reduce-transparency']
  });

  resize();

  return {
    resize: resize,
    resizeLens: resizeLens,
    update: () => {},
    get filter() { return enabledNow() ? filterValue : ''; },
    destroy() {
      if (reducedTransparency && reducedTransparency.removeEventListener) {
        reducedTransparency.removeEventListener('change', onTransparencyChange);
      }
      attrObserver.disconnect();
      layers.forEach((layer) => {
        if (layer.node) layer.node.remove();
        layer.element.style.removeProperty(layer.variable);
      });
      bar.removeAttribute('data-material');
    }
  };
}

// 小尺寸玻璃珠（开关圆钮 / 滑块透镜）共用一张固定尺寸的滤镜：
// 不给每个控件单独建 material（设置页有几十个开关），但折射仍然走 Sak 的位移贴图 + 三通道色散。
export function ensureGlassFilter(name, size, params = {}) {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const radius = Math.max(1, Math.round(size.radius || height / 2));
  const strength = params.strength == null ? 8 : params.strength;
  const depth = params.depth == null ? 2 : params.depth;
  const cab = params.chromaticAberration == null ? 1.2 : params.chromaticAberration;
  const blur = params.blur == null ? 0.5 : params.blur;
  const brightness = params.brightness == null ? 1.05 : params.brightness;
  const saturate = params.saturate == null ? 1.65 : params.saturate;
  const key = [width, height, radius, strength, depth, cab, blur, brightness, saturate].join('|');
  const previous = sharedFilters.get(name);
  if (previous && previous.key === key) {
    document.documentElement.style.setProperty('--glass-' + name + '-filter', previous.effect);
    return previous.effect;
  }
  if (previous) {
    const old = document.getElementById(previous.id);
    if (old) old.remove();
  }
  const id = 'lg-shared-' + name + '-' + (++serial);
  const url = displacementFilter({
    width: width,
    height: height,
    radius: radius,
    depth: depth,
    strength: strength,
    chromaticAberration: cab
  });
  const source = decodeURIComponent(url.slice(url.indexOf(',') + 1, url.lastIndexOf('#')));
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const filter = document.importNode(parsed.querySelector('filter'), true);
  filter.id = id;
  defs.append(filter);
  const effect = 'url("#' + id + '") blur(' + blur + 'px) brightness(' + brightness + ') saturate(' + saturate + ')';
  sharedFilters.set(name, { key: key, id: id, effect: effect });
  document.documentElement.style.setProperty('--glass-' + name + '-filter', effect);
  return effect;
}
