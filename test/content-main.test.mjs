// 内容脚本调度层（content/main.js）：在假页面里跑 core.js + main.js，只看它发给后台的消息和页面状态。
//   - 启动：只有顶层页面会自动开始翻译（刷新后恢复 / 打开网页自动翻译），iframe 不会
//     （弹窗和快捷键只控制主框架 frameId 0，iframe 自己开起来的话「还原原文」关不掉它）
//   - 配置广播：显示方式 / 目标语言真的变了才跟着改，翻译中要整页重建；没变就保留本页自己的选择
// 运行：node test/content-main.test.mjs
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

function flush() {
  return (async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  })();
}

// 返回 { sent: 发给后台的消息, config: 后台给的配置（可改）, page: 页面上的 DT, message(): 模拟后台 / 弹窗发来的消息, rebuilds }
// hooks（可选）：{ timers: [], listeners: {} } 收下计时器回调和 document 上的事件监听，测试自己决定何时触发
async function boot({ iframe = false, resume = false, translateOnLoad = false, config = {}, hooks = null } = {}) {
  const sent = [];
  const page = { rebuilds: 0, listener: null };
  const cfg = { hasKey: true, targetLang: 'zh-CN', mode: 'dual', translateOnLoad, ...config };
  const sandbox = {
    console,
    Promise,
    URL,
    // 计时器不真跑：只看消息和状态，也不让进程挂着
    setTimeout: hooks
      ? (fn) => {
          hooks.timers.push(fn);
          return hooks.timers.length;
        }
      : () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    MutationObserver: class {
      observe() {}
    },
    navigator: { platform: 'MacIntel', userAgent: '' },
    location: { href: 'https://example.com/a', hostname: 'example.com' },
    innerHeight: 800,
    addEventListener() {},
    document: {
      documentElement: fakeElement(),
      body: fakeElement(),
      addEventListener(type, fn) {
        if (hooks) hooks.listeners[type] = fn;
      },
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
          const replies = {
            'config:get': { ok: true, config: JSON.parse(JSON.stringify(cfg)) },
            'resume:get': { ok: true, value: resume },
            'resume:set': { ok: true }
          };
          Promise.resolve().then(() => cb(replies[msg.type] || { ok: false }));
        },
        onMessage: {
          addListener(fn) {
            page.listener = fn;
          }
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.top = iframe ? {} : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('content/core.js', root), 'utf8'), sandbox, { filename: 'core.js' });
  vm.runInContext(fs.readFileSync(new URL('content/units.js', root), 'utf8'), sandbox, { filename: 'units.js' });
  // dom.js 的 DOM 引擎换成桩：这里只关心调度
  const DT = sandbox.__DT;
  DT.restore = () => {
    page.rebuilds += 1;
  };
  DT.releaseReplaced = () => 0;
  DT.refreshStale = () => 0;
  DT.collectAll = () => [];
  DT.lastCollectFull = false;
  vm.runInContext(fs.readFileSync(new URL('content/main.js', root), 'utf8'), sandbox, { filename: 'main.js' });
  await flush();
  return {
    sent,
    config: cfg,
    DT,
    page,
    async message(msg) {
      let reply;
      page.listener(msg, {}, (r) => {
        reply = r;
      });
      await flush();
      return reply;
    }
  };
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

console.log('\n[启动：自动翻译只在顶层页面]');

await t('顶层页面：刷新后按标签页记忆恢复翻译', async () => {
  const { sent } = await boot({ resume: true });
  assert.ok(types(sent).includes('resume:get'));
  assert.ok(enabledBy(sent), '应该自动开启');
});

await t('顶层页面：打开网页自动翻译照常生效', async () => {
  const { sent } = await boot({ translateOnLoad: true });
  assert.ok(enabledBy(sent));
});

await t('iframe：标签页记忆和「打开网页自动翻译」都不会让它自己开始翻译', async () => {
  const { sent } = await boot({ iframe: true, resume: true, translateOnLoad: true });
  assert.equal(types(sent).includes('resume:get'), false, '不用再问后台');
  assert.equal(enabledBy(sent), false, 'iframe 不该自动开启');
  assert.deepEqual(types(sent), ['config:get']);
});

console.log('\n[配置广播：显示方式 / 目标语言]');

await t('翻译中别处改了显示方式：本页跟着改，并且整页重建', async () => {
  const c = await boot({ resume: true });
  assert.equal(c.DT.state.enabled, true);
  const before = c.page.rebuilds;
  c.config.mode = 'translation';
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.DT.state.mode, 'translation');
  assert.equal(c.page.rebuilds, before + 1, '不重建的话新旧两种显示方式混在一页');
});

await t('配置里的显示方式没变：保留本页自己切的（站点规则固定了模式也一样）', async () => {
  const c = await boot({ resume: true, config: { page: { site: { mode: 'dual' } } } });
  await c.message({ type: 'dt:setMode', mode: 'translation' });
  assert.equal(c.DT.state.mode, 'translation');
  const before = c.page.rebuilds;
  c.config.mode = 'translation'; // 弹窗随后把模式存进配置，站点规则仍然是 dual
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.DT.state.mode, 'translation', '不能被配置广播改回去');
  assert.equal(c.page.rebuilds, before);
});

await t('目标语言：配置广播先到并重建过，弹窗随后的 dt:setTarget 不再重建一次', async () => {
  const c = await boot({ resume: true });
  c.config.targetLang = 'en';
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.DT.state.target, 'en');
  const before = c.page.rebuilds;
  const status = await c.message({ type: 'dt:setTarget', target: 'en' });
  assert.equal(status.target, 'en');
  assert.equal(c.page.rebuilds, before, '同一种语言重建会作废在途请求、重复计费');
});

await t('没开翻译时改配置：只更新状态，不重建', async () => {
  const c = await boot();
  c.config.mode = 'translation';
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.DT.state.mode, 'translation');
  assert.equal(c.page.rebuilds, 0);
});


await t('翻译中别处开启医学模式：本页整页重建，按新配置重新翻译', async () => {
  const c = await boot({ resume: true, config: { medicalMode: false } });
  assert.equal(c.DT.state.enabled, true);
  const before = c.page.rebuilds;
  c.config.medicalMode = true;
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, before + 1, '不重建的话普通译文会继续冒充专业译文');
});

await t('翻译中关闭医学模式：同样整页重建，恢复普通译文', async () => {
  const c = await boot({ resume: true, config: { medicalMode: true } });
  const before = c.page.rebuilds;
  c.config.medicalMode = false;
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, before + 1, '关闭也要重建，不能继续显示专业译文');
});

await t('医学模式配置没变：不重复重建', async () => {
  const c = await boot({ resume: true, config: { medicalMode: true } });
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, 0);
});

await t('整页翻译：后台的 alignments 经 alignmentOf 校验后交给 DT.inject', async () => {
  const env = await boot({ config: { hoverCompare: true, lazy: false, skipSameLang: false } });
  const DT = env.DT;
  const unit = {
    el: {
      ...fakeElement(),
      isConnected: true,
      getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, bottom: 20 })
    },
    text: 'One. Two.',
    sentences: [
      { index: 0, start: 0, end: 4, text: 'One.' },
      { index: 1, start: 5, end: 9, text: 'Two.' }
    ],
    style: 'plain',
    own: false
  };
  const seen = [];
  DT.collectAll = () => [unit];
  DT.inject = (u, text, lang, align) => {
    seen.push({ text, align });
    return true;
  };
  DT.sourceChanged = () => false;
  DT.send = async (msg) => {
    if (msg.type === 'config:get') {
      return { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'dual', hoverCompare: true, lazy: false, skipSameLang: false } };
    }
    if (msg.type === 'resume:get') return { ok: true, value: false };
    if (msg.type === 'translate') {
      assert.equal(msg.align, true, '多句段落应请求结构化对齐');
      return { ok: true, results: ['译:One.译:Two.'], alignments: [[{ n: 1, t: '译:One.' }, { n: 1, t: '译:Two.' }]] };
    }
    return { ok: true };
  };

  await env.message({ type: 'dt:toggle' });
  await flush();
  await flush();
  assert.equal(seen.length, 1, '应该注入一次');
  assert.ok(seen[0].align && seen[0].align.reliable, '对齐应通过校验：' + JSON.stringify({ ali: unit.ali, want: unit.wantAlign, text: seen[0].text, sents: unit.sentences.length }));
  assert.equal(JSON.stringify(seen[0].align.parts.map((p) => [p.srcFrom, p.srcTo])), JSON.stringify([[0, 1], [1, 2]]));
});


await t('保留区：送翻带 <kN> 标记，注入拿到模型原样的回包', async () => {
  const env = await boot({ config: { hoverCompare: true, lazy: false, skipSameLang: false } });
  const DT = env.DT;
  const unit = {
    el: {
      ...fakeElement(),
      isConnected: true,
      getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, bottom: 20 })
    },
    text: 'Install Rimefox from the store today.',
    keep: [{ start: 8, end: 15, text: 'Rimefox' }],
    wire: 'Install <k1>Rimefox</k1> from the store today.',
    sentences: [{ index: 0, start: 0, end: 37, text: 'Install Rimefox from the store today.' }],
    style: 'plain',
    own: false
  };
  const seen = [];
  const asked = [];
  DT.collectAll = () => [unit];
  DT.inject = (u, text) => {
    seen.push(text);
    return true;
  };
  DT.sourceChanged = () => false;
  DT.send = async (msg) => {
    if (msg.type === 'config:get') {
      return { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'translation', hoverCompare: true, lazy: false, skipSameLang: false } };
    }
    if (msg.type === 'resume:get') return { ok: true, value: false };
    if (msg.type === 'translate') {
      asked.push(...msg.texts);
      return { ok: true, results: ['今天从商店安装 <k1>凛狐</k1>。'], alignments: [null] };
    }
    return { ok: true };
  };

  await env.message({ type: 'dt:toggle' });
  await flush();
  await flush();
  assert.deepEqual(asked, ['Install <k1>Rimefox</k1> from the store today.']);
  assert.deepEqual(seen, ['今天从商店安装 <k1>凛狐</k1>。'], '标记留给 DT.inject 切分');
  assert.equal(DT.keepText(unit, seen[0]), '今天从商店安装 Rimefox。');
});


await t('多段落共用容器：一段失败不会被另一段的成功清掉退避状态', async () => {
  const env = await boot({ config: { hoverCompare: true, lazy: false, skipSameLang: false } });
  const DT = env.DT;
  const el = {
    ...fakeElement(),
    isConnected: true,
    getBoundingClientRect: () => ({ width: 600, height: 120, top: 0, bottom: 120 })
  };
  const units = [
    { el, text: 'First paragraph fails.', index: 0, sig: 'a', sentences: [{ index: 0, start: 0, end: 22 }], style: 'plain', own: false },
    { el, text: 'Second paragraph succeeds.', index: 1, sig: 'b', sentences: [{ index: 0, start: 0, end: 25 }], style: 'plain', own: false }
  ];
  const injected = [];
  DT.collectAll = () => units;
  DT.inject = (u, text) => {
    injected.push({ index: u.index, text });
    return true;
  };
  DT.sourceChanged = () => false;
  DT.send = async (msg) => {
    if (msg.type === 'config:get') {
      return { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'dual', hoverCompare: true, lazy: false, skipSameLang: false } };
    }
    if (msg.type === 'resume:get') return { ok: true, value: false };
    if (msg.type === 'translate') return { ok: true, results: [null, '第二段译文'], alignments: [null, null] };
    return { ok: true };
  };

  await env.message({ type: 'dt:toggle' });
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(injected.length, 1, '只有成功的那段被注入');
  assert.equal(injected[0].index, 1);
  assert.equal(DT.state.failed, 1, '失败段的退避不能被成功段清掉');
});

// 补扫一轮：模拟滚动 → 懒翻译的节流计时器到点（只跑新排上的计时器）
async function rescan(hooks) {
  const from = hooks.timers.length;
  hooks.listeners.scroll();
  hooks.timers.slice(from).forEach((fn) => fn());
  for (let i = 0; i < 4; i += 1) await flush();
}

await t('注入被拒（结构对不上 / 已有译文）：记成已处理，下一轮不再原样送翻', async () => {
  const hooks = { timers: [], listeners: {} };
  const env = await boot({ config: { lazy: true, skipSameLang: false }, hooks });
  const DT = env.DT;
  DT.generation = 1;
  const el = {
    ...fakeElement(),
    isConnected: true,
    getBoundingClientRect: () => ({ width: 600, height: 20, top: 0, bottom: 20 })
  };
  const unit = () => ({ el, text: 'Published by the author', index: 0, gen: 1, sentences: [], style: 'plain', own: true });
  let injects = 0;
  const asked = [];
  // 真正的 DT.collect 用 accept 过滤（已处理 / 退避 / 太短的不收）
  DT.collectAll = (accept) => [unit()].filter((u) => !accept || accept(u));
  DT.inject = () => {
    injects += 1;
    return false;
  };
  DT.sourceChanged = () => false;
  DT.send = async (msg) => {
    if (msg.type === 'config:get') {
      return { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'dual', lazy: true, skipSameLang: false } };
    }
    if (msg.type === 'resume:get') return { ok: true, value: false };
    if (msg.type === 'translate') {
      asked.push(...msg.texts);
      return { ok: true, results: msg.texts.map((x) => '译：' + x), alignments: msg.texts.map(() => null) };
    }
    return { ok: true };
  };

  await env.message({ type: 'dt:toggle' });
  for (let i = 0; i < 4; i += 1) await flush();
  assert.equal(injects, 1);
  assert.equal(asked.length, 1);
  await rescan(hooks);
  await rescan(hooks);
  assert.equal(asked.length, 1, '同一段不该每轮都发去后台：' + JSON.stringify(asked));
  assert.equal(injects, 1);
  assert.equal(DT.state.skipped, 1, '算进「跳过」，进度条才能走完');
});

await t('保留区：超长段落切片后，带标记的每一片都是成对的 <kN>（后台才会加「原样照抄」的说明）', async () => {
  const { hasKeepMarks } = await import(new URL('lib/prompt.js', root));
  const env = await boot({ config: { lazy: false, skipSameLang: false } });
  const DT = env.DT;
  let filler = '';
  for (let i = 0; i < 22; i += 1) filler += 'This is sentence number ' + i + ' in a long paragraph. ';
  let kept = '';
  for (let j = 0; j < 8; j += 1) kept += 'Kept line ' + j + ' stays. ';
  kept = kept.trim();
  const text = filler + kept + ' and then ' + filler.trim();
  const start = filler.length;
  const keep = [{ start, end: start + kept.length, text: kept }];
  const unit = {
    el: { ...fakeElement(), isConnected: true, getBoundingClientRect: () => ({ width: 600, height: 400, top: 0, bottom: 400 }) },
    text,
    keep,
    wire: DT.units.keepWrap(text, keep),
    index: 0,
    sentences: [],
    style: 'plain',
    own: false
  };
  const asked = [];
  const seen = [];
  DT.collectAll = () => [unit];
  DT.inject = (u, raw) => {
    seen.push(raw);
    return true;
  };
  DT.sourceChanged = () => false;
  DT.send = async (msg) => {
    if (msg.type === 'config:get') {
      return { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'translation', lazy: false, skipSameLang: false } };
    }
    if (msg.type === 'resume:get') return { ok: true, value: false };
    if (msg.type === 'translate') {
      asked.push(...msg.texts);
      return { ok: true, results: msg.texts.slice(), alignments: msg.texts.map(() => null) };
    }
    return { ok: true };
  };

  await env.message({ type: 'dt:toggle' });
  for (let i = 0; i < 6; i += 1) await flush();
  assert.ok(asked.length >= 2, '应切成多片：' + asked.length);
  const marked = asked.filter((x) => /<\/?k1>/.test(x));
  assert.equal(marked.length, 1, '保留区应完整落在一片里');
  assert.equal(hasKeepMarks(marked), true, '这一片要能让后台认出成对标记');
  assert.equal(seen.length, 1);
  assert.ok(DT.units.keepParse(seen[0], keep, text).segs, '拼回来的译文要能按标记切开');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
