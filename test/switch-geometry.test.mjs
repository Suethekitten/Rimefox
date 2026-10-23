// 开关几何一致性：设置页和弹窗共用 lib/ui-tokens.css 里的 .switch，槽 / 填充 / 透镜 / 玻璃滤镜只认一组变量。
// 历史教训（0.10.0）：两份实现都按「内框 = width × height」算 top: 2px，但全局 `* { box-sizing: border-box }`
// 让 1px 描边吃掉了内框，透镜上 2px 下 0px、开状态贴住右边框；减少透明时伪元素是 content-box，2px 描边把透镜撑出槽外。
// 运行：node test/switch-geometry.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tokens = read('lib/ui-tokens.css');
const optionsCss = read('options/options.css');
const popupCss = read('popup/popup.css');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

// 取某个选择器（整行匹配）的声明块
function block(css, selector) {
  const start = css.indexOf('\n' + selector + ' {');
  assert.ok(start >= 0, '找不到 ' + selector);
  return css.slice(start, css.indexOf('}', start));
}
function px(body, name) {
  const m = body.match(new RegExp(name + ':\\s*(\\d+(?:\\.\\d+)?)px;'));
  return m ? Number(m[1]) : undefined;
}
function geometry(selector, base) {
  const body = block(tokens, selector);
  const g = Object.assign({}, base);
  ['--switch-w', '--switch-h', '--switch-border', '--switch-pad', '--switch-knob-w'].forEach((name) => {
    const v = px(body, name);
    if (v !== undefined) g[name] = v;
  });
  const inset = g['--switch-border'] + g['--switch-pad'];
  g.knobW = g['--switch-knob-w'];
  g.knobH = g['--switch-h'] - 2 * inset;
  g.travel = g['--switch-w'] - g.knobW - 2 * inset;
  return g;
}
function filterSize(file, name) {
  const m = read(file).match(new RegExp("ensureGlassFilter\\('" + name + "',\\s*\\{\\s*width:\\s*(\\d+),\\s*height:\\s*(\\d+)"));
  assert.ok(m, file + ' 里找不到 ensureGlassFilter(\'' + name + '\')');
  return { width: Number(m[1]), height: Number(m[2]) };
}

console.log('\n[开关几何]');

const regular = geometry('.switch', {});
const small = geometry('.switch-sm', regular);

t('两种尺寸都是整数像素、行程为正（透镜两端间隙相等由公式保证）', () => {
  [regular, small].forEach((g) => {
    [g['--switch-w'], g['--switch-h'], g['--switch-border'], g['--switch-pad'], g.knobW].forEach((v) => assert.ok(Number.isInteger(v), JSON.stringify(g)));
    assert.ok(g.knobH > 0 && g.travel > 0, JSON.stringify(g));
  });
});

t('常规开关透镜 = 设置页 slider 滤镜 = 排版滑块透镜（三者共用一张贴图）', () => {
  assert.deepEqual({ width: regular.knobW, height: regular.knobH }, filterSize('options/options.js', 'slider'));
  const lens = block(optionsCss, '.typo-lens');
  assert.deepEqual({ width: px(lens, 'width'), height: px(lens, 'height') }, filterSize('options/options.js', 'slider'));
});

t('紧凑开关透镜 = 弹窗 mini-slider 滤镜', () => {
  assert.deepEqual({ width: small.knobW, height: small.knobH }, filterSize('popup/popup.js', 'mini-slider'));
});

t('填充和透镜贴着槽内边缘、border-box，开 / 关只改 translate，开状态填充铺到透镜右缘', () => {
  const both = block(tokens, '.switch::before,\n.switch::after');
  assert.match(both, /box-sizing: border-box;/);
  assert.match(both, /top: var\(--switch-pad\);/);
  assert.match(both, /bottom: var\(--switch-pad\);/);
  assert.match(both, /left: var\(--switch-pad\);/);
  assert.ok(!/\n\s*(height|transform):/.test(block(tokens, '.switch::after')), '透镜不该再写死高度或 transform');
  assert.match(block(tokens, '.switch:checked::after,\n:checked + .switch::after'), /translate: var\(--switch-travel\) 0;/);
  // 开状态填充的右端 = 透镜右缘：透镜底下整片是填充，玻璃不会把断口折射到一边
  assert.match(block(tokens, '.switch:checked::before,\n:checked + .switch::before'), /width: calc\(var\(--switch-travel\) \+ var\(--switch-knob-w\)\);/);
  assert.match(block(tokens, '.switch'), /box-sizing: border-box;/);
});

t('页面样式里没有第二份开关实现', () => {
  const rules = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.switch\b/.test(rules(optionsCss)), 'options.css 又出现了开关规则');
  assert.ok(!/\.(mini-)?switch\b/.test(rules(popupCss)), 'popup.css 又出现了开关规则');
});

t('弹窗：每个 role="switch" 的复选框后面紧跟紧凑开关；设置页开关都是复选框', () => {
  const popupHtml = read('popup/index.html');
  const inputs = [...popupHtml.matchAll(/<input type="checkbox" id="(\w+)" role="switch" \/>\s*<span class="([^"]+)"/g)];
  assert.ok(inputs.length >= 2, '弹窗里找不到开关');
  inputs.forEach((m) => assert.equal(m[2], 'switch switch-sm', m[1]));
  const optionsHtml = read('options/index.html');
  const switches = [...optionsHtml.matchAll(/<input ([^>]*)class="switch"/g)];
  assert.ok(switches.length > 0);
  switches.forEach((m) => assert.match(m[1], /type="checkbox"/));
});

console.log('');
if (fail) {
  console.log('✗ ' + fail + ' 条失败，' + pass + ' 条通过');
  process.exit(1);
}
console.log('✓ ' + pass + ' 条全部通过');
