// YouTube 字幕运行时回归：用可控 Promise / 假 DOM 测试语言切换、视频切换、播放器重建等竞态。
// 运行：node test/subtitles-session.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// ---------------- 加载 classic content scripts ----------------
const root = new URL('..', import.meta.url);
const sandbox = { console, setTimeout, clearTimeout, setImmediate, Promise, URL, URLSearchParams };
sandbox.window = sandbox;
sandbox.__DT = {
  log: function () {},
  toast: function () {},
  STYLE_IDS: ['plain', 'classical', 'catgirl'],
  state: {},
  subtitleSource: {
    take: function () { return null; },
    fetchText: function () { return Promise.resolve(''); },
    replay: function () {}
  }
};
vm.createContext(sandbox);
for (const file of ['content/subtitles-core.js', 'content/subtitles.js']) {
  vm.runInContext(fs.readFileSync(new URL(file, root), 'utf8'), sandbox, { filename: file });
}
const subs = sandbox.__DT.subs;
const create = sandbox.__DT.subtitleRuntime && sandbox.__DT.subtitleRuntime.create;
assert.equal(typeof create, 'function', 'subtitles.js 未导出 createRuntime');

let pass = 0;
let fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { pass += 1; console.log('  ✓ ' + name); })
    .catch(function (err) { fail += 1; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); });
}

// ---------------- 假 DOM ----------------
function makeDoc() {
  const doc = {};
  const head = el('head', doc);
  const body = el('body', doc);
  doc.head = head;
  doc.body = body;
  doc.documentElement = body;
  doc.createElement = function (tag) { return el(tag, doc); };
  doc.getElementById = function (id) { return findById([head, body], id); };
  doc.querySelectorAll = function (selector) {
    if (selector === '.rimefox-subs-on') {
      return all(body).filter(function (e) { return e.classList.contains('rimefox-subs-on'); });
    }
    return [];
  };
  doc.querySelector = function () { return null; };
  return doc;
}
function el(tag, doc) {
  const e = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    textContent: '',
    id: '',
    _attrs: {},
    _classes: new Set(),
    clientHeight: 720
  };
  e.classList = {
    add: function (c) { e._classes.add(c); },
    remove: function (c) { e._classes.delete(c); },
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
    return null;
  };
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

// ---------------- 假环境 ----------------
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
function setup() {
  const doc = makeDoc();
  const player = el('div', doc);
  doc.body.appendChild(player);
  const btn = el('button', doc);
  btn._attrs['aria-pressed'] = 'true';
  player._captionBtn = btn;

  const source = {
    queue: [],
    fetches: [],
    take: function () { return source.queue.shift() || null; },
    fetchText: function (url) {
      const d = deferred();
      source.fetches.push({ url: url, d: d });
      return d.promise;
    },
    replays: 0,
    replay: function () { source.replays += 1; },
    // 测试替身：生产环境的 YouTube 适配层在 content/subtitles-source.js，这里只保留
    // 运行时竞态测试需要的协议行为（v 校验 / 广告过滤 / tlang 取原文 / json3 解析）。
    resolve: async function (raw) {
      if (!raw || !raw.url) return null;
      const p = subs.paramsOf(raw.url);
      const current = state.video;
      if (raw.replay && p.v && current && p.v !== current) return null;
      const ad = !!(state.player && state.player.classList.contains('ad-showing'));
      if (p.v && current && p.v !== current && ad) return null;
      let url = raw.url;
      let body = raw.body;
      if (p.tlang) {
        url = subs.withoutTlang(raw.url);
        body = await source.fetchText(url);
        if (!body) return null;
      }
      let json;
      try { json = JSON.parse(body); } catch (err) { return null; }
      const units = subs.unitsOf(json, url);
      if (!units.length) return null;
      const videoKey = p.v || current;
      return {
        platform: 'youtube',
        videoKey: videoKey,
        v: videoKey,
        trackKey: [p.lang, p.kind || 'manual'].join(':'),
        lang: p.lang,
        kind: p.kind === 'asr' ? 'asr' : 'manual',
        units: units
      };
    }
  };

  const state = {
    enabled: true,
    target: 'zh-CN',
    style: 'plain',
    video: 'A',
    ms: 0,
    player: player,
    now: 1000,
    requests: [],
    toasts: []
  };
  const env = {
    doc: doc,
    source: source,
    enabled: function () { return state.enabled; },
    target: function () { return state.target; },
    styleId: function () { return state.style; },
    videoId: function () { return state.video; },
    now: function () { return state.now; },
    player: function () { return state.player ? { player: state.player, ms: state.ms } : null; },
    send: function (msg) {
      const d = deferred();
      state.requests.push({ msg: msg, d: d });
      return d.promise;
    },
    log: function () {},
    toast: function (msg) { state.toasts.push(msg); }
  };
  const runtime = create(env);
  return { doc: doc, player: player, btn: btn, source: source, state: state, env: env, runtime: runtime };
}

function rawFor(video, lang, texts, extra) {
  const events = texts.map(function (text, i) {
    return { tStartMs: i * 2000, dDurationMs: 1800, segs: [{ utf8: text }] };
  });
  const url = 'https://www.youtube.com/api/timedtext?v=' + video + '&lang=' + lang + (extra || '') + '&fmt=json3';
  return { url: url, body: JSON.stringify({ events: events }) };
}
function tlangRaw(video, lang, targetLang) {
  return {
    url: 'https://www.youtube.com/api/timedtext?v=' + video + '&lang=' + lang + '&tlang=' + targetLang + '&fmt=json3',
    body: ''
  };
}
async function resolveReq(req, results) {
  req.d.resolve({ ok: true, results: results });
  await flush();
}
async function rejectReq(req) {
  req.d.reject(new Error('network'));
  await flush();
}
async function startTrack(c, video, texts) {
  await c.runtime.process(rawFor(video || 'A', 'en', texts || ['Hello.', 'World.']));
}
async function displayed(c) {
  await startTrack(c);
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.state.requests.length, 1, '首帧应发一次翻译');
  await resolveReq(c.state.requests[0], ['你好。', '世界。']);
  c.runtime.tick();
  return c.runtime.inspect();
}

console.log('\n[YouTube 字幕运行时]');

await t('A. 目标语言 zh → ja 后，旧中文结果不能覆盖日文', async function () {
  const c = setup();
  await startTrack(c);
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.state.requests.length, 1);
  assert.equal(c.state.requests[0].msg.target, 'zh-CN');

  c.state.target = 'ja';
  c.runtime.tick();
  assert.equal(c.state.requests.length, 2, '换语言后应立刻按新语言重新调度');
  assert.equal(c.state.requests[1].msg.target, 'ja');

  await resolveReq(c.state.requests[0], ['旧中文']);
  assert.equal(c.runtime.inspect().track.trans[0], undefined, '旧语结果必须丢弃');

  await resolveReq(c.state.requests[1], ['日本語']);
  c.runtime.tick();
  assert.equal(c.runtime.inspect().track.trans[0], '日本語');
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '日本語');
});

await t('B. 新目标语言等于原字幕语言时恢复原生字幕，原始轨道保留、旧译文清掉', async function () {
  const c = setup();
  const before = (await displayed(c)).track;
  assert.equal(c.player.classList.contains('rimefox-subs-on'), true);

  c.state.target = 'en';
  c.runtime.tick();
  const track = c.runtime.inspect().track;
  assert.equal(track, before, '同语言只停止接管，不能把原始轨道扔掉');
  assert.equal(track.units.length, 2);
  assert.equal(track.trans.filter(Boolean).length, 0, '旧语言译文不能留着');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  assert.equal(c.runtime.inspect().overlay.style.display, 'none');
  c.runtime.tick();
  assert.equal(c.state.requests.length, 1, '同语言不发翻译请求');
});

await t('C. 视频 A 请求未完成时，视频 B 能立即开始自己的调度', async function () {
  const c = setup();
  await startTrack(c, 'A');
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.state.requests.length, 1);

  c.state.video = 'B';
  await startTrack(c, 'B', ['B one.', 'B two.']);
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.state.requests.length, 2, '旧视频 inflight 不应阻塞新视频');
  assert.equal(c.state.requests[1].msg.texts.join('|'), 'B one.|B two.');
});

await t('D. 视频 B 已显示后，视频 A 的旧请求返回不能污染 B', async function () {
  const c = setup();
  await startTrack(c, 'A');
  c.state.ms = 0;
  c.runtime.tick();
  const reqA = c.state.requests[0];

  c.state.video = 'B';
  await startTrack(c, 'B', ['B one.']);
  c.state.ms = 0;
  c.runtime.tick();
  const reqB = c.state.requests[1];
  await resolveReq(reqB, ['B 译文']);
  c.runtime.tick();
  assert.equal(c.runtime.inspect().track.trans[0], 'B 译文');

  await resolveReq(reqA, ['A 旧译文']);
  assert.equal(c.runtime.inspect().track.v, 'B');
  assert.equal(c.runtime.inspect().track.trans[0], 'B 译文', '旧视频结果不得写入当前字幕');
});

await t('E. 旧请求异常结束时，不影响新视频计数与调度', async function () {
  const c = setup();
  await startTrack(c, 'A');
  c.state.ms = 0;
  c.runtime.tick();
  const reqA = c.state.requests[0];

  c.state.video = 'B';
  await startTrack(c, 'B', ['B one.']);
  c.state.ms = 0;
  c.runtime.tick();
  const reqB = c.state.requests[1];
  await rejectReq(reqA);
  assert.equal(c.runtime.inspect().track.inflight, 1, 'B 的计数不能被 A 的失败改掉');
  assert.equal(c.runtime.inspect().track.pending[0], true);
  assert.equal(c.runtime.inspect().track.failedAt.length, 0);
  await resolveReq(reqB, ['B 译文']);
  assert.equal(c.runtime.inspect().track.trans[0], 'B 译文');
});

await t('F. 原始字幕轨道异步获取乱序完成，不能覆盖当前轨道', async function () {
  const c = setup();
  const pA = c.runtime.process(tlangRaw('A', 'en', 'zh'));
  const pB = c.runtime.process(tlangRaw('B', 'en', 'zh'));
  assert.equal(c.source.fetches.length, 2);

  c.source.fetches[1].d.resolve(rawFor('B', 'en', ['B one.']).body);
  await pB;
  assert.equal(c.runtime.inspect().track.v, 'B');

  c.source.fetches[0].d.resolve(rawFor('A', 'en', ['A one.']).body);
  await pA;
  assert.equal(c.runtime.inspect().track.v, 'B', '晚完成的旧轨道不能覆盖新轨道');
});

await t('G. 播放器 DOM 替换后，内容相同的新叠层仍然可见', async function () {
  const c = setup();
  await displayed(c);
  const oldOverlay = c.runtime.inspect().overlay;
  assert.equal(oldOverlay.parentNode, c.player);
  assert.equal(oldOverlay.style.display, 'block');

  const player2 = el('div', c.doc);
  c.doc.body.appendChild(player2);
  const btn2 = el('button', c.doc);
  btn2._attrs['aria-pressed'] = 'true';
  player2._captionBtn = btn2;
  c.state.player = player2;
  c.runtime.tick();

  const now = c.runtime.inspect().overlay;
  assert.notEqual(now, oldOverlay, '播放器变了应创建新叠层');
  assert.equal(now.parentNode, player2);
  assert.equal(now.style.display, 'block', '新叠层不能因为 shown 缓存而跳过写入');
  assert.equal(now._trans.textContent, '你好。');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  assert.equal(player2.classList.contains('rimefox-subs-on'), true);
});

await t('H. 全屏/剧场高度变化后，字幕不会消失或重复', async function () {
  const c = setup();
  await displayed(c);
  const overlay = c.runtime.inspect().overlay;
  const small = overlay._trans.style.fontSize;
  c.player.clientHeight = 1080;
  c.runtime.tick();
  const large = c.runtime.inspect().overlay._trans.style.fontSize;
  assert.notEqual(large, small, '字号应随播放器高度变化');
  assert.equal(c.runtime.inspect().overlay.style.display, 'block');
  const count = c.player.children.filter(function (e) { return e.className === 'rimefox-subs'; }).length;
  assert.equal(count, 1, '播放器里不应重复叠加字幕层');
});

await t('I. 关闭 CC / 关闭字幕翻译时交还原生字幕', async function () {
  const c = setup();
  await displayed(c);
  c.btn._attrs['aria-pressed'] = 'false';
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false, 'CC 关闭时不能继续隐藏原生字幕');
  assert.equal(c.runtime.inspect().overlay.style.display, 'none');
  assert.notEqual(c.runtime.inspect().track, null, 'CC 关闭不清轨道，重新打开可继续');

  c.btn._attrs['aria-pressed'] = 'true';
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), true);
  assert.equal(c.runtime.inspect().overlay.style.display, 'block');

  c.state.enabled = false;
  c.runtime.tick();
  assert.notEqual(c.runtime.inspect().track, null, '关闭字幕翻译只交还显示，不扔原始轨道');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  assert.equal(c.runtime.inspect().overlay.style.display, 'none');
  const sent = c.state.requests.length;
  c.state.ms = 2500;
  c.runtime.tick();
  assert.equal(c.state.requests.length, sent, '关闭期间不发请求');
  assert.equal(c.btn.getAttribute('aria-pressed'), 'true', '不碰 CC 按钮');

  c.state.enabled = true;
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), true, '重新打开同一视频直接接着显示');
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '你好。');
});

await t('J. 快速切换语言 / 风格 / 视频，最终只接受最新有效结果', async function () {
  const c = setup();
  await startTrack(c, 'A');
  c.state.ms = 0;
  c.runtime.tick();
  const req1 = c.state.requests[0];

  c.state.target = 'ja';
  c.runtime.tick();
  const req2 = c.state.requests[1];

  c.state.style = 'classical';
  c.runtime.tick();
  const req3 = c.state.requests[2];

  c.state.video = 'B';
  await startTrack(c, 'B', ['Final.']);
  c.state.ms = 0;
  c.runtime.tick();
  const req4 = c.state.requests[3];

  await resolveReq(req1, ['stale-1']);
  await resolveReq(req2, ['stale-2']);
  await resolveReq(req3, ['stale-3']);
  const mid = c.runtime.inspect().track;
  assert.equal(mid.v, 'B');
  assert.equal(mid.trans[0], undefined, '旧代结果不能写入新视频');

  await resolveReq(req4, ['最新译文']);
  c.runtime.tick();
  const end = c.runtime.inspect().track;
  assert.equal(end.v, 'B');
  assert.equal(end.target, 'ja');
  assert.equal(end.style, 'classical');
  assert.equal(end.trans[0], '最新译文');
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '最新译文');
});

await t('K. 英文 CC：中文 → 英文（原生）→ 中文 → 英文 → 中文，复用原轨道、晚到的旧请求不残留', async function () {
  const c = setup();
  await startTrack(c, 'A', ['One.', 'Two.', 'Three.']);
  const units = c.runtime.inspect().track.units;
  c.state.ms = 0;
  c.runtime.tick();
  const zh1 = c.state.requests[0];
  assert.equal(zh1.msg.target, 'zh-CN');

  // 中文请求还没回来就切到英文：交还原生字幕
  c.state.target = 'en';
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  await resolveReq(zh1, ['旧一。', '旧二。', '旧三。']);
  c.runtime.tick();
  assert.equal(c.runtime.inspect().track.trans.filter(Boolean).length, 0, '切走之后才回来的中文不能写进去');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false, '英文目标下不接管');

  for (let round = 0; round < 2; round += 1) {
    // 切回中文：YouTube 不会再请求字幕（来源队列是空的），必须复用原轨道重新调度
    c.state.target = 'zh-CN';
    c.runtime.tick();
    const req = c.state.requests[c.state.requests.length - 1];
    assert.equal(req.msg.target, 'zh-CN', '第 ' + (round + 1) + ' 轮切回中文应重新调度');
    assert.equal(req.msg.texts.join('|'), 'One.|Two.|Three.');
    assert.equal(c.runtime.inspect().track.units, units, '应复用同一份原始时间轴');
    assert.equal(c.source.fetches.length, 0, '不重新下载字幕');
    await resolveReq(req, ['一。', '二。', '三。']);
    c.runtime.tick();
    assert.equal(c.player.classList.contains('rimefox-subs-on'), true);
    assert.equal(c.runtime.inspect().overlay.style.display, 'block');
    assert.equal(c.runtime.inspect().overlay._orig.textContent, 'One.');
    assert.equal(c.runtime.inspect().overlay._trans.textContent, '一。');

    c.state.target = 'en';
    c.runtime.tick();
    assert.equal(c.player.classList.contains('rimefox-subs-on'), false, '第 ' + (round + 1) + ' 轮切回英文应交还原生字幕');
    assert.equal(c.runtime.inspect().overlay.style.display, 'none');
    assert.equal(c.runtime.inspect().track.trans.filter(Boolean).length, 0, '切回英文后不留中文译文');
  }
});

await t('L. 字幕先以原语言到达（目标英文）：轨道留着，改成中文后直接开始翻', async function () {
  const c = setup();
  c.state.target = 'en';
  await startTrack(c, 'A', ['Hi there.']);
  c.state.ms = 0;
  c.runtime.tick();
  assert.notEqual(c.runtime.inspect().track, null, '同语言字幕也要留着轨道');
  assert.equal(c.state.requests.length, 0, '同语言不翻');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  c.state.target = 'zh-CN';
  c.runtime.tick();
  assert.equal(c.state.requests.length, 1, '改成中文后应立即调度');
  await resolveReq(c.state.requests[0], ['你好。']);
  c.runtime.tick();
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '你好。');
});

await t('M. 语言切换途中换视频：上一视频的轨道与晚到的请求都不复用', async function () {
  const c = setup();
  await startTrack(c, 'A', ['A one.']);
  c.state.ms = 0;
  c.runtime.tick();
  const reqA = c.state.requests[0];
  c.state.target = 'en';
  c.runtime.tick();

  c.state.video = 'B';
  c.runtime.tick();
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false, '新视频的字幕还没到，不能显示 A');
  await startTrack(c, 'B', ['B one.']);
  await resolveReq(reqA, ['A 旧译文']);
  c.state.target = 'zh-CN';
  c.runtime.tick();
  const reqB = c.state.requests[c.state.requests.length - 1];
  assert.equal(reqB.msg.texts.join('|'), 'B one.', '只翻当前视频的字幕');
  await resolveReq(reqB, ['B 译文']);
  c.runtime.tick();
  assert.equal(c.runtime.inspect().track.v, 'B');
  assert.equal(c.runtime.inspect().overlay._trans.textContent, 'B 译文');
});

await t('N. 重放的字幕回包必须属于当前视频；没有轨道时每个视频最多要一次重放，CC 关着不要', async function () {
  const c = setup();
  c.state.video = 'B';
  await c.runtime.process(Object.assign(rawFor('A', 'en', ['Old video.']), { replay: true }));
  assert.equal(c.runtime.inspect().track, null, '上一视频的重放不能被当成当前字幕');
  await c.runtime.process(Object.assign(rawFor('B', 'en', ['Current video.']), { replay: true }));
  assert.equal(c.runtime.inspect().track.v, 'B', '当前视频的重放可以用');
  // 新字幕比地址栏先到（不是重放）：照常接收
  await c.runtime.process(rawFor('C', 'en', ['Next video.']));
  assert.equal(c.runtime.inspect().track.v, 'C');

  const d = setup();
  d.btn._attrs['aria-pressed'] = 'false';
  d.runtime.tick();
  assert.equal(d.source.replays, 0, 'CC 关着不要重放');
  assert.equal(d.btn.getAttribute('aria-pressed'), 'false', '不能替用户打开 CC');
  d.btn._attrs['aria-pressed'] = 'true';
  d.runtime.tick();
  d.runtime.tick();
  assert.equal(d.source.replays, 1, '同一视频只要一次');
  d.state.video = 'B';
  d.runtime.tick();
  assert.equal(d.source.replays, 2, '换视频后可以再要一次');
});

await t('O. 切语言期间播放器 DOM 重建：切回中文后新播放器上照常显示', async function () {
  const c = setup();
  await displayed(c);
  c.state.target = 'en';
  c.runtime.tick();
  const player2 = el('div', c.doc);
  c.doc.body.appendChild(player2);
  const btn2 = el('button', c.doc);
  btn2._attrs['aria-pressed'] = 'true';
  player2._captionBtn = btn2;
  c.state.player = player2;
  c.state.target = 'zh-CN';
  c.runtime.tick();
  await resolveReq(c.state.requests[c.state.requests.length - 1], ['你好。', '世界。']);
  c.runtime.tick();
  const overlay = c.runtime.inspect().overlay;
  assert.equal(overlay.parentNode, player2);
  assert.equal(overlay.style.display, 'block');
  assert.equal(overlay._trans.textContent, '你好。');
  assert.equal(player2.classList.contains('rimefox-subs-on'), true);
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
});

await t('P. 播广告时交还原生字幕、不发翻译；广告播完接着显示正片的双语字幕', async function () {
  const c = setup();
  await displayed(c);
  assert.equal(c.runtime.inspect().overlay.style.display, 'block');
  const before = c.state.requests.length;
  c.player.classList.add('ad-showing');
  c.state.ms = 2500; // 广告自己的时间轴：正好落在正片第二句上
  c.runtime.tick();
  assert.equal(c.runtime.inspect().overlay.style.display, 'none', '播广告时不能把正片字幕叠在广告上');
  assert.equal(c.player.classList.contains('rimefox-subs-on'), false);
  assert.equal(c.state.requests.length, before, '播广告时不调度翻译');
  c.player.classList.remove('ad-showing');
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '你好。');
});

await t('Q. 插播广告的字幕不替换正片轨道（广告播完播放器不会再请求正片字幕）', async function () {
  const c = setup();
  const track = (await displayed(c)).track;
  c.player.classList.add('ad-showing');
  await c.runtime.process(rawFor('AD', 'en', ['Buy now.', 'Limited offer.'], '&kind=asr'));
  c.runtime.tick();
  assert.equal(c.runtime.inspect().track, track, '正片的轨道被广告字幕换掉了');
  c.player.classList.remove('ad-showing');
  c.state.ms = 0;
  c.runtime.tick();
  assert.equal(c.runtime.inspect().overlay.style.display, 'block');
  assert.equal(c.runtime.inspect().overlay._trans.textContent, '你好。');
  // 不在播广告时，别的视频的字幕照常接收（换视频时新字幕可能比地址栏先到）
  await c.runtime.process(rawFor('B', 'en', ['B one.']));
  assert.equal(c.runtime.inspect().track.v, 'B');
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);