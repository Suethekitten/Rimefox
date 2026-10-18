// 站点规则单测：格式校验、网址匹配、规则合并、夜间名单（纯函数）。
// 运行：node test/site-rules.test.mjs
import assert from 'node:assert/strict';

import { normalizeSiteRules, matchesUrl, resolveSiteRule, normalizeHosts, hostListed, BUILTIN_SITE_RULES } from '../lib/site-rules.js';
import { pickImportedConfig, mergeConfig, DEFAULTS } from '../lib/config.js';

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

console.log('\n[网址匹配]');

t('域名、*. 子域名（含本身）、带路径通配', () => {
  assert.ok(matchesUrl('github.com', 'https://github.com/a/b'));
  assert.ok(!matchesUrl('github.com', 'https://gist.github.com/x'));
  assert.ok(matchesUrl('*.wikipedia.org', 'https://en.wikipedia.org/wiki/Fox'));
  assert.ok(matchesUrl('*.wikipedia.org', 'https://wikipedia.org/'));
  assert.ok(!matchesUrl('*.wikipedia.org', 'https://notwikipedia.org/'));
  assert.ok(matchesUrl('example.com/docs/*', 'https://example.com/docs/intro?x=1'));
  assert.ok(!matchesUrl('example.com/docs/*', 'https://example.com/blog/'));
  assert.ok(!matchesUrl('github.com', 'not a url'));
});

console.log('\n[规则校验]');

t('合法规则原样保留，未知 mode / theme 被清空并报错', () => {
  const { rules, errors } = normalizeSiteRules([
    { matches: ['news.example.com'], textSelectors: ['article'], excludeSelectors: ['.ad', '.ad'], mode: 'translation', note: '只翻正文' },
    { matches: ['x.com'], mode: 'sideways', theme: 'neon' }
  ]);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].excludeSelectors, ['.ad']);
  assert.equal(rules[0].mode, 'translation');
  assert.equal(rules[1].mode, '');
  assert.equal(rules[1].theme, '');
  assert.equal(errors.length, 2);
});

t('不是数组 / 没有 matches / 网址写法不对 / 选择器带花括号 → 报错并丢弃', () => {
  assert.match(normalizeSiteRules({ matches: [] }).errors[0], /数组/);
  const r = normalizeSiteRules([{ matches: ['https://a.com'] }, { matches: ['b.com'], excludeSelectors: ['a{color:red}'] }, 'x']);
  assert.equal(r.rules.length, 1);
  assert.deepEqual(r.rules[0].excludeSelectors, []);
  assert.ok(r.errors.length >= 3);
});

console.log('\n[规则合并]');

t('用户规则优先：mode 取第一个写了的，选择器取并集，内置规则也生效', () => {
  const user = [{ matches: ['github.com'], excludeSelectors: ['.mine'], mode: 'translation', textSelectors: [], theme: '' }];
  const merged = resolveSiteRule('https://github.com/o/r', user);
  assert.equal(merged.mode, 'translation');
  assert.ok(merged.excludeSelectors.indexOf('.mine') >= 0);
  assert.ok(merged.excludeSelectors.indexOf('.react-directory-filename-cell') >= 0, '内置规则没有合进来');
  assert.equal(resolveSiteRule('https://unrelated.example/', user), null);
});

t('内置规则本身是合法规则', () => {
  assert.deepEqual(normalizeSiteRules(BUILTIN_SITE_RULES).errors, []);
});

console.log('\n[夜间名单]');

t('一行一个域名：去协议 / 路径 / *.，去重，子域名也算', () => {
  assert.deepEqual(normalizeHosts('https://Example.com/a\n*.blog.io  example.com\n\nnot a host!'), ['example.com', 'blog.io']);
  assert.deepEqual(normalizeHosts('http://localhost:8080/x 127.0.0.1:3000'), ['localhost', '127.0.0.1']);
  assert.ok(hostListed('www.example.com', ['example.com']));
  assert.ok(!hostListed('badexample.com', ['example.com']));
});

console.log('\n[配置导入 / 合并]');

t('新字段按类型和取值校验导入', () => {
  const env = (config) => ({ app: 'rimefox', schema: 1, config: { targetLang: 'zh-CN', theme: 'underline', batchSize: 8, ...config } });
  const ok = pickImportedConfig(env({ accentColor: 'teal', typoFontScale: 120, dockSide: 'left', customCss: 'color: #555', nightSites: ['a.com', 'bad host'], siteRules: [{ matches: ['a.com'] }] }));
  assert.equal(ok.config.accentColor, 'teal');
  assert.equal(ok.config.typoFontScale, 120);
  assert.equal(ok.config.dockSide, 'left');
  assert.equal(ok.config.customCss, 'color: #555');
  assert.deepEqual(ok.config.nightSites, ['a.com']);
  assert.equal(ok.config.siteRules.length, 1);
  const bad = pickImportedConfig(env({ accentColor: 'url(x)', typoFontScale: 999, dockSide: 'top', customCss: 'x } body {' }));
  ['accentColor', 'typoFontScale', 'dockSide', 'customCss'].forEach((k) => assert.ok(bad.rejected.indexOf(k) >= 0, k));
});

t('合并配置时清洗站点规则和夜间名单', () => {
  const next = mergeConfig(DEFAULTS, { siteRules: [{ matches: ['a.com'] }, 'junk'], nightSites: 'https://B.com/x' });
  assert.equal(next.siteRules.length, 1);
  assert.deepEqual(next.nightSites, ['b.com']);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
