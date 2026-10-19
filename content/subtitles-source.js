// YouTube 字幕来源适配层（扩展环境，只在 YouTube 加载）。
//
// 边界：
//   主环境 content/youtube-hook.js 只负责挂钩 XHR/fetch 并把 /api/timedtext 回包 postMessage 过来；
//   这个文件把消息、原文轨道请求、replay 收成 DT.subtitleSource；
//   content/subtitles.js 只消费 take() / fetchText() / replay()，不再直接碰 YouTube 的协议。
//
// 以后 YouTube 改接口（或要接第二个字幕来源）时，优先只改这一层；
// 纯解析仍放 content/subtitles-core.js，运行时调度/渲染放 content/subtitles.js。
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

  DT.subtitleSource = {
    take: function () {
      var raw = pending;
      pending = null;
      return raw;
    },
    fetchText: fetchText,
    replay: replay
  };
})();
