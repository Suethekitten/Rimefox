// Bilibili 播放器字幕元数据捕获：跑在页面主环境（manifest "world": "MAIN"），
// 只在 www.bilibili.com/video/* 的 document_start 加载。
//
// 只观察播放器自己的 /x/player/(wbi/)v2 回包，不改写请求 / 回包，不读取 Cookie。
// 这个接口包含当前 bvid / cid 与官方字幕轨元数据（subtitle_url 带播放器签发的时限 auth_key）。
// 回包同时留给扩展环境 replay：扩展脚本 document_idle 才启动，播放器通常已经请求完了。
(function () {
  'use strict';

  if (window.__rimefoxBiliHook) return;
  window.__rimefoxBiliHook = true;

  var API = /^https:\/\/api\.bilibili\.com\/x\/player\/(?:wbi\/)?v2(?:\?|$)/;
  var REL = /^\/x\/player\/(?:wbi\/)?v2(?:\?|$)/;
  var HISTORY_MAX = 4;
  var history = [];
  var seq = 0;

  function interesting(url) {
    if (typeof url !== 'string') return false;
    return API.test(url) || REL.test(url);
  }

  function post(data) {
    try {
      window.postMessage(data, location.origin);
    } catch (err) {
      /* 忽略 */
    }
  }

  function valid(json) {
    return !!(json && json.code === 0 && json.data &&
      typeof json.data.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(json.data.bvid) &&
      json.data.cid != null && json.data.subtitle && typeof json.data.subtitle === 'object');
  }

  function forward(url, text, requestSeq) {
    if (typeof text !== 'string' || !text || text.length > 600000) return;
    var json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return;
    }
    if (!valid(json)) return;
    var msg = {
      source: 'rimefox-bili',
      type: 'player',
      url: String(url),
      body: text,
      seq: requestSeq,
      at: Date.now()
    };
    history.push(msg);
    if (history.length > HISTORY_MAX) history.shift();
    post(msg);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.source !== 'rimefox-ext-bili') return;
    if (event.data.type !== 'replay') return;
    // 重发最近的几份，扩展层会按 bvid / cid 和代际再核验。
    history.forEach(function (msg) {
      post({ source: msg.source, type: msg.type, url: msg.url, body: msg.body, seq: msg.seq, at: msg.at, replay: true });
    });
  });

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__rimefoxBiliUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var url = this.__rimefoxBiliUrl;
    if (interesting(url)) {
      var requestSeq = ++seq;
      this.addEventListener('load', function () {
        try {
          if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
          var text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
          forward(url, text, requestSeq);
        } catch (err) {
          /* 读取失败就当没看见，不影响播放器 */
        }
      });
    }
    return send.apply(this, arguments);
  };

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url);
      var requestSeq = ++seq;
      var result = nativeFetch.apply(this, arguments);
      if (interesting(url)) {
        result.then(function (res) {
          res.clone().text().then(function (text) {
            forward(url, text, requestSeq);
          }, function () {});
        }, function () {});
      }
      return result;
    };
  }
})();