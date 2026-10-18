// YouTube 字幕运行时：监听页面钩子的字幕回包、拼句、按进度懒翻译、叠层显示。
// 只在 YouTube 加载；纯函数在 content/subtitles-core.js（必须先加载）。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || !DT.subs) return; // 依赖 subtitles-core.js
  var subs = DT.subs;
  // ---------------- 运行时（只在 YouTube 上） ----------------
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;

  var LOOK_AHEAD_MS = 90000; // 只翻播放位置往后这么长
  var LOOK_BEHIND_MS = 3000;
  var BATCH_ITEMS = 8; // 小批优先：当前句的译文更快回来
  var BATCH_CHARS = 1000;
  var RETRY_MS = 15000;
  var LINGER_MS = 1500; // 句末后再停留这么久，等下一句或等译文

  var pendingRaw = null; // 收到但还没处理的字幕回包
  var track = null; // { key, v, units, trans: [], failedAt: [], pending: {}, style }
  var inflight = 0;
  var overlay = null;
  var shown = '';
  var last = null; // 上一句已显示的内容，句间空档时用来兜底
  var warned = false;

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

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.source !== 'rimefox-yt' || d.type !== 'captions') return;
    if (typeof d.url !== 'string' || typeof d.body !== 'string') return;
    pendingRaw = { url: d.url, body: d.body };
  });

  async function process(raw) {
    var p = subs.paramsOf(raw.url);
    var url = raw.url;
    var body = raw.body;
    var lang = p.lang;

    // YouTube 机翻轨道：拿原文轨道来做双语（同源请求，带着播放器的令牌）
    if (p.tlang) {
      url = subs.withoutTlang(raw.url);
      try {
        var res = await fetch(url, { credentials: 'include' });
        body = await res.text();
      } catch (err) {
        body = '';
      }
      if (!body) return; // 拿不到原文就不接管，原生机翻字幕照常显示
    }
    // 字幕本来就是目标语言：不用翻
    if (subs.sameLanguage(lang, target())) {
      reset();
      return;
    }
    var key = [p.v, lang, p.kind, target()].join('|');
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
      v: p.v,
      units: units,
      trans: new Array(units.length),
      failedAt: [],
      pending: {},
      style: styleId()
    };
    shown = '';
    last = null;
    DT.log('subtitles:', units.length, 'units', p.kind === 'asr' ? '(asr)' : '', p.tlang ? '(from tlang)' : '');
  }

  function reset() {
    track = null;
    shown = '';
    last = null;
    render(null);
  }

  // ---------------- 翻译调度 ----------------
  function pump(nowMs) {
    if (!track) return;
    // 趣味风格切换：旧译文的措辞不能继续用，清掉重翻（缓存键带 style，不会串）
    var style = styleId();
    if (track.style !== style) {
      track.style = style;
      track.trans = new Array(track.units.length);
      track.failedAt = [];
      track.pending = {};
      warned = false;
      shown = '';
      last = null;
    }
    if (inflight > 0) return;
    var units = track.units;
    var batch = [];
    var chars = 0;
    var now = Date.now();
    // 先收集窗口内的候选，再按"离当前播放位置的距离"排序：
    // 正在说的那一句必须排第一，否则积压时当前句要等前面几批翻完才轮到。
    var cands = [];
    for (var i = 0; i < units.length; i += 1) {
      var u = units[i];
      if (u.end < nowMs - LOOK_BEHIND_MS) continue;
      if (u.start > nowMs + LOOK_AHEAD_MS) break;
      if (u.tag || track.trans[i] !== undefined || track.pending[i]) continue;
      if (track.failedAt[i] && now - track.failedAt[i] < RETRY_MS) continue;
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
    var batchStyle = track.style;
    inflight += 1;
    batch.forEach(function (i) {
      mine.pending[i] = true;
    });
    DT.send({
      type: 'translate',
      texts: batch.map(function (i) {
        return mine.units[i].text;
      }),
      target: target(),
      style: batchStyle
    })
      .then(
        function (res) {
          if (mine.style !== batchStyle) return; // 风格在请求途中变了：这批结果作废
          var results = (res && res.results) || [];
          batch.forEach(function (i, k) {
            var value = results[k];
            if (typeof value === 'string') mine.trans[i] = value.trim();
            else mine.failedAt[i] = Date.now();
          });
          if (res && !res.ok && res.error && !warned) {
            warned = true;
            DT.toast('字幕翻译失败：' + res.error, 5000);
          }
        },
        function () {
          if (mine.style !== batchStyle) return;
          batch.forEach(function (i) {
            mine.failedAt[i] = Date.now();
          });
        }
      )
      .then(function () {
        batch.forEach(function (i) {
          delete mine.pending[i];
        });
        inflight -= 1;
        shown = ''; // 刚回来的可能就是正在显示的那句
      });
  }

  // ---------------- 显示 ----------------
  var STYLE_ID = 'rimefox-subs-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-dt-ui', '1');
    // 接管期间隐藏原生字幕，免得两套字幕叠在一起
    style.textContent = '.rimefox-subs-on .ytp-caption-window-container{display:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureOverlay(player) {
    if (overlay && overlay.parentNode === player) return overlay;
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
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
    var orig = document.createElement('div');
    var trans = document.createElement('div');
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
    return overlay;
  }

  function render(state) {
    var player = state && state.player;
    document.querySelectorAll('.rimefox-subs-on').forEach(function (el) {
      if (el !== player) el.classList.remove('rimefox-subs-on');
    });
    // 没有可显示的内容就交还给原生字幕：以前先加隐藏类再判空，句间空档会两边都没有
    if (!state || !state.orig) {
      if (player) player.classList.remove('rimefox-subs-on');
      if (overlay) overlay.style.display = 'none';
      shown = '';
      return;
    }
    ensureStyle();
    player.classList.add('rimefox-subs-on');
    ensureOverlay(player);

    // 字号跟播放器高度走（全屏时变大）；控制条显示时往上让一让
    var h = player.clientHeight || 360;
    var size = Math.max(13, Math.min(32, Math.round(h * 0.036)));
    var autohide = player.classList.contains('ytp-autohide');
    overlay.style.bottom = Math.round(autohide ? h * 0.04 : Math.max(56, h * 0.1)) + 'px';
    overlay._trans.style.fontSize = size + 'px';
    overlay._orig.style.fontSize = Math.round(size * 0.82) + 'px';

    var sig = state.orig + '\u0000' + state.trans + '\u0000' + size;
    if (sig === shown) return;
    shown = sig;
    overlay._orig.textContent = state.orig;
    overlay._trans.textContent = state.trans;
    overlay._trans.style.display = state.trans ? 'table' : 'none';
    overlay.style.display = 'block';
  }

  function captionsOn(player) {
    var btn = player.querySelector('.ytp-subtitles-button');
    return !btn || btn.getAttribute('aria-pressed') === 'true';
  }

  function tick() {
    // 没开开关 / 没配 Key 时先留着，开了再处理（播放器不会为同一条轨道再请求一次）
    if (pendingRaw && enabled()) {
      var raw = pendingRaw;
      pendingRaw = null;
      process(raw);
    }
    if (!track) {
      render(null);
      return;
    }
    if (!enabled()) {
      reset();
      return;
    }
    // 换了视频：先收起，等新视频的字幕回包把 track 换掉。
    // 不能在这里清掉 track —— 新字幕可能比地址栏先到，会把刚收到的新轨道一起清掉
    if (track.v !== currentVideoId()) {
      render(null);
      return;
    }
    var video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    var player = video && (video.closest('.html5-video-player') || document.getElementById('movie_player'));
    if (!player || !captionsOn(player)) {
      render(null);
      return;
    }
    var ms = video.currentTime * 1000;
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

  setInterval(tick, 200);
  // 播放器可能在本脚本加载前就拉完了字幕：让主环境的钩子把最后一份再发一次
  window.postMessage({ source: 'rimefox-ext', type: 'replay' }, location.origin);
})();
