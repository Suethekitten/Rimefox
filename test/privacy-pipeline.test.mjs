// 翻译管线集成测试：用假的 chrome.* 与 fetch 驱动 background.js 的 translate 路由，
// 验证「发出去的是占位符、回来的译文已还原、映射不落盘、失败不输出半截内容」。
// 运行：node test/privacy-pipeline.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

// ---------------- 假的 chrome.storage ----------------
function makeArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (data.has(k)) out[k] = data.get(k);
        });
        return out;
      }
      const out = {};
      Object.keys(keys).forEach((k) => {
        out[k] = data.has(k) ? data.get(k) : keys[k];
      });
      return out;
    },
    async set(obj) {
      Object.keys(obj || {}).forEach((k) => data.set(k, obj[k]));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k));
    },
    async setAccessLevel() {
      return Promise.resolve();
    },
    async getBytesInUse() {
      return 0;
    }
  };
}

const localArea = makeArea();
const sessionArea = makeArea();
let messageListener = null;

globalThis.chrome = {
  storage: {
    local: localArea,
    session: sessionArea,
    onChanged: { addListener() {} }
  },
  runtime: {
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      }
    },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    lastError: undefined,
    sendMessage: async () => ({ ok: true }),
    openOptionsPage: () => {}
  },
  tabs: {
    onRemoved: { addListener() {} },
    sendMessage: async () => {},
    query: async () => []
  },
  commands: { onCommand: { addListener() {} } },
  contextMenus: {
    onClicked: { addListener() {} },
    removeAll(cb) {
      if (cb) cb();
    },
    create() {}
  },
  scripting: {
    executeScript: async () => [],
    insertCSS: async () => {}
  }
};

// ---------------- 假的接口 ----------------
const calls = [];
let replyFor = null; // (texts) => 字符串数组

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  const texts = JSON.parse(body.messages[1].content);
  const replies = replyFor ? replyFor(texts) : texts.map((one) => 'EN: ' + one);
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies) }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

const baseConfig = {
  _v: 99,
  currentProvider: 'deepseek',
  providerConfig: {
    deepseek: { engine: 'openai', baseUrl: 'https://fake.local/v1', apiKey: 'sk-test', model: 'fake-model' }
  },
  customPrompt: '保留 PII 占位符，不要翻译它们。',
  glossary: [],
  targetLang: 'en',
  batchSize: 8,
  privacyEnabled: false
};

async function setConfig(patch) {
  await localArea.set({ config: { ...baseConfig, ...patch } });
}

function translate(texts, extra) {
  return new Promise((resolve) => {
    messageListener({ type: 'translate', texts, target: 'en', style: 'plain', ...(extra || {}) }, { url: 'https://example.com/page' }, resolve);
  });
}

// ---------------- 驱动 ----------------
await import('../background.js');

console.log('\n[关闭时：默认行为不变]');

await setConfig({ privacyEnabled: false });
replyFor = null;
calls.length = 0;
let res = await translate(['请联系 test@example.com。']);
t('请求体里就是原文（与改动前一致）', () => {
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].body.messages[1].content);
  assert.deepEqual(payload, ['请联系 test@example.com。']);
  assert.equal(calls[0].body.messages[0].content.indexOf('保留 PII 占位符') >= 0, true);
  assert.equal(calls[0].body.messages[0].content.indexOf('隐私占位符（必须原样保留）'), -1);
});
t('返回译文，不经过脱敏/恢复', () => {
  assert.deepEqual(res.results, ['EN: 请联系 test@example.com。']);
});

console.log('\n[开启时：只发占位符]');

await setConfig({ privacyEnabled: true });
calls.length = 0;
res = await translate([
  '请联系 test.user+alias@example.com 或 +1 415-555-2671。',
  '身份证 11010519491231002X，卡号 4242 4242 4242 4242。',
  'Call me at (415) 555-2671.'
]);
t('请求体不含任何原始敏感值', () => {
  const all = calls.map((one) => one.body.messages[1].content).join('\n');
  ['test.user+alias@example.com', '+1 415-555-2671', '11010519491231002X', '4242 4242 4242 4242', '(415) 555-2671'].forEach((secret) => {
    assert.equal(all.indexOf(secret), -1, 'leaked: ' + secret);
  });
  assert.equal(all.indexOf('__PII_') >= 0, true);
  assert.equal(calls[0].body.messages[0].content.indexOf('隐私占位符（必须原样保留）') >= 0, true);
});
t('回包后完整还原原文', () => {
  assert.deepEqual(res.results, [
    'EN: 请联系 test.user+alias@example.com 或 +1 415-555-2671。',
    'EN: 身份证 11010519491231002X，卡号 4242 4242 4242 4242。',
    'EN: Call me at (415) 555-2671.'
  ]);
  res.results.forEach((one) => assert.equal(String(one).indexOf('__PII_'), -1));
});

console.log('\n[失败安全]');

await setConfig({ privacyEnabled: true });
calls.length = 0;
replyFor = (texts) => texts.map(() => '译文里把占位符弄丢了');
res = await translate(['邮箱 test@example.com']);
t('占位符丢失 → 该条为 null，不输出半截译文', () => {
  assert.deepEqual(res.results, [null]);
  assert.equal(res.ok, false); // 全部失败时 ok=false
  assert.match(String(res.error), /无法还原/);
});

await setConfig({ privacyEnabled: true });
calls.length = 0;
replyFor = (texts) => texts.map(() => '__PII_EMAIL_ADDRESS_99__');
res = await translate(['邮箱 test@example.com']);
t('占位符对不上（映射表外）→ 该条为 null', () => {
  assert.deepEqual(res.results, [null]);
  assert.equal(res.ok, false);
});

await setConfig({ privacyEnabled: true });
calls.length = 0;
replyFor = (texts) => texts.map((one) => one + '（重复：' + one + '）');
res = await translate(['邮箱 test@example.com']);
t('模型重复同一占位符 → 两处都还原', () => {
  assert.equal(res.results[0], '邮箱 test@example.com（重复：邮箱 test@example.com）');
});

console.log('\n[整页 / 划词 / 字幕 / 弹窗共用管线]');

t('四个翻译入口都走同一个 translate 路由（因此都被脱敏覆盖）', () => {
  const root = new URL('..', import.meta.url);
  ['content/main.js', 'content/selection.js', 'content/subtitles.js', 'popup/popup.js'].forEach((file) => {
    const src = fs.readFileSync(new URL(file, root), 'utf8');
    assert.equal(src.indexOf("type: 'translate'") >= 0, true, file + ' 没有走 translate 路由');
  });
});

t('脱敏/恢复只挂在 background 的 translate 路由上', () => {
  const root = new URL('..', import.meta.url);
  const src = fs.readFileSync(new URL('background.js', root), 'utf8');
  assert.equal(src.indexOf('maskTexts(') >= 0, true);
  assert.equal(src.indexOf('restoreText(') >= 0, true);
});

console.log('\n[术语表 / 自定义提示词]');

await setConfig({ privacyEnabled: true, glossary: [{ source: '银行卡', target: 'bank card' }] });
calls.length = 0;
replyFor = null;
res = await translate(['银行卡 4242 4242 4242 4242']);
t('术语表与自定义提示词照常进入提示词，脱敏不改变提示词结构', () => {
  const sys = calls[0].body.messages[0].content;
  assert.equal(sys.indexOf('银行卡') >= 0, true);
  assert.equal(sys.indexOf('bank card') >= 0, true);
  assert.equal(sys.indexOf('保留 PII 占位符') >= 0, true);
  assert.equal(res.results[0], 'EN: 银行卡 4242 4242 4242 4242');
});

console.log('\n[批量]');

await setConfig({ privacyEnabled: true, batchSize: 2 });
calls.length = 0;
replyFor = null;
res = await translate(['a@b.com 一', 'c@d.com 二', 'e@f.com 三']);
t('按 batchSize 拆批后，每批各自脱敏、各自还原', () => {
  assert.equal(calls.length, 2);
  const all = calls.map((one) => one.body.messages[1].content).join('\n');
  assert.equal(all.indexOf('a@b.com'), -1);
  assert.deepEqual(res.results, ['EN: a@b.com 一', 'EN: c@d.com 二', 'EN: e@f.com 三']);
});

console.log('\n[缓存]');

await setConfig({ privacyEnabled: true });
calls.length = 0;
replyFor = null;
await translate(['邮箱 cache@example.com']);
const callCount = calls.length;
res = await translate(['邮箱 cache@example.com']);
t('第二次命中本地缓存，不再请求接口', () => {
  assert.equal(calls.length, callCount);
  assert.equal(res.results[0], 'EN: 邮箱 cache@example.com');
  assert.equal(String(res.results[0]).indexOf('__PII_'), -1);
});

console.log('\n[映射不落盘]');

await new Promise((r) => setTimeout(r, 3000)); // 等缓存 flush 写存储
t('chrome.storage 的 local / session 里没有占位符或映射', () => {
  const dump = JSON.stringify({
    local: Object.fromEntries(localArea.data),
    session: Object.fromEntries(sessionArea.data)
  });
  assert.equal(dump.indexOf('__PII_'), -1);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
