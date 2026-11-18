// 划词 UI 合成事件守卫（审计 P1-1）：气泡 / 「译」小按钮 / 术语表单都挂在 light DOM，
// 网页脚本能用 dispatchEvent 伪造点击、直接发起付费翻译或往术语表投毒。
// 这里在假页面里跑 content/selection.js，逐个入口断言：
//   - 合成事件（isTrusted=false）不产生 translate / glossary:add 消息
//   - 真手势（isTrusted=true）路径不回归坏
// 运行：node test/selection-gesture.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);

function fakeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    style: {},
    attrs: {},
    dataset: {},
    handlers: {},
    childNodes: [],
    isConnected: true,
    tabIndex: 0,
    disabled: false,
    maxLength: 0,
    value: '',
    get firstChild() {
      return this.childNodes[0] || null;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : '';
    },
    hasAttribute(k) {
      return k in this.attrs;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (this.handlers[type] || (this.handlers[type] = [])).push(fn);
    },
    closest() {
      return null; // 页面元素：不在 [data-dt-ui] / 输入框里
    },
    click() {
      this.dispatch('click', evt({ isTrusted: false, target: this }));
    },
    dispatch(type, event) {
      for (const fn of this.handlers[type] || []) fn(event);
    },
    focus() {},
    select() {},
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
    },
    animate() {}
  };
  return el;
}

function evt(props) {
  return Object.assign({ stopPropagation() {}, preventDefault() {} }, props);
}

// 在假页面里跑 selection.js，返回 { sent, page }；page 提供 document 级事件派发与定时器
function boot({ config = {}, replies = {} } = {}) {
  const sent = [];
  const timers = [];
  const docListeners = {};
  const created = [];
  const documentElement = fakeElement();

  const document = {
    documentElement,
    body: fakeElement('body'),
    addEventListener(type, fn) {
      (docListeners[type] || (docListeners[type] = [])).push(fn);
    },
    createElement(tag) {
      const el = fakeElement(tag);
      created.push(el);
      return el;
    },
    createTextNode(text) {
      return { nodeType: 3, nodeValue: String(text) };
    }
  };

  const replyFor = (msg) => {
    if (replies[msg.type]) return replies[msg.type](msg);
    if (msg.type === 'translate') return { ok: true, results: ['你好'] };
    if (msg.type === 'glossary:add') return { ok: true, action: 'added' };
    return { ok: true };
  };

  const DT = {
    VERSION: 'test',
    state: { config: Object.assign({ selectionTranslate: true, selectionButton: true }, config), target: 'zh-CN' },
    log() {},
    icon() {
      return fakeElement('span');
    },
    uiText(zh) {
      return zh;
    },
    toast() {},
    direction: null,
    pip: null,
    send(msg) {
      sent.push(msg);
      return Promise.resolve(replyFor(msg));
    }
  };

  const selection = { collapsed: false, rangeCount: 1, getRangeAt: () => range };
  const range = { commonAncestorContainer: fakeElement() };
  range.getBoundingClientRect = () => ({ left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 });

  const sandbox = {
    console,
    window: null,
    setTimeout(fn) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    setInterval() {},
    requestAnimationFrame() {},
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: () => ({ matches: true }),
    addEventListener() {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    document,
    getSelection() {
      return selection;
    },
    chrome: {
      runtime: {
        getURL: (p) => 'chrome-extension://test/' + p,
        onMessage: { addListener() {} }
      }
    }
  };
  selection.toString = () => selection.text || '';
  sandbox.window = sandbox;
  sandbox.__DT = DT;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('content/selection.js', root), 'utf8'), sandbox, { filename: 'selection.js' });

  return {
    sent,
    DT,
    document,
    created,
    // document 级事件派发（mouseup / mousedown / keydown，捕获监听同存）
    fire(type, event) {
      event.target = event.target || document.body;
      for (const fn of docListeners[type] || []) fn(event);
    },
    // 跑掉 mouseup 的 10ms 延迟
    settle() {
      for (const fn of timers.splice(0)) fn();
    },
    // 按谓词找 createElement 造出的元素
    find(pred) {
      return created.find(pred) || null;
    },
    selection
  };
}

function clickTrusted(el) {
  el.dispatch('click', evt({ isTrusted: true, target: el }));
}

test('合成 mouseup 不出小按钮、不翻（选中即翻开着也一样）', () => {
  const page = boot({ config: { selectionImmediate: true } });
  page.selection.text = 'Hello world';
  page.fire('mouseup', evt({ isTrusted: false }));
  page.settle();
  assert.deepEqual(page.sent.map((m) => m.type), [], '合成 mouseup 直接忽略');
  const btn = page.find((el) => el.textContent === '译');
  assert.equal(btn, null, '连小按钮都不该出现');
});

test('合成 click「译」不产生付费 translate；真点击照常翻', async () => {
  const page = boot();
  page.selection.text = 'Hello world';
  page.fire('mouseup', evt({ isTrusted: true }));
  page.settle();
  const btn = page.find((el) => el.textContent === '译' && el.style.display === 'block');
  assert.ok(btn, '真 mouseup 后应出现小按钮');

  btn.dispatch('click', evt({ isTrusted: false, target: btn }));
  assert.deepEqual(page.sent.map((m) => m.type), [], '合成点击「译」必须被挡下');

  clickTrusted(btn);
  assert.deepEqual(page.sent.map((m) => m.type), ['translate'], '真点击不回归坏');
});

test('真 mouseup + 选中即翻照常发 translate；合成 mouseup 被挡', () => {
  const page = boot({ config: { selectionImmediate: true } });
  page.selection.text = 'Hello world';
  page.fire('mouseup', evt({ isTrusted: true }));
  page.settle();
  assert.deepEqual(page.sent.map((m) => m.type), ['translate']);
});

async function translatedPage() {
  const page = boot();
  page.selection.text = 'Hello world';
  page.fire('mouseup', evt({ isTrusted: true }));
  page.settle();
  const btn = page.find((el) => el.textContent === '译' && el.style.display === 'block');
  clickTrusted(btn);
  await new Promise((r) => setImmediate(r));
  return page;
}

test('合成点击气泡胶囊（复制 / 置顶 / 加入术语表）全部无动作', async () => {
  const page = await translatedPage();
  const bubble = page.find((el) => el.attrs['data-dt-ui'] === '1' && el.dataset && el.dataset.state === 'done');
  assert.ok(bubble, '翻译完成后气泡应在');
  const addTerm = bubble._addEl;
  const copy = bubble._copyEl;
  const pin = bubble._pinEl;
  assert.ok(addTerm && copy && pin);

  copy.dispatch('click', evt({ isTrusted: false, target: copy }));
  pin.dispatch('click', evt({ isTrusted: false, target: pin }));
  addTerm.dispatch('click', evt({ isTrusted: false, target: addTerm }));
  assert.equal(copy._label.textContent, '复制', '复制胶囊不能被合成点击触发');
  assert.equal(bubble._form, undefined, '术语表单不能被合成点击打开');

  bubble.dispatch('click', evt({ isTrusted: false, target: bubble }));
  assert.equal(bubble._textEl.textContent, '你好', '点气泡复制的路径也不能被合成触发');

  clickTrusted(addTerm);
  assert.ok(bubble._form, '真点击加入术语表照常打开表单');
});

test('合成 Enter 键不能激活胶囊；真 Enter 经键盘路径照常激活', async () => {
  const page = await translatedPage();
  const bubble = page.find((el) => el.attrs['data-dt-ui'] === '1' && el.dataset && el.dataset.state === 'done');
  const copy = bubble._copyEl;

  copy.dispatch('keydown', evt({ isTrusted: false, target: copy, key: 'Enter' }));
  assert.equal(copy._label.textContent, '复制', '合成 Enter 不能激活胶囊');

  copy.dispatch('keydown', evt({ isTrusted: true, target: copy, key: 'Enter' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(copy._label.textContent, '已复制', '真键盘 Enter 经自己派发的合成 click 放行');
});

test('改写术语表 input 值后合成点击保存 / 覆盖不写术语表；真点击照常写入', async () => {
  const page = await translatedPage();
  const bubble = page.find((el) => el.attrs['data-dt-ui'] === '1' && el.dataset && el.dataset.state === 'done');
  clickTrusted(bubble._addEl);
  const form = bubble._form;
  assert.ok(form, '表单应已打开');

  // 页面脚本直接改 light DOM input 的值，再合成点击保存
  form._src.value = '=evil';
  form._dst.value = '毒';
  form._save.dispatch('click', evt({ isTrusted: false, target: form._save }));
  form._overwrite.dispatch('click', evt({ isTrusted: false, target: form._overwrite }));
  assert.deepEqual(page.sent.map((m) => m.type), ['translate'], '合成点击不能产生 glossary:add');

  clickTrusted(form._save);
  assert.deepEqual(page.sent.map((m) => m.type), ['translate', 'glossary:add']);
  assert.equal(page.sent[1].source, '=evil');
  assert.equal(page.sent[1].overwrite, false);
});

test('合成 Enter 在术语表 input 里不保存；覆盖按钮的合成点击不写术语表', async () => {
  const replies = {
    'glossary:add': () => ({ ok: true, action: 'conflict', current: '旧译法' })
  };
  const page = boot({ replies });
  page.selection.text = 'Hello world';
  page.fire('mouseup', evt({ isTrusted: true }));
  page.settle();
  const btn = page.find((el) => el.textContent === '译' && el.style.display === 'block');
  clickTrusted(btn);
  await new Promise((r) => setImmediate(r));
  const bubble = page.find((el) => el.attrs['data-dt-ui'] === '1' && el.dataset && el.dataset.state === 'done');
  clickTrusted(bubble._addEl);
  const form = bubble._form;

  form._src.dispatch('keydown', evt({ isTrusted: false, target: form._src, key: 'Enter' }));
  assert.equal(page.sent.filter((m) => m.type === 'glossary:add').length, 0, '合成 Enter 不能保存术语');

  clickTrusted(form._save);
  assert.equal(page.sent.filter((m) => m.type === 'glossary:add').length, 1, '真点击保存照常询问冲突');
  await new Promise((r) => setImmediate(r));
  assert.equal(form._overwrite.style.display, 'inline-block', '冲突后覆盖按钮出现');

  form._overwrite.dispatch('click', evt({ isTrusted: false, target: form._overwrite }));
  assert.equal(page.sent.filter((m) => m.type === 'glossary:add').length, 1, '合成点击覆盖必须被挡下');

  clickTrusted(form._overwrite);
  assert.equal(page.sent.filter((m) => m.type === 'glossary:add').length, 2);
  assert.equal(page.sent[2].overwrite, true, '真点击覆盖带 overwrite 标记');
});
