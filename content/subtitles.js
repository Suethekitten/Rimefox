// YouTube 字幕运行时：消费字幕来源适配层、拼句、按进度懒翻译、叠层显示。
// 只在 YouTube 加载；纯函数在 content/subtitles-core.js，来源适配在 content/subtitles-source.js（都必须先加载）。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || !DT.subs) return; // 依赖 subtitles-core.js
  var subs = DT.subs;
  var source = DT.subtitleSource;
  if (!source) return; // 依赖 subtitles-source.js

  var LOOK_AHEAD_MS = 90000; // 只翻播放位置往后这么长
  var LOOK_BEHIND_MS = 3000;
  var BATCH_ITEMS = 8; // 小批优先：当前句的译文更快回来
  var BATCH_CHARS = 1000;
  var RETRY_MS = 15000;
  var LINGER_MS = 1500; // 句末后再停留这么久，等下一句或等译文
  var STYLE_ID = 'rimefox-subs-style';

  // 运行时工厂：把 DOM、配置、发送、计时都从参数注入，Node 测试可以用假实现控制 Promise 顺序。
  // 返回的对象只暴露 tick / process / reset / inspect；真实页面在文件末尾自动创建并每 200ms 调用 tick。
  function createRuntime(env) {
    var doc = env.doc;
    var src = env.source || source;
    var track = null; // { key, v, lang, kind, target, style, units, trans, failedAt, pending, gen, inflight, warned }
    var overlay = null;
    var shown = '';
    var shownOverlay = null;
    var last = null; // 上一句已显示的内容，句间空档时用来兜底
    var processSeq = 0; // 异步拿原文轨道的代际：晚开始的 process 覆盖早开始的
    var replayAskedFor = ''; // 已经为哪个视频向来源层要过一次 replay（每个视频最多一次）

    function now() {
      return env.now ? env.now() : Date.now();
    }

    function log() {
      if (env.log) env.log.apply(null, arguments);
    }

    function reset() {
      processSeq += 1; // 让还在 fetchText 的旧 process 作废
      track = null;
      shown = '';
      shownOverlay = null;
      last = null;
      render(null);
    }

    // 两种生命周期分开管：
    //   原始轨道（track.units，时间轴）只跟「视频 + 字幕轨道」走，视频没换、轨道没换就一直留着；
    //   译文（trans / pending / inflight）跟「目标语言 + 风格 + 请求代际 gen」走，任何一项变了都作废。
    // 目标语言等于字幕语言、或关掉字幕翻译时只是不接管（交还原生字幕），轨道不扔：
    // 以前这里直接 reset()，用户再切回中文时 YouTube 不会重新请求字幕，就再也翻不了了。

    // 语言 / 风格变化：保留原始字幕和句子时间轴，只让旧译文与旧请求失效
    function invalidate(next) {
      if (!track) return;
      track.gen += 1;
      track.inflight = 0;
      track.pending = {};
      track.trans = new Array(track.units.length);
      track.failedAt = [];
      track.warned = false;
      if (next && next.target !== undefined) track.target = next.target;
      if (next && next.style !== undefined) track.style = next.style;
      if (next && next.key !== undefined) track.key = next.key;
      shown = '';
      shownOverlay = null;
      last = null;
    }

    async function process(raw) {
      if (!raw || !raw.url) return;
      var p = subs.paramsOf(raw.url);
      var url = raw.url;
      var body = raw.body;
      var lang = p.lang;
      var seq = ++processSeq;
      var startVideo = p.v || env.videoId();
      // 重放的是主环境钩子留着的「最后一份」，可能是上一个视频的：和当前视频对不上就不收
      if (raw.replay && p.v && env.videoId() && p.v !== env.videoId()) return;

      // YouTube 机翻轨道：拿原文轨道来做双语（同源请求，带着播放器的令牌）
      if (p.tlang) {
        url = subs.withoutTlang(raw.url);
        try {
          body = await src.fetchText(url);
        } catch (err) {
          body = '';
        }
        if (seq !== processSeq) return; // 已经有更新的 process 开始
        if (!body) return; // 拿不到原文就不接管，原生机翻字幕照常显示
      }

      // 字幕本来就是目标语言：照样解析、留着轨道，只是不接管（tick 里交还原生字幕）；
      // 用户之后改了目标语言就能直接接着翻，不用等 YouTube 再请求一次
      var key = [p.v, lang, p.kind, env.target()].join('|');
      if (track && track.key === key) return; // 播放器重复拉同一条轨道（拖动进度时会）

      var json;
      try {
        json = JSON.parse(body);
      } catch (err) {
        return; // 不是 json3（老格式 / 出错页），不接管
      }
      var units = subs.unitsOf(json, url);
      if (!units.length) return;

      track = {
        key: key,
        v: p.v || startVideo,
        lang: lang,
        kind: p.kind,
        target: env.target(),
        style: env.styleId(),
        units: units,
        trans: new Array(units.length),
        failedAt: [],
        pending: {},
        gen: 0,
        inflight: 0,
        warned: false
      };
      shown = '';
      shownOverlay = null;
      last = null;
      log('subtitles:', units.length, 'units', p.kind === 'asr' ? '(asr)' : '', p.tlang ? '(from tlang)' : '');
    }

    // ---------------- 翻译调度 ----------------
    function pump(nowMs) {
      if (!track) return;
      if (!env.enabled()) return;
      if (track.target !== env.target() || track.style !== env.styleId()) return; // 由 tick 先失效
      if (subs.sameLanguage(track.lang, track.target)) return; // 字幕本来就是目标语言：不翻
      if (track.inflight > 0) return; // 只限制同一代任务；旧视频/旧语言的请求不算

      var units = track.units;
      var batch = [];
      var chars = 0;
      var nowValue = now();
      // 先收集窗口内的候选，再按"离当前播放位置的距离"排序：
      // 正在说的那一句必须排第一，否则积压时当前句要等前面几批翻完才轮到。
      var cands = [];
      for (var i = 0; i < units.length; i += 1) {
        var u = units[i];
        if (u.end < nowMs - LOOK_BEHIND_MS) continue;
        if (u.start > nowMs + LOOK_AHEAD_MS) break;
        if (u.tag || track.trans[i] !== undefined || track.pending[i]) continue;
        if (track.failedAt[i] && nowValue - track.failedAt[i] < RETRY_MS) continue;
        cands.push({
          i: i,
          dist: u.start <= nowMs && u.end >= nowMs ? 0 : (u.start > nowMs ? u.start - nowMs : nowMs - u.end)
        });
      }
      cands.sort(function (a, b) {
        return a.dist - b.dist || a.i - b.i;
      });
      cands.forEach(function (c) {
        if (batch.length && (batch.length >= BATCH_ITEMS || chars + units[c.i].text.length > BATCH_CHARS)) return;
        batch.push(c.i);
        chars += units[c.i].text.length;
      });
      if (!batch.length) return;

      var mine = track;
      var gen = mine.gen;
      var batchStyle = mine.style;
      var batchTarget = mine.target;
      mine.inflight += 1;
      batch.forEach(function (i) {
        mine.pending[i] = true;
      });

      var request;
      try {
        request = env.send({
          type: 'translate',
          texts: batch.map(function (i) {
            return mine.units[i].text;
          }),
          target: batchTarget,
          style: batchStyle
        });
      } catch (err) {
        request = Promise.reject(err);
      }

      Promise.resolve(request)
        .then(
          function (res) {
            // 代际/轨道/语言/风格任何一项变了，结果都作废；旧视频的请求不能污染新视频
            if (track !== mine || mine.gen !== gen || mine.target !== batchTarget || mine.style !== batchStyle) return;
            var results = (res && res.results) || [];
            batch.forEach(function (i, k) {
              var value = results[k];
              if (typeof value === 'string') mine.trans[i] = value.trim();
              else mine.failedAt[i] = now();
            });
            if (res && !res.ok && res.error && !mine.warned) {
              mine.warned = true;
              if (env.toast) env.toast('字幕翻译失败：' + res.error, 5000);
            }
          },
          function () {
            if (track !== mine || mine.gen !== gen || mine.target !== batchTarget || mine.style !== batchStyle) return;
            batch.forEach(function (i) {
              mine.failedAt[i] = now();
            });
          }
        )
        .then(function () {
          // 旧代际的 finally 不能再改计数/显示缓存，否则会干扰新视频
          if (track !== mine || mine.gen !== gen) return;
          batch.forEach(function (i) {
            delete mine.pending[i];
          });
          mine.inflight = Math.max(0, mine.inflight - 1);
          shown = ''; // 刚回来的可能就是正在显示的那句
        });
    }

    // ---------------- 显示 ----------------
    function ensureStyle() {
      if (doc.getElementById(STYLE_ID)) return;
      var style = doc.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-dt-ui', '1');
      // 接管期间隐藏原生字幕，免得两套字幕叠在一起
      style.textContent = '.rimefox-subs-on .ytp-caption-window-container{display:none !important;}';
      (doc.head || doc.documentElement).appendChild(style);
    }

    function captionsOn(player) {
      var btn = player.querySelector ? player.querySelector('.ytp-subtitles-button') : null;
      return !btn || btn.getAttribute('aria-pressed') === 'true';
    }

    function ensureOverlay(player) {
      if (overlay && overlay.parentNode === player && overlay.isConnected !== false) return overlay;
      if (overlay) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        else if (overlay.remove) overlay.remove();
      }
      overlay = doc.createElement('div');
      overlay.setAttribute('data-dt-ui', '1');
      overlay.className = 'rimefox-subs';
      overlay.style.cssText = [
        'position:absolute',
        'left:50%',
        'transform:translateX(-50%)',
        // 高于底部渐变（24），低于控制条（59）和设置菜单：不能盖住播放器控件
        'z-index:30',
        'max-width:86%',
        'width:max-content',
        'text-align:center',
        'pointer-events:none',
        'display:none',
        'font-family:"YouTube Noto",Roboto,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      ].join(';');
      var orig = doc.createElement('div');
      var trans = doc.createElement('div');
      [orig, trans].forEach(function (line) {
        line.style.cssText =
          'display:table;margin:0 auto 2px;padding:1px 8px;border-radius:3px;background:rgba(8,8,8,.75);color:#fff;line-height:1.35;white-space:pre-wrap;word-break:break-word;';
      });
      orig.style.color = 'rgba(255,255,255,.85)';
      overlay._orig = orig;
      overlay._trans = trans;
      overlay.appendChild(orig);
      overlay.appendChild(trans);
      player.appendChild(overlay);
      // 新叠层必须重新写一次，不能沿用旧叠层的 shown 缓存（播放器 DOM 重建时内容可能完全相同）
      shown = '';
      shownOverlay = null;
      return overlay;
    }

    function render(state) {
      var player = state && state.player;
      doc.querySelectorAll('.rimefox-subs-on').forEach(function (el) {
        if (el !== player) el.classList.remove('rimefox-subs-on');
      });
      // 没有可显示的内容就交还给原生字幕：以前先加隐藏类再判空，句间空档会两边都没有
      if (!state || !state.orig || !player) {
        if (player) player.classList.remove('rimefox-subs-on');
        if (overlay) overlay.style.display = 'none';
        shown = '';
        shownOverlay = null;
        return;
      }
      ensureStyle();
      player.classList.add('rimefox-subs-on');
      var surface = ensureOverlay(player);

      // 字号跟播放器高度走（全屏时变大）；控制条显示时往上让一让
      var h = player.clientHeight || 360;
      var size = Math.max(13, Math.min(32, Math.round(h * 0.036)));
      var autohide = player.classList.contains('ytp-autohide');
      overlay.style.bottom = Math.round(autohide ? h * 0.04 : Math.max(56, h * 0.1)) + 'px';
      overlay._trans.style.fontSize = size + 'px';
      overlay._orig.style.fontSize = Math.round(size * 0.82) + 'px';

      // 缓存必须同时绑定"哪个叠层"：播放器被替换后新叠层即使内容一样也要重新写
      var sig = state.orig + '\u0000' + state.trans + '\u0000' + size;
      if (surface === shownOverlay && sig === shown) return;
      shownOverlay = surface;
      shown = sig;
      overlay._orig.textContent = state.orig;
      overlay._trans.textContent = state.trans;
      overlay._trans.style.display = state.trans ? 'table' : 'none';
      overlay.style.display = 'block';
    }

    // 当前视频没有可用轨道（还没收到、或手上的是上一个视频的）：请来源层把最后一份字幕回包重放一次。
    // 每个视频最多要一次；重放回来的在 process() 里核对视频，旧视频的不收。不碰 CC 开关
    function recover(vid, player) {
      if (!vid || replayAskedFor === vid || !player || !captionsOn(player)) return;
      replayAskedFor = vid;
      try {
        src.replay();
      } catch (err) {
        /* 忽略 */
      }
    }

    function tick() {
      // 没开开关 / 没配 Key 时先留着，开了再处理（播放器不会为同一条轨道再请求一次）
      if (env.enabled()) {
        var raw = src.take();
        if (raw) process(raw);
      }
      // 关掉字幕翻译：交还原生字幕，不再发请求（pump 只在开启时调度）；
      // 原始轨道留着，同一个视频重新打开时直接接着翻
      if (!env.enabled()) {
        render(null);
        return;
      }

      // 换了视频：先收起，等新视频的字幕回包把 track 换掉。
      // 不能在这里清掉 track —— 新字幕可能比地址栏先到，会把刚收到的新轨道一起清掉
      var vid = env.videoId();
      var view = env.player();
      var player = view && view.player;
      if (!track || (track.v && vid && track.v !== vid)) {
        recover(vid, player);
        render(null);
        return;
      }

      // 目标语言 / 趣味风格变化：旧译文与旧请求立即失效（包括切到和字幕同语言的时候），轨道保留
      var tgt = env.target();
      if (track.target !== tgt) {
        invalidate({
          target: tgt,
          key: [track.v, track.lang, track.kind, tgt].join('|')
        });
      }
      var style = env.styleId();
      if (track.style !== style) invalidate({ style: style });

      // 字幕本来就是目标语言：不接管，交还原生字幕；改回别的语言时上面的 invalidate 会重新调度
      if (subs.sameLanguage(track.lang, tgt)) {
        render(null);
        return;
      }

      var ms = view && view.ms;
      if (!player || !captionsOn(player) || typeof ms !== 'number') {
        render(null);
        return;
      }
      pump(ms);
      var i = subs.unitAt(track.units, ms);
      if (i < 0) {
        // 句间空档：上一句刚结束不久就继续留着（最多 1.5s），否则交还原生字幕
        if (last && last.v === track.v && subs.shouldLinger(last, ms, LINGER_MS)) {
          var late = track.trans[last.i];
          render({
            player: player,
            orig: last.orig,
            trans: late && subs.clean(late) !== subs.clean(last.orig) ? late : ''
          });
        } else {
          render({ player: player, orig: '', trans: '' });
        }
        return;
      }
      var unit = track.units[i];
      var trans = track.trans[i];
      // 译文和原文一样（或模型判定无需翻译）就只显示一行
      if (!trans || subs.clean(trans) === subs.clean(unit.text)) trans = '';
      last = { v: track.v, i: i, start: unit.start, end: unit.end, orig: unit.text };
      render({ player: player, orig: unit.text, trans: trans });
    }

    function start() {
      replayAskedFor = env.videoId() || ''; // 启动时已经要过一次，recover() 不再重复要
      try {
        src.replay();
      } catch (err) {
        /* 忽略 */
      }
      setInterval(tick, 200);
    }

    return {
      tick: tick,
      start: start,
      process: process,
      reset: reset,
      pump: pump,
      render: render,
      inspect: function () {
        return { track: track, overlay: overlay, shown: shown, shownOverlay: shownOverlay, last: last };
      }
    };
  }

  // 测试入口：Node 自检脚本会用假的 doc / source / send 调用 create()
  DT.subtitleRuntime = { create: createRuntime };

  if (typeof location === 'undefined' || !/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;

  function cfg() {
    return DT.state.config || {};
  }

  function enabled() {
    var c = cfg();
    return !!DT.state.config && c.subtitleTranslate === true && !!c.hasKey; // 默认关闭，用户打开才接管
  }

  function target() {
    return DT.state.target || cfg().targetLang || 'zh-CN';
  }

  // 当前页面的趣味风格（弹窗里选的，只对当前页生效）
  function styleId() {
    var s = DT.state && DT.state.style;
    return DT.STYLE_IDS && DT.STYLE_IDS.indexOf(s) >= 0 ? s : 'plain';
  }

  function currentVideoId() {
    var m = /[?&]v=([^&]+)/.exec(location.search) || /\/(?:embed|shorts|live)\/([^/?#]+)/.exec(location.pathname);
    return m ? m[1] : '';
  }

  var runtime = createRuntime({
    doc: document,
    source: source,
    enabled: enabled,
    target: target,
    styleId: styleId,
    videoId: currentVideoId,
    now: function () {
      return Date.now();
    },
    player: function () {
      var video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      var player = video && (video.closest('.html5-video-player') || document.getElementById('movie_player'));
      if (!video || !player) return null;
      return { player: player, video: video, ms: video.currentTime * 1000 };
    },
    send: function (msg) {
      return DT.send(msg, 190000);
    },
    log: function () {
      DT.log.apply(DT, arguments);
    },
    toast: function (msg, ms) {
      DT.toast(msg, ms);
    }
  });

  runtime.start();
})();