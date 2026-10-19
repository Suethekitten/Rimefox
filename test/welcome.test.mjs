// 首次安装欢迎页：安装判断 / 语言默认值 / getURL 打开方式 / 页面资源与文案覆盖。
// 运行：node test/welcome.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WELCOME_PAGE,
  WELCOME_STEPS,
  shouldOpenWelcome,
  hasSavedUiLang,
  pickWelcomeLang,
  welcomePageUrl,
  openWelcomePage
} from '../lib/welcome.js';
import { translateText } from '../lib/i18n.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'welcome/index.html'), 'utf8');
const css = await readFile(resolve(root, 'welcome/welcome.css'), 'utf8');
const js = await readFile(resolve(root, 'welcome/welcome.js'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const optionsHtml = await readFile(resolve(root, 'options/index.html'), 'utf8');
const popupHtml = await readFile(resolve(root, 'popup/index.html'), 'utf8');
const popupJs = await readFile(resolve(root, 'popup/popup.js'), 'utf8');
const background = await readFile(resolve(root, 'background.js'), 'utf8');

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

console.log('\n[首次安装欢迎页]');

t('只有 install 自动打开；update / chrome_update / startup 不打开', () => {
  assert.equal(shouldOpenWelcome({ reason: 'install' }), true);
  ['update', 'chrome_update', 'shared_module_update', 'startup', ''].forEach((reason) => {
    assert.equal(shouldOpenWelcome({ reason }), false, reason);
  });
  assert.equal(shouldOpenWelcome(null), false);
  assert.equal(shouldOpenWelcome({}), false);
});

t('语言：保存过的 uiLang 优先；新安装按浏览器语言', () => {
  assert.equal(hasSavedUiLang({ uiLang: 'en' }), true);
  assert.equal(hasSavedUiLang({ uiLang: 'zh' }), true);
  assert.equal(hasSavedUiLang({ uiLang: 'fr' }), false);
  assert.equal(hasSavedUiLang({}), false);
  assert.equal(hasSavedUiLang(null), false);

  assert.equal(pickWelcomeLang({ uiLang: 'en' }, 'zh-CN'), 'en');
  assert.equal(pickWelcomeLang({ uiLang: 'zh' }, 'en-US'), 'zh');
  assert.equal(pickWelcomeLang({}, 'zh-CN'), 'zh');
  assert.equal(pickWelcomeLang({}, 'zh-Hant-TW'), 'zh');
  assert.equal(pickWelcomeLang({}, 'en-US'), 'en');
  assert.equal(pickWelcomeLang({}, 'ja-JP'), 'en');
  assert.equal(pickWelcomeLang({ uiLang: 'fr' }, 'zh-CN'), 'zh');
  assert.equal(pickWelcomeLang(null, 'zh'), 'zh');
});

t('用 runtime.getURL 拼扩展内置页面地址', () => {
  const url = welcomePageUrl({ getURL: (path) => 'chrome-extension://test-id/' + path });
  assert.equal(url, 'chrome-extension://test-id/' + WELCOME_PAGE);
  assert.equal(welcomePageUrl({}), WELCOME_PAGE);
  assert.equal(welcomePageUrl({ getURL: () => { throw new Error('boom'); } }), WELCOME_PAGE);
});

t('手动 / 首次打开都只创建标签页，不写配置', async () => {
  const calls = [];
  const scope = {
    runtime: { getURL: (path) => 'chrome-extension://test-id/' + path },
    tabs: { create: (options) => { calls.push(options); return Promise.resolve({ id: 7 }); } }
  };
  const created = await openWelcomePage(scope);
  assert.deepEqual(created, { id: 7 });
  assert.deepEqual(calls, [{ url: 'chrome-extension://test-id/' + WELCOME_PAGE }]);
  assert.equal(await openWelcomePage({}), null);
});

t('页面资源齐全，且没有远程脚本 / 样式 / 字体', () => {
  ['welcome.css', 'welcome.js', '../lib/ui-theme-boot.js', '../icons/icon128.png'].forEach((asset) => {
    assert(html.includes(asset), '缺少资源引用：' + asset);
  });
  assert(!/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:/i.test(html), '不应加载远程 JS/CSS');
  assert(!/<img\b[^>]*src\s*=\s*["']https?:/i.test(html), '不应加载远程图片');
  assert(!/@import\s+url\(\s*["']?https?:/i.test(css), 'CSS 不应远程导入');
  assert(!/url\(\s*["']?https?:/i.test(css), 'CSS 不应引用远程资源');
  assert(!/<[^>]+\son[a-z]+\s*=/i.test(html), '不应有内联事件处理器');
  assert(!/javascript:/i.test(html), '不应有 javascript: 链接');
});

t('四步面板与步骤按钮一一对应，按钮都有 type', () => {
  assert.equal(WELCOME_STEPS, 4);
  const panels = [...html.matchAll(/<section class="panel"[^>]*data-step="(\d+)"[^>]*aria-labelledby="([^"]+)"/g)];
  assert.equal(panels.length, WELCOME_STEPS, '面板数量');
  assert.deepEqual(panels.map((m) => Number(m[1])), [0, 1, 2, 3]);
  const stepButtons = [...html.matchAll(/class="step-btn"[^>]*data-step="(\d+)"/g)];
  assert.equal(stepButtons.length, WELCOME_STEPS, '步骤按钮数量');
  panels.forEach((m) => assert(html.includes('id="' + m[2] + '"'), '缺少标题 ' + m[2]));
  assert(!/<button\b(?![^>]*\btype=)/i.test(html), '所有 button 都要写 type');
});

t('外部链接都带 noopener noreferrer', () => {
  const links = [...html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>/gi)];
  assert(links.length >= 3, '外链数量');
  links.forEach((m) => {
    assert(/rel="noopener noreferrer"/.test(m[0]), '外链缺少 rel：' + m[1]);
    assert(/target="_blank"/.test(m[0]), '外链缺少 target：' + m[1]);
  });
});

t('欢迎页中文文案都有英文映射（跳过示意图里的示例译文）', () => {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const withoutSamples = withoutComments.replace(
    /<span[^>]*data-i18n-skip[^>]*>[\s\S]*?<\/span>/gi,
    ''
  );
  const missing = [];
  for (const match of withoutSamples.matchAll(/>([^<]*[\u4e00-\u9fff][^<]*)</g)) {
    const text = match[1].trim();
    if (text && translateText(text) === text) missing.push(text);
  }
  for (const attr of withoutSamples.matchAll(/(?:aria-label|title|placeholder)="([^"]*[\u4e00-\u9fff][^"]*)"/g)) {
    const text = attr[1].trim();
    if (text && translateText(text) === text) missing.push('[attr] ' + text);
  }
  assert.deepEqual(missing, [], '缺少英文：\n      ' + missing.join('\n      '));
});

t('欢迎页动态文案有英文映射', () => {
  [
    '界面语言已切换为英文',
    '界面语言已切换为中文',
    '已打开设置页',
    '无法打开设置页，请从扩展菜单进入。',
    '请在扩展环境中打开设置页。',
    '使用指南',
    '指南'
  ].forEach((key) => assert.notEqual(translateText(key), key, key + ' 没有英文'));
});

t('没有新增 tabs / 其它权限', () => {
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting', 'contextMenus']);
  assert(!('tabs' in manifest.permissions));
});

t('后台只在 install 时打开欢迎页，不再自动打开设置页', () => {
  assert(background.includes("from './lib/welcome.js'"));
  assert(background.includes('shouldOpenWelcome(details)'));
  assert(!/onInstalled[\s\S]{0,400}openOptionsPage\(\)/.test(background), '安装回调不应自动打开设置页');
  assert(/onInstalled[\s\S]{0,400}openWelcomePage\(\)/.test(background), '安装回调应打开欢迎页');
});

t('设置页和弹窗都有手动重开使用指南的入口', () => {
  assert(/sidebar-guide[^>]*href="\.\.\/welcome\/index\.html"/.test(optionsHtml));
  assert(optionsHtml.includes('使用指南'));
  assert(popupHtml.includes('id="openGuide"'));
  assert(popupHtml.includes('指南'));
  assert(popupJs.includes('openWelcomePage'));
});

t('欢迎页不会清空配置；只保存初始语言、语言切换和主题切换', () => {
  assert(!/chrome\.storage\.local\.set/.test(js), '不应直接写 storage');
  assert(!/chrome\.storage\.local\.(?:clear|remove)\s*\(/.test(js), '不应清空配置');
  assert(!/saveConfig\(\s*\{\s*\}\s*\)/.test(js), '不应整体覆盖配置');
  assert(js.includes("persist({ uiLang: initialLang })"));
  assert(js.includes("persist({ uiLang: next })"));
  assert(js.includes("persist({ uiTheme: next })"));
});

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
if (fail) process.exitCode = 1;
