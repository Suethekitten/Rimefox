// 设置页「外观」「站点与兼容性」的交互：强调色色板、译文排版预览、内置规则列表、站点规则 / 自定义 CSS 的实时校验
import { $, setResult } from './ui.js';
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentHex, isDefaultAccent, sanitizeTranslationCss, typographyVars } from '../lib/appearance.js';
import { BUILTIN_SITE_RULES, normalizeSiteRules } from '../lib/site-rules.js';

// ---------------- 强调色色板 ----------------
// 预设色是一排圆点，最后一个是取色器（自定义颜色）；选中值写进隐藏的 #accentColor
export function createAccentPicker({ container, input, onPick }) {
  const buttons = [];
  ACCENT_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.style.setProperty('--swatch', preset.hex);
    btn.dataset.value = preset.value;
    btn.title = preset.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', preset.label);
    btn.addEventListener('click', () => pick(preset.value));
    container.appendChild(btn);
    buttons.push(btn);
  });
  const custom = document.createElement('label');
  custom.className = 'swatch swatch-custom';
  custom.title = '自定义颜色';
  const color = document.createElement('input');
  color.type = 'color';
  color.setAttribute('aria-label', '自定义颜色');
  color.addEventListener('input', () => pick(color.value));
  custom.appendChild(color);
  container.appendChild(custom);

  function render(value) {
    const preset = ACCENT_PRESETS.find((p) => p.value === value);
    buttons.forEach((btn) => btn.setAttribute('aria-checked', String(!!preset && btn.dataset.value === value)));
    const isCustom = !preset && !isDefaultAccent(value);
    custom.classList.toggle('is-checked', isCustom);
    custom.style.setProperty('--swatch', isCustom ? accentHex(value) : 'transparent');
    color.value = accentHex(value);
  }

  function pick(value) {
    input.value = value;
    render(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (onPick) onPick(value);
  }

  return {
    set(value) {
      input.value = value || DEFAULT_ACCENT;
      render(input.value);
    }
  };
}

// ---------------- 译文排版预览 ----------------
// 预览放在一个迷你浏览器窗口里：译文样式（data-theme）、排版变量、强调色都和网页里的译文同一套
export function updateTypoPreview(preview, form) {
  const vars = typographyVars(form) || { '--dt-font-scale': '1', '--dt-line-height': 'inherit', '--dt-gap': '0.3em', '--dt-indent': '0' };
  Object.keys(vars).forEach((name) => preview.style.setProperty(name, vars[name]));
  const accent = isDefaultAccent(form.accentColor) ? '#3b82f6' : accentHex(form.accentColor);
  preview.style.setProperty('--dt-accent', accent);
  preview.dataset.theme = form.theme || 'underline';
}

// 预览窗右上角的「深色网页」开关：看深色网页上译文颜色的自动调整
export function bindPreviewScheme(button, box) {
  if (!button || !box) return;
  button.addEventListener('click', () => {
    const dark = !box.classList.contains('is-dark-page');
    box.classList.toggle('is-dark-page', dark);
    button.setAttribute('aria-pressed', dark ? 'true' : 'false');
  });
}

// 字号 / 行高 / 间距：把下拉框换成刻度滑块 + 数值胶囊 + 一键复位。
// 下拉框留在原位（隐藏）并且仍是唯一的数据来源：options.js 照旧读写 select.value，
// 这里拦截 value 的赋值来同步滑块；拖动滑块 = 选中对应选项并派发 change。
const SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

export function enhanceTypoSelect(select, defaultValue) {
  if (!select || select.dataset.slider) return;
  select.dataset.slider = '1';
  select.classList.add('typo-select');
  select.tabIndex = -1;
  const row = select.closest('.row');
  const title = row ? row.querySelector('.row-title') : null;

  const wrap = document.createElement('span');
  wrap.className = 'typo-slider';
  const rangeWrap = document.createElement('span');
  rangeWrap.className = 'typo-range-wrap';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = String(Math.max(0, select.options.length - 1));
  range.step = '1';
  // 视觉透镜复用 lib/liquid-glass 的材质 / 位移滤镜；原生 range 仍是唯一的交互与数据源。
  const fill = document.createElement('span');
  fill.className = 'typo-fill';
  fill.setAttribute('aria-hidden', 'true');
  const lens = document.createElement('span');
  lens.className = 'typo-lens';
  lens.setAttribute('aria-hidden', 'true');
  rangeWrap.append(range, fill, lens);
  const value = document.createElement('output');
  value.className = 'typo-value';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'typo-reset';
  reset.textContent = '↺';
  reset.title = '恢复默认';
  reset.setAttribute('aria-label', '恢复默认');
  wrap.append(rangeWrap, value, reset);
  select.after(wrap);

  function positionLens() {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 0;
    const width = range.clientWidth;
    const lensWidth = lens.offsetWidth || 30;
    const progress = max > min ? (Number(range.value) - min) / (max - min) : 0;
    const left = Math.max(0, Math.min(width - lensWidth, progress * (width - lensWidth)));
    lens.style.left = Math.round(left) + 'px';
    // 强调色填充到透镜中心，给玻璃透镜一点可折射的颜色。
    fill.style.width = Math.round(left + lensWidth / 2) + 'px';
  }

  function sync() {
    const index = Math.max(0, select.selectedIndex);
    const opt = select.options[index];
    range.value = String(index);
    value.textContent = opt ? opt.textContent : '';
    range.setAttribute('aria-valuetext', value.textContent);
    if (title) range.setAttribute('aria-label', title.textContent);
    reset.hidden = String(SELECT_VALUE.get.call(select)) === String(defaultValue);
    positionLens();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(positionLens);
  }

  function choose(index) {
    if (select.selectedIndex === index) return;
    select.selectedIndex = index;
    sync();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  Object.defineProperty(select, 'value', {
    configurable: true,
    get() {
      return SELECT_VALUE.get.call(this);
    },
    set(next) {
      SELECT_VALUE.set.call(this, next);
      sync();
    }
  });
  range.addEventListener('input', () => choose(Number(range.value)));
  range.addEventListener('pointerdown', () => rangeWrap.classList.add('is-dragging'));
  window.addEventListener('pointerup', () => rangeWrap.classList.remove('is-dragging'));
  window.addEventListener('pointercancel', () => rangeWrap.classList.remove('is-dragging'));
  if (typeof ResizeObserver === 'function') new ResizeObserver(positionLens).observe(rangeWrap);
  select.addEventListener('change', sync);
  reset.addEventListener('click', (event) => {
    event.preventDefault();
    const index = Array.from(select.options).findIndex((opt) => opt.value === String(defaultValue));
    if (index >= 0) choose(index);
  });
  sync();
}

// ---------------- 内置站点规则 ----------------
export function renderBuiltinRules(list) {
  list.textContent = '';
  BUILTIN_SITE_RULES.forEach((rule) => {
    const li = document.createElement('li');
    const where = document.createElement('code');
    where.textContent = rule.matches.join(', ');
    const note = document.createElement('span');
    note.textContent = rule.note || '';
    li.append(where, note);
    list.appendChild(li);
  });
}

// ---------------- 站点规则（JSON 文本） ----------------
// 返回 { rules, errors }；空文本 = 没有规则
export function parseSiteRulesText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { rules: [], errors: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { rules: [], errors: ['不是合法的 JSON：' + err.message] };
  }
  const result = normalizeSiteRules(data);
  // 选择器语法只有浏览器能判断：逐个试一遍，写错的提示出来（网页里也会单独忽略它）
  result.rules.forEach((rule, i) => {
    rule.textSelectors.concat(rule.excludeSelectors).forEach((sel) => {
      try {
        document.createDocumentFragment().querySelector(sel);
      } catch (err) {
        result.errors.push('第 ' + (i + 1) + ' 条规则的选择器写错了：' + sel);
      }
    });
  });
  return result;
}

export function showSiteRulesResult(text) {
  const node = $('siteRulesResult');
  const { rules, errors } = parseSiteRulesText(text);
  if (errors.length) setResult(node, errors.join('；'), 'bad');
  else if (rules.length) setResult(node, '格式正确，共 ' + rules.length + ' 条规则', 'ok');
  else setResult(node, '');
  return errors;
}

// ---------------- 译文自定义 CSS ----------------
export function showCustomCssResult(text) {
  const node = $('customCssResult');
  const { css, errors } = sanitizeTranslationCss(text);
  if (errors.length) setResult(node, errors.join('；'), 'bad');
  else if (css) setResult(node, '会应用到译文：' + css, 'ok');
  else setResult(node, '');
  return errors;
}
