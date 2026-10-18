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
export function updateTypoPreview(preview, form) {
  const vars = typographyVars(form) || { '--dt-font-scale': '1', '--dt-line-height': 'inherit', '--dt-gap': '0.3em', '--dt-indent': '0' };
  Object.keys(vars).forEach((name) => preview.style.setProperty(name, vars[name]));
  const accent = isDefaultAccent(form.accentColor) ? '#3b82f6' : accentHex(form.accentColor);
  preview.style.setProperty('--dt-accent', accent);
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
