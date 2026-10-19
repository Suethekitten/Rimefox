// 悬浮入口通过后台改 hoverCompare：只接受布尔值、不触发翻译请求。
// 运行：node test/hover-config.test.mjs
import assert from 'node:assert/strict';

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

const data = new Map();
const area = {
  async get(keys) {
    if (keys == null) return Object.fromEntries(data);
    if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
    if (Array.isArray(keys)) {
      const out = {};
      keys.forEach((k) => { if (data.has(k)) out[k] = data.get(k); });
      return out;
    }
    return {};
  },
  async set(obj) { Object.keys(obj || {}).forEach((k) => data.set(k, obj[k])); },
  async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k)); },
  async setAccessLevel() { return Promise.resolve(); },
  async getBytesInUse() { return 0; }
};
let listener = null;
globalThis.chrome = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    lastError: undefined,
    sendMessage: async () => ({ ok: true }),
    openOptionsPage() {}
  },
  tabs: { onRemoved: { addListener() {} }, sendMessage: async () => {}, query: async () => [] },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} }, removeAll(cb) { if (cb) cb(); }, create() {} },
  scripting: { executeScript: async () => [], insertCSS: async () => {} }
};
let fetches = 0;
globalThis.fetch = async () => {
  fetches += 1;
  throw new Error('hover:set 不应发网络请求');
};

const baseConfig = {
  _v: 99,
  currentProvider: 'deepseek',
  providerConfig: {
    deepseek: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'sk-test', model: 'fake' }
  },
  hoverCompare: true
};
await area.set({ config: baseConfig });

function send(msg) {
  return new Promise((resolve) => {
    listener(msg, { url: 'https://example.com/' }, resolve);
  });
}

await import('../background.js');

console.log('\n[hoverCompare 后台开关]');

let res = await send({ type: 'hover:set', value: false });
t('布尔 false：保存并返回新值', () => {
  assert.equal(res.ok, true);
  assert.equal(res.value, false);
  assert.equal(data.get('config').hoverCompare, false);
});

res = await send({ type: 'hover:set', value: false });
t('重复设置同一个值：仍成功（不报错）', () => {
  assert.equal(res.ok, true);
  assert.equal(data.get('config').hoverCompare, false);
});

res = await send({ type: 'hover:set', value: true });
t('布尔 true：重新开启', () => {
  assert.equal(res.ok, true);
  assert.equal(data.get('config').hoverCompare, true);
});

res = await send({ type: 'hover:set', value: 'true' });
t('非布尔值：拒绝，不写配置', () => {
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bad_value');
  assert.equal(data.get('config').hoverCompare, true);
});

res = await send({ type: 'hover:set', value: 1 });
t('数字 1：拒绝（严格布尔）', () => {
  assert.equal(res.ok, false);
  assert.equal(data.get('config').hoverCompare, true);
});

// 悬浮入口里连着点两个开关（mode:set / hover:set 都走 saveConfig）：两次「读 → 合并 → 写」不能互相覆盖
const { saveConfig } = await import('../lib/config.js');
await Promise.all([saveConfig({ mode: 'translation' }), saveConfig({ hoverCompare: false })]);
t('同时保存两项：两项都落盘，后写的不盖掉先写的', () => {
  assert.equal(data.get('config').mode, 'translation', '显示方式被另一次保存盖掉了');
  assert.equal(data.get('config').hoverCompare, false, '悬停对照被另一次保存盖掉了');
});

t('整个过程没有发起翻译 / 网络请求', () => {
  assert.equal(fetches, 0);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
