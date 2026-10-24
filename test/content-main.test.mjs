// 内容脚本调度层（content/main.js）：在假页面里跑 core.js + main.js，只看它发给后台的消息和页面状态。
//   - 启动：只有顶层页面会自动开始翻译（刷新后恢复 / 打开网页自动翻译），iframe 不会
//     （弹窗和快捷键只控制主框架 frameId 0，iframe 自己开起来的话「还原原文」关不掉它）
//   - 配置广播：显示方式 / 目标语言真的变了才跟着改，翻译中要整页重建；没变就保留本页自己的选择
// 运行：node test/content-main.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { professionalProfileFor, normalizeProfessionalOptions } from '../lib/config.js';

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
    hasAttribute(k) {
      return k in this.attrs;
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
async function boot({ iframe = false, resume = false, translateOnLoad = false, config = {}, hooks = null, pageDocument = {} } = {}) {
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
      constructor(fn) {
        if (hooks) (hooks.observers || (hooks.observers = [])).push(fn);
      }
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
      createElement: fakeElement,
      ...pageDocument
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
  vm.runInContext(fs.readFileSync(new URL('lib/inline-protocol.js', root), 'utf8'), sandbox, { filename: 'inline-protocol.js' });
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
    document: sandbox.document,
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

await t('专业配置新字段：以实际渲染策略比较，质量/上限变化重建且同值不重建', async () => {
  const c = await boot({ resume: true, config: { professionalProfile: 'medical', medicalMode: false, professionalOptions: { quality: 'balanced', subdomain: 'auto', maxReviewRequests: 1 } } });
  assert.equal(c.DT.state.medicalMode, true, '显式 profile 优先于兼容字段');
  c.config.professionalOptions = { quality: 'strict', subdomain: 'auto', maxReviewRequests: 1 };
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, 1);
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, 1, '相同策略不能重复取消在途请求');
  c.config.professionalOptions.maxReviewRequests = 0;
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, 2);
  c.config.professionalProfile = 'general';
  await c.message({ type: 'dt:configChanged' });
  assert.equal(c.page.rebuilds, 3);
});

await t('专业配置 ES5 与 ESM 规范化差分：旧值、冲突、坏值和额外请求边界一致', async () => {
  const { DT } = await boot();
  const configs = [{}, { medicalMode: true }, { professionalProfile: 'general', medicalMode: true }, { professionalProfile: 'medical', medicalMode: false }, { professionalProfile: 'legal', medicalMode: true }];
  configs.forEach((cfg) => assert.equal(DT.professionalContext.profile(cfg), professionalProfileFor(cfg)));
  [undefined, null, [], {}, { quality: 'fast', maxReviewRequests: 0 }, { quality: 'strict', subdomain: 'oncology', maxReviewRequests: 9 }, { quality: 'unknown', subdomain: '<script>', maxReviewRequests: -1 }, { maxReviewRequests: 2.8 }, { maxReviewRequests: '2' }, { maxReviewRequests: null }, { maxReviewRequests: undefined }, { maxReviewRequests: Infinity }].forEach((options) => {
    assert.deepEqual(JSON.parse(JSON.stringify(DT.professionalContext.options(options))), normalizeProfessionalOptions(options));
  });
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
      assert.equal(msg.documentContext, undefined, '普通模式不应发送专业文档上下文');
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

// 混合行内内容：模型已经返回非空译文，DOM 注入却失败（结构不支持 / 落点定不下来）——
// 这不是「跳过」也不是「已处理」：要记下原因；页面没变就不再请求（不重复计费），页面变了才重新收集
await t('注入失败（模型已给译文、DOM 写不进去）：不算跳过 / 已处理，记 renderFailed；页面没变不再请求，页面变了再收', async () => {
  const hooks = { timers: [], listeners: {} };
  const env = await boot({ config: { lazy: true, skipSameLang: false }, hooks });
  const DT = env.DT;
  DT.generation = 1;
  const el = {
    ...fakeElement(),
    isConnected: true,
    getBoundingClientRect: () => ({ width: 600, height: 20, top: 0, bottom: 20 })
  };
  const unit = () => ({ el, text: 'Building on this work (10), see Fig. 1.', index: 0, gen: 1, sentences: [], style: 'plain' });
  let injects = 0;
  let stamp = 'dom-v1';
  const asked = [];
  DT.collectAll = (accept) => [unit()].filter((u) => !accept || accept(u));
  DT.unitStamp = () => stamp;
  DT.inject = (u, raw) => {
    injects += 1;
    assert.ok(raw && raw.length, '注入时手里确实有模型给的译文');
    u.injectResult = { code: 'unsafe-structure', reason: 'test-structure' };
    return false;
  };
  DT.sourceChanged = () => false;
  DT.send = async (msg) => {
    if (msg.type === 'config:get') {
      return { ok: true, config: { hasKey: true, targetLang: 'zh-CN', mode: 'translation', lazy: true, skipSameLang: false } };
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
  assert.equal(DT.state.skipped || 0, 0, '模型给了译文但写不进页面，不能静默算成「跳过」');
  assert.equal(DT.state.translated || 0, 0, '也不能算成翻译成功');
  assert.equal(DT.state.renderFailed, 1, '要记成注入失败');
  assert.match(DT.state.lastRenderError, /unsafe-structure: test-structure/);
  await rescan(hooks);
  await rescan(hooks);
  assert.equal(asked.length, 1, '页面没变：同一个确定性错误不再重新请求翻译');
  assert.equal(injects, 1);
  stamp = 'dom-v2'; // 页面更新了
  await rescan(hooks);
  assert.equal(asked.length, 2, '页面变了才重新收集（后台缓存里有译文，不会再调用模型）');
  assert.equal(injects, 2);
  assert.equal(DT.state.renderFailed, 1, '同一段只算一次失败');
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

function contextElement(tag, text = '', children = []) {
  const el = { ...fakeElement(), nodeType: 1, tagName: tag.toUpperCase(), isConnected: true };
  el.childNodes = text ? [{ nodeType: 3, nodeValue: text, parentElement: el }] : children;
  el.childNodes.forEach((child, index) => {
    child.parentElement = el;
    child.previousElementSibling = index ? el.childNodes[index - 1] : null;
    child.nextElementSibling = el.childNodes[index + 1] || null;
  });
  el.matches = (selector) => selector.split(',').some((part) => {
    const name = part.trim();
    if (name[0] === '.') return String(el.className || '').split(/\s+/).includes(name.slice(1));
    if (name === '[translate="no"]') return el.getAttribute('translate') === 'no';
    return name.toUpperCase() === el.tagName;
  });
  Object.defineProperty(el, 'textContent', { configurable: true, get() {
    return el.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join('');
  } });
  el.closest = (selector) => {
    for (let current = el; current; current = current.parentElement) if (current.matches && current.matches(selector)) return current;
    return null;
  };
  el.querySelectorAll = (selector) => {
    const out = [];
    const visit = (parent) => (parent.childNodes || []).forEach((child) => {
      if (child.nodeType !== 1) return;
      if (child.matches(selector)) out.push(child);
      visit(child);
    });
    visit(el);
    return out;
  };
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  el.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, bottom: 40 });
  return el;
}

function contextFixture(definition = 'progression-free survival (PFS) and overall survival (OS).') {
  const h1 = contextElement('h1', 'Oncology trial');
  const h2 = contextElement('h2', 'Results');
  const near = contextElement('p', definition);
  const current = contextElement('p', 'PFS was assessed in 39 patients.');
  const article = contextElement('article', '', [h1, h2, near, current]);
  const body = contextElement('body', '', [article]);
  const pageDocument = { title: '  Oncology   trial  ', querySelectorAll: body.querySelectorAll, querySelector: body.querySelector };
  return { h1, h2, near, current, article, body, pageDocument };
}

await t('文档上下文只读标题、章节与相邻可靠定义，只发送批次实际使用的缩写', async () => {
  const fixture = contextFixture();
  Object.defineProperty(fixture.article, 'textContent', { get() { throw new Error('不能读取全文'); } });
  const { DT } = await boot({ pageDocument: fixture.pageDocument });
  const context = JSON.parse(JSON.stringify(DT.professionalContext.collect([{ el: fixture.current, text: 'PFS was assessed in 39 patients.' }])));
  assert.equal(context.title, 'Oncology trial');
  assert.deepEqual(context.headings, ['Oncology trial', 'Results']);
  assert.deepEqual(context.abbreviations, { PFS: 'progression-free survival' });
  assert.equal(JSON.stringify(context).includes('39 patients'), false, '正文不进入文档上下文');
  assert.deepEqual(Object.keys(context).sort(), ['abbreviations', 'headings', 'title']);
});

await t('缩写定义不猜测、不跨论文保留，冲突定义和混合论文批次不注入', async () => {
  const a = contextFixture('overall survival (OS); observation score (OS); unrelated phrase (PFS).');
  const { DT } = await boot({ pageDocument: a.pageDocument });
  const collect = DT.professionalContext.collect;
  assert.deepEqual(JSON.parse(JSON.stringify(collect([{ el: a.current, text: 'OS and PFS were recorded.' }]).abbreviations)), {});
  const b = contextFixture();
  assert.equal(collect([{ el: b.current, text: 'PFS was recorded.' }]).abbreviations.PFS, 'progression-free survival');
  const c = contextFixture('No abbreviation definition in this paper.');
  assert.deepEqual(JSON.parse(JSON.stringify(collect([{ el: c.current, text: 'PFS was recorded.' }]).abbreviations)), {});
  const mixed = collect([{ el: b.current, text: 'PFS was recorded.' }, { el: c.current, text: 'PFS has a different meaning.' }]);
  assert.equal(mixed.headings.length, 0);
  assert.equal(Object.keys(mixed.abbreviations).length, 0);
});

await t('文档上下文有预算，忽略扩展译文；仅译文标题从现有还原记录读原文', async () => {
  const fixture = contextFixture();
  const injected = contextElement('span', '不应进入提示词的标题译文');
  injected.setAttribute('data-dt-target', '');
  fixture.h1.childNodes.push(injected);
  const { DT, document } = await boot({ pageDocument: fixture.pageDocument });
  DT.replacedOf = (el) => el === fixture.h2 ? { src: 'Original results' } : null;
  let snapshot = DT.professionalContext.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.headings)), ['Oncology trial', 'Original results']);
  document.title = 'X'.repeat(1000);
  fixture.article.childNodes = Array.from({ length: 50 }, (_, i) => contextElement('h2', `${i} ${'Section '.repeat(40)}`));
  fixture.article.childNodes.forEach((el) => { el.parentElement = fixture.article; });
  snapshot = DT.professionalContext.snapshot();
  assert.equal(snapshot.title.length, 240);
  assert.ok(snapshot.headings.length <= 8);
  assert.ok(snapshot.headings.join('').length <= 600);
});

function installTranslationFixture(env, unit, reply) {
  const injected = [];
  env.DT.collectAll = () => [unit];
  env.DT.inject = (item, text) => { injected.push(text); return true; };
  env.DT.sourceChanged = () => false;
  env.DT.isOwnWrite = () => false;
  env.DT.send = async (msg) => {
    if (msg.type === 'config:get') return { ok: true, config: env.config };
    if (msg.type === 'resume:get') return { ok: true, value: false };
    if (msg.type === 'translate') return reply(msg);
    return { ok: true };
  };
  return injected;
}

await t('医学消息发送轻量上下文，疑点只计入状态，不自动修改模型译文', async () => {
  const fixture = contextFixture();
  const env = await boot({ config: { professionalProfile: 'medical', lazy: false, skipSameLang: false }, pageDocument: fixture.pageDocument });
  const unit = { el: fixture.current, text: 'PFS was assessed in 39 patients.', own: false, style: 'plain' };
  let requested;
  const injected = installTranslationFixture(env, unit, (msg) => {
    requested = msg;
    return { ok: true, results: ['39例患者接受了PFS评估。'], validations: [{ status: 'review', issues: [{ message: '数值对应关系需要审查' }] }] };
  });
  await env.message({ type: 'dt:toggle' });
  assert.equal(requested.documentContext.abbreviations.PFS, 'progression-free survival');
  assert.deepEqual(injected, ['39例患者接受了PFS评估。']);
  const status = await env.message({ type: 'dt:status' });
  assert.equal(status.qualityWarnings, 1);
  assert.equal(status.lastQualityWarning, '数值对应关系需要审查');
});

await t('在途翻译切换质量：旧策略回包作废，不混入新策略译文', async () => {
  const fixture = contextFixture();
  const env = await boot({ config: { professionalProfile: 'medical', professionalOptions: { quality: 'balanced' }, lazy: false, skipSameLang: false }, pageDocument: fixture.pageDocument });
  const unit = { el: fixture.current, text: 'PFS was assessed in 39 patients.', own: false, style: 'plain' };
  let resolveOld;
  let calls = 0;
  const injected = installTranslationFixture(env, unit, () => {
    calls += 1;
    return calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : { ok: true, results: ['严格策略译文。'] };
  });
  await env.message({ type: 'dt:toggle' });
  assert.equal(calls, 1);
  env.config.professionalOptions = { quality: 'strict' };
  await env.message({ type: 'dt:configChanged' });
  resolveOld({ ok: true, results: ['过期的标准策略译文。'] });
  await flush();
  assert.deepEqual(injected, ['严格策略译文。']);
  assert.equal(env.page.rebuilds, 1);
});

await t('在途翻译期间文档标题变化：丢弃旧上下文结果并重建', async () => {
  const fixture = contextFixture();
  const hooks = { timers: [], listeners: {} };
  const env = await boot({ config: { professionalProfile: 'medical', lazy: false, skipSameLang: false }, hooks, pageDocument: fixture.pageDocument });
  const unit = { el: fixture.current, text: 'PFS was assessed in 39 patients.', own: false, style: 'plain' };
  let resolveOld;
  const contexts = [];
  const injected = installTranslationFixture(env, unit, (msg) => {
    contexts.push(msg.documentContext.title);
    return contexts.length === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : { ok: true, results: ['新论文译文。'] };
  });
  await env.message({ type: 'dt:toggle' });
  env.document.title = 'A different oncology paper';
  const title = contextElement('title', env.document.title);
  hooks.observers[0]([{ type: 'characterData', target: title.childNodes[0] }]);
  resolveOld({ ok: true, results: ['旧论文译文。'] });
  await flush();
  assert.deepEqual(injected, ['新论文译文。']);
  assert.deepEqual(contexts, ['Oncology trial', 'A different oncology paper']);
  assert.equal(env.page.rebuilds, 1);
});

await t('v1与普通文本分批；格式段不再要求额外的模型句子对齐', async () => {
  const env = await boot({ config: { lazy: false, skipSameLang: false, concurrency: 1 } });
  const make = (text, inlineProtocol = '') => ({
    el: contextElement('p', text), text, wire: inlineProtocol ? '<f1>' + text + '</f1>' : text,
    inlineProtocol, sentences: [{ text: 'first.' }, { text: 'second.' }], style: 'plain'
  });
  const units = [make('Inline first. Inline second.', 'v1'), make('Ordinary first. Ordinary second.')];
  const asked = [];
  env.DT.collectAll = () => units;
  env.DT.sourceChanged = () => false;
  env.DT.inject = () => true;
  env.DT.send = async (msg) => {
    if (msg.type !== 'translate') return { ok: true };
    asked.push(msg);
    return { ok: true, results: msg.texts.map((text) => '译：' + text) };
  };
  await env.message({ type: 'dt:toggle' });
  assert.equal(asked.length, 2);
  assert.equal(asked[0].inlineProtocol, 'v1');
  assert.equal(asked[0].align, false);
  assert.equal(asked[1].inlineProtocol, undefined);
  assert.equal(asked[1].texts.length, 1);
});

await t('同视口交错普通/格式段落按协议装满小批，避免每段产生一个请求', async () => {
  const env = await boot({ config: { lazy: false, skipSameLang: false, concurrency: 1 } });
  const units = Array.from({ length: 6 }, (_, index) => ({
    el: contextElement('p', 'Paragraph ' + index), text: 'Paragraph ' + index,
    wire: index % 2 ? 'Paragraph ' + index : '<f1>Paragraph</f1> ' + index,
    inlineProtocol: index % 2 ? '' : 'v1', style: 'plain', sentences: []
  }));
  const asked = [];
  env.DT.collectAll = () => units;
  env.DT.sourceChanged = () => false;
  env.DT.inject = () => true;
  env.DT.send = async (msg) => {
    if (msg.type !== 'translate') return { ok: true };
    asked.push(msg);
    return { ok: true, results: msg.texts.map((text) => '译：' + text) };
  };
  await env.message({ type: 'dt:toggle' });
  assert.equal(asked.length, 2, '6个交错段落只需2个兼容批次，而非6次单条请求');
  assert.deepEqual(asked.map((msg) => msg.texts.length), [3, 3]);
  assert.ok(asked[0].texts.every((text) => text.includes('<f1>')));
  assert.ok(asked[1].texts.every((text) => !text.includes('<f1>')));
});

await t('确定性v1错误不注入、不退避重试、不发送同段剩余切片；DOM变化才重新请求', async () => {
  const hooks = { timers: [], listeners: {} };
  const env = await boot({ hooks, config: { lazy: true, skipSameLang: false, concurrency: 1, maxUnitChars: 200 } });
  const text = 'Source sentence with enough words to form several safe slices. '.repeat(35);
  const el = contextElement('p', text);
  let stamp = 'initial';
  const asked = [];
  let injected = 0;
  env.DT.collectAll = (accept) => [{ el, text, wire: '<f1>Source</f1>' + text.slice(6), inlineProtocol: 'v1', sentences: [], style: 'plain' }].filter(accept);
  env.DT.unitStamp = () => stamp;
  env.DT.sourceChanged = () => false;
  env.DT.inject = () => { injected += 1; return true; };
  env.DT.send = async (msg) => {
    if (msg.type !== 'translate') return { ok: true };
    asked.push(msg);
    return { ok: true, results: msg.texts.map(() => null), inlineErrors: msg.texts.map(() => 'atom-missing') };
  };
  await env.message({ type: 'dt:toggle' });
  assert.equal(injected, 0);
  assert.equal(asked.length, 1, '首批确定性失败后，不再发送该段剩余切片');
  assert.equal(env.DT.state.renderFailed, 1);
  assert.equal(env.DT.state.translated || 0, 0);
  assert.equal(env.DT.state.skipped || 0, 0);
  assert.match(env.DT.state.lastRenderError, /invalid-inline: atom-missing/);
  await rescan(hooks);
  await rescan(hooks);
  assert.equal(asked.length, 1, '未变更段落不产生新请求');
  stamp = 'changed-structure';
  await rescan(hooks);
  assert.equal(asked.length, 2);
});

await t('长段落切分保留嵌套f/k和原子内换行，拼回源文逐字一致', async () => {
  const { inspectInline } = await import('../lib/inline.js');
  const { DT } = await boot();
  const atom = '<k1><f2>safe link\nlabel. Still the same label.</f2></k1>';
  const wire = 'Opening sentence. '.repeat(25) + '<f1>emphasis. Inside emphasis.</f1> ' + atom + '\n' + 'Following sentence. '.repeat(30).trim();
  const parts = DT.splitLong(wire, 200, 'v1');
  assert.ok(parts.length > 2);
  assert.equal(parts.filter((part) => part.includes('<k1>')).length, 1);
  assert.ok(parts.some((part) => part.includes(atom)));
  for (const part of parts) assert.equal(inspectInline(part, part).ok, true, part);
  assert.equal(DT.joinSlots(parts, parts.seps), wire);
});

await t('保护内容不会从标题、父级保护章节、相邻定义或已替换src重新进入专业上下文', async () => {
  const secret = 'private account secret';
  const protectedHeading = contextElement('h2', secret);
  const wrapper = contextElement('section', '', [protectedHeading]);
  wrapper.className = 'notranslate';
  const excluded = contextElement('h2', 'SiteExcludedSecret');
  excluded.className = 'fixture-site-excluded';
  const f = contextFixture();
  f.near.setAttribute('translate', 'no');
  const hidden = contextElement('span', 'ReplacedSecret');
  hidden.className = 'notranslate';
  f.h1.childNodes.push(hidden);
  hidden.parentElement = f.h1;
  f.article.childNodes.push(wrapper, excluded);
  wrapper.parentElement = excluded.parentElement = f.article;
  f.pageDocument.title = secret + ' | ' + 'SiteExcludedSecret | ReplacedSecret | Oncology trial';
  const env = await boot({ config: { page: { site: { excludeSelectors: ['.fixture-site-excluded'] } } }, pageDocument: f.pageDocument });
  env.DT.replacedOf = (el) => el === f.h1 ? { src: 'Oncology trial ReplacedSecret' } : null;
  const context = env.DT.professionalContext.collect([{ el: f.current, text: 'PFS was assessed.' }]);
  const json = JSON.stringify(context);
  for (const value of [secret, 'SiteExcludedSecret', 'ReplacedSecret', 'progression-free survival']) assert.equal(json.includes(value), false, value);
  assert.equal(context.title, '', '无法将保护文本可靠映射到标题时省略标题元数据');
});

await t('标题只包含保护文本的一部分时也不外发；普通正文的字面f不破坏旧k切片', async () => {
  const f = contextFixture();
  f.near.className = 'notranslate';
  f.near.childNodes[0].nodeValue = 'SecretCustomerID 78423';
  f.pageDocument.title = 'SecretCustomerID | Oncology trial';
  const { DT } = await boot({ pageDocument: f.pageDocument });
  assert.equal(DT.professionalContext.collect([{ el: f.current, text: 'PFS was assessed.' }]).title, '');
  const atom = '<k1>' + 'long protected sentence. '.repeat(36) + '</k1>';
  const wire = 'Literal <f1> ' + 'prefix sentence. '.repeat(12) + atom + ' closing.';
  const parts = DT.splitLong(wire, 200);
  assert.equal(parts.filter((part) => part.includes(atom)).length, 1);
  assert.equal(DT.joinSlots(parts, parts.seps), wire);
});

await t('跨格式边界的缩写仍匹配相邻可靠定义，保护区不从本地原文恢复到上下文', async () => {
  const fixture = contextFixture();
  const env = await boot({ config: { professionalProfile: 'medical', lazy: false, skipSameLang: false }, pageDocument: fixture.pageDocument });
  const unit = { el: fixture.current, text: 'PFS was assessed. PrivateSecret', wire: 'P<f1>FS</f1> was assessed.<k1></k1>', inlineProtocol: 'v1', sentences: [], style: 'plain' };
  let requested;
  installTranslationFixture(env, unit, (msg) => { requested = msg; return { ok: true, results: ['<f1>有效</f1>译文<k1></k1>'] }; });
  await env.message({ type: 'dt:toggle' });
  assert.equal(requested.documentContext.abbreviations.PFS, 'progression-free survival');
  assert.equal(JSON.stringify(requested).includes('PrivateSecret'), false);
  assert.ok(requested.texts[0].includes('<f1>FS</f1>'));
});

await t('Shadow适配页省略标题元数据；源标记冲突与保护内容共存时零请求且不重试', async () => {
  const hooks = { timers: [], listeners: {} };
  const env = await boot({ hooks, config: { lazy: false, skipSameLang: false }, pageDocument: { title: 'ShadowPrivateSecret | Trial' } });
  env.DT.shadow = { active: () => true };
  assert.equal(env.DT.professionalContext.snapshot().title, '');
  env.DT.shadow = null;
  const el = contextElement('p', 'Literal <f99> with PrivateSecret.');
  let asked = 0;
  env.DT.collectAll = (accept) => [{ el, text: el.textContent, inlineIssue: 'reserved-marker-source', inlineProtocol: 'v1', wire: '', sentences: [], style: 'plain' }].filter(accept);
  env.DT.sourceChanged = () => false;
  env.DT.send = async (msg) => { if (msg.type === 'translate') asked += 1; return { ok: true }; };
  await env.message({ type: 'dt:toggle' });
  assert.equal(asked, 0);
  assert.equal(env.DT.state.renderFailed, 1);
  assert.match(env.DT.state.lastRenderError, /reserved-marker-source/);
  await rescan(hooks);
  assert.equal(asked, 0);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
