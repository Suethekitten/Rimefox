// 扩展页面主题单测：applyUiTheme 从 options / popup 的各自一份合并到 lib/ui-appearance.js 后，
// 行为必须一模一样（同时写 documentElement 和首帧预判用的 localStorage 缓存）。
// 运行：node test/ui-theme.test.mjs
import assert from 'node:assert/strict';

import { applyUiTheme } from '../lib/ui-appearance.js';

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

// 最小假的 document / localStorage：applyUiTheme 只碰这两处
function fakePage() {
  const root = { dataset: {}, style: {} };
  const store = new Map();
  const localStorage = {
    setItem: (k, v) => store.set(k, v),
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    removeItem: (k) => store.delete(k)
  };
  return { root, store, localStorage };
}

console.log('\n[界面主题]');

t('选了深色：写到 documentElement，并缓存给首帧预判', () => {
  const { root, store, localStorage } = fakePage();
  globalThis.document = { documentElement: root };
  globalThis.localStorage = localStorage;
  applyUiTheme('dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(store.get('dt.uiTheme'), 'dark');
});

t('选了浅色：同上，值是 light', () => {
  const { root, store, localStorage } = fakePage();
  globalThis.document = { documentElement: root };
  globalThis.localStorage = localStorage;
  applyUiTheme('light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.style.colorScheme, 'light');
  assert.equal(store.get('dt.uiTheme'), 'light');
});

t('auto / 非法值：撤掉主题交给 CSS，并清掉缓存', () => {
  for (const value of ['auto', '', 'purple', undefined]) {
    const { root, store, localStorage } = fakePage();
    root.dataset.theme = 'dark';
    root.style.colorScheme = 'dark';
    store.set('dt.uiTheme', 'dark');
    globalThis.document = { documentElement: root };
    globalThis.localStorage = localStorage;
    applyUiTheme(value);
    assert.equal('theme' in root.dataset, false, 'dataset.theme 要删掉：' + value);
    assert.equal(root.style.colorScheme, '', 'colorScheme 要清空：' + value);
    assert.equal(store.has('dt.uiTheme'), false, '缓存要清掉：' + value);
  }
});

t('localStorage 被禁用时仍然上色，不抛错', () => {
  const { root } = fakePage();
  globalThis.document = { documentElement: root };
  globalThis.localStorage = {
    setItem() {
      throw new Error('storage disabled');
    },
    removeItem() {
      throw new Error('storage disabled');
    }
  };
  applyUiTheme('dark');
  assert.equal(root.dataset.theme, 'dark');
  applyUiTheme('auto');
  assert.equal('theme' in root.dataset, false);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
