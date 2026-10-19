// 内容脚本启动：只有顶层页面会自动开始翻译（刷新后恢复 / 打开网页自动翻译），iframe 不会。
// 弹窗和快捷键只控制主框架（frameId 0），iframe 自己开起来的话「还原原文」关不掉它。
// 运行：node test/frame-boot.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);

function fakeElement() {
  return {
    style: {},
    attrs: {},
    className: '',
    lang: '',
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    appendChild() {},
    addEventListener() {}
  };
}

// 在一个假页面里跑 core.js + main.js，返回内容脚本发给后台的所有消息
async function boot({ iframe, resume, translateOnLoad }) {
  const sent = [];
  const replies = {
    'config:get': { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'dual', translateOnLoad } },
    'resume:get': { ok: true, value: resume },
    'resume:set': { ok: true }
  };
  const sandbox = {
    console,
    Promise,
    URL,
    // 计时器不真跑：只看启动阶段发了哪些消息，也不让进程挂着
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    MutationObserver: class {
      observe() {}
    },
    navigator: { platform: 'MacIntel', userAgent: '' },
    location: { href: 'https://example.com/a', hostname: 'example.com' },
    addEventListener() {},
    document: {
      documentElement: fakeElement(),
      body: fakeElement(),
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      createElement: fakeElement
    },
    chrome: {
      runtime: {
        id: 'test',
        lastError: undefined,
        sendMessage(msg, cb) {
          sent.push(msg);
          Promise.resolve().then(() => cb(replies[msg.type] || { ok: false }));
        },
        onMessage: { addListener() {} }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.top = iframe ? {} : sandbox;
  vm.createContext(sandbox);
  for (const file of ['content/core.js', 'content/main.js']) {
    vm.runInContext(fs.readFileSync(new URL(file, root), 'utf8'), sandbox, { filename: file });
  }
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  return sent;
}

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

const types = (sent) => sent.map((m) => m.type);
const enabledBy = (sent) => sent.some((m) => m.type === 'resume:set' && m.value === true);

console.log('\n[内容脚本启动：自动翻译只在顶层页面]');

await t('顶层页面：刷新后按标签页记忆恢复翻译', async () => {
  const sent = await boot({ iframe: false, resume: true, translateOnLoad: false });
  assert.ok(types(sent).includes('resume:get'));
  assert.ok(enabledBy(sent), '应该自动开启');
});

await t('顶层页面：打开网页自动翻译照常生效', async () => {
  const sent = await boot({ iframe: false, resume: false, translateOnLoad: true });
  assert.ok(enabledBy(sent));
});

await t('iframe：标签页记忆和「打开网页自动翻译」都不会让它自己开始翻译', async () => {
  const sent = await boot({ iframe: true, resume: true, translateOnLoad: true });
  assert.equal(types(sent).includes('resume:get'), false, '不用再问后台');
  assert.equal(enabledBy(sent), false, 'iframe 不该自动开启');
  assert.deepEqual(types(sent), ['config:get']);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
