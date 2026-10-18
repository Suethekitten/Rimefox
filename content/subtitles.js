// YouTube 字幕双语：打开 CC 时，把字幕换成「原文 + 译文」。
//
// 数据来源：content/youtube-hook.js（页面主环境）捕获播放器自己的字幕请求（带 pot 令牌），
// postMessage 过来。这里解析 json3 → 拼成句子 → 按播放进度懒翻译 → 叠在播放器上显示，
// 同时隐藏 YouTube 原生字幕。
//
// 三种字幕：
//   人工字幕       一个事件一句，带标点；可能一句被拆在相邻几个事件里 → 按句末标点合并
//   自动生成（ASR） 全小写、无标点、逐词带时间 → 按停顿拼句
//   YouTube 机翻   地址带 tlang → 去掉 tlang 重新请求原文轨道，自己翻
//
// 上半部分是纯函数（DT.subs.*，自检页直接测），下半部分只在 YouTube 上运行。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.subs) return; // 允许重复注入

  var subs = (DT.subs = {});

  // ---------------- 纯函数 ----------------

  var SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
  var SOUND_TAG = /^[[(（【][^\])）】]*[\])）】]$/; // [Music]、(Applause)、[音乐]

  function clean(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 字幕地址里的参数
  subs.paramsOf = function (url) {
    var out = { v: '', lang: '', tlang: '', kind: '' };
    try {
      var q = new URL(url, 'https://www.youtube.com').searchParams;
      out.v = q.get('v') || '';
      out.lang = q.get('lang') || '';
      out.tlang = q.get('tlang') || '';
      out.kind = q.get('kind') || '';
    } catch (err) {
      /* 坏地址就当没有参数 */
    }
    return out;
  };

  // 去掉 tlang：YouTube 机翻轨道 → 原文轨道
  subs.withoutTlang = function (url) {
    var u = new URL(url, 'https://www.youtube.com');
    u.searchParams.delete('tlang');
    return u.toString();
  };

  // 语言是否相同：zh-Hans ≈ zh-CN，zh-Hant ≈ zh-TW，其它比主语言
  function langKey(code) {
    var c = String(code || '').toLowerCase();
    if (/^zh(-hans|-cn|-sg)?$/.test(c)) return 'zh-cn';
    if (/^zh-(hant|tw|hk|mo)$/.test(c)) return 'zh-tw';
    return c.split('-')[0];
  }
  subs.sameLanguage = function (a, b) {
    return !!a && !!b && langKey(a) === langKey(b);
  };

  // 自动生成字幕：地址带 kind=asr，或片段带逐词偏移
  subs.isAsr = function (json, url) {
    if (subs.paramsOf(url || '').kind === 'asr') return true;
    var events = (json && json.events) || [];
    for (var i = 0; i < events.length && i < 50; i += 1) {
      var segs = events[i].segs || [];
      for (var k = 0; k < segs.length; k += 1) if (segs[k].tOffsetMs !== undefined) return true;
    }
    return false;
  };

  // 人工字幕：一个事件一条 [{ start, end, text }]
  subs.cuesOf = function (json) {
    var out = [];
    ((json && json.events) || []).forEach(function (e) {
      if (!e.segs) return;
      var text = clean(
        e.segs
          .map(function (s) {
            return s.utf8 || '';
          })
          .join('')
      );
      if (!text) return;
      var start = Number(e.tStartMs) || 0;
      out.push({ start: start, end: start + (Number(e.dDurationMs) || 0), text: text });
    });
    out.sort(function (a, b) {
      return a.start - b.start;
    });
    return out;
  };

  // 人工字幕 → 句子：一句被拆在相邻几条里时合并（整句翻译才通顺）。
  // 遇到句末标点、合并后超过 maxChars、或和下一条隔得太久就断开；[Music] 这类单独成句
  subs.sentencesOf = function (cues, opts) {
    var o = opts || {};
    var maxChars = o.maxChars || 120;
    var gapMs = o.gapMs || 1500;
    var out = [];
    var cur = null;
    function flush() {
      if (cur) out.push(cur);
      cur = null;
    }
    cues.forEach(function (cue) {
      var tag = SOUND_TAG.test(cue.text);
      if (cur && (tag || cue.start - cur.end > gapMs || cur.text.length + cue.text.length + 1 > maxChars)) flush();
      if (tag) {
        out.push({ start: cue.start, end: cue.end, text: cue.text, tag: true });
        return;
      }
      if (!cur) cur = { start: cue.start, end: cue.end, text: cue.text };
      else {
        cur.text += ' ' + cue.text;
        cur.end = Math.max(cur.end, cue.end);
      }
      if (SENTENCE_END.test(cue.text)) flush();
    });
    flush();
    return out;
  };

  // 自动生成字幕 → 逐词 [{ t, text, end }]（end = 所在事件的结束时间，最后一个词用）
  subs.wordsOf = function (json) {
    var out = [];
    ((json && json.events) || []).forEach(function (e) {
      if (!e.segs || e.aAppend) return; // aAppend 事件只是换行
      var start = Number(e.tStartMs) || 0;
      var end = start + (Number(e.dDurationMs) || 0);
      e.segs.forEach(function (s) {
        var text = clean(s.utf8);
        if (!text) return;
        out.push({ t: start + (Number(s.tOffsetMs) || 0), text: text, end: end });
      });
    });
    out.sort(function (a, b) {
      return a.t - b.t;
    });
    return out;
  };

  // 自动生成字幕 → 句子：没有标点，只能按停顿拼。
  // 停顿 ≥ pauseMs 断开；但这句还很短（< minChars）时要停顿 ≥ longPauseMs 才断，
  // 不然说话带停顿的人会被切成一两个词一段（真实演讲视频里 477 段有 108 段是这样），翻出来没法看；
  // 已经够长时，稍短的停顿也断；再长就硬断
  subs.chunksOf = function (words, opts) {
    var o = opts || {};
    var pauseMs = o.pauseMs || 600;
    var minChars = o.minChars || 20;
    var longPauseMs = o.longPauseMs || 1500;
    var softChars = o.softChars || 60;
    var softPauseMs = o.softPauseMs || 250;
    var maxChars = o.maxChars || 100;
    var tailMs = o.tailMs || 1500; // 一句说完后最多再停留多久
    var out = [];
    var cur = null;
    function flush(next) {
      if (!cur) return;
      var last = cur.lastT;
      cur.end = next ? Math.min(next.t, Math.max(cur.lastEnd, last + 800), last + tailMs) : last + tailMs;
      out.push({ start: cur.start, end: cur.end, text: cur.text, tag: cur.tag });
      cur = null;
    }
    words.forEach(function (w, i) {
      var tag = SOUND_TAG.test(w.text);
      if (cur) {
        var gap = w.t - cur.lastT;
        var len = cur.text.length;
        var pause = len < minChars ? longPauseMs : pauseMs;
        if (tag || cur.tag || gap >= pause || (len >= softChars && gap >= softPauseMs) || len + w.text.length + 1 > maxChars) {
          flush(w);
        }
      }
      if (!cur) cur = { start: w.t, text: w.text, lastT: w.t, lastEnd: w.end, tag: tag };
      else {
        cur.text += ' ' + w.text;
        cur.lastT = w.t;
        cur.lastEnd = w.end;
      }
      if (i === words.length - 1) flush(null);
    });
    return out;
  };

  // json3 + 地址 → 显示单位（句子）
  subs.unitsOf = function (json, url) {
    if (subs.isAsr(json, url)) return subs.chunksOf(subs.wordsOf(json));
    return subs.sentencesOf(subs.cuesOf(json));
  };

  // 二分查找 ms 时刻正在显示的单位
  subs.unitAt = function (units, ms) {
    var lo = 0;
    var hi = units.length - 1;
    var hit = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (units[mid].start <= ms) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return hit >= 0 && ms < units[hit].end ? hit : -1;
  };

  // 句间空档：上一句刚结束不久（默认 1.5s）时继续显示它，避免字幕闪一下就没。
  // 往前的空档（拖动到上一句之前）不保留；没有上一句也不保留。
  subs.shouldLinger = function (prev, ms, gapMs) {
    if (!prev) return false;
    var now = Number(ms) || 0;
    var gap = now - prev.end;
    return gap >= 0 && gap < (Number(gapMs) || 1500) && now >= prev.start;
  };

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
    for (var i = 0; i < units.length; i += 1) {
      var u = units[i];
      if (u.end < nowMs - LOOK_BEHIND_MS) continue;
      if (u.start > nowMs + LOOK_AHEAD_MS) break;
      if (u.tag || track.trans[i] !== undefined || track.pending[i]) continue;
      if (track.failedAt[i] && now - track.failedAt[i] < RETRY_MS) continue;
      if (batch.length && (batch.length >= BATCH_ITEMS || chars + u.text.length > BATCH_CHARS)) break;
      batch.push(i);
      chars += u.text.length;
    }
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
          trans: late && clean(late) !== clean(last.orig) ? late : ''
        });
      } else {
        render({ player: player, orig: '', trans: '' });
      }
      return;
    }
    var unit = track.units[i];
    var trans = track.trans[i];
    // 译文和原文一样（或模型判定无需翻译）就只显示一行
    if (!trans || clean(trans) === clean(unit.text)) trans = '';
    last = { v: track.v, i: i, start: unit.start, end: unit.end, orig: unit.text };
    render({ player: player, orig: unit.text, trans: trans });
  }

  setInterval(tick, 200);
  // 播放器可能在本脚本加载前就拉完了字幕：让主环境的钩子把最后一份再发一次
  window.postMessage({ source: 'rimefox-ext', type: 'replay' }, location.origin);
})();
