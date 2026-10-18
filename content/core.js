// 内容脚本：公共层（命名空间 / 工具 / 提示条）
(function () {
  'use strict';

  var DT = (window.__DT = window.__DT || {});
  DT.VERSION = '0.4.5';

  DT.state = {
    enabled: false,
    mode: 'dual',
    theme: 'underline',
    target: 'zh-CN',
    config: null,
    total: 0,
    translated: 0,
    failed: 0
  };

  DT.log = function () {
    if (DT.state.config && DT.state.config.debug) {
      var args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ['[DualTrans]'].concat(args));
    }
  };

  // 与后台通信。
  // 必须自带超时：MV3 的 service worker 可能被回收，此时 sendMessage 的
  // 回调永远不会触发，Promise 会挂死（表现为"一直翻译中、0 段"）。
  DT.send = function (msg, timeoutMs) {
    var limit = timeoutMs || 90000;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('与后台通信超时（' + Math.round(limit / 1000) + 's）'));
      }, limit);

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) finish(reject, new Error(err.message));
          else finish(resolve, res);
        });
      } catch (e) {
        finish(reject, e);
      }
    });
  };

  // 快捷键显示名："alt+a" → Mac 上 "Option + A"，其它系统 "Alt + A"。
  // 与 lib/config.js 的 hotkeyLabel 同一套逻辑（内容脚本不能 import）
  var IS_MAC = /mac/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
  );
  DT.hotkeyLabel = function (spec) {
    var names = IS_MAC ? { alt: 'Option', ctrl: 'Control', shift: 'Shift' } : { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift' };
    return String(spec || 'alt+a')
      .split('+')
      .filter(Boolean)
      .map(function (part) {
        var p = part.trim().toLowerCase();
        if (names[p]) return names[p];
        if (p.length === 1) return p.toUpperCase();
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(' + ');
  };

  // 折叠空白
  DT.normalizeText = function (text) {
    return String(text == null ? '' : text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\n\f\v]+/g, ' ')
      .trim();
  };

  // 纯符号 / 纯数字 / 太短 —— 不值得翻译
  DT.skipText = function (text) {
    if (!text || text.length < 2) return true;
    if (!/[\p{L}]/u.test(text)) return true;
    if (/^[\p{P}\p{S}\d\s]+$/u.test(text)) return true;
    return false;
  };

  // 这段文本是否已经基本是目标语言（避免中→中、英→英）
  // 注意：不能只看 CJK 占比。中英混排的段落（作者原文就混写）如果被判成
  // "已是中文"，整段就不会翻，表现为"有些段落没翻译"。
  // 规则：要同时满足「CJK 占绝对多数」且「拉丁字母很少」才算已达标。
  DT.looksLikeTarget = function (text, lang) {
    if (!text) return false;
    var letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 4) return false;

    var code = String(lang || '');
    var cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    var kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    var hangul = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
    var latin = (text.match(/[A-Za-z]/g) || []).length;

    if (code.indexOf('zh') === 0) {
      if (cjk / letters <= 0.75) return false;
      if (latin / letters > 0.15) return false;
      return true;
    }
    if (code.indexOf('ja') === 0) {
      if ((kana + cjk) / letters <= 0.6) return false;
      if (latin / letters > 0.2) return false;
      return true;
    }
    if (code.indexOf('ko') === 0) {
      if (hangul / letters <= 0.6) return false;
      if (latin / letters > 0.2) return false;
      return true;
    }
    if (code.indexOf('en') === 0) {
      return latin / letters > 0.9;
    }
    return false;
  };

  // 长段落按句切开，避免单条请求过大
  DT.splitLong = function (text, max) {
    var limit = Math.max(200, Number(max) || 1200);
    if (text.length <= limit) return [text];

    var marked = text.replace(/([.!?。！？；;:：])\s*/g, '$1\u0001');
    var parts = marked.split('\u0001');

    var out = [];
    var buf = '';
    parts.forEach(function (part) {
      if (!part) return;
      if (buf && buf.length + part.length > limit) {
        out.push(buf);
        buf = part;
      } else {
        buf = buf ? buf + ' ' + part : part;
      }
    });
    if (buf) out.push(buf);

    var safe = [];
    out.forEach(function (chunk) {
      var s = chunk;
      while (s.length > limit * 1.6) {
        safe.push(s.slice(0, Math.floor(limit * 1.6)));
        s = s.slice(Math.floor(limit * 1.6));
      }
      if (s) safe.push(s);
    });

    return safe.length ? safe : [text.slice(0, limit)];
  };

  // 轻量提示条（不依赖页面样式）
  DT.toast = function (message, ms) {
    try {
      var host = document.getElementById('dt-toast-root');
      if (!host) {
        host = document.createElement('div');
        host.id = 'dt-toast-root';
        host.setAttribute('data-dt-ui', '1');
        host.style.cssText =
          'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483647;' +
          'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
        (document.body || document.documentElement).appendChild(host);
      }
      var el = document.createElement('div');
      el.textContent = message;
      el.style.cssText =
        'max-width:72vw;padding:9px 14px;border-radius:10px;background:rgba(22,24,30,.93);color:#fff;' +
        'font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.24);opacity:0;transition:opacity .18s ease;';
      host.appendChild(el);
      requestAnimationFrame(function () {
        el.style.opacity = '1';
      });
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () {
          el.remove();
        }, 240);
      }, ms || 2200);
    } catch (err) {
      /* 忽略 */
    }
  };
})();
