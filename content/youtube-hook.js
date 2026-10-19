// YouTube 字幕捕获：跑在页面主环境（manifest 里 "world": "MAIN"），只在 youtube.com 上加载。
//
// 为什么要挂钩而不是自己请求：字幕地址要带播放器生成的 pot（proof of origin）令牌，
// 直接请求 captionTracks 里的 baseUrl 只会拿到 200 + 空内容。播放器自己的请求带着令牌，
// 这里把它的回包原样转给扩展环境（content/subtitles.js）。
//
// 这个文件没有扩展权限、不做任何判断，只转发；回包是页面数据，扩展那边按不可信文本处理。
(function () {
  'use strict';

  if (window.__rimefoxCaptionHook) return;
  window.__rimefoxCaptionHook = true;

  var MARK = '/api/timedtext';
  // 扩展环境的脚本在 document_idle 才加载，播放器可能更早就拉完了字幕（记住了 CC 开启）：
  // 留着最后一份，扩展那边起来后发 replay 再要一次
  var last = null;

  function post(data) {
    try {
      window.postMessage(data, location.origin);
    } catch (err) {
      /* 忽略 */
    }
  }

  function forward(url, body) {
    if (!body) return;
    last = { source: 'rimefox-yt', type: 'captions', url: String(url), body: String(body) };
    post(last);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.source !== 'rimefox-ext') return;
    // 重发时标上 replay：这一份可能是上一个视频的，扩展那边要核对视频才收
    if (event.data.type === 'replay' && last) {
      post({ source: last.source, type: last.type, url: last.url, body: last.body, replay: true });
    }
  });

  // 播放器目前用 XHR 拉字幕
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__rimefoxUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var url = this.__rimefoxUrl;
    if (url && String(url).indexOf(MARK) >= 0) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType && this.responseType !== 'text') return;
          forward(url, this.responseText);
        } catch (err) {
          /* responseType 不是文本时读 responseText 会抛 */
        }
      });
    }
    return send.apply(this, arguments);
  };

  // 以防播放器改用 fetch
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : input && input.url;
      var result = nativeFetch.apply(this, arguments);
      if (url && String(url).indexOf(MARK) >= 0) {
        result.then(function (res) {
          res.clone().text().then(function (text) {
            forward(url, text);
          }, function () {});
        }, function () {});
      }
      return result;
    };
  }
})();
