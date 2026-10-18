// 外观相关的纯函数：强调色、译文自定义 CSS 清洗、译文排版参数（可脱离浏览器测试：test/appearance.test.mjs）

// 强调色预设。violet 是默认值：设置页 / 弹窗维持原来的紫蓝，网页里的译文维持原来的蓝色下划线
export const ACCENT_PRESETS = [
  { value: 'violet', label: '紫罗兰', hex: '#6a5cf0' },
  { value: 'blue', label: '海蓝', hex: '#2f6fed' },
  { value: 'teal', label: '青绿', hex: '#0e9384' },
  { value: 'green', label: '松绿', hex: '#2f9e44' },
  { value: 'amber', label: '琥珀', hex: '#d97706' },
  { value: 'rose', label: '玫红', hex: '#e0457b' },
  { value: 'slate', label: '石墨', hex: '#5b6478' }
];

export const DEFAULT_ACCENT = 'violet';
const HEX_RE = /^#[0-9a-f]{6}$/i;

// 配置值合法吗：预设 id 或 #rrggbb
export function isValidAccent(value) {
  return ACCENT_PRESETS.some((p) => p.value === value) || HEX_RE.test(String(value || ''));
}

// 配置值 → 颜色；不合法时回到默认色
export function accentHex(value) {
  const preset = ACCENT_PRESETS.find((p) => p.value === value);
  if (preset) return preset.hex;
  if (HEX_RE.test(String(value || ''))) return String(value).toLowerCase();
  return ACCENT_PRESETS[0].hex;
}

export function isDefaultAccent(value) {
  return !value || value === DEFAULT_ACCENT || !isValidAccent(value);
}

// ---------------- 译文自定义 CSS ----------------
// 只允许「属性: 值;」这种声明，扩展会把它包进 html[data-dt="on"] .dt-target { … } 里，
// 所以写不出选择器、碰不到译文以外的东西。下面这些一律拒绝：
//   { } @    —— 跳出作用域、@import / @font-face 引外部资源
//   url( image-set( —— 加载外部资源（能把页面信息带出去）
//   expression( javascript: behavior -moz-binding —— 老浏览器的脚本注入手段
//   < \     —— 闭合 <style>、转义绕过检查
export const CUSTOM_CSS_MAX = 2000;
const CSS_MAX_DECLS = 40;
const PROP_RE = /^(--[a-z0-9-]+|-?[a-z][a-z0-9-]*)$/i;
const FORBIDDEN = [
  [/[{}@<\\]/, '不能包含 { } @ < \\ 这些字符（只写属性声明，不写选择器和 @ 规则）'],
  [/url\s*\(|image-set\s*\(|image\s*\(/i, '不能引用外部资源（url() / image-set()）'],
  [/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i, '不能包含脚本相关写法'],
  [/\/\*/, '不能包含注释']
];

// 返回 { css, errors }：css 是清洗后的声明（"color: #555; font-size: 0.95em"），errors 是逐条问题
export function sanitizeTranslationCss(text) {
  const raw = String(text || '').trim();
  const errors = [];
  if (!raw) return { css: '', errors };
  if (raw.length > CUSTOM_CSS_MAX) return { css: '', errors: ['超过 ' + CUSTOM_CSS_MAX + ' 字'] };
  for (const [re, why] of FORBIDDEN) {
    if (re.test(raw)) return { css: '', errors: [why] };
  }
  const decls = [];
  raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const i = part.indexOf(':');
      const prop = i > 0 ? part.slice(0, i).trim() : '';
      const value = i > 0 ? part.slice(i + 1).trim() : '';
      if (!prop || !value) {
        errors.push('「' + part + '」不是「属性: 值」的写法');
        return;
      }
      if (!PROP_RE.test(prop)) {
        errors.push('「' + prop + '」不是合法的属性名');
        return;
      }
      decls.push(prop.toLowerCase() + ': ' + value);
    });
  if (decls.length > CSS_MAX_DECLS) errors.push('最多 ' + CSS_MAX_DECLS + ' 条声明');
  if (errors.length) return { css: '', errors };
  return { css: decls.join('; '), errors };
}

// ---------------- 译文排版 ----------------
export const TYPO_DEFAULTS = { typoFontScale: 100, typoLineHeight: 0, typoGap: 3, typoIndent: false };

// 排版参数 → 内容脚本要写到 <html> 上的 CSS 变量；全是默认值时返回 null（不覆盖注入时继承的原文排版）
export function typographyVars(cfg) {
  const c = cfg || {};
  const d = TYPO_DEFAULTS;
  const scale = clamp(Number(c.typoFontScale) || d.typoFontScale, 70, 160);
  const lh = clamp(Number(c.typoLineHeight) || d.typoLineHeight, 0, 3);
  const gap = clamp(Number.isFinite(Number(c.typoGap)) ? Number(c.typoGap) : d.typoGap, 0, 20);
  const indent = !!c.typoIndent;
  if (scale === d.typoFontScale && lh === d.typoLineHeight && gap === d.typoGap && indent === d.typoIndent) return null;
  return {
    '--dt-font-scale': String(scale / 100),
    '--dt-line-height': lh ? String(lh) : 'inherit',
    '--dt-gap': gap / 10 + 'em',
    '--dt-indent': indent ? '2em' : '0'
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
