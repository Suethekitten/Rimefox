// YouTube 字幕来源适配层（扩展环境，只在 YouTube 加载）。
//
// 边界：
//   主环境 content/youtube-hook.js 只负责挂钩 XHR/fetch 并把 /api/timedtext 回包 postMessage 过来；
//   这个文件把消息、原文轨道请求、replay 收成统一的 DT.subtitleSource；
//   content/subtitles.js 只消费 take() / resolve() / player()，不再直接碰 YouTube 的协议。
//
// 统一轨道格式：{ platform, videoKey, trackKey, lang, kind, units }
// 以后 YouTube 改接口（或要接第二个字幕来源）时，优先只改这一层；
// 纯解析仍放 content/subtitles-core.js。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || !DT.subs) return; // 依赖 subtitles-core.js
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;

  var pending = null; // 最后一条还没被运行时取走的字幕回包

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.source !== 'rimefox-yt' || d.type !== 'captions') return;
    if (typeof d.url !== 'string' || typeof d.body !== 'string') return;
    // replay = 钩子应 replay() 请求重发的「最后一份」，可能属于上一个视频：运行时会核对视频再收
    pending = { url: d.url, body: d.body, replay: d.replay === true };
  });

  // 播放器可能在本脚本加载前就拉完了字幕：让主环境钩子把最后一份再发一次
  function replay() {
    try {
      window.postMessage({ source: 'rimefox-ext', type: 'replay' }, location.origin);
    } catch (err) {
      /* 忽略 */
    }
  }

  // 同一源请求：机翻轨道要拿原文轨道时，需要带上播放器的登录态 / 令牌
  function fetchText(url) {
    return fetch(url, { credentials: 'include' }).then(function (res) {
      return res.text();
    });
  }

  function currentVideoId() {
    var m = /[?&]v=([^&]+)/.exec(location.search) || /\/(?:embed|shorts|live)\/([^/?#]+)/.exec(location.pathname);
    return m ? m[1] : '';
  }

  function adOn(player) {
    return !!(player && player.classList && player.classList.contains('ad-showing'));
  }

  function adShowing() {
    var view = player();
    return !!(view && adOn(view.player));
  }

  // 原始回包 → 统一轨道。YouTube 的 json3 解析仍留在 subtitles-core.js。
  async function resolve(raw) {
    if (!raw || !raw.url) return null;
    var p = DT.subs.paramsOf(raw.url);
    var url = raw.url;
    var body = raw.body;
    var lang = p.lang;
    var current = currentVideoId();
    var startVideo = p.v || current;
    // 重放的是主环境钩子留着的「最后一份」，可能是上一个视频的：和当前视频对不上就不收
    if (raw.replay && p.v && current && p.v !== current) return null;
    // 播广告时收到别的视频的字幕（广告自己的）：不收。插播广告会把正片的轨道换掉，
    // 广告播完播放器不会再请求一次正片字幕，后面的双语字幕就没了。
    // 不播广告时照常收：换视频时新字幕可能比地址栏先到
    if (p.v && current && p.v !== current && adShowing()) return null;

    // YouTube 机翻轨道：拿原文轨道来做双语（同源请求，带着播放器的令牌）
    if (p.tlang) {
      url = DT.subs.withoutTlang(raw.url);
      try {
        body = await fetchText(url);
      } catch (err) {
        body = '';
      }
      if (!body) return null; // 拿不到原文就不接管，原生机翻字幕照常显示
    }

    var json;
    try {
      json = JSON.parse(body);
    } catch (err) {
      return null; // 不是 json3（老格式 / 出错页），不接管
    }
    var units = DT.subs.unitsOf(json, url);
    if (!units.length) return null;
    var videoKey = p.v || startVideo;
    return {
      platform: 'youtube',
      videoKey: videoKey,
      v: videoKey,
      trackKey: [lang, p.kind || 'manual'].join(':'),
      lang: lang,
      kind: p.kind === 'asr' ? 'asr' : 'manual',
      label: '',
      units: units
    };
  }

  function playerView() {
    var video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    var player = video && (video.closest('.html5-video-player') || document.getElementById('movie_player'));
    if (!video || !player) return null;
    return { player: player, video: video, ms: video.currentTime * 1000 };
  }

  function captionsOn(player) {
    var btn = player && player.querySelector ? player.querySelector('.ytp-subtitles-button') : null;
    return !btn || btn.getAttribute('aria-pressed') === 'true';
  }

  function matches(track) {
    var current = currentVideoId();
    return !track || !track.v || !current || track.v === current;
  }

  DT.subtitleSource = {
    platform: 'youtube',
    hideNativeCss: '.rimefox-subs-on .ytp-caption-window-container{display:none !important;}',
    take: function () {
      var raw = pending;
      pending = null;
      return raw;
    },
    resolve: resolve,
    fetchText: fetchText,
    replay: replay,
    player: playerView,
    captionsOn: captionsOn,
    matches: matches,
    blocked: function (player) { return adOn(player); },
    videoKey: currentVideoId,
    status: function () { return ''; }
  };
})();
