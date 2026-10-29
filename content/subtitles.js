// 通用视频字幕运行时：消费来源适配层、按播放进度懒翻译、双语叠层显示。
// 平台差异只存在于 DT.subtitleSource（YouTube / Bilibili）；这里不解析任何站点的原始回包。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || !DT.subs) return; // 依赖 subtitles-core.js
  var subs = DT.subs;
  var source = DT.subtitleSource;
  if (!source) return;

  var LOOK_AHEAD_MS = 90000; // 只翻播放位置往后这么长
  var LOOK_BEHIND_MS = 3000;
  var BATCH_ITEMS = 8; // 小批优先：当前句的译文更快回来
  var BATCH_CHARS = 1000;
  var RETRY_MS = 15000;
  var LINGER_MS = 1500; // 句末后再停留这么久，等下一句或等译文
  var STYLE_ID = 'rimefox-subs-style';
  var OVERLAY_CLASS = 'rimefox-subs';
  var ACTIVE_CLASS = 'rimefox-subs-on';

  // 运行时工厂：把 DOM、配置、发送、计时都从参数注入，Node 测试可以用假实现控制 Promise 顺序。
  // 返回的对象只暴露 tick / process / reset / inspect；真实页面在文件末尾自动创建并每 200ms 调用 tick。
  function createRuntime(env) {
    var doc = env.doc;
    var src = env.source || source;
    var track = null; // { identity, platform, videoKey, trackKey, lang, kind, units, ... }
    var overlay = null;
    var shown = '';
    var shownOverlay = null;
    var last = null; // 上一句已显示的内容，句间空档时用来兜底
    var processSeq = 0; // 异步解析 / 取原文轨道的代际：晚开始的 process 覆盖早开始的
    var replayAskedFor = ''; // 已经为哪个视频向来源层要过一次 replay（每个视频最多一次）

    function now() {
      return env.now ? env.now() : Date.now();
    }

    function log() {
      if (env.log) env.log.apply(null, arguments);
    }

    function platform() {
      return src.platform || 'youtube';
    }

    function playerView() {
      if (src.player) return src.player();
      return env.player ? env.player() : null;
    }

    function captionsOn(player) {
      if (src.captionsOn) return src.captionsOn(player);
      var btn = player && player.querySelector ? player.querySelector('.ytp-subtitles-button') : null;
      return !btn || btn.getAttribute('aria-pressed') === 'true';
    }

    function blocked(player) {
      if (src.blocked) return !!src.blocked(player);
      return !!(player && player.classList && player.classList.contains('ad-showing'));
    }

    function currentVideoKey() {
      if (src.videoKey) return src.videoKey();
      return env.videoId ? env.videoId() : '';
    }

    function matchesTrack(candidate) {
      if (src.matches) return src.matches(candidate);
      var vid = env.videoId ? env.videoId() : '';
      return !candidate || !candidate.v || !vid || candidate.v === vid;
    }

    function hideNativeCss() {
      return src.hideNativeCss || '.rimefox-subs-on .ytp-caption-window-container{display:none !important;}';
    }

    function identityOf(t) {
      return [
        t.platform || platform(),
        t.videoKey || t.v || '',
        t.trackKey || '',
        t.lang || '',
        t.kind || ''
      ].join('|');
    }

    function cacheScopeOf(t) {
      return [
        t.platform || platform(),
        t.videoKey || t.v || '',
        t.trackKey || '',
        t.lang || ''
      ].join('|').slice(0, 200);
    }

    function reset() {
      processSeq += 1; // 让还在 resolve 的旧 process 作废
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
    // 用户再切回中文时不必等页面重新加载字幕。
    function invalidate(next) {
      if (!track) return;
      track.gen += 1;
      track.inflight = 0;
      track.pending = {};
      track.trans = new Array(track.units.length);
      track.failedAt = [];
      track.warned = false;
      if (next && next.target !== undefined) track.target = next.target;
      if (next && next.targetCode !== undefined) track.targetCode = next.targetCode;
      if (next && next.style !== undefined) track.style = next.style;
      if (next && next.intensity !== undefined) track.intensity = next.intensity;
      shown = '';
      shownOverlay = null;
      last = null;
    }

    async function process(raw) {
      if (!raw) return;
      var seq = ++processSeq;
      var normalized;
      try {
        normalized = src.resolve ? await src.resolve(raw) : raw;
      } catch (err) {
        return;
      }
      if (seq !== processSeq) return; // 已经有更新的 process 开始
      if (!normalized || !normalized.units || !normalized.units.length) return;

      var units = normalized.units.filter(function (u) {
        return u && isFinite(u.start) && isFinite(u.end) && u.end > u.start && typeof u.text === 'string' && u.text;
      });
      if (!units.length) return;

      var identity = identityOf(normalized);
      if (track && track.identity === identity) return; // 播放器重复拉同一条轨道（拖动进度时会）

      track = {
        identity: identity,
        platform: normalized.platform || platform(),
        videoKey: normalized.videoKey || normalized.v || '',
        v: normalized.videoKey || normalized.v || '', // 兼容旧测试 / 诊断字段
        trackKey: normalized.trackKey || '',
        lang: normalized.lang || '',
        rawLang: normalized.rawLang || normalized.lang || '',
        kind: normalized.kind || '',
        label: normalized.label || '',
        bvid: normalized.bvid || '',
        cid: normalized.cid || '',
        page: normalized.page || 0,
        cacheScope: cacheScopeOf(normalized),
        units: units,
        target: env.target ? env.target() : '',
        targetCode: env.targetCode ? env.targetCode() : (env.target ? env.target() : ''),
        style: env.styleId ? env.styleId() : 'plain',
        intensity: env.intensity ? env.intensity() : 'standard',
        trans: new Array(units.length),
        failedAt: [],
        pending: {},
        gen: 0,
        inflight: 0,
        warned: false,
        // 后台按标签页计的付费预算用完了：本页停止自动翻译，等新视频（新 track）再恢复。
        blocked: false
      };
      shown = '';
      shownOverlay = null;
      last = null;
      log('subtitles:', units.length, 'units', platform(), normalized.kind || '', normalized.lang || '');
    }

    // ---------------- 翻译调度 ----------------
    function pump(nowMs) {
      if (!track) return;
      if (track.blocked) return; // 后台预算用完：不再自动发请求，等新视频 / 新轨道
      if (!env.enabled || !env.enabled()) return;
      if (track.target !== env.target() || track.targetCode !== (env.targetCode ? env.targetCode() : env.target()) || track.style !== env.styleId() || track.intensity !== (env.intensity ? env.intensity() : 'standard')) return; // 由 tick 先失效
      if (subs.sameLanguage(track.lang, env.targetCode ? env.targetCode() : env.target())) return; // 字幕本来就是目标语言：不翻
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
      var batchIntensity = mine.intensity;
      var batchTarget = mine.target;
      var batchTargetCode = mine.targetCode;
      mine.inflight += 1;
      batch.forEach(function (i) {
        mine.pending[i] = true;
      });

      var request;
      try {
        var requestMessage = {
          type: 'translate',
          texts: batch.map(function (i) {
            return mine.units[i].text;
          }),
          target: batchTarget,
          style: batchStyle
        };
        if (batchStyle !== 'plain') requestMessage.intensity = batchIntensity;
        // 字幕缓存身份隔离到平台 / 视频 / cid / 轨道 / 源语言；目标语言、风格、模型配置由后台基础键负责。
        // 显示模式不是身份的一部分，切换双语 / 仅译文不会重复付费。
        if (mine.cacheScope) requestMessage.cacheScope = mine.cacheScope;
        request = env.send(requestMessage);
      } catch (err) {
        request = Promise.reject(err);
      }

      Promise.resolve(request)
        .then(
          function (res) {
            // 代际/轨道/语言/风格任何一项变了，结果都作废；旧视频的请求不能污染新视频
            if (track !== mine || mine.gen !== gen || mine.target !== batchTarget || mine.targetCode !== batchTargetCode || mine.style !== batchStyle || mine.intensity !== batchIntensity) return;
            // 后台预算用完：停掉本页的自动翻译，不再进重试队列（否则每轮退避都会再发一次）
            if (res && res.errorCode === 'subtitle_budget') {
              mine.blocked = true;
              if (!mine.warned) {
                mine.warned = true;
                if (env.toast) env.toast('字幕翻译已达本页上限，本页已暂停自动翻译（换视频或刷新后恢复）', 6000);
              }
              return;
            }
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
            if (track !== mine || mine.gen !== gen || mine.target !== batchTarget || mine.targetCode !== batchTargetCode || mine.style !== batchStyle || mine.intensity !== batchIntensity) return;
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
      var existing = doc.getElementById(STYLE_ID);
      var css = hideNativeCss();
      if (existing) {
        if (existing.textContent !== css) existing.textContent = css;
        return;
      }
      var style = doc.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-dt-ui', '1');
      // 接管期间只隐藏当前播放器里的原生字幕层；不碰弹幕和页面其它区域。
      style.textContent = css;
      (doc.head || doc.documentElement).appendChild(style);
    }

    function ensureOverlay(player) {
      if (overlay && overlay.parentNode === player && overlay.isConnected !== false) return overlay;
      if (overlay) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        else if (overlay.remove) overlay.remove();
        overlay = null;
      }
      // 同一个播放器只允许一个 Rimefox 字幕层。
      var old = [];
      try {
        old = doc.querySelectorAll('.' + OVERLAY_CLASS);
      } catch (err) {
        old = [];
      }
      Array.prototype.forEach.call(old, function (node) {
        if (node.parentNode) node.parentNode.removeChild(node);
      });
      overlay = doc.createElement('div');
      overlay.setAttribute('data-dt-ui', '1');
      overlay.className = OVERLAY_CLASS;
      var font = platform() === 'youtube'
        ? '"YouTube Noto",Roboto,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
        : '"PingFang SC","Microsoft YaHei","Noto Sans SC",Roboto,sans-serif';
      overlay.style.cssText = [
        'position:absolute',
        'left:50%',
        'transform:translateX(-50%)',
        // 高于底部渐变，低于控制条和设置菜单：不能盖住播放器控件
        'z-index:30',
        'max-width:86%',
        'width:max-content',
        'text-align:center',
        'pointer-events:none',
        'display:none',
        'font-family:' + font
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
      var nodes = [];
      try {
        nodes = doc.querySelectorAll('.' + ACTIVE_CLASS);
      } catch (err) {
        nodes = [];
      }
      Array.prototype.forEach.call(nodes, function (el) {
        if (el !== player) el.classList.remove(ACTIVE_CLASS);
      });
      // 没有可显示的内容就交还给原生字幕：以前先加隐藏类再判空，句间空档会两边都没有
      if (!state || !state.orig || !player) {
        if (player) player.classList.remove(ACTIVE_CLASS);
        if (overlay) overlay.style.display = 'none';
        shown = '';
        shownOverlay = null;
        return;
      }
      ensureStyle();
      player.classList.add(ACTIVE_CLASS);
      var surface = ensureOverlay(player);

      // 字号跟播放器高度走（全屏时变大）；控制条显示时往上让一让。
      var h = player.clientHeight || 360;
      var size = Math.max(13, Math.min(32, Math.round(h * 0.036)));
      var autohide = src.controlsHidden ? !!src.controlsHidden(player) : (platform() === 'youtube' && player.classList.contains('ytp-autohide'));
      var bottom = src.overlayBottom
        ? src.overlayBottom(h, autohide)
        : Math.round(autohide ? h * 0.04 : Math.max(56, h * 0.1));
      overlay.style.bottom = bottom + 'px';
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

    // 当前视频没有可用轨道（还没收到、或手上的是上一个视频的）：请来源层把最后一份回包重放一次。
    // 每个视频最多要一次；重放回来的在 process() 里核对视频，旧视频的不收。不碰 CC 开关。
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

      var view = playerView();
      var player = view && view.player;
      // 播广告时交还原生显示、不调度翻译：时间轴是广告的，正片的句子对不上
      if (blocked(player)) {
        render(null);
        return;
      }

      // 换了视频 / 分 P：先收起，等新视频的字幕回包把 track 换掉。
      // 不能在这里清掉 track —— 新字幕可能比地址栏先到，会把刚收到的新轨道一起清掉。
      var vid = currentVideoKey();
      if (!track || !matchesTrack(track)) {
        recover(vid, player);
        render(null);
        return;
      }

      // 目标语言 / 趣味风格变化：旧译文与旧请求立即失效（包括切到和字幕同语言的时候），轨道保留
      var tgt = env.target();
      if (track.target !== tgt) {
        invalidate({ target: tgt });
      }
      var code = env.targetCode ? env.targetCode() : env.target();
      if (track.targetCode !== code) invalidate({ targetCode: code });
      var style = env.styleId();
      if (track.style !== style) invalidate({ style: style });
      var strength = env.intensity ? env.intensity() : 'standard';
      if (track.intensity !== strength) invalidate({ intensity: strength });

      // 字幕本来就是目标语言：不接管，交还原生字幕；改回别的语言时上面的 invalidate 会重新调度
      if (subs.sameLanguage(track.lang, env.targetCode ? env.targetCode() : env.target())) {
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
        if (last && last.identity === track.identity && subs.shouldLinger(last, ms, LINGER_MS)) {
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
      last = { identity: track.identity, i: i, start: unit.start, end: unit.end, orig: unit.text };
      render({ player: player, orig: unit.text, trans: trans });
    }

    function start() {
      replayAskedFor = currentVideoKey() || ''; // 启动时已经要过一次，recover() 不再重复要
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

  if (typeof location === 'undefined') return;

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

  // 字幕轨道语言是 BCP 47；自定义语言的内部 id 不能拿去比较，用后台下发的 code。
  function targetCode() {
    return (DT.state && DT.state.targetCode) || target();
  }

  // 当前页面实际生效的趣味风格（选而未应用的风格不在此列；字幕跟随整页，避免同页两种文风）
  function styleId() {
    var s = DT.state && DT.state.style;
    return DT.STYLE_IDS && DT.STYLE_IDS.indexOf(s) >= 0 ? s : 'plain';
  }

  function intensity() {
    if (styleId() === 'plain') return 'standard';
    return DT.normalizeIntensity ? DT.normalizeIntensity(DT.state && DT.state.intensity) : 'standard';
  }

  var runtime = createRuntime({
    doc: document,
    source: source,
    enabled: enabled,
    target: target,
    targetCode: targetCode,
    styleId: styleId,
    intensity: intensity,
    now: function () {
      return Date.now();
    },
    player: source.player,
    videoId: source.videoKey,
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

  DT.subtitleRuntime.instance = runtime;
  runtime.start();
})();
