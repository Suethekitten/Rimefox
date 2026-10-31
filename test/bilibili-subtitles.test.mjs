// Bilibili 字幕适配、解析、生命周期、费用与安全回归。
// 运行：node test/bilibili-subtitles.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isTrustedBilibiliSubtitleUrl as libTrusted, readTextCapped } from '../lib/subtitle-source.js';

const root = new URL('..', import.meta.url);
const sandbox = { console, setTimeout, clearTimeout, setImmediate, Promise, URL, URLSearchParams, TextDecoder };
sandbox.window = sandbox;
sandbox.__DT = {
  log: function () {},
  toast: function () {},
  STYLE_IDS: ['plain', 'classical', 'catgirl'],
  state: {},
  subtitleSource: {
    platform: 'youtube',
    take: function () { return null; },
    resolve: function () { return null; },
    replay: function () {},
    player: function () { return null; },
    captionsOn: function () { return false; },
    matches: function () { return true; },
    hideNativeCss: ''
  }
};
vm.createContext(sandbox);
for (const file of ['content/subtitles-core.js', 'content/subtitles.js']) {
  vm.runInContext(fs.readFileSync(new URL(file, root), 'utf8'), sandbox, { filename: file });
}
const subs = sandbox.__DT.subs;
const runtimeCreate = sandbox.__DT.subtitleRuntime && sandbox.__DT.subtitleRuntime.create;
assert.equal(typeof runtimeCreate, 'function', 'subtitles.js 未导出 createRuntime');

// Bilibili 来源层单独加载；load 时 location 只是普通站点，不会自动接管。
sandbox.location = { hostname: 'example.com', pathname: '/', search: '' };
vm.runInContext(fs.readFileSync(new URL('content/bilibili-subtitles-source.js', root), 'utf8'), sandbox, {
  filename: 'content/bilibili-subtitles-source.js'
});
const createBiliSource = sandbox.__DT.bilibiliSubtitleSource && sandbox.__DT.bilibiliSubtitleSource.create;
assert.equal(typeof createBiliSource, 'function', 'bilibili-subtitles-source.js 未导出 create');
delete sandbox.location;

let pass = 0;
let fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass += 1; console.log('  ✓ ' + name); })
    .catch(function (err) { fail += 1; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); });
}
function eq(actual, expected, msg) {
  // vm 里的数组原型与宿主不同，统一转成 JSON 值再比较。
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
  return { promise: promise, resolve: resolve, reject: reject };
}
function flush() {
  return new Promise(function (r) { setImmediate(r); }).then(function () {
    return new Promise(function (r) { setImmediate(r); });
  });
}

// ---------------- 合成 fixture（不含真实字幕正文 / Cookie / 令牌） ----------------
const SAFE_URL = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/demo?auth_key=fake';
const SAFE_HUMAN_URL = 'https://i0.hdslb.com/bfs/subtitle/demo.json';
function bodyOf(items) {
  return JSON.stringify({
    font_size: 0.4,
    font_color: '#FFFFFF',
    background_alpha: 0.5,
    body: items.map(function (x, i) {
      return { from: x[0], to: x[1], content: x[2], sid: i + 1 };
    })
  });
}
function trackOf(lan, url, extra) {
  return Object.assign({ id: lan + '-id', id_str: lan + '-id', lan: lan, lan_doc: lan, subtitle_url: url, type: 1 }, extra || {});
}
function playerPayload(opts) {
  const o = opts || {};
  const bvid = o.bvid || 'BV1xx411c7mD';
  const cid = o.cid || 1001;
  return {
    code: 0,
    message: 'OK',
    data: {
      aid: 9001,
      bvid: bvid,
      cid: cid,
      page_no: o.page || 1,
      subtitle: {
        lan: o.selectedLan || '',
        subtitles: o.tracks || [trackOf('ai-zh', SAFE_URL)]
      }
    }
  };
}
function messageFor(opts, seq) {
  return {
    source: 'rimefox-bili',
    type: 'player',
    seq: seq === undefined ? 1 : seq,
    body: JSON.stringify(playerPayload(opts))
  };
}

// ---------------- 假 DOM ----------------
function makeEl(tag, doc) {
  const e = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null, style: {}, textContent: '', id: '',
    _attrs: {}, _classes: new Set(), clientHeight: 720, className: ''
  };
  e.classList = {
    add: function (c) { e._classes.add(c); if (c === 'rimefox-subs') e.className = c; },
    remove: function (c) { e._classes.delete(c); if (c === 'rimefox-subs') e.className = ''; },
    contains: function (c) { return e._classes.has(c); }
  };
  e.setAttribute = function (k, v) { e._attrs[k] = String(v); if (k === 'id') e.id = String(v); };
  e.getAttribute = function (k) { return e._attrs[k] === undefined ? null : e._attrs[k]; };
  e.appendChild = function (child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = e;
    e.children.push(child);
    return child;
  };
  e.removeChild = function (child) {
    const i = e.children.indexOf(child);
    if (i >= 0) e.children.splice(i, 1);
    child.parentNode = null;
  };
  e.remove = function () { if (e.parentNode) e.parentNode.removeChild(e); };
  e.querySelector = function (selector) {
    if (selector === '.ytp-subtitles-button') return e._captionBtn || null;
    if (selector === '.bpx-player-ctrl-subtitle-language-item.bpx-state-active') return e._activeItem || null;
    return null;
  };
  e.querySelectorAll = function () { return []; };
  Object.defineProperty(e, 'isConnected', {
    get: function () {
      let p = e;
      while (p) {
        if (p === doc.body || p === doc.head) return true;
        p = p.parentNode;
      }
      return false;
    }
  });
  return e;
}
function makeDoc(state) {
  const doc = {};
  const head = makeEl('head', doc);
  const body = makeEl('body', doc);
  doc.head = head;
  doc.body = body;
  doc.documentElement = body;
  doc.createElement = function (tag) { return makeEl(tag, doc); };
  doc.getElementById = function (id) { return findById([head, body], id); };
  doc.querySelectorAll = function (selector) {
    if (selector === '.rimefox-subs-on') return all(body).filter(function (e) { return e.classList.contains('rimefox-subs-on'); });
    if (selector === '.rimefox-subs') return all(body).filter(function (e) { return e.classList.contains('rimefox-subs'); });
    return [];
  };
  doc.querySelector = function (selector) {
    if (selector === '.bpx-player-ctrl-subtitle-language-item.bpx-state-active') {
      if (state.activeItem) return state.activeItem;
      return state.lan ? activeItem(state.lan) : null;
    }
    if (selector === '#bilibili-player .bpx-player-subtitle-wrap' || selector === '.bpx-player-subtitle-wrap') return state.wrap || null;
    return null;
  };
  return doc;
}
function all(e, out) {
  out = out || [];
  out.push(e);
  e.children.forEach(function (c) { all(c, out); });
  return out;
}
function findById(roots, id) {
  for (const root of roots) {
    const hit = all(root).find(function (e) { return e.id === id; });
    if (hit) return hit;
  }
  return null;
}
function activeItem(lan) {
  return { getAttribute: function (k) { return k === 'data-lan' ? lan : null; } };
}

console.log('\n[Bilibili 字幕解析]');

await t('人工字幕：from/to 秒转毫秒、空白清理、顺序保持、句末合并', function () {
  const json = JSON.parse(bodyOf([
    [1.2, 4.5, '  Hello   everyone.  '],
    [4.6, 7.8, 'Welcome back.'],
    [8.0, 9.0, ''],
    [9.2, 10.0, '   ']
  ]));
  const units = subs.bilibiliUnits(json);
  eq(units.map(function (u) { return u.text; }), ['Hello everyone.', 'Welcome back.']);
  eq(units[0].start, 1200);
  eq(units[0].end, 4500);
  eq(units[1].start, 4600);
});

await t('没有句末标点的连续字幕（中文 / AI 字幕常见）逐段保留时间轴，不拼成长块、不插空格', function () {
  const zh = ['大家好欢迎来到我的频道', '今天我们来聊一聊人工智能', '它正在改变我们的生活', '从手机里的语音助手', '到自动驾驶汽车',
    '再到医院里的影像诊断', '很多事情都已经不一样了', '但是它也带来了一些问题', '比如隐私和就业', '我们应该怎么看待', '这就是今天的主题',
    '希望大家喜欢', '记得一键三连', '我们下期再见'];
  const units = subs.bilibiliUnits(JSON.parse(bodyOf(zh.map(function (text, i) { return [i * 2.4, i * 2.4 + 2.35, text]; }))));
  eq(units.length, zh.length);
  eq(units.map(function (u) { return u.text; }), zh);
  assert.ok(units.every(function (u) { return u.end - u.start <= 2400; }), '每段仍是原来的约 2.4 秒');
  const en = ['so today we are going to talk', 'about how this model works', 'and why it matters for', 'everyone who uses it'];
  eq(subs.bilibiliUnits(JSON.parse(bodyOf(en.map(function (text, i) { return [i * 1.6, i * 1.6 + 1.55, text]; })))).length, en.length);
});

await t('AI 中文字幕：ai-zh 识别为中文，轨道 kind=asr，时间轴正确', function () {
  const json = JSON.parse(bodyOf([[31.9, 32.72, '晚上好。'], [32.8, 35.0, '欢迎回来。']]));
  const track = subs.bilibiliTrack(json, {
    bvid: 'BV1xx411c7mD', cid: '1001', track: trackOf('ai-zh', SAFE_URL)
  });
  eq(track.platform, 'bilibili');
  eq(track.lang, 'zh-CN');
  eq(track.kind, 'asr');
  eq(track.units.length, 2);
  eq(track.units[0].start, 31900);
  assert.equal(subs.sameLanguage('ai-zh', 'zh-CN'), true);
  assert.equal(subs.sameLanguage('ai-en', 'en-US'), true);
});

await t('空字幕、错误结构、非法时间、重复、超长和乱序都被安全处理', function () {
  eq(subs.bilibiliUnits({}), []);
  eq(subs.bilibiliUnits({ body: null }), []);
  const json = JSON.parse(bodyOf([
    [3, 4, 'Third.'],
    [1, 2, 'First.'],
    [1, 2, 'First.'],
    [-1, 2, 'Negative.'],
    [5, 5, 'Zero.'],
    [6, 7, '   '],
    [8, 9, 'x'.repeat(2001)],
    [10, 11, 'Last.']
  ]));
  const units = subs.bilibiliUnits(json);
  eq(units.map(function (u) { return u.text; }), ['First.', 'Third.', 'Last.']);
});

await t('多语言轨道：ai-zh / zh-CN / en-US 都能按语言匹配', function () {
  const json = JSON.parse(bodyOf([[1, 2, '你好']]));
  const zh = subs.bilibiliTrack(json, { bvid: 'BV1xx411c7mD', cid: '1', track: trackOf('zh-CN', SAFE_HUMAN_URL) });
  const en = subs.bilibiliTrack(json, { bvid: 'BV1xx411c7mD', cid: '1', track: trackOf('en-US', SAFE_HUMAN_URL) });
  eq(zh.lang, 'zh-CN');
  eq(en.lang, 'en-US');
  assert.equal(subs.sameLanguage(zh.lang, 'zh-Hans'), true);
  assert.equal(subs.sameLanguage(en.lang, 'en'), true);
  assert.equal(subs.sameLanguage(zh.lang, 'en'), false);
});

await t('字幕 HTML 不会被当作 DOM 执行，保留为纯文本', function () {
  const json = JSON.parse(bodyOf([[1, 2, '<img src=x onerror=alert(1)>plain']]));
  const units = subs.bilibiliUnits(json);
  eq(units[0].text, '<img src=x onerror=alert(1)>plain');
});

console.log('\n[Bilibili 来源适配]');

await t('播放器回包 → 当前语言轨道 → 取 CDN JSON → 统一轨道', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const calls = [];
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function (msg) {
      calls.push(msg);
      return { ok: true, text: bodyOf([[1.2, 2.5, '你好']]) };
    }
  });
  assert.equal(source.accept(messageFor({ selectedLan: 'ai-zh' }, 1)), true);
  const ev = source.take();
  assert.ok(ev, '应产出轨道事件');
  eq(ev.track.lan, 'ai-zh');
  const track = await source.resolve(ev);
  assert.ok(track);
  eq(track.videoKey, 'BV1xx411c7mD:1001');
  eq(track.units[0].start, 1200);
  eq(calls[0].type, 'subtitle:fetch');
  assert.match(calls[0].url, /^https:\/\/aisubtitle\.hdslb\.com\//);
});

await t('只选播放器当前激活的语言；切换到英文后重新产出英文轨道', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'text']]) }; }
  });
  source.accept(messageFor({
    tracks: [trackOf('ai-zh', SAFE_URL), trackOf('en-US', SAFE_HUMAN_URL)],
    selectedLan: 'ai-zh'
  }, 1));
  eq(source.take().track.lan, 'ai-zh');
  state.lan = 'en-US';
  eq(source.take().track.lan, 'en-US');
  state.lan = 'ai-zh';
  eq(source.take().track.lan, 'ai-zh');
});

await t('旧视频 / 晚到的回包不能覆盖新视频；分 P cid 变化会产出新身份', async function () {
  const state = { lan: 'zh-CN' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1001 }, 2));
  const p1 = source.take();
  eq(p1.meta.cid, '1001');
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1002 }, 3));
  const p2 = source.take();
  eq(p2.meta.cid, '1002');
  assert.notEqual(p1.key, p2.key);
  // 旧代际（seq 更小）晚到，不能覆盖
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1001 }, 1));
  assert.equal(source.inspect().meta.cid, '1002');
  // 地址栏换到另一个 BV 之前，旧 BV 的元数据不能先接管
  source.accept(messageFor({ bvid: 'BV2yy411c7mE', cid: 2001 }, 4));
  assert.equal(source.take(), null, '地址栏尚未更新时先留着');
});

await t('字幕 CDN 白名单拒绝任意 / 非 HTTPS / 非官方地址', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  let calls = 0;
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { calls += 1; return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  assert.equal(source.accept(messageFor({ tracks: [trackOf('ai-zh', 'https://evil.example/x.json')] }, 1)), true);
  assert.equal(source.take(), null, '不可信 URL 不进入轨道选择');
  eq(calls, 0);
  assert.equal(libTrusted(SAFE_URL), true);
  assert.equal(libTrusted(SAFE_HUMAN_URL), true);
  assert.equal(libTrusted('http://aisubtitle.hdslb.com/bfs/ai_subtitle/x'), false);
  assert.equal(libTrusted('https://evil.example/x.json'), false);
  assert.equal(libTrusted('https://aisubtitle.hdslb.com/other'), false);
  assert.equal(libTrusted('javascript:alert(1)'), false);
  // 内容脚本与后台的白名单必须完全一致
  const values = [SAFE_URL, SAFE_HUMAN_URL, 'http://aisubtitle.hdslb.com/bfs/ai_subtitle/x', 'https://evil.example/x.json',
    'https://aisubtitle.hdslb.com/other', 'https://i0.hdslb.com/bfs/other/x', 'javascript:alert(1)', '//aisubtitle.hdslb.com/bfs/ai_subtitle/x'];
  values.forEach(function (v) { assert.equal(subs.isTrustedBilibiliSubtitleUrl(v), libTrusted(v), v); });
});

await t('没有字幕轨道 / 空 subtitle 不产出事件，也不发请求', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  let calls = 0;
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { calls += 1; return { ok: true, text: '{}' }; }
  });
  source.accept(messageFor({ tracks: [] }, 1));
  assert.equal(source.take(), null);
  assert.equal(source.status(), 'none');
  eq(calls, 0);
});

await t('语言前缀 URL（/zh-Hans/video/）仍能匹配当前视频', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/zh-Hans/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1001 }, 1));
  const ev = source.take();
  assert.ok(ev);
  eq(source.videoKey(), 'BV1xx411c7mD:1001');
});

await t('分 P URL 的 p 号与轨道不一致时，旧 P 轨道立即失效', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '?p=2' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1001, page: 1 }, 1));
  const p1 = await source.resolve(source.take());
  assert.ok(p1);
  assert.equal(source.matches(p1), false, 'P1 轨道不能在 URL p=2 时继续显示');
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1002, page: 2 }, 2));
  const p2 = await source.resolve(source.take());
  assert.ok(p2);
  assert.equal(source.matches(p2), true);
  assert.equal(source.matches(Object.assign({}, p2, { page: 1 })), false);
});

await t('active class 缺失但原生字幕可见时，用播放器元数据选择唯一轨道', async function () {
  const state = { lan: '', wrap: { getClientRects: function () { return [1]; } } };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ tracks: [trackOf('ai-zh', SAFE_URL)], selectedLan: 'ai-zh' }, 1));
  const ev = source.take();
  assert.ok(ev, '应使用 selectedLan 兜底');
  assert.equal(ev.track.lan, 'ai-zh');
  assert.equal(source.captionsOn(), true);
});

await t('换到另一种语言（元数据里没有 / 尚未取到）时旧轨道立即失效，不再盖住原生字幕', async function () {
  const state = { lan: 'en-US' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'Hello.']]) }; }
  });
  source.accept(messageFor({ tracks: [trackOf('en-US', SAFE_HUMAN_URL), trackOf('ai-zh', SAFE_URL)], selectedLan: 'en-US' }, 1));
  const track = await source.resolve(source.take());
  assert.ok(track);
  assert.equal(source.matches(track), true, '选中的就是这条轨道');
  state.lan = 'ja';
  assert.equal(source.matches(track), false, '元数据里没有 ja：交还原生字幕');
  state.lan = 'ai-zh';
  assert.equal(source.matches(track), false, '换成另一条轨道（新轨道还没取到）：旧轨道不能继续显示');
  state.lan = 'en-US';
  assert.equal(source.matches(track), true);
});

await t('取字幕失败一次后按退避重试；播放器新回包（新签名地址）立即重试', async function () {
  const state = { lan: 'en-US' };
  const doc = makeDoc(state);
  let clock = 10000;
  let failNext = 2;
  let fetches = 0;
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    now: function () { return clock; },
    send: async function () {
      fetches += 1;
      if (failNext > 0) { failNext -= 1; return { ok: false, error: 'http' }; }
      return { ok: true, text: bodyOf([[1, 2, 'Hello.']]) };
    }
  });
  source.accept(messageFor({ tracks: [trackOf('en-US', SAFE_HUMAN_URL)], selectedLan: 'en-US' }, 1));
  assert.equal(await source.resolve(source.take()), null, '第一次失败');
  assert.equal(source.take(), null, '退避期内不重试');
  clock += 3500;
  const retry = source.take();
  assert.ok(retry, '退避到期后重试同一条轨道');
  assert.equal(await source.resolve(retry), null, '第二次也失败');
  clock += 1000;
  assert.equal(source.take(), null, '第二次退避更长');
  source.accept(messageFor({ tracks: [trackOf('en-US', SAFE_HUMAN_URL)], selectedLan: 'en-US' }, 2));
  const fresh = source.take();
  assert.ok(fresh, '播放器新回包立即可以再取');
  assert.ok(await source.resolve(fresh), '这次成功');
  assert.equal(source.take(), null, '成功后不再重复产出');
  assert.equal(fetches, 3);
});

await t('收起原生字幕用透明而不是 display:none，接管本身不会让兜底判定成「CC 关了」', function () {
  const state = { lan: '', wrap: { getClientRects: function () { return [1]; } } };
  const source = createBiliSource({
    doc: makeDoc(state),
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  assert.equal(/display\s*:\s*none/.test(source.hideNativeCss), false);
  assert.match(source.hideNativeCss, /\.rimefox-subs-on \.bpx-player-subtitle-wrap[^{]*\{[^}]*opacity:0 !important/);
});

await t('没有 active 类、元数据也没给语言、只有一条轨道：take 与 captionsOn 一致，能接管', async function () {
  const state = { lan: '', wrap: { getClientRects: function () { return [1]; } } };
  const source = createBiliSource({
    doc: makeDoc(state),
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ tracks: [trackOf('en-US', SAFE_HUMAN_URL)], selectedLan: '' }, 1));
  const ev = source.take();
  assert.ok(ev, '唯一轨道兜底');
  assert.equal(source.captionsOn(), true, 'captionsOn 也要认唯一轨道，否则取了字幕却永远不显示');
  const track = await source.resolve(ev);
  assert.equal(source.matches(track), true);
});

await t('关闭 CC 但 active 选中项仍在：captionsOn 必须让位，不能继续显示译文叠层', async function () {
  const state = { lan: 'ai-zh', wrap: { getClientRects: function () { return []; } } };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ tracks: [trackOf('ai-zh', SAFE_URL)], selectedLan: 'ai-zh' }, 1));
  assert.equal(source.captionsOn(), false, '原生字幕层不可见时，active class 不能单独让扩展接管');
  state.wrap = { getClientRects: function () { return [1]; } };
  assert.equal(source.captionsOn(), true, '原生字幕层恢复可见后继续接管');
});

console.log('\n[Bilibili 运行时：隔离 / 懒翻译 / 渲染]');

function setupRuntime() {
  const state = {
    enabled: true,
    target: 'zh-CN',
    targetCode: 'zh-CN',
    style: 'plain',
    videoKey: 'BV1xx411c7mD:1001',
    page: 1,
    ms: 0,
    captionsOn: true,
    requests: [],
    toasts: []
  };
  const doc = makeDoc({});
  const player = makeEl('div', doc);
  const video = makeEl('video', doc);
  player.appendChild(video);
  doc.body.appendChild(player);
  const queue = [];
  const source = {
    platform: 'bilibili',
    hideNativeCss: '.rimefox-subs-on .bpx-player-subtitle-wrap{display:none !important;}',
    take: function () { return queue.shift() || null; },
    resolve: function (raw) { return Promise.resolve(raw.track || raw); },
    replay: function () {},
    player: function () { return state.captionsOn || state.ms >= 0 ? { player: player, video: video, ms: state.ms } : null; },
    captionsOn: function () { return state.captionsOn; },
    matches: function (t) { return !!t && t.videoKey === state.videoKey && (!t.page || !state.page || t.page === state.page); },
    blocked: function () { return false; },
    videoKey: function () { return state.videoKey; }
  };
  const env = {
    doc: doc,
    source: source,
    enabled: function () { return state.enabled; },
    target: function () { return state.target; },
    targetCode: function () { return state.targetCode; },
    styleId: function () { return state.style; },
    intensity: function () { return 'standard'; },
    now: function () { return 1000; },
    send: function (msg) {
      const d = deferred();
      state.requests.push({ msg: msg, d: d });
      return d.promise;
    },
    log: function () {},
    toast: function (msg) { state.toasts.push(msg); }
  };
  return { doc: doc, player: player, state: state, source: source, runtime: runtimeCreate(env), queue: queue };
}
function trackFor(videoKey, texts, opts) {
  const o = opts || {};
  return {
    platform: 'bilibili',
    videoKey: videoKey,
    v: videoKey,
    trackKey: o.trackKey || 'en-id:en-US',
    lang: o.lang || 'en-US',
    kind: o.kind || 'manual',
    page: o.page || 1,
    units: texts.map(function (text, i) {
      return { start: i * 2000, end: i * 2000 + 1800, text: text };
    })
  };
}
async function resolveReq(req, results) {
  req.d.resolve({ ok: true, results: results });
  await flush();
}

await t('首个 Bilibili 轨道只发一批翻译；cacheScope 含平台 / 视频 / cid / 轨道 / 语言', async function () {
  const c = setupRuntime();
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', ['Hello.', 'World.']) });
  c.runtime.tick();
  eq(c.state.requests.length, 1);
  assert.match(c.state.requests[0].msg.cacheScope, /^bilibili\|BV1xx411c7mD:1001\|en-id:en-US\|en-US$/);
  assert.equal(c.state.requests[0].msg.texts.join('|'), 'Hello.|World.');
  await resolveReq(c.state.requests[0], ['你好。', '世界。']);
  c.runtime.tick();
  eq(c.runtime.inspect().overlay._orig.textContent, 'Hello.');
  eq(c.runtime.inspect().overlay._trans.textContent, '你好。');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), true);
});

await t('分 P 切换：P1 晚到的旧译文不能写入 P2，渲染层只剩一个', async function () {
  const c = setupRuntime();
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', ['P1 text']) });
  c.runtime.tick();
  const req1 = c.state.requests[0];
  c.state.videoKey = 'BV1xx411c7mD:1002';
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1002', ['P2 text']) });
  c.runtime.tick();
  eq(c.state.requests.length, 2);
  await resolveReq(req1, ['P1 old']);
  assert.equal(c.runtime.inspect().track.videoKey, 'BV1xx411c7mD:1002');
  eq(c.runtime.inspect().track.trans.filter(Boolean), []);
  await resolveReq(c.state.requests[1], ['P2 translated']);
  c.runtime.tick();
  eq(c.runtime.inspect().overlay._trans.textContent, 'P2 translated');
  const overlays = all(c.player).filter(function (e) { return e.className === 'rimefox-subs' || e.classList.contains('rimefox-subs'); });
  eq(overlays.length, 1);
});

await t('分 P 页面号变化时，运行时通过 source.matches 立即停止显示旧 P 轨道', async function () {
  const c = setupRuntime();
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', ['P1 text'], { page: 1 }) });
  c.runtime.tick();
  eq(c.runtime.inspect().overlay._orig.textContent, 'P1 text');
  c.state.page = 2;
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  const noOverlay = c.runtime.inspect().overlay;
  assert.ok(!noOverlay || noOverlay.style.display === 'none', 'CC 关闭时不显示叠层');
});

await t('BV1 → BV2：旧请求晚返回不能污染新视频；新视频立即可调度', async function () {
  const c = setupRuntime();
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', ['BV1 text']) });
  c.runtime.tick();
  const old = c.state.requests[0];
  c.state.videoKey = 'BV2yy411c7mE:2001';
  await c.runtime.process({ track: trackFor('BV2yy411c7mE:2001', ['BV2 text']) });
  c.runtime.tick();
  eq(c.state.requests.length, 2);
  await resolveReq(old, ['BV1 wrong']);
  assert.equal(c.runtime.inspect().track.videoKey, 'BV2yy411c7mE:2001');
  await resolveReq(c.state.requests[1], ['BV2 translated']);
  c.runtime.tick();
  eq(c.runtime.inspect().overlay._trans.textContent, 'BV2 translated');
});

await t('目标语言与源语言相同：不接管理、不发请求；改目标语言后只发一次', async function () {
  const c = setupRuntime();
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', ['Hello.'], { lang: 'en-US' }) });
  c.state.target = 'en-US';
  c.state.targetCode = 'en-US';
  c.runtime.tick();
  eq(c.state.requests.length, 0);
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  c.state.target = 'zh-CN';
  c.state.targetCode = 'zh-CN';
  c.runtime.tick();
  eq(c.state.requests.length, 1);
  await resolveReq(c.state.requests[0], ['你好。']);
  c.runtime.tick();
  eq(c.runtime.inspect().overlay._trans.textContent, '你好。');
  // 旧语言结果晚到不能覆盖新语言
  c.state.target = 'ja';
  c.runtime.tick();
  await resolveReq(c.state.requests[0], ['旧中文']);
  assert.notEqual(c.runtime.inspect().track.trans[0], '旧中文');
  eq(c.state.requests.length, 2);
});

await t('字幕翻译关闭 / CC 关闭：0 请求，原生字幕恢复；重新开启复用轨道', async function () {
  const c = setupRuntime();
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', ['Hello.']) });
  c.runtime.tick();
  await resolveReq(c.state.requests[0], ['你好。']);
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), true);
  c.state.captionsOn = false;
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  const noOverlay = c.runtime.inspect().overlay;
  assert.ok(!noOverlay || noOverlay.style.display === 'none', 'CC 关闭时不显示叠层');
  c.state.captionsOn = true;
  c.state.enabled = false;
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  const sent = c.state.requests.length;
  c.runtime.tick();
  eq(c.state.requests.length, sent);
  c.state.enabled = true;
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), true);
  eq(c.runtime.inspect().overlay._trans.textContent, '你好。');
});

await t('无轨道时不发 AI 请求；不对两小时视频做全量预翻', async function () {
  const c = setupRuntime();
  c.runtime.tick();
  eq(c.state.requests.length, 0);
  await c.runtime.process({ track: trackFor('BV1xx411c7mD:1001', Array.from({ length: 500 }, function (_, i) { return 'line ' + i; })) });
  c.runtime.tick();
  eq(c.state.requests.length, 1);
  assert.ok(c.state.requests[0].msg.texts.length <= 8, '单批不超过 8 句');
  assert.ok(c.state.requests[0].msg.texts.join('').length <= 1000, '单批不超过 1000 字');
});

await t('分 P：地址栏没有 ?p 时按第 1 P 算，旧 P 轨道失效（V10）', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ bvid: 'BV1xx411c7mD', cid: 1002, page: 2 }, 1));
  const p2 = await source.resolve(source.take());
  assert.ok(p2);
  assert.equal(source.matches(p2), false, '地址栏没有 ?p 就是第 1 P，旧 P2 轨道不能继续显示');
});

await t('伪造巨大 seq 不能把来源层锁死（V11）', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ cid: 1001 }, 1));
  assert.equal(source.inspect().meta.cid, '1001');
  source.accept(messageFor({ cid: 1002 }, 1000000));
  assert.equal(source.inspect().meta.cid, '1001', '巨大的 seq 跳跃应被忽略，旧回包不能被顶掉');
  source.accept(messageFor({ cid: 1003 }, 2));
  assert.equal(source.inspect().meta.cid, '1003', '之后的真回包仍能进来');
});

await t('对象 / 数组 id_str 不会把不同轨道撞成同一个键（V12）', async function () {
  const state = { lan: 'ai-zh' };
  const doc = makeDoc(state);
  const source = createBiliSource({
    doc: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '' },
    send: async function () { return { ok: true, text: bodyOf([[1, 2, 'x']]) }; }
  });
  source.accept(messageFor({ tracks: [trackOf('ai-zh', SAFE_URL, { id: 'a', id_str: { bad: 1 } })] }, 1));
  const first = source.take();
  source.accept(messageFor({ tracks: [trackOf('ai-zh', SAFE_HUMAN_URL, { id: 'b', id_str: [] })] }, 2));
  const second = source.take();
  assert.ok(first && second);
  assert.notEqual(first.key, second.key, 'String(对象) 全是 [object Object]，必须退回 id');
});

await t('readTextCapped：没有 content-length 的超大响应读到上限就停（V13）', async function () {
  const chunk = new Uint8Array(3000).fill(65);
  const res = new Response(new ReadableStream({
    start: function (c) { c.enqueue(chunk); c.enqueue(chunk); c.close(); }
  }));
  const out = await readTextCapped(res, 4096);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'too_large');
  const small = new Response('{"body":[]}');
  const ok = await readTextCapped(small, 4096);
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '{"body":[]}');
});

await t('CC 关闭时即使有轨道也不调度（与来源层 captionsOn 叠加）；重开 CC 复用译文不重复请求', async function () {
  const c = setupRuntime();
  c.state.captionsOn = false;
  await c.runtime.process(trackFor('BV1xx411c7mD:1001', ['Hello.']));
  c.runtime.tick();
  assert.equal(c.state.requests.length, 0, 'CC 关闭时不能发请求');
  const noOverlay = c.runtime.inspect().overlay;
  assert.ok(!noOverlay || noOverlay.style.display === 'none', 'CC 关闭时不显示叠层');

  c.state.captionsOn = true;
  c.runtime.tick();
  assert.equal(c.state.requests.length, 1, '重开 CC 后才调度');
  await resolveReq(c.state.requests[0], ['你好。']);
  c.runtime.tick();
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '你好。');

  const before = c.state.requests.length;
  c.state.captionsOn = false;
  c.runtime.tick();
  c.state.captionsOn = true;
  c.runtime.tick();
  assert.equal(c.state.requests.length, before, '重开 CC 复用已有译文，不重复请求');
});
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);